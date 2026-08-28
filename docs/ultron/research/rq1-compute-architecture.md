# RQ1 — Compute architecture for the greedy thread engine

- **Decision priority**: P0 (blocks T3 engine design and T4 renderer wiring)
- **Status**: COMMITTED CANDIDATE (auto-commit per plan.md research queue)
- **Affected tasks**: T3 (engine), T4 (renderer). Minor consequences for T8 (determinism hash, perf marks)
- **Delegation record**: deep-research track agent, 2026-08-27. Spike: `docs/ultron/research/spikes/rq1-bench.js` (disposable, not production code)

---

## 1. Question

For 300 pins on a ~600 px circle at ~4,000 greedy passes with deterministic output, vanilla JS
(ES modules, no build step), Canvas 2D rendering: which compute architecture keeps
**time-to-first-thread (TTFT) < 2 s after Start** and rendering **jank-free (~60 fps)**?

Sub-decisions:
1. Chord data strategy: (A) precompute-all / (B) on-the-fly / (C) lazy memoization.
2. Execution context: Web Worker vs chunked main-thread time-slicing.
3. Scheduling: compute-ahead pipelining vs compute-all-then-animate.

## 2. Constraints + evaluation criteria

- Hard: TTFT < 2 s after Start; no visible jank at default animation speed; deterministic output
  (same input + params → identical pin sequence); works from `file://` and any static server
  (T1/T12 acceptance); no build step; evergreen browsers.
- Soft: honest memory footprint (mobile-safe), simple module boundaries (T3 must be pure/testable),
  fast-forward/speed control must never starve or block.
- Criteria ranked: (1) TTFT headroom, (2) main-thread isolation, (3) total compute time,
  (4) memory, (5) implementation simplicity/determinism risk.

## 3. Options considered

### A) Precompute-all chord tables (COMMITTED)
Build flattened pixel-index lists for all C(300,2) = 44,850 chords once (Bresenham, 8-connected),
stored as `Uint32Array` indices + `Uint32Array` offsets; greedy steps only sum prebuilt lists.

- **Fit**: measured total 529 ms (build 91 ms + loop 438 ms, 109.5 µs/step). Memory 59.0 MB
  (15,410,134 px × 4 B = 58.8 MB + 0.17 MB offsets). TTFT probe (build + first 64 passes): **104 ms**.
- **Effort**: low — straight typed-array code, no cache invalidation logic.
- **Risks**: 59 MB resident (acceptable for desktop + modern phones; single contiguous allocation,
  trivially freed). Wasted build if user cancels instantly (~91 ms — negligible).
  **Tables depend only on (size, pins, radius) — NOT the image** → reuse across restarts/reweaves
  with same settings; rebuild only when pin count/size changes.

### B) On-the-fly rasterization (rejected)
Fused Bresenham+sum per candidate per step, no cache (strongest form — no index materialization).

- **Fit**: measured 2,237 ms (559.3 µs/step) = **5.14× A's loop, 4.26× A's total**. Memory ~0 extra.
- **Effort**: lowest code, but TTFT on slower/mobile hardware (3–5× inflation) approaches/breaches 2 s
  before pass 1 (first pass needs 295 rasterizations — fine — but full-weave fast-forward and
  complete-in-<10s goals suffer).
- **Risks**: raw speed. Keep as documented low-memory contingency (e.g., `navigator.deviceMemory ≤ 2`),
  not committed.

### C) Lazy memoization (rejected)
Rasterize each chord on first evaluation, cache (Map<chordId, Uint32Array>).

- **Fit**: measured 698.7 ms (174.7 µs/step). Key measurement: **44,250 of 44,850 chords (98.7%)
  get cached** — the greedy walk visits 300/300 pins within 4,000 passes, and each visited pin
  rasterizes all its ~295 candidates. Memory converges to A's 58.8 MB **plus** Map/per-array
  overhead (~2 MB) **plus** allocation churn during the run.
