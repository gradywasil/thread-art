// Thread Art — weave animation controller (T4).
//
// A pure consumer of the scheduler's pass-record batches: it drains the
// buffered queue at the user's DISPLAY speed on a requestAnimationFrame
// loop, drawing each thread pin-to-pin on the accumulated canvas via cheap
// sub-segment interpolation (the tip advances a little inside each frame —
// the "pulling tight" feel, explicitly kept simple). Compute-ahead
// pipelining means the queue is normally full and the loop never starves.
//
// Speed is display-only (committed RQ2): a multiplier over a base of one
// thread per animation frame — 60 passes/second at 1× — so a default
// 4,000-pass weave runs ≈67 s at 1×, ≈4.2 s at 16×, and pause freezes the
// tip exactly where it is (speed 0, equivalent). The final canvas depends
// only on the pass sequence, never on speed, pauses, or frame timing.
//
// The rAF loop runs only while there is something to draw and the weave is
// not paused and not completed — no idle frame churn, and pausing releases
// the loop entirely until resume.
//
// Frame-time deltas are collected for QA evidence (T8): getFrameStats()
// returns mean/p95/max over the run; the pause gap is never recorded.
//
// Callbacks: onFirstThread(), onPassDrawn(drawnCount, fromPin, toPin) —
// fired once per fully-laid thread, in emission order, so live counters
// (T5) can accumulate exactly what the loom shows.
//
// Reduced motion (T9, criterion 11): when setReducedMotion(true) is active
// the rAF loop is never used. Instead the queue drains in REDUCED_STEPS
// brief staged steps on a plain setTimeout cadence (~1 s for a default
// 4,000-pass weave instead of the ~67 s animation) — an instant/stepped
// finish that honors prefers-reduced-motion. Only the PRESENTATION changes:
// the same passes are drawn in the same order (full opaque segments, so
// stepping over a partially-drawn segment is idempotent), the counters
// accumulate the identical chords, and the final canvas comes from the
// completion replay either way — the sequence and every stat are bit-
// identical to an animated run. The media query is watched by main.js and
// forwarded live, so a mid-weave change swaps modes on the next tick.

// 1× = one thread per frame at 60 fps (display-only; RQ2 committed range).
export const BASE_PASSES_PER_SECOND = 60;
export const SPEED_STEPS = [0.5, 1, 2, 4, 8, 16]; // committed RQ2 knob set

// Stepped-finish cadence for reduced motion (T9): the whole drain is split
// into this many steps, one every REDUCED_STEP_MS (scaled by the speed
// multiplier so the speed controls keep working in stepped mode).
export const REDUCED_STEPS = 10;
export const REDUCED_STEP_MS = 100;

