# Plan — Algorithmic Thread Art Generator

Status: APPROVED — research committed; ready for production
Source scope: docs/ultron/town-hall.md (APPROVED)

## Fixed by scope (not re-decided here)
- Pure client-side static single page; no build step required; no backend; zero network after load.
- Lean showpiece MVP; non-goals locked in the brief.
- Deterministic; internal working resolution ~500–700 px; evergreen browsers; graceful mobile.
- Outputs: animated experience, PNG download, plain-text pin sequence + stats.
- 11 acceptance criteria in the brief are the contract.

## Committed research decisions (auto-approved (ultron-supreme), 2026-08-27)
- RQ1 → COMMITTED: Precompute-all chord tables (Uint32 flattened + offsets, canonical lo→hi
  rasterization with explicit tie-break for determinism) inside a module Web Worker; stream
  transferable pass-record batches (first ~64 passes immediately, then 128–256) for compute-ahead
  pipelining; feature-detected setTimeout-chunked main-thread fallback using the same engine;
  NO SharedArrayBuffer, NO requestIdleCallback. Evidence: research/rq1-compute-architecture.md +
  research/spikes/rq1-bench.js (529 ms total, 104 ms TTFT, 59 MB, determinism hash stable).
  Affects T3 (pure engine: buildTables/weave), T4 (src/compute.js scheduler + worker protocol +
  fallback), T8 (TTFT/frame/determinism instrumentation).
- RQ2 → COMMITTED defaults: pins 300 (knob 200–500); passes 4000 (knob 1000–8000);
  lighteningDelta 20/255 (knob 4–32); neighborSkip = round(n/30) both directions (=10 at 300
  pins, knob 0–25); minImprovement 0; stopping = pass budget AND 3-consecutive-no-improvement
  convergence; animation speed 0.5×–16× is display-only (T4). Evidence:
  research/rq2-algorithm-defaults.md. Affects T3 (config object + stopping logic), T4/T5
  (knobs/counters), T8 (mean-pixel-error tripwire: if too light try delta 24 / 5000 passes).
- RQ3 → COMMITTED mapping: default board 24 in (60.96 cm); feet = Σ chord_px × (0.6096 /
  virtual_diameter_px) × 3.28084 — expect ≈5,093 ft (1,552 m) at 4,000 passes; thread spec: black
  100% polyester ~0.3 mm (informs ~1 px visual line width at 600 px res); counter shows feet
  primary, meters secondary in stats; .txt header states the board assumption + thread note.
  Evidence: research/rq3-physical-mapping.md. Affects T5 (display-time scale factor over
  canonical totalPx), T7 (txt header fields).
- RQ4 → COMMITTED preprocessing: conditional 2nd→98nd percentile linear stretch over in-circle
  pixels only; SKIP if (p98−p2 ≥ 200) → bit-exact passthrough, or (< 24) → flat/noise guard;
  else LUT-stretch to 0–255; deterministic, dependency-free. Evidence:
  research/rq4-contrast-normalization.md. Affects T2 (pipeline decode→downscale 'high'→circle
  crop→normalize→Float32Array; log applied/p2/p98/range), T3 (plateau mitigation), T8 (log fields).

## Lanes
Product/UX · UI/Visual Design · Frontend Engineering · Engine (algorithm) · QA/Test ·
Accessibility · DevOps(static). No backend lane.

---

## Tasks

### T1 — Static page scaffold
- Owner: Frontend. Outcome: the page exists and accepts an image.
- Status: completed. Size: small.
- Scope: `index.html` + `styles.css` + ES module JS structure; canvas; landing state with drop
  zone (file picker + drag-and-drop; paste optional); basic error state for unreadable files;
  "image never leaves your machine" statement. Journey: Land → Upload.
- Inputs: brief. Output: loadable static page in project root.
- Deps: none. Parallel: — .
- Files: index.html, styles.css, src/main.js (+ upload module).
- Acceptance: page opens via file:// or static server; accepts jpg/png/webp; broken file shows
  error, not a crash. Validation: manual load + upload of 3 file types.
- Risks: none material.

### T2 — Ingest + draggable circular crop
- Owner: Frontend (UX consulted). Outcome: working-res greyscale circle ready for the engine.
- Status: completed. Size: medium.
- Scope: EXIF-safe decode (createImageBitmap imageOrientation), downscale to ~600 px working res,
  circular draggable crop overlay (mouse + touch) over the uploaded image, emit
  {Float32Array greyscale circle data, diameter, crop offset}. Per rq4: pipeline decode→downscale
  'high'→circle crop→normalize→Float32Array (conditional p2→p98 stretch, in-circle only; skip if
  p98−p2 ≥ 200 or < 24) and log applied/p2/p98/range. Journey: Upload → Crop.
