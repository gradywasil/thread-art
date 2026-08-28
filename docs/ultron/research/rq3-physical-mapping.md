# RQ3 — Physical mapping for the "feet of string used" counter

## Question + affected task IDs

**Question:** What physical mapping makes the live "feet of string used" counter HONEST and believable? Specifically: (1) assumed physical board diameter, (2) real thread spec (material/thickness) for the stats header and canvas line width, (3) sanity check of totals against real artists' reported lengths, (4) unit presentation (feet vs meters, phrasing of the assumption).

**Affected tasks:** T5 (counters: live feet counter), T7 (stats header + .txt download header fields)

## Constraints + evaluation criteria

- **Honesty:** the counter must be derivable from first principles the user can verify: sum of Euclidean chord lengths (virtual px) × (physical diameter / virtual diameter). No fudge factors, no fabricated numbers.
- **Believability:** final totals should land in the range real string-art portrait artists actually report (~1–3 km for dense circular portraits).
- **No fake numbers:** every constant shown in the UI/txt header (board size, thread spec) must trace to a real-world source or be labeled as an assumption.
- **No scope change:** pin count (~300) and pass count (~4,000) are fixed by scope; this RQ only picks the physical constants.

## Core formula

```
physical_length = Σ (chord_length_px) × (board_diameter_m / virtual_diameter_px)
feet            = physical_length_m × 3.28084
```

Average chord between two random pins on the circle = 4R/π = 2D/π ≈ 0.63662 × D.
Expected total ≈ passes × 0.63662 × D.

## Evidence (primary sources, links + exact claims + dates)

1. **Petros Vrellis — official "Knit" page** (the canonical algorithmic string-portrait reference), https://artof01.com/vrellis/works/knit.html (accessed 2026-08-27; work dated 2016):
   - "The loom is an 28'' aluminum rim, with 200 anchor pegs on its circumference."
   - The thread "is knitted as straight lines across the anchor pegs" "3.000 - 4.000 times", "reaching a total length of 1 - 2 kilometers."
   - → 28 in (71.1 cm) board, 200 pins, 3,000–4,000 passes, 1–2 km thread.
2. **Vice Creators Project article on Vrellis** (Nathaniel Ainley, 2016-07-28), https://www.vice.com/en/article/code-knitting-algorithms-woven-portraits/:
   - "1500 meters of thread"; the string crosses "from peg to peg 3000-4000 times, coming out to nearly a mile of string."
   - → Independent confirmation: 3,000–4,000 passes ≈ 1,500–1,600 m (1 mile = 5,280 ft).
3. **Reddit r/DIY + Imgur mirror — hobbyist portrait** (post au0ilz, 2019), https://www.reddit.com/r/DIY/comments/au0ilz/made_a_string_art_portrait_out_of_a_continuous_2/ and https://imgur.com/gallery/i-made-string-art-portrait-out-of-continuous-2-km-long-thread-ljoJeal:
   - "a continuous 2 km long thread" on a **42 cm diameter** circle; nails 2.2 × 40 mm; single sewing thread. (Search-indexed quote; Reddit bot-blocks direct fetch.) Note: 2 km at 42 cm exceeds the geometric maximum for ~2,400 connections, so this claim likely includes spool waste/wrap — treat as an upper bound of claimed lengths, not geometry.