- **Effort**: medium (cache keying, growth management).
- **Risks**: strictly dominated by A in this regime: same steady-state memory, slower loop
  (174.7 vs 109.5 µs/step), worse locality. C only wins when passes ≪ pin-visit coverage or a
  min-chord-length rule prunes candidates hard — not the committed parameter space (RQ2 may prune
  short chords; even a 30% prune leaves C paying A-class memory for A-beating work).

### Execution context decision

**Web Worker (primary) + chunked main-thread fallback (feature-detected).**

- The greedy loop is inherently sequential (pass k+1 reads state mutated by pass k) — a worker
  gives **no parallel speedup**; its value is main-thread isolation (zero compute on the rAF
  thread → jank-free by construction) and a clean producer/consumer animation pipeline.
- Measured fallback viability: chunked A on main thread, 8 ms compute budget per `setTimeout(0)`
  slice → 528 ms wall (1.21× loop-only, 1.00× incl. build), 58 slices, 68 ms total scheduling
  overhead. Fully viable; used when Worker spawn throws (Chrome `file://`: origin `null` →
  `SecurityError`, see evidence).
- **SharedArrayBuffer rejected**: requires secure context + cross-origin isolation via COOP/COEP
  HTTP headers; on plain static servers and `file://` the constructor is hidden and `postMessage`
  throws (MDN). Transferables give us zero-copy message passing without any headers.
- **requestIdleCallback rejected as scheduler**: not Baseline, disabled by default in Safari
  (WebKit enabled it only in STP 178). `setTimeout` time-slicing is universal; idle callbacks also
  fire too rarely under load for our TTFT budget.

### Scheduling decision

**Compute-ahead pipelining (committed).** Worker streams batches of pass records (first batch of
~64 passes immediately after table build, then ~128–256 per message); renderer animates from a
buffered queue at user speed. TTFT ≈ build + first batch ≈ 0.1 s measured (Node) — ~0.3–0.5 s even
assuming 3–5× browser/mobile inflation, vs compute-all-then-animate which could reach 2–3 s on slow
hardware (breaching budget). Compute (0.11 ms/pass) vastly outpaces even 60 fps fast-forward
drawing, so the queue never starves. Same protocol serves both worker and fallback paths.

## 4. Recommendation + rationale

**Architecture A (precompute-all) running in a Web Worker (module worker), streaming transferable
pass-record batches to the main-thread renderer (compute-ahead pipelining); feature-detected
fallback to chunked main-thread `setTimeout` time-slicing over the same engine module; no
SharedArrayBuffer; no requestIdleCallback.**

Rationale: A is measured-fastest in total and per-step (529 ms / 109.5 µs/step) with a 19× TTFT
margin (104 ms vs 2,000 ms budget); C converges to A's memory anyway (98.7% cache coverage) so its
only theoretical advantage never materializes at these parameters; B is 4.26× slower with TTFT risk
on slow hardware. Worker keeps all compute off the rAF thread and the pipelined protocol makes TTFT
independent of total compute; the measured fallback keeps the `file://` acceptance path (T1/T12)
honest with identical determinism (same engine code, same sequence — verified in spike:
hash `4703e4a2` identical across A, B, C, and chunked execution).

## 5. Evidence

### Primary sources (consulted 2026-08-27)

1. MDN — Using web workers (last modified 2026-05-07):
   https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
   — transferables are "zero-copy"; workers intended for "processor-intensive calculations without
   blocking the user interface thread"; subworkers must be same-origin.
2. MDN — SharedArrayBuffer (last modified 2026-02-10):
   https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
   — shared memory requires secure context + cross-origin isolation (COOP/COEP headers); otherwise
   "the constructor on the global object is hidden" and "the various postMessage() APIs will throw".
   Baseline since Dec 2021 but only under those headers.
3. MDN — Worker() constructor (last modified 2026-05-21):
   https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker
   — script URL "must be same-origin with the caller's document, or a blob: or data: URL";
   `SecurityError DOMException` thrown when same-origin policy violated; `{ type: "module" }`
   support: Chrome/Edge 80, Safari 15, Firefox 114 (per MDN compat table / caniuse).