- Inputs: T1. Output: `src/ingest.js`, `src/crop.js`.
- Deps: T1. Parallel: T3 (engine builds against synthetic arrays).
- Acceptance: crop circle draggable on desktop + touch; emitted array dimensions correct; EXIF
  portrait renders upright. Validation: instrumented dump + visual check.
- Risks: touch crop feel on small screens → T11 pass.

### T3 — Greedy thread engine (pure, testable)
- Owner: Engine. Outcome: deterministic pin-sequence generator.
- Status: completed. Size: medium.
- Scope: pin placement on circle; chord enumeration with pixel-index lists; greedy loop — from
  current pin evaluate candidate chords by summed darkness, pick best, subtract lightening delta,
  record chord; stopping rules (pass target and/or min-improvement threshold); parameters exposed
  as a config object. Per rq1: pure buildTables/weave split (Uint32 flattened + offsets, lo→hi
  tie-break). Per rq2: defaults 300 pins / 4000 passes / delta 20/255 / neighborSkip round(n/30)
  / minImprovement 0; stopping = pass budget AND 3-consecutive-no-improvement. Per rq4:
  normalization upstream mitigates plateau on light images. No rendering, no DOM — pure module +
  unit tests.
- Inputs: T1 (module wiring), RQ1 architecture, RQ2 defaults. Output: `src/engine.js` + tests.
- Deps: T1. Parallel: T2.
- Acceptance: unit tests pass (synthetic arrays: converges on dark blob, deterministic across
  runs, lightening applied exactly once per covered pixel per pass). Validation: test runner (node
  or browser test page).
- Risks: perf on default settings → RQ1; plateau on light images → RQ4.

### T4 — Animated weave renderer
- Owner: Frontend. Outcome: the showpiece — thread drawing itself in real time.
- Status: completed. Size: medium.
- Scope: consume engine steps (per rq1: worker protocol via `src/compute.js` scheduler —
  transferable pass-record batches, first ~64 then 128–256, with feature-detected
  setTimeout-chunked main-thread fallback using the same engine; no SharedArrayBuffer, no
  requestIdleCallback); draw progressive black thread segments pin-to-pin at ~60fps; speed
  multiplier incl. pause and fast-forward (per rq2: 0.5×–16×, display-only); start on explicit
  Start; completion transitions to complete state. Journey: Start → Weaving → Complete.
- Inputs: T2, T3, RQ1. Output: `src/render.js`, `src/anim.js`.
- Deps: T2, T3. Parallel: — .
- Acceptance: no visible jank at default speed; speed control materially changes duration;
  time-to-first-thread < 2 s after Start. Validation: perf marks + manual watch.
- Risks: architecture choice (RQ1) determines worker wiring.

### T5 — Live counters
- Owner: Frontend (UX consulted). Outcome: honest, ticking stats during the weave.
- Status: completed. Size: small.
- Scope: feet-of-string counter from summed Euclidean chord lengths × physical mapping (per rq3:
  display-time scale factor over canonical totalPx — 24 in board, feet = Σ chord_px × (0.6096 /
  virtual_diameter_px) × 3.28084, ≈5,093 ft at 4,000 passes; feet primary, meters secondary in
  stats); passes counter (per rq2: knobs 200–500 pins, 1000–8000 passes reflected in counters);
  subtle progress indication. Rendered as live text (accessible).
- Inputs: T4, RQ3. Output: `src/stats.js` + UI region.
- Deps: T4. Parallel: — .
- Acceptance: counter monotonic; feet value consistent with chord geometry (spot-check vs
  hand-computed chord sum). Validation: instrumented assertion in dev build.
- Risks: RQ3 mapping not yet committed — compute per-chord honestly, apply scale factor at display.

### T6 — Completion state
- Owner: Product/UX + Frontend. Outcome: satisfying landing after the weave.
- Status: completed. Size: small.
- Scope: stats summary (pins, passes, total feet, board assumption), "view original" toggle
  (simple toggle, NOT a compare slider), restart with new settings/image. Journey: Complete.
- Inputs: T4, T5. Output: completion UI.
- Deps: T5. Parallel: T7.
- Acceptance: toggle shows original; restart returns to crop state cleanly (no leaks/stale canvas).
  Validation: manual journey run.

### T7 — Downloads
- Owner: Frontend. Outcome: PNG + pin-sequence artifacts.
- Status: completed. Size: small.
- Scope: PNG export of final canvas; plain-text sequence: stats header (pins, passes, total feet,
  assumed board size; per rq3: header states 24 in board assumption + thread note — black 100%
  polyester ~0.3 mm, feet primary/meters secondary) + numbered `1. 214 → 89` winding order;
  client-side blob downloads.
- Inputs: T6. Output: `src/download.js`.
- Deps: T6 (stats exist). Parallel: T6 partially.
- Acceptance: PNG matches canvas; txt order equals drawn sequence (assert against engine log).
  Validation: automated check in test page.

