// Thread Art — greedy thread engine (T3).
//
// PURE module: no DOM, no worker machinery, no globals beyond standard
// ECMAScript — it runs identically inside a Web Worker, chunked on the main
// thread, and under Node for the unit tests (all scheduling/worker wiring is
// T4's job, rendering is T4/T5's).
//
// ── Input contract (T2, src/ingest.js) ─────────────────────────────────
// `greyscale` is a row-major Float32Array of d² luma values for the d×d
// working-resolution square whose inscribed circle is the artwork:
//   scale 0 = black … 1 = white; pixels OUTSIDE the circle are exactly 1.0.
// The engine works internally in DARKNESS = 1 − luma (0 = nothing left to
// weave, 1 = fully wanted), so out-of-circle pixels contribute nothing. The
// caller's array is never mutated; a private Float32Array copy is the
// weaving state.
//
// ── Pin placement (exact, documented) ──────────────────────────────────
// With n = pinCount, s = size (px) and r = radius:
//   θi  = (i / n) · 2π                      (f64)
//   xi  = s/2 + cos(θi) · r                 (f64; screen y grows DOWNWARD)
//   yi  = s/2 + sin(θi) · r
//   pxi = (round(xi), round(yi))            (Bresenham endpoints)
// Pin 0 is the 3 o'clock (rightmost) point; because screen y grows downward,
// increasing i walks the circle CLOCKWISE: pin n/4 at 6 o'clock, n/2 at
// 9 o'clock, 3n/4 at 12 o'clock (exactly, when 4 divides n).
// Default radius = floor(s/2) − 2 (at s = 600 → r = 298, matching the
// committed RQ1 spike) — pins sit 2 px inside the rim so rounded chord
// endpoints can never leave the canvas. Residual determinism note: cos/sin
// are implementation-approximated (≤ 1 ulp); after rounding to integer pixel
// coordinates the cross-engine disagreement probability is ~1e-13 per run —
// practically deterministic; T8 re-verifies sequence hashes in-browser.
//
// ── Architecture (committed RQ1, option A: precompute-all) ─────────────
// buildTables(size, pinCount) enumerates every unordered pin pair exactly
// once ("chord"), rasterizes it with an 8-connected integer Bresenham walk
// in the CANONICAL lo→hi pin-index direction (RQ1 finding D1: Bresenham
// pixel sets are direction-dependent; canonical direction is what makes
// repeated and chunked runs bit-identical), and stores all chords' pixel
// indices (row-major y·s + x) in one flattened Uint32Array `pixels` plus a
// Uint32Array `offsets` where offsets[k] .. offsets[k+1] delimits chord k.
// Chord id for the unordered pair (i, j), i ≠ j:
//   lo = min(i, j), hi = max(i, j)
//   id = lo·(2n − lo − 1)/2 + (hi − lo − 1)        (compact bijection)
// Tables depend only on (size, pinCount, radius) — never on the image or the
// weaving params (RQ1 finding D3) — so T4 may cache them across reweaves;
// changing neighborSkip / delta / passes never invalidates a table.
//
// ── Greedy loop (committed RQ2 defaults) ───────────────────────────────
// From the current pin, evaluate every candidate pin whose CYCLIC distance
// exceeds neighborSkip (k nearest pins excluded in BOTH directions). Score =
// Σ darkness over the chord's pixel list (f64 accumulation in a fixed order —
// deterministic by construction). Pick the maximum with the explicit
// tie-break (RQ1 finding D2): candidates are scanned in ascending pin index
// and only a STRICTLY greater sum replaces the incumbent, i.e. the LOWEST
// pin index wins ties. Subtract lighteningDelta from each covered pixel
// EXACTLY ONCE per pass (this Bresenham never revisits a pixel), clamped at
// 0. Emit the pass record (fromPin, toPin); continue from toPin.
//
// ── Domain translation (RQ2 → this engine) ─────────────────────────────
// RQ2 states the delta on the 0–255 byte scale (default 20, UI knob 4–32).
// This engine's darkness domain is the 0..1 luma scale, so delta = knob/255
// (20/255 = 0.0784313725…). minImprovement stays in summed-darkness units of
// the 0..1 domain (default 0 ⇒ a pass fails when nothing reachable is left).
//
// ── Stopping rules (committed RQ2) ─────────────────────────────────────
// maxPasses counts EMITTED passes (threads drawn), not failed attempts. A
// "fail" is an attempt whose best score ≤ minImprovement; after
// convergenceFails (3) consecutive fails the run stops with reason
// 'converged' (a blank image stops after 3 attempts, emitting 0 threads).
// 'budget' is declared the moment the last allowed thread is emitted; the
// two reasons are mutually exclusive by construction.
//
// ── API shape (RQ1 §7 sketch, adjusted to the T2 luma contract) ────────
//   buildTables(size, pinCount, {radius?})   → cacheable chord tables
//   createWeaveState(greyscale, config?)     → fresh mutable run state
//   weavePasses(state, tables, toPass, out)  → resumable core: runs passes
//       [state.passIndex, toPass), writing (fromPin, toPin) Int16 pairs into
//       `out` at row = pass index — the from/to pass ranges of the RQ1
//       sketch, enabling both worker batching and the chunked main-thread
//       fallback in T4 with identical output.
//   weave(greyscale, config?, tables?)       → one-shot convenience wrapper.

