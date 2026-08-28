// Thread Art — engine unit tests (T3).
//
// Node-runnable, zero dependencies:  node tests/engine.test.mjs
// (uses node:assert + the global performance timer; Node >= 18).
//
// Narrowest checks first: config/geometry/table exactness, then single-pass
// subtraction semantics, then loop rules (neighborSkip, tie-break, stopping),
// then determinism (repeat / table reuse / chunked), then boundary params,
// then convergence behaviour, and finally the RQ1-spike-style perf smoke at
// the committed defaults (600 px / 300 pins / 4000 passes).

import { strict as assert } from "node:assert";
import {
  ENGINE_KNOBS,
  DEFAULT_ENGINE_CONFIG,
  autoNeighborSkip,
  resolveConfig,
  cyclicPinDistance,
  chordId,
  defaultRadius,
  pinPositions,
  buildTables,
  createWeaveState,
  weavePasses,
  weave,
  hashSequence,
} from "../src/engine.js";

// ---------------------------------------------------------------- helpers

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// Deterministic PRNG (mulberry32 — same as the RQ1 spike).
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Synthetic engine input (LUMA domain, the T2 contract): `blobs` are
// {x, y, r, a} Gaussian-ish dark spots (a = peak added darkness), paper is
// [base, range] uniform noise. Returned Float32Array is row-major size².
function lumaImage(size, blobs, paper, seed) {
  const rnd = mulberry32(seed);
  const luma = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let d = paper[0] + rnd() * paper[1];
      for (const b of blobs) {
        const bx = x - b.x;
        const by = y - b.y;
        const dd = Math.sqrt(bx * bx + by * by);
        if (dd < b.r) {
          const f = 1 - dd / b.r;
          d += b.a * f * f;
        }
      }
      luma[y * size + x] = Math.max(0, Math.min(1, 1 - d));
    }
  }
  return luma;
}

function uniformLuma(size, value) {
  const a = new Float32Array(size * size);
  a.fill(value);
  return a;
}

// Oracle for one greedy pass: mirrors the committed rule (ascending
// candidates, strict > ⇒ lowest pin index wins ties) against the tables.
// scoreNorm mirrors the engine's FL-1 normalization ("mean" divides the
// summed darkness by the chord's pixel count).
function oraclePass(darkness, tables, cur, skip, scoreNorm = "mean") {
  const n = tables.pinCount;
  let bestJ = -1;
  let bestSum = -Infinity;
  let bestS = 0;
  let bestE = 0;
  for (let j = 0; j < n; j++) {
    if (j === cur) continue;
    if (cyclicPinDistance(cur, j, n) <= skip) continue;
    const id = chordId(cur, j, n);
    const s = tables.offsets[id];
    const e = tables.offsets[id + 1];
    let sum = 0;
    for (let k = s; k < e; k++) sum += darkness[tables.pixels[k]];
    const score = scoreNorm === "mean" ? sum / (e - s) : sum;
    if (score > bestSum) {
      bestSum = score;
      bestJ = j;
      bestS = s;
      bestE = e;
    }
  }
  return { bestJ, bestSum, bestS, bestE };
}

// Apply the engine's exact subtraction semantics for one chord.
function oracleSubtract(darkness, tables, s, e, delta) {
  let remaining = 0;
  for (let k = s; k < e; k++) {
    const idx = tables.pixels[k];
    const old = darkness[idx];
    const v = old - delta;
    darkness[idx] = v > 0 ? Math.fround(v) : 0;
    remaining += old - darkness[idx];
  }
  return remaining;
}

let bigTablesCache = null;
function bigTables() {
  // Committed default geometry: 600 px, 300 pins, radius 298 (RQ1 spike).
  if (!bigTablesCache) bigTablesCache = buildTables(600, 300);
  return bigTablesCache;
}

