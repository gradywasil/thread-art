// Thread Art — pre-start weave knobs (T6; ranges committed in RQ2 §7).
//
// Owns the crop stage's settings region: the three committed pre-start knobs
//   • Pins            200–500   (default 300, step 10)
//   • Coverage        1000–8000 passes (default 4,000, step 100)
//   • Darkness        4–32 on the 0–255 scale (default 8, step 1; FL-1)
// plus the optional ADVANCED min-chord-gap control (0–25 pins, default
// "auto" = max(1, round(pinCount / 30)) — the RQ2 resolution, = 10 at 300
// pins). The gap is folded into a collapsed <details> so the showpiece
// surface stays lean (RQ2: "Advanced knobs may default collapsed").
//
// Every control is a native <input type="range"> — keyboard-operable for
// free (arrows step, Home/End jump, PageUp/PageDown page) — with a live
// <output> value label. The ENGINE only sanity-checks inputs (T3's resolveConfig
// deliberately does not know the UI ranges), so THIS module is the single
// place that clamps/snaps to ENGINE_KNOBS before a config reaches the
// scheduler at Start.
//
// Knob values persist across journeys (crop → weave → complete → reweave /
// start over): they are the user's tuning preference, and "Weave again with
// new settings" expects to find them where they were left. Defaults are the
// frozen RQ2 values on first load only.

import { ENGINE_KNOBS, DEFAULT_ENGINE_CONFIG, autoNeighborSkip } from "./engine.js";
import { formatGrouped } from "./stats.js";

// Snap a raw value onto a knob's step grid inside [min, max].
function snap(value, { min, max, step }) {
  const stepped = min + Math.round((value - min) / step) * step;
  return Math.min(max, Math.max(min, stepped));
}

export function createKnobController({
  pins,
  pinsValue,
  passes,
  passesValue,
  delta,
  deltaValue,
  gap,
  gapValue,
  gapAuto,
}) {
  const ranges = {
    pins: { input: pins, out: pinsValue, knob: ENGINE_KNOBS.pinCount },
    passes: { input: passes, out: passesValue, knob: ENGINE_KNOBS.maxPasses },
    delta: { input: delta, out: deltaValue, knob: ENGINE_KNOBS.lighteningDelta255 },
    gap: { input: gap, out: gapValue, knob: ENGINE_KNOBS.neighborSkip },
  };
  // Step sizes are a UI choice (RQ2 fixes only min/max/default): coarse
  // enough to hit exact values with a mouse, fine enough to matter.
  const steps = { pins: 10, passes: 100, delta: 1, gap: 1 };

  function current(name) {
    const { input, knob } = ranges[name];
    return snap(Number(input.value), { min: knob.min, max: knob.max, step: steps[name] });
  }

  // Visual only (T10): the custom range track paints its filled portion from
  // a --fill percentage custom property. Kept in sync here, where every value
  // change already flows through.
  function paintFill(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const v = Number(input.value);
    const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--fill", `${pct.toFixed(2)}%`);
  }

  function renderPins(v) {
    pinsValue.textContent = formatGrouped(v);
  }

  function renderPasses(v) {
    passesValue.textContent = `${formatGrouped(v)} threads`;
  }

  function renderDelta(v) {
    deltaValue.textContent = `${v} / 255`;
  }

  function renderGap() {
    if (gapAuto.checked) {
      gapValue.textContent = `auto · ${autoNeighborSkip(current("pins"))} pins`;
    } else {
      gapValue.textContent = `${gap.value} pins`;
    }
  }

  function bind(name, onChange) {
    const { input } = ranges[name];
    input.addEventListener("input", () => {
      const v = current(name); // clamped + snapped whatever the DOM reports
      if (String(v) !== input.value) input.value = String(v);
      paintFill(input);
      onChange(v);
    });
    paintFill(input);
  }

  bind("pins", (v) => {
    renderPins(v);
    renderGap(); // the auto gap follows the pin count
  });
  bind("passes", renderPasses);
  bind("delta", renderDelta);
  bind("gap", renderGap);

  gapAuto.addEventListener("change", () => {
    gap.disabled = gapAuto.checked;
    if (!gapAuto.checked) {
      // Start manual editing from the current auto value, not from zero.
      gap.value = String(autoNeighborSkip(current("pins")));
    }
    paintFill(gap);
    renderGap();
  });

  // Initial paint (HTML carries the RQ2 defaults; this makes it true even if
  // the markup drifts).
  renderPins(current("pins"));
  renderPasses(current("passes"));
  renderDelta(current("delta"));
  renderGap();

  return {
    // The engine config for the next Start (RQ2 domain translation: the
    // darkness knob's 0–255 value becomes lighteningDelta = knob/255).
    getConfig() {
      const pinCount = current("pins");
      return {
        pinCount,
        maxPasses: current("passes"),
        lighteningDelta: current("delta") / 255,
        neighborSkip: gapAuto.checked ? "auto" : snap(Number(gap.value), { ...ENGINE_KNOBS.neighborSkip, step: steps.gap }),
      };
    },

    // Human/QA view of the knobs (255-scale delta, as RQ2 states it).
    describe() {
      return {
        pinCount: current("pins"),
        maxPasses: current("passes"),
        lighteningDelta255: current("delta"),
        neighborSkip: gapAuto.checked ? `auto (${autoNeighborSkip(current("pins"))})` : Number(gap.value),
      };
    },

    focus() {
      pins.focus();
    },
  };
}

// Defaults re-exported for tests/QA (the RQ2 single source of truth lives in
// engine.js; this is the expected first-load describe() shape).
export const KNOB_DEFAULTS = Object.freeze({
  pinCount: DEFAULT_ENGINE_CONFIG.pinCount,
  maxPasses: DEFAULT_ENGINE_CONFIG.maxPasses,
  lighteningDelta255: Math.round(DEFAULT_ENGINE_CONFIG.lighteningDelta * 255),
  neighborSkip: `auto (${autoNeighborSkip(DEFAULT_ENGINE_CONFIG.pinCount)})`,
});
