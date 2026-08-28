// FL-1 likeness lab — reproduce + A/B the likeness defect (disposable spike).
//
// Usage: node lab.mjs [stage ...]   (default: all stages)
//   stages: repro | scoring | sweep | blur | skip | final
//
// Pure Node, zero deps. Imports the REAL src/engine.js (buildTables etc.) so
// chord geometry is exactly the shipped one; the greedy loop is re-implemented
// here with pluggable suspects (score length-exponent, target blur, delta,
// skip) because the shipped engine hard-codes sum scoring.
//
// The renderer is a software Canvas2D stand-in: 1px-wide stroke of the thread
// color blended over the paper with per-pixel AA coverage
//   cov = clamp(1 - dist(pixelCenter, capsuleAxis), 0, 1)
// (box-filter approximation of a unit-width round-capped stroke — the same
// model Chrome rasterizes). calibrate.mjs validates it against the real
// src/render.js under headless Chrome.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { buildTables, defaultRadius } from "../../../../../src/engine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(HERE, "../../likeness-evidence");
fs.mkdirSync(EVIDENCE, { recursive: true });

// ── constants (match src/render.js exactly) ────────────────────────────────
const SIZE = 600;
const PINS = 300;
const PAPER_RGB = [0xf5, 0xf0, 0xe4];
const THREAD_RGB = [0x15, 0x12, 0x0d];
const PAPER_L = (2126 * PAPER_RGB[0] + 7152 * PAPER_RGB[1] + 722 * PAPER_RGB[2]) / 10000 / 255;
const THREAD_L = (2126 * THREAD_RGB[0] + 7152 * THREAD_RGB[1] + 722 * THREAD_RGB[2]) / 10000 / 255;
const INK_RANGE = PAPER_L - THREAD_L; // full one-thread→saturated luma span
const FEET_PER_PX = (0.6096 / SIZE) * 3.28084; // rq3 mapping (24 in board)

// ── deterministic PRNG (same family as engine.test.mjs) ───────────────────
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═════════════════════════════════════════════ test images (deterministic)

function inCircle(x, y) {
  const dx = x + 0.5 - SIZE / 2;
  const dy = y + 0.5 - SIZE / 2;
  return dx * dx + dy * dy <= (SIZE / 2) * (SIZE / 2);
}

function ellipseAlpha(x, y, cx, cy, rx, ry, soft = 10) {
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  const d = Math.sqrt(nx * nx + ny * ny);
  const a = (1 - d) * soft;
  return a <= 0 ? 0 : a >= 1 ? 1 : a;
}

// Portrait-like face: light ground, dark hair mass, mid-tone skin, dark
// eyes/brows/mouth — the structure acceptance criterion 5 is judged on.
function portraitFace({ light = false } = {}) {
  const rnd = mulberry32(7717);
  const bg = light ? 0.95 : 0.86;
  const hair = light ? 0.42 : 0.14;
  const skinTop = light ? 0.86 : 0.8;
  const skinBottom = light ? 0.8 : 0.68;
  const eye = light ? 0.32 : 0.12;
  const brow = light ? 0.5 : 0.3;
  const mouth = light ? 0.55 : 0.34;
  const luma = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!inCircle(x, y)) {
        luma[y * SIZE + x] = 1;
        continue;
      }
      let v = bg + (rnd() - 0.5) * 0.03;
      // hair mass (behind the face)
      v = v * (1 - ellipseAlpha(x, y, 300, 225, 170, 165, 6)) + hair * ellipseAlpha(x, y, 300, 225, 170, 165, 6);
      // face oval with a vertical skin gradient + slight side falloff
      const fa = ellipseAlpha(x, y, 300, 325, 118, 150, 8);
      const skin = skinTop + (skinBottom - skinTop) * Math.min(1, Math.max(0, (y - 175) / 300));
      const side = 1 - 0.06 * ellipseAlpha(x, y, 300, 325, 118, 150, 3) * Math.abs(x - 300) / 118;
      v = v * (1 - fa) + skin * side * fa;
      // hair fringe over the forehead
      const fringe = ellipseAlpha(x, y, 300, 182, 132, 58, 8);
      v = v * (1 - fringe) + hair * fringe;
      // brows
      for (const [bx, by] of [[252, 283], [348, 283]]) {
        const a = ellipseAlpha(x, y, bx, by, 23, 5.5, 6);
        v = v * (1 - a) + brow * a;
      }
      // eyes (dark almond with a tiny light glint)
      for (const [ex, ey] of [[252, 300], [348, 300]]) {
        const a = ellipseAlpha(x, y, ex, ey, 18, 9.5, 5);
        v = v * (1 - a) + eye * a;
        const g = ellipseAlpha(x, y, ex + 5, ey - 3, 3.2, 2.4, 4);
        v = v * (1 - g * 0.75) + (eye + 0.55) * 0.75 * g;
      }
      // nose: subtle side shade + nostrils
      const ns = ellipseAlpha(x, y, 300, 352, 26, 34, 4) * 0.18;
      v = v * (1 - ns) + (v - 0.1) * ns;
      for (const [nx, ny] of [[289, 364], [311, 364]]) {
        const a = ellipseAlpha(x, y, nx, ny, 5, 3.2, 5);
        v = v * (1 - a) + (light ? 0.45 : 0.25) * a;
      }
      // mouth: lips + darker seam
      const ml = ellipseAlpha(x, y, 300, 390, 31, 9, 5);
      v = v * (1 - ml) + mouth * ml;
      const seam = ellipseAlpha(x, y, 300, 390, 26, 3.4, 5);
      v = v * (1 - seam) + (mouth - 0.16) * seam;
      // chin shadow under the jaw
      const cs = ellipseAlpha(x, y, 300, 478, 86, 22, 4) * 0.45;
      v = v * (1 - cs) + (v - 0.22) * cs;
      luma[y * SIZE + x] = Math.max(0, Math.min(1, v));
    }
  }
  return {
    name: light ? "light-portrait" : "portrait",
    luma,
    regions: {
      eyeL: [[252, 300], 11, 7],
      eyeR: [[348, 300], 11, 7],
      cheekL: [[233, 338], 16, 12],
      cheekR: [[367, 338], 16, 12],
      mouth: [[300, 390], 20, 6],
      hair: [[300, 165], 65, 42],
      bgL: [[95, 140], 26, 18],
      bgR: [[505, 460], 26, 18],
    },
  };
}