### T8 — QA acceptance harness
- Owner: QA. Outcome: evidence for the 11 acceptance criteria.
- Status: completed. Size: medium.
- Scope: determinism check (same input+params → identical sequence hash); timing instrumentation
  (TtFT, frame stats; per rq1: TTFT/frame/determinism instrumentation — re-measure absolute
  browser timings from the spike); internal mean-pixel-error metric logged to console/dev panel
  (per rq2: tripwire — if too light try delta 24 / 5000 passes; per rq4: log applied/p2/p98/range
  fields); download correctness assertions; document results in production-log.md.
- Inputs: T3, T4, T5, T7. Output: `tests/` or dev harness page + log entries.
- Deps: T7. Parallel: T9, T10.
- Acceptance: each of the 11 brief criteria has recorded pass/fail evidence. Validation: run
  harness, review log.
- Risks: perf variance across hardware — record environment.

### T9 — Accessibility pass
- Owner: Accessibility. Outcome: no one is locked out of the experience.
- Status: completed. Size: small.
- Scope: `prefers-reduced-motion` instant/stepped finish path; canvas label; keyboard-reachable
  controls; counters as live text (already text).
- Inputs: T4. Output: a11y wiring in render/UI.
- Deps: T4. Parallel: T7, T10.
- Acceptance: reduced-motion honored (no long animation); tab-through works. Validation: manual +
  OS setting toggle.

### T10 — Showpiece polish
- Owner: UI/Visual Design. Outcome: it looks like a portfolio piece.
- Status: completed. Size: medium.
- Scope: typography, counter styling, landing/empty state, crop state, complete state, error
  state, privacy statement presentation; consistent visual identity for the whole journey.
- Inputs: T6. Output: styles overhaul.
- Deps: T6. Parallel: T8, T9.
- Acceptance: all six states visually coherent; no layout break at common sizes. Validation:
  screenshot review at 1280/1440/390 widths.

### T11 — Graceful mobile pass
- Owner: Frontend (QA consulted). Outcome: usable on modern phones.
- Status: completed. Size: small.
- Scope: responsive layout, touch crop drag verified, weave performance spot-check, controls
  reachable.
- Inputs: T2, T4, T10. Output: responsive fixes.
- Deps: T10. Parallel: T8.
- Acceptance: journey completable on a modern phone (devtools emulation + real device if
  available). Validation: manual run.

### T12 — Static deploy readiness + final sweep
- Owner: DevOps/QA. Outcome: shippable folder + final acceptance state recorded.
- Status: completed. Size: small.
- Scope: works from file:// and any static server; relative paths; no console errors; final run of
  T8 harness; write final acceptance state to production-log.md.
- Inputs: all. Output: final report.
- Deps: T8, T9, T10, T11. Parallel: — .
- Acceptance: clean run from static server; production-log.md records final state. Validation:
  serve + full journey.

---

## Dependency-ordered index
1. T1 scaffold
2. T2 crop ← T1 ∥ T3
3. T3 engine ← T1 (RQ1, RQ2) ∥ T2
4. T4 renderer ← T2, T3 (RQ1)
5. T5 counters ← T4 (RQ3)
6. T6 completion ← T5 ∥ T7
7. T7 downloads ← T6
8. T8 QA harness ← T7 ∥ T9 ∥ T10
9. T9 a11y ← T4 ∥ T8 ∥ T10
10. T10 polish ← T6 ∥ T8 ∥ T9
11. T11 mobile ← T10
12. T12 deploy + final sweep ← T8–T11
13. Post-run fix FL-1 likeness defect (matched ink + mean scoring, delta 20→8) ← post-T12
    user report · completed-pending-verification — evidence: production-log.md FL-1 entry

## Milestones
- M1 — "It accepts a portrait" (T1+T2): upload, EXIF-safe, draggable circle. Exposes crop UX
  assumptions earliest.
- M2 — "It weaves end-to-end" (T3+T4+T5): thin full path — engine → animation → honest counter.
  Riskiest assumptions (algorithm quality, perf) proven here.
- M3 — "It lands" (T6+T7): completion state + both downloads.
- M4 — "It ships" (T8–T12): acceptance evidence, a11y, polish, mobile, static readiness.

## Assumptions that return to Town Hall if broken
- No build step is both possible and sufficient (pure ES modules).
- Greedy quality on portraits is acceptable for a showpiece without algorithm upgrades.
- ~600 px working resolution suffices for likeness at 300 pins.

## Handoff
- Build order: T1 → {T2 ∥ T3} → T4 → T5 → {T6 → T7} → {T8 ∥ T9 ∥ T10} → T11 → T12.
- Fixed decisions: see "Fixed by scope".
- Research queue: RQ1–RQ4 above, phrased per task; dispositions auto-committed by
  deep-research-supreme, folded back into T2/T3/T4/T5 before their execution.
- Approval needed now: this plan (the single user review of the run; everything after is
  auto-approved by ultron-supreme).
