# Travel Freely

**Find a trip that leaves room in your budget for being there.**

[Open the live beta](https://travel-freely.windcrash64.workers.dev/)

Travel Freely is a student-friendly travel planning beta, built from Nightjet Atlas. It brings flight search handoffs, real train timetables, a globe, and a whole-trip budget into one interface. The React app and its API are designed to run together on Cloudflare Workers with Static Assets.

The current interface and streaming backend were deployed and verified on September 9, 2026. Source changes are on `codex/travel-freely` in [draft PR #1](https://github.com/windcrash64/nightjet-atlas/pull/1); the branch has not been merged into `master`.

## Current implementation

- Search cities and airports, choose a date and transport modes, and compare returned journeys by duration, changes, and available prices. Provider results appear independently as they arrive; stopping a search keeps received options, and an individual provider can be retried.
- Search a bundled Germany long-distance timetable: **656 stations and 5,217 trips** in the September 9, 2026 snapshot. Direct and one-change trains use real service calendars and boarding restrictions. International coverage is limited to services present in that feed.
- Open flight comparison and operator sites for the selected route. A server-side Skyscanner Live Prices adapter is implemented, but **an approved partner key has not been configured**. Flight handoffs work without that key; live flight quotes do not.
- Open FlixBus, rail operators and Google Maps transit. The Maps handoff includes the selected coordinates; choose the date and time there. Transit can include buses, trains or metro, and the link does not provide fares or guarantee metro-only routing. The bundled timetable contains no bus or metro services.
- Plan a budget with your own baggage and transfer costs; inspect nearby airports and save plans on this device. Saved plans restore their estimates, while changed trip details mark them for review before a budget total is treated as current.
- See timetable attribution, dates, and coverage limitations alongside results. Unknown prices stay unknown.

Search validation checks selected suggestions, coordinates, real dates from today through the next 365 days, and one to eight adults. Interrupted streams, rate limits and malformed provider responses have explicit states; late responses cannot replace a newer search. Restored saved plans are validated before use. Opening a saved trip whose date has passed searches tomorrow and prompts a budget review.

Rail durations are station-to-station. Flight durations, when a provider is connected, are airport-to-airport. Ground access, check-in, separate-ticket protection, and complete door-to-door routing are not solved by this beta. The app has no checkout or payment processing and does not sell tickets.

## Run locally

Use Node.js 24. The compact timetable path uses Node's bounded ZIP reader and does not require `unzip`.

```sh
npm ci
npm run data:edge
npm run build
npm run dev:api
```

In a second terminal:

```sh
npm run dev
```

Vite serves the UI on port 5173 and proxies `/api` to the local Worker on port 8787. The initial build supplies the Worker's Static Assets directory. Re-run `npm run data:edge` to refresh the generated timetable; no large multi-country download is needed for this path.

```sh
npm run check
```

This runs the application tests, Worker tests, deployment-pipeline tests, and production UI build. Provider HTTP tests use fixtures; passing them does not establish that a flight-provider account is approved or connected. The generated timetable remains an explicit prerequisite; tests and packaging do not silently download it.

## Publish and maintain

See [DEPLOY.md](DEPLOY.md) for Cloudflare deployment, secrets, daily timetable refresh, and the optional original Node server. Refresh the timetable, then run the checked deployment entry point:

```sh
npm run data:edge -- --force
npm run deploy
```

For an explicit package-and-publish sequence:

```sh
npm run check
node scripts/build-cloudflare.mjs
node scripts/deploy-cloudflare.mjs deploy
```

`npm run deploy` runs checks, creates the package, publishes it, and verifies public assets and API behavior. Packaging rebuilds the UI, requires tomorrow in UTC to be within the timetable calendar, and rejects source retrieval timestamps older than seven days. Package hashes and source fingerprints prevent publishing changed files under an older build. Running the deployment helper without a command only prints help.

Publishing needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in its environment. It records the previous Worker versions in a non-secret receipt before publication, then verifies the new public build. If verification fails after publication, inspect that receipt and follow the explicit rollback procedure in [DEPLOY.md](DEPLOY.md); rerunning the command is not a rollback. The live beta passed public asset, build identity, API, streaming and browser checks. Clean GitHub CI passed all checks; 201 tests passed locally, with 15 optional legacy full-network tests skipped.

The [GitHub Actions workflow](.github/workflows/deploy.yml) supports manual deployment and a daily 05:30 UTC timetable refresh after it is merged into `master` and its two Cloudflare repository secrets are configured. **Those GitHub secrets are not configured yet; scheduled production refresh is not active.** Missing credentials fail clearly. The workflow does not commit generated data or change branches.

## Data and architecture

The hosted beta bundles only the small DELFI / gtfs.de long-distance feed under CC BY 4.0. Its initial calendar spans **September 5–October 5, 2026**; subsequent ingests use the publisher's actual coverage. Out-of-range searches are refused. Train fares are unavailable in this feed; a connected flight provider can supply real quotes.

The compact ingester checks archive sizes and checksums, CSV structure, identifiers, calendars and stop permissions before replacing a good timetable. Failed downloads or malformed feeds retain the previous output. Routing considers faster interchanges even when the first train also runs directly to the destination, and walking transfers use bounded distance estimates rounded up to whole minutes. [EDGE-DATA.md](docs/EDGE-DATA.md) records the supported source constraints and validation evidence.

The original `scripts/ingest.mjs`, `server.mjs`, and RAPTOR-style rail engine remain available for an optional separately hosted multi-country backend. That separate ingester still uses `unzip`. Its much larger dataset is not the Cloudflare beta's coverage. Review its source licenses and size the host before enabling it.

- [Cloudflare API and provider contract](docs/CLOUDFLARE.md)
- [Bundled rail data, refresh, and validation](docs/EDGE-DATA.md)
- [Data sources and licenses](DATA_SOURCES.md)
- [Developer handoff](HANDOFF.md)

Code: MIT. Map geometry: [Natural Earth](https://www.naturalearthdata.com/), public domain via world-atlas. Airport reference data: [OurAirports](https://ourairports.com/data/), public domain. Data-provider licenses remain separate from the code license.
