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

The script needs Node.js 22.2 or newer. It reads ZIP entries in memory using Node's bounded decompressor; no `unzip` executable or extraction directory is needed. It downloads only the named compact feed, limits compressed input to 16 MiB, a decoded table to 32 MiB, and the total declared decoded archive to 64 MiB. A forged uncompressed size cannot bypass the actual decompression limit. Central/local headers, CRC checksums, duplicate names and unsafe paths are checked before use. Required tables must be present; optional tables come only from the current archive.

The 12-hour cache age is measured from retrieval time, so repeated ingestion cannot make an old download appear newly retrieved. Cache metadata includes the archive's SHA-256 hash. Parsing, calendar checks, indexing and the bundle-size guard all finish before cache/output promotion. File writes use unique temporary files and atomic renames; failed downloads or malformed feeds preserve the last good output and cache. No archive file is extracted onto disk.

## Attribution and dates

Source: **DELFI e.V. / gtfs.de**, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Required credit is carried into every API response: “Timetable data: DELFI e.V. / gtfs.de (CC BY 4.0), © OpenStreetMap contributors”. The feed registry records the [publisher's licensing page](https://gtfs.de/en/license/).

Each response includes source attribution, download URL, retrieval time, publisher Last-Modified value, ingestion timestamp, and calendar coverage. All weekly operating patterns and `calendar_dates.txt` additions/removals are preserved, including exception-only feeds and day 30 in the second calendar bit field. An unknown service calendar, invalid weekday/exception, duplicate identifier, bad reference, malformed CSV row, invalid boarding permission or non-monotonic call fails ingestion. This prevents silently replacing good data with a partial timetable. The optional `feed_info` interval further restricts published coverage. Dates outside that bounded interval are refused. The maximum encodable interval is 60 days; a larger feed fails ingestion instead of truncating its calendar silently.

This importer supports fixed, minute-precision timetables whose agency clocks are `Europe/Berlin` and whose service-day times are below 48:00. Other timezones, nonzero seconds, and nonempty `frequencies.txt` or `transfers.txt` rules fail explicitly. Frequency expansion and publisher-specific transfer overrides must be implemented before accepting such a feed. These constraints are checked against the [GTFS schedule reference](https://gtfs.org/documentation/schedule/reference/).

## Search behavior

`worker/edge-rail.js` exports `edgeRailSearch(input)`. It accepts `from` and `to` coordinates, a date in `YYYY-MM-DD` or numeric `YYYYMMDD` form, and an optional integer `departHour` (default 8). Missing date means today in Europe/Berlin. It returns the existing server journey shape plus `sources`, `generatedAt`, `date`, `calendar: { from, days }`, and an explicit `searchScope` description.

- Searches direct and one-change long-distance trains, with up to eight useful alternatives. A direct train is also considered for faster interchanges before its destination call. Routes requiring more changes can be absent.
- Uses stations within 8 km of each city coordinate. Journeys are station-to-station; travel from the city coordinate to the station is not included in duration.
- Honors normal GTFS pickup/drop-off permissions. Arrival-only stops cannot be used for boarding. On-request calls are not offered.
- Retains the publisher's trip ID separately from its route label. Two different trains both labeled “ICE” remain two legs and a transfer.
- Uses an eight-minute minimum interchange allowance and permits connections with up to three additional hours of waiting. These are planning assumptions, not operator connection guarantees.
- Walking links use an exact build-time distance comparison for all compact-feed stations (at most 800 m, at 80 m/min rounded up to the next minute). This avoids missed links at higher latitudes and understating a short walk. Paths, accessibility, and station layouts are not verified.
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
| Network gzip after correctness audit | 660,394 bytes |
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

The production measurements above were captured on deployment `fb44f9a6b870465d9392b24ecd3336b2`, before the later correctness audit below. All observed requests succeeded without exceptions. Warm and other measured routes used 5–9 ms CPU, while the first search used 12 ms and still exceeded the nominal 10-ms free allowance. The optimization reduced the earlier 23-ms cold search and 21-ms Hamburg–Frankfurt measurement, but does not guarantee every route stays below that allowance. No paid-plan upgrade was performed; monitor platform CPU before increasing traffic or coverage.

The local initialization comparison alternated six fresh Node processes per version and searched Berlin–Munich, Hamburg–Cologne, and Berlin–Hamburg on September 10. All three returned eight journeys, and the complete response hashes matched before and after the change. These wall timings are not Cloudflare CPU measurements.

The route optimizer builds transfer lists only from trains serving the destination, removes dominated candidates with an O(n log n) scan, and creates full journey objects only for the final eight choices. Hamburg–Frankfurt previously constructed 3,172 full objects to retain 741 train combinations; it now constructs at most eight. An earlier interleaved Node benchmark reduced its warm median from 3.30 to 2.14 ms over 24 samples per version. Exact response comparisons for that optimization across 228 route/date/hour queries preserved all 999 journeys, including three sleepers.

The subsequent correctness audit replayed **224 route/date/hour queries**, checking **815 journeys / 1,303 train legs** against the packed timetable's exact calls, legal boarding/alighting and calendar masks. No fastest-result regression occurred; 32 responses changed their useful alternatives after considering interchanges on direct trains. A constructed timetable independently verifies the formerly missed case: a 10:00 train arriving directly at 15:00 can change at 11:00 to an 11:10 train arriving at 12:00. Fifty interleaved warm Hamburg–Frankfurt samples measured **0.96 → 1.05 ms median** in Node for this correctness change. These are local wall timings; the revised router has not inherited the earlier production CPU measurements.

The focused offline suite (`node --test worker/edge-rail.test.js`) covers malformed/quoted CSV, ZIP traversal and duplicate paths, CRC corruption, header disagreement, both declared and actual decompression limits, atomic refresh failures, calendar boundaries/removals, exception-only refreshes, restricted calls, insufficient interchange time, strict dates, equal-label train identity and high-latitude walking links. Fixtures use isolated temporary workspaces and never download data. Ingestion also caps the indexed timetable at 3,000 stations, 25,000 trips and 250,000 calls before index construction.

The packaged Worker must be checked on deployment: the network gzip measurement excludes other application code, and Node timings are not Cloudflare CPU measurements. Cloudflare currently documents a [3 MiB compressed free bundle, 128 MB isolate memory, 10 ms free request CPU, and 1-second startup limit](https://developers.cloudflare.com/workers/platform/limits/). A free Worker can still reach its CPU limit on cold or unusually expensive searches; verify startup and request CPU for the updated production version before widening coverage. Ingestion refuses a network above 2 MiB gzip so the rest of the Worker has headroom.

Validation independently compared **161,727 calendar bits** with the raw weekly calendar and date exceptions. Across **33 route/date queries**, **176 returned journeys / 241 train legs** were checked against their original service IDs, calendar days, exact timetable minutes, legal pickup/drop-off calls, chronological order, transfer counts, and null fares. Tests also covered invalid coordinates, invalid dates, invalid hours, dates outside both calendar boundaries, and equivalence of ISO/numeric input dates. The public app's Berlin–Munich search returned eight actual alternatives on September 10, with a fastest scheduled station-to-station duration of 239 minutes.

### Numeric candidate keys

The final candidate-map adjustment replaces allocated string keys with `si * (serviceCount + 1) + nextSi + 1`. Direct journeys use `nextSi = -1`, which maps to slot zero; connecting service positions occupy distinct remaining slots. The stride prevents collisions, and the 25,000-trip ingest limit keeps every key exactly representable. No query, traveler or result cache is introduced.

After the file change, **96 complete responses containing 360 journeys** matched the prior string-key implementation exactly across six route pairs, four dates and four departure hours; all focused rail tests passed. In the preceding read-only experiment, **100 interleaved Hamburg–Frankfurt samples** measured **1.84 → 1.40 ms median** (about 24% less) for numeric keys. Result normalization alone measured 0.11 ms median. These are **Node wall-time measurements, not Cloudflare request CPU**; they do not establish improved cold-request CPU or compliance with the free-tier CPU allowance. A new deployed measurement is required for that claim.