// RQ1-spike-style synthetic 600×600 portrait: 5 seeded soft blobs + paper
// noise (same generator as the spike's makeImage, seed 20260827). Rich enough
// that even 8000 passes at delta 4/255 do not exhaust it.
function spikePortraitLuma() {
  const rnd = mulberry32(20260827);
  const blobs = [];
  for (let b = 0; b < 5; b++) {
    const ang = rnd() * Math.PI * 2;
    const dist = rnd() * 298 * 0.55;
    blobs.push({
      x: 300 + Math.cos(ang) * dist,
      y: 300 + Math.sin(ang) * dist,
      r: 60 + rnd() * 120,
      a: 0.45 + rnd() * 0.5,
    });
  }
  return lumaImage(600, blobs, [0.04, 0.05], 20260827);
}

// ---------------------------------------------------------------- 1. config

test("config: RQ2 defaults + knob ranges exported", () => {
  assert.deepEqual(ENGINE_KNOBS.pinCount, { min: 200, max: 500, default: 300, label: "Pins" });
  assert.deepEqual(ENGINE_KNOBS.maxPasses, { min: 1000, max: 8000, default: 4000, label: "Coverage (passes)" });
  assert.deepEqual(ENGINE_KNOBS.lighteningDelta255, { min: 4, max: 32, default: 8, label: "Darkness (0–255 scale)" });
  assert.deepEqual(ENGINE_KNOBS.neighborSkip, { min: 0, max: 25, default: "auto", label: "Min chord gap (pins)" });
  assert.deepEqual(DEFAULT_ENGINE_CONFIG, {
    pinCount: 300,
    maxPasses: 4000,
    lighteningDelta: 8 / 255,
    neighborSkip: "auto",
    minImprovement: 0,
    convergenceFails: 3,
    startPin: 0,
    scoreNorm: "mean",
  });
  assert.ok(Object.isFrozen(DEFAULT_ENGINE_CONFIG));
});

test("config: resolveConfig — auto skip resolution, overrides, idempotence", () => {
  assert.equal(autoNeighborSkip(300), 10); // RQ2: round(n/30) at 300 pins
  assert.equal(autoNeighborSkip(200), 7);
  assert.equal(autoNeighborSkip(500), 17);
  const base = resolveConfig();
  assert.equal(base.pinCount, 300);
  assert.equal(base.maxPasses, 4000);
  assert.equal(base.neighborSkip, 10); // "auto" resolved
  assert.equal(base.lighteningDelta, 8 / 255);
  assert.equal(base.minImprovement, 0);
  assert.equal(base.convergenceFails, 3);
  assert.equal(base.scoreNorm, "mean"); // FL-1 default: length-normalized chords
  assert.ok(Object.isFrozen(base));

  const over = resolveConfig({ pinCount: 200, maxPasses: 8000, lighteningDelta: 4 / 255, neighborSkip: 25, startPin: 5, scoreNorm: "sum" });
  assert.equal(over.neighborSkip, 25); // explicit value passes through
  assert.equal(over.startPin, 5);
  assert.equal(over.scoreNorm, "sum");
  assert.deepEqual(resolveConfig(over), over); // idempotent on resolved configs
  assert.throws(() => resolveConfig({ scoreNorm: "median" }), RangeError);
});

test("config: resolveConfig rejects degenerate values", () => {
  assert.throws(() => resolveConfig({ pinCount: 1 }), RangeError);
  assert.throws(() => resolveConfig({ pinCount: 300.5 }), RangeError);
  assert.throws(() => resolveConfig({ pinCount: 40000 }), RangeError); // Int16Array records
  assert.throws(() => resolveConfig({ maxPasses: 0 }), RangeError);
  assert.throws(() => resolveConfig({ lighteningDelta: 0 }), RangeError);
  assert.throws(() => resolveConfig({ lighteningDelta: -0.1 }), RangeError);
  assert.throws(() => resolveConfig({ lighteningDelta: 2 }), RangeError); // > 1 (255-scale value passed raw?)
  assert.throws(() => resolveConfig({ neighborSkip: -1 }), RangeError);
  assert.throws(() => resolveConfig({ pinCount: 8, neighborSkip: 4 }), RangeError); // >= floor(8/2): no candidates
  assert.throws(() => resolveConfig({ neighborSkip: "lots" }), RangeError);
  assert.throws(() => resolveConfig({ convergenceFails: 0 }), RangeError);
  assert.throws(() => resolveConfig({ pinCount: 8, startPin: 8 }), RangeError);
  assert.throws(() => resolveConfig({ minImprovement: "high" }), RangeError);
  assert.throws(() => resolveConfig(null), TypeError);
});

