# Travel Freely on Cloudflare

The React application and `/api/*` run together on Cloudflare Workers with Static Assets. The optional original Node rail server remains a separate service: its full in-memory transit index is not bundled into the Worker. This deployment does not use Sites.

## Deploy

From the repository root, use the installed Wrangler v4 CLI:

```sh
npm ci
node scripts/ingest-edge.mjs
npm run check
npm run build:cloudflare
npx wrangler deploy --dry-run
# Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN securely, then:
npm run deploy
```

`wrangler.jsonc` points to `worker/index.js`, binds `dist/` as `ASSETS`, and routes `/api/*` to the Worker before the single-page application fallback. The authenticated Cloudflare connector can also deploy the same compiled Worker and assets directly to the selected account. Cloudflare authentication is needed to publish; it is separate from travel-provider credentials.

The exact public URL is printed by deployment. Verify `/api/health`, then make a real route search in the application. A deployment with no flight credential is intentional and usable: it reports that live flight prices are not connected, while the bundled timetable and direct provider links remain available.

## Provider connections

### Flights

Live prices require a **Skyscanner-approved partner API key** with Flights Live Prices access. Installing Cloudflare does not supply one. Store it only as a Worker secret:

```sh
npx wrangler secret put SKYSCANNER_API_KEY
```

