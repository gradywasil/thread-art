// Thread Art — weave computation scheduler (T4, committed RQ1).
//
// One protocol, two execution contexts:
//   1. Module Web Worker (primary) — new Worker(new URL("./worker.js", …),
//      { type: "module" }) streaming transferable pass-record batches
//      (first 64 passes, then 192) with compute-ahead pipelining, so the
//      animation starts while later passes are still being computed.
//   2. Feature-detected setTimeout-chunked main-thread fallback running the
//      SAME engine functions (buildTables + createWeaveState + weavePasses)
//      in ≤ 8 ms time slices — used when Worker construction throws (Chrome
//      on file://: origin "null" → SecurityError), when module workers are
//      unavailable, or when the worker errors before producing output.
//      T3's tests prove chunked execution is bit-identical to single-shot,
//      so the sequence (and, after the renderer's final replay, the canvas)
//      is identical across both paths.
//
// The worker, its chord-table cache, and the fallback table cache are MODULE
// state shared by every scheduler instance: chord tables depend only on
// (size, pinCount, radius) — never on the image or weave parameters (RQ1
// finding D3) — so a reweave after "Start over" reuses them instead of
// paying the ~100 ms rebuild + 59 MB reallocation again. There is exactly
// one active run at a time (the app never runs two weaves concurrently).
//
// NO SharedArrayBuffer, NO requestIdleCallback (committed RQ1).
//
// The handler contract (what the renderer/anim layer consumes):
//   onStarted({ id, mode: "worker" | "fallback", tableReused })
//   onBatch({ from, to, seq: Int16Array(2·(to−from)), chordPx, euclidPx })
//   onDone({ mode, passesUsed, stopReason, totalChordPx, totalThreadEuclidPx,
//            initialDarkness, remainingDarkness, computeMs, tableReused })
//   onError(message)
//
// chordPx / euclidPx are the engine's running totals at each batch boundary
// — exactly the hook T5's live counters need (RQ3: feet come from
// totalThreadEuclidPx; both totals are exported so nothing downstream has
// to recompute them).

import {
  buildTables,
  createWeaveState,
  weavePasses,
  resolveConfig,
  defaultRadius,
} from "./engine.js";

// Batch policy (RQ1): TTFT batch first, then the steady-state band.
export const WORKER_FIRST_BATCH = 64;
export const WORKER_NEXT_BATCH = 192;

// Fallback time-slicing (RQ1-measured: 8 ms budget per setTimeout(0) slice
// cost ~13% wall over the raw loop — viable). weavePasses is called in
// ~32-pass calls (~4 ms each) so a slice never overshoots the budget much.
const FALLBACK_SLICE_MS = 8;
const FALLBACK_CHUNK_PASSES = 32;

// ── shared module state ──────────────────────────────────────────────────
let runId = 0;
let active = null; // { id, cancelled, mode, gotProgress, greyscale, config }
let handlers = null; // handlers of the scheduler that started the active run
let worker = null; // created lazily, kept alive for table reuse (RQ1 D3)
let workerUsable = typeof Worker !== "undefined";
let fallbackCache = null; // { key, tables } — main-thread table cache (RQ1 D3)

const isCurrent = (run) => run === active && !run.cancelled;

// ── worker path ──────────────────────────────────────────────────────────
function handleWorkerMessage(event) {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  const run = active;
  if (!run || msg.id !== run.id || run.cancelled) return; // stale traffic dropped
  if (msg.type === "started") {
    handlers.onStarted && handlers.onStarted({ id: run.id, mode: "worker", tableReused: !!msg.tableReused });
  } else if (msg.type === "progress") {
    run.gotProgress = true;
    handlers.onBatch &&
      handlers.onBatch({
        from: msg.from,
        to: msg.to,
        seq: msg.seq,
        chordPx: msg.chordPx,
        euclidPx: msg.euclidPx,
      });
  } else if (msg.type === "done") {
    active = null;
    handlers.onDone && handlers.onDone(msg.stats);
  } else if (msg.type === "error") {
    workerFailed(run, msg.message);
  }
}

function handleWorkerError(event) {
  workerUsable = false;
  if (worker) {
    try {
      worker.terminate();
    } catch {
      /* already gone */
    }
    worker = null;
  }
  const run = active;
  if (run && run.mode === "worker") {
    workerFailed(run, (event && event.message) || "worker failed to load");
  }
}

// A worker failure before any output restarts the SAME run on the main
// thread; after output there is nothing safe to do but surface the error.
function workerFailed(run, message) {
  if (run.gotProgress || !run.greyscale) {
    active = null;
    handlers.onError && handlers.onError(message);
    return;
  }
  startFallback(run, run.greyscale, run.config, true);
}