// Graded pattern: horizontal luma ramp + four darkness discs — tone-transfer
// curve + local-contrast probes independent of face structure.
function gradedPattern() {
  const rnd = mulberry32(991);
  const luma = new Float32Array(SIZE * SIZE);
  const discs = [
    [110, 520, 0.16],
    [236, 520, 0.36],
    [363, 520, 0.56],
    [490, 520, 0.76],
  ];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!inCircle(x, y)) {
        luma[y * SIZE + x] = 1;
        continue;
      }
      let v = 0.1 + 0.82 * (x / (SIZE - 1)) + (rnd() - 0.5) * 0.015;
      for (const [dx, dy, dl] of discs) {
        const a = ellipseAlpha(x, y, dx, dy, 23, 23, 6);
        v = v * (1 - a) + dl * a;
      }
      luma[y * SIZE + x] = Math.max(0, Math.min(1, v));
    }
  }
  return {
    name: "graded",
    luma,
    regions: Object.fromEntries(discs.map(([dx, dy, dl], i) => [`disc${i}`, [[dx, dy], 15, 15]])),
    discs,
  };
}

// ═════════════════════════════════════════════ software renderer + ink model

function drawCapsule(L, ax, ay, bx, by, alpha) {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - 1.5));
  const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx) + 1.5));
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - 1.5));
  const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by) + 1.5));
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    const row = y * SIZE;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - ax;
      const py = y + 0.5 - ay;
      let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = px - t * dx;
      const cy = py - t * dy;
      const ds = Math.sqrt(cx * cx + cy * cy);
      const cov = 1 - ds;
      if (cov <= 0) continue;
      const i = row + x;
      L[i] += alpha * (cov > 1 ? 1 : cov) * (THREAD_L - L[i]);
    }
  }
}

// Render a pass sequence exactly the way the shipped renderer would with a
// given per-stroke alpha (alpha=1 reproduces today's opaque ink).
function renderSeq(tables, seq, alpha) {
  const L = new Float32Array(SIZE * SIZE).fill(PAPER_L);
  const pins = tables.pins;
  for (let k = 0; k + 1 < seq.length; k += 2) {
    const a = seq[k];
    const b = seq[k + 1];
    drawCapsule(L, pins[a * 2], pins[a * 2 + 1], pins[b * 2], pins[b * 2 + 1], alpha);
  }
  return L;
}

// κ = mean luma drop over a chord's Bresenham footprint for ONE opaque
// crossing from paper. matched-alpha for a delta is delta / κ.
function measureKappa(tables) {
  const chords = [];
  for (let i = 0; i < 60; i++) {
    chords.push([i * 5, (i * 5 + 137) % PINS]);
    chords.push([i * 5 + 1, (i * 5 + 61) % PINS]);
  }
  let drops = 0;
  let pixels = 0;
  for (const [a, b] of chords) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const id = (lo * (2 * PINS - lo - 1)) / 2 + (hi - lo - 1);
    const s = tables.offsets[id];
    const e = tables.offsets[id + 1];
    const L = new Float32Array(SIZE * SIZE).fill(PAPER_L);
    const pins = tables.pins;
    drawCapsule(L, pins[a * 2], pins[a * 2 + 1], pins[b * 2], pins[b * 2 + 1], 1);
    for (let k = s; k < e; k++) {
      drops += PAPER_L - L[tables.pixels[k]];
      pixels++;
    }
  }
  return drops / pixels;
}

// ═════════════════════════════════════════════ engine variants (greedy copy)

function gaussianBlur(src, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + r];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(SIZE * SIZE);
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(SIZE - 1, Math.max(0, x + i));
        acc += src[y * SIZE + xx] * kernel[i + r];
      }
      tmp[y * SIZE + x] = acc;
    }
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(SIZE - 1, Math.max(0, y + i));
        acc += tmp[yy * SIZE + x] * kernel[i + r];
      }
      out[y * SIZE + x] = acc;
    }
  }
  return out;
}

// Pluggable greedy: score = Σ darkness / len^scoreP  (scoreP 0 = shipped sum,
// 0.5 = mean×√len, 1 = pure mean). Everything else mirrors src/engine.js.
function weaveVariant(greyscale, tables, o) {
  const {
    maxPasses = 4000,
    delta = 20 / 255,
    skip = 10,
    scoreP = 0,
    blurSigma = 0,
    minImprovement = 0,
    convergenceFails = 3,
    startPin = 0,
  } = o;
  const n = tables.pinCount;
  let darkness = new Float32Array(SIZE * SIZE);
  let initial = 0;
  for (let i = 0; i < darkness.length; i++) {
    const d = Math.fround(1 - greyscale[i]);
    darkness[i] = d;
    initial += d;
  }
  if (blurSigma > 0) {
    darkness = gaussianBlur(darkness, blurSigma);
    initial = 0;
    for (let i = 0; i < darkness.length; i++) initial += darkness[i];
  }
  const { pixels, offsets, pinPx } = tables;
  const w = new Float64Array(tables.nChords);
  for (let k = 0; k < tables.nChords; k++) {
    const len = offsets[k + 1] - offsets[k];
    w[k] = len > 0 ? 1 / Math.pow(len, scoreP) : 0;
  }
  const seq = new Int16Array(maxPasses * 2);
  let cur = startPin;
  let pass = 0;
  let fails = 0;
  let stop = null;
  let euclid = 0;
  let attempts = 0;
  while (pass < maxPasses && stop === null) {
    let bestJ = -1;
    let bestScore = -Infinity;
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
      const score = sum * w[id];
      if (score > bestScore) {
        bestScore = score;
        bestJ = j;
        bestS = s;
        bestE = e;
      }
    }
    attempts++;
    if (bestJ >= 0 && bestScore > minImprovement) {
      for (let k = bestS; k < bestE; k++) {
        const idx = pixels[k];
        const v = darkness[idx] - delta;
        darkness[idx] = v > 0 ? v : 0;
      }
      seq[pass * 2] = cur;
      seq[pass * 2 + 1] = bestJ;
      pass++;
      const ddx = pinPx[bestJ * 2] - pinPx[cur * 2];
      const ddy = pinPx[bestJ * 2 + 1] - pinPx[cur * 2 + 1];
      euclid += Math.sqrt(ddx * ddx + ddy * ddy);
      fails = 0;
      cur = bestJ;
      if (pass >= maxPasses) stop = "budget";
    } else {
      fails++;
      if (fails >= convergenceFails) stop = "converged";
    }
  }
  let remaining = 0;
  for (let i = 0; i < darkness.length; i++) remaining += darkness[i];
  return {
    seq: seq.subarray(0, pass * 2),
    passesUsed: pass,
    stopReason: stop,
    darkness,
    initialDarkness: initial,
    remainingDarkness: remaining,
    euclidPx: euclid,
    feet: euclid * FEET_PER_PX,
  };
}

