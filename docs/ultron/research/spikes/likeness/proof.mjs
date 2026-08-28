// FL-1 proof — before/after woven output from the REAL app code of a given
// tree (engine + render modules, run in-page under headless Chrome), on the
// likeness lab's deterministic portrait target. Saves PNG + metrics per tree.
//
// Usage: node proof.mjs <tree-root> <out-prefix>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const TREE = path.resolve(process.argv[2] || ".");
const PREFIX = process.argv[3] || "run";
const EVIDENCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../likeness-evidence");
fs.mkdirSync(EVIDENCE, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" };
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let p = path.join(TREE, path.normalize(url.pathname));
    if (p === TREE || url.pathname.endsWith("/")) p = path.join(TREE, "index.html");
    if (!p.startsWith(TREE) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fl1-proof-"));
const PORT2 = 23000 + Math.floor(Math.random() * 20000);
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
    if (data.method === "Page.loadEventFired") { clearTimeout(timer); resolve(); }
  });
  cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
});
await sleep(800);

// In-page: rebuild the lab's deterministic portrait target, weave it with
// THIS tree's engine at THIS tree's defaults, replay through THIS tree's
// renderer, and measure. (Generator copied verbatim from lab.mjs.)
const EVAL = `(async () => {
  const engine = await import("./src/engine.js");
  const render = await import("./src/render.js");
  const SIZE = 600;
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function inCircle(x, y) {
    const dx = x + 0.5 - SIZE / 2, dy = y + 0.5 - SIZE / 2;
    return dx * dx + dy * dy <= (SIZE / 2) * (SIZE / 2);
  }
  function ellipseAlpha(x, y, cx, cy, rx, ry, soft = 10) {
    const nx = (x - cx) / rx, ny = (y - cy) / ry;
    const d = Math.sqrt(nx * nx + ny * ny);
    const a = (1 - d) * soft;
    return a <= 0 ? 0 : a >= 1 ? 1 : a;
  }
  const rnd = mulberry32(7717);
  const luma = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!inCircle(x, y)) { luma[y * SIZE + x] = 1; continue; }
      let v = 0.86 + (rnd() - 0.5) * 0.03;
      let a = ellipseAlpha(x, y, 300, 225, 170, 165, 6);
      v = v * (1 - a) + 0.14 * a;
      const fa = ellipseAlpha(x, y, 300, 325, 118, 150, 8);
      const skin = 0.8 + (0.68 - 0.8) * Math.min(1, Math.max(0, (y - 175) / 300));
      const side = 1 - 0.06 * ellipseAlpha(x, y, 300, 325, 118, 150, 3) * Math.abs(x - 300) / 118;
      v = v * (1 - fa) + skin * side * fa;
      const fringe = ellipseAlpha(x, y, 300, 182, 132, 58, 8);
      v = v * (1 - fringe) + 0.14 * fringe;
      for (const [bx, by] of [[252, 283], [348, 283]]) {
        const b = ellipseAlpha(x, y, bx, by, 23, 5.5, 6);
        v = v * (1 - b) + 0.3 * b;
      }
      for (const [ex, ey] of [[252, 300], [348, 300]]) {
        const e = ellipseAlpha(x, y, ex, ey, 18, 9.5, 5);
        v = v * (1 - e) + 0.12 * e;
        const g = ellipseAlpha(x, y, ex + 5, ey - 3, 3.2, 2.4, 4);
        v = v * (1 - g * 0.75) + (0.12 + 0.55) * 0.75 * g;
      }
      const ns = ellipseAlpha(x, y, 300, 352, 26, 34, 4) * 0.18;
      v = v * (1 - ns) + (v - 0.1) * ns;
      for (const [nx, ny] of [[289, 364], [311, 364]]) {
        const n = ellipseAlpha(x, y, nx, ny, 5, 3.2, 5);
        v = v * (1 - n) + 0.25 * n;
      }
      const ml = ellipseAlpha(x, y, 300, 390, 31, 9, 5);
      v = v * (1 - ml) + 0.34 * ml;
      const seam = ellipseAlpha(x, y, 300, 390, 26, 3.4, 5);
      v = v * (1 - seam) + 0.18 * seam;
      const cs = ellipseAlpha(x, y, 300, 478, 86, 22, 4) * 0.45;
      v = v * (1 - cs) + (v - 0.22) * cs;
      luma[y * SIZE + x] = Math.max(0, Math.min(1, v));
    }
  }
  const tables = engine.buildTables(SIZE, 300);
  const run = engine.weave(luma, undefined, tables);
  const c = document.createElement("canvas");
  c.width = SIZE; c.height = SIZE;
  const r = render.createWeaveRenderer(c);
  if (typeof render.threadAlphaForDelta255 === "function") {
    r.init(SIZE, 300, { threadAlpha: render.threadAlphaForDelta255(run.config.lighteningDelta * 255) });
  } else {
    r.init(SIZE, 300); // pre-FL-1 tree: opaque ink
  }
  r.replay(run.seq);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const at = (i) => (2126 * data[i * 4] + 7152 * data[i * 4 + 1] + 722 * data[i * 4 + 2]) / 10000 / 255;
  const mask = new Uint8Array(SIZE * SIZE);
  let n = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (inCircle(x, y)) { mask[y * SIZE + x] = 1; n++; }
  }
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, err = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const t = luma[i], v = at(i);
    sa += t; sb += v; saa += t * t; sbb += v * v; sab += t * v; err += Math.abs(t - v);
  }
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) * (sa / n), vb = sbb / n - (sb / n) * (sb / n);
  function regionMean(cx, cy, rx, ry) {
    let sum = 0, m = 0;
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || !inCircle(x, y)) continue;
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny > 1) continue;
        const l = at(y * SIZE + x);
        sum += 1 - l; m++;
      }
    }
    return m ? sum / m : 0;
  }
  const eyeD = (regionMean(252, 300, 11, 7) + regionMean(348, 300, 11, 7)) / 2;
  const cheekD = (regionMean(233, 338, 16, 12) + regionMean(367, 338, 16, 12)) / 2;
  const mouthD = regionMean(300, 390, 20, 6);
  const hairD = regionMean(300, 165, 65, 42);
  const bgD = (regionMean(95, 140, 26, 18) + regionMean(505, 460, 26, 18)) / 2;
  let chordSum = 0, chordN = 0;
  for (let k = 0; k + 1 < run.seq.length; k += 2) {
    const a = run.seq[k], b = run.seq[k + 1];
    const dx = tables.pinPx[b * 2] - tables.pinPx[a * 2];
    const dy = tables.pinPx[b * 2 + 1] - tables.pinPx[a * 2 + 1];
    chordSum += Math.sqrt(dx * dx + dy * dy); chordN++;
  }
  let rsum = 0, rn = 0;
  for (let i = 0; i < 300; i++) for (let j = i + 1; j < 300; j++) {
    const dx = tables.pinPx[j * 2] - tables.pinPx[i * 2];
    const dy = tables.pinPx[j * 2 + 1] - tables.pinPx[i * 2 + 1];
    rsum += Math.sqrt(dx * dx + dy * dy); rn++;
  }
  return {
    tree: ${JSON.stringify(path.basename(TREE))},
    defaults: {
      delta255: +(run.config.lighteningDelta * 255).toFixed(1),
      scoreNorm: run.config.scoreNorm || "sum(pre-FL-1)",
      passes: run.config.maxPasses,
    },
    passesUsed: run.passesUsed,
    seqHash: engine.hashSequence(run.seq),
    corr: +(cov / Math.sqrt(va * vb)).toFixed(4),
    mae255: +((err / n) * 255).toFixed(1),
    eyeMinusCheek: +(eyeD - cheekD).toFixed(3),
    mouthMinusCheek: +(mouthD - cheekD).toFixed(3),
    hairMinusBg: +(hairD - bgD).toFixed(3),
    chordMean: +(chordSum / chordN).toFixed(1),
    randomChordMean: +(rsum / rn).toFixed(1),
    feet: Math.round(run.totalThreadEuclidPx * (0.6096 / SIZE) * 3.28084),
    wovenPct: +((1 - run.remainingDarkness / run.initialDarkness) * 100).toFixed(1),
    threadAlpha: typeof r.threadAlpha === "number" ? +r.threadAlpha.toFixed(4) : 1,
    png: c.toDataURL("image/png").split(",")[1],
  };
})()`;

const result = await cdp.evaluate(EVAL, { awaitPromise: true });
const { png, ...metrics } = result;
fs.writeFileSync(path.join(EVIDENCE, `proof-${PREFIX}-woven.png`), Buffer.from(png, "base64"));
fs.writeFileSync(path.join(EVIDENCE, `proof-${PREFIX}-metrics.json`), JSON.stringify(metrics, null, 2));
console.log(`${PREFIX}:`, JSON.stringify(metrics, null, 2));
chrome.kill("SIGKILL");
server.close();
process.exit(0);
