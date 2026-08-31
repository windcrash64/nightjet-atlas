# Nightjet Atlas

**Some journeys happen while you sleep.** This is a journey planner that draws
the night.

Europe still runs sleeper trains. Flight search cannot show you why that
matters, because a bed is not a price and darkness is not a duration. Rome2Rio
renders the ÖBB Nightjet from Vienna to Rome as one flat row —
`Night train 14h TRY3,300–8,500` — ranked below a flight badged "BEST", with no
departure time, no arrival time, and no indication that eight of those fourteen
hours are spent asleep in a bed. A model of `[mode][duration][price]` is
structurally incapable of making the argument for a night train.

So this one draws the journey instead.

## What it does

Every journey renders as a **Marey/Ibry graphical train schedule** — the 1878
form that made railway timetables legible, and the cover of Tufte's *Visual
Display of Quantitative Information*. Time runs left to right, distance bottom
to top; the slope of the line is speed and a flat step is a stop.

Behind the line is **the real sky**. Civil, nautical and astronomical twilight
are computed from the sun's actual position along the route — interpolated to
the traveller's moving coordinates, because an eastbound night train really does
meet dawn earlier than the city it left. Those bands are not decoration; they
are the argument. A night train draws a long line straight through the dark and
arrives in the morning. A day journey draws a short scratch across the light.

Verified example, live from the API:

```
Vienna 18:07 ────────────────────→ Rome 09:14 (+1)
NJ 40233 · ÖBB · 15h 07m · 1 transfer · 69% after dark
12h 15m in a bed — you arrive the next morning without paying for a hotel night
```

It also does ordinary door-to-door multimodal routing — address to address,
including the local legs at both ends that flight search ignores. Heathrow
Terminal 2 to Charing Cross is 49 minutes on the Heathrow Express and the
Bakerloo line, and that is part of your journey whether or not anyone shows it
to you.

## What this app refuses to do

**It never shows a price, and it never estimates one.** Open transit data
carries schedules, not fares. There is no free, legitimate source of real
European rail prices — this was researched thoroughly and the honest answer is
that Amadeus Self-Service was decommissioned in July 2026, Duffel's terms
prohibit metasearch, and scraping Google Flights violates its `robots.txt`. So
where a fare exists the app links to the operator who sells it, and where one
does not it says so. A `price` field that is `null` stays `null`; there is no
code path that invents a number. There is a test that enforces this.

**It never claims data it did not receive.** Every leg carries a source state —
`live` when the operator is reporting realtime data, `scheduled` when it is a
published timetable, `walking` when there is no service to be late. Live data
gets the only saturated colour on the page. Where routing fails, the app shows
nothing rather than something plausible.

**It does not pretend its coverage is universal.** Open transit feeds are strong
across Europe, Japan and parts of North America, and thin or absent elsewhere.
Istanbul returns no itineraries. That is a gap in the data, and the app says so
rather than implying no route exists.

## Design

The palette follows Cassandre's *Nord Express* (1927) — "a polyphony of greys:
the cold smoke, the polished steel of the rods, the velvet depth of the sky. At
their heart, a single red flares." A wide tonal blue-grey range carries all the
information, and exactly one saturated red is reserved for live realtime data.
Data honesty becomes the loudest colour on the page instead of a footnote —
which is the right emphasis, because the most common complaint from real
Nightjet riders is delays.

Type is **Overpass**, drawn from the 1945 FHWA highway signage alphabet, with
Overpass Mono for times and tabular figures.

The line draws on load and then holds before settling — after Hans Hilfiker's
1944 Swiss railway clock, whose second hand sweeps in 58.5 seconds and then
*pauses* at twelve awaiting the master impulse. Motion that waits rather than
eases. It respects `prefers-reduced-motion`.

## Running it

```bash
npm install
npm run dev          # Vite dev server
node dev-proxy.mjs   # serves the two API functions locally, in another shell
```

Then open http://127.0.0.1:5180.

```bash
npm test             # 22 tests, no network required
npm run build        # ~69 KB gzipped
npm run data:airports  # regenerate the airport dataset from OurAirports
```

## Deploying

Static assets plus two Cloudflare Pages Functions. There is no server to run.

```bash
npm run build
npx wrangler pages deploy dist
```

The functions in `functions/api/` proxy Transitous server-side — necessary
because its policy requires an identifying `User-Agent`, which a browser cannot
set — and cache responses at the edge to keep load off a volunteer service.

Deliberately **not** Next.js: a hello-world Next app on the Cloudflare adapter
measures 940 KB gzipped against a 3 MB free-tier Worker limit, before any
application code. This app is 69 KB, and static assets do not count against that
limit at all.

## Licence and data

The code is MIT. **The data is not**, and one of its constraints shapes this
whole project: Transitous prohibits commercial use and requires that consuming
projects be open source. This app is therefore open source and non-commercial by
design — that is the condition under which the data may be used at all.

Read [DATA_SOURCES.md](DATA_SOURCES.md) before deploying anything. It records
every source, its licence, its attribution requirement, and the sources that
were investigated and rejected, with the reasons.

Routing and place search by [Transitous](https://transitous.org/) (MOTIS) over
open transit feeds — [data sources](https://transitous.org/sources/). Geometry
© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Airport
data from [OurAirports](https://ourairports.com/data/) (public domain).
