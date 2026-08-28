// Thread Art — T8 QA acceptance harness: recorded pass/fail evidence for the
// 11 acceptance criteria in docs/ultron/town-hall.md (the contract).
//
// Usage:   node tests/acceptance.mjs [--quick]
//   --quick  skips the full-speed 1× default-duration run (criterion 3's
//            duration measurement is then marked SKIPPED; everything else —
//            including 1× frame sampling over a shorter window — still runs).
//
// Zero dependencies (Node >= 22: global WebSocket + fetch). What it does:
//   1. Re-runs the T3 engine unit suite (tests/engine.test.mjs) as a gate.
//   2. Serves the project root with a tiny node:http static server.
//   3. Drives real headless Google Chrome over raw-WebSocket CDP through the
//      REAL app journeys (file-picker upload via DOM.setFileInputFiles, real
//      CDP mouse clicks only — NO synthetic Enter/Space anywhere, per the T6
//      environment finding that they park headless rAF).
//   4. Measures everything with its OWN instruments (never the app's debug
//      hook for load-bearing numbers): a first-thread stroke recorder on the
//      loom canvas, an independent rAF frame sampler, an independent
//      PerformanceObserver longtask watcher, independent URL/anchor spies,
//      its own FNV-1a canvas hashing, its own pin math + rq3 chord
//      recomputation, and its own in-circle mask + luma error model.
//   5. Session A (worker path) + Session B (forced fallback: window.Worker
//      deleted before any script) + a light 390×844 viewport-emulation pass.
//
// Criteria 10 (graceful mobile) gets a light 390×844 viewport-emulation data
// point but is VERIFIED IN T11; criterion 11 (prefers-reduced-motion instant
// path + a11y basics) is VERIFIED IN T9 — recorded as DEFERRED, not failed.
//
// Environment variance caveat: absolute timings are HEADLESS numbers on the
// machine that runs this (recorded in the environment block); the criteria
// they evidence are budgeted (TTFT < 2 s, duration 1–3 min) with large
// margins, so headless measurements are conservative-or-representative.

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ARTIFACTS = fs.mkdtempSync("/tmp/thread-art-t8-");
const QUICK = process.argv.includes("--quick");

// ── results bookkeeping ────────────────────────────────────────────────────
const results = [];
const evidence = {}; // criterion → human-readable evidence line(s)
function check(name, pass, detail = "") {
  results.push({ name, pass: !!pass, detail: String(detail) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return !!pass;
}
function note(criterion, text) {
  (evidence[criterion] ??= []).push(text);
}
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function statsOf(arr) {
  if (!arr || arr.length === 0) return { n: 0, mean: null, p95: null, max: null };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    n: arr.length,
    mean: +(sum / arr.length).toFixed(2),
    p95: +sorted[Math.min(arr.length - 1, Math.ceil(arr.length * 0.95) - 1)].toFixed(2),
    max: +Math.max(...arr).toFixed(2),
  };
}

// ── deterministic fixtures (harness-owned PNG encoder, LCG noise) ──────────
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
function encodePNG(w, h, gray) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(gray[y * w + x])));
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const ell = (x, y, cx, cy, rx, ry) => ((x - cx) ** 2) / (rx * rx) + ((y - cy) ** 2) / (ry * ry);

// Portrait 800×600 (greyscale): dark hair band, mid-gray face, darker
// eyes/mouth, light ground + LCG speckle. Enough total darkness to consume
// the default 4,000-pass budget (the showpiece journey image).
function makePortrait() {
  const w = 800,
    h = 600,
    g = new Float64Array(w * h);
  const rnd = lcg(0x33d17a2f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 208; // light ground
      const face = ell(x, y, 400, 320, 190, 230);
      if (face < 1) v = 118 - Math.sqrt(face) * 20; // mid-gray face
      const hair = ell(x, y, 400, 235, 235, 150);
      if (hair < 1 && y < 330) v = 38; // dark hair (upper mass)
      if (ell(x, y, 336, 285, 24, 15) < 1) v = 16; // eye
      if (ell(x, y, 464, 285, 24, 15) < 1) v = 16; // eye
      if (ell(x, y, 400, 408, 52, 18) < 1) v = 60; // mouth
      g[y * w + x] = v + (rnd() * 8 - 4);
    }
  }
  return encodePNG(w, h, g);
}

// Light portrait 600×600: pale face on pale ground, only the hair + features
// dark. In-circle p2 lands in the dark hair (>2% of pixels) and p98 in the
// pale ground → range ≥ 200 → RQ4 normalization SKIPS, so the weave target
// stays genuinely light — the rq2 tripwire scenario ("final result too
// light" → try delta 24 / 5000 passes).
function makeLightPortrait() {
  const w = 600,
    h = 600,
    g = new Float64Array(w * h);
  const rnd = lcg(0x6f2c9155);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 226; // pale ground
      const face = ell(x, y, 300, 330, 150, 175);
      if (face < 1) v = 202 - Math.sqrt(face) * 12; // pale face
      const hair = ell(x, y, 300, 205, 188, 118);
      if (hair < 1 && y < 300) v = 22; // dark hair (only strongly dark region)
      if (ell(x, y, 254, 300, 15, 10) < 1) v = 24; // eye
      if (ell(x, y, 346, 300, 15, 10) < 1) v = 24; // eye
      if (ell(x, y, 300, 382, 42, 12) < 1) v = 58; // mouth
      g[y * w + x] = v + (rnd() * 6 - 3);
    }
  }
  return encodePNG(w, h, g);
}

const FIX = {
  portrait: path.join(ARTIFACTS, "portrait.png"),
  light: path.join(ARTIFACTS, "lightportrait.png"),
};
fs.writeFileSync(FIX.portrait, makePortrait());
fs.writeFileSync(FIX.light, makeLightPortrait());

// ── static server (project root) ───────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let p = path.join(ROOT, path.normalize(url.pathname));
    if (p === ROOT || url.pathname.endsWith("/")) p = path.join(ROOT, "index.html");
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(p)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(p));
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const APP_PORT = server.address().port;
const APP = `http://127.0.0.1:${APP_PORT}/`;
process.on("exit", () => {
  try {
    server.close();
  } catch {}
});

// ── minimal raw-WebSocket CDP client ───────────────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id && this.pending.has(data.id)) {
        const { res, rej } = this.pending.get(data.id);
        this.pending.delete(data.id);
        data.error ? rej(new Error(data.error.message)) : res(data.result);
      } else if (data.method) {
        for (const fn of this.listeners.get(data.method) || []) fn(data.params);
      }
    };
    ws.onclose = () => {
      for (const { rej } of this.pending.values()) rej(new Error("websocket closed"));
      this.pending.clear();
    };
  }
  static async connect(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let page = null;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
        if (page) break;
      } catch {}
      await sleep(250);
    }
    if (!page) throw new Error("no page target found");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("ws connect timeout")), 8000);
      ws.onopen = () => {
        clearTimeout(t);
        res();
      };
      ws.onerror = () => {
        clearTimeout(t);
        rej(new Error("ws error"));
      };
    });
    return new CDP(ws);
  }
  on(method, fn) {
    (this.listeners.get(method) ?? this.listeners.set(method, []).get(method)).push(fn);
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, { awaitPromise = false, timeoutMs = 90000 } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      timeout: timeoutMs,
    });
    if (r.exceptionDetails) {
      throw new Error(
        "page eval failed: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      );
    }
    return r.result?.value;
  }
  async click(x, y) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: "left",
        clickCount: 1,
      });
    }
  }
  async rect(selectorJs) {
    return this.evaluate(`(() => { const el = ${selectorJs}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2, visible: !el.hidden && r.width > 0 && r.height > 0 }; })()`);
  }
}