// ------------------------------------------------------------ 2. geometry

test("pins: exact placement math (pin 0 at 3 o'clock, clockwise on screen)", () => {
  assert.equal(defaultRadius(600), 298); // RQ1 spike geometry
  assert.equal(defaultRadius(100), 48);
  assert.equal(defaultRadius(4), 1); // clamped minimum

  const p = pinPositions(600, 300);
  // Angles that hit the axes exactly: cos/sin of these return exact ±1/±0.
  assert.equal(p[0], 598); // pin 0: 3 o'clock (x = 300 + 298)
  assert.equal(p[1], 300);
  assert.equal(p[150 * 2], 2); // pin n/2: 9 o'clock (cos(Math.PI) === -1 exactly)
  assert.equal(Math.round(p[150 * 2 + 1]), 300); // sin(Math.PI) = 1.2e-16 → 300.00000000000006
  // Screen y grows downward ⇒ clockwise: pin n/4 at 6 o'clock, 3n/4 at 12.
  assert.equal(Math.round(p[75 * 2]), 300);
  assert.equal(Math.round(p[75 * 2 + 1]), 598);
  assert.equal(Math.round(p[225 * 2]), 300);
  assert.equal(Math.round(p[225 * 2 + 1]), 2);
  assert.ok(p[75 * 2 + 1] > p[1]); // below pin 0 ⇒ clockwise, not counter-

  const q = pinPositions(600, 4, 298); // explicit radius honored
  assert.equal(Math.round(q[0]), 598);
  assert.equal(Math.round(q[2]), 300);
  assert.equal(Math.round(q[4]), 2);
  assert.equal(Math.round(q[6]), 300);
});

test("chordId: compact bijection over all unordered pairs", () => {
  assert.equal(chordId(0, 1, 8), 0);
  assert.equal(chordId(0, 7, 8), 6); // (0,j) maps to j-1
  assert.equal(chordId(6, 7, 8), 27); // last pair → C(8,2)-1
  assert.equal(chordId(5, 2, 8), chordId(2, 5, 8)); // symmetric

  for (const n of [8, 300]) {
    const seen = new Set();
    let max = -1;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const id = chordId(i, j, n);
        assert.ok(id >= 0 && id < (n * (n - 1)) / 2, `id ${id} in range for (${i},${j})`);
        assert.ok(!seen.has(id), `id ${id} unique for (${i},${j})`);
        seen.add(id);
        if (id > max) max = id;
      }
    }
    assert.equal(seen.size, (n * (n - 1)) / 2);
    assert.equal(max, (n * (n - 1)) / 2 - 1);
  }
});

// ------------------------------------------------------------- 3. tables

test("tables: structure, exact sizes, deterministic rebuild", () => {
  const t = buildTables(64, 24);
  assert.equal(t.size, 64);
  assert.equal(t.pinCount, 24);
  assert.equal(t.radius, defaultRadius(64));
  assert.equal(t.nChords, (24 * 23) / 2);
  assert.equal(t.offsets.length, t.nChords + 1);
  assert.equal(t.pixels.length, t.totalPx);
  assert.equal(t.offsets[t.nChords], t.totalPx); // offsets prefix-sum ends exactly
  let mono = true;
  for (let k = 0; k <= t.nChords; k++) {
    if (k > 0 && t.offsets[k] < t.offsets[k - 1]) mono = false;
  }
  assert.ok(mono, "offsets monotone non-decreasing");
  for (let k = 0; k < t.totalPx; k++) {
    assert.ok(t.pixels[k] >= 0 && t.pixels[k] < 64 * 64, "pixel index in bounds");
  }
  assert.equal(t.pinPx.length, 48);
  assert.equal(t.pins.length, 48);

  const t2 = buildTables(64, 24);
  assert.deepEqual([...t2.offsets], [...t.offsets]);
  assert.deepEqual([...t2.pixels], [...t.pixels]);
});

