// Thread Art — weave canvas renderer (T4).
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
// Sub-segment drawing: drawSegmentPortion(a, b, t0, t1) strokes only the
// [t0, t1] slice of the a→b chord. The stroke is fully opaque, so repeated
// extension of the same segment is idempotent (no darkening artifacts) —
// that is what makes the cheap "thread pulling tight" animation possible:
// the anim layer advances the tip a little each frame, and the FINAL canvas
// is exactly the union of all full segments, independent of frame timing.

import { pinPositions } from "./engine.js";

const PAPER = "#f5f0e4"; // warm paper ground (visual polish is T10's pass)
const THREAD = "#15120d"; // the black ~0.3 mm polyester thread
const PIN_FILL = "rgba(38, 32, 24, 0.38)"; // subtle pin marks under the thread
const PIN_RADIUS = 1.1;

export function createWeaveRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  let pins = null; // Float64Array [x0, y0, x1, y1, …] — engine pin positions
  let diameter = 0;

  function paintGround() {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, diameter, diameter);

    ctx.fillStyle = PIN_FILL;
    for (let i = 0; i < pins.length / 2; i++) {
      ctx.beginPath();
      ctx.arc(pins[i * 2], pins[i * 2 + 1], PIN_RADIUS, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.strokeStyle = THREAD;
    ctx.lineWidth = 1; // ~0.3 mm thread at working resolution (rq3)
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  return {
    // Reset the loom for a fresh weave: sizes the backing store to the
    // working resolution, paints the paper, marks the pins. Called on every
    // Start, which is also what guarantees a restart leaves no stale ink.
    init(newDiameter, pinCount) {
      diameter = newDiameter;
      canvas.width = diameter; // assigning width clears the canvas
      canvas.height = diameter;
      pins = pinPositions(diameter, pinCount);
      paintGround();
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
      for (let i = 0; i + 1 < seq.length; i += 2) {
        this.drawSegment(seq[i], seq[i + 1]);
      }
    },

    // Full pin-to-pin thread segment (the accumulated form; T6/T7 may use
    // this to replay the final canvas).
    drawSegment(a, b) {
      ctx.beginPath();
      ctx.moveTo(pins[a * 2], pins[a * 2 + 1]);
      ctx.lineTo(pins[b * 2], pins[b * 2 + 1]);
      ctx.stroke();
    },

    // Partial pin-to-pin segment for 0 ≤ t0 < t1 ≤ 1 — the animation unit.
    drawSegmentPortion(a, b, t0, t1) {
      const ax = pins[a * 2];
      const ay = pins[a * 2 + 1];
      const bx = pins[b * 2];
      const by = pins[b * 2 + 1];
      ctx.beginPath();
      ctx.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0);
      ctx.lineTo(ax + (bx - ax) * t1, ay + (by - ay) * t1);
      ctx.stroke();
    },
  };
}
