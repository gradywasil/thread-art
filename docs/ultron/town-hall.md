# Town Hall — Algorithmic Thread Art Generator

Status: APPROVED (all clusters individually signed off; final gate passed)

## Problem statement
People love the look of hand-made thread art portraits but almost nobody gets to see *how* they're
made — the thousands of individual thread decisions. Existing tools either flash a final image or
output dry instructions. There is no experience that shows the algorithm *thinking* in thread.

## Target users
- Primary: the curious viewer / portfolio visitor who uploads a portrait and watches it weave
  itself (showpiece audience).
- Secondary: makers who want the pin sequence + stats to physically build a piece.

## MVP (lean showpiece)
A single static page, pure client-side. The user uploads a portrait, drags a circular crop over it,
optionally tweaks 3–4 pre-start knobs, and starts the weave. A single black thread animates itself
pin-to-pin around 300 pins in a circle, progressively burning the portrait into the canvas, while a
counter ticks up total feet of string. At completion: final portrait, stats, PNG download, and a
plain-text pin-sequence + stats download.

MVP includes:
- Upload via file picker and drag-and-drop (paste optional, production discretion)
- Visible circular crop, draggable to reposition, before the weave starts
- Pre-start knobs: pin count, thread coverage/passes, thread darkness, animation speed
- Real-time animated weaving with live feet-of-string counter and pass counter
- Speed control during the weave (pause / fast-forward within the approved outcome)
- Completion state: final portrait + stats + "view original" toggle (simple toggle, not a slider)
- Downloads: PNG of final art; .txt pin sequence with stats header
- Reduced-motion path: instant/stepped finish instead of long animation
- Statement that the image never leaves the user's machine

## Explicit non-goals
- Scrub/replay timeline; before/after compare slider
- Live mid-weave parameter tweaking
- Multi-color threads
- Share links, persistence, gallery, auth
- Nail-hole template / physical print layout generator
- Any backend, network calls after load, or image upload to a server
- User-visible fidelity score

## Primary journeys and states
Journey: Land → Upload → Crop (drag circle; knobs available) → Start → Weaving (counters ticking,
speed control) → Complete (stats, downloads, original toggle).

States: landing/empty · image-loaded/crop · weaving · complete · reduced-motion instant path ·
error (unreadable file).

## Success measures and acceptance criteria
1. Time-to-first-thread < 2 s after pressing Start (on mid-range modern hardware).
2. Animation is smooth at default speed — no visible jank (60fps rendering target, internal).
3. Default full weave takes 1–3 minutes; speed multiplier materially changes duration.
4. Feet counter is believable and honest: computed from actual Euclidean chord lengths between
   pins, scaled by a declared physical board mapping (researched default). Never a fake counter.
5. Likeness judged by human side-by-side check (completion-state original toggle).
6. Mean pixel error vs the target greyscale is tracked internally as a dev tuning tool only.
7. PNG download matches the finished canvas; .txt sequence is exactly the drawn winding order,
   with stats header (pins, passes, total feet, assumed board size).
8. Same image + same settings → identical result (deterministic).
9. Zero network activity after page load; image never leaves the machine.
10. Graceful mobile: usable layout, touch crop drag, acceptable weave performance on modern phones.
11. `prefers-reduced-motion` honored with instant/stepped completion.

## Constraints, assumptions, dependencies, risks
- Modern evergreen browsers only; no legacy support.
- Single static page, no build step required.
- Deterministic algorithm per image + settings.
- Images downscaled internally to ~500–700 px working resolution.
- EXIF orientation handled locally.
- Risks: greedy plateau on low-contrast/light images (mitigate: stopping rules + optional contrast
  normalization — research); compute cost jank on weak hardware (mitigate: chord precomputation /
  worker — research); memory of precomputed chord table (research to size).

## Role Perspectives
(written during the meeting; retained as record)

### Product / user value
- Supports: upload → immediate weaving → feet counter ticking → satisfying artifact. The "burning
  in" of the image is the emotional payoff; pacing is a product feature.
- Strongest concern: a demo must land fast — dead compute time or a dragging weave kills the wow.
- Cost/risk: "black screen while computing" moment. Opportunity: continuous progress feedback.
- Experiment: measure greedy compute cost for ~4,000 passes × 300 pins; decide pipeline split.

### UX / UI
- Supports: one page, one drop zone, 3–4 knobs, live counters, obvious start state.
- Concern: knobs restarting the weave feel punitive; silent center-crop confuses. Both resolved:
  pre-start knobs only + draggable crop preview.
- Risk: phone EXIF rotation; desktop-first with graceful mobile.