export const TWO_PI = 2 * Math.PI;

// UI knob ranges (RQ2 §7). The engine itself only sanity-checks inputs; the
// UI (T5) clamps to these. lighteningDelta255 is the 0–255-scale knob whose
// engine value is knob/255; neighborSkip default "auto" resolves to
// Math.max(1, round(pinCount / 30)) (= 10 at 300 pins).
export const ENGINE_KNOBS = Object.freeze({
  pinCount: Object.freeze({ min: 200, max: 500, default: 300, label: "Pins" }),
  maxPasses: Object.freeze({ min: 1000, max: 8000, default: 4000, label: "Coverage (passes)" }),
  lighteningDelta255: Object.freeze({ min: 4, max: 32, default: 20, label: "Darkness (0–255 scale)" }),
  neighborSkip: Object.freeze({ min: 0, max: 25, default: "auto", label: "Min chord gap (pins)" }),
});

// Default config — single source of truth (RQ2 §4, verbatim field set,
// lighteningDelta translated to the 0..1 darkness domain, plus the
// engine-level startPin which is NOT a UI knob).
export const DEFAULT_ENGINE_CONFIG = Object.freeze({
  pinCount: 300,
  maxPasses: 4000,
  lighteningDelta: 20 / 255,
  neighborSkip: "auto",
  minImprovement: 0,
  convergenceFails: 3,
  startPin: 0,
});

// neighborSkip "auto": k nearest pins excluded both directions (RQ2).
export function autoNeighborSkip(pinCount) {
  return Math.max(1, Math.round(pinCount / 30));
}

// Cyclic (around-the-circle) distance between pins i and j.
export function cyclicPinDistance(i, j, pinCount) {
  let d = i > j ? i - j : j - i;
  const m = pinCount - d;
  return m < d ? m : d;
}

// Compact chord id for the unordered pair {i, j}, i ≠ j (RQ1): a bijection
// onto [0, C(n,2)). lo·(2n−lo−1) is always even, so the division is exact.
export function chordId(i, j, pinCount) {
  const lo = i < j ? i : j;
  const hi = i < j ? j : i;
  return (lo * (2 * pinCount - lo - 1)) / 2 + (hi - lo - 1);
}

// Default pin-circle radius: 2 px inside the rim (RQ1 spike used 298 @ 600).
export function defaultRadius(size) {
  return Math.max(1, Math.floor(size / 2) - 2);
}

