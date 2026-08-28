# RQ4 — Greyscale contrast normalization: when and how

- **Decision priority:** P1 (feeds T2 ingest/preprocessing; mitigates T3 risk "plateau on light images")
- **Affected tasks:** T2 (ingest + crop — where normalization runs), T3 (greedy engine — plateau
  mitigation), T8 (QA harness — log normalization stats as evidence)
- **Status:** committed candidate (auto-committed per plan research-queue disposition)
- **Delegation record:** deep-research track agent (ZCode), 2026-08-27

## Question

When and how should greyscale contrast normalization be applied so weak/light/low-contrast uploads
still produce good weaves WITHOUT harming already-good inputs? Sub-questions:
1. Always normalize, or only conditionally?
2. Which method: percentile linear stretch, histogram equalization, CLAHE, or gamma?
3. Does blur/denoise or downscale-aware sampling matter at ~600 px working resolution?
4. Exact acceptance check: what input statistics trigger (or skip) normalization?

## Constraints and evaluation criteria

- Robust: weak/washed/light inputs weave well; good inputs pass through unharmed (ideally bit-exact).
- Deterministic (acceptance criterion 8: same image + settings → identical result). No RNG, no
  async, no floating-point ordering hazards; integer histogram → LUT is fully reproducible.
- Dependency-free, vanilla JS, cheap: operates on a Uint8/Uint8ClampedArray or Float32Array in
  O(N) with N ≈ 600×600 ≈ 360k pixels; must fit T2's pipeline budget trivially.
- Monotonic mapping preferred: tonal ordering must be preserved for likeness (acceptance criterion
  5 — human side-by-side check against original).
- No new user-facing knob required (lean MVP; town-hall scope locks knobs at 3–4 pre-start ones).

## Options considered

| Option | Fit | Risks |
|---|---|---|
| **Conditional percentile linear stretch (2nd→98th)** | O(N) two-pass + 256-LUT; monotonic; outlier-robust; canonical in scikit-image's own equalization example; canonical in HIPR2; bounded (clips to 0–255) | Mild clipping of 2% darkest/lightest pixels when applied; needs flat-image guard (below) |
| Histogram equalization (global) | Cheap, deterministic | Non-linear remap to uniform histogram — "artificial-looking" results (HIPR2); amplifies noise in near-uniform regions (OpenCV CLAHE docs: noise in small tiles "will be amplified"; Dragonfly docs: over-amplifies noise in near-uniform regions); destroys linear tonal relationships → hurts side-by-side likeness |
| CLAHE | Best local contrast; clips noise amplification | Heaviest (tiling + clip + bilinear interp), ~100+ lines and 2–3 extra parameters; local adaptation turns flat backgrounds into "texture" → greedy would burn thread into empty background; overkill for an MVP |
| Gamma correction | Cheap, smooths midtones | Fixes brightness bias, not dynamic-range compression; cannot map a narrow histogram to full range; wrong tool for the actual failure mode |
| Min–max stretch (0th→100th) | Simplest | HIPR2: "a single outlying pixel with either a very high or low value can severely affect the scaling" — JPEG specks / specular dots wreck it |
| Otsu threshold (as Xunius/string_art does) | Good for binary masks | We are not thresholding; greedy darkness-sum needs continuous tones — reject |

## Recommendation (default method + trigger)

**Conditional 2nd–98th percentile linear stretch over the crop-circle pixels only**, with a
flat-image guard. Concretely:

1. After decode → high-quality downscale → circular crop, build a 256-bin histogram over
   in-circle pixels only (pixels the engine will actually see; outside-circle pixels would
   corrupt percentiles — e.g., white letterboxing around a dark photo).
2. Find `p2` (smallest value with cumulative ≥ 2% of N) and `p98` (≥ 98% of N).
3. **Skip** if `p98 − p2 ≥ 200` (≈ 78% of full scale): input already has good range; passthrough
   is bit-exact — this is the "no harm to good inputs" guarantee.
4. **Skip** if `p98 − p2 < 24` (≈ 10% of scale): near-constant image; stretching would amplify
   sensor/JPEG noise at > ~10× gain with no real structure to weave. Greedy plateau is handled by
   T3 stopping rules instead (skimage's degenerate case: constant input just clips to output range
   — we make the guard explicit and logged).
5. Otherwise **stretch**: `out = clamp((v − p2) · 255 / (p98 − p2), 0, 255)` via a 256-entry LUT.
6. Return stats `{applied, p2, p98, range}` for T8 logging.