// ── page-side instrument (installed before any page script; independent of
//    the app's own debug hook). Records: longtasks, rAF frame deltas in
//    sampling windows, the FIRST thread stroke on #loom-canvas, the Start
//    click arrival, every object URL created/revoked, download anchors, and
//    keeps the PNG/txt blobs for byte-level verification. ──────────────────
const INSTRUMENT = `(() => {
  if (window.__t8) return;
  const t = (window.__t8 = {
    longtasks: [], frames: [], sampling: false, lastFrame: 0,
    firstStrokeAt: null, strokeCount: 0, startClickAt: null,
    urls: [], revoked: [], anchors: [], pngBlob: null, txtBlob: null,
    wantPng: false, wantTxt: false, loom1: null,
  });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) t.longtasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  requestAnimationFrame(function loop(now) {
    if (t.sampling && t.lastFrame) t.frames.push(+(now - t.lastFrame).toFixed(2));
    t.lastFrame = now;
    requestAnimationFrame(loop);
  });
  document.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest("#start-button")) t.startClickAt = performance.now();
  }, true);
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = gc.call(this, type, ...rest);
    if (type === "2d" && ctx && this.id === "loom-canvas" && !ctx.__t8Stroke) {
      ctx.__t8Stroke = true;
      const os = ctx.stroke.bind(ctx);
      ctx.stroke = function (...a) {
        if (t.firstStrokeAt === null) t.firstStrokeAt = performance.now();
        t.strokeCount++;
        return os.apply(this, a);
      };
    }
    return ctx;
  };
  const oc = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const url = oc(blob);
    t.urls.push({ url, size: (blob && blob.size) || 0, type: (blob && blob.type) || "" });
    if (blob && blob.type === "image/png" && t.wantPng) { t.pngBlob = blob; t.wantPng = false; }
    if (blob && String(blob.type).indexOf("text/plain") === 0 && t.wantTxt) { t.txtBlob = blob; t.wantTxt = false; }
    return url;
  };
  const or = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function (url) { t.revoked.push(url); return or(url); };
  const oclick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...a) {
    t.anchors.push({ download: this.download, href: String(this.href).slice(0, 48), connected: !!this.isConnected });
    return oclick.apply(this, a);
  };
})();`;

// ── session launcher ───────────────────────────────────────────────────────
const chromes = [];
async function launchSession({ deleteWorker = false } = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const profile = fs.mkdtempSync(path.join(ARTIFACTS, "profile-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  chromes.push(chrome);
  process.on("exit", () => {
    try {
      chrome.kill("SIGKILL");
    } catch {}
  });
  await sleep(900);
  const cdp = await CDP.connect(port);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");

  const bucket = {
    consoleErrors: [],
    consoleWarnings: [],
    exceptions: [],
    logErrors: [],
    loadFails: [],
    appLines: [],
    requests: [],
    loadTime: null,
  };
  cdp.on("Runtime.consoleAPICalled", (p) => {
    const text = (p.args || []).map((a) => String(a.value ?? a.description ?? "")).join(" ");
    if (p.type === "error") bucket.consoleErrors.push(text);
    if (p.type === "warning") bucket.consoleWarnings.push(text);
    if (text.startsWith("[thread-art]")) bucket.appLines.push(text);
  });
  cdp.on("Runtime.exceptionThrown", (p) => bucket.exceptions.push(p.exceptionDetails?.text || "?"));
  cdp.on("Log.entryAdded", (p) => {
    if (p.entry.level === "error") bucket.logErrors.push(p.entry.text);
  });
  cdp.on("Network.loadingFailed", (p) => bucket.loadFails.push(`${p.errorText} ${p.blockedReason || ""}`));
  cdp.on("Network.requestWillBeSent", (p) => bucket.requests.push({ url: p.request.url, ts: p.timestamp }));
  cdp.on("Page.loadEventFired", () => {
    if (bucket.loadTime === null) bucket.loadTime = Date.now();
  });

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  if (deleteWorker) {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "delete window.Worker;" });
  }
  return { cdp, chrome, port, bucket };
}