// Exact f64 pin positions (see header for the documented index math).
// Returns a Float64Array of length 2·pinCount: [x0, y0, x1, y1, …].
export function pinPositions(size, pinCount, radius = defaultRadius(size)) {
  const xy = new Float64Array(pinCount * 2);
  const c = size / 2;
  for (let i = 0; i < pinCount; i++) {
    const t = (i / pinCount) * TWO_PI;
    xy[i * 2] = c + Math.cos(t) * radius;
    xy[i * 2 + 1] = c + Math.sin(t) * radius;
  }
  return xy;
}

// Resolve + validate a config. Accepts partial overrides over the defaults
// (and is idempotent: passing an already-resolved config returns the same
// values). Throws TypeError/RangeError on malformed input. Note the knob
// RANGES above are a UI concern — the engine only rejects degenerate values
// (so unit tests may use e.g. 8 pins).
export function resolveConfig(overrides = {}) {
  if (overrides === null || typeof overrides !== "object") {
    throw new TypeError("config must be an object");
  }
  const raw = { ...DEFAULT_ENGINE_CONFIG, ...overrides };

  const int = (value, name, min) => {
    if (!Number.isInteger(value) || value < min) {
      throw new RangeError(`${name} must be an integer >= ${min} (got ${value})`);
    }
    return value;
  };

  const pinCount = int(raw.pinCount, "pinCount", 2);
  if (pinCount > 32767) {
    throw new RangeError("pinCount must be <= 32767 (Int16Array pass records)");
  }
  const maxPasses = int(raw.maxPasses, "maxPasses", 1);
  const convergenceFails = int(raw.convergenceFails, "convergenceFails", 1);

  const lighteningDelta = raw.lighteningDelta;
  if (!Number.isFinite(lighteningDelta) || lighteningDelta <= 0 || lighteningDelta > 1) {
    throw new RangeError(`lighteningDelta must be in (0, 1] on the 0..1 darkness domain (got ${lighteningDelta}; 255-scale knob / 255)`);
  }
  const minImprovement = raw.minImprovement;
  if (!Number.isFinite(minImprovement)) {
    throw new RangeError(`minImprovement must be a finite number (got ${minImprovement})`);
  }

  let neighborSkip = raw.neighborSkip;
  if (neighborSkip === "auto") neighborSkip = autoNeighborSkip(pinCount);
  neighborSkip = int(neighborSkip, "neighborSkip", 0);
  if (neighborSkip >= Math.floor(pinCount / 2)) {
    throw new RangeError(`neighborSkip ${neighborSkip} leaves no candidate pins (must be < pinCount/2 = ${Math.floor(pinCount / 2)})`);
  }

  const startPin = int(raw.startPin, "startPin", 0);
  if (startPin >= pinCount) {
    throw new RangeError(`startPin must be < pinCount ${pinCount} (got ${startPin})`);
  }

  return Object.freeze({
    pinCount,
    maxPasses,
    lighteningDelta,
    neighborSkip,
    minImprovement,
    convergenceFails,
    startPin,
  });
}

