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
node scripts/ingest.mjs   # downloads the feeds, builds src/data/network.json (~83MB, gitignored)
                          # Switzerland needs headroom: NODE_OPTIONS=--max-old-space-size=6144
node server.mjs           # routing API on :8080
npm run dev               # UI on :5173, proxies /api to :8080
```

```bash
npm test              # 50 tests
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
  **716ms**, worst 841ms, measured by `scripts/bench.mjs`.
- Real 3D globe (Natural Earth vector geometry, no map tiles, no keys), framed
  on the journey by computing the chord it subtends.
- Spot-checked against reality: Madrid–Barcelona 197min on AVE (real ~2h30),
  Paris–Marseille 184min TGV (real ~3h), Zurich–Milan 197min direct EC (real
  ~3h20), Zurich–Geneva 170min IC1, Amsterdam–Rotterdam 43min,
  Berlin–Munich 247min ICE 29, Amsterdam–Berlin 371min, Paris–Brussels 82min
  Eurostar (real ~1h22), Paris–London 217min, Berlin–Prague 250min (~4h),
  Berlin–Warszawa 330min, Vienna–Budapest 275min RJX.
- 50 tests: 14 on the router, 13 on place search, 12 against the real ingested
  network, plus journey normalisation. Every place-search test names a bug that
  actually shipped.

**Deliberately absent:** prices. Open feeds carry schedules, not fares, and
there is no free legitimate source of European rail prices. `price` is `null`
everywhere, enforced by a test.

## Known gaps

- **Not deployed.** The ~95MB network needs a small VPS (~€5–25/month), not
  Cloudflare Pages. The old Nightjet Atlas deployment at
  nightjet-atlas.pages.dev is still live and now shows a different, older app.
- **No payments.** Decided deliberately: build the product first, monetise with
  evidence. See the research summary below.
- **Coverage stops at five countries.** Italy is NeTEx-only, Austria needs
  Keycloak OAuth and its host refuses connections, Belgium states no licence.
  Czechia and Poland are verified workable and are the obvious next additions — all need route_type filtering during ingest,
  which the ingester now supports via keepModes and maxRouteType.
- **Times are agency-local, and every country ingested is on CET**, so they are
  directly comparable today. The ingester fails loudly if a feed from another
  offset is added, because journeys crossing that boundary would be silently
  hours wrong.
- **The 4,132-airport dataset is bundled but unused.** No flight routing yet.
- **Berlin–Munich returns six departures of one train.** That is the honest
  answer for that corridor and the UI now says so, but a "show later
  departures" control would serve better than listing them.

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

1. Add Czechia and Poland, using the keepModes/maxRouteType filters.
2. Local times instead of UTC.
3. Deploy: small VPS, nightly ingest, a real domain.
4. Only then revisit money, with usage data rather than a guess.
