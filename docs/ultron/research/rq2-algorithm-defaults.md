# RQ2 — Algorithm defaults that produce recognizable portraits (+ stopping rules)

- Decision priority: **P0** (blocks T3 engine defaults; informs T4 speed, T5 pass counter, T8 quality metric)
- Status: **committed candidate** (auto-committed per state.md; delta value carries a one-line tuning note for T8)
- Affected tasks: **T3** (primary — config object + stopping logic), T4 (speed knob semantics), T5 (pass counter target), T8 (mean-pixel-error baseline)
- Delegation record: deep-research track agent (ZCode / GLM-5.3), 2026-08-27

---

## 1. Question

What default parameter set makes the greedy thread engine produce RECOGNIZABLE portraits from a
~600 px greyscale circle: pin count (default + range), pass/thread count, per-thread lightening
delta, minimum chord improvement threshold, near-neighbor pin ignore rule, stopping rules, and
which preprocessing materially affects recognition?

## 2. Constraints + evaluation criteria

Constraints (fixed by scope/plan):
- Client-side, deterministic, no build step; internal working resolution ~500–700 px (plan.md line 9).
- Pin default ~300, range roughly 200–500 (scope).
- Engine model fixed in T3 scope: greedy loop, summed-darkness scoring, **subtract a constant
  lightening delta per covered pixel** (plan.md lines 62–66). Preprocessing normalization is RQ4's
  call; RQ2 only flags what matters.

Evaluation criteria:
1. Likeness: a casual viewer recognizes the uploaded face at default settings.
2. Convergence robustness: no plateau spam (thousands of near-zero-gain chords) on light images.
3. No visual artifacts: no rim-hugging dark ring, no banding/streaking from over-dark threads.
4. Feasible wall-clock: default pass count completes an animation of reasonable length (minutes,
   not hours) — real-world guides: 200 nails/1,500 lines = 6–10 h by hand (String Art Studio FAQ);
   an app animation must be far lighter.

## 3. Options considered (parameter values found, with sources)

### 3.1 Pin count

| Source | Pins | Notes |
|---|---|---|
| Petros Vrellis (originator, "A new way to knit", 2016) | **200** | 28-inch rim, 200 anchor pegs, 3,000–4,000 loops, 1–2 km thread — artof01.com/vrellis/works/knit.html; Hackaday 2016-07-28 |
| StringArt.jl (neumann-mlucas, Oct 2023) | 180 default | README advises "keep pins below 250, size below 1000" |
| kaspar98/StringArt (Python, 2020) | ~235 | nail_step=4 around 300 px circle → π·300/4 ≈ 235 |
| abhishekaudupa/computational-string-art (C) | 200 | MAX_NAIL_COUNT 200 |
| Possibly Wrong blog (2022-01-22) | 256 | meticulous write-up; notes Vrellis used 200 |
| akshatphumbhra/StringArt (Python) | 288 | parameters.py numHooks=288 |
| stringartgenerator.cc (commercial web tool) | 288 | landing page: "288 pins and 4000 lines" |
| prabinpebam/string-art (JS, browser) | **300** | README: "default 300" |
| string-art-generator.com/blog | 200–300 | "For detailed portraits: 200–300 pins" |

Convergence: implementations cluster 180–300. Nothing credible goes beyond ~300 for a circle
portrait; Grumpy Developer used 576–776 nails only for multi-circle/grid torture tests at 3278 px.
At our 600 px working res, 300 pins ⇒ arc spacing 600π/300 ≈ 6.3 px — near the aliasing floor for
1 px threads, so 500 pins adds compute, not likeness.

### 3.2 Pass/thread count

| Source | Passes/threads |
|---|---|
| Vrellis (2016) | **3,000–4,000** continuous loops |
| akshatphumbhra/StringArt | numStrings = **4000** |
| prabinpebam/string-art (JS) | numChords = **4000** default |
| stringartgenerator.cc | 4000 lines |
| string-art-generator.com | 2,000–3,000 recommended (their delta differs) |
| StringArt.jl | 1,000 default; "for sizes 500–800, 2000 is more than enough" (adaptive strength) |
| kaspar98/StringArt | uncapped — runs until 3 consecutive failed improvements |
| Possibly Wrong | 8,927 chords, but opaque 1 px thread at 4096² — different density regime |
| abhishekaudupa (C) | 600 (200 nails, additive-inverse model) |