test("tables: horizontal chord (0 → n/2) covers exactly row c, pin-to-pin", () => {
  const t = bigTables(); // 600 px, 300 pins, r = 298
  const id = chordId(0, 150, 300);
  const s = t.offsets[id];
  const e = t.offsets[id + 1];
  assert.equal(e - s, 597); // x from 598 down to 2 inclusive
  assert.equal(t.pixels[s], 300 * 600 + 598); // starts AT pin 0's pixel
  assert.equal(t.pixels[e - 1], 300 * 600 + 2); // ends AT pin 150's pixel
  for (let k = s; k < e; k++) {
    const idx = t.pixels[k];
    assert.equal(Math.floor(idx / 600), 300, "row 300 only");
    if (k > s) assert.equal(t.pixels[k], t.pixels[k - 1] - 1, "contiguous −1 steps (lo→hi = right→left)");
  }
});

test("tables: no duplicate pixel index within any chord's list", () => {
  const t = buildTables(64, 24);
  const scratch = [];
  for (let id = 0; id < t.nChords; id++) {
    const s = t.offsets[id];
    const e = t.offsets[id + 1];
    scratch.length = 0;
    for (let k = s; k < e; k++) scratch.push(t.pixels[k]);
    scratch.sort((a, b) => a - b);
    for (let k = 1; k < scratch.length; k++) {
      assert.ok(scratch[k] !== scratch[k - 1], `chord ${id} would lighten a pixel twice`);
    }
  }
});

// ------------------------------------------------- 4. state + subtraction

test("state: darkness conversion (1 − luma) exact, input not required to be square-free", () => {
  const luma = new Float32Array([0, 0.25, 0.5, 1]);
  const state = createWeaveState(luma, { pinCount: 4 });
  assert.equal(state.size, 2);
  assert.equal(state.darkness[0], 1);
  assert.equal(state.darkness[1], 0.75);
  assert.equal(state.darkness[2], 0.5);
  assert.equal(state.darkness[3], 0);
  assert.equal(state.initialDarkness, 1 + 0.75 + 0.5 + 0);
  assert.equal(state.currentPin, 0);
  assert.equal(state.passIndex, 0);

  assert.throws(() => createWeaveState(new Float32Array(15)), RangeError); // not a square
  assert.throws(() => createWeaveState([0, 1, 1, 0]), TypeError); // not a Float32Array
});

test("greedy: delta applied exactly once per covered pixel per pass, clamped at 0", () => {
  const tables = buildTables(64, 24);
  for (const delta255 of [4, 20, 32]) {
    // Boundary knobs 4/255 and 32/255 plus the default 20/255.
    const delta = delta255 / 255;

    // Uniform mid-grey: chosen chord pixels drop by exactly one delta.
    const luma = uniformLuma(64, 0.5);
    const r = weave(luma, { pinCount: 24, maxPasses: 1, neighborSkip: 2, lighteningDelta: delta }, tables);
    assert.equal(r.passesUsed, 1);
    assert.equal(r.records[0].fromPin, 0);
    // Oracle on the INITIAL darkness (derived from the same f32 stores):
    const init = new Float32Array(64 * 64);
    for (let i = 0; i < init.length; i++) init[i] = Math.fround(1 - luma[i]);
    const first = oraclePass(init, tables, 0, 2);
    assert.equal(r.records[0].toPin, first.bestJ, "chosen pin equals oracle argmax");
    // Mean scoring on a UNIFORM image: every candidate ties at the same mean,
    // so the lowest eligible pin wins (pin 3 at skip 2) — not the opposite
    // pin that raw sum scoring picked (sum favors the longest chord).
    assert.equal(r.records[0].toPin, 3, "uniform tie under mean scoring goes to the lowest eligible pin");
    // The same run under "sum" recovers the old behavior (opposite pin 12):
    const rSum = weave(luma, { pinCount: 24, maxPasses: 1, neighborSkip: 2, lighteningDelta: delta, scoreNorm: "sum" }, tables);
    assert.equal(rSum.records[0].toPin, 12, "sum scoring still prefers the longest chord");
    const expected = new Float32Array(init);
    oracleSubtract(expected, tables, first.bestS, first.bestE, delta);
    assert.deepEqual([...r.state.darkness], [...expected]);
    let changed = 0;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== init[i]) changed++;
    }
    assert.equal(changed, first.bestE - first.bestS, "exactly the chord's pixels changed");
    assert.ok(init[0] - delta >= 0.3, "value dropped by ~one delta, not two");

    // Near-white input (darkness < even the 4/255 knob delta): chord pixels clamp to EXACTLY 0.
    const light = uniformLuma(64, 0.99);
    const rl = weave(light, { pinCount: 24, maxPasses: 1, neighborSkip: 2, lighteningDelta: delta }, tables);
    const initL = new Float32Array(64 * 64);
    for (let i = 0; i < initL.length; i++) initL[i] = Math.fround(1 - light[i]);
    assert.ok(initL[0] < delta, "precondition: darkness below delta");
    const id = chordId(0, rl.records[0].toPin, 24);
    for (let k = tables.offsets[id]; k < tables.offsets[id + 1]; k++) {
      assert.equal(rl.state.darkness[tables.pixels[k]], 0, "clamped at 0");
    }
    let untouched = 0;
    for (let i = 0; i < rl.state.darkness.length; i++) {
      if (rl.state.darkness[i] === initL[i]) untouched++;
    }
    assert.equal(untouched, initL.length - (tables.offsets[id + 1] - tables.offsets[id]));
  }
});

