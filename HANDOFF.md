# Nightjet Atlas — handoff

**Repo:** https://github.com/windcrash64/nightjet-atlas (public, MIT)
**Local:** `C:/Users/nalba/Documents/nightjet`
**Status as of 2026-08-31:** built, tested, verified in a browser. Not yet deployed.

## What it is

A journey planner whose signature move is a Marey/Ibry stringline drawn against
the real computed sky. It leads with European night trains — the journeys that
flight search structurally cannot argue for — and does full door-to-door
multimodal routing underneath.

Rebuilt from scratch, replacing the earlier `Documents/Travel App` prototype
whose data was invented (fictional airlines "Skyline Air"/"Orbit Pacific",
fares from a `distance * coefficient` formula, 24 hardcoded cities).

## Verified working (evidence, not assertion)

| Check | Result |
|---|---|
| `npm test` | 22/22 pass, no network needed |
| `npx vite build` | clean, 69 KB gzipped total |
| Pages Functions | tested directly in Node: 4/4 validation cases return correct 400s; real routing returns 6 itineraries with 6 NIGHT_RAIL legs |
| Browser, desktop 1440 | screenshotted; stringline renders correctly |
| Browser, mobile 390 | screenshotted; chart height bug found and fixed |
| Production bundle | served from `dist/` and verified with live data |

Real data confirmed on screen: ÖBB **NJ 40233** Wien Hbf 18:10 → Bologna
Centrale 06:25, connecting to Trenitalia **FR** to Roma Termini. 69% after dark,
12h 15m in a bed.

## The one thing left

**Deploy needs `npx wrangler login`** — interactive browser OAuth that a session
cannot complete on your behalf. After that:

```bash
npm run build
npx wrangler pages deploy dist
```

`wrangler.toml` is already configured (`pages_build_output_dir = "dist"`,
`compatibility_date = "2026-08-04"`). No secrets or env vars are required —
every upstream is keyless.

## Constraints that shape this project

**Transitous prohibits commercial use and requires consuming projects be open
source.** That is why the repo is public and MIT. Going commercial means
replacing the backend with self-hosted MOTIS (MIT, verified actively maintained).
It also requires an identifying User-Agent (set in both functions) and a visible
link to transitous.org/sources (in the footer).

**There is no free real flight-price API in 2026.** Amadeus Self-Service was
decommissioned 2026-07-17; Duffel's terms ban metasearch; scraping Google Flights
violates robots.txt. This is why the product leads with time and sleep rather
than price, and why `price` is `null` everywhere with a test enforcing it.

Full reasoning, including every rejected source, is in `DATA_SOURCES.md`.

## Known gaps

- **Coverage is uneven.** Strong in Europe/Japan/US-NE; Istanbul returns zero
  itineraries; Barcelona→Palma finds no ferry. The app says so rather than
  implying no route exists.
- **No fares anywhere.** By design — see above.
- **`src/data/airports.json` is built but not yet used by the UI.** 4,132 real
  airports are bundled and ready for an airport-aware mode; the current search
  is transit-only.
- **Times display in UTC**, not local. Correct but not friendly; the per-leg
  `tz` field from MOTIS is available to fix this.
- **The night-train seed list is 5 routes**, from a scan that found 8 across 448
  European city pairs. Live search is not limited to these.
- **workerd crashes locally on this Windows machine**, so `wrangler pages dev`
  could not be used. Functions were verified directly in Node instead; the same
  handler code runs in both.
