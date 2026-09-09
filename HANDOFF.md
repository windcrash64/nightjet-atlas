# Travel Freely developer handoff

Repository: [windcrash64/nightjet-atlas](https://github.com/windcrash64/nightjet-atlas). Updated September 9, 2026. Current implementation work remains on `codex/travel-freely` in the existing draft pull request; the default branch is `master`. The [live beta](https://travel-freely.windcrash64.workers.dev/) includes the streaming backend and interface changes below, published and verified September 9, 2026. **The source branch has not been merged.**

## Current product

Travel Freely is a flight-first travel planning beta with an interactive globe, city/airport search, mode choices, journey comparison, operator handoffs, device-local saved plans, and a budget that separates known fares from user-entered extras. The UI must describe airport-to-airport and station-to-station durations honestly. It is not a complete door-to-door booking service.

| Area | Implemented state |
| --- | --- |
| Cloudflare | Current Worker API plus Static Assets published and verified September 9, 2026; 12 asset hashes, build ID, JSON/NDJSON and browser flows verified |
| Scheduled refresh | Workflow prepared; GitHub Cloudflare secrets not configured and daily production refresh not active |
| Rail | Bundled Germany long-distance GTFS; 656 stations / 5,217 trips in the current snapshot; direct and one-change routes |
| Search lifecycle | Independent streamed provider results, visible loading/partial/error states, stop while keeping received options, per-provider retry and rate-limit countdown |
| Flights | Skyscanner create/poll adapter implemented; approved partner key not configured; live inventory integration still needs that account and a real provider test |
| Flight/operator handoffs | Links usable without a flight API key; external sites remain responsible for quotes and checkout |
| Bus and metro | FlixBus and Google Maps transit handoffs; bundled data has no bus/metro services and returns no normalized bus/metro journeys |
| Budget | User-entered extras and available quoted fares; unknown fares do not become zero-cost trips; changed trip details require reviewing retained estimates |
| Saved plans | Validated browser localStorage on this device, including budget estimates, adult count and preferences; no account or server-side saved-trip database |
| Payments | No checkout, payment collection, or automatic booking |

The initial bundled calendar covers September 5–October 5, 2026. Refresh and redeploy before expiry. An empty rail result means no direct/one-change route in this feed, not that travel is impossible. Price is null for these timetable results; approved live flight results can contain real prices for all selected adults.

Google Maps receives origin/destination coordinates and `travelmode=transit`; it receives no selected date/time or fare data. Its result can include buses, trains or metro. The link copy requires travelers to choose the departure time and confirm service and fares in Maps. A bus- or metro-only API filter currently produces an empty bundled-timetable result, rather than evidence that no such service exists locally. The external rail adapter can normalize those modes when a suitable source is actually connected.

## Start and check

Use Node.js 24. The compact `data:edge` path needs no `unzip`; the optional original full ingester still does.

```sh
npm ci
npm run data:edge
npm run build
npm run dev:api
```

Start `npm run dev` in another terminal. Vite on 5173 proxies the Worker's `/api` on 8787. `npm run check` runs application, Worker and deployment-pipeline tests, then the UI production build. Real bundled rail tests need the generated edge data; live flight API tests are separate from the mocked provider tests. Ingestion is explicit and never started implicitly by tests or package creation.

For publication after refreshing the data, use `npm run deploy`. It runs the checks, rebuilds/packages the UI and Worker, publishes, and verifies the public result. The equivalent manual publication command is `node scripts/deploy-cloudflare.mjs deploy` after `npm run check` and `node scripts/build-cloudflare.mjs`; an omitted command prints help without deploying. The helper requires the Cloudflare account ID and API token in its environment. See [DEPLOY.md](DEPLOY.md) for receipt verification and explicit rollback.

## Files to know

- `src/App.jsx` and `src/styles.css`: product UI, accessible interactions, budget and saved-plan flows.
- `src/lib/planner.js`: city/airport lookup, provider handoffs, comparison and budget helpers.
- `src/lib/search-pipeline.js`: bounded NDJSON/JSON response reading, independent provider state, cancellation, retry and latest-search protection.
- `src/lib/trip-state.js`: form validation, saved-trip sanitization, trip identity and budget-estimate restoration.
- `worker/index.js`: same-origin `/api/plan`, JSON/NDJSON responses, input validation, rate limiting, provider isolation, shared deadlines and health.
- `worker/providers.js`: Skyscanner quotes/polling and normalized rail results.
- `worker/edge-rail.js`, `scripts/ingest-edge.mjs`: bounded ZIP/CSV ingestion, validated calendars and calls, atomic refresh, stop permissions, precomputed indexes initialized at module startup.
- `wrangler.jsonc`: Worker name, Static Assets, API routing and search rate-limit binding.
- `scripts/build-cloudflare.mjs`, `scripts/deploy-cloudflare.mjs`, `scripts/cloudflare-package.mjs`: freshness and size checks, frozen assets, source fingerprints, package integrity, public verification, deployment receipts and explicit Worker-version rollback.
- `.github/workflows/deploy.yml`: manual and daily 05:30 UTC refresh/deploy, activated after merge to `master` and Actions secret configuration.
- `scripts/ingest.mjs`, `server.mjs`, `src/lib/router.js`: optional original multi-country Node engine, not the current bundled coverage.

## Validation and operating limits

The compact rail follow-up independently rechecked 161,727 service/calendar bits against the original weekly calendar and exceptions and all 52,878 call minutes/permissions. An audit of 224 route/date/hour queries checked 815 journeys and 1,303 train legs with no invalid calls or fastest-result regressions. A constructed timetable covers the previously missed faster interchange on a train that also runs directly to the destination. Tests exercise malformed CSV, bounded ZIP decompression, calendar/permission errors, optional-table refreshes and byte-for-byte preservation of good output/cache after invalid refreshes. Node measurements are documented in [EDGE-DATA.md](docs/EDGE-DATA.md); they are not a replacement for Cloudflare runtime measurements.

The verified deployment is `ea34d486-5954-4434-96d6-27752443d66e`, version `bce2d54e-bc13-4958-919b-75986445135e` at 100%, with build ID `e0ff89320dbc94655a640cc8379670fbb2d4f8e47c67f3461626b52d109ac951`. All 12 public asset hashes and MIME/security headers matched, health/build identity and JSON/NDJSON checks passed, and Berlin-Munich returned eight unpriced timetable options for September 10, fastest 239 minutes. The nonsecret `worker/.build/deployment-receipt.json` records verification and the prior version for rollback. Actual Cloudflare CPU was 20 ms for the first Berlin-Munich request, 8 ms for its repeat, 10 ms for Munich-Berlin and 12 ms for Hamburg-Frankfurt; startup was 21 ms. Later Berlin JSON/NDJSON checks used 15/11 ms. The small live sample does not demonstrate a production CPU improvement from the allocation optimization. Every observed request succeeded without exceptions, but some exceed the nominal 10-ms free allowance. These measurements do not guarantee free-plan CPU headroom for every route. No paid upgrade was made; the temporary diagnostic tail was deleted.

Final local checks passed 201 tests (140 application/transport, 50 Worker, 11 pipeline); 15 tests requiring the separate legacy full dataset were skipped. Clean GitHub Actions runs passed installation, fresh ingestion, all checks, both package strategies and a Wrangler dry run on Node 24/Linux. Browser checks covered desktop/mobile, live details and globe, invalid place drafts, budget arithmetic/review, saved restoration, and delayed actual provider responses: early rail rendering, cancellation, single-provider retry, and changing inputs back after interruption.

The UI requires actual selected suggestions and valid trip dates/adult counts; the API independently rejects malformed/oversized requests, invalid UTF-8 and uncovered rail dates. The browser bounds response size and lifetime and rejects malformed/interrupted streams. Shared server deadlines and cancellation stop waiting on providers; failed flight requests do not remove received rail results. Retrying one provider preserves the others, and responses from an older query cannot overwrite a newer trip. Booking links retain provider attribution and completeness; multi-ticket quotes must not be presented as a single protected booking. Neither scheduled times nor a health response guarantee running status or inventory.

Saved entries are bounded, sanitized and deduplicated before rendering. Opening an expired saved trip switches the search to tomorrow and prompts review of retained estimates. Route/date/adult changes mark old costs for review; saved fares and user estimates are never refreshed quotes.

Packaging requires tomorrow in UTC to be inside the calendar and each source retrieval timestamp to be at most seven days old. The default Static Assets package and optional bundled-assets fallback preserve configuration and headers, record a public build ID, and reject altered sources or package bytes. Deployment verification checks public assets/MIME/headers, SPA behavior, health build ID, JSON and streamed rail searches, API boundaries and uncovered dates. Before publication, a non-secret receipt records previous Worker version percentages. Rollback is an explicit command that restores those Worker versions; it does not restore external resources or data, and an initial deployment has no prior version to restore.

## Remaining external setup

1. Merge the reviewed branch into `master` and configure GitHub Actions secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` if daily production refresh is wanted. The workflow fails clearly when either is missing and cannot deploy from another branch.
2. Obtain and configure an approved `SKYSCANNER_API_KEY` in Cloudflare, then verify actual live quotes, baggage disclosures and booking handoffs. Installing Cloudflare or supplying a Cloudflare token does not grant flight-data access.
3. Expand transport coverage through explicitly licensed sources and actual provider contracts. Local transit, real airport access, more transfers, cross-day connections, accessibility and rail fares remain separate integration work.

The optional `RAIL_API_URL` can connect a separately hosted Node search engine. Review its date behavior, resource needs, source licenses, and public-service obligations before using the larger feed mix. The old full-network measurements and research in `docs/research/` describe earlier investigation; they are not current hosted coverage or proof of a provider's present terms.

See [DEPLOY.md](DEPLOY.md), [DATA_SOURCES.md](DATA_SOURCES.md), and [the provider/API reference](docs/CLOUDFLARE.md) for the concrete setup. Do not commit credentials, generated networks, or temporary Cloudflare upload tokens.