### Frontend
- Supports: Canvas 2D suffices; greedy over greyscale pixel data is well understood.
- Concern: naive per-step chord rescanning janks — est. 4,000 × 300 × ~100 px ≈ 10⁸ ops.
  Precomputing C(300,2) ≈ 44,850 chord pixel-index lists turns steps into cheap summations; a
  Web Worker keeps rendering smooth.
- Experiment: prototype chord table + worker; measure. → routed to research.

### Backend / data / integrations
- N/A — no backend. Local pipeline: ImageData → greyscale Float32Array → progressive lightening.

### Quality / reliability
- Supports: deterministic given params.
- Concern: greedy degradation on light/sparse images; stopping criteria needed (target passes
  and/or minimum-improvement threshold); contrast preprocessing may be needed for weak inputs.
- Risk: silent bad outputs → accepted as risk with researched mitigations.

### Security / privacy
- Pure client-side; image never uploaded; state it in UI. No meaningful attack surface.

### Accessibility
- Reduced-motion instant path (in MVP); canvas labeled; controls keyboard-reachable; counters are
  live text.

### Domain accuracy (string-art physics) — directional; cited numbers → deep-research
- Real pieces: ~200–500 pins; dense portraits use thread measured in thousands of feet. Counter
  must derive from real chord geometry × declared board size.
- Concern: thread visual weight — overlaps darken; lightening model must look thread-like, not
  scribble-like. → research defaults.

## Open questions — disposition
| # | Question | Owner | Blocking? |
|---|----------|-------|-----------|
| Q1 | Compute architecture: precompute-all vs pipelined compute-ahead; worker vs main thread | research | informs production, non-blocking |
| Q2 | Algorithm defaults: pin count range, pass count, lightening amount, min chord improvement, stopping rules | research → production tuning | informs, non-blocking |
| Q3 | Physical scale mapping for feet counter: board diameter, thread width, units | research | informs, non-blocking |
| Q4 | Crop behavior | SETTLED in town hall: visible + draggable | — |
| Q5 | Reduced-motion scope | SETTLED: in MVP, instant/stepped path | — |
| Q6 | Export format | SETTLED: plain text (.txt with stats header) | — |
| Q7 | Mobile level | SETTLED: graceful | — |
| Q8 | Contrast normalization for weak images | research → production | informs, non-blocking |

Production-owned questions must preserve the approved outcome; anything touching user behavior,
scope, acceptance criteria, or non-goals returns to Town Hall.

## Decisions with rationale (incl. rejected alternatives)
1. Purpose = showpiece demo. Rejected: maker-tool-first (animation is the differentiator), both-
   equally (would compromise the showpiece).
2. Pure client-side static. Rejected: backend (unnecessary, privacy cost).
3. Curated defaults + few knobs. Rejected: fully automatic (too rigid), full playground (complexity).
4. Outputs: experience + PNG + txt sequence/stats. Rejected: bare experience (user wants
   artifacts), shareable links (persistence complexity).
5. Lean showpiece MVP (Challenger/Advocate round). Rejected: + replay toys (dilutes the
   meditation), bare minimum (drops requested outputs).
6. Experience-first success measures (Challenger/Advocate round). Rejected: fidelity-first
   (sacrifices pacing), hybrid visible score (kills mystique; error stays internal).
7. Crop: visible + draggable. Rejected: silent center-crop (confusing), preview-no-drag (faces
   off-center).
8. Mobile: graceful. Rejected: first-class (effort away from desktop showpiece), desktop-only
   (dead-ends phones).
9. Export format: plain text. Rejected: CSV (machine-friendly, human-poor), both (more UI).
10. Constraints list confirmed as proposed.

## Cluster sign-offs
1. Problem & users — confirmed (round 1)
2. MVP boundary & non-goals — lean showpiece (round 1, Challenger/Advocate)
3. Journeys, states, success measures, acceptance criteria — experience-first (round 1,
   Challenger/Advocate)
4. Constraints, assumptions, risks — confirmed (round 2)
5. Open-question dispositions — table above, settled with clusters (rounds 1–2 + final gate)

## Handoff note for plan-it-out
Scope is a single-page static client-side app in /Users/arrangedgodly/Documents/Projects/thread-art.
Three research tracks should be planned as prerequisites/informers, not blockers: compute
architecture (Q1), algorithm defaults (Q2/Q8), physical mapping (Q3). Plan the build around:
upload/crop stage → engine (greedy algorithm, chord precompute, worker) → animated render layer →
counters/stats → downloads → reduced-motion + graceful mobile → acceptance checks per the 11
criteria above. No build step required; keep it deployable as a static folder.
