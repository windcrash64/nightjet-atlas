# Data sources, licences and attribution

The **code** in this repository is MIT. That grant does **not** extend to the
data this app ingests. Every source below keeps its own licence, and two of
them constrain how this project may be deployed.

Read this before deploying anything. The machine-readable version — which the
ingester actually reads — is [`data/sources/registry.json`](data/sources/registry.json).

## The rule this project is built on

Feeds are fetched **from their publishers directly**. Never from
`api.transitous.org`, whose usage policy states verbatim:

> "Due to data source licences and resource prioritisation, commercial use is
> not allowed."

Transitous's *feed catalogue* is a different matter: it is CC0-1.0 public
domain (`REUSE.toml`: `path = "feeds/**.json"`,
`SPDX-License-Identifier = "CC0-1.0"`), so it is legitimate to read it as a map
of which publisher serves which country under which licence. Take the map, not
the server.

## Ingested sources

| Source | Covers | Licence | Commercial | Key |
|---|---|---|---|---|
| [gtfs.de long-distance](https://download.gtfs.de/germany/fv_free/latest.zip) | ICE, IC, EC, ECE, EN, RJ — incl. ÖBB, SNCF, SBB, PKP, ČD, MÁV, NS as operators | CC BY 4.0 | Yes | None |
| [gtfs.de regional](https://download.gtfs.de/germany/rv_free/latest.zip) | RB, RE, IRE, S-Bahn, non-federal railways | CC BY 4.0 | Yes | None |
| [Renfe](https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip) | AVE, AVLO, ALVIA, Intercity, AVANT, MD | CC BY 4.0 | Yes | None |
| [SNCF Voyageurs](https://transport.data.gouv.fr/) | TGV, Intercités, TER | **ODbL 1.0** | Yes, **share-alike** | None |

Required attribution, rendered in the app footer:

- Timetable data: DELFI e.V. / gtfs.de (CC BY 4.0), © OpenStreetMap contributors
- Timetable data: Renfe Operadora (CC BY 4.0)
- Timetable data: SNCF Voyageurs, via transport.data.gouv.fr (ODbL 1.0)

Separately, **EU Delegated Regulation 2017/1926 Art. 8(3)** requires that
reused travel data carry its source *and* the last-update time of the static
data — regardless of what the licence says. The app shows both.

### The ODbL constraint on SNCF

ODbL's share-alike attaches to a **derived database**, not merely to the file.
Serving journey *results* is fine. Publishing `src/data/network.json` as a
dataset while SNCF data is inside it would oblige us to license that derivative
under ODbL too. The file is gitignored, and this is recorded in the registry
beside the feed rather than in a document nobody re-reads.

## Bundled data

| Dataset | File | Licence | Attribution required? |
|---|---|---|---|
| [OurAirports](https://ourairports.com/data/) | `src/data/airports.json` | Public domain (Unlicense) | No (credited anyway) |
| [Natural Earth](https://www.naturalearthdata.com/) via world-atlas | npm dependency | Public domain | No (credited anyway) |

## Investigated and deliberately not used

Recorded so the reasoning is not lost and nobody re-litigates it.

| Source | Why not |
|---|---|
| **Italy (Trenitalia)** | Publishes **NeTEx only** — a single 370MB XML, no GTFS. Our ingester reads GTFS. Partial mitigation: the French Trenitalia feed carries Paris–Milano. |
| **Austria (MVO)** | Host resolves but refuses TCP on 443, and every dataset needs a Keycloak OAuth token. Partial mitigation: the German long-distance feed already carries ÖBB as an operating agency with RJ, EN, EC, IC and ICE into Austria. |
| **Belgium (SNCB)** | The feed works and serves 1,489 rail routes but states **no licence at all** — unlike its neighbours, which all carry CC BY 4.0. Technically working, legally unestablished. |
| **Denmark, Sweden** | Working feeds whose licence text could not be retrieved. Unverified terms are not a basis to ingest. |
| **Czechia, Poland** | Permissive licences (CC0, CC BY 4.0) but served from third-party rehosts (`data.jr.ggu.cz`, `gtfs.kasznia.net`) rather than operator-owned URLs. A single volunteer is the uptime dependency. |
| **Germany local transit** | 272MB of buses, trams and subways. Out of scope for an intercity planner and it would dominate the graph. |
| **DELFI GTFS-Realtime** | **CC BY-SA** (share-alike), unlike the CC BY static feed. Needs an isolated pipeline stage before share-alike can be allowed near anything else. |
| **OpenFlights routes** | Frozen since 2014; upstream says it is "of historical value only". |
| **OpenSky Network** | Its licence names "integration into a live product, service, or automated system" as requiring a written agreement, even for non-profits. A keyless HTTP 200 is not permission. |
| **Duffel** | Its Services Agreement bans building metasearch on the platform. A comparison tool that does not create orders is contractually prohibited, not merely expensive. |
| **Amadeus Self-Service** | Decommissioned 2026-07-17; the hosts no longer resolve. Most tutorials still recommend it. |
| **Google Flights scraping** | `google.com/robots.txt` disallows `/travel/flights/search`, and the technique relies on TLS-fingerprint impersonation. |
| **`tile.openstreetmap.org` as a basemap** | Returns its "Access blocked" page as `HTTP 200 image/png`, so status codes cannot detect a block. Volunteer infrastructure, withdrawable without notice. We render vector geometry ourselves instead. |

## No fares, anywhere

Open transit feeds carry schedules, not retail prices, and there is no free,
legitimate source of European rail fares. `price` is `null` on every leg and
every journey, enforced by a test. Where a feed supplies a link to where a
ticket is sold, the app links out; where it does not, the app says so.