// ── Chord tables ────────────────────────────────────────────────────────
// Built in two exact passes: (1) per-chord pixel COUNT via the closed form
// max(|dx|, |dy|) + 1 (this Bresenham variant advances its dominant axis
// every iteration, so the count is exact), prefix-summed into `offsets`;
// (2) rasterization of every chord in the canonical lo→hi pin direction
// into the exactly-sized `pixels` array, with a per-chord invariant check.
// No scratch over-allocation, no image dependence (RQ1 D3).
export function buildTables(size, pinCount, opts = {}) {
  if (!Number.isInteger(size) || size < 2) {
    throw new RangeError(`size must be an integer >= 2 (got ${size})`);
  }
  if (!Number.isInteger(pinCount) || pinCount < 2) {
    throw new RangeError(`pinCount must be an integer >= 2 (got ${pinCount})`);
  }
  const radius = opts.radius !== undefined ? opts.radius : defaultRadius(size);
  if (!Number.isFinite(radius) || radius < 1 || radius > Math.floor((size - 1) / 2)) {
    throw new RangeError(`radius must be in [1, floor((size-1)/2)] for size ${size} (got ${radius})`);
  }

  const pins = pinPositions(size, pinCount, radius); // exact f64 positions
  const pinPx = new Int32Array(pinCount * 2); // rounded pixel endpoints
  for (let i = 0; i < pinCount; i++) {
    pinPx[i * 2] = Math.round(pins[i * 2]);
    pinPx[i * 2 + 1] = Math.round(pins[i * 2 + 1]);
  }

  const nChords = (pinCount * (pinCount - 1)) / 2;
  const lens = new Uint32Array(nChords);

  // Pass 1: exact lengths (no rasterization needed for the count).
  for (let i = 0; i < pinCount; i++) {
    const xi = pinPx[i * 2];
    const yi = pinPx[i * 2 + 1];
    for (let j = i + 1; j < pinCount; j++) {
      const dx = Math.abs(pinPx[j * 2] - xi);
      const dy = Math.abs(pinPx[j * 2 + 1] - yi);
      lens[(i * (2 * pinCount - i - 1)) / 2 + (j - i - 1)] = (dx > dy ? dx : dy) + 1;
    }
  }

  const offsets = new Uint32Array(nChords + 1);
  let acc = 0;
  for (let k = 0; k < nChords; k++) {
    offsets[k] = acc;
    acc += lens[k];
  }
  offsets[nChords] = acc;

  // Pass 2: canonical lo→hi rasterization (RQ1 D1).
  const pixels = new Uint32Array(acc);
  for (let i = 0; i < pinCount; i++) {
    const xi = pinPx[i * 2];
    const yi = pinPx[i * 2 + 1];
    for (let j = i + 1; j < pinCount; j++) {
      const id = (i * (2 * pinCount - i - 1)) / 2 + (j - i - 1);
      const end = offsets[id] + lens[id];
      let w = offsets[id];
      let x0 = xi;
      let y0 = yi;
      const x1 = pinPx[j * 2];
      const y1 = pinPx[j * 2 + 1];
      const dx = Math.abs(x1 - x0);
      const sx = x0 < x1 ? 1 : -1;
      const dy = -Math.abs(y1 - y0);
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        pixels[w++] = y0 * size + x0;
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x0 += sx;
        }
        if (e2 <= dx) {
          err += dx;
          y0 += sy;
        }
      }
      // Exactness guard: the closed-form length must match the walk.
      if (w !== end) {
        throw new Error("engine bug: Bresenham pixel count differs from closed form");
      }
    }
  }

  return {
    size,
    pinCount,
    radius,
    pins, // Float64Array — exact pin positions (documented math)
    pinPx, // Int32Array — rounded pixel endpoints (what was rasterized)
    nChords,
    offsets, // Uint32Array(nChords + 1): chord id k = pixels[offsets[k] .. offsets[k+1])
    pixels, // Uint32Array(totalPx): flattened row-major y*size + x indices
    totalPx: acc,
  };
}