test("greedy: full-run replay exactness (records + tables reproduce the final state)", () => {
  const size = 96;
  const tables = buildTables(size, 48);
  const luma = lumaImage(size, [{ x: 60, y: 38, r: 26, a: 0.9 }], [0.01, 0.01], 7);
  const cfg = { pinCount: 48, maxPasses: 300 };
  const r = weave(luma, cfg, tables);

  // Replay from a fresh conversion, applying each recorded chord in order.
  const replay = new Float32Array(size * size);
  let remaining = 0;
  let sum = 0;
  for (let i = 0; i < replay.length; i++) {
    const d = Math.fround(1 - luma[i]);
    replay[i] = d;
    sum += d;
  }
  let totalChordPx = 0;
  let totalEuclid = 0;
  for (const rec of r.records) {
    const id = chordId(rec.fromPin, rec.toPin, 48);
    const s = tables.offsets[id];
    const e = tables.offsets[id + 1];
    remaining += oracleSubtract(replay, tables, s, e, r.config.lighteningDelta);
    totalChordPx += e - s;
    const dx = tables.pinPx[rec.toPin * 2] - tables.pinPx[rec.fromPin * 2];
    const dy = tables.pinPx[rec.toPin * 2 + 1] - tables.pinPx[rec.fromPin * 2 + 1];
    totalEuclid += Math.sqrt(dx * dx + dy * dy);
  }
  assert.deepEqual([...r.state.darkness], [...replay], "final darkness reproduced exactly");
  assert.equal(r.state.remainingDarkness, sum - remaining);
  assert.equal(r.totalChordPx, totalChordPx, "running totalChordPx exact");
  assert.equal(r.totalThreadEuclidPx, totalEuclid, "running Euclidean total exact");
  assert.ok(r.totalChordPx > 0);
  // Input contract: the caller's luma array is never mutated.
  const fresh = lumaImage(size, [{ x: 60, y: 38, r: 26, a: 0.9 }], [0.01, 0.01], 7);
  assert.deepEqual([...luma], [...fresh]);
});

// --------------------------------------------------------- 5. loop rules

test("neighborSkip: no chord to the k nearest pins in either direction", () => {
  const size = 240;
  const luma = lumaImage(size, [{ x: 130, y: 110, r: 70, a: 0.9 }], [0.02, 0.02], 11);

  // Explicit skip on 200 pins.
  let r = weave(luma, { pinCount: 200, maxPasses: 300, neighborSkip: 10 });
  for (const rec of r.records) {
    assert.ok(cyclicPinDistance(rec.fromPin, rec.toPin, 200) > 10, `dist(${rec.fromPin},${rec.toPin}) > 10`);
  }
  // "auto" on 300 pins resolves to 10 (RQ2).
  r = weave(luma, { pinCount: 300, maxPasses: 300 });
  assert.equal(r.config.neighborSkip, 10);
  for (const rec of r.records) {
    assert.ok(cyclicPinDistance(rec.fromPin, rec.toPin, 300) > 10);
  }
  // Wrap-around: include runs starting near pin 0 / pin n−1.
  r = weave(luma, { pinCount: 200, maxPasses: 300, neighborSkip: 25, startPin: 199 });
  for (const rec of r.records) {
    const d = cyclicPinDistance(rec.fromPin, rec.toPin, 200);
    assert.ok(d > 25, `wrap-around distance ${d} > 25`);
  }
});