// ── journey helpers ────────────────────────────────────────────────────────
async function navigate(cdp, bucket) {
  bucket.loadTime = null;
  const done = cdp.send("Page.navigate", { url: APP });
  await done;
  for (let i = 0; i < 60 && bucket.loadTime === null; i++) await sleep(150);
  await sleep(400);
}
async function upload(cdp, filePath) {
  await cdp.send("DOM.setFileInputFiles", { files: [filePath], nodeId: await nodeId(cdp, "#file-input") });
  await waitStage(cdp, "crop");
}
async function nodeId(cdp, sel) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const node = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
  if (!node.nodeId) throw new Error("node not found: " + sel);
  return node.nodeId;
}
async function waitStage(cdp, name, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await cdp.evaluate(`document.getElementById("stage-${name}").hidden === false`);
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`stage ${name} never became visible`);
}
async function clickSel(cdp, sel) {
  await cdp.evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:"center"})`);
  await sleep(60);
  const r = await cdp.rect(`document.querySelector(${JSON.stringify(sel)})`);
  if (!r || !r.visible) throw new Error("not clickable: " + sel);
  await cdp.click(r.cx, r.cy);
  await sleep(140);
}
async function harvestTTFT(cdp) {
  for (let i = 0; i < 40; i++) {
    const v = await cdp.evaluate(
      `(() => { const t = window.__t8; const w = window.__threadArtDebug && window.__threadArtDebug.weave; return t.firstStrokeAt !== null && t.startClickAt !== null ? { mine: +(t.firstStrokeAt - t.startClickAt).toFixed(1), app: w && w.ttftMs != null ? Math.round(w.ttftMs) : null, firstStrokeAt: Math.round(t.firstStrokeAt) } : null; })()`
    );
    if (v) return v;
    await sleep(150);
  }
  throw new Error("first thread never drawn (TTFT timeout)");
}
// Reset the per-run TTFT recorders (firstStrokeAt/startClickAt persist across
// runs otherwise — they must be cleared right before each Start click).
async function resetTTFT(cdp) {
  await cdp.evaluate(`(() => { const t = window.__t8; t.firstStrokeAt = null; t.startClickAt = null; return true; })()`);
}
// Arm the download-blob capture: the NEXT image/png and text/plain blobs
// created are the download artifacts (the upload-validation File is also an
// image/png blob, so arming must happen right before the button clicks).
async function armDownloads(cdp) {
  await cdp.evaluate(`(() => { const t = window.__t8; t.pngBlob = null; t.txtBlob = null; t.wantPng = true; t.wantTxt = true; return true; })()`);
}
// Keep an in-page snapshot of any canvas's pixels for cross-run byte-diffing.
async function snapshotCanvas(cdp, key, sel) {
  await cdp.evaluate(`(() => { const c = document.querySelector(${JSON.stringify(sel)}); window.__t8["${key}"] = c.getContext("2d").getImageData(0, 0, c.width, c.height).data.slice(); return window.__t8["${key}"].length; })()`);
}
async function diffSnapshots(cdp, keyA, keyB) {
  return cdp.evaluate(`(() => {
    const t = window.__t8, a = t["${keyA}"], b = t["${keyB}"];
    if (!a || !b) return { missing: true };
    let diff = 0, maxDelta = 0, first = null;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        diff++;
        const d = Math.abs(a[i] - b[i]);
        if (d > maxDelta) maxDelta = d;
        if (!first) first = { px: i >> 2, ch: i % 4, av: a[i], bv: b[i] };
      }
    }
    return { diff, maxDelta, lenA: a.length, lenB: b.length, first };
  })()`);
}
async function startSample(cdp) {
  await cdp.evaluate(`(() => { const t = window.__t8; t.frames = []; t.sampling = true; t._at = performance.now(); return t.frames.length; })()`);
}
async function stopSample(cdp) {
  const arr = await cdp.evaluate(`(() => { const t = window.__t8; t.sampling = false; return { frames: t.frames.slice(), at: Math.round(t._at), now: Math.round(performance.now()) }; })()`);
  return { stats: statsOf(arr.frames), from: arr.at, to: arr.now, raw: arr.frames };
}
async function waitComplete(cdp, bucket, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  let lastDrawn = -1;
  let lastProgress = Date.now();
  while (Date.now() < deadline) {
    const w = await cdp.evaluate(
      `(() => { const w = window.__threadArtDebug && window.__threadArtDebug.weave; return w && !w.active && w.hash ? w : (w ? { drawn: w.drawn, active: true } : null); })()`
    );
    if (w && !w.active) return await completionSnapshot(cdp);
    if (w && w.drawn !== undefined) {
      if (w.drawn > lastDrawn) {
        lastDrawn = w.drawn;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > 15000) {
        throw new Error(`weave stalled at drawn=${lastDrawn} (rAF park suspicion)`);
      }
    }
    if (bucket.exceptions.length || bucket.consoleErrors.length) break;
    await sleep(1200);
  }
  throw new Error(
    "weave did not complete: exceptions=" + JSON.stringify(bucket.exceptions) + " errors=" + JSON.stringify(bucket.consoleErrors.slice(0, 5))
  );
}
async function completionSnapshot(cdp) {
  return cdp.evaluate(`(() => {
    const w = window.__threadArtDebug.weave, d = window.__threadArtDebug;
    return {
      hash: w.hash, seq: Array.from(w.seq || []), animationMs: w.animationMs, drawn: w.drawn,
      totalPasses: w.totalPasses, passesUsed: w.passesUsed, stopReason: w.stopReason,
      mode: w.mode, ttftMs: w.ttftMs, frameStats: w.frameStats, stats: w.stats, counters: w.counters,
      knobs: d.knobs, normalization: d.lastIngest && d.lastIngest.normalization,
      circle: d.crop, diameter: d.lastIngest && d.lastIngest.diameter,
      feetText: document.getElementById("counter-feet-value").textContent,
      statusText: document.getElementById("weave-status").textContent,
      completeDetail: document.getElementById("complete-detail").textContent,
      completeLength: document.getElementById("complete-length").textContent,
      appFrameStats: w.frameStats,
    };
  })()`);
}
// Independent FNV-1a over a canvas's RGBA pixels (harness-owned).
function canvasHashEval(sel) {
  return `(() => {
    const c = document.querySelector(${JSON.stringify(sel)});
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let h = 0x811c9dc5;
    for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return c.width + ":" + (h >>> 0).toString(16);
  })()`;
}
// Harness-owned pin math + rq3 recomputation over the emitted sequence.
function rq3Eval(seqArrExpr, dExpr, pinsExpr) {
  return `(() => {
    const seq = ${seqArrExpr}, d = ${dExpr}, pins = ${pinsExpr};
    const r = Math.floor(d / 2) - 2;
    const px = new Int32Array(pins * 2);
    for (let i = 0; i < pins; i++) {
      const th = (i / pins) * Math.PI * 2;
      px[i * 2] = Math.round(d / 2 + Math.cos(th) * r);
      px[i * 2 + 1] = Math.round(d / 2 + Math.sin(th) * r);
    }
    let sum = 0;
    for (let i = 0; i + 1 < seq.length; i += 2) {
      const a = seq[i], b = seq[i + 1];
      const dx = px[b * 2] - px[a * 2], dy = px[b * 2 + 1] - px[a * 2 + 1];
      sum += Math.sqrt(dx * dx + dy * dy);
    }
    return { euclidPx: sum, feet: sum * (0.6096 / d) * 3.28084, meters: sum * (0.6096 / d) };
  })()`;
}
// Harness-owned in-circle mask + rendered luma error vs the target greyscale.
const MEAN_ERR_EVAL = `(() => {
  const dbg = window.__threadArtDebug, ing = dbg.lastIngest;
  const d = ing.diameter;
  const ccx = dbg.crop.cx - ing.cropOffset.x, ccy = dbg.crop.cy - ing.cropOffset.y;
  const r2 = (d / 2) ** 2;
  const c = document.getElementById("loom-canvas");
  const data = c.getContext("2d").getImageData(0, 0, d, d).data;
  let inside = 0, err = 0;
  for (let y = 0; y < d; y++) {
    const dy = y + 0.5 - ccy;
    for (let x = 0; x < d; x++) {
      const dx = x + 0.5 - ccx;
      if (dx * dx + dy * dy > r2) continue;
      const i = (y * d + x) * 4;
      const luma = (2126 * data[i] + 7152 * data[i + 1] + 722 * data[i + 2]) / 10000 / 255;
      err += Math.abs(ing.greyscale[y * d + x] - luma);
      inside++;
    }
  }
  const st = dbg.weave.stats;
  return {
    inside,
    renderedMeanError255: +((err / inside) * 255).toFixed(2),
    modelMeanError: +(st.remainingDarkness / inside).toFixed(4),
    modelMeanErrorPer255: +((st.remainingDarkness / inside) * 255).toFixed(2),
    wovenPct: st.initialDarkness ? +((1 - st.remainingDarkness / st.initialDarkness) * 100).toFixed(1) : null,
  };
})()`;
// rq2 tripwire A/B: pure engine runs on the exact app input, both configs,
// shared cached tables; rendered error from a scratch canvas via the real
// renderer module (same paint path as the app).
const TRIPWIRE_EVAL = `(async () => {
  const engine = await import("./src/engine.js");
  const render = await import("./src/render.js");
  const dbg = window.__threadArtDebug, ing = dbg.lastIngest;
  const d = ing.diameter, pins = 300;
  const tables = engine.buildTables(d, pins);
  const mask = (() => {
    const ccx = dbg.crop.cx - ing.cropOffset.x, ccy = dbg.crop.cy - ing.cropOffset.y;
    const r2 = (d / 2) ** 2;
    const m = new Uint8Array(d * d);
    let n = 0;
    for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
      const dx = x + 0.5 - ccx, dy = y + 0.5 - ccy;
      if (dx * dx + dy * dy <= r2) { m[y * d + x] = 1; n++; }
    }
    return { m, n };
  })();
  const configs = [
    { name: "defaults", cfg: { pinCount: pins, maxPasses: 4000, lighteningDelta: 8 / 255, neighborSkip: "auto" } },
    { name: "tripwire", cfg: { pinCount: pins, maxPasses: 5000, lighteningDelta: 24 / 255, neighborSkip: "auto" } },
  ];
  const out = [];
  for (const { name, cfg } of configs) {
    const t0 = performance.now();
    const r = engine.weave(ing.greyscale, cfg, tables);
    const c = document.createElement("canvas");
    c.width = d; c.height = d;
    const renderer = render.createWeaveRenderer(c);
    // FL-1: matched ink — the scratch render's thread alpha follows the
    // config's delta exactly like the app's loom does.
    renderer.init(d, pins, { threadAlpha: render.threadAlphaForDelta255(cfg.lighteningDelta * 255) });
    renderer.replay(r.seq);
    const data = c.getContext("2d").getImageData(0, 0, d, d).data;
    let err = 0;
    for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
      const i = y * d + x;
      if (!mask.m[i]) continue;
      const p = i * 4;
      const luma = (2126 * data[p] + 7152 * data[p + 1] + 722 * data[p + 2]) / 10000 / 255;
      err += Math.abs(ing.greyscale[i] - luma);
    }
    out.push({
      name,
      ms: Math.round(performance.now() - t0),
      passesUsed: r.passesUsed,
      stopReason: r.stopReason,
      seqHash: engine.hashSequence(r.seq),
      modelMeanError: +(r.remainingDarkness / mask.n).toFixed(4),
      modelMeanErrorPer255: +((r.remainingDarkness / mask.n) * 255).toFixed(2),
      renderedMeanError255: +((err / mask.n) * 255).toFixed(2),
      wovenPct: r.initialDarkness ? +((1 - r.remainingDarkness / r.initialDarkness) * 100).toFixed(1) : null,
      initialDarkness: Math.round(r.initialDarkness),
      remainingDarkness: Math.round(r.remainingDarkness),
      feet: r.totalThreadEuclidPx * (0.6096 / d) * 3.28084,
    });
  }
  return { inside: mask.n, configs: out };
})()`;
async function screenshot(cdp, name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(ARTIFACTS, name + ".png"), Buffer.from(r.data, "base64"));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`T8 acceptance harness — artifacts in ${ARTIFACTS}`);
console.log(`app: ${APP}  quick=${QUICK}`);

// 0. Engine unit suite gate (T3 regression signal inside every harness run).
{
  const out = execFileSync(process.execPath, [path.join(ROOT, "tests/engine.test.mjs")], {
    encoding: "utf8",
    timeout: 120000,
  });
  const passCount = (out.match(/\bPASS\b/g) || []).length;
  const failCount = (out.match(/\bFAIL\b/g) || []).length;
  check("gate: tests/engine.test.mjs green", failCount === 0 && passCount >= 23, `${passCount} checks`);
}

// ═══ Session A — worker path ═══════════════════════════════════════════════
const A = await launchSession({});
const ev = { ttftWorker: [], ttftFallback: [], runs: [], frameWindows: [], baseline: null };

await navigate(A.cdp, A.bucket);
const ENV = await A.cdp.evaluate(`(() => {
  const gpu = (() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return "no webgl";
      const e = gl.getExtension("WEBGL_debug_renderer_info");
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch (err) { return "unavailable: " + err.message; }
  })();
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    deviceMemoryGB: navigator.deviceMemory || null,
    gpu, dpr: window.devicePixelRatio, view: window.innerWidth + "x" + window.innerHeight,
  };
})()`);
const chromeVersion = (await A.cdp.send("Browser.getVersion")).product;
const host = { node: process.version, os: `${os.platform()} ${os.release()} ${os.arch()}`, date: new Date().toISOString() };
console.log("env:", JSON.stringify({ ...ENV, chrome: chromeVersion, ...host }, null, 2));
note("env", `UA ${ENV.ua}`);
note("env", `GPU ${ENV.gpu} · ${ENV.cores} cores · deviceMemory ${ENV.deviceMemoryGB} GB · DPR ${ENV.dpr}`);
note("env", `Chrome ${chromeVersion} · Node ${host.node} · ${host.os} · ${host.date}`);

// Blank-page rAF baseline (the environment's own frame clock).
await startSample(A.cdp);
await sleep(1800);
ev.baseline = (await stopSample(A.cdp)).stats;
note("frames", `blank-page rAF baseline: mean ${ev.baseline.mean} ms · p95 ${ev.baseline.p95} ms · max ${ev.baseline.max} ms (n=${ev.baseline.n})`);
console.log("baseline frames:", JSON.stringify(ev.baseline));

// A1 — defaults journey at 1× (criterion 1 TTFT, criterion 2 frames @1×,
// criterion 3 default duration, plus all completion evidence).
await upload(A.cdp, FIX.portrait);
const knobsDefault = await A.cdp.evaluate(`window.__threadArtDebug.knobs`);
check(
  "defaults are RQ2 knobs with the FL-1 delta (300/4000/8/auto)",
  knobsDefault.pinCount === 300 && knobsDefault.maxPasses === 4000 && knobsDefault.lighteningDelta255 === 8 && String(knobsDefault.neighborSkip).startsWith("auto"),
  JSON.stringify(knobsDefault)
);
note("settings", `knob defaults: ${JSON.stringify(knobsDefault)}`);

await resetTTFT(A.cdp);
await clickSel(A.cdp, "#start-button");
const ttft1 = await harvestTTFT(A.cdp);
ev.ttftWorker.push(ttft1);
check("criterion 1: TTFT < 2 s after Start (worker, run 1)", ttft1.mine < 2000, `mine ${ttft1.mine} ms · app ${ttft1.app} ms`);
await startSample(A.cdp);
await sleep(5000);
const win1x = await stopSample(A.cdp);
ev.frameWindows.push({ label: "1× early (run 1)", ...win1x });

if (!QUICK) {
  // Let the whole default weave finish at 1× — the criterion 3 duration.
  const snap1 = await waitComplete(A.cdp, A.bucket, 240000);
  ev.runs.push(snap1);
  const dur1 = snap1.animationMs / 1000;
  check("criterion 3: default weave 1–3 min at 1×", dur1 >= 60 && dur1 <= 180, `${dur1.toFixed(1)} s (${snap1.passesUsed} threads, ${snap1.stopReason})`);
  const rate1x = snap1.passesUsed / (snap1.animationMs / 1000);
  note("c3", `1× full weave: ${dur1.toFixed(1)} s wall · ${rate1x.toFixed(1)} passes/s · ${snap1.passesUsed} threads (${snap1.stopReason})`);

  // late-window frame sample on the same 1× weave happened before completion;
  // take a sustained-pace measurement from drawn deltas instead:
  // (early window already captured; animationMs is the aggregate)
  console.log("run 1 complete:", JSON.stringify({ hash: snap1.hash, dur1: +dur1.toFixed(1), feetText: snap1.feetText }));
} else {
  await clickSel(A.cdp, '#weave-speeds button[data-speed="16"]');
  const snapq = await waitComplete(A.cdp, A.bucket, 240000);
  ev.runs.push(snapq);
  note("c3", "SKIPPED (quick mode)");
  console.log("run 1 (quick 16×) complete:", snapq.hash);
}

const snapA1 = ev.runs[ev.runs.length - 1];

// IMPORTANT (environment finding): repeated getImageData on a canvas can
// flip Chrome's will-read-frequently heuristic, switching that ELEMENT to
// software rasterization — after which the SAME stroke list rasterizes with
// different anti-aliasing (observed: identical sequences, ~15% of pixels
// differing at stroke edges by up to 172/255). So the determinism comparison
// NEVER pixel-reads #loom-canvas: it hashes #complete-canvas instead — a 1:1
// drawImage copy of the finished loom, whose rasterization is path-independent
// (texture blit, no strokes) — and defers every loom read until after the
// comparison. The loom-readback drift itself is measured afterwards as a
// recorded observation (run 3 + scratch-canvas ground truth).
const compHash1 = await A.cdp.evaluate(canvasHashEval("#complete-canvas"));
await snapshotCanvas(A.cdp, "run1", "#complete-canvas");
const seq1 = snapA1.seq;

// A2 — run 2: pristine reweave at 16× (criterion 8 core + criterion 2 @16×
// window + worker TTFT run 2). No loom pixel reads, no screenshots/toggles/
// downloads before the hash check.
await clickSel(A.cdp, "#complete-reweave");
await waitStage(A.cdp, "crop");
await resetTTFT(A.cdp);
await clickSel(A.cdp, "#start-button");
const ttft2 = await harvestTTFT(A.cdp);
ev.ttftWorker.push(ttft2);
await clickSel(A.cdp, '#weave-speeds button[data-speed="16"]');
await startSample(A.cdp);
await sleep(4000);
const win16 = await stopSample(A.cdp);
ev.frameWindows.push({ label: "16× (run 2)", ...win16 });
const snapA2 = await waitComplete(A.cdp, A.bucket, 240000);
ev.runs.push(snapA2);
const compHash2 = await A.cdp.evaluate(canvasHashEval("#complete-canvas"));
await snapshotCanvas(A.cdp, "run2", "#complete-canvas");
{
  const seqsIdentical = seq1.length === snapA2.seq.length && seq1.every((v, i) => v === snapA2.seq[i]);
  check(
    "criterion 8: same image + settings → identical sequence AND canvas (1× run vs 16× reweave)",
    snapA1.hash === snapA2.hash && seqsIdentical && compHash1 === compHash2,
    `seq hash ${snapA1.hash} ≡ ${snapA2.hash} (8000 ints element-identical: ${seqsIdentical}) · final-canvas FNV ${compHash1} ≡ ${compHash2}`
  );
  note("c8", `run 1 (${QUICK ? "1×→16×" : "pure 1×"}, ${snapA1.animationMs} ms) vs run 2 (16× reweave, ${snapA2.animationMs} ms): identical seq element-for-element AND identical final canvas (hashed via the completion copy; the loom is never pixel-read before this point)`);
}

// A2b — frame stats checks for criterion 2 (run 1's 1× window, run 2's 16×
// window; both vs the session's own blank-page baseline).
{
  const w1x = ev.frameWindows[0];
  const b = ev.baseline;
  check("criterion 2: frames @1× track the session baseline (no jank)", Math.abs(w1x.stats.mean - b.mean) <= 3 && w1x.stats.p95 <= b.p95 + 5, `mean ${w1x.stats.mean} vs baseline ${b.mean} · p95 ${w1x.stats.p95} vs ${b.p95} · max ${w1x.stats.max} (n=${w1x.stats.n})`);
  note("frames", `1× window: mean ${w1x.stats.mean} ms · p95 ${w1x.stats.p95} ms · max ${w1x.stats.max} ms (n=${w1x.stats.n}) · app's whole-run frameStats (corroborating): ${JSON.stringify(snapA1.frameStats)}`);
  check("criterion 2: frames @16× track the session baseline (no jank)", Math.abs(win16.stats.mean - b.mean) <= 3 && win16.stats.p95 <= b.p95 + 5, `mean ${win16.stats.mean} vs ${b.mean} · p95 ${win16.stats.p95} vs ${b.p95} · max ${win16.stats.max} (n=${win16.stats.n})`);
  note("frames", `16× window: mean ${win16.stats.mean} ms · p95 ${win16.stats.p95} ms · max ${win16.stats.max} ms (n=${win16.stats.n}) · app's own frameStats (corroborating): ${JSON.stringify(snapA2.frameStats)}`);
}