export function createWeaveAnimation({
  drawSegmentPortion,
  onFirstThread,
  onPassDrawn,
  onComplete,
  totalPasses = 0, // the run's pass budget — sizes the stepped-drain chunks
}) {
  const pending = []; // Int16Array batches of (fromPin, toPin) pairs
  let cursorBatch = 0;
  let cursorIndex = 0; // byte-pair cursor inside pending[cursorBatch]

  let speed = 1;
  let paused = false;
  let reducedMotion = false; // prefers-reduced-motion: stepped finish (T9)
  let drainTimer = 0; // stepped-drain setTimeout id (reduced-motion mode)
  let current = null; // { from, to, t } — in-flight segment, t = drawn fraction
  let doneReceived = false; // scheduler posted done
  let completed = false; // drained after done → onComplete fired once
  let firstThreadAt = null;
  let rafId = 0;
  let lastTime = 0;
  let lastFrameStamp = 0;
  let drawn = 0;
  const frameDeltas = []; // ms between consecutive rAF callbacks

  function nextPass() {
    while (cursorBatch < pending.length) {
      const batch = pending[cursorBatch];
      if (cursorIndex + 1 < batch.length) {
        const pair = { from: batch[cursorIndex], to: batch[cursorIndex + 1], t: 0 };
        cursorIndex += 2;
        return pair;
      }
      cursorBatch += 1;
      cursorIndex = 0;
    }
    return null;
  }

  function draw(a, b, t0, t1) {
    if (firstThreadAt === null) {
      firstThreadAt = performance.now();
      if (onFirstThread) onFirstThread(firstThreadAt);
    }
    drawSegmentPortion(a, b, t0, t1);
  }

  function advance(dtMs) {
    if (current === null) current = nextPass();
    if (current === null) return; // starved — wait for the next batch
    let t = current.t + (dtMs / 1000) * BASE_PASSES_PER_SECOND * speed;
    while (current !== null && t >= 1) {
      draw(current.from, current.to, current.t, 1); // finish the segment
      drawn += 1;
      // (drawnCount, fromPin, toPin) — the pin pair lets T5's counters
      // accumulate the canonical chord length of each LAID thread.
      if (onPassDrawn) onPassDrawn(drawn, current.from, current.to);
      t -= 1;
      current = nextPass();
    }
    if (current !== null) {
      draw(current.from, current.to, current.t, t); // tip advances mid-segment
      current.t = t;
    }
    // else: queue drained — any leftover fractional budget is dropped (the
    // next batch/advance starts fresh; a fraction of a pass is sub-frame).
  }

  function drained() {
    return current === null && cursorBatch >= pending.length;
  }

  function completeIfDrained() {
    if (completed || !doneReceived || !drained()) return;
    completed = true;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = 0;
    }
    if (onComplete) onComplete();
  }

  // One staged step of the reduced-motion drain: lays a batch of FULL
  // segments (idempotent over any partially-drawn tip left by the rAF path)
  // sized so the whole weave finishes in ~REDUCED_STEPS steps at 1×.
  function drainStep() {
    drainTimer = 0;
    if (completed || paused) return;
    const hint = totalPasses > 0 ? totalPasses : 4000;
    let budget = Math.max(32, Math.round((hint / REDUCED_STEPS) * speed));
    while (budget-- > 0) {
      if (current === null) current = nextPass();
      if (current === null) break; // starved — retry on the next step
      draw(current.from, current.to, 0, 1);
      drawn += 1;
      if (onPassDrawn) onPassDrawn(drawn, current.from, current.to);
      current = null;
    }
    if (drained()) {
      completeIfDrained();
      return;
    }
    scheduleNext();
  }

  // Mode-aware scheduler: rAF loop normally, stepped setTimeout drain under
  // reduced motion. Exactly one of the two is ever pending.
  function scheduleNext() {
    if (paused || completed) return;
    if (drained()) {
      completeIfDrained();
      return;
    }
    if (reducedMotion) {
      if (!drainTimer) drainTimer = setTimeout(drainStep, REDUCED_STEP_MS);
    } else if (!rafId) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    rafId = 0;
    if (completed) return;
    if (lastFrameStamp) frameDeltas.push(now - lastFrameStamp);
    lastFrameStamp = now;
    const dt = Math.max(0, now - lastTime);
    lastTime = now;
    advance(dt);
    if (drained()) completeIfDrained();
    if (!completed) rafId = requestAnimationFrame(frame);
  }

  return {
    // Feed one batch of pass records from the scheduler.
    push(batch) {
      if (!completed && batch && batch.length) {
        pending.push(batch);
        scheduleNext();
      }
    },

    // The scheduler reported done — completion fires once the queue drains.
    finish() {
      doneReceived = true;
      scheduleNext();
    },

    setSpeed(mult) {
      if (Number.isFinite(mult) && mult > 0) speed = mult; // pause is separate, not speed 0
    },

    // Reduced-motion switch (T9): swaps the rAF animation for the stepped
    // drain, live — safe at any point (both modes draw the same full
    // segments; a partially-drawn rAF tip is simply completed by the step).
    setReducedMotion(on) {
      reducedMotion = !!on;
      if (completed) return;
      if (reducedMotion && rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (!reducedMotion && drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = 0;
      }
      if (!paused) scheduleNext();
    },

    pause() {
      if (paused || completed) return;
      paused = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = 0;
      }
    },

    resume() {
      if (!paused || completed) return;
      paused = false;
      lastFrameStamp = 0; // never record the pause gap as a frame delta
      lastTime = performance.now();
      scheduleNext();
    },

    // Hard stop for cancellation/restart: no further drawing or callbacks.
    stop() {
      completed = true;
      paused = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = 0;
      }
      pending.length = 0;
      cursorBatch = 0;
      cursorIndex = 0;
      current = null;
    },

    get speed() {
      return speed;
    },
    get paused() {
      return paused;
    },
    get reducedMotion() {
      return reducedMotion;
    },
    get drawn() {
      return drawn;
    },
    get firstThreadAt() {
      return firstThreadAt;
    },

    // Frame pacing evidence for T8/QA.
    getFrameStats() {
      const n = frameDeltas.length;
      if (n === 0) return { frames: 0, meanMs: null, p95Ms: null, maxMs: null };
      let sum = 0;
      let max = 0;
      for (let i = 0; i < n; i++) {
        sum += frameDeltas[i];
        if (frameDeltas[i] > max) max = frameDeltas[i];
      }
      const sorted = Array.from(frameDeltas).sort((a, b) => a - b);
      const p95 = sorted[Math.min(n - 1, Math.max(0, Math.ceil(n * 0.95) - 1))];
      return {
        frames: n,
        meanMs: +(sum / n).toFixed(2),
        p95Ms: +p95.toFixed(2),
        maxMs: +max.toFixed(2),
      };
    },
  };
}
