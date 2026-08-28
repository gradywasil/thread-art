// FL-1 calibration — measure the REAL renderer's per-crossing ink under
// headless Chrome via CDP, and validate the lab's software renderer against
// it. Produces the shipped alpha constant (kappa + regional factor).
//
// Usage: node calibrate.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" };
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let p = path.join(ROOT, path.normalize(url.pathname));
    console.log("[srv]", req.url);
    if (p === ROOT || url.pathname.endsWith("/")) p = path.join(ROOT, "index.html");
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(fs.readFileSync(p));
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id && this.pending.has(data.id)) {
        const { res, rej } = this.pending.get(data.id);
        this.pending.delete(data.id);
        data.error ? rej(new Error(data.error.message)) : res(data.result);
      }
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
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error("ws error")); };
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, { awaitPromise = false, timeoutMs = 120000 } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, timeout: timeoutMs });
    if (r.exceptionDetails) {
      throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fl1-cal-"));
const PORT2 = 21000 + Math.floor(Math.random() * 20000);
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT2}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1280,900",
  "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });
await sleep(900);
const cdp = await CDP.connect(PORT2);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await new Promise((resolve) => {
  const timer = setTimeout(resolve, 8000);
  cdp.ws.addEventListener("message", (msg) => {
    const data = JSON.parse(msg.data);
    if (data.method === "Page.loadEventFired") {
      clearTimeout(timer);
      resolve();
    }
  });
  cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
});
await sleep(800);
// Robustness retry: dynamic imports right after navigation occasionally fail
// with "Failed to fetch dynamically imported module" (context race).
async function evaluateRetry(expr, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await cdp.evaluate(expr, { awaitPromise: true });
    } catch (e) {
      if (i === tries - 1) throw e;
      console.log(`eval retry ${i + 1}: ${e.message.slice(0, 80)}`);
      await sleep(700);
    }
  }
}

// Phase 1 — kappa: one opaque crossing per sample chord via the REAL
// renderer; mean luma drop over the chord's Bresenham footprint.
const KAPPA_EVAL = `(async () => {
  const engine = await import("./src/engine.js");
  const render = await import("./src/render.js");
  const d = 600, pins = 300;
  const tables = engine.buildTables(d, pins);
  const pairs = [];
  for (let i = 0; i < 60; i++) {
    pairs.push([i * 5, (i * 5 + 137) % pins]);
    pairs.push([i * 5 + 1, (i * 5 + 61) % pins]);
  }
  const luma = (p) => (2126 * p[0] + 7152 * p[1] + 722 * p[2]) / 10000;
  let drops = 0, px = 0;
  const profile = [];
  for (const [a, b] of pairs) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const id = (lo * (2 * pins - lo - 1)) / 2 + (hi - lo - 1);
    const s = tables.offsets[id], e = tables.offsets[id + 1];
    const c = document.createElement("canvas");
    c.width = d; c.height = d;
    const r = render.createWeaveRenderer(c);
    r.init(d, pins);
    // one opaque full segment
    const before = [];
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const img0 = ctx.getImageData(0, 0, d, d).data;
    for (let k = s; k < e; k++) {
      const idx = tables.pixels[k];
      before.push(luma([img0[idx * 4], img0[idx * 4 + 1], img0[idx * 4 + 2]]));
    }
    r.drawSegment(a, b);
    const img1 = ctx.getImageData(0, 0, d, d).data;
    for (let j = 0; j < before.length; j++) {
      const idx = tables.pixels[s + j];
      const after = luma([img1[idx * 4], img1[idx * 4 + 1], img1[idx * 4 + 2]]);
      drops += Math.max(0, before[j] - after);
      if (profile.length < 12 && j % 37 === 0) profile.push(+(before[j] - after).toFixed(1));
      px++;
    }
  }
  return { kappa255: +((drops / px)).toFixed(2), sampledDrops: profile };
})()`;