### 3.3 Per-thread lightening delta (0–255 scale, constant-subtract model)

| Source | Delta | Context |
|---|---|---|
| kaspar98/StringArt | 0.05 normalized = **12.75** | at 300 px working res, image prescaled ×0.9; RGB mode 0.1 = 25.5 |
| grvlbit/stringart (Python) | **20** | self.weight=20, clamped at 0; 100 nails/1000 iters |
| prabinpebam/string-art (JS) | **20** | `errorArray[idx] = Math.max(errorArray[idx] - lineWeight, 0)` |
| StringArt.jl | base 25/100 → effective ≈ **25** at Gaussian center | line_strength=25, adaptively scaled ×0.5–2.0 toward target mean darkness 0.35 |
| Grumpy Developer | "useful values are around **30–100**" | at 3278 px res (1 px thread is relatively thinner) |
| akshatphumbhra/StringArt | full 255 (hard set) | opaque-thread model, 3000 px — different camp |
| Possibly Wrong; abhishekaudupa | no delta | opaque/additive-inverse models |

Key scaling insight (derived, first principles): what matters is darkening per pass per unit area
= (delta/255)·(threadWidth/canvasSize). kaspar98's 12.75 at 300 px ⇒ equivalent ≈ 25 at 600 px.
All constant-delta sources, normalized to our 600 px / 1 px-thread setup, land in **12–25**.
Band of good results ≈ 12–25; ≥30 risks banding/streaks, ≤8 goes muddy and needs 2× passes.

### 3.4 Minimum chord improvement threshold X

- kaspar98/StringArt: accept only if `best_cumulative_improvement > 0` (strict); initial best −99999.
- Possibly Wrong: stop "when that best average improvement is negative, that is, when we would make
  the image worse by continuing."
- abhishekaudupa: keep a thread only `if (error < initial_error)`.
- prabinpebam, grvlbit, StringArt.jl, bledxs: no threshold — pure argmax every pass.

Standard practice: X = 0 (any strictly positive summed darkness). No source uses a nonzero magic
number; plateau control is handled by stopping rules, not by inflating X.

### 3.5 Near-neighbor pin ignore rule

- akshatphumbhra/StringArt: `hookSkip = 30` — candidates run from curHook+31 to curHook+257 (of
  288), i.e., skips the 30 nearest pins in BOTH directions (~10% of the circle each way, min arc ≈ 39°).
- bledxs/string-art-generator (TS): "Skip nearby pins" = `Math.floor(pins.length * 0.1)` (10% of pins).
- StringArt.jl: geometric — chords shorter than `SMALL_CHORD_CUTOFF = 0.10` of canvas size are
  excluded ("short chords add near-zero signal"). At 180 pins/512 px that equals skipping ≈ 6 pins.
- prabinpebam (JS): not index-based; skips pins < 10 px away + a 20-pin recent-use history.
- kaspar98, grvlbit, Possibly Wrong, Grumpy Developer: no neighbor rule at all.

Conflict noted: brief hypothesized k ≈ 1–5; implementations that DO skip use larger values
(≈ n/30 geometric up to n/10 per side), and several good implementations skip none. Skipping too
little admits near-tangent rim-hugging chords; skipping 10%-of-pins (akshat, bledxs) is aggressive
and costs rim detail.

### 3.6 Stopping rules

- Fixed pass budget only: akshatphumbhra (4000), prabinpebam (4000 or break when no valid chord),
  grvlbit (1000 or residual ≤ 0), abhishekaudupa (600), Grumpy Developer (max-iterations param).
- Convergence only: kaspar98 — stop after **3 consecutive failed improvements** (improvement ≤ 0).
- Hybrid/adaptive: StringArt.jl — warmup restart + EMA stall detection (RESTART_EMA_ALPHA=0.05,
  restart when gain < 30% of initial, min 20 steps apart); Possibly Wrong — stop when best average
  improvement < 0.

### 3.7 Preprocessing that materially affects recognition (FLAG for RQ4 — not decided here)