function spawnWorker() {
  try {
    const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    w.addEventListener("message", handleWorkerMessage);
    w.addEventListener("error", handleWorkerError);
    return w;
  } catch {
    workerUsable = false; // e.g. Chrome file:// (origin null → SecurityError)
    return null;
  }
}

// ── main-thread fallback path (same engine, time-sliced) ─────────────────
function startFallback(run, greyscale, config, afterWorkerFailure) {
  run.mode = "fallback";
  try {
    const resolved = resolveConfig(config || {});
    const size = Math.sqrt(greyscale.length);
    const radius = defaultRadius(size);
    const key = `${size}:${resolved.pinCount}:${radius}`;
    let tableReused = true;
    if (!fallbackCache || fallbackCache.key !== key) {
      fallbackCache = { key, tables: buildTables(size, resolved.pinCount) };
      tableReused = false;
    }
    const state = createWeaveState(greyscale, resolved); // copies; input never mutated
    const out = new Int16Array(resolved.maxPasses * 2);
    const started = performance.now();
    handlers.onStarted &&
      handlers.onStarted({ id: run.id, mode: "fallback", tableReused, afterWorkerFailure: !!afterWorkerFailure });

    const step = () => {
      if (!isCurrent(run)) return; // cancelled/replaced — leaves no stale state
      const from = state.passIndex;
      // First slice caps at the worker's first batch (TTFT parity); later
      // slices run to an 8 ms deadline in ~32-pass weavePasses calls.
      const cap = from === 0 ? WORKER_FIRST_BATCH : Infinity;
      const deadline = performance.now() + FALLBACK_SLICE_MS;
      while (
        state.stopReason === null &&
        state.passIndex < resolved.maxPasses &&
        state.passIndex - from < cap &&
        (state.passIndex === from || performance.now() < deadline)
      ) {
        const target = Math.min(
          state.passIndex + FALLBACK_CHUNK_PASSES,
          resolved.maxPasses,
          from + cap
        );
        weavePasses(state, fallbackCache.tables, target, out);
      }
      const to = state.passIndex;
      if (to > from) {
        handlers.onBatch &&
          handlers.onBatch({
            from,
            to,
            seq: out.slice(from * 2, to * 2),
            chordPx: state.totalChordPx,
            euclidPx: state.totalThreadEuclidPx,
          });
      }
      if (state.stopReason !== null || state.passIndex >= resolved.maxPasses) {
        active = null;
        handlers.onDone &&
          handlers.onDone({
            mode: "fallback",
            passesUsed: state.passIndex,
            stopReason: state.stopReason,
            totalChordPx: state.totalChordPx,
            totalThreadEuclidPx: state.totalThreadEuclidPx,
            initialDarkness: state.initialDarkness,
            remainingDarkness: state.remainingDarkness,
            tableReused,
            computeMs: performance.now() - started,
          });
      } else {
        setTimeout(step, 0);
      }
    };
    setTimeout(step, 0);
  } catch (error) {
    active = null;
    handlers.onError && handlers.onError(String((error && error.message) || error));
  }
}

// ── run control ──────────────────────────────────────────────────────────
function startRun(greyscale, config, schedHandlers) {
  cancelRun(); // never two runs at once
  handlers = schedHandlers;
  const run = {
    id: ++runId,
    cancelled: false,
    mode: null,
    gotProgress: false,
    greyscale, // caller's array (never mutated by the engine) — kept for a fallback switch
    config,
  };
  active = run;

  if (workerUsable && !worker) worker = spawnWorker();
  if (worker) {
    run.mode = "worker";
    const wire = greyscale.slice(); // transferred copy; caller's array stays intact
    try {
      worker.postMessage({ type: "start", id: run.id, greyscale: wire, config }, [wire.buffer]);
      return run.id;
    } catch {
      workerUsable = false;
      worker = null;
      run.mode = null; // fall through to the main-thread path
    }
  }
  startFallback(run, greyscale, config, false);
  return run.id;
}

function cancelRun() {
  const run = active;
  if (!run) return;
  run.cancelled = true;
  active = null;
  if (run.mode === "worker" && worker) {
    try {
      worker.postMessage({ type: "cancel", id: run.id });
    } catch {
      /* dead worker — nothing running */
    }
  }
  // The fallback chain stops itself on the next slice via isCurrent().
}

// ── scheduler factory ────────────────────────────────────────────────────
export function createWeaveScheduler(schedHandlers = {}) {
  return {
    start(greyscale, config = {}) {
      return startRun(greyscale, config, schedHandlers);
    },
    cancel() {
      cancelRun();
    },
    dispose() {
      cancelRun();
      if (worker) {
        try {
          worker.terminate();
        } catch {
          /* already gone */
        }
        worker = null;
      }
    },
    get mode() {
      return active ? active.mode : null;
    },
  };
}