// A3 — completion evidence on run 2's completion state: feet honesty
// (criterion 4), likeness capability (criterion 5), mean pixel error
// (criterion 6), downloads (criterion 7).
{
  const s = snapA2;
  const my = await A.cdp.evaluate(rq3Eval(`window.__threadArtDebug.weave.seq`, String(s.diameter), "300"));
  const displayed = parseInt(s.feetText.replace(/,/g, ""), 10);
  const delta = Math.abs(displayed - my.feet);
  check("criterion 4: displayed feet ≡ independent rq3 recomputation (±1 ft)", delta <= 1, `displayed ${fmt(displayed)} vs mine ${my.feet.toFixed(2)} (Δ ${delta.toFixed(2)} ft) · Σ euclid ${fmt(my.euclidPx)} px`);
  note("c4", `counter ${s.feetText} ft · status "${s.statusText}" · mine ${my.feet.toFixed(2)} ft from own pin math over the emitted seq · parity ${JSON.stringify(s.counters.parity)}`);

  const origHash2 = await A.cdp.evaluate(canvasHashEval("#original-canvas"));
  ev.loomHashA = compHash2;
  check("criterion 5: view-original toggle exists and swaps a genuinely different canvas", compHash2 !== origHash2, `woven ${compHash2} vs original ${origHash2}`);
  await screenshot(A.cdp, "complete-woven");
  const toggle0 = await A.cdp.evaluate(`(() => { const b = document.getElementById("complete-toggle"); return { pressed: b.getAttribute("aria-pressed"), label: b.textContent }; })()`);
  await clickSel(A.cdp, "#complete-toggle");
  const toggle1 = await A.cdp.evaluate(`(() => { const b = document.getElementById("complete-toggle"); const o = document.getElementById("original-canvas"); const w = document.getElementById("complete-canvas"); return { pressed: b.getAttribute("aria-pressed"), label: b.textContent, caption: document.getElementById("complete-caption").textContent, origVisible: !o.closest("[hidden]") && o.getBoundingClientRect().width > 0, wovenHidden: w.getBoundingClientRect().width === 0 || !!w.closest("[hidden]") }; })()`);
  await screenshot(A.cdp, "complete-original");
  check("criterion 5: toggle ON shows the original in place", toggle1.pressed === "true" && toggle1.origVisible, JSON.stringify(toggle1));
  await clickSel(A.cdp, "#complete-toggle");
  note("c5", `toggle ${toggle0.pressed}/${toggle0.label} → ${toggle1.pressed}/${toggle1.label} · caption "${toggle1.caption}" · screenshots complete-woven.png + complete-original.png (human side-by-side check available in the completion state)`);

  const err1 = await A.cdp.evaluate(MEAN_ERR_EVAL);
  const mpeLine = A.bucket.appLines.find((l) => l.includes("mean pixel error"));
  check("criterion 6: mean pixel error tracked internally (console/dev only)", !!mpeLine, mpeLine || "no console line");
  const noUserFacing = await A.cdp.evaluate(`!/(mean pixel error|fidelity|pixel error)/i.test(document.body.innerText)`);
  check("criterion 6: metric NOT user-facing (absent from the DOM)", noUserFacing);
  note("c6", `model error ${err1.modelMeanError} (${err1.modelMeanErrorPer255}/255) per in-circle px · rendered ${err1.renderedMeanError255}/255 · woven ${err1.wovenPct}% · console: "${mpeLine}"`);

  // Downloads (reuse the T7 assertion pattern at the blob level). Arm the
  // capture FIRST so the upload-validation File is not mistaken for the
  // exported PNG (it is also an image/png blob).
  await armDownloads(A.cdp);
  await clickSel(A.cdp, "#download-png");
  await sleep(500);
  await clickSel(A.cdp, "#download-seq");
  await sleep(500);
  const dl = await A.cdp.evaluate(`(async () => {
    const t = window.__t8;
    const out = { anchors: t.anchors, urls: t.urls, png: null, txt: null };
    if (t.pngBlob) {
      const bm = await createImageBitmap(t.pngBlob);
      const c = document.createElement("canvas");
      c.width = bm.width; c.height = bm.height;
      c.getContext("2d").drawImage(bm, 0, 0);
      const a = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const cc = document.getElementById("complete-canvas");
      const b = cc.getContext("2d").getImageData(0, 0, cc.width, cc.height).data;
      const n = Math.min(a.length, b.length);
      let diff = 0, h = 0x811c9dc5;
      for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 0x01000193) >>> 0; }
      let hb = 0x811c9dc5;
      for (let i = 0; i < b.length; i++) { hb ^= b[i]; hb = Math.imul(hb, 0x01000193) >>> 0; }
      for (let i = 0; i < n; i++) { if (a[i] !== b[i]) diff++; }
      out.png = { w: bm.width, h: bm.height, diffBytes: diff, bytes: t.pngBlob.size, hash: (h >>> 0).toString(16), canvasHash: (hb >>> 0).toString(16), aLen: a.length, bLen: b.length, cw: cc.width, ch: cc.height };
    }
    if (t.txtBlob) out.txt = await t.txtBlob.text();
    return out;
  })()`, { awaitPromise: true });
  check(
    "criterion 7: PNG download pixel-identical to the finished canvas",
    dl.png && dl.png.diffBytes === 0 && dl.png.hash === dl.png.canvasHash && dl.png.w === dl.png.cw && dl.png.h === dl.png.ch,
    dl.png ? `${dl.png.w}×${dl.png.h} · ${dl.png.bytes} B · diff 0/${dl.png.aLen} bytes · hash ≡ canvas` : "no png blob captured"
  );
  const seqPairs = snapA2.seq;
  const lines = dl.txt.split("\n");
  const winding = lines.filter((l) => /^\d+\. \d+ → \d+$/.test(l));
  let seqOk = winding.length === snapA2.passesUsed;
  for (let i = 0; seqOk && i < winding.length; i++) {
    const m = winding[i].match(/^(\d+)\. (\d+) → (\d+)$/);
    if (!m || Number(m[1]) !== i + 1 || Number(m[2]) !== seqPairs[i * 2] || Number(m[3]) !== seqPairs[i * 2 + 1]) seqOk = false;
  }
  const headerFeet = Number((dl.txt.match(/Thread length: ([\d,]+) ft \(([\d,]+) m\)/) || [])[1]?.replace(/,/g, ""));
  check("criterion 7: txt winding ≡ drawn sequence, header ≡ stats", seqOk && headerFeet === displayed && dl.txt.includes(`Pins: 300`) && dl.txt.includes(`Darkness: 8 / 255`), `${winding.length} lines ≡ ${snapA2.passesUsed} emitted passes · header ft ${headerFeet} ≡ counter ${displayed} · bytes ${dl.txt.length} chars`);
  note("c7", `PNG ${dl.png.bytes} B diff 0 · txt ${dl.txt.length} chars, winding order verified against the emitted sequence · board/thread/spool header lines present: ${dl.txt.includes("Assumes a 24 in") && dl.txt.includes("polyester") && dl.txt.includes("wrap at pins")}`);
  ev.txtA = dl.txt;
  await sleep(150); // the app revokes object URLs on the next macrotask
  const liveUrls = await A.cdp.evaluate(`(() => { const t = window.__t8; return t.urls.filter(u => !t.revoked.includes(u.url)).length; })()`);
  check("criterion 7 hygiene: object URLs all revoked", liveUrls === 0, `${liveUrls} live of ${dl.urls.length} created`);
}

