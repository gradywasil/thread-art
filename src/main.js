// Thread Art — application entry (T1 scaffold + T2 crop + T4 weave journey +
// T6 pre-start knobs and completion state).
//
// Loaded as a deferred ES module by the bootstrap in index.html whenever the
// page is served over http(s). Vanilla ES modules, no build step; all paths
// are relative so the folder works from any static server or subpath.
//
// This module owns: stage switching for the journey (Land → Upload → Crop →
// Weaving → Complete), the drop-zone wiring (file picker + drag-and-drop +
// optional paste), the visible error states, and the transition into the
// crop stage. File validation logic lives in ./upload.js; the ingest
// pipeline (decode → downscale → circle crop → normalize → emit) in
// ./ingest.js; the draggable circle in ./crop.js; the weave computation
// scheduler (worker + fallback) in ./compute.js; the canvas renderer in
// ./render.js; the rAF animation in ./anim.js; the live counters (feet of
// thread, passes, progress) in ./stats.js; the pre-start weave knobs (RQ2
// ranges → engine config) in ./knobs.js; the completion state (stats
// summary, view-original toggle, restart actions) in ./complete.js; the
// completion downloads (PNG + pin-sequence txt) in ./download.js.

import { pickImageFile, readImageFile, releaseImage } from "./upload.js";
import { prepareWorkingImage, emitCropOutput } from "./ingest.js";
import { createCropController } from "./crop.js";
import { hashSequence } from "./engine.js";
import { createWeaveScheduler } from "./compute.js";
import { createWeaveRenderer, threadAlphaForDelta255 } from "./render.js";
import { createWeaveAnimation, SPEED_STEPS } from "./anim.js";
import { createLiveCounters, formatGrouped } from "./stats.js";
import { createKnobController } from "./knobs.js";
import { createCompleteController } from "./complete.js";
import { createDownloadController, artworkFromRun } from "./download.js";

const el = {
  dropZone: document.getElementById("drop-zone"),
  dropZoneLabel: document.getElementById("drop-zone-label"),
  pickButton: document.getElementById("pick-button"),
  fileInput: document.getElementById("file-input"),
  errorRegion: document.getElementById("error-region"),
  errorTitle: document.getElementById("error-title"),
  errorMessage: document.getElementById("error-message"),
  errorDismiss: document.getElementById("error-dismiss"),
  cropFrame: document.getElementById("crop-frame"),
  cropCanvas: document.getElementById("crop-canvas"),
  cropCircle: document.getElementById("crop-circle"),
  cropMeta: document.getElementById("crop-meta"),
  startButton: document.getElementById("start-button"),
  cropReplace: document.getElementById("crop-replace"),
  knobPins: document.getElementById("knob-pins"),
  knobPinsValue: document.getElementById("knob-pins-value"),
  knobPasses: document.getElementById("knob-passes"),
  knobPassesValue: document.getElementById("knob-passes-value"),
  knobDelta: document.getElementById("knob-delta"),
  knobDeltaValue: document.getElementById("knob-delta-value"),
  knobGap: document.getElementById("knob-gap"),
  knobGapValue: document.getElementById("knob-gap-value"),
  knobGapAuto: document.getElementById("knob-gap-auto"),
  completeCanvas: document.getElementById("complete-canvas"),
  originalCanvas: document.getElementById("original-canvas"),
  completeCaption: document.getElementById("complete-caption"),
  completeToggle: document.getElementById("complete-toggle"),
  completeLength: document.getElementById("complete-length"),
  completeDetail: document.getElementById("complete-detail"),
  completeNote: document.getElementById("complete-note"),
  completeReweave: document.getElementById("complete-reweave"),
  completeRestart: document.getElementById("complete-restart"),
  downloadPng: document.getElementById("download-png"),
  downloadSeq: document.getElementById("download-seq"),
  loomCanvas: document.getElementById("loom-canvas"),
  completeStage: document.getElementById("stage-complete"),
  weaveHeading: document.getElementById("weave-heading"),
  completeHeading: document.getElementById("complete-heading"),
  weavePause: document.getElementById("weave-pause"),
  weaveSpeeds: document.getElementById("weave-speeds"),
  weaveRestart: document.getElementById("weave-restart"),
  counterFeetValue: document.getElementById("counter-feet-value"),
  counterPassesValue: document.getElementById("counter-passes-value"),
  counterAnnouncement: document.getElementById("counter-announcement"),
  progressTrack: document.getElementById("progress-track"),
  progressFill: document.getElementById("progress-fill"),
  weaveStatus: document.getElementById("weave-status"),
};

