# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary:** the curious viewer — a portfolio visitor who uploads a portrait and watches it weave itself (showpiece audience). Deployed at thread.arrangedgodly.com under the owner's personal domain, so in practice this is the audience of arrangedgodly.com. *(Showpiece-first split approved in `docs/ultron/town-hall.md`; the personal-portfolio framing inferred 2026-08-28 from deployment context, unconfirmed.)*
- **Secondary:** makers who want the pin-to-pin winding order and stats to physically build a piece with nails and thread.

## Product Purpose

Thread Art turns an uploaded portrait into algorithmic string art in the browser: upload → drag a circular crop → optionally tune pins / coverage / darkness → watch a single black thread weave the portrait pin-by-pin around the ring, one greedy decision at a time, while an honest feet-of-thread counter ticks up. At completion: the final portrait, stats, a PNG download, and the full winding order as plain text — a blueprint you could actually follow with nails and thread.

It exists because people love the look of hand-made thread art but almost never see *how* it is made — the thousands of individual thread decisions. Existing tools either flash a final image or output dry instructions; none show the algorithm *thinking* in thread.

Success (approved acceptance criteria, verified in `docs/ultron/production-log.md`): time-to-first-thread < 2 s; smooth default-speed animation; default weave 1–3 min with speed control that materially changes duration; feet counter computed from real Euclidean chord geometry × declared 24 in board; likeness judged by human side-by-side (view-original toggle); determinism (same image + settings → identical artifacts); zero network after load; graceful mobile; reduced-motion instant path.

## Positioning

The animation is the product: a live view of the greedy algorithm making each thread decision, with numbers derived from real physics (chord lengths, pin geometry, declared board size). String-art tools that output final images or instruction lists cannot truthfully claim it. Deliberately experience-first, not fidelity-first — a visible fidelity score was rejected to protect the mystique.

## Operating Context

- Runs entirely in the browser tab: ~163 KB dependency-free vanilla JS (ES modules + Web Worker), no build step, served by any static server. Local dev: `python3 -m http.server` → http://localhost:8000. `file://` shows an in-page notice (browsers block module Workers there).
- Deployed via GitHub Pages Actions (`.github/workflows/deploy.yml`) at **https://thread.arrangedgodly.com/** (Cloudflare-proxied; the apex arrangedgodly.com serves a personal SPA, hence the subdomain).
- Physical mapping: the counter assumes a 24 in (61 cm) board; at defaults (~4,000 passes) that is ~7,000 ft of thread — in the range real string artists report.
- Terminology kept honest in-UI: pins, passes/threads, feet of thread, pin sequence / winding order.

## Capabilities and Constraints

Confirmed functionality (shipped):

- Upload via file picker, drag-and-drop, and clipboard paste; EXIF-safe decode; downscale to ~600 px working resolution; conditional contrast normalization (2nd→98th percentile stretch only when needed).
- Draggable circular crop (mouse, pen, touch, arrow-key nudge).
- Pre-start knobs: pins 200–500 (default 300), coverage 1,000–8,000 threads (default 4,000), darkness 4–32 (default 8 — calibrated), advanced min-chord-gap 0–25 with auto (pins ÷ 30, default on).
- Worker-driven greedy weave with precomputed chord tables (~100 ms to first thread); pause and 0.5×–16× speed during the weave.
- Live counters (feet, passes, progress) while weaving; completion state with stats, view-original toggle, PNG download, and `.txt` winding-order download with stats header.

Hard constraints:

- Evergreen browsers only; no legacy support.
- Determinism is contractual: same image + same settings → byte-identical PNG and `.txt` across worker/fallback, any speed, reduced-motion (completion replays the canonical sequence).
- Zero network activity after page load; the image never leaves the machine — stated in the UI and kept by architecture.
- Knobs are pre-start only: changing settings means a re-weave.

Non-goals (approved): scrub/replay timeline; before/after compare slider; live mid-weave parameter tweaking; multi-color threads; share links, persistence, gallery, auth; nail-hole template / physical print layout generator; any backend; user-visible fidelity score (mean pixel error stays an internal dev tool).

Open decisions: none confirmed. *(Inferred 2026-08-28 from an unanswered interview round: v1 is treated as shipped and accepted — the owner personally deployed it after the run closed; the MVP non-goals above are not known to be temporary.)*

## Brand Commitments

- Name: **Thread Art**. Tagline: "a portrait, woven from a single thread". Footer line: "Made of one thread, a ring of pins, and no server." Home: **https://thread.arrangedgodly.com/**.
- Voice (confirmed by approved shipped copy): plain-spoken and honest. Every number shown must be true and derivable; privacy and determinism are stated as facts, not marketing.
- *(Binding status inferred 2026-08-28 from an unanswered interview round, unconfirmed: name, tagline, and domain are treated as settled. No brand assets exist beyond the inline SVG favicon — no logo files, no palette documentation.)*

## Evidence on Hand

- `docs/ultron/town-hall.md` — approved scoping brief: problem, users, MVP, non-goals, acceptance criteria, decisions with rejected alternatives.
- `docs/ultron/plan.md` and `docs/ultron/research/` — approved 12-task plan; rq1–rq4 research records, decision matrix, likeness-evidence A/B lab results (JSON).
- `docs/ultron/production-log.md` — per-task verification evidence, FINAL ACCEPTANCE STATE (11/11 criteria), and the FL-1 likeness-fix record.
- `tests/engine.test.mjs` and `tests/acceptance.mjs` — runnable engine and acceptance tests.
- Live production deployment (green CI on every push).
- Absences future work must not fabricate: no user testimonials, usage analytics, user research, press, or customers; no original photography or brand asset library.

## Product Principles

1. **Show the thinking.** The animated weave is the product; pacing is a feature. Never trade the experience for raw output speed, and add no replay toys that dilute the meditation.
2. **Honest numbers or none.** Every displayed figure derives from real geometry and a declared mapping. Never a fake counter; never an invented claim.
3. **Nothing leaves the machine.** Client-side is structural privacy — promised in the UI and kept by architecture. No server, no network after load.
4. **Deterministic craft.** Same image + same settings must always weave the identical piece, byte-for-byte.
5. **Lean showpiece.** Curated defaults plus a few knobs. Resist playground scope creep; the approved non-goals guard the experience.

## Accessibility & Inclusion

Confirmed by shipped implementation and acceptance criteria: `prefers-reduced-motion` gets an instant stepped finish; all controls keyboard-reachable (crop nudges with arrow keys); canvases carry `role="img"` labels; counters update a throttled polite live region instead of spamming per-tick; exactly one `h1` names the visible stage; graceful mobile layout with touch crop drag.
