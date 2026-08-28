// Thread Art — downloads (T7): the two completion-state artifacts.
//
//   • "Download PNG" — the final woven canvas as a PNG blob (the completion
//     canvas is a pixel-for-pixel copy of the loom AFTER the one-time
//     deterministic replay, so the PNG is a pure function of the woven
//     sequence — worker path, fallback path, any speed, any pause pattern all
//     export identical bytes for one sequence).
//   • "Download pin sequence (.txt)" — the stats header per RQ3 (pins,
//     threads, total feet + meters from the SAME stats.js mapping/number
//     formatting as the live counters and the completion summary, the board
//     assumption line, the thread spec line, the laid-vs-spool honesty note,
//     and the knob values used) followed by the numbered pin-to-pin winding
//     order EXACTLY as drawn — one thread per line, "1. 214 → 89".
//
// Honesty/determinism rules:
//   • The txt is a pure function of the completed run (config + engine stats
//     + sequence). No timestamps, no image names — the worker and fallback
//     paths weave bit-identical sequences, so they must produce byte-identical
//     txt files (T4/T5/T6 proved the sequence, totals and canvas identical).
//   • Feet/meters reuse ./stats.js verbatim (feetFromEuclidPx /
//     metersFromEuclidPx over the engine's canonical totalThreadEuclidPx,
//     formatFeetMeters feet-primary/meters-secondary) — the txt numbers are
//     bit-identical to the completion summary the user just read.
//   • Board/thread phrasing follows research/rq3-physical-mapping.md §"TXT
//     header phrasing (T7)" verbatim.
//
// Mechanics: both artifacts go through Blob → URL.createObjectURL → a
// transient <a download> click → revokeObjectURL on the next macrotask (the
// standard pattern; revoking synchronously can break Safari downloads). No
// network, nothing leaves the tab.

import {
  feetFromEuclidPx,
  metersFromEuclidPx,
  formatFeetMeters,
  formatGrouped,
} from "./stats.js";
import { autoNeighborSkip } from "./engine.js";

// rq3 txt-header phrasing (single source of truth for T7).
export const BOARD_ASSUMPTION_LINE =
  "Assumes a 24 in (60 cm) board; length = sum of thread segments × scale.";
export const THREAD_SPEC_LINE =
  "Thread: black polyester sewing thread, ~0.3 mm.";
export const SPOOL_NOTE_LINE =
  "Length counts thread laid pin-to-pin; a real spool uses slightly more (wrap at pins).";

export const PNG_FILENAME = "thread-art.png";
export const TXT_FILENAME = "thread-art-pin-sequence.txt";

// The download payload assembled from a COMPLETED run (see main.js's
// weaveComplete → lastRun). Returns null when the run lacks final engine
// stats or a sequence (e.g. clicked mid-weave — impossible from the complete
// stage, but click-time defensive).
export function artworkFromRun(run) {
  if (!run || !run.stats || !run.seq || run.seq.length < 2) return null;
  const config = run.config || {};
  return {
    pinCount: config.pinCount,
    maxPasses: config.maxPasses,
    lighteningDelta255: Math.round((config.lighteningDelta || 0) * 255),
    neighborSkip: config.neighborSkip, // "auto" | number
    passesUsed: run.stats.passesUsed,
    stopReason: run.stats.stopReason, // "budget" | "converged"
    euclidPx: run.stats.totalThreadEuclidPx,
    diameterPx: run.input ? run.input.diameter : 0,
    seq: run.seq, // Int16Array of (fromPin, toPin) pairs, emission order
  };
}

function describeGap(artwork) {
  return artwork.neighborSkip === "auto"
    ? `auto (${autoNeighborSkip(artwork.pinCount)}) pins`
    : `${artwork.neighborSkip} pins`;
}

// The plain-text artifact: header block (stats + the weave settings actually
// used) then the winding order, one thread per line. Pure — no DOM access.
export function buildSequenceText(artwork) {
  if (!artwork) return "";
  const d = artwork.diameterPx;
  const feet = feetFromEuclidPx(artwork.euclidPx, d);
  const meters = metersFromEuclidPx(artwork.euclidPx, d);
  const why = artwork.stopReason === "converged" ? "converged early" : "full pass budget";

  const lines = [];
  const title = "Thread Art — pin winding order";
  lines.push(title, "=".repeat(title.length), "");
  lines.push("Stats");
  lines.push(`Pins: ${formatGrouped(artwork.pinCount)}`);
  lines.push(`Threads: ${formatGrouped(artwork.passesUsed)} of ${formatGrouped(artwork.maxPasses)} (${why})`);
  lines.push(`Thread length: ${formatFeetMeters(feet, meters)}`);
  lines.push(`Darkness: ${artwork.lighteningDelta255} / 255`);
  lines.push(`Min chord gap: ${describeGap(artwork)}`);
  lines.push(BOARD_ASSUMPTION_LINE);
  lines.push(THREAD_SPEC_LINE);
  lines.push(SPOOL_NOTE_LINE);
  lines.push("");
  lines.push("Winding order — one thread per line: thread number, from pin → to pin");
  const seq = artwork.seq;
  for (let i = 0; i + 1 < seq.length; i += 2) {
    lines.push(`${i / 2 + 1}. ${seq[i]} → ${seq[i + 1]}`);
  }
  lines.push(""); // trailing newline (POSIX-friendly)
  return lines.join("\n");
}

// Save a Blob as a client-side download. Returns the object URL (revoked on
// the next macrotask — synchronously revoking can break Safari's download).
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return url;
}

export function downloadText(text, filename = TXT_FILENAME) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  saveBlob(blob, filename);
  return blob;
}

// Export a canvas as PNG. Resolves with the PNG Blob (or null if encoding
// was refused — effectively impossible for a valid canvas).
export function downloadCanvasPng(canvas, filename = PNG_FILENAME) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      saveBlob(blob, filename);
      resolve(blob);
    }, "image/png");
  });
}

// Completion-state wiring (T7): owns the two download buttons. Native
// <button>s — keyboard-operable for free; both live inside #stage-complete,
// so they are only reachable when a finished portrait is on screen.
// getArtwork() is consulted at CLICK time (a hidden-stage click cannot
// happen, and a null artwork no-ops defensively).
export function createDownloadController({ canvas, pngButton, seqButton, getArtwork }) {
  const log = []; // QA/T8 instrumentation (NOT load-bearing for the app)

  function record(entry) {
    log.push(entry);
    if (log.length > 50) log.shift();
  }

  pngButton.addEventListener("click", () => {
    const artwork = getArtwork();
    if (!artwork) return;
    downloadCanvasPng(canvas, PNG_FILENAME).then((blob) => {
      record({
        kind: "png",
        filename: PNG_FILENAME,
        ok: Boolean(blob),
        bytes: blob ? blob.size : 0,
        at: Math.round(performance.now()),
      });
    });
  });

  seqButton.addEventListener("click", () => {
    const artwork = getArtwork();
    if (!artwork) return;
    const text = buildSequenceText(artwork);
    const blob = downloadText(text, TXT_FILENAME);
    record({
      kind: "txt",
      filename: TXT_FILENAME,
      ok: blob.size > 0,
      bytes: blob.size,
      threads: artwork.passesUsed,
      at: Math.round(performance.now()),
    });
  });

  return {
    getLog() {
      return log.slice();
    },
  };
}