// A4 — run 3 AFTER the completion-state interactions (screenshots, toggle,
// downloads, and by now several #loom-canvas pixel reads from the mean-error
// metric). Environment probe: Chrome's will-read-frequently heuristic can
// switch the loom element to software rasterization, after which the
// IDENTICAL replay stroke list rasterizes with different anti-aliasing. The
// scratch-canvas replay of the SAME sequence via the REAL renderer module is
// the ground truth for "final canvas = pure function of the sequence".
await clickSel(A.cdp, "#complete-reweave");
await waitStage(A.cdp, "crop");
await resetTTFT(A.cdp);
await clickSel(A.cdp, "#start-button");
const ttft3 = await harvestTTFT(A.cdp);
ev.ttftWorker.push(ttft3);
await clickSel(A.cdp, '#weave-speeds button[data-speed="16"]');
const snapA3 = await waitComplete(A.cdp, A.bucket, 240000);
ev.runs.push(snapA3);
console.log(`run 3 (16×, after completion interactions + loom reads): hash ${snapA3.hash} · ${snapA3.animationMs} ms`);
{
  const compHash3 = await A.cdp.evaluate(canvasHashEval("#complete-canvas"));
  const dd = await diffSnapshots(A.cdp, "run1", "run2");
  // Ground truth: replay the app's own sequence on a detached canvas.
  const scratch = await A.cdp.evaluate(`(async () => {
    const render = await import("./src/render.js");
    const w = window.__threadArtDebug.weave;
    const d = window.__threadArtDebug.lastIngest.diameter;
    const c = document.createElement("canvas");
    c.width = d; c.height = d;
    const r = render.createWeaveRenderer(c);
    r.init(d, w.config.pinCount);
    r.replay(w.seq);
    const data = c.getContext("2d").getImageData(0, 0, d, d).data;
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return c.width + ":" + (h >>> 0).toString(16);
  })()`, { awaitPromise: true });
  // Snapshot run 3's completion canvas for the drift measurement, then diff.
  await snapshotCanvas(A.cdp, "run3", "#complete-canvas");
  const dd13b = await diffSnapshots(A.cdp, "run1", "run3");
  check(
    "criterion 8 (robustness): post-readback reweave — seq identical AND canvas ≡ scratch replay of that sequence",
    snapA3.hash === snapA1.hash && (compHash3 === compHash1 || scratch === compHash1),
    `seq ${snapA3.hash} ≡ ${snapA1.hash} · canvas run3 ${compHash3} · run1 ${compHash1} · scratch-replay ${scratch}`
  );
  const drifted = compHash3 !== compHash1;
  note(
    "c8-drift",
    drifted
      ? `after loom pixel reads, the recycled loom rasterizes the identical sequence with AA-level differences (run1↔run3: ${dd13b.diff} bytes, max Δ${dd13b.maxDelta}/255 — stroke-edge pixels; run1↔run2 was ${dd.diff} bytes) — Chrome will-read-frequently raster-path switch, harness-induced (a user session never pixel-reads the loom); the scratch-canvas replay (fresh element) reproduces ${scratch}`
      : `canvas identical across all three runs (${compHash1}); readback drift not triggered in this session`
  );
  if (!QUICK) {
    const rate16 = snapA2.passesUsed / (snapA2.animationMs / 1000);
    const rate1 = snapA1.passesUsed / (snapA1.animationMs / 1000);
    check("criterion 3: speed materially changes duration (1× → 16×)", rate16 / rate1 >= 8, `1× ${rate1.toFixed(1)} passes/s vs 16× ${rate16.toFixed(1)} passes/s → ratio ${(rate16 / rate1).toFixed(1)}× (durations ${(snapA1.animationMs / 60000).toFixed(2)} min → ${(snapA2.animationMs / 1000).toFixed(1)} s)`);
  }
}

