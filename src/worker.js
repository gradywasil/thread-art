// Thread Art — module Web Worker running the pure engine (T4, committed RQ1).
//
// The worker exists for MAIN-THREAD ISOLATION, not parallelism (the greedy
// loop is inherently sequential): every compute-heavy thing the scheduler in
// ./compute.js needs happens here, off the rAF thread, so the animation is
// jank-free by construction.
//
// ── Message protocol (mirrored by src/compute.js) ──────────────────────
//   main → worker: { type: "start", id, greyscale: Float32Array, config? }
//                   (greyscale.buffer is TRANSFERRED — zero copy, RQ1; the
//                    main-thread copy detaches, which is why compute.js
//                    sends its own slice and keeps the caller's array)
//   main → worker: { type: "cancel", id }
//   worker → main: { type: "started", id, tableReused }
//   worker → main: { type: "progress", id, from, to, seq: Int16Array,
//                    chordPx, euclidPx }        (seq.buffer transferred)
//   worker → main: { type: "done", id, stats }
//   worker → main: { type: "error", id, message }
//
// Messages from a cancelled/replaced run carry a stale id and are dropped by
// the scheduler, so late traffic can never corrupt a restart.
//
// ── Batching + cancellation (committed RQ1) ────────────────────────────
// First batch = 64 passes (time-to-first-thread), then 192 per message
// (inside the committed 128–256 band). The worker yields to its message
// queue between batches (setTimeout 0), so a cancel/restart is honored
// within ~one batch (~25 ms of compute) — never after the run ended.
//
// ── Table reuse (RQ1 finding D3) ───────────────────────────────────────
// Chord tables depend only on (size, pinCount, radius) — never on the image
// or the weave parameters — so they are cached here and reused across
// reweaves; only a pin-count/resolution change rebuilds them.
//
// NO SharedArrayBuffer (COOP/COEP unavailability) and NO requestIdleCallback
// (not Baseline) anywhere — committed RQ1.

import {
  buildTables,
  createWeaveState,
  weavePasses,
  resolveConfig,
  defaultRadius,
} from "./engine.js";

const FIRST_BATCH = 64;
const NEXT_BATCH = 192;

let cache = null; // { key, tables } — cached across runs (RQ1 D3)
let run = null; // { id, state, tables, out, firstBatch, tableReused, started }

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

function startRun(msg) {
  run = null; // a start implicitly cancels anything still in flight
  try {
    if (!(msg.greyscale instanceof Float32Array)) {
      throw new TypeError("start.greyscale must be a Float32Array (T2 ingest contract)");
    }
    const config = resolveConfig(msg.config || {});
    const size = Math.sqrt(msg.greyscale.length);
    const radius = defaultRadius(size);
    const key = `${size}:${config.pinCount}:${radius}`;
    let tableReused = true;
    if (!cache || cache.key !== key) {
      cache = { key, tables: buildTables(size, config.pinCount) };
      tableReused = false;
    }
    const state = createWeaveState(msg.greyscale, config); // copies; input never mutated
    run = {
      id: msg.id,
      state,
      tables: cache.tables,
      out: new Int16Array(config.maxPasses * 2),
      firstBatch: true,
      tableReused,
      started: performance.now(),
    };
    post({ type: "started", id: run.id, tableReused });
    setTimeout(chunk, 0);
  } catch (error) {
    post({ type: "error", id: msg.id, message: String((error && error.message) || error) });
  }
}

function chunk() {
  if (!run) return; // cancelled or replaced
  const { state, tables, out, id } = run;
  const from = state.passIndex;
  const want = run.firstBatch ? FIRST_BATCH : NEXT_BATCH;
  run.firstBatch = false;
  weavePasses(state, tables, Math.min(from + want, state.config.maxPasses), out);
  const to = state.passIndex;

  if (to > from) {
    // Copy the just-written rows and transfer the copy's buffer (RQ1: the
    // ArrayBuffer is the transferable, not the typed array itself).
    const seq = out.slice(from * 2, to * 2);
    post(
      {
        type: "progress",
        id,
        from,
        to,
        seq,
        chordPx: state.totalChordPx, // running totals at the batch boundary (T5)
        euclidPx: state.totalThreadEuclidPx,
      },
      [seq.buffer]
    );
  }

  if (state.stopReason !== null || state.passIndex >= state.config.maxPasses || to === from) {
    post({
      type: "done",
      id,
      stats: {
        mode: "worker",
        passesUsed: state.passIndex,
        stopReason: state.stopReason === null ? "converged" : state.stopReason,
        totalChordPx: state.totalChordPx,
        totalThreadEuclidPx: state.totalThreadEuclidPx,
        initialDarkness: state.initialDarkness,
        remainingDarkness: state.remainingDarkness, // T8 mean-pixel-error inputs
        tableReused: run.tableReused,
        computeMs: performance.now() - run.started,
      },
    });
    run = null;
    return;
  }
  setTimeout(chunk, 0); // yield: lets cancel/start messages through between batches
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "start") {
    startRun(msg);
  } else if (msg.type === "cancel" && run && msg.id === run.id) {
    run = null;
  }
};