test("neighborSkip: 0 allows adjacent pins (tie-break then picks pin 1)", () => {
  // All-zero darkness + minImprovement −1 ⇒ every candidate ties at 0.
  const r = weave(uniformLuma(64, 1), {
    pinCount: 24,
    maxPasses: 3,
    neighborSkip: 0,
    minImprovement: -1,
  });
  assert.deepEqual(r.records, [
    { fromPin: 0, toPin: 1 },
    { fromPin: 1, toPin: 0 },
    { fromPin: 0, toPin: 1 },
  ]);
});

test("tie-break: guaranteed all-tie picks the lowest eligible pin index (RQ1 D2)", () => {
  // Zero image (every candidate scores exactly 0) with skip 2: eligible pins
  // from 0 are 3,4,…,299 — the FIRST strictly-greater incumbent is pin 3.
  const r = weave(uniformLuma(64, 1), {
    pinCount: 24,
    maxPasses: 3,
    neighborSkip: 2,
    minImprovement: -1,
  });
  assert.deepEqual(r.records, [
    { fromPin: 0, toPin: 3 },
    { fromPin: 3, toPin: 0 },
    { fromPin: 0, toPin: 3 },
  ]);
  assert.equal(r.state.remainingDarkness, 0); // subtraction of 0 stays clamped at 0
});

test("tie-break: symmetric centered blob matches ascending-strict-> oracle", () => {
  const size = 240;
  const tables = buildTables(size, 96);
  const luma = lumaImage(size, [{ x: 120, y: 120, r: 70, a: 0.95 }], [0.02, 0.02], 3);
  const cfg = resolveConfig({ pinCount: 96, maxPasses: 40 });

  const r = weave(luma, cfg, tables);
  assert.equal(cfg.neighborSkip, 3); // auto at 96 pins

  // Independent oracle walk over the same converted darkness.
  const darkness = new Float32Array(size * size);
  for (let i = 0; i < darkness.length; i++) darkness[i] = Math.fround(1 - luma[i]);
  let cur = 0;
  for (let p = 0; p < 40; p++) {
    const best = oraclePass(darkness, tables, cur, cfg.neighborSkip);
    assert.equal(r.records[p].fromPin, cur);
    assert.equal(r.records[p].toPin, best.bestJ, `pass ${p} matches oracle`);
    oracleSubtract(darkness, tables, best.bestS, best.bestE, cfg.lighteningDelta);
    cur = best.bestJ;
  }
});

// ---------------------------------------------------------- 6. stopping

test("stopping: blank image converges after 3 attempts, 0 threads", () => {
  const r = weave(uniformLuma(96, 1), { pinCount: 48, maxPasses: 1000 });
  assert.equal(r.passesUsed, 0);
  assert.equal(r.records.length, 0);
  assert.equal(r.seq.length, 0);
  assert.equal(r.stopReason, "converged");
  assert.equal(r.state.attempts, 3); // convergenceFails
  assert.equal(r.state.consecutiveFails, 3);
  assert.equal(r.totalChordPx, 0);
});

test("stopping: small dark dot exhausts and converges before the budget", () => {
  const size = 160;
  const luma = lumaImage(size, [{ x: 100, y: 80, r: 12, a: 1 }], [0, 0], 1);
  const r = weave(luma, { pinCount: 80, maxPasses: 3000, lighteningDelta: 32 / 255 });
  assert.equal(r.stopReason, "converged");
  assert.ok(r.passesUsed >= 4, `needed a few threads (got ${r.passesUsed})`);
  assert.ok(r.passesUsed < 3000, `stopped before budget (got ${r.passesUsed})`);
  assert.ok(r.state.remainingDarkness < 0.05 * r.initialDarkness, "dot essentially exhausted");
});