const ERROR_TITLES = {
  missing: "No image found",
  empty: "That file is empty",
  unsupported: "That’s not a JPG, PNG or WebP",
  "too-large": "That image is too large",
  "too-small": "That image is too small",
  unreadable: "That image can’t be read",
};

const DROP_LABEL_DEFAULT = el.dropZoneLabel.textContent;

const state = {
  reading: false,
};

// ── Reduced motion (T9, criterion 11) ────────────────────────────────────
// The OS setting is watched LIVE: a mid-weave change swaps the animation
// between the rAF drain and the stepped finish on the next tick (anim.js);
// CSS transitions are handled by the styles.css media query. The sequence,
// stats and final canvas are identical either way — only the presentation
// differs (a ~1 s staged reveal instead of the ~67 s animation).
const reducedMotionQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

function reducedMotionActive() {
  return Boolean(reducedMotionQuery && reducedMotionQuery.matches);
}

if (reducedMotionQuery) {
  const applyReducedMotion = (event) => {
    if (weave && weave.anim) weave.anim.setReducedMotion(event.matches);
  };
  if (typeof reducedMotionQuery.addEventListener === "function") {
    reducedMotionQuery.addEventListener("change", applyReducedMotion);
  } else if (typeof reducedMotionQuery.addListener === "function") {
    reducedMotionQuery.addListener(applyReducedMotion); // older Safari
  }
}

const crop = createCropController({
  frame: el.cropFrame,
  canvas: el.cropCanvas,
  circle: el.cropCircle,
});

// Live counter region (T5): feet of thread (rq3 display-time mapping over
// the engine's canonical Euclidean chord sum), passes drawn, progress bar.
// The visually-hidden #counter-announcement node (T9) is the ONLY content
// of the aria-live wrapper — announcements are milestone-based, while the
// visible counters keep ticking visually at ~10 Hz outside the region.
const counters = createLiveCounters({
  feetValue: el.counterFeetValue,
  passesValue: el.counterPassesValue,
  track: el.progressTrack,
  fill: el.progressFill,
  status: el.weaveStatus,
  announce: el.counterAnnouncement,
});

// Pre-start weave knobs (T6): the RQ2 ranges, clamped here (the engine only
// sanity-checks) and resolved into the engine config at Start.
const knobs = createKnobController({
  pins: el.knobPins,
  pinsValue: el.knobPinsValue,
  passes: el.knobPasses,
  passesValue: el.knobPassesValue,
  delta: el.knobDelta,
  deltaValue: el.knobDeltaValue,
  gap: el.knobGap,
  gapValue: el.knobGapValue,
  gapAuto: el.knobGapAuto,
});

// Completion state (T6): finished portrait + stats + view-original toggle +
// the two restart paths. "Weave again" keeps the same image (the crop stage
// still holds it) and returns with the knobs editable; "Start over" is the
// full reset to the upload stage.
const completion = createCompleteController({
  canvas: el.completeCanvas,
  originalCanvas: el.originalCanvas,
  caption: el.completeCaption,
  toggle: el.completeToggle,
  lengthValue: el.completeLength,
  detail: el.completeDetail,
  note: el.completeNote,
  reweave: el.completeReweave,
  restart: el.completeRestart,
  onReweave() {
    endWeaveRun(); // completed runs are already torn down; this is belt-and-braces
    showStage("crop");
    knobs.focus();
  },
  onRestart() {
    backToUploadStage();
  },
});

// Completion downloads (T7): PNG of the finished portrait + the txt pin
// sequence. Both read the LAST completed run at click time; the woven
// #complete-canvas is the pixel-identical copy of the replayed loom.
const downloads = createDownloadController({
  canvas: el.completeCanvas,
  pngButton: el.downloadPng,
  seqButton: el.downloadSeq,
  getArtwork() {
    return artworkFromRun(lastRun);
  },
});