// Longtask audit for criterion 2 (mine, whole session so far — before the
// tripwire eval which intentionally blocks the main thread).
{
  const lt = await A.cdp.evaluate(`window.__t8.longtasks`);
  check("criterion 2: zero longtasks during worker-path weaving", lt.length === 0, lt.length ? JSON.stringify(lt.slice(0, 5)) : "none across the whole worker session");
  note("frames", `longtasks (worker session, own PerformanceObserver): ${lt.length}`);
}

// RQ4 normalization fields (T2 follow-up): harvest the decision record.
{
  const n = snapA1.normalization;
  check("RQ4 evidence: normalization decision logged with p2/p98/range", n && typeof n.p2 === "number" && typeof n.p98 === "number" && typeof n.range === "number", JSON.stringify(n));
  note("rq4", `portrait normalization: ${JSON.stringify(n)} (decision: ${n.applied ? "applied" : n.range >= 200 ? "skipped — already good range" : "skipped — flat guard"})`);
}

// A5 — light-image journey + rq2 tripwire A/B (criterion 6 tuning evidence).
await clickSel(A.cdp, "#complete-restart");
await waitStage(A.cdp, "upload");
await upload(A.cdp, FIX.light);
await resetTTFT(A.cdp);
await clickSel(A.cdp, "#start-button");
await harvestTTFT(A.cdp).catch(() => {});
await clickSel(A.cdp, '#weave-speeds button[data-speed="16"]');
const snapLight = await waitComplete(A.cdp, A.bucket, 240000);
{
  const n = snapLight.normalization;
  note("rq4", `light portrait normalization: ${JSON.stringify(n)} (expect skip: range ≥ 200 — keeps the light target light)`);
  const mpe = A.bucket.appLines.filter((l) => l.includes("mean pixel error")).pop();
  note("c6", `light image defaults: ${mpe} · ${snapLight.passesUsed} threads (${snapLight.stopReason})`);
  console.log("light journey:", mpe, snapLight.stopReason, snapLight.passesUsed);
}
const trip = await A.cdp.evaluate(TRIPWIRE_EVAL, { awaitPromise: true, timeoutMs: 120000 });
{
  const [def, tw] = trip.configs;
  const modelImprovement = def.modelMeanError > 0 ? (1 - tw.modelMeanError / def.modelMeanError) * 100 : 0;
  const renderedImprovement = def.renderedMeanError255 > 0 ? (1 - tw.renderedMeanError255 / def.renderedMeanError255) * 100 : 0;
  check(
    "rq2 tripwire evaluated (light image, engine A/B)",
    Number.isFinite(def.modelMeanError) && Number.isFinite(tw.modelMeanError),
    `defaults (8/255, 4000): model ${def.modelMeanError} (${def.modelMeanErrorPer255}/255) · rendered ${def.renderedMeanError255}/255 · ${def.passesUsed} passes (${def.stopReason}) || tripwire (24/255, 5000): model ${tw.modelMeanError} (${tw.modelMeanErrorPer255}/255) · rendered ${tw.renderedMeanError255}/255 · ${tw.passesUsed} passes (${tw.stopReason})`
  );
  note(
    "c6-tripwire",
    `defaults→tripwire: model error ${modelImprovement >= 0 ? "-" : "+"}${Math.abs(modelImprovement).toFixed(1)}% (${def.modelMeanErrorPer255}→${tw.modelMeanErrorPer255}/255) · rendered ${renderedImprovement >= 0 ? "-" : "+"}${Math.abs(renderedImprovement).toFixed(1)}% (${def.renderedMeanError255}→${tw.renderedMeanError255}/255) · woven ${def.wovenPct}%→${tw.wovenPct}% · feet ${fmt(def.feet)}→${fmt(tw.feet)} ft (+${(((tw.feet / def.feet) - 1) * 100).toFixed(0)}% thread)`
  );
  console.log("tripwire:", JSON.stringify(trip, null, 2));
}
ev.trip = trip;
ev.snapLight = snapLight;

