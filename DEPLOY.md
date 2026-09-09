# Deploy Travel Freely

The default deployment is one Cloudflare Worker with Static Assets: the React application and `/api/*` share an origin. The Worker bundles the compact Germany long-distance timetable. The original large Node rail engine is an optional separate backend.

Current beta: [travel-freely.windcrash64.workers.dev](https://travel-freely.windcrash64.workers.dev/), published and checked on September 9, 2026. The public UI and API returned eight real Berlin–Munich timetable options for September 10; the fastest took 239 minutes.

## Build and verify

Use Node.js 24, npm, and `unzip`. From the repository root:

```sh
npm ci
npm run data:edge
npm run check
node scripts/build-cloudflare.mjs
```

`data:edge` downloads the compact publisher feed and atomically writes the gitignored `src/data/edge-network.json`. `check` runs tests and builds `dist/`. Packaging writes the compiled Worker, asset manifest, and size summary into `worker/.build/`; it refuses a Worker at or above the free plan's 3 MiB gzip bundle limit. Full deployment still requires a Cloudflare account with suitable access.

The September 9 snapshot has 656 stations, 5,217 trips, and a September 5–October 5 calendar. These counts describe the snapshot, not guaranteed future feed contents. See [EDGE-DATA.md](docs/EDGE-DATA.md) for resource measurements and search limits.

## Deploy with account credentials

Provide these environment variables through your shell's secure credential handling or your CI secret store:

| Name | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Destination account ID |
| `CLOUDFLARE_API_TOKEN` | Account-scoped permission to edit Workers and upload their assets |

Then run:

```sh
node scripts/deploy-cloudflare.mjs
```

The helper uploads the static assets, publishes the Worker named in `wrangler.jsonc` (`travel-freely`), enables its `workers.dev` address, and prints the actual URL and deployment result. It preserves existing Worker text secrets. Never put tokens, temporary upload credentials, or provider keys in the repository or browser bundle.

Wrangler is also supported for interactive authentication and deployment:

```sh
npx wrangler login
npx wrangler deploy --dry-run
npx wrangler deploy
```

Build `dist/` and generate `edge-network.json` first. The optional `node scripts/build-cloudflare.mjs --bundled-assets` prepares a transport fallback for connector environments without asset uploads; normal production deployment uses Static Assets.

After each deployment, verify the printed URL's `/api/health` and perform a real rail search in the UI. Without a flight-provider secret, health should report Skyscanner as `not_configured` and rail as `bundled_timetable`.

The deployment helper also checks published asset hashes and actual timetable responses:

```sh
node scripts/deploy-cloudflare.mjs verify https://travel-freely.windcrash64.workers.dev
```

It searches tomorrow in UTC by default; an optional final `YYYY-MM-DD` argument selects another date within the API's allowed range. It derives the uncovered-date check from the returned calendar. `verify-tail` accepts a temporary Cloudflare diagnostic session over standard input and measures actual request CPU; keep that session credential private.

## Flight and optional rail secrets

Live flight quotes require a Skyscanner-approved partner key with Flights Live Prices access. No such key is configured by this repository. Flight and operator handoffs remain usable without it.

```sh
npx wrangler secret put SKYSCANNER_API_KEY
```

Optional Worker settings are `SKYSCANNER_MARKET` (default `TR`), `SKYSCANNER_LOCALE` (`en-GB`), and `SKYSCANNER_CURRENCY` (`EUR`). Keep EUR for the current euro budget comparison unless the UI's currency handling is extended. Set approved values in the Worker configuration. Local development can use the gitignored `.dev.vars`; production credentials must be stored as Worker secrets.

`RAIL_API_URL` optionally selects an external HTTPS rail backend instead of the bundled timetable:

```sh
npx wrangler secret put RAIL_API_URL
```

The Worker calls only that origin's `POST /api/search`. It does not expose the original server's reload route. See [the API contract](docs/CLOUDFLARE.md) before connecting another backend. Bus/metro handoff links are not proof that the backend has their schedules.

## Daily refresh through GitHub Actions

The workflow at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) has a manual `workflow_dispatch` trigger and a daily **05:30 UTC** schedule. Merge the reviewed changes into the default branch, `master`, and add repository Actions secrets named `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

**These GitHub repository secrets are not configured yet.** This workflow is prepared for review; daily production refresh is not active. An interactive deployment through Cloudflare does not automatically configure GitHub Actions.

Run it from `master`. A wrong branch or missing secret produces a failed run with a clear configuration error. A successful run installs locked dependencies, fetches a fresh timetable, runs checks, packages the Worker, deploys it, and checks public health. The workflow has only `contents: read` repository permission and never commits, pushes, or changes the branch. It does not need the flight key in GitHub because the deployed Worker's existing secrets are preserved.

The schedule becomes available after the workflow reaches the default branch; GitHub schedules can be delayed. Check failed or disabled Actions runs. Timetables are bundled at deployment, so a successful ingest without a deployment does not refresh production. Once its calendar expires, the rail API explicitly refuses uncovered dates. [GitHub's schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule)

## Optional original Node rail engine

For the original multi-country engine, provision a separate persistent Node host with several gigabytes of disk and enough ingestion memory. Earlier project measurements are historical snapshots; remeasure the current feeds instead of applying the compact Worker's resource figures to this server. This path does not provide complete European, local-transit, or fare coverage automatically.

On a POSIX host:

```sh
npm ci
NODE_OPTIONS=--max-old-space-size=6144 node scripts/ingest.mjs
HOST=127.0.0.1 PORT=8080 node server.mjs
```

For PowerShell, set `$env:NODE_OPTIONS = '--max-old-space-size=6144'` before running the full ingester. Its use of `unzip` requires the executable on PATH. The resulting `src/data/network.json` is separate from `edge-network.json` and is not shipped in the Worker.

Run `server.mjs` under a process supervisor, bind it to loopback behind a configured TLS reverse proxy, and expose only the search API needed by the Worker. The server's rate limiter uses the socket peer address; configure trusted-proxy handling if per-client limits are required. Do not forward `/api/reload` publicly.

After a successful full ingestion, `SIGHUP` reloads the Node network in place and clears its result cache. On Windows, the alternative is local `POST /api/reload` with `x-reload-token` matching the server's `RELOAD_TOKEN` environment variable. Keep that administration credential out of client code and the public proxy. A failed reload retains the previous in-memory network.

Review [DATA_SOURCES.md](DATA_SOURCES.md) before publishing results from the full feed mix. In particular, an ODbL-derived database can carry obligations when a public service produces results from it; keeping `network.json` private is not an exemption.