// Dev instrumentation for QA harnesses (T8): live crop state, last engine
// input, live/completed weave summary, the current knob settings, and
// long-task samples. Nothing here is required for the app to run.
window.__threadArtDebug = {
  get crop() {
    return crop.getCircle();
  },
  get reducedMotion() {
    return reducedMotionActive();
  },
  lastIngest: null,
  get weave() {
    return summarizeRun(weave || lastRun);
  },
  get knobs() {
    return knobs.describe();
  },
  get downloads() {
    return downloads.getLog();
  },
  longTasks: [],
};

try {
  if (typeof PerformanceObserver === "function") {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__threadArtDebug.longTasks.push({
          start: Math.round(entry.startTime),
          duration: Math.round(entry.duration),
        });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  }
} catch {
  /* longtask entries unsupported (e.g. Safari) — rAF deltas still collected */
}

// Minimal state switcher for the journey stages.
const STAGES = ["upload", "crop", "weave", "complete"];

function showStage(name) {
  for (const stage of STAGES) {
    document.getElementById(`stage-${stage}`).hidden = stage !== name;
  }
}

function showError(title, message, { dismissLabel = "Try another image", action = "pick" } = {}) {
  el.errorTitle.textContent = title;
  el.errorMessage.textContent = message;
  el.errorDismiss.textContent = dismissLabel;
  errorAction = action;
  el.errorRegion.hidden = false;
  el.errorDismiss.focus();
}

// What the error card's button does: "pick" reopens the file picker (upload
// errors), "settings" returns to the crop-stage controls (weave errors —
// same image + settings would fail identically, so the honest recovery is
// adjusting them, not re-picking).
let errorAction = "pick";

function clearError() {
  el.errorRegion.hidden = true;
  el.errorTitle.textContent = "";
  el.errorMessage.textContent = "";
}

// Escape dismisses a visible error region (T9) — the standard keyboard way
// out of an alert; the dismiss button stays the primary, focused affordance.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.errorRegion.hidden) clearError();
});

function setBusy(busy) {
  state.reading = busy;
  el.dropZone.classList.toggle("is-busy", busy);
  el.pickButton.disabled = busy;
  el.dropZoneLabel.textContent = busy ? "Reading image…" : DROP_LABEL_DEFAULT;
}

async function handleFileList(fileList) {
  if (state.reading) return;
  clearError();

  const file = pickImageFile(fileList);
  if (!file) {
    showError(
      ERROR_TITLES.missing,
      "Drop a JPG, PNG or WebP image file — folders and other kinds of files can’t be woven."
    );
    return;
  }

  setBusy(true);
  // T1 validation (readable-file check) — its <img> decode only proves the
  // file decodes; the ingest pipeline re-decodes the File itself. The
  // result's own reason/message reach the card (empty / unsupported /
  // too-large all have specific copy in ./upload.js).
  const result = await readImageFile(file);
  if (!result.ok) {
    setBusy(false);
    showError(ERROR_TITLES[result.reason] || ERROR_TITLES.unreadable, result.message);
    return;
  }
  releaseImage(result);

  // The paste listener is global, so a new image can arrive mid-weave — but
  // only a VALID one earns the teardown: tear the active run down here,
  // synchronously after all awaits and BEFORE the crop canvas is redrawn.
  // (Earlier would kill the weave for a file that fails anyway; later would
  // let a late completion hijack the new journey and pair the old weave with
  // the new image's "original" view. A completion that fires during the
  // decode above is self-consistent — the canvas still holds the old image.)
  const interruptedWeave = Boolean(weave);
  if (interruptedWeave) {
    endWeaveRun();
    completion.reset();
  }

  const prepared = await prepareWorkingImage(file, el.cropCanvas);
  if (prepared.ok) {
    enterCropStage(file, prepared);
    setBusy(false);
    return;
  }
  setBusy(false);
  if (prepared.reason === "too-small") {
    showError(
      ERROR_TITLES["too-small"],
      "After resizing for the loom, its short side comes out under 16 px — too small to seat the ring of pins. Try a larger photo."
    );
  } else {
    showError(
      ERROR_TITLES.unreadable,
      "It looks like an image, but the browser can’t decode it — the file may be corrupted or mislabeled."
    );
  }
  // A mid-weave paste that fails ingest has already torn the run down: the
  // old photo is still on the crop canvas, so return there to recover from.
  if (interruptedWeave && crop.isOpen) showStage("crop");
}