- Greyscale weights 0.2989/0.5870/0.1140 (kaspar98; prabinpebam 0.3/0.59/0.11) — standard luma.
- Target prescale ×0.9 (kaspar98 `orig_pic = rgb2gray(img)*0.9`) — leaves headroom so even the
  lightest background retains a little "wanted darkness"; prevents dead never-woven regions.
- Contrast shaping: akshatphumbhra sigmoid k=13 around midpoint 0.5; StringArt.jl per-channel
  histogram equalization + TARGET_MEAN_DARK = 0.35 (adaptive strength targets mean darkness 0.35);
  string-art-generator.com practice for portraits: contrast +35%, brightness −10%.
- Gamma 2.2 suggested in Possibly Wrong comments; author measured negligible difference.
  CIEDE2000 perceptual weighting: "so little difference". Edge-enhance (grvlbit) — likely
  counterproductive for portraits (boosts noise).
- Cross-thread Gaussian weighting GAUSS5 = (0.06, 0.24, 0.40, 0.24, 0.06) in StringArt.jl —
  weights a thread's center line above its edges when scoring/subtracting. Refinement option for
  T3 (nice-to-have, not default). Spatial subject/center weighting in the image: no source does it.

## 4. Recommendation — committed candidate

```js
// src/engine.js — default config (single source of truth for T3)
export const DEFAULT_ENGINE_CONFIG = {
  pinCount: 300,          // UI knob "Pins": 200–500 (default 300; diminishing returns > ~400 at 600 px)
  maxPasses: 4000,        // UI knob "Coverage": 1000–8000 (default 4000; Vrellis + 3 tools agree)
  lighteningDelta: 20,    // UI knob "Darkness": 4–32 on 0–255; subtract once per covered pixel, clamp at 0
  neighborSkip: 'auto',   // resolves to Math.max(1, Math.round(pinCount / 30)) => 10 at 300 pins
                           // UI knob "Min chord gap" (advanced): 0–25 pins; skip k nearest pins BOTH directions
  minImprovement: 0,      // accept a chord only if its summed darkness > 0 (X = 0, evidence standard)
  convergenceFails: 3,    // secondary stop: bail after 3 consecutive passes with no positive-improvement chord
};
// Stopping = BOTH: primary hard cap maxPasses; secondary convergence stop (consecutive fails >= 3).
// Speed knob lives in T4 (animation only, never affects the sequence): 0.5×–16× + pause + instant.
```

Rationale:
- **300 pins / 4000 passes** is the exact default pair of a working browser JS implementation
  (prabinpebam/string-art), matches the commercial web tool (stringartgenerator.cc: 288/4000), and
  brackets the originator's real-world 200 pins / 3,000–4,000 loops. Scope's ~300/~4,000 is
  validated, not invented.
- **Delta 20** is the only value evidenced at (or near) our exact configuration: prabinpebam ships
  300 pins + 4000 chords + weight 20 as a matched set; kaspar98's 12.75-at-300 px rescales to ≈ 25
  at 600 px; StringArt.jl's adaptive strength centers ≈ 25. First-principles check (derived):
  600 px circle ≈ 283k px, mean wanted darkness ≈ 0.35 ⇒ ≈ 99k darkness units; mean greedy chord
  ≈ 320 px ⇒ 320·(20/255) ≈ 25 units/thread ⇒ ≈ 4,000–5,000 threads to converge. The three knobs
  are mutually calibrated; change one and the others drift.
- **neighborSkip = n/30** (= 10 at 300 pins, min central angle 12°, min chord ≈ 10% of diameter)
  reproduces StringArt.jl's geometric 10%-of-canvas cutoff exactly, while staying well under the
  aggressive 10%-of-pins camp (akshat 30, bledxs 30). Expressed in pins so T3 stays resolution-free.
- **X = 0 + 3-fail stop**: matches kaspar98 and Possibly Wrong; the convergence stop — not a raised
  threshold — is what prevents plateau spam. A raised X would silently starve light images.
- **Both stopping rules**: budget gives a predictable animation/counter; convergence stop protects
  light/low-contrast inputs from thousands of zero-gain rim chords.

## 5. Evidence (links / repos / constants / dates)

All accessed 2026-08-27.
1. Petros Vrellis, "A new way to knit" — https://artof01.com/vrellis/works/knit.html (2016):
   200 pegs, 28-inch rim, 3,000–4,000 loops, 1–2 km thread, >2 billion calculations. Corroborated by
   https://hackaday.com/2016/07/28/computer-designed-portraits-knit-by-hand/ ("200 choices × 3,000–4,000 passes").