// Model view: what the engine's own darkness state claims the canvas shows.
function modelImage(run, greyscale) {
  const out = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < out.length; i++) {
    const woven = Math.fround(1 - greyscale[i]) - run.darkness[i];
    out[i] = Math.max(0, Math.min(1, 1 - woven));
  }
  return out;
}

// ═════════════════════════════════════════════ metrics

const MASK = (() => {
  const m = new Uint8Array(SIZE * SIZE);
  let count = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (inCircle(x, y)) {
        m[y * SIZE + x] = 1;
        count++;
      }
    }
  }
  return { m, n: count };
})();

function pearson(a, b) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (!MASK.m[i]) continue;
    sa += a[i]; sb += b[i];
    saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i];
    n++;
  }
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) * (sa / n);
  const vb = sbb / n - (sb / n) * (sb / n);
  return cov / Math.sqrt(va * vb);
}

function mae255(a, b) {
  let err = 0;
  for (let i = 0; i < a.length; i++) {
    if (!MASK.m[i]) continue;
    err += Math.abs(a[i] - b[i]);
  }
  return (err / MASK.n) * 255;
}

// Paper-compensated MAE: rescale the render's [threadL, paperL] span onto
// [threadL, 1] — what an eye does adapting to the warm paper ground.
function compensate(renderL) {
  const out = new Float32Array(renderL.length);
  const k = (1 - THREAD_L) / INK_RANGE;
  for (let i = 0; i < out.length; i++) out[i] = THREAD_L + (renderL[i] - THREAD_L) * k;
  return out;
}

function regionMean(luma, [[cx, cy], rx, ry]) {
  let sum = 0, n = 0;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || !inCircle(x, y)) continue;
      if (ellipseAlpha(x + 0.5, y + 0.5, cx, cy, rx, ry, 1e9) < 1) continue;
      sum += 1 - luma[y * SIZE + x]; // darkness
      n++;
    }
  }
  return n ? sum / n : 0;
}

function chordStats(tables, seq) {
  const { pinPx } = tables;
  const lens = [];
  for (let k = 0; k + 1 < seq.length; k += 2) {
    const a = seq[k], b = seq[k + 1];
    const dx = pinPx[b * 2] - pinPx[a * 2];
    const dy = pinPx[b * 2 + 1] - pinPx[a * 2 + 1];
    lens.push(Math.sqrt(dx * dx + dy * dy));
  }
  lens.sort((x, y) => x - y);
  const mean = lens.reduce((s, v) => s + v, 0) / (lens.length || 1);
  return {
    mean,
    p10: lens[Math.floor(lens.length * 0.1)] ?? null,
    p50: lens[Math.floor(lens.length * 0.5)] ?? null,
    p90: lens[Math.floor(lens.length * 0.9)] ?? null,
  };
}

function randomChordMean(tables) {
  const { pinPx } = tables;
  let sum = 0, n = 0;
  for (let i = 0; i < PINS; i++) {
    for (let j = i + 1; j < PINS; j++) {
      const dx = pinPx[j * 2] - pinPx[i * 2];
      const dy = pinPx[j * 2 + 1] - pinPx[i * 2 + 1];
      sum += Math.sqrt(dx * dx + dy * dy);
      n++;
    }
  }
  return sum / n;
}

function toneCurve(target, render) {
  const bins = 12;
  const acc = Array.from({ length: bins }, () => [0, 0]);
  for (let i = 0; i < target.length; i++) {
    if (!MASK.m[i]) continue;
    const td = 1 - target[i];
    const rd = (PAPER_L - render[i]) / INK_RANGE;
    const b = Math.min(bins - 1, Math.floor(td * bins));
    acc[b][0] += rd;
    acc[b][1]++;
  }
  let st = 0, sr = 0, stt = 0, str = 0, n = 0;
  const curve = [];
  for (let b = 0; b < bins; b++) {
    if (!acc[b][1]) continue;
    const t = (b + 0.5) / bins;
    const r = acc[b][0] / acc[b][1];
    curve.push([+t.toFixed(3), +r.toFixed(3)]);
    st += t; sr += r; stt += t * t; str += t * r; n++;
  }
  const slope = (n * str - st * sr) / (n * stt - st * st);
  const intercept = (sr - slope * st) / n;
  let ssRes = 0, ssTot = 0;
  const mr = sr / n;
  for (const [t, r] of curve) {
    ssRes += (r - (slope * t + intercept)) ** 2;
    ssTot += (r - mr) ** 2;
  }
  return { slope: +slope.toFixed(3), r2: +(1 - ssRes / ssTot).toFixed(3), curve };
}