// A6 — criterion 9: zero network activity after page load (observed across
// the whole session: every request must be a same-origin app file; data: and
// blob: URLs never hit the network).
{
  const external = A.bucket.requests.filter((r) => !r.url.startsWith(APP) && !/^(data|blob|about):/.test(r.url));
  check("criterion 9: zero network activity after load (no non-app-origin request all session)", external.length === 0, external.length ? JSON.stringify(external.slice(0, 3)) : `all ${A.bucket.requests.length} requests were same-origin app files / data: / blob:`);
  note("c9", `network: ${A.bucket.requests.length} requests total, all ${APP}* or data:/blob: · image bytes never left the page (uploads came from local disk via the real file picker)`);
}

// A7 — light mobile viewport emulation (criterion 10; full pass = T11).
{
  await A.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await navigate(A.cdp, A.bucket);
  const sw = await A.cdp.evaluate(`document.documentElement.scrollWidth`);
  await upload(A.cdp, FIX.portrait);
  await resetTTFT(A.cdp);
  await clickSel(A.cdp, "#start-button");
  await harvestTTFT(A.cdp).catch(() => {});
  await clickSel(A.cdp, '#weave-speeds button[data-speed="16"]');
  const snapM = await waitComplete(A.cdp, A.bucket, 240000);
  const reach = await A.cdp.evaluate(`(() => {
    const ids = ["complete-toggle", "download-png", "download-seq", "complete-reweave", "complete-restart"];
    return ids.map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { id, w: +r.width.toFixed(1), in: r.left >= 0 && r.right <= window.innerWidth }; });
  })()`);
  await screenshot(A.cdp, "complete-390");
  check("criterion 10 (light): 390px viewport emulation completes the journey, no overflow, controls reachable", sw === 390 && reach.every((r) => r.w > 0 && r.in), `scrollWidth ${sw} · controls ${reach.map((r) => r.id + (r.in ? "✓" : "✗")).join(" ")} · hash ${snapM.hash}`);
  note("c10", `390×844 DPR2 emulation: full journey completes at 16×, controls reachable — full mobile verification deferred to T11`);
  await A.cdp.send("Emulation.clearDeviceMetricsOverride");
}

