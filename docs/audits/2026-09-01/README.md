# Visual audit — 2026-09-01

Captured from the running app (Vite + the local routing server) with four
countries ingested: Germany, France, Spain and Switzerland.

| View | File |
|---|---|
| Phone, Berlin→Munich | `mobile-390-ranked.png` (and `mobile-390.png`, before the ranking fix) |
| Tablet | `tablet-768.png` |
| Desktop, Frankfurt→Vienna with sleepers | `frankfurt-vienna-1440.png` |
| Desktop, Zurich→Milano | `zurich-milano-1440.png` |
| Map framing on a short journey | `globe-close-framing.png` |

## Defects found by looking at the render

1. **A dominated journey led the list.** Berlin→Munich opened with an 08:00
   arriving 16:20, above a 09:36 direct arriving 13:43 — leaving 96 minutes
   earlier to arrive 157 minutes later. An unconditional "earliest departure"
   pick skipped the dominance check, and the filler loop had the same hole.
2. **A short journey sat in an empty frame.** Zurich→Milan was two dots and a
   scratch, because the camera's closest distance was tuned for journeys the
   length of Berlin–Madrid.
3. **Station markers held a fixed world size**, so they became invisible specks
   when the camera closed in and blobs when it pulled back.
4. **The map was letterboxed to 4:3 on phones**, squeezing Europe into a strip.
5. **The attribution printed twice**, because two ingested feeds share one
   attribution string.
6. **Typing into a populated field appended** rather than replaced, so clicking
   "Berlin Hbf" and typing "Madrid" gave "MadridBerlin Hbf".

## Verified working

- Four countries' attributions all render, plus the retrieval date that EU
  Delegated Regulation 2017/1926 Art. 8(3) requires.
- Badges are computed from the result set: "Fastest", "Sleep through it" with
  the hours asleep, "No changes".
- Sleeper legs draw in gold on the map and as a gold chip in the list.
- Search returns in 50–800ms; repeat searches hit the cache at ~30ms.
- English city names resolve to local ones (Vienna→Wien, Munich→München,
  Cologne→Köln, Milan→Milano).