test("stopping: budget reported at exactly maxPasses (1 / 1000 / 8000)", () => {
  const luma = lumaImage(240, [{ x: 130, y: 110, r: 70, a: 0.9 }], [0.02, 0.02], 11);

  const one = weave(luma, { pinCount: 200, maxPasses: 1 });
  assert.equal(one.passesUsed, 1);
  assert.equal(one.stopReason, "budget");

  // Pass-count knob boundaries on the rich 600 px portrait (with the 4/255
  // delta knob boundary so the image cannot converge inside the budget).
  const rich = spikePortraitLuma();
  const low = weave(rich, { maxPasses: 1000, lighteningDelta: 4 / 255 }); // knob minimum
  assert.equal(low.passesUsed, 1000);
  assert.equal(low.stopReason, "budget");

  const high = weave(rich, { maxPasses: 8000, lighteningDelta: 4 / 255 }); // knob maximum
  assert.equal(high.passesUsed, 8000);
  assert.equal(high.stopReason, "budget");
  assert.ok(high.totalChordPx > low.totalChordPx);
});

// ------------------------------------------------------ 7. determinism

test("determinism: repeated runs + independent table builds are identical", () => {
  const luma = lumaImage(240, [{ x: 140, y: 100, r: 65, a: 0.9 }], [0.015, 0.01], 42);
  const cfg = { pinCount: 200, maxPasses: 600 };

  const a = weave(luma, cfg); // builds its own tables
  const b = weave(luma, cfg, buildTables(240, 200)); // independent build, reused
  const c = weave(luma, cfg); // third full run

  assert.deepEqual([...a.seq], [...b.seq]);
  assert.deepEqual([...b.seq], [...c.seq]);
  const h = hashSequence(a.seq);
  assert.equal(h, hashSequence(b.seq));
  assert.equal(h, hashSequence(c.seq));
  assert.match(h, /^[0-9a-f]+$/);
  assert.equal(a.totalChordPx, b.totalChordPx);
  assert.equal(a.totalThreadEuclidPx, c.totalThreadEuclidPx);
  assert.deepEqual([...a.state.darkness], [...c.state.darkness]);
});

test("determinism: chunked execution bit-identical to single-shot (T4 contract)", () => {
  const size = 240;
  const luma = lumaImage(size, [{ x: 140, y: 100, r: 65, a: 0.9 }], [0.015, 0.01], 42);
  const cfg = resolveConfig({ pinCount: 200, maxPasses: 600 });
  const tables = buildTables(size, cfg.pinCount);

  const single = weave(luma, cfg, tables);

  const state = createWeaveState(luma, cfg);
  const out = new Int16Array(cfg.maxPasses * 2);
  const chunks = [1, 7, 64, 128, 200, 200];
  let done = 0;
  for (const c of chunks) {
    const res = weavePasses(state, tables, done + c, out);
    done += res.written;
    assert.equal(res.passIndex, done);
  }
  const last = weavePasses(state, tables, cfg.maxPasses, out); // the remainder
  done += last.written;
  assert.equal(done, 600);
  assert.equal(last.stopReason, "budget");

  const again = weavePasses(state, tables, cfg.maxPasses, out); // resumed after stop: no-op
  assert.equal(again.written, 0);

  assert.deepEqual([...out], [...single.seq], "chunked == single-shot");
  assert.equal(hashSequence(out), hashSequence(single.seq));
  assert.equal(state.totalChordPx, single.totalChordPx);
  assert.deepEqual([...state.darkness], [...single.state.darkness]);

  assert.throws(() => weavePasses(state, buildTables(64, 24), 10, new Int16Array(64)), TypeError);
  assert.throws(() => weavePasses(state, tables, 600, new Int16Array(4)), RangeError);
});

// ---------------------------------------------------- 8. boundary params