// ── Weaving state ───────────────────────────────────────────────────────
// Fresh run state: converts the T2 luma input to internal darkness
// (1 − luma, so out-of-circle 1.0 → 0) and carries every running total the
// counters (T5) and QA harness (T8) need. Mutated only by weavePasses().
export function createWeaveState(greyscale, config = {}) {
  if (!(greyscale instanceof Float32Array)) {
    throw new TypeError("greyscale must be a Float32Array (T2 ingest contract: row-major d² luma)");
  }
  const n2 = greyscale.length;
  const size = Math.sqrt(n2);
  if (size !== Math.floor(size) || size < 2) {
    throw new RangeError(`greyscale length must be a perfect square >= 4, row-major d² (got ${n2})`);
  }
  const resolved = resolveConfig(config);

  const darkness = new Float32Array(n2);
  let sum = 0;
  for (let i = 0; i < n2; i++) {
    const d = Math.fround(1 - greyscale[i]);
    darkness[i] = d;
    sum += d;
  }

  return {
    config: resolved, // frozen resolved config
    size,
    darkness, // remaining wanted darkness (0..1); the weaving state
    passIndex: 0, // passes emitted so far (= next `out` row)
    attempts: 0, // pass evaluations attempted (emitted + failed)
    currentPin: resolved.startPin,
    consecutiveFails: 0,
    stopReason: null, // null | "budget" | "converged"
    totalChordPx: 0, // Σ Bresenham pixel counts (canonical totalPx for RQ3/T5)
    totalThreadEuclidPx: 0, // Σ sqrt(dx²+dy²) over rounded pin px (RQ3 chord_px)
    initialDarkness: sum, // f64 sums, fixed accumulation order
    remainingDarkness: sum,
  };
}

// ── Resumable greedy core ───────────────────────────────────────────────
// Runs passes [state.passIndex, min(toPass, config.maxPasses)) writing
// (fromPin, toPin) Int16 pairs into `out` at row = pass index. Stops early
// with state.stopReason = "converged" after convergenceFails consecutive
// failed attempts, or sets "budget" the moment maxPasses threads are emitted.
// Deterministic: identical state + tables + bounds ⇒ identical writes, in
// one call or many (chunked execution in T4 produces the same sequence).
export function weavePasses(state, tables, toPass, out) {
  if (!state || !state.config || !(state.darkness instanceof Float32Array)) {
    throw new TypeError("state must come from createWeaveState()");
  }
  if (tables.size !== state.size || tables.pinCount !== state.config.pinCount) {
    throw new TypeError(`tables (size ${tables.size}, pins ${tables.pinCount}) do not match the run (size ${state.size}, pins ${state.config.pinCount})`);
  }

  const cfg = state.config;
  const target = Math.min(toPass, cfg.maxPasses);
  if (out.length < target * 2) {
    throw new RangeError(`out must hold ${target} pass records (${target * 2} Int16 slots; got ${out.length})`);
  }

  const n = cfg.pinCount;
  const skip = cfg.neighborSkip;
  const delta = cfg.lighteningDelta;
  const minImp = cfg.minImprovement;
  const { pixels, offsets, pinPx } = tables;
  const darkness = state.darkness;

  let cur = state.currentPin;
  let written = 0;

  while (state.passIndex < target && state.stopReason === null) {
    // Evaluate all candidate pins: cyclic distance > neighborSkip, scanned in
    // ASCENDING pin index; strict > keeps the incumbent, so ties go to the
    // LOWEST pin index (RQ1 finding D2 — the explicit deterministic
    // tie-break).
    let bestJ = -1;
    let bestSum = -Infinity;
    let bestS = 0;
    let bestE = 0;
    for (let j = 0; j < n; j++) {
      if (j === cur) continue;
      let d = j - cur;
      if (d < 0) d = -d;
      const m = n - d;
      if (m < d) d = m;
      if (d <= skip) continue;
      const lo = cur < j ? cur : j;
      const hi = cur < j ? j : cur;
      const id = (lo * (n + n - lo - 1)) / 2 + (hi - lo - 1);
      const s = offsets[id];
      const e = offsets[id + 1];
      let sum = 0;
      for (let k = s; k < e; k++) sum += darkness[pixels[k]];
      if (sum > bestSum) {
        bestSum = sum;
        bestJ = j;
        bestS = s;
        bestE = e;
      }
    }

    state.attempts++;

    if (bestJ >= 0 && bestSum > minImp) {
      // Subtract the delta EXACTLY ONCE per covered pixel, clamped at 0
      // (Bresenham never revisits a pixel within one chord). The running
      // darkness sum is updated from the stored values, so it stays exact.
      for (let k = bestS; k < bestE; k++) {
        const idx = pixels[k];
        const old = darkness[idx];
        const v = old - delta;
        if (v > 0) {
          darkness[idx] = v;
          state.remainingDarkness -= old - darkness[idx];
        } else {
          darkness[idx] = 0;
          state.remainingDarkness -= old;
        }
      }
      out[state.passIndex * 2] = cur;
      out[state.passIndex * 2 + 1] = bestJ;
      state.passIndex++;
      written++;
      state.totalChordPx += bestE - bestS;
      const ddx = pinPx[bestJ * 2] - pinPx[cur * 2];
      const ddy = pinPx[bestJ * 2 + 1] - pinPx[cur * 2 + 1];
      state.totalThreadEuclidPx += Math.sqrt(ddx * ddx + ddy * ddy); // exact f64: integers < 2^53, sqrt correctly rounded
      state.consecutiveFails = 0;
      cur = bestJ;
      if (state.passIndex >= cfg.maxPasses) state.stopReason = "budget";
    } else {
      state.consecutiveFails++;
      if (state.consecutiveFails >= cfg.convergenceFails) state.stopReason = "converged";
    }
  }

  state.currentPin = cur;
  return { written, passIndex: state.passIndex, stopReason: state.stopReason };
}