2. prabinpebam/string-art — https://github.com/prabinpebam/string-art (JS/browser): README defaults
   300 pins, 4000 chords; string-art.js: `lineWeight = 20`, `errorArray[idx] = Math.max(errorArray[idx] - lineWeight, 0)`,
   skip pins < 10 px + 20-pin history, stop on fixed count or `bestPin === -1`.
3. kaspar98/StringArt — https://github.com/kaspar98/StringArt (2020): nail_step=4 (≈235 pins at
   LONG_SIDE=300), strength 0.05 (=12.75/255), `if best_cumulative_improvement <= 0: fails++`,
   `if fails >= 3: break`, `orig_pic = rgb2gray(img)*0.9`, no neighbor rule.
4. akshatphumbhra/StringArt — https://github.com/akshatphumbhra/StringArt: parameters.py numHooks=288,
   numStrings=4000, hookSkip=30, contrast=13 (sigmoid k), size=3000, line weight = full 255 whitening.
5. StringArt.jl — https://github.com/neumann-mlucas/StringArt.jl (Oct 2023): pins=180, steps=1000,
   size=512 defaults; README guidance "pins < 250", "2000 is more than enough" at 500–800 px;
   src/StringArt.jl: line_strength=25 scaled by `clamp(0.35/mean_dark, 0.5, 2.0)`,
   SMALL_CHORD_CUTOFF=0.10, GAUSS5=(0.06,0.24,0.40,0.24,0.06), histogram equalization.
6. grvlbit/stringart — https://github.com/grvlbit/stringart: nails=100, iterations=1000, weight=20,
   stop when residual sum ≤ 0; edge-enhance preprocessing.
7. abhishekaudupa/computational-string-art — https://github.com/abhishekaudupa/computational-string-art
   (C): MAX_NAIL_COUNT=200, max_loop_count=600, additive-inverse darkening (510−d−s), accept iff error decreases.
8. Possibly Wrong, "String art" — https://possiblywrong.wordpress.com/2022/01/22/string-art/
   (2022-01-22): 256 pins, ~8,927 chords (opaque 1 px model, 4096² canvas), stop when best average
   improvement < 0; gamma 2.2 negligible; cites Birsak et al. 2018 "String Art: Towards Computational
   Fabrication of String Images" (https://www.researchgate.net/publication/322766118).
9. Grumpy Developer, "Creating an algorithm for string art" —
   https://contentnation.net/en/grumpydevelop/stringart: lineColor "useful values around 30–100",
   path-reuse penalty 1, max-iterations stop, no neighbor rule (pre-Feb-2024 multithread update).
10. bledxs/string-art-generator — https://github.com/bledxs/string-art-generator (TS web):
    stringArtEngine.ts skips `Math.floor(pins.length * 0.1)` nearby pins; per-line darkness =
    `params.lineOpacity * 50`; no threshold; fixed line budget.
11. stringartgenerator.cc (commercial): "288 pins and 4000 lines" — https://stringartgenerator.cc/.
12. string-art-generator.com blog — https://string-art-generator.com/blog/best-string-art-generator-online-free:
    "detailed portraits: 200–300 pins", 2,000–3,000 threads starting point, portrait prep
    contrast +35% / brightness −10%.
13. String Art Studio FAQ — https://stringartstudio.com/faq: real-world winding 200 nails/1,500
    lines = 6–10 h; 300 nails = 15–20 h (feasibility anchor for RQ3).

Conflicts (noted):
- Delta camps: constant-subtract (kaspar98 12.75@300px, grvlbit 20, prabinpebam 20) vs
  opaque/additive (akshatphumbhra 255, abhishekaudupa, Possibly Wrong). T3's spec is the
  constant-subtract camp, so defaults were drawn only from that camp, rescale-normalized to 600 px.
- Neighbor skip: 4 repos skip none; skippers use n/30 (geometric) to n/10 per side. Resolved at
  n/30 (geometric rationale: it equals a hard chord-length floor, independent of pin density).
- Pin count: artists/academics favor 180–256; web tools favor 288–300. Scope's 300 kept (validated
  by prabinpebam at exactly 300) with the range capped at 500 and a "diminishing returns > 400" note.

