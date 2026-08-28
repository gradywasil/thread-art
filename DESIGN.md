---
name: Thread Art
description: A dark gallery room where a single gold thread weaves a portrait — warm paper discs, hairline rings, hushed precision.
colors:
  gallery-black: "#12100d"
  gallery-raised: "#1a1712"
  gallery-sunken: "#0c0b09"
  warm-paper: "#ece6d9"
  aged-paper: "#a89f8e"
  faded-paper: "#8a8272"
  hairline: "#2c2822"
  hairline-strong: "#453e32"
  thread-gold: "#c9a25f"
  spotlit-gold: "#e5c98f"
  gold-shadow: "#241c10"
  thread-glow: "rgba(201, 162, 95, 0.16)"
  ember: "#cf8572"
  ember-edge: "#4b2e26"
  ember-ground: "#221713"
typography:
  display:
    fontFamily: "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif"
    fontSize: "clamp(1.75rem, 4.5vw, 2.5rem)"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "0.01em"
  hero-counter:
    fontFamily: "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif"
    fontSize: "clamp(2.4rem, 6.5vw, 3.4rem)"
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "0.01em"
    fontFeature: "tnum"
  wordmark:
    fontFamily: "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif"
    fontSize: "clamp(1.05rem, 2.2vw, 1.3rem)"
    fontWeight: 400
    letterSpacing: "0.42em"
  overline:
    fontFamily: "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif"
    fontSize: "0.95rem"
    fontWeight: 500
    letterSpacing: "0.14em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  hint:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "0.78rem"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.8em"
rounded:
  pill: "999px"
  panel: "14px"
  frame: "12px"
  note: "10px"
  chip: "4px"
components:
  button-primary:
    backgroundColor: "{colors.thread-gold}"
    textColor: "{colors.gold-shadow}"
    rounded: "{rounded.pill}"
    padding: "0.65rem 1.75rem"
  button-primary-hover:
    backgroundColor: "{colors.spotlit-gold}"
    textColor: "{colors.gold-shadow}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.spotlit-gold}"
    rounded: "{rounded.pill}"
    padding: "0.55rem 1.3rem"
  button-ghost-hover:
    backgroundColor: "rgba(201, 162, 95, 0.06)"
    textColor: "{colors.thread-gold}"
  speed-segment-active:
    backgroundColor: "{colors.thread-gold}"
    textColor: "{colors.gold-shadow}"
  error-note:
    backgroundColor: "{colors.ember-ground}"
    textColor: "{colors.aged-paper}"
    rounded: "{rounded.note}"
    padding: "0.95rem 1.1rem"
  loom-disc:
    backgroundColor: "{colors.gallery-sunken}"
    rounded: "50%"
---

# Design System: Thread Art

## Overview

**Creative North Star: "The Dark Gallery"**

Thread Art is a dark gallery room lit for one piece. The visitor stands in near-black warmth — Gallery Black under a soft radial spotlight blooming down from the ceiling — and on a plinth before them sits the work: a warm paper disc in a hairline ring, a single gold thread winding the portrait into being. Everything else is museum signage: wordmark, titles, counters, controls — hushed, sparse, exact.

The system is restrained precision. One accent, Thread Gold, does all the expressive work — the thread itself, the ring, the one decisive button, the live pulse — while everything else is paper-toned text on darkness, structured by hairlines. Depth follows a spotlight-and-plinth philosophy: exhibited artifacts (the loom discs, the photo) sit on plinth rings and cast soft black pools; the controls stay flat, weightless ink on air. Numbers are a moral matter in this room: every figure renders in tabular numerals, the hero counters in the display serif, because the counters must be believed.

Confirmed visual rejections: the bright SaaS-white dashboard register and default web blue — this room never goes white, and blue never enters it; and runtime network fonts — the zero-network page mandates system stacks, and the typography is chosen so that constraint reads as taste rather than fallback.

