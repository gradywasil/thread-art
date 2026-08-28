// Thread Art — draggable circular crop overlay (T2).
//
// Owns the interaction only: the working image is drawn into `canvas` by the
// ingest pipeline (./ingest.js) before open() is called. The circle is the
// region the thread canvas will sample; the user drags it (mouse, pen or
// touch — unified through Pointer Events; the frame carries touch-action:none
// so touch drags never scroll the page) or nudges it with the arrow keys.
//
// The circle's diameter is fixed at min(width, height) of the working image —
// the largest inscribed circle — and the user positions its center along the
// long axis. Positioning (not resizing) is the settled town-hall decision.
//
// All geometry lives in working pixels; the overlay is laid out in CSS
// percentages of the canvas box, so window resizes reflow it for free.

const KEY_STEP = 8; // working px per arrow-key nudge (Shift ×2)

export function createCropController({ frame, canvas, circle }) {
  const state = { open: false, w: 0, h: 0, d: 0, cx: 0, cy: 0 };
  let drag = null; // {id, dx, dy} offset from pointer to circle center

  function clampCenter(x, y) {
    const r = state.d / 2;
    return {
      x: Math.min(Math.max(Math.round(x), r), state.w - r),
      y: Math.min(Math.max(Math.round(y), r), state.h - r),
    };
  }

  function setCenter(x, y) {
    const c = clampCenter(x, y);
    state.cx = c.x;
    state.cy = c.y;
    render();
  }

  // Percent-based layout: the circle tracks the canvas box at any CSS size.
  function render() {
    circle.style.width = `${(state.d / state.w) * 100}%`;
    circle.style.height = `${(state.d / state.h) * 100}%`;
    circle.style.left = `${((state.cx - state.d / 2) / state.w) * 100}%`;
    circle.style.top = `${((state.cy - state.d / 2) / state.h) * 100}%`;
  }

  function pointerToWorking(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * state.w,
      y: ((event.clientY - rect.top) / rect.height) * state.h,
    };
  }

  function insideCircle(p) {
    const dx = p.x - state.cx;
    const dy = p.y - state.cy;
    return dx * dx + dy * dy <= (state.d / 2) * (state.d / 2);
  }

  frame.addEventListener("pointerdown", (event) => {
    // Ignore non-primary buttons, and any SECOND pointer while a drag is
    // active (T11: on touch screens a resting finger or palm would otherwise
    // hijack the drag and jump the circle).
    if (!state.open || drag) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const p = pointerToWorking(event);
    if (insideCircle(p)) {
      // Grabbed inside the circle: keep it under the same relative point.
      drag = { id: event.pointerId, dx: state.cx - p.x, dy: state.cy - p.y };
    } else {
      // Grabbed outside (coarse-touch friendly): the circle jumps to the
      // pointer, then follows it.
      setCenter(p.x, p.y);
      drag = { id: event.pointerId, dx: 0, dy: 0 };
    }
    frame.setPointerCapture(event.pointerId);
    frame.classList.add("is-dragging");
    circle.classList.add("is-dragging");
    event.preventDefault();
  });

  frame.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const p = pointerToWorking(event);
    setCenter(p.x + drag.dx, p.y + drag.dy);
    event.preventDefault();
  });

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    drag = null;
    if (event && frame.hasPointerCapture(event.pointerId)) {
      frame.releasePointerCapture(event.pointerId);
    }
    frame.classList.remove("is-dragging");
    circle.classList.remove("is-dragging");
  }

  frame.addEventListener("pointerup", endDrag);
  frame.addEventListener("pointercancel", endDrag);
  frame.addEventListener("lostpointercapture", endDrag);

  // Keyboard: nudge with arrows (Shift = bigger steps), Home recenters.
  // Basic affordance now; the full a11y semantics pass belongs to T9.
  circle.addEventListener("keydown", (event) => {
    if (!state.open) return;
    const step = event.shiftKey ? KEY_STEP * 2 : KEY_STEP;
    let handled = true;
    switch (event.key) {
      case "ArrowLeft":
        setCenter(state.cx - step, state.cy);
        break;
      case "ArrowRight":
        setCenter(state.cx + step, state.cy);
        break;
      case "ArrowUp":
        setCenter(state.cx, state.cy - step);
        break;
      case "ArrowDown":
        setCenter(state.cx, state.cy + step);
        break;
      case "Home":
        setCenter(state.w / 2, state.h / 2);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  });

  return {
    // Call after the working image has been drawn into the canvas.
    open(width, height) {
      state.open = true;
      state.w = width;
      state.h = height;
      state.d = Math.min(width, height);
      setCenter(width / 2, height / 2);
    },

    // Reset interaction state and clear the canvas (used when leaving crop).
    close() {
      state.open = false;
      state.w = state.h = state.d = 0;
      state.cx = state.cy = 0;
      drag = null;
      circle.classList.remove("is-dragging");
      frame.classList.remove("is-dragging");
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },

    // Current circle for ingest: {cx, cy, d} in working pixels (integers).
    getCircle() {
      return { cx: state.cx, cy: state.cy, d: state.d };
    },

    get isOpen() {
      return state.open;
    },
  };
}
