#!/usr/bin/env node
/**
 * DISPOSABLE SPIKE BENCHMARK — RQ1 compute architecture (thread-art).
 * NOT production code. Lives under docs/ultron/research/spikes/ on purpose.
 *
 * Compares three greedy-thread-engine architectures on identical synthetic input:
 *   A) Precompute-all  : build pixel-index lists for all 44,850 chords up front
 *                        (flattened Uint32 indices + Uint32 offsets), greedy
 *                        steps just sum lists.
 *   B) On-the-fly      : fused Bresenham rasterize+sum per candidate per step,
 *                        no cache, no index materialization (strongest form of B).
 *   C) Lazy memoization: rasterize a chord on first evaluation, cache per-chord
 *                        Uint32Array in a Map.
 *
 * Also simulates chunked main-thread time-slicing (setTimeout budget slices) on
 * architecture A to quantify wall-time inflation of the no-Worker fallback.
 *
 * Run:  node docs/ultron/research/spikes/rq1-bench.js
 * Env:  Node >= 18 (uses global performance). Node 24.8.0 used for recorded run.
 */

'use strict';

// ---------------------------------------------------------------------------
// Parameters (mirrors RQ1 statement + plan.md T3 defaults)
// ---------------------------------------------------------------------------
const SIZE = 600;            // working resolution (square canvas)
const PINS = 300;            // pins on circle
const RADIUS = 298;          // circle radius in px (diameter ~600 px)
const PASSES = 4000;         // greedy passes
const SKIP_ADJACENT = 2;     // cyclic pin distance <= this is not a candidate
const DELTA = 24 / 255;      // per-thread lightening delta (RQ2 ballpark)
const SEED = 20260827;       // deterministic synthetic image
const RUNS = 3;              // median-of-N for each timed phase

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + synthetic 600x600 greyscale "portrait"
// Darkness convention: 0 = white, 1 = black. Float32Array, length SIZE*SIZE.
// Pixels outside the circle are 0 (chords stay inside the circle anyway).
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeImage() {
  const img = new Float32Array(SIZE * SIZE);
  const rnd = mulberry32(SEED);
  const cx = SIZE / 2, cy = SIZE / 2;
  // 5 soft dark blobs (deterministic placement via seeded rnd) on light ground
  const blobs = [];
  for (let b = 0; b < 5; b++) {
    const ang = rnd() * Math.PI * 2;
    const dist = rnd() * RADIUS * 0.55;
    blobs.push({
      x: cx + Math.cos(ang) * dist,
      y: cy + Math.sin(ang) * dist,
      r: 60 + rnd() * 120,
      a: 0.45 + rnd() * 0.5,
    });
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > RADIUS * RADIUS) continue; // outside circle: 0
      let d = 0.04 + rnd() * 0.05; // light paper noise (keeps sums non-degenerate)
      for (const b of blobs) {
        const bx = x - b.x, by = y - b.y;
        const dd = Math.sqrt(bx * bx + by * by);
        if (dd < b.r) d += b.a * (1 - dd / b.r) * (1 - dd / b.r);
      }
      img[y * SIZE + x] = Math.min(1, d);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// Pin geometry + candidate rule
// ---------------------------------------------------------------------------
function makePins() {
  const pins = new Float64Array(PINS * 2);
  const c = SIZE / 2;
  for (let i = 0; i < PINS; i++) {
    const t = (i / PINS) * Math.PI * 2;
    pins[i * 2] = c + Math.cos(t) * RADIUS;
    pins[i * 2 + 1] = c + Math.sin(t) * RADIUS;
  }
  return pins;
}

function cyclicDist(i, j, n) {
  const d = Math.abs(i - j);
  return Math.min(d, n - d);
}

/** Candidate pin lists per source pin (shared by A/B/C). */
function makeCandidates() {
  const cand = new Array(PINS);
  for (let i = 0; i < PINS; i++) {
    const list = [];
    for (let j = 0; j < PINS; j++) {
      if (j === i) continue;
      if (cyclicDist(i, j, PINS) <= SKIP_ADJACENT) continue;
      list.push(j);
    }
    cand[i] = list;
  }
  return cand;
}

/**
 * COMPACT chord id for unordered pair (i,j), i != j: id in [0, C(PINS,2)).
 * lo=min(i,j), hi=max(i,j): id = lo*(2*PINS-lo-1)/2 + (hi-lo-1).
 */
function chordId(i, j) {
  const lo = i < j ? i : j, hi = i < j ? j : i;
  return (lo * (2 * PINS - lo - 1)) / 2 + (hi - lo - 1);
}
const N_CHORDS = (PINS * (PINS - 1)) / 2;

// ---------------------------------------------------------------------------
// Chord table build (single pass, exact-size output; capacity-allocated scratch)
// Returns { pixels: Uint32Array, offsets: Uint32Array(nChords+1), totalPx, ms }
// offsets[k] .. offsets[k+1] delimit chord id k's pixel indices.
// ---------------------------------------------------------------------------
function buildTables(pins, cand) {
  const t0 = performance.now();
  const cap = Math.ceil(N_CHORDS * 1.30 * 0.9 * (4 * RADIUS / Math.PI)) + 4096; // generous
  const scratch = new Uint32Array(cap);
  const lens = new Uint32Array(N_CHORDS);
  let totalPx = 0;
  const px = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < PINS; i++) {
    for (const j of cand[i]) {
      if (j < i) continue; // each unordered pair once
      // inline Bresenham writing into scratch
      let x0 = Math.round(pins[i * 2]), y0 = Math.round(pins[i * 2 + 1]);
      const x1 = Math.round(pins[j * 2]), y1 = Math.round(pins[j * 2 + 1]);
      const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
      const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      let s = totalPx;
      for (;;) {
        scratch[s++] = y0 * SIZE + x0;
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
      lens[chordId(i, j)] = s - totalPx;
      totalPx = s;
    }
  }
  // compact + build offsets
  const pixels = new Uint32Array(totalPx);
  pixels.set(scratch.subarray(0, totalPx));
  const offsets = new Uint32Array(N_CHORDS + 1);
  let acc = 0;
  for (let k = 0; k < N_CHORDS; k++) { offsets[k] = acc; acc += lens[k]; }
  offsets[N_CHORDS] = acc;
  return { pixels, offsets, totalPx, ms: performance.now() - t0 };
}

// ---------------------------------------------------------------------------
// Shared greedy inner loop over prebuilt tables (used by A, TTFT probe, chunked)
// steps: pass records written into seq (Int16 pairs). Returns nothing.
// ---------------------------------------------------------------------------
function greedyWithTables(state, pins, cand, pixels, offsets, seq, from, to) {
  let cur = from;
  for (let step = from; step < to; step++) {
    let bestJ = -1, bestSum = -1;
    const list = cand[cur];
    for (let c = 0; c < list.length; c++) {
      const j = list[c];
      const id = chordId(cur, j);
      const s = offsets[id], e = offsets[id + 1];
      let sum = 0;
      for (let k = s; k < e; k++) sum += state[pixels[k]];
      if (sum > bestSum) { bestSum = sum; bestJ = j; } // strict >: lowest j wins ties
    }
    const id = chordId(cur, bestJ);
    const s = offsets[id], e = offsets[id + 1];
    for (let k = s; k < e; k++) {
      const v = state[pixels[k]] - DELTA;
      state[pixels[k]] = v > 0 ? v : 0;
    }
    seq[step * 2] = cur; seq[step * 2 + 1] = bestJ;
    cur = bestJ;
  }
}

// ---------------------------------------------------------------------------
// ARCH A: precompute-all tables, then greedy
// ---------------------------------------------------------------------------
function runArchA(img, pins, cand) {
  const tables = buildTables(pins, cand);
  const state = Float32Array.from(img);
  const seq = new Int16Array(PASSES * 2);
  const t0 = performance.now();
  greedyWithTables(state, pins, cand, tables.pixels, tables.offsets, seq, 0, PASSES);
  const greedyMs = performance.now() - t0;
  const memBytes = tables.pixels.byteLength + tables.offsets.byteLength;
  const visited = new Set();
  for (let k = 0; k < PASSES; k++) visited.add(seq[k * 2]);
  return {
    seq, buildMs: tables.ms, greedyMs, perStepMs: greedyMs / PASSES,
    memBytes, totalPx: tables.totalPx, visitedPins: visited.size,
  };
}

// ---------------------------------------------------------------------------
// ARCH B: on-the-fly FUSED rasterize+sum (no cache, no index materialization)
// This is the strongest realistic form of B: single Bresenham walk per
// candidate that sums state[y*SIZE+x] inline.
// ---------------------------------------------------------------------------
function runArchB(img, pins, cand) {
  const state = Float32Array.from(img);
  const seq = new Int16Array(PASSES * 2);
  let cur = 0;
  const t0 = performance.now();
  for (let step = 0; step < PASSES; step++) {
    let bestJ = -1, bestSum = -1;
    const list = cand[cur];
    const cx0 = Math.round(pins[cur * 2]), cy0 = Math.round(pins[cur * 2 + 1]);
    for (let c = 0; c < list.length; c++) {
      const j = list[c];
      // canonical direction (lo->hi): Bresenham pixel sets are direction-dependent;
      // canonicalizing keeps B bit-identical with A's tables (see determinism check)
      const lo = cur < j ? cur : j, hi = cur < j ? j : cur;
      let x0 = lo === cur ? cx0 : Math.round(pins[lo * 2]);
      let y0 = lo === cur ? cy0 : Math.round(pins[lo * 2 + 1]);
      const x1 = Math.round(pins[hi * 2]), y1 = Math.round(pins[hi * 2 + 1]);
      const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
      const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      let sum = 0;
      for (;;) {
        sum += state[y0 * SIZE + x0];
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
      if (sum > bestSum) { bestSum = sum; bestJ = j; }
    }
    // subtract along chosen chord (canonical lo->hi walk, deterministic)
    const lo = cur < bestJ ? cur : bestJ, hi = cur < bestJ ? bestJ : cur;
    let x0 = Math.round(pins[lo * 2]), y0 = Math.round(pins[lo * 2 + 1]);
    const x1 = Math.round(pins[hi * 2]), y1 = Math.round(pins[hi * 2 + 1]);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      const idx = y0 * SIZE + x0;
      const v = state[idx] - DELTA;
      state[idx] = v > 0 ? v : 0;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    seq[step * 2] = cur; seq[step * 2 + 1] = bestJ;
    cur = bestJ;
  }
  const ms = performance.now() - t0;
  return { seq, ms, perStepMs: ms / PASSES };
}

// ---------------------------------------------------------------------------
// ARCH C: lazy memoization — per-chord Uint32Array built on first use, Map cache
// ---------------------------------------------------------------------------
function runArchC(img, pins, cand) {
  const state = Float32Array.from(img);
  const seq = new Int16Array(PASSES * 2);
  const cache = new Map();
  const tmp = []; // plain array scratch for first rasterization
  let cachedBytes = 0, misses = 0, hits = 0;
  let cur = 0;
  const t0 = performance.now();
  for (let step = 0; step < PASSES; step++) {
    let bestJ = -1, bestSum = -1;
    const list = cand[cur];
    for (let c = 0; c < list.length; c++) {
      const j = list[c];
      const key = chordId(cur, j);
      let arr = cache.get(key);
      if (arr === undefined) {
        tmp.length = 0;
        // rasterize in canonical lo->hi direction (matches A's tables bit-for-bit)
        const lo = cur < j ? cur : j, hi = cur < j ? j : cur;
        let x0 = Math.round(pins[lo * 2]), y0 = Math.round(pins[lo * 2 + 1]);
        const x1 = Math.round(pins[hi * 2]), y1 = Math.round(pins[hi * 2 + 1]);
        const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
        const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
          tmp.push(y0 * SIZE + x0);
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
        arr = Uint32Array.from(tmp);
        cache.set(key, arr);
        cachedBytes += arr.byteLength;
        misses++;
      } else hits++;
      let sum = 0;
      for (let k = 0; k < arr.length; k++) sum += state[arr[k]];
      if (sum > bestSum) { bestSum = sum; bestJ = j; }
    }
    const arr = cache.get(chordId(cur, bestJ));
    for (let k = 0; k < arr.length; k++) {
      const v = state[arr[k]] - DELTA;
      state[arr[k]] = v > 0 ? v : 0;
    }
    seq[step * 2] = cur; seq[step * 2 + 1] = bestJ;
    cur = bestJ;
  }
  const ms = performance.now() - t0;
  return {
    seq, ms, perStepMs: ms / PASSES, misses, hits,
    cachedChords: cache.size, cachedBytes,
    cachedBytesPlusOverhead: cachedBytes + cache.size * 48, // Map entry + array header est.
  };
}

// ---------------------------------------------------------------------------
// Chunked main-thread simulation on arch A (the no-Worker fallback):
// greedy in slices with a per-slice compute budget, setTimeout(0) between slices.
// ---------------------------------------------------------------------------
function runChunkedA(img, pins, cand, pixels, offsets, budgetMs, done) {
  const state = Float32Array.from(img);
  const seq = new Int16Array(PASSES * 2);
  let step = 0, slices = 0, computeMs = 0;
  const t0 = performance.now();
  function slice() {
    const ts = performance.now();
    let cur = step === 0 ? 0 : seq[(step - 1) * 2 + 1];
    for (; step < PASSES; step++) {
      // one pass inline (same as greedyWithTables body, plus budget check)
      let bestJ = -1, bestSum = -1;
      const list = cand[cur];
      for (let c = 0; c < list.length; c++) {
        const j = list[c];
        const id = chordId(cur, j);
        const s = offsets[id], e = offsets[id + 1];
        let sum = 0;
        for (let k = s; k < e; k++) sum += state[pixels[k]];
        if (sum > bestSum) { bestSum = sum; bestJ = j; }
      }
      const id = chordId(cur, bestJ);
      const s = offsets[id], e = offsets[id + 1];
      for (let k = s; k < e; k++) {
        const v = state[pixels[k]] - DELTA;
        state[pixels[k]] = v > 0 ? v : 0;
      }
      seq[step * 2] = cur; seq[step * 2 + 1] = bestJ;
      cur = bestJ;
      if (performance.now() - ts >= budgetMs) { step++; break; }
    }
    slices++;
    computeMs += performance.now() - ts;
    if (step < PASSES) setTimeout(slice, 0);
    else done({ seq, ms: performance.now() - t0, slices, computeMs });
  }
  setTimeout(slice, 0);
}

// ---------------------------------------------------------------------------
// Determinism helpers
// ---------------------------------------------------------------------------
function hashSeq(seq) {
  let h = 0x9E3779B9;
  for (let k = 0; k < seq.length; k++) h = Math.imul(h ^ seq[k], 0x85EBCA6B) ^ (h >>> 13);
  return (h >>> 0).toString(16);
}
function seqEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}
const median = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
const fmtBytes = (b) => (b / 1048576).toFixed(1) + ' MB';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`node ${process.version} | SIZE=${SIZE} PINS=${PINS} RADIUS=${RADIUS} PASSES=${PASSES} SKIP_ADJ=${SKIP_ADJACENT} DELTA=${DELTA.toFixed(3)} RUNS=${RUNS}`);
  console.log(`date: ${new Date().toISOString()}\n`);

  const img = makeImage();
  const pins = makePins();
  const cand = makeCandidates();
  const candPerStep = cand[0].length;
  const totalEvals = candPerStep * PASSES;
  console.log(`candidates per step (skip rule |cyc dist|<=${SKIP_ADJACENT}): ${candPerStep}`);
  console.log(`candidate chord evaluations per run: ${totalEvals.toLocaleString()}`);
  console.log(`expected pixel reads per run (analytic): ~${Math.round(totalEvals * 0.9003 * (4 * RADIUS / Math.PI)).toLocaleString()} px\n`);

  // ---- sanity: chordId compactness ----
  {
    const seen = new Set();
    let ok = true;
    for (let i = 0; i < PINS && ok; i++)
      for (let j = i + 1; j < PINS; j++) {
        const id = chordId(i, j);
        if (id < 0 || id >= N_CHORDS || seen.has(id)) { ok = false; break; }
        seen.add(id);
      }
    console.log(`chordId compact bijection over [0,${N_CHORDS}): ${ok ? 'OK' : 'FAIL'}\n`);
  }

  // ---- ARCH A ----
  let a;
  {
    const builds = [], greedys = [];
    for (let r = 0; r < RUNS; r++) {
      a = runArchA(img, pins, cand);
      builds.push(a.buildMs); greedys.push(a.greedyMs);
    }
    const build = median(builds), greedy = median(greedys);
    console.log('ARCH A (precompute-all):');
    console.log(`  chord-table build : ${build.toFixed(1)} ms (median of ${RUNS})`);
    console.log(`  greedy loop       : ${greedy.toFixed(1)} ms  (${(greedy / PASSES * 1000).toFixed(1)} us/step)`);
    console.log(`  TOTAL             : ${(build + greedy).toFixed(1)} ms`);
    console.log(`  memory            : ${fmtBytes(a.memBytes)} total (pixels ${a.totalPx.toLocaleString()} Uint32 = ${fmtBytes(a.totalPx * 4)} + offsets ${fmtBytes(a.offsetsBytes || N_CHORDS * 4 + 4)})`);
    console.log(`  pixels/chord avg  : ${(a.totalPx / N_CHORDS).toFixed(1)} px (analytic 0.9003*4R/pi = ${(0.9003 * 4 * RADIUS / Math.PI).toFixed(1)})`);
    console.log(`  distinct pins seen: ${a.visitedPins}/${PINS}`);
    console.log(`  seq hash          : ${hashSeq(a.seq)}\n`);
  }

  // ---- ARCH B ----
  let b;
  {
    const runs = [];
    for (let r = 0; r < RUNS; r++) { b = runArchB(img, pins, cand); runs.push(b.ms); }
    const ms = median(runs);
    console.log('ARCH B (on-the-fly, fused Bresenham+sum):');
    console.log(`  greedy loop       : ${ms.toFixed(1)} ms (median of ${RUNS}) (${(ms / PASSES * 1000).toFixed(1)} us/step)`);
    console.log(`  vs A              : loop ${(ms / a.greedyMs).toFixed(2)}x A-loop; ${(ms / (a.buildMs + a.greedyMs)).toFixed(2)}x A-total`);
    console.log(`  memory            : ~0 extra (state + seq only)`);
    console.log(`  seq hash          : ${hashSeq(b.seq)}\n`);
  }

  // ---- ARCH C ----
  let c;
  {
    const runs = [];
    for (let r = 0; r < RUNS; r++) { c = runArchC(img, pins, cand); runs.push(c.ms); }
    const ms = median(runs);
    console.log('ARCH C (lazy memoization, Map<chordId, Uint32Array>):');
    console.log(`  greedy loop       : ${ms.toFixed(1)} ms (median of ${RUNS}) (${(ms / PASSES * 1000).toFixed(1)} us/step)`);
    console.log(`  cache miss/hit    : ${c.misses.toLocaleString()} misses / ${c.hits.toLocaleString()} hits`);
    console.log(`  chords cached     : ${c.cachedChords.toLocaleString()} of ${N_CHORDS.toLocaleString()} (${(c.cachedChords / N_CHORDS * 100).toFixed(1)}%)`);
    console.log(`  memory at end     : ${fmtBytes(c.cachedBytes)} raw (+~${fmtBytes(c.cachedChords * 48)} headers)`);
    console.log(`  seq hash          : ${hashSeq(c.seq)}\n`);
  }

  // ---- determinism cross-check ----
  const a2 = runArchA(img, pins, cand);
  console.log('determinism cross-check: A==A\' ' + (seqEquals(a.seq, a2.seq) ? 'OK' : 'FAIL')
    + ' | A==B ' + (seqEquals(a.seq, b.seq) ? 'OK' : 'FAIL')
    + ' | A==C ' + (seqEquals(a.seq, c.seq) ? 'OK' : 'FAIL') + '\n');

  // ---- TTFT probe (worker path, arch A): table build + first 64 passes ----
  {
    const tt = [];
    for (let r = 0; r < RUNS; r++) {
      const t0 = performance.now();
      const tables = buildTables(pins, cand);
      const state = Float32Array.from(img);
      const seq = new Int16Array(64 * 2);
      greedyWithTables(state, pins, cand, tables.pixels, tables.offsets, seq, 0, 64);
      tt.push(performance.now() - t0);
    }
    const ms = median(tt);
    console.log(`TTFT probe (A: build + first 64 passes, median of ${RUNS}): ${ms.toFixed(1)} ms (${(ms / 1000).toFixed(2)} s; budget 2 s)\n`);
  }

  // ---- chunked main-thread fallback simulation (A tables, 8 ms slices) ----
  await new Promise((resolve) => {
    const tables = buildTables(pins, cand);
    runChunkedA(img, pins, cand, tables.pixels, tables.offsets, 8, (res) => {
      console.log('CHUNKED MAIN-THREAD FALLBACK (A tables, 8 ms compute budget, setTimeout(0)):');
      console.log(`  wall time         : ${res.ms.toFixed(1)} ms over ${res.slices} slices (${(res.ms / PASSES * 1000).toFixed(1)} us/step effective)`);
      console.log(`  compute in slices : ${res.computeMs.toFixed(1)} ms; scheduling overhead ${(res.ms - res.computeMs).toFixed(1)} ms`);
      console.log(`  vs A continuous   : ${(res.ms / a.greedyMs).toFixed(2)}x loop-only, ${(res.ms / (a.buildMs + a.greedyMs)).toFixed(2)}x incl. build`);
      console.log(`  seq hash          : ${hashSeq(res.seq)} (matches A: ${seqEquals(res.seq, a.seq) ? 'OK' : 'FAIL'})\n`);
      resolve();
    });
  });

  console.log('DONE (disposable spike; numbers recorded in rq1-compute-architecture.md)');
}

main().catch((e) => { console.error(e); process.exit(1); });
