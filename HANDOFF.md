# Handoff

**Repo:** https://github.com/windcrash64/nightjet-atlas (public, MIT)
**Local:** `C:/Users/nalba/Documents/nightjet`
**Last worked:** 2026-09-01

## What this is

A journey planner that answers "how do I actually get from A to B", showing
real options on a real map and ranking them by time, changes, and whether you
can sleep through it. It runs on transit data we ingest ourselves from the
operators, so a search costs compute we already pay for rather than money per
request.

## Run it

```bash
npm install
node scripts/ingest.mjs   # downloads the feeds, builds src/data/network.json (~103MB, gitignored)
                          # Switzerland needs headroom: NODE_OPTIONS=--max-old-space-size=6144
node server.mjs           # routing API on :8080
npm run dev               # UI on :5173, proxies /api to :8080
```

```bash
npm test              # 98 tests
node scripts/bench.mjs  # cold search latency per corridor
```

## State

**Working, verified against real timetables:**

- 189,209 stops and 384,515 services from six commercially-licensed feeds
  covering Germany, France, Spain, Switzerland and the Netherlands (see
  `data/sources/registry.json`).
- **Reach is wider than the ingested countries**, because a cross-border
  service carries its foreign stops with it. Verified routing to Warsaw,
  Prague, Budapest, Copenhagen, Brussels, Vienna, Milan, Zagreb, Ljubljana and
  London St Pancras.
- RAPTOR-style routing over patterns rather than trips. Median cold search
  **273ms**, worst 546ms, measured by `scripts/bench.mjs`. Warm (cached)
  searches return in 33–40ms.
- **Searches are filtered to the day you ask for**, defaulting to today. Only
  117,470 of 384,515 services run on a given date (103,621 on a Sunday), so
  three quarters of what the app used to offer was not actually running.
- **The server holds 451MB resident**, measured on the running process. The
  hot structures — 3.2M stop-times, 3.6M footpaths, 3.2M stop→service entries
  — are CSR typed-array columns rather than millions of small JS arrays, which
  is what took heap from 1,205MB to 176MB and halved search latency. Widths
  are asserted by tests in `src/lib/calls.test.js`, because the deployment
  maths depends on them.
- Real 3D globe (Natural Earth vector geometry, no map tiles, no keys), framed
  on the journey by computing the chord it subtends.
- Spot-checked against reality: Madrid–Barcelona 197min on AVE (real ~2h30),
  Paris–Marseille 184min TGV (real ~3h), Zurich–Milan 197min direct EC (real
  ~3h20), Zurich–Geneva 170min IC1, Amsterdam–Rotterdam 43min,
  Berlin–Munich 247min ICE 29, Amsterdam–Berlin 371min, Paris–Brussels 82min
  Eurostar (real ~1h22), Paris–London 217min, Berlin–Prague 250min (~4h),
  Berlin–Warszawa 330min, Vienna–Budapest 275min RJX.
- 98 tests: 21 on the router, 13 on place search, 12 against the real ingested
  network, 17 on the GTFS calendar, 15 on how the option list describes itself,
  9 on the packed stop-time columns, plus solar position. Every place-search
  test names a bug that actually shipped.

**Deliberately absent:** prices. Open feeds carry schedules, not fares, and
there is no free legitimate source of European rail prices. `price` is `null`
everywhere, enforced by a test.

## Known gaps

- **Not deployed, but ready to be.** See [DEPLOY.md](DEPLOY.md): 451MB
  resident (a 1GB VPS is enough; it was 1.4GB before the typed-array work),
  ~6GB disk of which 452MB is the feed cache, plus a systemd unit and a cron
  script. The nightly cycle is safe — the ingest writes network.json
  atomically and the server reloads in place on SIGHUP or POST /api/reload, so
  there is no restart and no dropped request, and a corrupt file leaves
  yesterday's data serving. Still not Cloudflare Pages or Workers (128MB), and
  still not Lambda-shaped: the 6s index build wants a long-lived process. What
  is left is buying the box and pointing a domain at it. The old
  nightjet-atlas.pages.dev deployment is still live and shows an older app.
- **No payments.** Decided deliberately: build the product first, monetise with
  evidence. See the research summary below.
- **Coverage stops at five countries.** Italy is NeTEx-only, Austria needs
  Keycloak OAuth and its host refuses connections, Belgium states no licence.
  Czechia and Poland were researched on 2026-09-01 and the answer was not the
  expected one — see `docs/research/cz-pl-rail-feeds-2026-09.md`:
  - **Poland is excluded on licence grounds.** No official rail GTFS exists;
    PKP is not even registered as a data provider on dane.gov.pl. The one
    official source is JSON behind manual approval, marked "all rights
    reserved". The CC-BY-4.0 on the volunteer rehost traces to no PKP grant.
  - **Czechia is viable and deferred.** Its licence is the best we have found
    anywhere (the state disclaims copyright, database copyright and sui
    generis right, with a CC0 match), but it publishes NeTEx and CZPTT XML
    only. Adding it is a converter project, not an ingest config change.
- **Times are agency-local, and every country ingested is on CET**, so they are
  directly comparable today. The ingester fails loudly if a feed from another
  offset is added, because journeys crossing that boundary would be silently
  hours wrong.
- **The 4,132-airport dataset is bundled but unused.** No flight routing yet.

- **A sparse corridor can honestly return nothing.** The empty state now says
  so and offers "leave earlier" / "try the next day" rather than blaming
  coverage, but there is no "next departure after this window" search — if the
  only train is at 06:00 tomorrow, nothing tells you that.

## What the research established

Two workflows (39 and 25 agents) with adversarial verification. The load-bearing
conclusions:

- **The commercial path is legal and clear.** MOTIS is MIT with no restriction.
  ÖBB's own terms permit `kommerziell nutzen`. EU Delegated Regulation
  2017/1926 Art. 8(1) obliges member states to publish this data for reuse on a
  non-discriminatory basis, and Art. 8(4) caps how restrictive their licences
  may be. Art. 8(3) separately requires showing the source and last-update time
  — which the app does.
- **Transitous is off-limits commercially** ("commercial use is not allowed",
  plus an open-source requirement), which is why nothing here depends on it.
  Their feed *catalogue* is CC0 and was used as a map of publishers.
- **There is no free flight-price API in 2026.** Amadeus Self-Service was
  decommissioned 2026-07-17; Duffel's terms ban metasearch; scraping Google
  violates its robots.txt.
- **Paid subscriptions have failed in this niche.** fromAtoB had 2.5M monthly
  visitors, funding, and the right to sell tickets, and went insolvent.
  bahn.guru is archived. Eurail deleted its own web trip planner in May 2026.
  The survivors — Chronotrains, Seat61 — are free and ad/affiliate/donation
  funded. Rail affiliate commission is thin: Rail Europe 0.91%, Trainline ~3%.
- **Feed operations are the real cost, not servers.** Transitous logs roughly
  five feed breakages a week with experienced maintainers and donated hardware.

## Next, in the order I would do it

1. Deploy: small VPS, nightly ingest, a real domain. Nothing else matters
   until someone other than us can load it.
2. Czechia, if coverage is worth a NeTEx→GTFS converter. Not Poland — its
   licence question is closed for now, and reopening it means asking PKP PLK
   directly rather than searching again.
3. Only then revisit money, with usage data rather than a guess.

(Local-vs-UTC times came off this list: times are agency-local, every ingested
country is on CET, and the ingester fails loudly if a feed from another offset
is added.)