function enterCropStage(file, prepared) {
  crop.open(prepared.width, prepared.height);
  const circle = crop.getCircle();
  el.cropMeta.textContent =
    `${file && file.name ? file.name : "Pasted image"} · ` +
    `working at ${prepared.width} × ${prepared.height} px · crop ⌀ ${circle.d} px`;
  showStage("crop");
  el.startButton.focus({ preventScroll: true });
}

function backToUploadStage() {
  endWeaveRun();
  crop.close();
  completion.reset(); // no stale art, stats or toggle state may survive
  window.__threadArtDebug.lastIngest = null;
  clearError();
  showStage("upload");
  el.pickButton.focus({ preventScroll: true });
}

// ── Weave run (T4) ──────────────────────────────────────────────────────
// One active run at a time: scheduler (worker or fallback) feeds pass-record
// batches to the animation, the animation draws threads on the accumulated
// canvas at the user's speed, and completion switches to the complete state
// (T6: stats summary, view-original toggle, restart actions).

let weave = null; // active run object
let lastRun = null; // most recent run, kept readable for QA/T6/T7

function startWeave() {
  const output = emitCropOutput(el.cropCanvas, crop.getCircle());
  window.__threadArtDebug.lastIngest = output;
  beginWeaveRun(output);
}

function beginWeaveRun(output) {
  endWeaveRun(); // never two runs at once (also the mid-weave restart path)
  // Config comes from the pre-start knobs (T6), clamped to the RQ2 ranges by
  // the knob controller; lighteningDelta is already in the engine's 0..1
  // domain (knob's 0–255 value ÷ 255), neighborSkip is "auto" or a pin count.
  const config = knobs.getConfig();
  const k = knobs.describe();
  console.log(
    `[thread-art] weave config: pins ${k.pinCount} · passes ${k.maxPasses} · ` +
    `darkness ${k.lighteningDelta255}/255 · gap ${k.neighborSkip}`
  );
  const startedAt = performance.now();

  const renderer = createWeaveRenderer(el.loomCanvas);
  // FL-1: the thread ink follows the darkness knob — each laid thread
  // darkens its path by the amount the engine's model subtracted, so the
  // optimized pattern and the displayed canvas agree (see src/render.js).
  renderer.init(output.diameter, config.pinCount, {
    threadAlpha: threadAlphaForDelta255(k.lighteningDelta255),
  }); // fresh paper — no stale ink
  counters.begin({
    diameterPx: output.diameter, // the rq3 virtual board (display-time scale)
    pinCount: config.pinCount,
    totalPasses: config.maxPasses,
  });

  const run = {
    mode: null,
    ttftMs: null,
    hash: null,
    stats: null,
    counters: null,
    config, // the knobs' resolved engine config (completion summary + QA)
    input: output, // {diameter, cropOffset, …} — the completion's original view
    circle: crop.getCircle(), // {cx, cy, d} — the exact sampled circle (T8 dev metric)
    totalPasses: config.maxPasses,
    startedAt,
    completedAt: null,
    batches: [],
    renderer,
    anim: null,
    scheduler: null,
  };
  weave = run;

  run.anim = createWeaveAnimation({
    drawSegmentPortion: renderer.drawSegmentPortion,
    totalPasses: config.maxPasses, // sizes the reduced-motion stepped drain (T9)
    onFirstThread(at) {
      run.ttftMs = at - startedAt;
      console.log(`[thread-art] first thread after ${Math.round(run.ttftMs)} ms`);
    },
    // Counters tick with LAID thread (not computed passes): the pair is the
    // just-finished pass, in emission order.
    onPassDrawn(drawnCount, fromPin, toPin) {
      counters.notePass(fromPin, toPin);
    },
    onComplete: weaveComplete,
  });
  if (reducedMotionActive()) {
    run.anim.setReducedMotion(true);
    console.log("[thread-art] reduced motion: on — the weave will step to completion");
  }

  run.scheduler = createWeaveScheduler({
    onStarted(info) {
      run.mode = info.mode;
      console.log(
        `[thread-art] weave compute: ${info.mode}${info.tableReused ? " (chord tables reused)" : ""}`
      );
      counters.noteStarted(info.mode);
    },
    onBatch(batch) {
      run.batches.push(batch.seq);
      run.anim.push(batch.seq);
    },
    onDone(stats) {
      run.stats = stats;
      run.totalPasses = stats.passesUsed;
      counters.noteComputed(stats);
      run.anim.finish(); // completion fires when the animation has drained
      console.log("[thread-art] weave done:", {
        mode: stats.mode,
        passesUsed: stats.passesUsed,
        stopReason: stats.stopReason,
        totalChordPx: stats.totalChordPx,
        totalThreadEuclidPx: stats.totalThreadEuclidPx,
        computeMs: Math.round(stats.computeMs),
      });
    },
    onError(message) {
      weaveFailed(message);
    },
  });

  showStage("weave");
  resetWeaveControls();
  el.downloadSeq.disabled = false; // re-evaluated at completion (0-thread runs have no sequence)
  // Stage-change focus management (T9): the Start button that triggered the
  // weave is now hidden — move focus to the weave heading so keyboard and
  // screen-reader users land in the new stage, not on <body>.
  el.weaveHeading.focus({ preventScroll: true });
  run.scheduler.start(output.greyscale, config);
}

