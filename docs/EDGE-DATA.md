# Rail timetable on Cloudflare

The hosted rail API uses the small [Germany long-distance GTFS feed](https://download.gtfs.de/germany/fv_free/latest.zip), published by gtfs.de with data from DELFI e.V. The full multi-country `network.json` is not loaded in a Worker. This deployment returns real scheduled trains for the dates in the downloaded feed. It does not claim live availability, ticket prices, exhaustive routing, or Europe-wide coverage.

## Refresh and build

From the repository root:

```powershell
node scripts/ingest-edge.mjs
# Bypass the 12-hour download cache when necessary:
node scripts/ingest-edge.mjs --force
```

This writes the generated, gitignored `src/data/edge-network.json`. Run it before building or deploying the Worker. A new ingestion must be deployed to update the hosted timetable; this script does not create a background schedule. If the publisher cannot be downloaded, ingestion fails and leaves the previous output untouched. Expired deployed data produces an explicit coverage response instead of pretending trains operate every day.

The script needs Node.js and `unzip`. On Windows it recognizes Git's `C:/Program Files/Git/usr/bin/unzip.exe`; `EDGE_UNZIP` can select another executable. It downloads only the named compact feed, caps the archive at 16 MiB, extracts only the expected GTFS filenames into `data/cache/edge-fv-free`, and never modifies the full ingester or its cache folders.

## Attribution and dates

Source: **DELFI e.V. / gtfs.de**, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Required credit is carried into every API response: “Timetable data: DELFI e.V. / gtfs.de (CC BY 4.0), © OpenStreetMap contributors”. The feed registry records the [publisher's licensing page](https://gtfs.de/en/license/).

Each response includes source attribution, download URL, retrieval time, publisher Last-Modified value, ingestion timestamp, and calendar coverage. All weekly operating patterns and `calendar_dates.txt` additions/removals are preserved. A service with no known calendar is excluded. Dates outside the actual bounded feed interval are refused, and malformed dates are rejected. The maximum encodable interval is 60 days; a larger feed fails ingestion instead of truncating its calendar silently.

## Search behavior

`worker/edge-rail.js` exports `edgeRailSearch(input)`. It accepts `from` and `to` coordinates, a date in `YYYY-MM-DD` or numeric `YYYYMMDD` form, and an optional integer `departHour` (default 8). Missing date means today in Europe/Berlin. It returns the existing server journey shape plus `sources`, `generatedAt`, `date`, `calendar: { from, days }`, and an explicit `searchScope` description.

- Searches direct and one-change long-distance trains, with up to eight useful alternatives. Routes requiring more changes can be absent.
- Uses stations within 8 km of each city coordinate. Journeys are station-to-station; travel from the city coordinate to the station is not included in duration.
- Honors normal GTFS pickup/drop-off permissions. Arrival-only stops cannot be used for boarding. On-request calls are not offered.
- Retains the publisher's trip ID separately from its route label. Two different trains both labeled “ICE” remain two legs and a transfer.
- Uses an eight-minute minimum interchange allowance and permits connections with up to three additional hours of waiting. These are planning assumptions, not operator connection guarantees.
- Walking links between nearby stops are the existing router's distance estimates (at most 800 m, about 80 m/min). Paths, accessibility, and station layouts are not verified.
- Preserves GTFS service-day times beyond midnight. Initial boarding is restricted to the selected calendar date; next-day connecting trains expressed as a new service day are not searched. Overnight transfer coverage is therefore incomplete.
- Every train leg and journey has `price: null`. No fare, availability, student discount, local train, metro, or bus schedule is fabricated.

An empty result means no direct/one-change route was found **in this feed**. It does not mean travel is impossible. Operator booking/search links remain the next step for ticket prices and unsupported routes.

## Size and validation

Measured on **2026-09-09** using the publisher archive last modified **2026-09-05 08:37:08 GMT**:

| Measurement | Result |
| --- | ---: |
| Downloaded archive | 395,749 bytes |
| Stations | 656 |
| Trips | 5,217 |
| Scheduled calls | 52,878 |
| Calendar interval | September 5–October 5, 2026 (31 days) |
| Rejected malformed trips | 0 |
| Network with precomputed lookup tables | 3,640,266 bytes |
| Network gzip | 660,368 bytes |
| Deployed Worker startup | 20 ms |
| Deployed first Berlin–Munich request CPU | 12 ms; outcome `ok` |
| Deployed repeat Berlin–Munich / reverse route CPU | 8 / 5 ms; outcomes `ok` |
| Deployed Hamburg–Frankfurt request CPU | 9 ms; outcome `ok` |
| Local median first request, before → after initialization change | 12.61 → 11.89 ms wall time |
| Local median module import, before → after | 29.49 → 30.16 ms wall time |
| Local median warm request, before → after | 3.96 → 4.16 ms wall time |
| Node post-GC heap used | 14.37 MB |
| Node retained ArrayBuffers | 0.85 MB |

The ingester computes immutable stop/departure lists and packed-column values at build time. The Worker imports the JSON as bundled data and hydrates its typed arrays once during module initialization. Requests read this prepared timetable; hydration no longer consumes the first search's request CPU allowance. This startup work performs no network call or filesystem read and stores no traveller/request data globally. Unneeded JSON copies are released after initialization.

The production measurements above were captured on deployment `fb44f9a6b870465d9392b24ecd3336b2`. All observed requests succeeded without exceptions. Warm and other measured routes used 5–9 ms CPU, while the first search used 12 ms and still exceeded the nominal 10-ms free allowance. The optimization reduced the earlier 23-ms cold search and 21-ms Hamburg–Frankfurt measurement, but does not guarantee every route stays below that allowance. No paid-plan upgrade was performed; monitor platform CPU before increasing traffic or coverage.

The local initialization comparison alternated six fresh Node processes per version and searched Berlin–Munich, Hamburg–Cologne, and Berlin–Hamburg on September 10. All three returned eight journeys, and the complete response hashes matched before and after the change. These wall timings are not Cloudflare CPU measurements.

The route optimizer builds transfer lists only from trains serving the destination, removes dominated candidates with an O(n log n) scan, and creates full journey objects only for the final eight choices. Hamburg–Frankfurt previously constructed 3,172 full objects to retain 741 train combinations; it now constructs eight. An interleaved Node benchmark reduced its warm median from 3.30 to 2.14 ms over 24 samples per version. Exact response comparisons across 228 route/date/hour queries preserved all 999 journeys, including three sleepers. All 23 Worker tests pass, including strict dominance-boundary and generated-timetable regressions.

The packaged Worker must be checked on deployment: the network gzip measurement excludes other application code, and Node timings are not Cloudflare CPU measurements. Cloudflare currently documents a [3 MiB compressed free bundle, 128 MB isolate memory, 10 ms free request CPU, and 1-second startup limit](https://developers.cloudflare.com/workers/platform/limits/). A free Worker can still reach its CPU limit on cold or unusually expensive searches; verify startup and request CPU for the updated production version before widening coverage. Ingestion refuses a network above 2 MiB gzip so the rest of the Worker has headroom.

Validation independently compared **161,727 calendar bits** with the raw weekly calendar and date exceptions. Across **33 route/date queries**, **176 returned journeys / 241 train legs** were checked against their original service IDs, calendar days, exact timetable minutes, legal pickup/drop-off calls, chronological order, transfer counts, and null fares. Tests also covered invalid coordinates, invalid dates, invalid hours, dates outside both calendar boundaries, and equivalence of ISO/numeric input dates. The public app's Berlin–Munich search returned eight actual alternatives on September 10, with a fastest scheduled station-to-station duration of 239 minutes.