test("boundary params: pin knobs 200 and 500 run correctly with auto skip", () => {
  const luma = lumaImage(600, [{ x: 320, y: 260, r: 160, a: 0.85 }], [0.02, 0.01], 5);

  const min = weave(luma, { pinCount: 200, maxPasses: 400 });
  assert.equal(min.config.neighborSkip, 7); // auto at 200 pins
  for (const rec of min.records) {
    assert.ok(cyclicPinDistance(rec.fromPin, rec.toPin, 200) > 7);
  }
  assert.equal(min.stopReason, "budget");

  const max = weave(luma, { pinCount: 500, maxPasses: 200 });
  assert.equal(max.config.neighborSkip, 17); // auto at 500 pins
  for (const rec of max.records) {
    assert.ok(cyclicPinDistance(rec.fromPin, rec.toPin, 500) > 17);
  }
  assert.equal(max.stopReason, "budget");
  assert.ok(max.totalChordPx > 0);

  // Deterministic against the SAME tables (the T4 reuse path).
  const tables = max.tables;
  const max2 = weave(luma, { pinCount: 500, maxPasses: 200 }, tables);
  assert.deepEqual([...max.seq], [...max2.seq]);
});

// ------------------------------------------------------ 9. convergence

test("convergence: thread density concentrates over the dark blob", () => {
  const size = 300;
  const blob = { x: 190, y: 150, r: 60, a: 0.95 };
  const luma = lumaImage(size, [blob], [0.012, 0.006], 42);
  const r = weave(luma, { pinCount: 200, maxPasses: 1500 });
  // Dense weave over the blob (this synthetic drains near, but never past,
  // the 1500-pass budget; either stop reason is acceptable here).
  assert.ok(r.passesUsed >= 1000, `dense weave (got ${r.passesUsed})`);
  assert.ok(r.stopReason === "budget" || r.stopReason === "converged");

  const initial = new Float32Array(size * size);
  for (let i = 0; i < initial.length; i++) initial[i] = Math.fround(1 - luma[i]);
  const final = r.state.darkness;

  let inN = 0;
  let outN = 0;
  let inRed = 0;
  let outRed = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - blob.x;
      const dy = y - blob.y;
      const inside = dx * dx + dy * dy < blob.r * blob.r;
      const red = initial[y * size + x] - final[y * size + x];
      if (inside) {
        inN++;
        inRed += red;
      } else {
        outN++;
        outRed += red;
      }
    }
  }
  const inMean = inRed / inN;
  const outMean = outRed / outN;
  assert.ok(inMean > 8 * outMean, `inside reduction ${inMean.toFixed(4)} >> outside ${outMean.toFixed(4)}`);
  // The falloff-weighted mean initial darkness inside the blob is ~0.32;
  // a majority of it must be woven away (0.15 is well past half).
  assert.ok(inMean > 0.15, `substantial inside reduction (got ${inMean.toFixed(4)})`);
  assert.ok(outMean < 0.014, `paper barely darkened (got ${outMean.toFixed(4)})`);
});

// --------------------------------------------------------- 10. perf smoke

test("perf smoke: defaults 600 px / 300 pins / 4000 passes (RQ1 harness style)", () => {
  const luma = spikePortraitLuma();

  const t0 = performance.now();
  const tables = buildTables(600, 300);
  const t1 = performance.now();
  const r = weave(luma, undefined, tables);
  const t2 = performance.now();

  const buildMs = t1 - t0;
  const loopMs = t2 - t1;
  const totalMs = buildMs + loopMs;
  const mb = (tables.pixels.byteLength + tables.offsets.byteLength) / 1048576;

  assert.equal(r.passesUsed, 4000);
  assert.equal(r.stopReason, "budget");
  assert.ok(totalMs < 5000, `full weave in ${totalMs.toFixed(0)} ms (< 5000 ms guard; RQ1 expectation 0.5–1.5 s)`);

  console.log(`      [perf] table build ${buildMs.toFixed(1)} ms | greedy loop ${loopMs.toFixed(1)} ms ` +
    `(${((loopMs / 4000) * 1000).toFixed(1)} us/pass) | total ${totalMs.toFixed(1)} ms` +
    ` | tables ${mb.toFixed(1)} MB (${tables.totalPx.toLocaleString()} px)` +
    ` | seq hash ${hashSequence(r.seq)}`);
});

// ---------------------------------------------------------------- runner

let failed = 0;
let index = 0;
for (const [name, fn] of tests) {
  index++;
  try {
    await fn();
    console.log(`PASS  ${index}/${tests.length}  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${index}/${tests.length}  ${name}`);
    console.error(`      ${err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n      ") : err}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
if (failed > 0) process.exit(1);