function evaluate(image, run, renderL, tables, label) {
  const t = image.luma;
  const dark = (L) => {
    const d = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) d[i] = (PAPER_L - L[i]) / INK_RANGE;
    return d;
  };
  const rd = dark(renderL);
  const r = {
    label,
    corr: +pearson(t, renderL).toFixed(4),
    mae255: +mae255(t, renderL).toFixed(1),
    maeComp255: +mae255(t, compensate(renderL)).toFixed(1),
    passes: run.passesUsed,
    stop: run.stopReason,
    feet: Math.round(run.feet),
    wovenPct: +((1 - run.remainingDarkness / run.initialDarkness) * 100).toFixed(1),
  };
  if (image.regions.eyeL) {
    const eyeD = (regionMean(renderL, image.regions.eyeL) + regionMean(renderL, image.regions.eyeR)) / 2;
    const cheekD = (regionMean(renderL, image.regions.cheekL) + regionMean(renderL, image.regions.cheekR)) / 2;
    const mouthD = regionMean(renderL, image.regions.mouth);
    const hairD = regionMean(renderL, image.regions.hair);
    const bgD = (regionMean(renderL, image.regions.bgL) + regionMean(renderL, image.regions.bgR)) / 2;
    const tEye = (regionMean(t, image.regions.eyeL) + regionMean(t, image.regions.eyeR)) / 2;
    const tCheek = (regionMean(t, image.regions.cheekL) + regionMean(t, image.regions.cheekR)) / 2;
    const tMouth = regionMean(t, image.regions.mouth);
    r.eyeMinusCheek = +(eyeD - cheekD).toFixed(3);
    r.eyeContrastRatio = tCheek - tEye > 0 ? +((eyeD - cheekD) / (tEye - tCheek) * -1).toFixed(2) : null; // + = right direction
    r.mouthMinusCheek = +(mouthD - cheekD).toFixed(3);
    r.mouthContrastRatio = +((mouthD - cheekD) / (tMouth - tCheek) * -1).toFixed(2);
    r.hairMinusBg = +(hairD - bgD).toFixed(3);
    const tHair = regionMean(t, image.regions.hair);
    const tBg = (regionMean(t, image.regions.bgL) + regionMean(t, image.regions.bgR)) / 2;
    r.hairContrastRatio = +((hairD - bgD) / (tHair - tBg) * -1).toFixed(2);
  }
  if (image.discs) {
    const vals = image.discs.map(([dx, dy, dl], i) => {
      const dd = regionMean(renderL, [[dx, dy], 14, 14]);
      const ring = ringMean(renderL, dx, dy, 30, 40);
      return { disc: +dd.toFixed(3), ring: +ring.toFixed(3), sep: +(dd - ring).toFixed(3), targetSep: +(dl - ringTarget(t, dx, dy)).toFixed(3) };
    });
    r.discs = vals;
    r.tone = toneCurve(t, renderL);
  }
  const cs = chordStats(tables, run.seq);
  r.chordMean = Math.round(cs.mean);
  r.chordP10 = Math.round(cs.p10 ?? 0);
  r.chordP50 = Math.round(cs.p50 ?? 0);
  r.chordP90 = Math.round(cs.p90 ?? 0);
  return r;
}

function ringTarget(t, cx, cy, r0, r1) {
  let sum = 0, n = 0;
  for (let y = Math.floor(cy - r1); y <= Math.ceil(cy + r1); y++) {
    for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || !inCircle(x, y)) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d < r0 || d > r1) continue;
      sum += 1 - t[y * SIZE + x];
      n++;
    }
  }
  return n ? sum / n : 0;
}
function ringMean(L, cx, cy, r0, r1) {
  let sum = 0, n = 0;
  for (let y = Math.floor(cy - r1); y <= Math.ceil(cy + r1); y++) {
    for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || !inCircle(x, y)) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d < r0 || d > r1) continue;
      sum += (PAPER_L - L[y * SIZE + x]) / INK_RANGE;
      n++;
    }
  }
  return n ? sum / n : 0;
}

// ═════════════════════════════════════════════ PNG output (zero-dep)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodeGrayPNG(w, h, gray) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(gray[y * w + x] * 255)));
      raw[y * (w + 1) + 1 + x] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // 8-bit grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function compositeRow(images, gap = 16) {
  const h = Math.max(...images.map((i) => i.length ? Math.sqrt(i.length) : 0));
  const w = h;
  const totalW = images.length * w + (images.length - 1) * gap;
  const out = new Float32Array(totalW * (h + 2 * gap)).fill(1);
  images.forEach((img, k) => {
    const x0 = k * (w + gap);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        out[(y + gap) * totalW + x0 + x] = img[y * w + x];
      }
    }
  });
  return encodeGrayPNG(totalW, h + 2 * gap, out);
}

// ═════════════════════════════════════════════ experiment driver

const tables = buildTables(SIZE, PINS);
console.log(`lab: tables ${tables.totalPx.toLocaleString()} px · radius ${defaultRadius(SIZE)}`);
const KAPPA = measureKappa(tables);
const RANDOM_CHORD_MEAN = randomChordMean(tables);
console.log(`lab: kappa (mean opaque drop over Bresenham footprint) = ${(KAPPA * 255).toFixed(1)}/255 · random chord mean = ${RANDOM_CHORD_MEAN.toFixed(1)} px`);

const alphaForDelta = (delta255, k = 1) => Math.min(1, (delta255 / 255 / KAPPA) * k);

const IMAGES = { portrait: portraitFace(), graded: gradedPattern(), light: portraitFace({ light: true }) };
const results = { kappa255: +(KAPPA * 255).toFixed(2), randomChordMean: +RANDOM_CHORD_MEAN.toFixed(1), runs: [] };

function runCase(imageKey, label, opts, ink) {
  const image = IMAGES[imageKey];
  const t0 = performance.now();
  const run = weaveVariant(image.luma, tables, opts);
  const t1 = performance.now();
  const alpha = ink === "opaque" ? 1 : alphaForDelta((opts.delta ?? 20 / 255) * 255, ink.k ?? 1);
  const renderL = renderSeq(tables, run.seq, alpha);
  const t2 = performance.now();
  const ev = evaluate(image, run, renderL, tables, label);
  ev.image = imageKey;
  ev.alpha = +alpha.toFixed(4);
  ev.weaveMs = Math.round(t1 - t0);
  ev.renderMs = Math.round(t2 - t1);
  results.runs.push(ev);
  console.log(
    `${label.padEnd(34)} corr ${ev.corr.toFixed(3)} · MAE ${String(ev.mae255).padStart(5)}/255 (comp ${ev.maeComp255}) · ` +
    `eye−cheek ${ev.eyeMinusCheek ?? "—"} · mouth−cheek ${ev.mouthMinusCheek ?? "—"} · hair−bg ${ev.hairMinusBg ?? "—"} · ` +
    `chord μ${ev.chordMean} (p10 ${ev.chordP10}/p90 ${ev.chordP90}) · ${ev.passes}p ${ev.stop} · ${ev.feet} ft`
  );
  return { run, renderL, ev };
}

const stages = process.argv.slice(2);
const has = (s) => stages.length === 0 || stages.includes(s);

const BASE = { delta: 20 / 255, maxPasses: 4000, skip: 10, scoreP: 0, blurSigma: 0 };
let artifacts = {};