4. **Facebook string-art groups** (via search index, 2020s): Edison Abazi "Girl in Gold" — "over 3.5 kilograms of nails and over 2,000 meters of thread" (https://www.facebook.com/nikita.nair.984/posts/5953719824729374/); another portrait "250 nails, a 3km long thread and over 2,400 connections" (https://www.facebook.com/groups/2177135245931362/posts/3243385612639648/). → Artist claims commonly land at 2–3 km.
5. **StringIT! automated string-art machine, Instructables** (2025), https://www.instructables.com/StringIT-Automated-String-Art-Machine/: thread portraits on a **60 cm circular wooden canvas** — direct precedent for 60 cm as a working circular-portrait board size.
6. **Thread specs — Gütermann Sew-all (the standard all-purpose thread):** https://consumer.guetermann.com/en/products/sew-all_thread/: 100% polyester, ticket No. 100, universal needle NM 70–90. Gütermann does not publish mm diameter; Tex/denier conversion (Coats thread numbering, https://www.coats.com/en/applications/technical-information/thread-numbering; Sailrite sizing guide, https://www.sailrite.com/Selecting-the-Right-Thread-Size) puts all-purpose polyester (Tex 30–40 / Serafil 60–40) at **~0.25–0.35 mm** diameter. Etsy cord listings sell 0.35 mm round waxed polyester cord explicitly for string art (e.g., https://www.etsy.com/in-en/market/00_nylon_thread, indexed listing: "0.35 / 0.45 / 0.55 / 0.65 mm round waxed polyester cord").
7. **Round string-art kit boards:** eBay mandala kit on a 50 × 50 cm round board (https://www.ebay.com/itm/204860453541); Pinterest string-art patterns on 40 × 40 cm boards. → Documented circular boards span ~40–71 cm.

## Options considered (board size → total at 4,000 passes, avg chord 2D/π)

| Board | Diameter | Total length | In feet | Verdict |
|---|---|---|---|---|
| 40 cm (16 in) | 0.40 m | 1,019 m ≈ 1.0 km | 3,342 ft | Low end; matches small kit boards; total feels slightly light vs artist claims |
| 42 cm (Reddit artist's actual) | 0.42 m | 1,070 m | 3,509 ft | Real precedent but small for a "portrait" |
| 50 cm (20 in) | 0.50 m | 1,273 m | 4,177 ft | Kit-typical; fine but rounder precedent exists at 60 cm |
| **24 in (60.96 cm) — RECOMMENDED** | 0.6096 m | **1,552 m ≈ 1.55 km** | **5,093 ft** | Mid-range of documented portrait looms (42–71 cm); matches StringIT's 60 cm build; total = "nearly a mile of string", exactly Vice's phrasing for Vrellis |
| 28 in (71.1 cm, Vrellis) | 0.7112 m | 1,811 m ≈ 1.8 km | 5,942 ft | Largest documented; honest but assumes the artist-grade loom |

## Model calibration (decisive sanity check)

Vrellis is the only artist with a full public spec (board + pins + passes + length), so calibrate against him:
- Model: 3,500 passes × 0.63662 × 0.7112 m = **1,585 m**
- Reported: "1 - 2 kilometers" (his site) and "1500 meters… nearly a mile" (Vice)
- **Error ≈ 6%.** The 4R/π mean-chord model reproduces real-world totals without any fudge factor. The formula itself is honest.

**Sanity check verdict at our scope (300 pins, 4,000 passes):**
- 24 in board → ~1.55 km ≈ 5,090 ft. Lands squarely inside the 1–3 km / "thousands of feet" band real artists report (1.5–2 km Vrellis, 2 km Reddit, 2–3 km Facebook artists). **NOT implausibly low or high — no adjustment needed.** If a future variant ever reads low, the dominant lever is pass count (total ∝ passes × D); board size moves it only ~±25% across the plausible 40–71 cm range.

## Recommendation

1. **Default board diameter: 24 in (0.6096 m; display as 24 in / 61 cm).** Why: (a) mid-range of every documented circular portrait board (42 cm Reddit → 60 cm StringIT → 71 cm Vrellis); (b) 24 in is a standard, familiar US board/round size (bicycle rim lineage of the art form uses 28 in, so 24 in reads authentic); (c) at the fixed 4,000-pass scope it yields ~5,000 ft ≈ 1.55 km — "nearly a mile of string," the exact figure Vice reported for the genre's most famous piece. Believability by construction.
2. **Thread spec: 100% polyester all-purpose sewing thread (à la Gütermann Sew-all, Tkt No. 100), thickness ≈ 0.3 mm** (documented band 0.25–0.35 mm). Use "0.3 mm polyester sewing thread" verbatim in the stats header.
3. **Formula (T5):** `feet = Σ chord_px × (0.6096 / virtual_circle_diameter_px) × 3.28084`, applied at display time only — never baked into the virtual geometry.
4. **Units:** live counter in **feet** (user-facing requirement). Stats header shows feet primary + meters secondary, e.g. `5,093 ft (1,552 m)`.
5. **TXT header phrasing (T7):** a literal line such as
   `Assumes a 24 in (60 cm) board; length = sum of thread segments × scale. Thread: black polyester sewing thread, ~0.3 mm.`
   Optionally add: `Length counts thread laid pin-to-pin; a real spool uses slightly more (wrap at pins).` — this one-line honesty note preempts the only systematic underestimate in the model.

## Tradeoffs / risks

- **Counter measures laid thread, not spool consumed.** Real artists' claims include wrap-around-pin waste and spool tails (the Reddit 2 km claim at 42 cm is geometrically impossible as pure chords — max ≈ 1.0 km — so claims can include ~2× waste or exaggeration). Our number is honest geometry; the optional txt note covers the gap. Risk: low.
- **4R/π assumes uniformly random pin pairs.** Real algorithms bias toward nearer pins, so our displayed total may run slightly high vs the true mean chord of our own paths — but we compute the ACTUAL sum of chords, so this only affects the prediction, never the counter's honesty. No risk to correctness.
- **24 in is an assumption, not a measurement.** Mitigated by stating it in the txt header verbatim (criterion: no fake numbers).
- **Meters-in-header:** costs a few characters; improves international believability and cross-checkability against the 1–3 km artist literature. Keep.

## Implementation consequences

- **T5 (counters):** compute `scaleFtPerPx = (0.6096 / virtualCircleDiameterPx) × 3.28084` once per canvas layout; accumulate `totalPx` as each chord is added; display `totalPx × scaleFtPerPx` (live) — formatting: integer feet with thousands separators. Never mutate stored geometry; the mapping is display-time only, so canvas resize cannot corrupt the total (recompute scale from current virtual diameter, keep `totalPx` canonical).
- **T7 (stats header + txt):** stats header fields: passes, pins, feet primary, meters secondary, thread spec line ("black polyester sewing thread, ~0.3 mm"). TXT download header must include: `Assumes a 24 in (60 cm) board` + the thread spec + (recommended) the laid-vs-spool note above.
- **Canvas line width (informative):** true 0.3 mm thread maps to ~0.4 px on an 800 px canvas (0.0003 m ÷ 0.6096 m × 800 px) — sub-pixel and invisible. Rendered stroke width stays a legibility choice (1–2 px); do NOT claim the on-screen stroke equals physical thread width. The 0.3 mm figure is for the stats header only.

## Decision priority + status

- **Priority:** P1 (blocks honest implementation of T5 counter semantics and T7 header fields).
- **Status:** COMMITTED CANDIDATE — default 24 in (60.96 cm) board, 0.3 mm black polyester sewing thread, feet-primary/meters-secondary, assumption line in txt header. Awaiting ratification in plan review.

## Delegation record

- Researched by: deep-research track agent (RQ3), ZCode subagent, 2026-08-27.
- Method: web search + primary-source fetches (artist pages, Vice article, Instructables build, supplier specs); analytic calibration against Vrellis's published loom spec.