function weaveComplete() {
  const run = weave;
  if (!run) return;
  run.completedAt = performance.now();
  const seq = concatBatches(run.batches);
  run.hash = hashSequence(seq);
  run.seq = seq; // kept on the run for the completion downloads (T7) + QA
  // One deterministic repaint from the canonical sequence, so the final
  // canvas is identical across worker/fallback paths, speeds and pauses
  // (animation-time partial strokes differ only in sub-pixel AA seams).
  if (run.renderer) run.renderer.replay(seq);
  // Final counter values come from the engine's canonical totals; the
  // drawn accumulation must equal them (evidence line + QA summary below).
  counters.finish();
  run.counters = counters.getSummary();
  console.log(
    `[thread-art] weave complete: ${run.stats ? run.stats.passesUsed : "?"} threads in ` +
    `${Math.round(run.completedAt - run.startedAt)} ms of animation, sequence hash ${run.hash}`
  );
  console.log(
    `[thread-art] thread used: ${formatGrouped(run.counters.feet)} ft ` +
    `(${formatGrouped(run.counters.meters)} m) — assumes a 24 in board; ` +
    `drawn/engine euclid parity: ${run.counters.parity && run.counters.parity.euclidPxMatchesEngine ? "ok" : "MISMATCH"}`
  );
  logMeanPixelError(run); // internal dev metric only (T8) — never user-facing
  weave = null;
  lastRun = run;
  // Completion state (T6): finished portrait + stats summary + view-original
  // toggle + restart actions. The loom canvas has just been replayed to its
  // final deterministic form; the completion copies it pixel-for-pixel.
  completion.show({
    loom: el.loomCanvas,
    original: {
      canvas: el.cropCanvas, // still holds the working image (color, un-normalized)
      x: run.input.cropOffset.x,
      y: run.input.cropOffset.y,
      size: run.input.diameter,
    },
    summary: {
      pinCount: run.config.pinCount,
      passesUsed: run.stats ? run.stats.passesUsed : run.counters.drawn,
      stopReason: run.stats ? run.stats.stopReason : null,
      euclidPx: run.stats ? run.stats.totalThreadEuclidPx : run.counters.euclidPxDrawn,
      diameterPx: run.input.diameter,
    },
  });
  showStage("complete");
  // The finished-piece moment: restart the one-shot bloom/rise so a reweave
  // earns it again (remove → forced reflow → add).
  el.completeStage.classList.remove("just-woven");
  void el.completeStage.offsetWidth;
  el.completeStage.classList.add("just-woven");
  // A 0-thread run (blank image, converged before the first pass) has no
  // winding order to export — the txt button must say so by being disabled,
  // not by no-op-ing. The PNG stays live: the paper portrait is real.
  el.downloadSeq.disabled = !(run.seq && run.seq.length >= 2);
  // Focus lands on the completion heading (T9): the weave-stage control
  // that had focus (if any) is hidden with its stage — the "Woven" heading
  // announces the new state and Tab continues into its actions from the top.
  el.completeHeading.focus({ preventScroll: true });
}