if (has("repro")) {
  console.log("\n══ stage repro — the shipped defect, objectively ══");
  for (const key of ["portrait", "graded", "light"]) {
    const shipped = runCase(key, `${key} / shipped (opaque, sum)`, BASE, "opaque");
    // model view: same run, engine's own darkness state as the image
    const image = IMAGES[key];
    const model = modelImage(shipped.run, image.luma);
    const m = {
      label: `${key} / model view`,
      corr: +pearson(image.luma, model).toFixed(4),
      mae255: +mae255(image.luma, model).toFixed(1),
    };
    console.log(`${m.label.padEnd(34)} corr ${m.corr.toFixed(3)} · MAE ${m.mae255}/255  ← what the MODEL thinks it drew`);
    results.runs.push({ image: key, ...m });
    artifacts[key] = { shipped };
  }
  console.log(`chord baseline: random-pair mean ${RANDOM_CHORD_MEAN.toFixed(1)} px (4R/π)`);
}

if (has("scoring")) {
  console.log("\n══ stage scoring — suspects one at a time ══");
  // (a) alone on opaque ink: cannot fix saturation
  runCase("portrait", "portrait / mean-only (opaque)", { ...BASE, scoreP: 1 }, "opaque");
  // (b) alone: matched ink, shipped scoring
  runCase("portrait", "portrait / matched-ink only (sum)", BASE, "matched");
  // (a) on top of matched ink
  for (const p of [0.5, 1]) {
    runCase("portrait", `portrait / matched + scoreP ${p}`, { ...BASE, scoreP: p }, "matched");
  }
  runCase("graded", "graded / matched-ink only (sum)", BASE, "matched");
  for (const p of [0.5, 1]) {
    runCase("graded", `graded / matched + scoreP ${p}`, { ...BASE, scoreP: p }, "matched");
  }
}

if (has("sweep")) {
  console.log("\n══ stage sweep — delta × passes (matched ink, best scoring) ══");
  const p = 1;
  for (const d255 of [6, 8, 12, 16, 20, 24]) {
    for (const passes of [4000, 8000]) {
      runCase("portrait", `portrait / d${d255} p${passes} scoreP ${p}`, { ...BASE, delta: d255 / 255, maxPasses: passes, scoreP: p }, "matched");
    }
  }
}

if (has("blur")) {
  console.log("\n══ stage blur — scoring-target blur (best-of prior stages) ══");
  for (const sigma of [1, 2]) {
    runCase("portrait", `portrait / matched d16 blur σ${sigma}`, { ...BASE, delta: 16 / 255, scoreP: 1, blurSigma: sigma }, "matched");
    runCase("graded", `graded / matched d16 blur σ${sigma}`, { ...BASE, delta: 16 / 255, scoreP: 1, blurSigma: sigma }, "matched");
  }
}

if (has("skip")) {
  console.log("\n══ stage skip — neighborSkip sensitivity ══");
  for (const skip of [10, 5]) {
    runCase("portrait", `portrait / matched d16 skip ${skip}`, { ...BASE, delta: 16 / 255, scoreP: 1, skip }, "matched");
  }
}

if (has("tone")) {
  console.log("\n══ stage tone — delta × passes × ink-k on the graded pattern ══");
  for (const d255 of [6, 8, 12, 20]) {
    for (const passes of [4000, 8000]) {
      const { ev } = runCase("graded", `graded / d${d255} p${passes} k1`, { ...BASE, delta: d255 / 255, maxPasses: passes, scoreP: 1 }, "matched");
      console.log(`   t → r: ${ev.tone.curve.map(([t, r]) => t + "→" + r).join(" ")} · woven ${ev.wovenPct}%`);
    }
  }
}

if (has("kfactor")) {
  console.log("\n══ stage kfactor — ink calibration multiplier (alpha = k·delta/κ) ══");
  for (const k of [1, 1.25, 1.5, 1.75, 2]) {
    for (const d255 of [8, 12]) {
      for (const passes of [4000, 6000]) {
        const ev = runCase("portrait", `portrait / d${d255} p${passes} k${k}`, { ...BASE, delta: d255 / 255, maxPasses: passes, scoreP: 1 }, { k });
        if (ev.tone) console.log(`   tone: ${ev.tone.curve.map(([t, r]) => t + "→" + r).join(" ")}`);
      }
    }
  }
}

if (has("matrix")) {
  console.log("\n══ stage matrix — fine-ink configurations (scoreP × delta × passes × blur) ══");
  for (const cfg of [
    { delta: 6 / 255, maxPasses: 8000, scoreP: 1, blurSigma: 0 },
    { delta: 6 / 255, maxPasses: 8000, scoreP: 1, blurSigma: 1 },
    { delta: 4 / 255, maxPasses: 8000, scoreP: 1, blurSigma: 0 },
    { delta: 4 / 255, maxPasses: 8000, scoreP: 1, blurSigma: 1 },
    { delta: 8 / 255, maxPasses: 8000, scoreP: 1, blurSigma: 1 },
    { delta: 6 / 255, maxPasses: 8000, scoreP: 0.5, blurSigma: 1 },
    { delta: 6 / 255, maxPasses: 4000, scoreP: 1, blurSigma: 1 },
  ]) {
    const tag = `d${Math.round(cfg.delta * 255)} p${cfg.maxPasses} P${cfg.scoreP} σ${cfg.blurSigma}`;
    for (const key of ["portrait", "graded", "light"]) {
      const { ev } = runCase(key, `${key} / ${tag}`, { ...BASE, ...cfg }, "matched");
      if (ev.tone) console.log(`   tone: ${ev.tone.curve.map(([t, r]) => t + "→" + r).join(" ")} · woven ${ev.wovenPct}%`);
    }
  }
}