4. MDN — Transferable objects (last modified 2025-09-18):
   https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
   — ArrayBuffer transferable (memory "moved", detached after); typed arrays are NOT transferable —
   transfer the underlying `.buffer`.
5. MDN — requestIdleCallback (last modified 2025-06-23):
   https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback
   — "Limited availability", not Baseline (Safari ships disabled by default; WebKit enabled it in
   Safari Technology Preview 178 per
   https://developer.apple.com/documentation/safari-technology-preview-release-notes/stp-release-178);
   MDN itself recommends a setTimeout fallback.
6. Chrome `file://` worker restriction (corroborating):
   https://stackoverflow.com/questions/67326425/construct-worker-from-script-loaded-from-different-origin and
   https://github.com/nraynaud/webgcode/issues/36 — "Failed to construct 'Worker': Script at
   'file:///…' cannot be accessed from origin 'null'". Workarounds: serve over http, blob-URL
   worker, or `--allow-file-access-from-files` flag. This is why a main-thread fallback is required
   for T1/T12's `file://` acceptance.

### Spike measurements (measured, not guessed)

Script: `docs/ultron/research/spikes/rq1-bench.js`. Re-run: `node docs/ultron/research/spikes/rq1-bench.js`
(Node ≥ 18, no deps; recorded with Node v24.8.0, darwin arm64, 2026-08-27, median of 3;
runtime ≈ 35 s). Synthetic deterministic 600×600 Float32 darkness image (mulberry32 seed 20260827,
5 soft blobs + paper noise), 300 pins @ r=298, skip cyclic-distance ≤ 2 (295 candidates/step),
delta 24/255, 4,000 passes.

| Metric | A precompute-all | B on-the-fly (fused) | C lazy memo |
|---|---|---|---|
| Table build | 91.2 ms | — | — |
| Greedy loop (4,000 passes) | 438.1 ms | 2,237.1 ms | 698.7 ms |
| Per step | 109.5 µs | 559.3 µs | 174.7 µs |
| Total | **529.3 ms** | 2,237.1 ms (4.26× A) | 698.7 ms |
| Extra memory | **59.0 MB** (58.8 MB pixels + 0.17 MB offsets) | ~0 | 58.8 MB + ~2 MB overhead |
| Chords touched/cached | all 44,850 by construction | none | 44,250 / 44,850 = 98.7% |

- Pixel model (analytic, confirmed): avg Bresenham chord = 0.9003 × 4R/π = 341.6 px predicted,
  343.6 px measured; total indices 15,410,134. Candidate evaluations per run: 1,180,000
  (295 × 4,000); pixel reads ≈ 403 M per run.
- TTFT probe (A: build + first 64 passes): **104.4 ms** (budget 2,000 ms → ~19× headroom).
- Chunked main-thread (A tables, 8 ms budget, `setTimeout(0)`): 528.1 ms wall, 58 slices,
  scheduling overhead 68.4 ms → 1.00× A total. **Viable fallback.**
- Determinism: A ≡ A′ ≡ B ≡ C ≡ chunked, sequence hash `4703e4a2` — only after canonicalizing
  chord rasterization direction (see Finding D1). Before canonicalization, B and C diverged from A.
- Node ≠ browser JIT caveat: browser/mobile may run 1.5–5× slower; even at 5× inflation A totals
  ~2.6 s compute with TTFT ~0.5 s (pipelined) — still within budget. Margin is ≥ 4× everywhere.

### Findings that became implementation requirements

- **D1 (determinism hazard)**: Bresenham pixel sets are direction-dependent — walking pin i→j vs
  j→i covers different pixels. Canonicalize every chord rasterization to lo→hi pin index (and/or
  key caches by unordered pair but always rasterize canonically). Summation is safe: float64
  accumulation of our float32 values (≤ 2^24 mantissa bits, sums < 2^9) is exact, hence
  order-independent — direction, not float associativity, was the divergence cause.
- **D2**: tie-breaking must be explicit — strict `>` with candidate iteration in ascending pin
  index gives "lowest index wins ties", deterministic everywhere.
- **D3**: chord tables are image-independent (depend only on size/pins/radius) → build once,
  reuse across reweaves; only pin-count/resolution changes trigger rebuild.

## 6. Tradeoffs + confidence

- We pay 59 MB resident for a 4.26× speed win and 19× TTFT headroom. If a future low-memory
  target appears (deviceMemory ≤ 2 GB devices), arch B remains a parameter-level escape hatch
  (same engine interface, no tables) at the cost of speed — documented contingency only.
- Worker adds one message-protocol module and a fallback path; without the `file://` acceptance
  requirement the fallback could be dropped, but T1/T12 lock it in.
- Confidence: **high** on the A-vs-B-vs-C ordering and the worker+pipeline shape (measured, large
  margins, cross-validated determinism). **Medium** on absolute browser/mobile timings (Node JIT
  proxy; inflation assumption 3–5×). T8 must re-measure TTFT and frame stats in-browser.

## 7. Implementation consequences + plan updates for T3/T4

### T3 — engine (src/engine.js, pure, no DOM/worker imports)

- Pure function core: `buildTables(size, pins, radius) -> {pixels: Uint32Array, offsets: Uint32Array}`
  (cacheable per D3) and `weave(darkness: Float32Array, size, params, tables, from, to, out: Int16Array)`
  writing pass records `(fromPin, toPin)` pairs — resumable ranges enable both batching and the
  chunked fallback. Params: `{ pins, passes, skipAdjacent, delta, minChordLen? }` (defaults from RQ2).
- Compact chord id: `lo*(2*PINS-lo-1)/2 + (hi-lo-1)` for lo<hi (bijection verified in spike).
- Requirements D1–D3 baked in; unit tests: determinism (same hash twice, and tables-reuse path),
  converges on dark blob, chosen-chord pixels lightened exactly once per pass, no duplicate pixel
  index within a chord's list.

### T4 — renderer + scheduler (src/render.js, src/anim.js, src/compute.js)

- `src/compute.js` scheduler: try `new Worker(new URL('./engine-worker.js', import.meta.url),
  { type: 'module' })` inside try/catch; on throw (Chrome `file://`), fall back to chunked
  main-thread execution of the same `weave()` in ≤ 8 ms `setTimeout` slices. Worker protocol sketch:
  - main → worker: `{ type: 'start', params, size, darkness: Float32Array }` (darkness buffer
    **transferred**, not copied; note: transfer the `.buffer`, per MDN typed arrays aren't
    transferable themselves)
  - worker → main: `{ type: 'progress', from, to, seq: Int16Array }` (buffer transferred; first
    batch ≈ 64 passes for TTFT, then 128–256), `{ type: 'done', stats }`, `{ type: 'error', message }`
  - main → worker: `{ type: 'cancel' }`
  - Never uses SharedArrayBuffer (COOP/COEP unavailability documented above).
- Renderer: pure consumer of the pass-record queue; draws incremental pin-to-pin segments on a
  persistent Canvas 2D (no per-frame clear); speed multiplier = passes/second (pause, fast-forward
  drains multiple segments per frame); complete state fires when `done` received AND queue drained.
- T8 additions: record TTFT via performance marks, frame-time samples, and determinism hash
  (worker path and fallback path must match — spike already proves same-code equality).

---

## 8. Summary block (for plan fold-back)

**Committed**: Arch A precomputed chord tables in a module Web Worker, transferable-batch
compute-ahead pipelining, `setTimeout`-chunked main-thread fallback (no SAB, no rIC), canonical
lo→hi rasterization + explicit tie-break for determinism. Measured (Node 24.8.0, M-series):
529 ms full weave, 104 ms TTFT (budget 2 s), 59 MB, 109.5 µs/pass; fallback +0–21% wall.
