# Travel Freely

**Find a trip that leaves room in your budget for being there.**

[Open the live beta](https://travel-freely.windcrash64.workers.dev/)

Travel Freely is a student-friendly travel planning beta, built from Nightjet Atlas. It brings flight search handoffs, real train timetables, a globe, and a whole-trip budget into one interface. The React app and its API are designed to run together on Cloudflare Workers with Static Assets.

## What works today

- Search cities and airports, choose a date and transport modes, and compare returned journeys by duration, changes, and available prices.
- Search a bundled Germany long-distance timetable: **656 stations and 5,217 trips** in the September 9, 2026 snapshot. Direct and one-change trains use real service calendars and boarding restrictions. International coverage is limited to services present in that feed.
- Open flight comparison and operator sites for the selected route. A server-side Skyscanner Live Prices adapter is implemented, but **an approved partner key has not been configured**. Flight handoffs work without that key; live flight quotes do not.
- Open bus, metro, and rail operator links. These are handoffs, not an integrated end-to-end transit timetable.
- Plan a budget with your own baggage, transfer, and other cost entries; inspect nearby airports and save plans on this device.
- See timetable attribution, dates, and coverage limitations alongside results. Unknown prices stay unknown.

Rail durations are station-to-station. Flight durations, when a provider is connected, are airport-to-airport. Ground access, check-in, separate-ticket protection, and complete door-to-door routing are not solved by this beta. The app has no checkout or payment processing and does not sell tickets.

## Run locally

Use Node.js 24 and `unzip` (Git for Windows supplies it).

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

This runs the application tests, Worker tests, and production UI build. Provider HTTP tests use fixtures; passing them does not establish that a flight-provider account is approved or connected.

## Publish and maintain

See [DEPLOY.md](DEPLOY.md) for Cloudflare deployment, secrets, daily timetable refresh, and the optional original Node server. The production packaging and deployment helpers are:

```sh
node scripts/build-cloudflare.mjs
node scripts/deploy-cloudflare.mjs
```

The deployment helper needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in its environment. It prints the actual public URL after a successful deployment. The live beta above was published and verified on September 9, 2026.

The [GitHub Actions workflow](.github/workflows/deploy.yml) supports manual deployment and a daily 05:30 UTC timetable refresh after it is merged into `master` and its two Cloudflare repository secrets are configured. **Those GitHub secrets are not configured yet; scheduled production refresh is not active.** Missing credentials fail clearly. The workflow does not commit generated data or change branches.

## Data and architecture

The hosted beta bundles only the small DELFI / gtfs.de long-distance feed under CC BY 4.0. Its initial calendar spans **September 5–October 5, 2026**; subsequent ingests use the publisher's actual coverage. Out-of-range searches are refused. Train fares are unavailable in this feed; a connected flight provider can supply real quotes.

The original `scripts/ingest.mjs`, `server.mjs`, and RAPTOR-style rail engine remain available for an optional separately hosted multi-country backend. That much larger dataset is not the Cloudflare beta's coverage. Review its source licenses and size the host before enabling it.

- [Cloudflare API and provider contract](docs/CLOUDFLARE.md)
- [Bundled rail data, refresh, and validation](docs/EDGE-DATA.md)
- [Data sources and licenses](DATA_SOURCES.md)
- [Developer handoff](HANDOFF.md)

Code: MIT. Map geometry: [Natural Earth](https://www.naturalearthdata.com/), public domain via world-atlas. Airport reference data: [OurAirports](https://ourairports.com/data/), public domain. Data-provider licenses remain separate from the code license.