function weaveFailed(message) {
  endWeaveRun();
  completion.reset(); // a failed reweave must not leave the last portrait around
  showError(
    "The weave couldn’t run",
    `Something went wrong while computing the thread pattern: ${message}`,
    { dismissLabel: "Adjust settings", action: "settings" }
  );
  showStage("crop");
}

function endWeaveRun() {
  if (!weave) return;
  if (weave.scheduler) weave.scheduler.cancel(); // stale worker traffic is dropped by id
  if (weave.anim) weave.anim.stop();
  weave = null;
  counters.reset(); // no stale numbers if the region is seen again
}

// Internal dev metric for QA/T8 (console only — the brief keeps any fidelity
// score out of the UI, a non-goal): mean pixel error vs the target greyscale,
// in the engine's darkness domain, averaged over the IN-CIRCLE pixels (the
// pixels the loom can represent). The mask reproduces circleSample() exactly:
// circle center minus cropOffset, radius d/2, pixel centers at +0.5.
function logMeanPixelError(run) {
  const stats = run.stats;
  const input = run.input;
  if (!stats || !input || !input.greyscale || !run.circle) return;
  const d = input.diameter;
  const ccx = run.circle.cx - input.cropOffset.x;
  const ccy = run.circle.cy - input.cropOffset.y;
  const r2 = (d / 2) * (d / 2);
  let inside = 0;
  for (let y = 0; y < d; y++) {
    const dy = y + 0.5 - ccy;
    for (let x = 0; x < d; x++) {
      const dx = x + 0.5 - ccx;
      if (dx * dx + dy * dy <= r2) inside++;
    }
  }
  const meanError = stats.remainingDarkness / Math.max(1, inside);
  const woven =
    stats.initialDarkness > 0
      ? ((stats.initialDarkness - stats.remainingDarkness) / stats.initialDarkness) * 100
      : 0;
  console.log(
    `[thread-art] mean pixel error (dev): ${meanError.toFixed(4)} per in-circle px ` +
    `(${inside} px) · ${woven.toFixed(1)}% of initial darkness woven`
  );
}

function summarizeRun(run) {  if (!run) return null;
  return {
    active: weave === run,
    mode: run.mode,
    ttftMs: run.ttftMs,
    drawn: run.anim ? run.anim.drawn : 0,
    totalPasses: run.totalPasses,
    passesUsed: run.stats ? run.stats.passesUsed : null,
    stopReason: run.stats ? run.stats.stopReason : null,
    hash: run.hash,
    seq: run.seq || null, // the canonical emitted sequence (T7 txt / QA)
    config: run.config || null,
    speed: run.anim ? run.anim.speed : null,
    paused: run.anim ? run.anim.paused : null,
    reducedMotion: run.anim ? run.anim.reducedMotion : null,
    frameStats: run.anim ? run.anim.getFrameStats() : null,
    stats: run.stats,
    counters: run.counters || (weave === run ? counters.getSummary() : null),
    animationMs: run.completedAt ? Math.round(run.completedAt - run.startedAt) : null,
  };
}

function concatBatches(batches) {
  let n = 0;
  for (const batch of batches) n += batch.length;
  const out = new Int16Array(n);
  let offset = 0;
  for (const batch of batches) {
    out.set(batch, offset);
    offset += batch.length;
  }
  return out;
}

// The live counter region is owned by ./stats.js (T5) — the old minimal
// status line was its placeholder and is gone.

// ── Weave controls: pause + speed, usable DURING the weave ──────────────