const DECAY_EVAL = `(async () => {
  const render = await import("./src/render.js");
  const engine = await import("./src/engine.js");
  const d = 600, pins = 300;
  const tables = engine.buildTables(d, pins);
  const alpha = ${"__ALPHA__"};
  const c = document.createElement("canvas");
  c.width = d; c.height = d;
  const r = render.createWeaveRenderer(c);
  r.init(d, pins);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  // Override the renderer's opaque stroke with the calibrated alpha stroke
  // (the renderer strokes with whatever ctx state is live; paintGround set it).
  ctx.strokeStyle = "rgba(21,18,13," + alpha + ")";
  const luma = (p) => (2126 * p[0] + 7152 * p[1] + 722 * p[2]) / 10000;
  const pairs = [];
  for (let i = 0; i < 40; i++) pairs.push([i * 7, (i * 7 + 149) % pins]);
  const foot = [];
  for (const [a, b] of pairs) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const id = (lo * (2 * pins - lo - 1)) / 2 + (hi - lo - 1);
    const s = tables.offsets[id], e = tables.offsets[id + 1];
    const list = [];
    for (let k = s; k < e; k++) list.push(tables.pixels[k]);
    foot.push(list);
  }
  const out = [];
  for (let rep = 0; rep <= 16; rep++) {
    let sum = 0, n = 0;
    const img = ctx.getImageData(0, 0, d, d).data;
    for (const list of foot) {
      for (const idx of list) {
        sum += luma([img[idx * 4], img[idx * 4 + 1], img[idx * 4 + 2]]);
        n++;
      }
    }
    out.push(+(sum / n).toFixed(2));
    for (const [a, b] of pairs) r.drawSegment(a, b);
  }
  return out;
})()`;
const kappa = await evaluateRetry(KAPPA_EVAL);
console.log("real renderer kappa (mean opaque drop over Bresenham footprint):", JSON.stringify(kappa));

// Phase 2 — decay curve at the FL-1 winner alpha (delta 8/255, k 0.7):
// alpha = 0.7 * (8/255) / (kappa_real/255).
const alpha = (0.7 * (8 / 255)) / (kappa.kappa255 / 255);
const decayReal = await evaluateRetry(DECAY_EVAL.replace("__ALPHA__", String(alpha.toFixed(4))));
console.log("real decay (mean footprint luma after 0..16 crossings at alpha " + alpha.toFixed(4) + "):", JSON.stringify(decayReal));

// Software renderer validation: identical experiment in Node.
const { buildTables } = await import(path.join(ROOT, "src/engine.js").replace(/\\/g, "/"));
const tables = buildTables(600, 300);
const PAPER_L = (2126 * 0xf5 + 7152 * 0xf0 + 722 * 0xe4) / 10000 / 255;
const THREAD_L = (2126 * 0x15 + 7152 * 0x12 + 722 * 0x0d) / 10000 / 255;
const pins = tables.pins;
const pairs = [];
for (let i = 0; i < 40; i++) pairs.push([i * 7, (i * 7 + 149) % 300]);
function drawCapsule(L, ax, ay, bx, by, a) {
  const SIZE = 600;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - 1.5));
  const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx) + 1.5));
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - 1.5));
  const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by) + 1.5));
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - ax, py = y + 0.5 - ay;
      let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = px - t * dx, cy = py - t * dy;
      const ds = Math.sqrt(cx * cx + cy * cy);
      const cov = 1 - ds;
      if (cov <= 0) continue;
      const i = y * SIZE + x;
      L[i] += a * (cov > 1 ? 1 : cov) * (THREAD_L - L[i]);
    }
  }
}
const footIdx = pairs.map(([a, b]) => {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const id = (lo * (2 * 300 - lo - 1)) / 2 + (hi - lo - 1);
  const s = tables.offsets[id], e = tables.offsets[id + 1];
  const list = [];
  for (let k = s; k < e; k++) list.push(tables.pixels[k]);
  return list;
});
const L = new Float32Array(600 * 600).fill(PAPER_L);
const decaySoft = [];
for (let rep = 0; rep <= 16; rep++) {
  let sum = 0, n = 0;
  for (const list of footIdx) {
    for (const idx of list) { sum += L[idx]; n++; }
  }
  decaySoft.push(+(((sum / n) * 255) / 1).toFixed(2));
  for (const [a, b] of pairs) drawCapsule(L, pins[a * 2], pins[a * 2 + 1], pins[b * 2], pins[b * 2 + 1], alpha);
}
console.log("software decay (same experiment):                                     ", JSON.stringify(decaySoft));
const maxDiff = Math.max(...decayReal.map((v, i) => Math.abs(v - decaySoft[i])));
console.log(`validation: max |real − software| over the 17-point decay curve = ${maxDiff.toFixed(2)}/255 luma`);

fs.writeFileSync(path.join(ROOT, "docs/ultron/research/likeness-evidence/calibration.json"), JSON.stringify({
  kappa255: kappa.kappa255,
  alpha,
  decayReal,
  decaySoft,
  maxDiff255: +maxDiff.toFixed(2),
}, null, 2));
console.log("wrote calibration.json");
chrome.kill("SIGKILL");
server.close();
process.exit(0);

// Phase 2 — k-crossing decay at candidate alpha (validates multiplicative
// model + gives the effective per-crossing fraction).