Optional non-secret Worker variables configure the provider market and display currency:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SKYSCANNER_MARKET` | `TR` | Market code approved for the integration |
| `SKYSCANNER_LOCALE` | `en-GB` | Provider locale |
| `SKYSCANNER_CURRENCY` | `EUR` | Currency requested from Skyscanner |

The adapter calls `/search/create`, then up to three `/search/poll/{sessionToken}` requests. It honors replacement and unchanged responses, uses the provider's elapsed flight duration, and converts documented price units. Quotes describe **all selected adults**, not a fabricated per-person fare. Airport-local clock times retain their dates without inventing UTC offsets. A bounded or failed poll returns a visibly `partial` provider state when earlier quotes remain available. Live inventory may have changed when a booking page opens; baggage remains unknown unless a supported adapter supplies it.

Only public HTTPS deep links from provider results reach the client. Multi-ticket quotes expose their complete `bookingLinks` array, with no single `bookingUrl` pretending to cover the whole itinerary. Source keys and session tokens are never returned.

### Bundled rail timetable

Without `RAIL_API_URL`, `worker/edge-rail.js` searches a compact, real Germany long-distance GTFS feed and international services present in that feed. It returns direct and one-change **station-to-station** options. It does not claim complete European coverage, metro/bus coverage, real-time running status, or rail fares.

The ingestion script downloads the feed and writes `src/data/edge-network.json`. The initial snapshot was retrieved on 2026-09-09 and covers the encoded calendar beginning 2026-09-05 for 31 days. The response includes the actual source, license, attribution, update timestamp, and calendar. Refresh the snapshot and redeploy before its calendar expires; searches outside coverage are refused rather than answered from an unrelated day.

```sh
node scripts/ingest-edge.mjs
npm run build
npx wrangler deploy
```

Retain the feed attribution wherever results are displayed. The bundled snapshot's metadata identifies DELFI e.V. / gtfs.de under CC BY 4.0 and OpenStreetMap contributors; see the source's license and attribution fields for exact text.

### Optional full rail, bus, and metro runtime

For wider coverage, ingest the original data and host `server.mjs` on a suitable Node host using the existing `DEPLOY.md` instructions. Then set `RAIL_API_URL` to that service's HTTPS origin. It may be stored as a Worker secret when the origin should not appear in configuration:

```sh
npx wrangler secret put RAIL_API_URL
```

The Worker forwards only a fixed `POST /api/search`, including the exact `YYYYMMDD` date and coordinates. It never exposes `/api/reload` or forwards arbitrary paths. The legacy server must return a valid calendar covering the request; the Worker rejects absent/stale calendars and mismatched result dates. It preserves feed attribution and returns `price: null` because GTFS schedules do not contain fares. Each journey must use only the transport modes selected by the traveler (walking connections are allowed).

The external runtime is optional. The Skyscanner account/key and any desired external rail deployment still have to be provisioned by their respective owners; no credentials are embedded in this repository.

## HTTP contract

`GET /api/health` reports service health, deployed package `buildId`, and provider configuration, without secrets or upstream URLs. Configuration is not proof that a provider account is authorized or its latest search will succeed.

`POST /api/plan` accepts `application/json`:

```json
{
  "from": { "name": "Berlin", "lat": 52.52, "lon": 13.405, "iata": "BER" },
  "to": { "name": "Munich", "lat": 48.137, "lon": 11.575, "iata": "MUC" },
  "date": "2026-09-10",
  "adults": 1,
  "cabin": "economy",
  "modes": ["plane", "train", "bus", "metro"]
}
```

Change the sample date to a future date covered by the timetable. Dates must be real calendar dates between the current UTC day and 365 days ahead. `adults` is an integer from 1 to 8; supported cabins are `economy`, `premium_economy`, `business`, and `first`. Modes must be unique and non-empty. Names are bounded, coordinates must be finite numbers, and optional IATA codes must have three uppercase letters.

Default JSON responses contain `query`, `providers`, `journeys`, and `searchedAt`. Every selected provider has `{id,status,message}` and an optional error `code`; states include `ok`, `partial`, `empty`, `unavailable`, `not_configured`, and `error`. Provider errors do not discard successful results from other providers. An empty journey list does not imply that travel is impossible.

Clients may send `Accept: application/x-ndjson` for independent provider delivery. Validation and rate limiting finish before the stream starts; early failures remain non-200 JSON responses. A successful stream contains one `{type:"start",query}`, a `{type:"provider",provider,journeys}` event for each requested provider as it finishes, and one `{type:"complete",searchedAt}`. Every event ends with a newline. The overall provider budget is 12 seconds; aborting the request or cancelling the response stream stops upstream fetches and polling waits. `enable_request_signal` is set in Worker compatibility flags. Conventional JSON responses remain supported.

The browser reads this stream incrementally with a 20-second overall deadline, bounded response bytes and validation before rendering. Received results survive a later provider failure or cancellation. A new search supersedes older requests; retrying a single provider keeps the others' results. HTTP 429 retry hints disable retries until their countdown expires. The UI's transport tabs filter the common comparison search; they do not imply that every mode has a connected schedule provider.

Each normalized journey includes `id`, `provider`, `mode`, `modes`, `from`, `to`, `date`, `departure`, `arrival`, `durationMinutes`, `changes`, `price`, `bookingUrl`, `bookingLinks`, `legs`, `source`, and `notes`. Each leg has its mode, endpoints, local date/time strings, elapsed duration, and available operator/service information. Rail journeys additionally preserve `sources`. Clients must display `timeBasis`, price basis, provider completeness, and source limitations accurately.

Validation returns structured 400/413/415 errors; wrong methods return 405; unknown API paths return 404. Search bodies are limited to 8 KiB and upstream JSON to 4 MiB. Stream reads and provider requests have deadlines. Search results use `Cache-Control: no-store`; cross-origin browser requests are rejected.

An optional Cloudflare Rate Limiting binding named `SEARCH_RATE_LIMITER` enables an edge-managed per-IP search cap. The Worker calls it before contacting travel providers and returns HTTP 429 with a retry hint when exhausted. Set an appropriate limit before opening paid provider credentials to significant traffic; no in-memory cross-request IP tracking is used.

## Verification and references

`node --test worker/*.test.js` exercises the real HTTP handler, input/body validation, secret isolation, provider failures, timestamp/price normalization, create/poll semantics, stale calendars, safe booking links, and real bundled rail results. Provider HTTP tests use explicit test fixtures. A live Skyscanner search still requires an approved key and should be checked after configuration.

- [Cloudflare Static Assets bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Skyscanner Live Prices workflow](https://developers.skyscanner.net/docs/flights-live-prices/overview)
- [Skyscanner query fields](https://developers.skyscanner.net/docs/flights-live-prices/query-object)
- [Skyscanner price and result enums](https://developers.skyscanner.net/docs/getting-started/enums)