function setSpeedSelection(mult) {
  for (const button of el.weaveSpeeds.querySelectorAll("button")) {
    const selected = Number(button.dataset.speed) === mult;
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
}

function resetWeaveControls() {
  setSpeedSelection(1);
  el.weavePause.textContent = "Pause";
  el.weavePause.setAttribute("aria-pressed", "false");
  el.weaveStatus.dataset.paused = "false";
  disarmStopButton();
}

// Arm-then-fire state for the mid-weave stop button (see wireWeaveControls).
let stopArmTimer = 0;
function disarmStopButton() {
  clearTimeout(stopArmTimer);
  delete el.weaveRestart.dataset.armed;
  el.weaveRestart.textContent = "Stop the weave";
}

function wireWeaveControls() {
  // Speed buttons are generated from the anim module's SPEED_STEPS so the
  // committed 0.5×–16× set has a single source of truth.
  for (const step of SPEED_STEPS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "speed-button";
    button.dataset.speed = String(step);
    button.textContent = `${step}×`;
    button.setAttribute("aria-pressed", step === 1 ? "true" : "false");
    button.addEventListener("click", () => {
      setSpeedSelection(step);
      if (weave) weave.anim.setSpeed(step); // applies live, mid-weave
    });
    el.weaveSpeeds.appendChild(button);
  }

  el.weavePause.addEventListener("click", () => {
    if (!weave) return;
    if (weave.anim.paused) {
      weave.anim.resume();
      el.weavePause.textContent = "Pause";
      el.weavePause.setAttribute("aria-pressed", "false");
      el.weaveStatus.dataset.paused = "false";
      counters.setPaused(false);
    } else {
      weave.anim.pause();
      el.weavePause.textContent = "Resume";
      el.weavePause.setAttribute("aria-pressed", "true");
      el.weaveStatus.dataset.paused = "true"; // the dot holds steady — no pulse while paused
      counters.setPaused(true);
    }
  });

  // Mid-weave stop is arm-then-fire: the run is minutes of the product, and a
  // thumb reaching for the speed group shouldn't end it on one touch. First
  // press arms (label asks the question, gold state), second press within
  // the window stops; the arm decays on its own.
  el.weaveRestart.addEventListener("click", () => {
    if (!weave) {
      // No active run (late click) — behave like the plain stage return.
      showStage("crop");
      el.startButton.focus({ preventScroll: true });
      return;
    }
    if (el.weaveRestart.dataset.armed !== "true") {
      el.weaveRestart.dataset.armed = "true";
      el.weaveRestart.textContent = "Stop the weave?";
      clearTimeout(stopArmTimer);
      stopArmTimer = setTimeout(disarmStopButton, 2600);
      return;
    }
    disarmStopButton();
    endWeaveRun();
    showStage("crop");
    el.startButton.focus({ preventScroll: true });
  });
}

// ── Upload wiring (T1/T2, unchanged) ────────────────────────────────────

function wireUpload() {
  // File picker. The whole zone is clickable; the inner button is the
  // keyboard-accessible affordance.
  el.pickButton.addEventListener("click", () => el.fileInput.click());
  el.dropZone.addEventListener("click", (event) => {
    if (event.target.closest("button")) return; // the button handles itself
    if (state.reading) return; // a read is in flight — don't open a second picker
    el.fileInput.click();
  });
  el.fileInput.addEventListener("change", () => {
    handleFileList(el.fileInput.files);
    el.fileInput.value = ""; // allows re-picking the same file
  });
  el.errorDismiss.addEventListener("click", () => {
    clearError();
    if (errorAction === "settings") {
      el.startButton.focus({ preventScroll: true });
      return;
    }
    if (!state.reading) el.fileInput.click();
  });

  // Drag and drop. A depth counter keeps the highlight stable while the
  // pointer moves between the zone's children.
  let dragDepth = 0;
  el.dropZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    el.dropZone.classList.add("drag-over");
  });
  el.dropZone.addEventListener("dragover", (event) => event.preventDefault());
  el.dropZone.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) el.dropZone.classList.remove("drag-over");
  });
  el.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    el.dropZone.classList.remove("drag-over");
    handleFileList(event.dataTransfer && event.dataTransfer.files);
  });
  // Dropping outside the zone must not navigate the page away.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  // Paste (optional nicety per the brief): screenshots land on the clipboard
  // as image files.
  window.addEventListener("paste", (event) => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          handleFileList([file]);
          return;
        }
      }
    }
  });

  // Crop stage actions.
  el.startButton.addEventListener("click", startWeave);
  el.cropReplace.addEventListener("click", backToUploadStage);
}

// An active weave is minutes of the product: reloading or closing the tab
// mid-run throws it away silently. The guard is attached once, but only
// speaks while a run is live (a quiet page never nags on exit).
window.addEventListener("beforeunload", (event) => {
  if (!weave) return;
  event.preventDefault();
  event.returnValue = "";
});

showStage("upload");
wireUpload();
wireWeaveControls();
