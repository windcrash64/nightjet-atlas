# Travel Freely developer handoff

Repository: [windcrash64/nightjet-atlas](https://github.com/windcrash64/nightjet-atlas). Updated September 9, 2026. Current implementation work is on `codex/travel-freely`; the default branch is `master`. The branch is intended for review before merge. The [live beta](https://travel-freely.windcrash64.workers.dev/) is deployed to Cloudflare; the source branch has not been merged.

## Current product

Travel Freely is a flight-first travel planning beta with an interactive globe, city/airport search, mode choices, journey comparison, operator handoffs, device-local saved plans, and a budget that separates known fares from user-entered extras. The UI must describe airport-to-airport and station-to-station durations honestly. It is not a complete door-to-door booking service.

| Area | Implemented state |
| --- | --- |
| Cloudflare | Published Worker API plus Static Assets; public UI and real rail search verified on September 9, 2026 |
| Scheduled refresh | Workflow prepared; GitHub Cloudflare secrets not configured and daily production refresh not active |
| Rail | Bundled Germany long-distance GTFS; 656 stations / 5,217 trips in the current snapshot; direct and one-change routes |
| Flights | Skyscanner create/poll adapter implemented; approved partner key not configured; live inventory integration still needs that account and a real provider test |
| Flight/operator handoffs | Links usable without a flight API key; external sites remain responsible for quotes and checkout |
| Bus and metro | Operator/local-transit handoffs; no complete integrated schedules or end-to-end connections |
| Budget | User-entered extras and available quoted fares; unknown fares do not become zero-cost trips |
| Saved plans | Browser localStorage on this device; no account or server-side saved-trip database |
| Payments | No checkout, payment collection, or automatic booking |

The initial bundled calendar covers September 5–October 5, 2026. Refresh and redeploy before expiry. An empty rail result means no direct/one-change route in this feed, not that travel is impossible. Price is null for these timetable results; approved live flight results can contain real prices for all selected adults.

## Start and check

```sh
npm ci
npm run data:edge
npm run build
npm run dev:api
```

Start `npm run dev` in another terminal. Vite on 5173 proxies the Worker's `/api` on 8787. `npm run check` runs application tests, Worker tests, and the UI production build. Real bundled rail tests need the generated edge data; live flight API tests are separate from the mocked provider tests.

## Files to know

- `src/App.jsx` and `src/styles.css`: product UI, accessible interactions, budget and saved-plan flows.
- `src/lib/planner.js`: city/airport lookup, provider handoffs, comparison and budget helpers.
- `worker/index.js`: same-origin `/api/plan`, input validation, rate limiting, provider isolation, health.
- `worker/providers.js`: Skyscanner quotes/polling and normalized rail results.
- `worker/edge-rail.js`, `scripts/ingest-edge.mjs`: compact timetable, real calendars, stop permissions, precomputed indexes initialized at module startup.
- `wrangler.jsonc`: Worker name, Static Assets, API routing and search rate-limit binding.
- `scripts/build-cloudflare.mjs`, `scripts/deploy-cloudflare.mjs`: checked-size deployment packages and account-token publication.
- `.github/workflows/deploy.yml`: manual and daily 05:30 UTC refresh/deploy, activated after merge to `master` and Actions secret configuration.
- `scripts/ingest.mjs`, `server.mjs`, `src/lib/router.js`: optional original multi-country Node engine, not the current bundled coverage.

## Validation and operating limits

The compact rail work independently verified 161,727 service/calendar bits against the raw weekly calendar and exceptions, all 52,878 packed calls, and 241 train legs across 176 returned journeys. Exact source times, pickup/drop-off permissions, calendar bounds, trip identities, and null fares were checked. Node measurements are documented in [EDGE-DATA.md](docs/EDGE-DATA.md); they are not a replacement for Cloudflare runtime measurements.

The API rejects malformed/oversized requests and uncovered rail dates. Provider failures are reported independently, so an unavailable flight provider does not remove valid rail results. Booking links retain provider attribution and completeness; multi-ticket quotes must not be presented as a single protected booking. Neither scheduled times nor a health response guarantee running status or inventory.

## Remaining external setup

1. Merge the reviewed branch into `master` and configure GitHub Actions secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` if daily production refresh is wanted. The workflow fails clearly when either is missing and cannot deploy from another branch.
2. Obtain and configure an approved `SKYSCANNER_API_KEY` in Cloudflare, then verify actual live quotes, baggage disclosures and booking handoffs. Installing Cloudflare or supplying a Cloudflare token does not grant flight-data access.
3. Expand transport coverage through explicitly licensed sources and actual provider contracts. Local transit, real airport access, more transfers, cross-day connections, accessibility and rail fares remain separate integration work.

The optional `RAIL_API_URL` can connect a separately hosted Node search engine. Review its date behavior, resource needs, source licenses, and public-service obligations before using the larger feed mix. The old full-network measurements and research in `docs/research/` describe earlier investigation; they are not current hosted coverage or proof of a provider's present terms.

See [DEPLOY.md](DEPLOY.md), [DATA_SOURCES.md](DATA_SOURCES.md), and [the provider/API reference](docs/CLOUDFLARE.md) for the concrete setup. Do not commit credentials, generated networks, or temporary Cloudflare upload tokens.