Rationale: linear stretch "can only apply a linear scaling function… the enhancement is less
harsh" than equalization and preserves relative grey-level intensities (HIPR2); percentile bounds
fix the outlier failure of min–max (HIPR2 lunar example: full-range min/max made normalization "no
effect" until 1%/99% cutoffs were used); the 2/98 pair is the canonical published default
(scikit-image contrast-stretching example). For the engine specifically: with a washed input
(range ~100 of 255), chord darkness differences are small relative to the per-thread lightening
delta; stretching multiplies contrast (≈ 2.5×) before the greedy loop, directly mitigating the T3
"plateau on light images" risk. On trigger statistics (not method): every surveyed generator that
normalizes does so by range/max rescaling, never by equalization (Xunius normalizes by max;
Lili does no contrast step at all).

### Reference implementation (~28 lines, vanilla JS, no deps)

```js
const P_LO = 0.02, P_HI = 0.98;   // percentiles (skimage-canonical 2/98)
const MIN_RANGE = 24;             // flat guard: skip below (~10% of scale)
const GOOD_RANGE = 200;           // already good: skip (bit-exact passthrough)

// gray: Uint8Array of in-circle luma pixels, length N (post crop, pre Float32Array)
export function normalizeContrast(gray, N) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) hist[gray[i]]++;
  const loCut = N * P_LO, hiCut = N * P_HI;
  let acc = 0, p2 = 0, p98 = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loCut) { p2 = v; break; } }
  acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= hiCut) { p98 = v; break; } }
  const range = p98 - p2;
  if (range < MIN_RANGE || range >= GOOD_RANGE)
    return { applied: false, p2, p98, range };
  const lut = new Uint8ClampedArray(256);   // clamps to 0..255 automatically
  const scale = 255 / range;
  for (let v = 0; v < 256; v++) lut[v] = (v - p2) * scale;
  for (let i = 0; i < N; i++) gray[i] = lut[gray[i]];
  return { applied: true, p2, p98, range };
}
```

Deterministic: integer histogram, exact cumulative cuts, single LUT — same input yields identical
output on every run in the same browser. (Cross-browser decode/color-management may shift pixels
by ±1 pre-existing; that variance is upstream of this step and run-to-run determinism holds.)

### Answers to the four sub-questions

1. **Conditionally, not always.** Trigger on measured dynamic range (`p98 − p2`). Always-on would
   slightly clip 2% of tones in every good input for no gain; conditional keeps good inputs
   bit-exact while rescuing weak ones.
2. **Percentile linear stretch (2/98)** — cheapest fully-deterministic monotonic option; equalize/
   CLAHE distort tonal relationships and can over-amplify noise; gamma doesn't fix range.
3. **Downscale quality: yes. Blur/denoise: no (flag only).**
   - Resampling quality matters: one-step downscale from a 3000–4000 px upload to ~600 px with
     default `low` smoothing risks aliasing/moiré (hair, fabric) that feeds bogus darkness. Use
     `createImageBitmap(blob, { imageOrientation: 'from-image', resizeQuality: 'high' })` —
     `imageOrientation: 'from-image'` is the documented EXIF-safe default (MDN, Window:
     createImageBitmap) — and/or draw with `ctx.imageSmoothingQuality = 'high'`. Both surveyed
     pipelines that resize treat filter quality as a real step (Xunius uses `Image.ANTIALIAS`;
     Michael Crum downsamples to thread-diameter pixels as part of the model).
   - Explicit blur is NOT needed by default: greedy chord scoring sums darkness over ~100+ pixel
     chords (plan's own architecture numbers), an inherent area average that suppresses pixel
     noise; Xunius blurs (Gaussian σ=2 at 400 px) only because it thresholds via Otsu, which is
     noise-sensitive — we don't threshold; callummcdougall recommends blur for importance
     weightings, not the source image; Michael Crum's "blur" is a perception-model downscale.
     Flag: if T8 QA shows artifacting on grainy phone photos, an optional 3×3 box blur (~10 lines,
     1 pass) can be added — not in the default path (lean MVP).
4. **Acceptance check (exact):** with N = in-circle pixel count, trigger normalization iff
   `24 ≤ p98 − p2 < 200`; skip (log stats) otherwise. Skip reasons: `range < 24` → flat/noise
   guard; `range ≥ 200` → already-good passthrough.

## Evidence (primary sources, consulted 2026-08-27)

- **scikit-image exposure example** (equalization vs stretching, docs 0.21.x):
  https://scikit-image.org/docs/0.21.x/auto_examples/color_exposure/plot_equalize.html —
  canonical percentile stretch: `p2, p98 = np.percentile(img, (2, 98)); rescale_intensity(img,
  in_range=(p2, p98))`; presented as the less-harsh alternative to equalization.
- **skimage `rescale_intensity` API** (stable docs): https://scikit-image.org/docs/stable/api/skimage.exposure.html —
  stretch/shrink semantics, clipping behavior; constant input degenerates to clipping (motivates
  explicit flat guard).
- **HIPR2, Contrast Stretching** (Edinburgh): https://homepages.inf.ed.ac.uk/rbf/HIPR2/stretch.htm —
  min–max stretch outlier failure ("a single outlying pixel… severely affect the scaling");
  percentile cutoffs as robust fix; stretching "less harsh" than equalization, equalization
  "yields an artificial-looking result"; narrow-histogram behavior.
- **OpenCV histogram equalization / CLAHE tutorial** (4.x):
  https://docs.opencv.org/4.x/d5/daf/tutorial_py_histogram_equalization.html — noise in
  small-tile AHE "will be amplified"; CLAHE clips bins (default limit 40) + bilinear interp —
  confirms equalization-family noise risk and CLAHE's complexity.
- **MDN, Window: createImageBitmap**: https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap —
  `resizeQuality`: `pixelated|low(default)|medium|high`; `imageOrientation` default `from-image`
  ("oriented according to EXIF orientation metadata, if present") — EXIF-safe decode + quality
  resize in one call, zero deps.
- **Xunius/string_art** (Python, GitHub): https://github.com/Xunius/string_art — pipeline:
  grayscale → resize width 400 with `Image.ANTIALIAS` → Gaussian blur σ=2 → invert → Otsu
  threshold ×0.8 → normalize by max (`img/img.max()`) → circle mask. Evidence that (a) quality
  resampling is standard, (b) blur is tied to thresholding (we don't threshold), (c) their
  normalization is range-based (max), not equalization.
- **fjzll/StringArtGeneratorLili** (TypeScript web app, GitHub):
  https://github.com/fjzll/StringArtGeneratorLili — `src/lib/algorithms/imageProcessor.ts`:
  pipeline is cropToSquare (via `drawImage`) → `convertToGrayscale` (weighted R/G/B luma) →
  circular mask. **No contrast normalization at all** — an existence proof that a web string-art
  tool can ship without it, and a gap our conditional step fills.
- **Michael Crum, "Generalized String Art Generator"** (2023):
  https://michael-crum.com/string_art_generator/ — downscales so 1 pixel = thread diameter; a
  second downscale-by-d acts as perceptual blur; no contrast step. Supports downscale-as-part-of-
  model, not blur-as-denoise.
- **Possibly Wrong, "String art"** (2022-01-22):
  https://possiblywrong.wordpress.com/2022/01/22/string-art/ — greedy over pre-existing 8-bit
  greyscale P5 input; no preprocessing (input assumed prepared).
- **callummcdougall/computational-thread-art** (GitHub README + LessWrong writeup):
  https://github.com/callummcdougall/computational-thread-art — user-side guidance: 400×400
  suffices, good inputs have "good tonal range", bad ones "low contrast"; blur recommended for
  importance weightings, not the source image; darkness 150–200 per line.
- **Dragonfly docs** (contrast filters): https://www.theobjects.com/dragonfly/dfhelp/3-5/Content/05_Image%20Processing/Contrast%20Adjustment%20Filters.htm —
  global HE "over-amplif[ies] noise in near-uniform regions".

## Tradeoffs and confidence

- Deliberate low-key/high-key photos (true range < 200 but intentional, e.g. highlights at 120)
  will be auto-stretched, doubling contrast vs the original — defensible for likeness-driven
  weaving (and "view original" toggle preserves the reference), but purists may object. A manual
  override knob was considered and rejected: lean-MVP scope; revisit only if user feedback demands.
- 2% tails are clipped when stretch fires: acceptable (specular highlights/void blacks saturate
  gracefully via clamp).
- Thresholds 24/200 are informed defaults (HIPR2 percentile practice; scale-relative rationale),
  not measured optima — T8 should log `{applied, p2, p98, range}` and flag any image class where
  the trigger misfires; tuning is a constant change, not a redesign.
- Cross-browser bit-differences in decode are upstream and pre-existing; run-to-run determinism
  (criterion 8) is unaffected.
- **Confidence: HIGH** on method family and pipeline position (multiple independent primary
  sources agree: linear/range normalization when normalizing at all; equalization family rejected
  for noise/tonal reasons; quality resampling standard). **MEDIUM** on exact threshold values
  (24 / 200) pending T8 evidence.

## Implementation consequences for T2

Pipeline order (confirms plan): **decode (EXIF-safe `createImageBitmap`, `imageOrientation:
'from-image'`) → downscale to ~600 px (`resizeQuality: 'high'` or draw with
`imageSmoothingQuality: 'high'`) → circular draggable crop → circle-mask pixel set → conditional
percentile stretch (over in-circle pixels ONLY) → Float32Array emit**. Notes:
- Normalization must run AFTER circle crop and BEFORE Float32Array conversion; it must exclude
  out-of-circle pixels from the histogram.
- Keep it a pure function (Uint8Array + N in, stats out) — unit-testable like T3: constant array
  (skip), full-range array (bit-exact skip), washed array (applied, endpoints 0/255).
- Return `{applied, p2, p98, range}` up to the QA/dev panel for T8 evidence logging.
- ~28 lines, no dependencies, ~2 passes over 360k pixels (< 5 ms class on modern hardware) — no
  measurable impact on the < 2 s time-to-first-thread budget.
- No blur module in default build; leave a code comment pointing to the optional 3×3 box blur
  flag for T8 follow-up only.