// Exact model↔render alignment ("exponential engine"): the canvas blend is
// multiplicative (whiteness q *= (1 − alpha·cov) per crossing), so the model
// tracks q per pixel with the population-average m = alpha·E[cov] =
// deltaLuma / INK_RANGE and scores the SIGNED error D0 − (1 − q): pixels the
// render has not yet brought to target keep attracting threads; over-woven
// pixels repel them. q snaps to 0 below Q_FLOOR so convergence still exists.
const Q_FLOOR = 0.5 / 255 / INK_RANGE;
function weaveExact(greyscale, tables, o) {
  const {
    maxPasses = 4000,
    delta = 20 / 255,
    skip = 10,
    scoreP = 1,
    blurSigma = 0,
    minImprovement = 0,
    convergenceFails = 3,
    startPin = 0,
  } = o;
  const n = tables.pinCount;
  const m = delta / INK_RANGE;
  let target = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < target.length; i++) target[i] = Math.fround(1 - greyscale[i]);
  if (blurSigma > 0) target = gaussianBlur(target, blurSigma);
  const q = new Float32Array(SIZE * SIZE).fill(1); // render whiteness (model)
  let initial = 0;
  for (let i = 0; i < target.length; i++) initial += target[i];
  const { pixels, offsets, pinPx } = tables;
  const w = new Float64Array(tables.nChords);
  for (let k = 0; k < tables.nChords; k++) {
    const len = offsets[k + 1] - offsets[k];
    w[k] = len > 0 ? 1 / Math.pow(len, scoreP) : 0;
  }
  const seq = new Int16Array(maxPasses * 2);
  let cur = startPin;
  let pass = 0;
  let fails = 0;
  let stop = null;
  let euclid = 0;
  const decay = 1 - m;
  while (pass < maxPasses && stop === null) {
    let bestJ = -1;
    let bestScore = -Infinity;
    let bestS = 0;
    let bestE = 0;
    for (let j = 0; j < n; j++) {
      if (j === cur) continue;
      let d = j - cur;
      if (d < 0) d = -d;
      const mm = n - d;
      if (mm < d) d = mm;
      if (d <= skip) continue;
      const lo = cur < j ? cur : j;
      const hi = cur < j ? j : cur;
      const id = (lo * (n + n - lo - 1)) / 2 + (hi - lo - 1);
      const s = offsets[id];
      const e = offsets[id + 1];
      let sum = 0;
      for (let k = s; k < e; k++) {
        const idx = pixels[k];
        sum += target[idx] + q[idx] - 1; // signed remaining wanted darkness
      }
      const score = sum * w[id];
      if (score > bestScore) {
        bestScore = score;
        bestJ = j;
        bestS = s;
        bestE = e;
      }
    }
    if (bestJ >= 0 && bestScore > minImprovement) {
      for (let k = bestS; k < bestE; k++) {
        const idx = pixels[k];
        const qn = q[idx] * decay;
        q[idx] = qn < Q_FLOOR ? 0 : qn;
      }
      seq[pass * 2] = cur;
      seq[pass * 2 + 1] = bestJ;
      pass++;
      const ddx = pinPx[bestJ * 2] - pinPx[cur * 2];
      const ddy = pinPx[bestJ * 2 + 1] - pinPx[cur * 2 + 1];
      euclid += Math.sqrt(ddx * ddx + ddy * ddy);
      fails = 0;
      cur = bestJ;
      if (pass >= maxPasses) stop = "budget";
    } else {
      fails++;
      if (fails >= convergenceFails) stop = "converged";
    }
  }
  let remaining = 0;
  for (let i = 0; i < q.length; i++) {
    const signed = target[i] - (1 - q[i]);
    remaining += signed > 0 ? signed : 0;
  }
  return {
    seq: seq.subarray(0, pass * 2),
    passesUsed: pass,
    stopReason: stop,
    q,
    initialDarkness: initial,
    remainingDarkness: remaining,
    euclidPx: euclid,
    feet: euclid * FEET_PER_PX,
  };
}

if (has("exact")) {
  console.log("\n══ stage exact — exponential signed-residual engine (optimized = displayed) ══");
  for (const cfg of [
    { delta: 8 / 255, maxPasses: 4000, scoreP: 1, blurSigma: 0 },
    { delta: 8 / 255, maxPasses: 8000, scoreP: 1, blurSigma: 0 },
    { delta: 12 / 255, maxPasses: 4000, scoreP: 1, blurSigma: 0 },
    { delta: 12 / 255, maxPasses: 8000, scoreP: 1, blurSigma: 0 },
    { delta: 16 / 255, maxPasses: 4000, scoreP: 1, blurSigma: 0 },
    { delta: 16 / 255, maxPasses: 8000, scoreP: 1, blurSigma: 0 },
    { delta: 20 / 255, maxPasses: 4000, scoreP: 1, blurSigma: 0 },
    { delta: 20 / 255, maxPasses: 8000, scoreP: 1, blurSigma: 0 },
    { delta: 16 / 255, maxPasses: 8000, scoreP: 1, blurSigma: 1 },
  ]) {
    const tag = `exact d${Math.round(cfg.delta * 255)} p${cfg.maxPasses} P${cfg.scoreP} σ${cfg.blurSigma}`;
    for (const key of ["portrait", "graded", "light"]) {
      const image = IMAGES[key];
      const t0 = performance.now();
      const run = weaveExact(image.luma, tables, cfg);
      const t1 = performance.now();
      const renderL = renderSeq(tables, run.seq, alphaForDelta(cfg.delta * 255));
      const ev = evaluate(image, run, renderL, tables, `${key} / ${tag}`);
      ev.image = key;
      ev.weaveMs = Math.round(t1 - t0);
      results.runs.push(ev);
      console.log(
        `${ev.label.padEnd(38)} corr ${ev.corr.toFixed(3)} · MAE ${String(ev.mae255).padStart(5)}/255 (comp ${ev.maeComp255}) · ` +
        `eye−cheek ${ev.eyeMinusCheek ?? "—"} · hair−bg ${ev.hairMinusBg ?? "—"} · chord μ${ev.chordMean} · ` +
        `${ev.passes}p ${ev.stop} · ${ev.feet} ft · woven ${ev.wovenPct}%`
      );
      if (ev.tone) console.log(`   tone: ${ev.tone.curve.map(([t, r]) => t + "→" + r).join(" ")}`);
    }
  }
}

if (has("look")) {
  console.log("\n══ stage look — PNG panels for visual comparison ══");
  const image = IMAGES.portrait;
  const cases = [
    ["shipped", weaveVariant(image.luma, tables, BASE), 1],
    ["d6p8000", weaveVariant(image.luma, tables, { ...BASE, delta: 6 / 255, maxPasses: 8000, scoreP: 1 }), alphaForDelta(6)],
    ["d8p8000", weaveVariant(image.luma, tables, { ...BASE, delta: 8 / 255, maxPasses: 8000, scoreP: 1 }), alphaForDelta(8)],
    ["d8p4000", weaveVariant(image.luma, tables, { ...BASE, delta: 8 / 255, maxPasses: 4000, scoreP: 1 }), alphaForDelta(8)],
    ["exact-d8p8000", weaveExact(image.luma, tables, { ...BASE, delta: 8 / 255, maxPasses: 8000, scoreP: 1 }), alphaForDelta(8)],
  ];
  fs.writeFileSync(path.join(EVIDENCE, "look-target.png"), encodeGrayPNG(SIZE, SIZE, image.luma));
  for (const [name, run, alpha] of cases) {
    const renderL = renderSeq(tables, run.seq, alpha);
    fs.writeFileSync(path.join(EVIDENCE, `look-${name}.png`), encodeGrayPNG(SIZE, SIZE, renderL));
    console.log(`wrote look-${name}.png`);
  }
}