// ── One-shot convenience wrapper ────────────────────────────────────────
// weave(greyscale, config?, tables?) → full deterministic run. `tables` is
// optional (built from the derived size + resolved pinCount when omitted);
// pass a cached buildTables() result to reuse tables across runs (RQ1 D3).
export function weave(greyscale, config = {}, tables = null) {
  if (!(greyscale instanceof Float32Array)) {
    throw new TypeError("greyscale must be a Float32Array (T2 ingest contract: row-major d² luma)");
  }
  const size = Math.sqrt(greyscale.length);
  if (size !== Math.floor(size) || size < 2) {
    throw new RangeError(`greyscale length must be a perfect square >= 4, row-major d² (got ${greyscale.length})`);
  }
  const resolved = resolveConfig(config);
  const tbl = tables !== null ? tables : buildTables(size, resolved.pinCount);

  const state = createWeaveState(greyscale, resolved);
  const out = new Int16Array(resolved.maxPasses * 2);
  weavePasses(state, tbl, resolved.maxPasses, out);

  const passesUsed = state.passIndex;
  const seq = out.subarray(0, passesUsed * 2); // (fromPin, toPin) pairs
  const records = new Array(passesUsed);
  for (let p = 0; p < passesUsed; p++) {
    records[p] = { fromPin: out[p * 2], toPin: out[p * 2 + 1] };
  }
  return {
    seq, // Int16Array(2·passesUsed) — compact canonical form (T4 transfer, T7 txt, T8 hash)
    records, // [{fromPin, toPin}, …] — readable pass records
    passesUsed, // threads emitted
    stopReason: state.stopReason, // "budget" | "converged"
    totalChordPx: state.totalChordPx, // canonical Σ chord px (RQ3/T5)
    totalThreadEuclidPx: state.totalThreadEuclidPx, // Σ Euclidean pin distance in px (RQ3 mapping)
    initialDarkness: state.initialDarkness,
    remainingDarkness: state.remainingDarkness, // T8 mean-pixel-error inputs
    config: resolved,
    state, // final weave state (state.darkness = remaining wanted darkness)
    tables: tbl,
  };
}

// Sequence hash for determinism checks (same mixer as the RQ1 spike, so
// spike-era hashes stay comparable). Works on any Int16Array-like.
export function hashSequence(seq) {
  let h = 0x9e3779b9;
  for (let k = 0; k < seq.length; k++) {
    h = Math.imul(h ^ seq[k], 0x85ebca6b) ^ (h >>> 13);
  }
  return (h >>> 0).toString(16);
}
