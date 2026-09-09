# Data sources, licenses and attribution

The repository's MIT license covers its code. Each dataset and connected provider retains its own license or agreement. This document distinguishes the current Cloudflare beta from the optional original multi-country engine; inclusion in the registry does not mean a source is bundled in production.

## Current Cloudflare beta

| Source | Use | License/access |
| --- | --- | --- |
| [Germany long-distance GTFS](https://download.gtfs.de/germany/fv_free/latest.zip), DELFI e.V. / gtfs.de | Real direct and one-change rail timetables, including international stops present in the source | CC BY 4.0; publisher-direct download |
| [OurAirports](https://ourairports.com/data/) | Airport reference coordinates/codes and nearby-airport exploration | Public domain; reference data is not a flight schedule |
| [Natural Earth](https://www.naturalearthdata.com/), via world-atlas | Globe geometry | Public domain |
| [Skyscanner Flights Live Prices](https://developers.skyscanner.net/docs/flights-live-prices/overview) | Optional live flight quotes and supplied booking links | Approved partner access required; no key is configured |
| External airline, rail, bus and local-transit sites | User-initiated search/booking handoffs | Links are not copied inventory or a claim of integration |

The bundled rail snapshot generated September 9, 2026 contains **656 stations, 5,217 trips and 52,878 calls**, with calendar coverage September 5–October 5, 2026. The next refresh may change all of these figures. Only dates actually covered by the feed are accepted. It does not include complete regional, bus, metro, or European rail coverage.

Every rail response preserves the source attribution, license URL, publisher update value, retrieval timestamp and calendar bounds. Required credit:

> Timetable data: DELFI e.V. / gtfs.de (CC BY 4.0), © OpenStreetMap contributors

See the [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/), the [publisher's licensing page](https://gtfs.de/en/license/), and [the ingester notes](docs/EDGE-DATA.md). Keep this attribution and the retrieval/update information visible with reused timetable results.

The original source clocks are Europe/Berlin. The ingester retains GTFS service-day minutes, including values after midnight, and weekly calendar exceptions. Local walk/transfer allowances are planning assumptions, not supplied live traffic or accessibility data. Timetable accuracy and operating conditions should be checked with the operator before travel.

## Fares and flight data

The bundled GTFS feed has no retail fares. Its train legs and journeys therefore have `price: null`. User-entered baggage, transfer, or other budget amounts are user estimates, not provider quotes.

The Skyscanner adapter can return actual provider prices once an approved `SKYSCANNER_API_KEY` is configured. Those quotes are for all selected adults and keep their currency, source and retrieval time. Baggage is marked unknown when not supplied. Incomplete searches are labeled partial; incomplete booking-link sets are not presented as a complete purchase. The final seller confirms the current fare and terms.

Before adding a provider, verify its current access requirements and the agreement covering this specific comparison/handoff use. No flight-page scraping is implemented.

## Optional original Node engine

The full ingester reads [`data/sources/registry.json`](data/sources/registry.json). It is an optional separate deployment with a much larger network and different obligations. Its configured sources include:

| Registry source | Recorded license | Current beta bundle |
| --- | --- | --- |
| Germany long-distance | CC BY 4.0 | Yes |
| Germany regional | CC BY 4.0 | No |
| Spain / Renfe | CC BY 4.0 | No |
| Netherlands / OVapi–OpenOV | CC0 1.0 | No |
| Switzerland / opentransportdata.swiss | Publisher terms of use | No |
| France / SNCF Voyageurs | ODbL 1.0 | No |

These are registry records from the earlier investigation, not a fresh confirmation that each endpoint or license remains unchanged. Recheck the publisher's current terms and dataset before enabling a feed. Keep each source's attribution and update metadata with the results it contributes. Cross-border services in one feed do not imply complete domestic coverage of the neighboring country.

### ODbL and public results

Keeping an ODbL-derived database out of Git or behind a private API is **not** an exemption from the license's public-use obligations. Section 4.4 addresses sharing derivative databases under ODbL; section 4.6 also addresses public use of a produced work from a derivative database and the required offer of machine-readable access to the database or qualifying alterations. Review the actual derivation and satisfy the applicable notice, share-alike and access requirements before publishing that service. [ODbL 1.0, sections 4.4–4.6](https://opendatacommons.org/licenses/odbl/1-0/)

The Cloudflare beta avoids mixing the SNCF ODbL source into its bundled network. This does not remove the need to honor CC BY attribution for the feed it does use. A plain assertion in an older registry note or research document is not a substitute for the license text.

## Investigated sources and future expansion

`docs/research/` and the registry retain earlier research, including inaccessible endpoints, unresolved terms and formats that need converters. Treat those records as dated evidence. An unavailable license page is not permission and is not proof of a publisher's refusal; a rehost's label is not a grant from the rights holder. Technical accessibility alone does not establish reuse rights.

The app does not depend on `api.transitous.org`, OpenSky, OpenFlights routes, or public OpenStreetMap tile servers. Any future integration should use the source's current documented access and terms, keep provenance, and make the resulting coverage visible to travelers.
