# Thread Art — Algorithmic Thread Art Generator

Upload a portrait. Watch a single black thread weave itself around 300 pins,
burning the image into the canvas one greedy decision at a time — while a counter
ticks up every foot of string used.

**Live:** https://thread.arrangedgodly.com/

## What it does

- **Upload → crop → weave.** Drop in any portrait, drag the circular canvas over
  the part you want, and press Start. A greedy algorithm — running in a Web
  Worker — evaluates every possible thread from the current pin, picks the one
  crossing the darkest path of pixels, draws it, mathematically lightens those
  pixels, and repeats thousands of times.
- **An honest counter.** The feet-of-string counter is computed from the actual
  Euclidean chord lengths between pins, scaled to an assumed 24 in (60 cm)
  board. At the default 4,000 threads that's roughly 7,000 ft — about 1.3 miles,
  squarely in the range real string artists report.
- **Walk away with artifacts.** Download a PNG of the finished weave, or the
  full pin-to-pin winding order as plain text — a blueprint you could actually
  follow with nails and thread.
- **Nothing leaves your machine.** All computation is client-side, in ~163 KB
  of dependency-free vanilla JS. No build step, no server, no network after load.

## Controls

| Knob | Default | Range |
|---|---|---|
| Pins | 300 | 200–500 |
| Coverage (threads) | 4,000 | 1,000–8,000 |
| Darkness (per-thread ink) | 8 | 4–32 |

During the weave: pause, 0.5×–16× speed. `prefers-reduced-motion` gets an
instant stepped finish instead of the ~67 s animation.

## Run it locally

```bash
python3 -m http.server
# open http://localhost:8000
```

Any static server works — no install, no build. (Opening `index.html` directly
via `file://` shows a notice: browsers block module Workers there.)

## How it works, briefly

1. **Ingest** — EXIF-safe decode, downscale to ~600 px, circular sample,
   conditional contrast normalization (2nd→98th percentile stretch, only when
   the input needs it).
2. **Precompute** — all C(300,2) = 44,850 chord pixel-index tables (~59 MB of
   typed arrays), built once in the worker so each greedy step is just cheap
   summations. ~100 ms from Start to first thread.
3. **Greedy weave** — from the current pin, score every candidate chord by
   summed remaining darkness, take the best (deterministic tie-break), subtract
   the ink delta, record the pass. Stops at the thread budget or after three
   consecutive steps with no improvement.
4. **Animate** — the renderer draws threads at up to 60/s from streamed worker
   batches; at completion the canvas is replayed once from the canonical
   sequence so every path (worker/fallback, any speed, reduced-motion) produces
   byte-identical results.

## Project history

This app was planned, researched, and built by an autonomous multi-agent run
(ultron-supreme: town-hall → plan → deep-research → production, 12 tasks each
worker-built and independently verified). The full paper trail — scoping brief,
plan, research records with benchmarks, and per-task verification evidence —
lives in [`docs/ultron/`](docs/ultron/).