**Key Characteristics:**
- Near-black warm room with a single overhead spotlight gradient
- One gold accent: the thread, the ring, the decisive action, the live state
- Warm paper text ramp (Warm / Aged / Faded Paper) — never pure white
- Circles for the loom, pills for controls, hairlines for structure
- Display serif carries titles and hero numbers; system sans carries UI copy
- Tabular figures on every number; 4.5:1 contrast floor on every text token
- Motion is small, short, and fully disabled under `prefers-reduced-motion`

## Colors

A candlelit palette: near-black warmth, a paper-tone text ramp, and one gold that reads as physical thread under a spotlight.

### Primary
- **Thread Gold** (#c9a25f): the medium itself. Colors the thread strokes, the crop ring, the primary button, the slider fill, and the live status pulse. Rare by design — see The One Gold Rule.
- **Spotlit Gold** (#e5c98f): how gold reads when lit — text on dark for ghost-button labels, knob values, code chips, and hover states; also the primary button's hover fill. 11.11:1 on Gallery Black.
- **Gold Shadow** (#241c10): the dark side under gold — text on gold fills (primary button, active speed segment). 7.06:1 on Thread Gold.
- **Thread Glow** (rgba(201, 162, 95, 0.16)): the halo ingredient inside plinth rings and hover auras.

### Neutral
- **Gallery Black** (#12100d): the room — page background beneath the spotlight gradient.
- **Raised Wall** (#1a1712): the upper member of the tonal card gradient.
- **Sunken Base** (#0c0b09): the void inside circles — loom canvas grounds, the speed-group tray.
- **Warm Paper** (#ece6d9): primary text.
- **Aged Paper** (#a89f8e): secondary text — ledes, error body, privacy note.
- **Faded Paper** (#8a8272): tertiary text — hints, captions, meta lines. Still holds 4.99:1 on the room and 4.63:1 at the spotlight peak.
- **Hairline** (#2c2822): dividers, slider-track bases, internal separators.
- **Strong Hairline** (#453e32): control borders, disc rims, the dashed drop ring.

### Tertiary
- **Ember** (#cf8572): error titles and the noscript warning — a muted terracotta that quarrels with nothing. 6.04:1 on Ember Ground.
- **Ember Edge** (#4b2e26): error-card border.
- **Ember Ground** (#221713): error-card fill.

### Named Rules
**The One Gold Rule.** Gold marks the thread and exactly one decisive action per stage. If two things on a screen compete for gold, one of them is wrong.

**The 4.5 Line.** Every text token must hold ≥4.5:1 against both Gallery Black and the spotlight peak (#1d1812) — audited and pinned in the shipped stylesheet; do not regress it.

## Typography

**Display Font:** Iowan Old Style → Palatino Linotype → Book Antiqua → Palatino → Georgia → Times New Roman (system serif stack)
**Body Font:** ui-sans-serif → system-ui → −apple-system → Segoe UI → Helvetica → Arial
**Mono Font:** ui-monospace → SF Mono → Menlo → Consolas

**Character:** An old-style book serif with quiet italics, paired with the OS's plain sans. The serif is the room's voice — plaques, titles, hero numbers, italic asides; the sans is the machinery's voice — labels, hints, controls. Nothing is fetched; the stacks make the zero-network constraint read as deliberate.

### Hierarchy
- **Display** (500, clamp(1.75rem, 4.5vw, 2.5rem), line-height 1.15): the stage title — exactly one per stage, crowned by the gradient hairline ornament.
- **Hero Counter** (500, clamp(2.4rem, 6.5vw, 3.4rem), line-height 1.08, tabular): feet-of-thread totals, the showpiece number.
- **Wordmark** (400, clamp(1.05rem, 2.2vw, 1.3rem), +0.42em tracking, uppercase): "THREAD ART", optically re-centered with a matching text-indent, anchored by the gold lozenge beneath.
- **Overline** (500, 0.95rem, +0.14em, uppercase): card kickers ("Weave settings").
- **Body** (400, 1rem, line-height 1.55; ledes 1.02rem capped at 34rem): stage ledes and copy.
- **Caption** (400, 0.76–0.95rem): hints and meta lines in Faded Paper; serif italic where the line is a plaque (tagline, figure captions, footer).

### Named Rules
**The Honest Figures Rule.** Every number — counters, knob values, crop meta, speed multipliers — renders with tabular figures; hero numbers render in the display serif. A counter that wobbles is a counter that lies.

**The System-Stack Rule.** No font is ever fetched at runtime. Type arrives via system stacks only; the zero-network page makes this law, and the stacks make it taste.

## Layout

The spatial model is a single centered stage. The page is a three-row grid (header / stage / footer) over min-height 100svh; the body carries the room — Gallery Black with a soft radial spotlight (1100×700px at 50% −10%, #1d1812 fading to transparent at 60%). Stage panels measure min(44rem, 100%) and replace one another; every stage leads with the same h1-plus-ornament rhythm.

Rhythm: blocks breathe ~1.9rem apart; action rows gap 0.8rem; page padding clamps (1.5rem, 4vw, 3.25rem); ledes cap at 34rem. No multi-column dashboards, ever — one artifact, one attention.

Wide crop screen (≥62rem): photo and settings compose side by side — columns minmax(0, 1.2fr) / minmax(17rem, 0.8fr) with a 3rem gutter, title and lede spanning both, the title ornament flipping from a centered fade to a left gold run. The photo caps at 32rem wide / 56svh tall so the composed screen stays inside a normal viewport.

Mobile grace: the same stages, single column, but the action row sits above the knobs so Start is reachable without scrolling past every control. Coarse pointers get ~44px hit areas, a 22px slider thumb, and `touch-action: manipulation` everywhere except the crop frame, whose drags must own the gesture.

**The One Stage Rule.** Exactly one stage panel is ever visible, and it always carries the same skeleton — ornament, h1, lede, artifact, actions. New screens join the sequence; they don't invent new chrome.

## Elevation & Depth

Spotlight and plinth: the room is dark and the exhibits are lit. Depth belongs to the exhibited artifacts — the loom discs, the crop photo, the drop-target loom — which sit on plinths of hairline ring, gold halo, and soft black drop. Controls and cards never lift: a button is ink on air, and cards are tonal (a Raised Wall → Sunken Base gradient at ~85% alpha) rather than shadowed.

### Shadow Vocabulary
- **Plinth Ring** (`0 0 0 1px var(--hairline), 0 0 34px var(--accent-glow), 0 26px 60px -22px rgba(0,0,0,0.72)`): the composite pedestal under the weaving canvas and the finished piece.
- **Artifact Drop** (`0 22–26px 50–60px -30px rgba(0,0,0,0.8–0.85)`): the soft black pool beneath photo frames and the drop zone.
- **Gold Aura** (hover and drag halos at ≤0.35 alpha, e.g. `0 0 46px rgba(201,162,95,0.14)`): light catching gold — state moments only.
- **Inset Void** (`inset 0 0 0 1px rgba(0,0,0,0.35)`): the drop zone's inner rim, carving the disc into the wall.
- **Hero Shadow** (`text-shadow: 0 2px 22px rgba(0,0,0,0.55)`): keeps the giant counter legible over the disc.

### Named Rules
**The Plinth Rule.** If it isn't the exhibit, it doesn't cast. Shadows on controls are a category error; state changes there are border-and-tint, never lift.

## Shapes

The circle is the form language because the loom is the subject. Anything that *is* the loom — drop target, crop ring, weaving canvas, finished portrait — is a perfect circle (border-radius 50%, aspect-ratio 1). Anything that *acts on* the loom is a pill (999px): buttons, the speed group, slider tracks. Structure is hairline: 1px borders, gradient hairline ornaments (52px) above titles, smaller hairline breaks above the privacy note and counters. Two ornaments recur: the gold lozenge (5px square rotated 45°) anchoring the wordmark, and the dashed inner reference ring (inset 5–9px, gold at ~0.4 alpha) marking the sampled disc. Cards round at 14px, photo frames at 12px, error notes at 10px, code chips at 4px.

**The Circle Rule.** Circle = the work. Pill = the hand. Hairline = the room. When adding an element, ask which of the three it is.

## Components

### Buttons
Pills of ink and air; gold only for the decisive act.
- **Shape:** full pill (999px).
- **Primary:** Thread Gold fill, Gold Shadow text, 1px gold border, padding 0.65rem 1.75rem, 0.98rem at +0.03em, soft Gold Aura (`0 10px 26px -14px rgba(201,162,95,0.55)`). Hover lifts fill and border to Spotlit Gold with a brighter aura. Disabled: 0.55 opacity, no tint.
- **Ghost** (every secondary action): transparent ground, Spotlit Gold text, Strong Hairline border, padding 0.55rem 1.3rem, 0.95rem. Hover: gold border, Thread Gold text, 6% gold tint. Toggle buttons (Pause) swap border and text to gold via `aria-pressed`.
- **Focus:** the global treatment — 2px Thread Gold outline, 3px offset, 2px radius.

### Chips
The speed group: a segmented pill on Sunken Base with hairline dividers. Segments are Aged Paper text that hover to Warm Paper; the active segment fills Thread Gold with Gold Shadow text and a 14px aura. Focus outlines pull inside (−3px offset) because the group clips.

### Cards / Containers
The knobs card ("Weave settings"): 14px corners, tonal gradient (Raised Wall → Sunken Base at 85% alpha) over the room, 1px Hairline border, padding 1.35–1.5rem, centered serif overline title. Advanced controls fold behind a summary divider that hover-brightens to gold. No shadows — see The Plinth Rule.

### Inputs / Fields
The range knob: a 22px-tall hit area over a 3px hairline track with the gold filled portion left of the thumb (`--fill` % maintained in JS; Firefox uses native range-progress). The 15px circular Thread Gold thumb carries a 3px near-black rim plus a 1px gold micro-ring and 10px glow. Focus: gold outline at 4px offset. Coarse pointers grow to a 30px track and 22px thumb. Checkboxes follow gold via `accent-color`.

### Navigation
None — the stage sequence replaces it. The header is signage: tracked uppercase wordmark, gold lozenge, serif-italic tagline in Faded Paper. The footer is a one-line plaque.

### The Loom (signature)
The showpiece artifact, drawn by the same geometry at every scale: the miniature drop-target loom (SVG pin-ring with gold chords), the crop circle (2px gold ring, halo, and a 9999px box-shadow scrim that dims everything outside the disc), and the weaving / finished discs (Sunken Base circles on the Plinth Ring). The drop target's states are the room's grammar: hover warms the dashed ring to gold; drag-over makes it solid gold with a 46px aura; busy turns the miniature loom — the app's only spinner.

### The Counters (signature)
The weave screen's hero: the feet total in display-serif tabular figures (clamping up to 3.4rem) with a serif-italic gold unit, the passes line beneath, a 2px hairline progress track filled by a gold gradient via `scaleX`, and a status line whose 6px gold dot pulses only while thread is actively laid. The honesty note ("assumes a 24 in board") sits beneath in Faded Paper.

## Do's and Don'ts

### Do:
- **Do** give every stage exactly one gold decisive action; every other action is a ghost pill.
- **Do** render every number in tabular figures — hero numbers in the display serif.
- **Do** hold every text token at ≥4.5:1 on both Gallery Black and the spotlight peak (#1d1812).
- **Do** put the exhibit on its plinth: hairline ring + Thread Glow halo + soft black drop.
- **Do** keep motion small and short (130–180ms states, one 1.7s pulse, one 2.8s turn) and fully disabled under `prefers-reduced-motion`.
- **Do** choose system stacks for all type — the constraint is the style.

### Don't:
- **Don't** go SaaS: no white surfaces, no default web blue, no drop shadows on controls (confirmed rejection).
- **Don't** fetch fonts at runtime — network silence is a product promise (confirmed rejection).
- **Don't** widen gold past the thread, the ring, the decisive action, and the live state.
- **Don't** let a screen show two competing gold moments — see The One Gold Rule.
- **Don't** square the work: the loom is always a circle; rectangles are for cards and frames only.
- **Don't** announce per-tick counter changes to screen readers — counters tick visibly but announce only at phase changes and milestones.
