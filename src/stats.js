// Thread Art — live counters (T5, committed RQ3 physical mapping).
//
// The weave stage's honest, ticking stats: a feet-of-thread counter and a
// passes counter, as plain accessible live text plus a subtle hairline
// progress bar. No fake numbers anywhere on the path:
//
//   • The engine accumulates the CANONICAL per-pass Euclidean chord length
//     (Σ sqrt(dx²+dy²) over rounded pin px) in emission order — exported as
//     totalThreadEuclidPx. This module accumulates the SAME sum, in the SAME
//     order (the animation draws passes in emission order), over the SAME
//     rounded integer pin coordinates (pinPositions + Math.round, exactly
//     buildTables' pinPx) — so the drawn counter and the engine total are
//     bit-identical f64 sums. The counter therefore ticks with what the
//     user SEES laid on the loom (drawn threads), not with compute-ahead
//     progress: at 1× the worker finishes all 4,000 passes in ~0.6 s while
//     the animation drains for ~67 s, and the counters must follow the
//     thread, not the CPU.
//   • The physical scale is applied AT DISPLAY TIME ONLY (rq3): the stored
//     geometry stays in virtual px, and
//       feet = Σ euclid_px × (0.6096 / virtual_diameter_px) × 3.28084
//     assumes a 24 in (60.96 cm) board. virtual_diameter_px is the working
//     circle diameter (the loom canvas / engine size, i.e. the whole virtual
//     "board"; the pin ring sits 2 px inside its rim by the engine's
//     defaultRadius). Resizing the display can never corrupt the total.
//   • Feet is PRIMARY in the live counter (rq3); meters appear secondary in
//     stats contexts (the completion line + the helpers exported for T6/T7).
//
// DOM writes are throttled to ~10 Hz (the accumulation is per-pass and
// exact; only the rendering is throttled), so a 16× weave does not turn
// into 960 text updates per second.
//
// Screen-reader announcements are throttled MUCH harder (T9): the visible
// counters live OUTSIDE the aria-live region and tick visually at 10 Hz,
// while a single visually-hidden node inside the polite live region is
// written only on PHASE CHANGES and 25%-progress milestones (plus the final
// line at completion) — a screen reader following the weave hears a handful
// of updates per run, never a burst per second.

import { pinPositions } from "./engine.js";

// ── rq3 physical constants (single source of truth for T5/T6/T7) ─────────
export const BOARD_DIAMETER_M = 0.6096; // assumed board: 24 in (60.96 cm)
export const BOARD_LABEL = "24 in (61 cm) board";
export const FEET_PER_METER = 3.28084;

// ft per virtual px for a given working-circle diameter.
export function feetPerPx(virtualDiameterPx) {
  return (BOARD_DIAMETER_M / virtualDiameterPx) * FEET_PER_METER;
}

// m per virtual px (computed directly from the px sum — never feet ÷ 3.28084
// — so feet and meters are both exact mappings of one canonical number).
export function metersPerPx(virtualDiameterPx) {
  return BOARD_DIAMETER_M / virtualDiameterPx;
}

export function feetFromEuclidPx(euclidPx, virtualDiameterPx) {
  return euclidPx * feetPerPx(virtualDiameterPx);
}

export function metersFromEuclidPx(euclidPx, virtualDiameterPx) {
  return euclidPx * metersPerPx(virtualDiameterPx);
}

