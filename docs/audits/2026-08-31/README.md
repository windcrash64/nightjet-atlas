# Visual audit — 2026-08-31

Captured from the live production deployment at
https://nightjet-atlas.pages.dev, with real data from Transitous (the
Vienna→Rome default, showing ÖBB Nightjet NJ 40233).

| Viewport | File |
|---|---|
| 360 (small phone) | `atlas-360.png` |
| 768 (tablet) | `atlas-768.png`, `atlas-768-search.png` |
| 1440 (desktop) | `atlas-1440.png` |

## Defects found by looking at the render

These were all caught in the screenshot-critique loop, not by reading code:

1. **Twilight bands rendered as vertical stripes.** Each band ended at its last
   sample rather than at the next band's first, opening a one-sample gap that
   read as a gap in the sky. The underlying sun math was correct — 7 clean
   bands in a dusk→night→dawn arc — so this was purely a rendering fault.
2. **Daylight was a bright slab that stole the emphasis.** The night is the
   subject of this picture; a glaring day block inverted that. Held daylight
   back to a dim slate.
3. **The chart collapsed to ~100px tall on a phone**, turning every label into
   an unreadable speck. The component now swaps to a squarer viewBox below
   720px, and the steeper slope actually reads more dramatically.
4. **The arrival point collided with the frame** — it is the payoff of the
   drawing and needed air around it.
5. **The gold sleeper line was unlabelled.** Now reads `asleep · NJ 40233`,
   rotated to run along the line at its exact angle, as a Marey chart labels
   its trains.
6. **Duplicated `clipPath` id** across all six charts on the page, which would
   have made every chart clip to the first one's geometry once the mobile and
   desktop boxes diverged.
7. **Meta-line separators jammed together** (`15h 07m·1 transfer·69% after
   dark`) because Overpass draws `·` with narrow sidebearings.

## What was checked and is correct

- Search row at 768 has room; the 720px breakpoint is right.
- Six journeys render simultaneously without the charts interfering.
- Daytime journeys draw pale wide bands and sleepers draw dark ones, so the
  comparison the product exists to make is visible at a glance.
- Live/scheduled source-state badges render on every transit leg.
- "No fare shown" appears on every journey, with an operator link where the
  feed supplies one.
