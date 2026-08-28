// Thread Art — weave canvas renderer (T4; ink model revised by FL-1).
//
// Owns the persistent ("accumulated") loom canvas: a warm paper ground,
// subtly marked pins, and anti-aliased ~1 px black thread segments drawn
// pin-to-pin ON TOP of everything drawn before — there is deliberately NO
// per-frame clear or redraw, because the accumulating thread crossings ARE
// the artwork. The canvas backing store is the working resolution (the
// engine's circle diameter), so 1 canvas px == 1 engine px and the ~0.3 mm
// black polyester thread maps to ~1 px of line width (rq3 physical note);
// the browser scales the canvas to its CSS box.
//
// Pin geometry comes from the engine's own documented math (pinPositions
// with the default radius) — renderer and chord tables can never disagree
// about where a pin is.
//
// ── FL-1 matched ink ───────────────────────────────────────────────────
// The engine's model subtracts lighteningDelta from each covered pixel per
// crossing; the canvas must darken by the SAME amount per crossing or the
// optimized pattern and the displayed image diverge (the likeness defect:
// opaque strokes darkened ~111/255 per crossing vs the model's 20/255, so
// the display saturated while the model believed it was 97% done). Threads
// are therefore stroked at a CALIBRATED ALPHA (threadAlphaForDelta255):
//   alpha = regionalFactor · (delta/255) / (kappa/255)
// measured against real headless-Chrome rasterization
// (docs/ultron/research/likeness-evidence/calibration.json):
//   kappa = 110.76/255 — mean luma drop over a chord's Bresenham footprint
//   for one OPAQUE crossing from paper; regionalFactor = 0.7 — the lab-
//   measured optimum compensating the band ink an opaque AA stroke deposits
//   beside the model's 1 px footprint (likeness lab, stage tune).
// The knob thus maps linearly to visible per-crossing darkening, and tone
// emerges from crossing density (Vrellis-style) instead of saturating.
//
// Sub-segment drawing: drawSegmentPortion(a, b, t0, t1) strokes only the
// [t0, t1] slice of the a→b chord with BUTT caps — consecutive slices of
// the same chord are collinear, so butt caps tile with no overlap, which
// matters now that strokes are translucent (round caps would double-ink a
// 1 px disc at every frame seam). Full segments (drawSegment / replay) use
// ROUND caps for the pin-wrap look. The FINAL canvas always comes from the
// one-shot replay(): paper + pins + every full segment exactly once — a
// pure function of the pass sequence, independent of speed, pauses, frame
// timing, or reduced-motion stepping (a stepped drain may transiently
// double-draw one in-flight segment; the completion replay erases that).

import { pinPositions, DEFAULT_ENGINE_CONFIG } from "./engine.js";

const PAPER = "#f5f0e4"; // warm paper ground (visual polish is T10's pass)
const THREAD = "#15120d"; // the black ~0.3 mm polyester thread
const PIN_FILL = "rgba(38, 32, 24, 0.38)"; // subtle pin marks under the thread
const PIN_RADIUS = 1.1;

// Real-canvas ink calibration (FL-1; measured via CDP against this exact
// stroke geometry — lineWidth 1, round caps, this thread/paper pair).
export const THREAD_INK = Object.freeze({
  kappa255: 110.76, // opaque per-crossing mean drop over the Bresenham footprint
  regionalFactor: 0.7, // band-ink compensation (likeness-lab measured optimum)
});

// Stroke alpha whose per-crossing mean darkening over a chord's footprint
// matches the engine's lighteningDelta (0–255 knob scale).
export function threadAlphaForDelta255(delta255) {
  const a = ((delta255 / 255) / (THREAD_INK.kappa255 / 255)) * THREAD_INK.regionalFactor;
  return Math.min(1, Math.max(0.004, a));
}

export function createWeaveRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  let pins = null; // Float64Array [x0, y0, x1, y1, …] — engine pin positions
  let diameter = 0;
  let threadAlpha = threadAlphaForDelta255(
    Math.round(DEFAULT_ENGINE_CONFIG.lighteningDelta * 255)
  );

  function paintGround() {
    ctx.globalAlpha = 1;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, diameter, diameter);

    ctx.fillStyle = PIN_FILL;
    for (let i = 0; i < pins.length / 2; i++) {
      ctx.beginPath();
      ctx.arc(pins[i * 2], pins[i * 2 + 1], PIN_RADIUS, 0, 2 * Math.PI);
      ctx.fill();
    }

    // FL-1: translucent thread ink matched to the engine's delta (see header).
    ctx.globalAlpha = threadAlpha;
    ctx.strokeStyle = THREAD;
    ctx.lineWidth = 1; // ~0.3 mm thread at working resolution (rq3)
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  return {
    // Reset the loom for a fresh weave: sizes the backing store to the
    // working resolution, paints the paper, marks the pins. Called on every
    // Start, which is also what guarantees a restart leaves no stale ink.
    // opts.threadAlpha overrides the delta-matched default (main.js passes
    // the run's actual darkness knob so the ink follows the knob linearly).
    init(newDiameter, pinCount, opts = {}) {
      diameter = newDiameter;
      canvas.width = diameter; // assigning width clears the canvas
      canvas.height = diameter;
      pins = pinPositions(diameter, pinCount);
      if (Number.isFinite(opts.threadAlpha) && opts.threadAlpha > 0 && opts.threadAlpha <= 1) {
        threadAlpha = opts.threadAlpha;
      }
      paintGround();
    },

    // The active thread ink (0–1 stroke alpha) — QA/harness visibility.
    get threadAlpha() {
      return threadAlpha;
    },

    // Deterministic final repaint from the canonical pass sequence (Int16Array
    // of (fromPin, toPin) pairs): paper + pins + every full segment, in
    // order, exactly once each. Called ONCE at completion (never per frame).
    //
    // Why: during the animation, segments are drawn as speed-dependent
    // partial portions, and overlapping anti-aliased stroke seams accumulate
    // sub-pixel alpha slightly differently depending on speed/pauses/frame
    // timing — visually identical, but not bit-identical. This repaint makes
    // the FINAL canvas a pure function of the sequence, so worker path,
    // fallback path, any speed, any pause pattern all end on the same pixels
    // (and a T7 replay reproduces them exactly).
    replay(seq) {
      paintGround();
      ctx.lineCap = "round";
      for (let i = 0; i + 1 < seq.length; i += 2) {
        this.drawSegment(seq[i], seq[i + 1]);
      }
    },

    // Full pin-to-pin thread segment (the accumulated form; T6/T7 may use
    // this to replay the final canvas). Round caps: the thread wraps the pin.
    drawSegment(a, b) {
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(pins[a * 2], pins[a * 2 + 1]);
      ctx.lineTo(pins[b * 2], pins[b * 2 + 1]);
      ctx.stroke();
    },

    // Partial pin-to-pin segment for 0 ≤ t0 < t1 ≤ 1 — the animation unit.
    // Butt caps: consecutive collinear slices tile exactly, so translucent
    // ink accumulates once per covered pixel (no seam beads).
    drawSegmentPortion(a, b, t0, t1) {
      const ax = pins[a * 2];
      const ay = pins[a * 2 + 1];
      const bx = pins[b * 2];
      const by = pins[b * 2 + 1];
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0);
      ctx.lineTo(ax + (bx - ax) * t1, ay + (by - ay) * t1);
      ctx.stroke();
    },
  };
}