// Deterministic integer grouping: 5093 → "5,093". Hand-rolled so every
// browser/locale renders the counter identically (the app is locale-free).
export function formatGrouped(value) {
  return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// "5,093 ft (1,552 m)" — feet primary, meters secondary (rq3 stats phrasing).
export function formatFeetMeters(feet, meters) {
  return `${formatGrouped(feet)} ft (${formatGrouped(meters)} m)`;
}

// Rounded integer pin coordinates — exactly buildTables' pinPx (the engine's
// totalThreadEuclidPx is computed over these integers).
export function roundedPinPx(size, pinCount) {
  const pins = pinPositions(size, pinCount); // default radius, like the scheduler
  const out = new Int32Array(pins.length);
  for (let i = 0; i < pins.length; i++) out[i] = Math.round(pins[i]);
  return out;
}

// Euclidean chord length in px between two pins (rounded coordinates).
export function euclidChordPx(pinPx, a, b) {
  const dx = pinPx[b * 2] - pinPx[a * 2];
  const dy = pinPx[b * 2 + 1] - pinPx[a * 2 + 1];
  return Math.sqrt(dx * dx + dy * dy);
}

const RENDER_INTERVAL_MS = 100; // DOM write throttle (matches T4's status cadence)

// ── live counter region controller ────────────────────────────────────────
// Owns the #weave-counters region: hero feet counter, passes counter,
// progress bar, phase line. Elements are looked up once by main.js and
// handed in; the controller is created once and re-begun per run.
// `announce` is the visually-hidden node inside the aria-live="polite"
// wrapper — the ONLY node announced to screen readers (see header).
export function createLiveCounters({ feetValue, passesValue, track, fill, status, announce }) {
  let pinPx = null;
  let scaleFt = 0;
  let scaleM = 0;
  let diameterPx = 0; // remembered from begin() — scheduler stats don't carry it
  let drawn = 0; // threads fully laid (animation order)
  let totalPasses = 0; // denominator: configured budget, then passesUsed once known
  let euclidPx = 0; // Σ Euclidean chord px over DRAWN passes (engine-parity)
  let phase = "preparing"; // preparing | weaving | finishing | done
  let mode = null; // "worker" | "fallback"
  let finalStats = null; // scheduler's onDone stats
  let lastRenderAt = -Infinity;
  let lastAnnouncement = ""; // dedupe — never re-announce identical text
  let lastMilestone = -1; // last announced 25% milestone index (0…4)

  // Screen-reader announcement (T9): phase changes + 25% milestones + the
  // final line. Written only when the text actually changes.
  function announceText(text) {
    if (!announce || text === lastAnnouncement) return;
    lastAnnouncement = text;
    announce.textContent = text;
  }

  function maybeAnnounceMilestone() {
    if (phase === "done" || totalPasses <= 0) return;
    const m = Math.floor(progress() * 4); // 0…4 in 25% steps
    if (m <= lastMilestone || m < 1 || m > 3) return; // 100% is the final line
    lastMilestone = m;
    announceText(
      `${m * 25}% woven — ${formatGrouped(drawn)} of ${formatGrouped(totalPasses)} threads · ` +
        `${formatGrouped(euclidPx * scaleFt)} ft of thread`
    );
  }

  function progress() {
    return totalPasses > 0 ? Math.min(1, drawn / totalPasses) : 0;
  }

  function finalLine() {
    if (!finalStats) return null;
    const feet = finalStats.totalThreadEuclidPx * scaleFt;
    const meters = finalStats.totalThreadEuclidPx * scaleM;
    const why = finalStats.stopReason === "converged" ? "converged" : "full budget";
    return `${formatFeetMeters(feet, meters)} of thread · ${formatGrouped(finalStats.passesUsed)} threads · ${why}`;
  }

  function renderStatus() {
    // Visual only (T10): the phase drives the status line's live gold dot in
    // styles.css. Text content is untouched (announcements/QA read text).
    if (status && status.dataset) status.dataset.phase = phase;
    if (phase === "preparing") {
      status.textContent = "Preparing the loom…";
    } else if (phase === "weaving") {
      status.textContent = `Weaving · ${mode === "worker" ? "worker thread" : "main thread"}`;
    } else if (phase === "finishing") {
      status.textContent = `Finishing — laying the last ${formatGrouped(Math.max(0, totalPasses - drawn))} threads`;
    } else {
      const line = finalLine();
      if (line) status.textContent = line;
    }
  }

  function renderCounters() {
    lastRenderAt = performance.now();
    feetValue.textContent = formatGrouped(euclidPx * scaleFt);
    passesValue.textContent = `${formatGrouped(drawn)} / ${formatGrouped(totalPasses)}`;
    if (track && fill) {
      track.setAttribute("aria-valuemax", String(totalPasses));
      track.setAttribute("aria-valuenow", String(drawn));
      fill.style.transform = `scaleX(${progress().toFixed(4)})`;
    }
  }

  function render() {
    renderCounters();
    renderStatus();
  }

  return {
    // Fresh run: reset everything and prime the scale from the working
    // circle diameter (the rq3 virtual board) + the run's pass budget.
    begin({ diameterPx: d, pinCount, totalPasses: passes }) {
      if (!(d > 0)) throw new RangeError(`diameterPx must be > 0 (got ${d})`);
      diameterPx = d;
      pinPx = roundedPinPx(d, pinCount);
      scaleFt = feetPerPx(diameterPx);
      scaleM = metersPerPx(diameterPx);
      drawn = 0;
      totalPasses = passes;
      euclidPx = 0;
      phase = "preparing";
      mode = null;
      finalStats = null;
      lastRenderAt = -Infinity;
      lastMilestone = -1;
      render();
      announceText("Preparing the loom");
    },

    noteStarted(runMode) {
      mode = runMode;
      if (phase === "preparing") phase = "weaving";
      renderStatus();
      announceText(`Weaving started · ${mode === "worker" ? "worker thread" : "main thread"}`);
    },

    // One thread fully laid on the loom (from the animation, in emission
    // order) — accumulate the canonical Euclidean chord and tick the DOM at
    // a human cadence. Monotonic by construction.
    notePass(fromPin, toPin) {
      if (!pinPx) return;
      euclidPx += euclidChordPx(pinPx, fromPin, toPin);
      drawn += 1;
      if (performance.now() - lastRenderAt >= RENDER_INTERVAL_MS) {
        renderCounters();
        if (phase === "finishing") renderStatus(); // the "last N threads" count ticks too
      }
      maybeAnnounceMilestone();
    },

    // Scheduler finished computing: the true thread total is now known. If
    // it converged under the budget, the denominator becomes the actual
    // count so the counter can honestly reach "N / N".
    noteComputed(stats) {
      finalStats = stats;
      if (stats && stats.passesUsed > 0) totalPasses = stats.passesUsed;
      phase = "done"; // for the status line's benefit if already drained…
      if (drawn < totalPasses) phase = "finishing"; // …but normally the animation still drains
      render();
      if (phase === "finishing") {
        announceText(`Pattern computed — laying the last ${formatGrouped(totalPasses - drawn)} threads`);
      }
      maybeAnnounceMilestone();
    },

    // Weave complete (animation drained): show the engine's canonical final
    // values (bit-identical to the drawn accumulation — parity is exposed
    // via getSummary for QA/T8).
    finish() {
      if (finalStats) {
        euclidPx = finalStats.totalThreadEuclidPx;
        drawn = finalStats.passesUsed;
      }
      phase = "done";
      render();
      const line = finalLine();
      if (line) announceText(`Weave complete — ${line}`);
    },

    reset() {
      phase = "preparing";
      mode = null;
      finalStats = null;
      drawn = 0;
      euclidPx = 0;
      totalPasses = 0;
      render();
    },

    getSummary() {
      return {
        phase,
        mode,
        drawn,
        totalPasses,
        euclidPxDrawn: euclidPx,
        feet: Math.floor(euclidPx * scaleFt),
        meters: Math.floor(euclidPx * scaleM),
        engineEuclidPx: finalStats ? finalStats.totalThreadEuclidPx : null,
        parity:
          finalStats === null
            ? null
            : {
                euclidPxMatchesEngine: Math.abs(euclidPx - finalStats.totalThreadEuclidPx) < 1e-6,
                drawnMatchesEngine: drawn === finalStats.passesUsed,
              },
      };
    },
  };
}