## 6. Tradeoffs + risks + confidence

- Delta too high (≥25–30): threads saturate pixels early → visible streaks/banding, coarse
  midtones, engine converges before 4,000 passes (animation ends early looking "stringy").
- Delta too low (≤8): needs 6,000–8,000 passes to reach the same darkness → slow, and with the
  4,000 cap the portrait stays under-woven ("muddy/light"). Delta, passes, and pin count are a
  calibrated triple — expose all three as knobs so users can re-tune coherently.
- neighborSkip too high (>15 at 300 pins): loses rim detail, hollow ring around the face.
  Too low (0–2): near-tangent chords pile up on the circumference → dark rim halo.
- minImprovement > 0 tempting but harmful on light images (starves them of chords); keep 0 and rely
  on the 3-fail convergence stop.
- 500 pins at 600 px: pin arc ≈ 3.8 px ⇒ adjacent chords nearly parallel and sub-thread-width →
  moiré risk; acceptable knob ceiling but not a good default.
- Risks: delta 20 is calibrated, not visually verified on OUR 600 px pipeline — T8's mean-pixel-error
  metric should confirm; if final images are systematically too light, raise delta to 24 or extend
  coverage to 5,000 (one-line change, single constant). Light/low-contrast inputs remain RQ4's job.
- Confidence: **high** on pin count, pass count, stopping rules (originator + 3 independent
  implementations + 1 commercial tool converge); **moderate-high** on delta (constant-subtract camp
  converges 12–25 after resolution normalization; exact 20 vs 16 vs 24 is a tuning band);
  **moderate** on neighborSkip (practice diverges; n/30 is a reasoned midpoint).

## 7. Implementation consequences for T3 (+ pre-start knob ranges)

Config shape: a single frozen `DEFAULT_ENGINE_CONFIG` object exported from `src/engine.js`
(pinCount, maxPasses, lighteningDelta, neighborSkip ('auto' | number, resolved internally to
`Math.max(1, Math.round(pinCount/30))` when 'auto'), minImprovement, convergenceFails). Engine is
pure: takes {Float32Array circle, diameter, config} → {pinSequence, passesUsed, stopReason:
'budget' | 'converged'}.
Stopping logic: loop while `passes < maxPasses`; each pass evaluate all candidate chords to pins
beyond neighborSkip in both directions; accept best if `score > minImprovement`, subtract
lighteningDelta from every covered pixel (clamp ≥ 0); else increment fail counter; bail when
`fails >= convergenceFails`. Score = summed remaining darkness over the chord's pixel list (length
normalization NOT needed — summed, not averaged; averaging biases long chords, per kaspar98's
cumulative-improvement framing vs prabinpebam's average debate in bledxs comments).
Pre-start UI knobs (ranges): Pins 200–500 (default 300) · Coverage 1,000–8,000 passes
(default 4,000) · Darkness 4–32 (default 20) · Min chord gap 0–25 pins (default auto=10) ·
Speed 0.5×–16× + pause + instant (animation-only, T4). Advanced knobs (gap, darkness) may default
collapsed to keep the showpiece lean.
Unit tests required by T3 acceptance: converges on dark blob, deterministic, delta applied exactly
once per covered pixel per pass, clamped at 0, neighborSkip excludes k nearest pins on both sides,
stopReason correct for both 'budget' and 'converged' paths.

## 8. Flags to other tracks

- RQ4 (owns normalization): the materially-effective levers found were target prescale ×0.9
  (kaspar98), sigmoid k≈13 mid 0.5 (akshatphumbhra), histogram equalization + target mean darkness
  0.35 (StringArt.jl), practical contrast +35%/brightness −10%. Gamma 2.2 and perceptual metrics
  measured negligible. GAUSS5 center-weighted subtraction is an optional T3 refinement.
- RQ3 (physical mapping): Vrellis real-world anchor — 28-inch/200-pin board consumes 1–2 km per
  3,000–4,000 loops; at 300 pins/4,000 passes expect ≥ 1–2 km equivalents.
- T8: log mean-pixel-error at defaults; tuning tripwire: if error plateaus > ~18/255 mean abs,
  test delta 24 / 5,000 passes before shipping.