// Exponential-subtraction, clamped at 0 ("expclamp"): per crossing the
// remaining wanted darkness drops by m·(whiteness) — mirroring the canvas's
// multiplicative blend — so a pixel only stops attracting threads when the
// RENDER (not a linear model count) has reached its target darkness. No
// signed penalty, so the run stays budget-bound like the shipped engine.
const R_FLOOR = 0.5 / 255;
function weaveExpClamp(greyscale, tables, o) {
  const {
    maxPasses = 4000,
    delta = 20 / 255,
    skip = 10,
    scoreP = 1,
    blurSigma = 0,
    minImprovement = 0,
    convergenceFails = 3,
    startPin = 0,
  } = o;
  const n = tables.pinCount;
  const m = delta / INK_RANGE;
  let darkness = new Float32Array(SIZE * SIZE);
  let initial = 0;
  for (let i = 0; i < darkness.length; i++) {
    const d = Math.fround(1 - greyscale[i]);
    darkness[i] = d;
    initial += d;
  }
  if (blurSigma > 0) {
    darkness = gaussianBlur(darkness, blurSigma);
    initial = 0;
    for (let i = 0; i < darkness.length; i++) initial += darkness[i];
  }
  const c = new Float32Array(SIZE * SIZE); // 1 − D0 (per-pixel constant)
  for (let i = 0; i < c.length; i++) c[i] = 1 - darkness[i];
  const { pixels, offsets, pinPx } = tables;
  const w = new Float64Array(tables.nChords);
  for (let k = 0; k < tables.nChords; k++) {
    const len = offsets[k + 1] - offsets[k];
    w[k] = len > 0 ? 1 / Math.pow(len, scoreP) : 0;
  }
  const seq = new Int16Array(maxPasses * 2);
  let cur = startPin;
  let pass = 0;
  let fails = 0;
  let stop = null;
  let euclid = 0;
  while (pass < maxPasses && stop === null) {
    let bestJ = -1;
    let bestScore = -Infinity;
    let bestS = 0;
    let bestE = 0;
    for (let j = 0; j < n; j++) {
      if (j === cur) continue;
      let d = j - cur;
      if (d < 0) d = -d;
      const mm = n - d;
      if (mm < d) d = mm;
      if (d <= skip) continue;
      const lo = cur < j ? cur : j;
      const hi = cur < j ? j : cur;
      const id = (lo * (n + n - lo - 1)) / 2 + (hi - lo - 1);
      const s = offsets[id];
      const e = offsets[id + 1];
      let sum = 0;
      for (let k = s; k < e; k++) sum += darkness[pixels[k]];
      const score = sum * w[id];
      if (score > bestScore) {
        bestScore = score;
        bestJ = j;
        bestS = s;
        bestE = e;
      }
    }
    if (bestJ >= 0 && bestScore > minImprovement) {
      for (let k = bestS; k < bestE; k++) {
        const idx = pixels[k];
        const r = darkness[idx];
        const v = r - m * (c[idx] + r);
        darkness[idx] = v < R_FLOOR ? 0 : v;
      }
      seq[pass * 2] = cur;
      seq[pass * 2 + 1] = bestJ;
      pass++;
      const ddx = pinPx[bestJ * 2] - pinPx[cur * 2];
      const ddy = pinPx[bestJ * 2 + 1] - pinPx[cur * 2 + 1];
      euclid += Math.sqrt(ddx * ddx + ddy * ddy);
      fails = 0;
      cur = bestJ;
      if (pass >= maxPasses) stop = "budget";
    } else {
      fails++;
      if (fails >= convergenceFails) stop = "converged";
    }
  }
  let remaining = 0;
  for (let i = 0; i < darkness.length; i++) remaining += darkness[i];
  return {
    seq: seq.subarray(0, pass * 2),
    passesUsed: pass,
    stopReason: stop,
    darkness,
    initialDarkness: initial,
    remainingDarkness: remaining,
    euclidPx: euclid,
    feet: euclid * FEET_PER_PX,
  };
}

if (has("expclamp")) {
  console.log("\n══ stage expclamp — exponential subtraction clamped at 0 ══");
  for (const cfg of [
    { delta: 8 / 255, maxPasses: 4000, scoreP: 1 },
    { delta: 8 / 255, maxPasses: 8000, scoreP: 1 },
    { delta: 12 / 255, maxPasses: 4000, scoreP: 1 },
    { delta: 12 / 255, maxPasses: 8000, scoreP: 1 },
    { delta: 16 / 255, maxPasses: 4000, scoreP: 1 },
    { delta: 16 / 255, maxPasses: 8000, scoreP: 1 },
    { delta: 20 / 255, maxPasses: 4000, scoreP: 1 },
    { delta: 20 / 255, maxPasses: 8000, scoreP: 1 },
    { delta: 16 / 255, maxPasses: 8000, scoreP: 0.5 },
    { delta: 16 / 255, maxPasses: 4000, scoreP: 1, skip: 15 },
    { delta: 16 / 255, maxPasses: 8000, scoreP: 1, skip: 5 },
  ]) {
    const tag = `expclamp d${Math.round(cfg.delta * 255)} p${cfg.maxPasses} P${cfg.scoreP} skip${cfg.skip ?? 10}`;
    for (const key of ["portrait", "graded", "light"]) {
      const image = IMAGES[key];
      const t0 = performance.now();
      const run = weaveExpClamp(image.luma, tables, cfg);
      const t1 = performance.now();
      const renderL = renderSeq(tables, run.seq, alphaForDelta(cfg.delta * 255));
      const ev = evaluate(image, run, renderL, tables, `${key} / ${tag}`);
      ev.image = key;
      ev.weaveMs = Math.round(t1 - t0);
      results.runs.push(ev);
      console.log(
        `${ev.label.padEnd(40)} corr ${ev.corr.toFixed(3)} · MAE ${String(ev.mae255).padStart(5)}/255 (comp ${ev.maeComp255}) · ` +
        `eye−cheek ${ev.eyeMinusCheek ?? "—"} · hair−bg ${ev.hairMinusBg ?? "—"} · chord μ${ev.chordMean} (p10 ${ev.chordP10}) · ` +
        `${ev.passes}p ${ev.stop} · ${ev.feet} ft · woven ${ev.wovenPct}% · ${ev.weaveMs}ms`
      );
      if (ev.tone) console.log(`   tone: ${ev.tone.curve.map(([t, r]) => t + "→" + r).join(" ")}`);
    }
  }
}