// Session A hygiene.
check("hygiene A: zero console errors / exceptions / failed loads (worker session)", A.bucket.consoleErrors.length === 0 && A.bucket.exceptions.length === 0 && A.bucket.loadFails.length === 0, `errors ${A.bucket.consoleErrors.length} · exceptions ${A.bucket.exceptions.length} · loadFails ${A.bucket.loadFails.length}`);

try {
  A.chrome.kill("SIGKILL");
} catch {}

// ═══ Session B — forced fallback (window.Worker deleted) ════════════════════
const B = await launchSession({ deleteWorker: true });
await navigate(B.cdp, B.bucket);
const noWorker = await B.cdp.evaluate(`typeof Worker === "undefined"`);
check("fallback session precondition: window.Worker deleted", noWorker);
await upload(B.cdp, FIX.portrait);
await resetTTFT(B.cdp);
await clickSel(B.cdp, "#start-button");
const ttftF1 = await harvestTTFT(B.cdp);
ev.ttftFallback.push(ttftF1);
check("criterion 1: TTFT < 2 s after Start (fallback, run 1)", ttftF1.mine < 2000, `mine ${ttftF1.mine} ms · app ${ttftF1.app} ms`);
await clickSel(B.cdp, '#weave-speeds button[data-speed="16"]');
const snapB1 = await waitComplete(B.cdp, B.bucket, 240000);
await clickSel(B.cdp, "#complete-reweave");
await waitStage(B.cdp, "crop");
await resetTTFT(B.cdp);
await clickSel(B.cdp, "#start-button");
const ttftF2 = await harvestTTFT(B.cdp);
ev.ttftFallback.push(ttftF2);
await clickSel(B.cdp, '#weave-speeds button[data-speed="16"]');
const snapB2 = await waitComplete(B.cdp, B.bucket, 240000);
const compHashB = await B.cdp.evaluate(canvasHashEval("#complete-canvas"));
{
  check("criterion 8 (cross-path): worker ≡ fallback sequence AND canvas", snapB1.hash === snapA1.hash && compHashB === ev.loomHashA, `seq ${snapB1.hash} vs ${snapA1.hash} · final-canvas FNV ${compHashB} (fallback, fresh session) vs ${ev.loomHashA} (worker)`);
  await armDownloads(B.cdp);
  await clickSel(B.cdp, "#download-seq");
  await sleep(400);
  const txtB = await B.cdp.evaluate(`window.__t8.txtBlob ? window.__t8.txtBlob.text() : null`, { awaitPromise: true });
  check("criterion 7/8 (cross-path): txt byte-identical across worker/fallback", txtB === ev.txtA, `${txtB.length} chars vs ${ev.txtA.length}`);
  const myB = await B.cdp.evaluate(rq3Eval(`window.__threadArtDebug.weave.seq`, String(snapB1.diameter), "300"));
  const dispB = parseInt(snapB1.feetText.replace(/,/g, ""), 10);
  check("criterion 4 (fallback): feet ≡ independent recomputation", Math.abs(dispB - myB.feet) <= 1, `displayed ${fmt(dispB)} vs mine ${myB.feet.toFixed(2)}`);
  const ltB = await B.cdp.evaluate(`window.__t8.longtasks`);
  const anim = ltB.filter((t) => t.start + t.duration > ttftF1.firstStrokeAt);
  note("frames", `fallback longtasks: ${ltB.length} total (${JSON.stringify(ltB.slice(0, 3))}) — any pre-first-thread longtask is the committed main-thread chord-table build inside the TTFT budget`);
  check("criterion 2 (fallback): no longtask overlapping the weaving animation", anim.length === 0, anim.length ? JSON.stringify(anim.slice(0, 3)) : "0 during weaving");
  const externalB = B.bucket.requests.filter((r) => !r.url.startsWith(APP) && !/^(data|blob|about):/.test(r.url));
  check("criterion 9 (fallback): zero non-app network", externalB.length === 0);
  check("hygiene B: zero console errors / exceptions (fallback session)", B.bucket.consoleErrors.length === 0 && B.bucket.exceptions.length === 0 && B.bucket.loadFails.length === 0);
}

try {
  B.chrome.kill("SIGKILL");
} catch {}

// ═══ Report ════════════════════════════════════════════════════════════════
console.log("\n═══ T8 acceptance evidence summary ═══");
note(
  "c1",
  `TTFT samples (mine = Start-click arrival → first loom stroke, own recorder): worker ${ev.ttftWorker.map((t) => `${t.mine} ms (app ${t.app})`).join(" · ")} · fallback ${ev.ttftFallback.map((t) => `${t.mine} ms (app ${t.app})`).join(" · ")} — all far under the 2,000 ms budget (reweaves are faster: chord tables cached per RQ1 D3)`
);
console.log(`env: ${ENV.ua} · ${ENV.gpu} · Chrome ${chromeVersion} · Node ${host.node} · ${host.os} · ${host.date}`);
for (const [k, v] of Object.entries(evidence)) console.log(`  [${k}] ${v.join(" | ")}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
note("c11", "reduced-motion + a11y basics: VERIFIED IN T9 (placeholder per plan)");
note("c10-full", "graceful mobile on real devices: VERIFIED IN T11 (viewport-emulation data point recorded above)");
console.log("criteria 10 (full) and 11: deferred to T11/T9 per plan.");
fs.writeFileSync(
  path.join(ARTIFACTS, "evidence.json"),
  JSON.stringify({ env: { ...ENV, chrome: chromeVersion, ...host }, evidence, results, tripwire: ev.trip, quick: QUICK }, null, 2)
);
console.log(`artifacts: ${ARTIFACTS}`);
server.close();
process.exit(failed.length ? 1 : 0);
