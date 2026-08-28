// Thread Art — completion state (T6).
//
// Owns the #stage-complete region: the finished portrait (a pixel copy of the
// loom canvas, which lives in the hidden weave stage), the "view original"
// TOGGLE (a simple show/hide of the uploaded portrait in place of the woven
// canvas — explicitly NOT a compare slider, per the town-hall non-goals),
// the stats summary, and the two restart actions.
//
// Stats reuse ./stats.js exports verbatim (T5's follow-up): the rq3
// display-time mapping (feetFromEuclidPx / metersFromEuclidPx over the
// engine's canonical totalThreadEuclidPx), formatFeetMeters (feet primary,
// meters secondary) and the BOARD_LABEL assumption line. The numbers shown
// here are therefore bit-identical to the weave stage's completion line.
//
// "View original": the original canvas is drawn from the crop stage's
// working-resolution canvas — the EXIF-correct, downscaled, un-normalized
// color photo — sampling exactly the woven circle (cropOffset + diameter
// from the T2 ingest output), so the toggle compares like for like.

import {
  feetFromEuclidPx,
  metersFromEuclidPx,
  formatFeetMeters,
  formatGrouped,
  BOARD_LABEL,
} from "./stats.js";

export function createCompleteController({
  canvas, // woven portrait display canvas
  originalCanvas, // the uploaded portrait, circle region
  caption,
  toggle,
  lengthValue,
  detail,
  note,
  reweave,
  restart,
  onReweave,
  onRestart,
}) {
  const wovenCtx = canvas.getContext("2d");
  const originalCtx = originalCanvas.getContext("2d");

  function setView(showOriginal) {
    canvas.hidden = showOriginal;
    originalCanvas.hidden = !showOriginal;
    toggle.setAttribute("aria-pressed", showOriginal ? "true" : "false");
    toggle.textContent = showOriginal ? "View woven" : "View original";
    caption.textContent = showOriginal ? "The original photo" : "Woven from a single thread";
  }

  toggle.addEventListener("click", () => {
    setView(toggle.getAttribute("aria-pressed") !== "true");
  });

  reweave.addEventListener("click", () => {
    if (onReweave) onReweave();
  });
  restart.addEventListener("click", () => {
    if (onRestart) onRestart();
  });

  return {
    // Paint the completion state from the finished run. Call once per run,
    // right before the complete stage becomes visible.
    //   loom:       the weave-stage canvas (already replayed to its final form)
    //   original:   { canvas, x, y, size } — source working canvas + circle
    //               bounding box (T2 ingest's cropOffset/diameter)
    //   summary:    { pinCount, passesUsed, stopReason, euclidPx, diameterPx }
    show({ loom, original, summary }) {
      const d = summary.diameterPx;
      canvas.width = d; // assigning width clears any previous run's art
      canvas.height = d;
      wovenCtx.drawImage(loom, 0, 0);

      originalCanvas.width = d;
      originalCanvas.height = d;
      originalCtx.drawImage(original.canvas, original.x, original.y, d, d, 0, 0, d, d);

      const feet = feetFromEuclidPx(summary.euclidPx, d);
      const meters = metersFromEuclidPx(summary.euclidPx, d);
      // Matches stats.js's finalLine and download.js's txt header verbatim.
      const why =
        summary.stopReason === "converged"
          ? "stopped early, with nothing left worth weaving"
          : "full thread budget";
      lengthValue.textContent = formatFeetMeters(feet, meters);
      detail.textContent =
        `${formatGrouped(summary.pinCount)} pins · ${formatGrouped(summary.passesUsed)} threads · ${why}`;
      note.textContent = `thread length measured pin-to-pin · assumes a ${BOARD_LABEL}`;

      setView(false); // always open on the woven portrait
    },

    // Clear everything (Start over with a new image): no stale art, stats or
    // toggle state may survive into the next journey.
    reset() {
      canvas.width = 1;
      canvas.height = 1;
      originalCanvas.width = 1;
      originalCanvas.height = 1;
      lengthValue.textContent = "";
      detail.textContent = "";
      note.textContent = "";
      setView(false);
    },
  };
}