if (has("lift")) {
  console.log("\n══ stage lift — analytic log-lift of the darkness target ══");
  // The canvas blend is exponential: reaching darkness D needs
  // N(D) = ln(1−D)/ln(1−ã) crossings (ã = delta/INK_RANGE), while the linear
  // model sends D/δ. Preprocess D → D' = δ·N(D) so the model sends exactly
  // the traffic the render needs (D' ≈ D for light, steep for dark).
  const lift = (D, delta) => {
    if (D <= 0) return 0;
    const a = delta / INK_RANGE;
    const l = (delta * Math.log(1 - Math.min(D, 0.999))) / Math.log(1 - a);
    return Math.max(0, Math.min(3, l));
  };
  for (const cfg of [
    { delta: 8 / 255, maxPasses: 8000, scoreP: 1 },
    { delta: 12 / 255, maxPasses: 8000, scoreP: 1 },
    { delta: 16 / 255, maxPasses: 8000, scoreP: 1 },
    { delta: 12 / 255, maxPasses: 4000, scoreP: 1 },
    { delta: 12 / 255, maxPasses: 8000, scoreP: 0.5 },
  ]) {
    const tag = `lift d${Math.round(cfg.delta * 255)} p${cfg.maxPasses} P${cfg.scoreP}`;
    for (const key of ["portrait", "graded", "light"]) {
      const image = IMAGES[key];
      const lifted = new Float32Array(image.luma.length);
      for (let i = 0; i < lifted.length; i++) lifted[i] = 1 - lift(Math.fround(1 - image.luma[i]), cfg.delta);
      const t0 = performance.now();
      const run = weaveVariant(lifted, tables, cfg);
      const t1 = performance.now();
      const renderL = renderSeq(tables, run.seq, alphaForDelta(cfg.delta * 255));
      const ev = evaluate(image, run, renderL, tables, `${key} / ${tag}`);
      ev.image = key;
      ev.weaveMs = Math.round(t1 - t0);
      results.runs.push(ev);
      console.log(
        `${ev.label.padEnd(34)} corr ${ev.corr.toFixed(3)} · MAE ${String(ev.mae255).padStart(5)}/255 (comp ${ev.maeComp255}) · ` +
        `eye−cheek ${ev.eyeMinusCheek ?? "—"} · hair−bg ${ev.hairMinusBg ?? "—"} · chord μ${ev.chordMean} · ` +
        `${ev.passes}p ${ev.stop} · ${ev.feet} ft`
      );
      if (ev.tone) console.log(`   tone: ${ev.tone.curve.map(([t, r]) => t + "→" + r).join(" ")}`);
    }
  }
}

if (has("tune")) {
  console.log("\n══ stage tune — final cross: partial lift × ink factor ══");
  const lift1 = (D, delta) => {
    if (D <= 0) return 0;
    const a = delta / INK_RANGE;
    return Math.max(0, Math.min(3, (delta * Math.log(1 - Math.min(D, 0.999))) / Math.log(1 - a)));
  };
  for (const lambda of [0]) {
    for (const k of [0.7]) {
      for (const passes of [4000]) {
      const cfg = { delta: 8 / 255, maxPasses: passes, scoreP: 1 };
      cfg.delta = (process.env.TUNE_DELTA ? Number(process.env.TUNE_DELTA) : 8) / 255;
      const tag = `d${Math.round(cfg.delta * 255)} p${passes} λ${lambda} k${k}`;
      for (const key of ["portrait", "graded", "light"]) {
        const image = IMAGES[key];
        const target = new Float32Array(image.luma.length);
        for (let i = 0; i < target.length; i++) {
          const D = Math.fround(1 - image.luma[i]);
          target[i] = 1 - (D + lambda * (lift1(D, cfg.delta) - D));
        }
        const run = weaveVariant(target, tables, cfg);
        const renderL = renderSeq(tables, run.seq, alphaForDelta(cfg.delta * 255) * k);
        const ev = evaluate(image, run, renderL, tables, `${key} / ${tag}`);
        ev.image = key;
        results.runs.push(ev);
        console.log(
          `${ev.label.padEnd(30)} corr ${ev.corr.toFixed(3)} · MAE ${String(ev.mae255).padStart(5)}/255 (comp ${ev.maeComp255}) · ` +
          `eye−cheek ${ev.eyeMinusCheek ?? "—"} · hair−bg ${ev.hairMinusBg ?? "—"} · ${ev.passes}p · ${ev.feet} ft`
        );
        if (ev.tone) console.log(`   tone: ${ev.tone.curve.map(([t, r]) => t + "→" + r).join(" ")}`);
      }
      }
    }
  }
}

if (has("final")) {
  console.log("\n══ stage final — winner rerun + PNG evidence ══");
  // FL-1 winner: mean scoring + matched ink (regional k = 0.7), delta 8/255,
  // passes 4000, skip auto(10), no blur.
  const WINNER = { delta: 8 / 255, maxPasses: 4000, skip: 10, scoreP: 1, blurSigma: 0 };
  const WIN_K = 0.7;
  for (const key of ["portrait", "graded", "light"]) {
    const win = runCase(key, `${key} / WINNER`, WINNER, { k: WIN_K });
    artifacts[key] = { ...(artifacts[key] || {}), win };
    const image = IMAGES[key];
    const targetPNG = encodeGrayPNG(SIZE, SIZE, image.luma);
    fs.writeFileSync(path.join(EVIDENCE, `${key}-target.png`), targetPNG);
    const comp = compositeRow([image.luma, artifacts[key].shipped.renderL, win.renderL]);
    fs.writeFileSync(path.join(EVIDENCE, `${key}-before-after.png`), comp);
    console.log(`wrote ${key}-before-after.png (target | shipped | winner)`);
  }
}

fs.writeFileSync(path.join(EVIDENCE, "lab-results.json"), JSON.stringify(results, null, 2));
console.log(`\nwrote ${path.join(EVIDENCE, "lab-results.json")}`);
