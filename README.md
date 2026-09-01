# Where next

**Every way from A to B, drawn on the world.**

Type two places. Get the real trains between them — ranked by how long they
take, how many times you change, and whether you can sleep through it — with
the journey drawn on a 3D globe built from actual geometry.

It runs on transit data we ingest ourselves from the operators, so a search
costs compute we already pay for rather than money per request.

## What it does

Search Zurich to Hamburg on an evening and you get six real options, including
`NJ 2870` leaving at 21:59 and arriving 08:11 — ten hours, every one of them
asleep, no hotel — alongside the seven-hour version that changes once at Basel.
That comparison is the product. A list of departure times cannot make it; you
have to see the sleeper next to the fast train to know which one you want.

- **189,209 stops and 384,515 services** from six feeds covering Germany,
  France, Spain, Switzerland and the Netherlands.
- **Reach is wider than those five countries.** A cross-border service carries
  its foreign stops with it, so routing to Warsaw, Prague, Budapest,
  Copenhagen, Brussels, Vienna, Milan, Zagreb, Ljubljana and London St Pancras
  works today.
- **RAPTOR-style routing over patterns**, not trips. Median cold search 383ms,
  worst 448ms; repeat searches 33–38ms.
- **A real globe**, Natural Earth vector geometry — no map tiles, no API key,
  no third-party request — framed on the journey by computing the chord it
  subtends.
- **The list explains itself.** On a corridor where one train runs all day it
  says so, with the median gap between its departures, rather than showing you
  eight near-identical rows and letting you wonder what broke.

## What it refuses to do

**It never shows a price, and never estimates one.** Open feeds carry
schedules, not fares, and there is no free legitimate source of European rail
prices: Amadeus Self-Service was decommissioned on 2026-07-17, Duffel's terms
prohibit metasearch, and scraping Google violates its `robots.txt`. `price` is
`null` everywhere and there is no code path that invents one. A test enforces
it.

**It never claims a feature it does not render.** Badges appear only when they
change a decision — "Fastest" needs a 15-minute margin over the runner-up,
because a three-minute win is advice to wait an hour for nothing.

**It shows where its data came from and when.** EU Delegated Regulation
2017/1926 Art. 8(3) requires the source and last-update time wherever this data
is reused, and the footer carries both.

## Running it

```bash
npm install
node scripts/ingest.mjs   # downloads the feeds, builds src/data/network.json (~98MB, gitignored)
                          # Switzerland needs headroom: NODE_OPTIONS=--max-old-space-size=6144
node server.mjs           # routing API on :8080, also serves dist/
npm run dev               # UI on :5173, proxies /api to :8080
```

```bash
npm test                  # 74 tests, no network required
npm run build
node scripts/bench.mjs    # cold search latency per corridor
```

## Deploying

A long-lived Node process on a small VPS. The server holds **451MB resident**
and spends 3.9s building its index at startup, so it wants a box it can stay
warm on — not Cloudflare Workers (128MB), not a Lambda cold start per request.
A 1GB VPS is enough.

That number is load-bearing and was measured, not estimated. It used to be
1.4GB: the network is millions of small arrays, and as plain JavaScript objects
each `[stop, arrive, depart]` triple cost more in object header than the twelve
bytes inside it. The hot structures — 3.2M stop-times, 3.6M footpaths, 3.2M
stop→service entries — are now CSR typed-array columns, which took heap from
1,205MB to 176MB and halved search latency. The column widths are asserted by
tests in `src/lib/calls.test.js`, because the hosting decision depends on them.

## Data and licences

Six feeds, all fetched from the publishers directly. Read
[DATA_SOURCES.md](DATA_SOURCES.md) and `data/sources/registry.json` before
deploying: they record every source, its licence, its attribution requirement,
and — as importantly — the sources investigated and rejected, with reasons.

| Feed | Licence |
|---|---|
| Germany long-distance, Germany regional, Spain (Renfe) | CC-BY-4.0 |
| Netherlands | CC0-1.0 |
| Switzerland | opentransportdata.swiss terms of use |
| France (SNCF) | ODbL-1.0 |

Two constraints worth knowing before you touch this:

- **SNCF is ODbL**, whose share-alike attaches to a derived *database*. Keep
  `src/data/network.json` unpublished as a dataset while SNCF is in it.
- **Nothing here depends on `api.transitous.org`**, and nothing should. Its
  terms prohibit commercial use and require consuming projects be open source.
  Its feed *catalogue* is CC0 and was legitimate to read as a map of
  publishers.

The code is MIT. Geometry from [Natural Earth](https://www.naturalearthdata.com/)
(public domain) via world-atlas. Airport data from
[OurAirports](https://ourairports.com/data/) (public domain).
