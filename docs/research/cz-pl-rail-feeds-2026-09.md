# Official rail GTFS for Czechia and Poland

**Researched:** 2026-09-01
**Question:** We depend on two volunteer rehosts (`data.jr.ggu.cz` for Czechia,
`gtfs.kasznia.net` for Poland). Does an operator-owned or government-owned
source exist for either, and does its licence permit commercial use?

**Answer:** Czechia yes, with a catch. Poland no, and the volunteer feed's
licence may itself be unfounded.

---

## Czechia — official source exists, licence is the best available, no GTFS

**Publisher:** Ministerstvo dopravy + CHAPS spol. s r.o., via CIS JŘ
(Celostátní informační systém o jízdních řádech).

- Portal: https://portal.cisjr.cz/ — anonymous, no login
- Registered on data.gov.cz under EU Directive 2019/1024
- Access rights `PUBLIC`, updated 3× weekly
- `https://www.nap.cz/` returns **403** — dead end, do not use

### The licence is as clean as it gets

Resolved through data.gov.cz's SPARQL endpoint (the web UI is a JS shell).
The Czech state declares, in machine-readable form, all four of:

| Assertion | Value |
|---|---|
| `skos:narrowMatch` | **CC0** (EU Publications Office authority) |
| autorské-dílo | contains **no copyrighted works** |
| databáze-jako-autorské-dílo | **not** a copyright-protected database |
| databáze-chráněná-zvláštními-právy | **no** sui generis database right |

Source: `https://data.gov.cz/zdroj/datové-sady/66003008/1224193768/distribuce/6685410c556c969c531f20762e279e17/podmínky-užití`

With no exclusive right asserted at all, there is nothing left to restrict
commercial reuse. This is materially stronger than the `CC0-1.0` tag a
volunteer applied to the rehost — that tag is a third party's opinion; this is
the publisher disclaiming rights.

### The catch: no GTFS anywhere

`portal.cisjr.cz/pub/` contains exactly `draha`, `JDF`, `netex`, `seznamy`.
There is no `gtfs` folder. What exists:

- `pub/netex/NeTEx_GVD2026.zip` — NeTEx, >10MB, anonymous
- `pub/draha/celostatni/szdc/2026/JR2026.zip` — CZPTT XML, >10MB, anonymous
- `pub/netex/CISJR_NeTEx.pdf` — 377KB spec

`data.jr.ggu.cz` is a **conversion** of the CZPTT branch, not a mirror. Moving
to the official source therefore means owning a NeTEx→GTFS (or CZPTT→GTFS)
converter, **including synthesising extended route types 100–105 ourselves** —
NeTEx has no `route_type`, it uses its own vehicle-mode taxonomy.

### Two things to check before shipping

1. The same metadata node declares `osobní-údaje` → **contains personal data**.
   Almost certainly an entry error for a timetable, but CC0 does not waive
   GDPR. Inspect the payload.
2. ČD / RegioJet / Leo Express presence is **inferred** from CIS JŘ submission
   being a legal obligation for licensed carriers — not observed. Both zips
   exceeded the fetch cap, so nobody has actually opened them yet.

---

## Poland — do not ingest

### There is no official GTFS at any reachable URL

Queried `api.dane.gov.pl` directly (the portal itself is a JS shell):

- `?q=GTFS` → only Gmina Legnica, ZTM Katowice/GZM, Metropolia GZM. All urban,
  all CC BY 4.0. **No PKP, no rail.**
- `?q=rozkład jazdy kolej` → no GTFS format at all
- `institutions?q=PKP` → **PKP Intercity, PKP PLK, POLREGIO and Ministerstwo
  Infrastruktury are not registered as data-providing institutions**

Also dead: `kpd.gov.pl` (DNS ENOTFOUND — the domain does not exist),
`utk.gov.pl` (403), NAPCORE's own NAP list (404).

### The official source is gated and rights-reserved

`https://pdp-api.plk-sa.pl/` — "Otwarte Dane Kolejowe", operated by PKP PLK.
Found via the footer of portalpasazera.pl.

- **JSON only.** No GTFS, no NeTEx, no bulk download. Query-and-paginate.
- **Registration required**, then **3–5 business days of manual administrator
  verification**. Discretionary approval, not self-service.
- Footer, verbatim: *"© 2025 Otwarte Dane Kolejowe. PKP Polskie Linie
  Kolejowe S.A. **Wszelkie prawa zastrzeżone**"* — all rights reserved.

A service branded "Otwarte Dane" that reserves all rights is not offering a
licence. Ingesting it into a commercial product means operating on revocable
discretionary permission. The referenced *regulamin* v1.0 could not be
retrieved, so the actual clause is unknown — unresolved, not proven hostile,
but nowhere near a green light.

### The volunteer feed's licence claim is unverified

`feeds/pl.json` in the Transitous catalogue tags `gtfs.kasznia.net/static/pkp-ic.zip`
and `polish-trains.zip` as `CC-BY-4.0`. **That tag is the Transitous
maintainers' own characterisation.** No corresponding PKP grant was found
anywhere. So the rehost we already considered fragile may also be resting on a
licence claim nobody can trace.

The related RT host `mkuran.pl` returned **403** during this research — a live
demonstration of the fragility concern.

---

## Decision

**Neither is being added right now.**

- **Poland: excluded on licence grounds**, upgraded from "fragile rehost" to
  "no defensible licence at all". The registry entry now says so. If Poland
  ever matters commercially, the next step is not more searching — it is
  retrieving the PKP PLK regulamin v1.0 and asking them directly.
- **Czechia: viable but deferred.** The licence is the best of any feed we
  have looked at, and better than what we would get from the rehost. But it
  costs a NeTEx→GTFS converter with hand-synthesised route types. That is a
  project, not an ingest config change. Worth doing precisely because it
  removes a single-volunteer dependency on the country with the cleanest
  licence — and it can be de-risked by diffing the converter's output against
  `data.jr.ggu.cz` before cutting over.

## Gaps in this research

- Neither Czech zip was opened (both exceeded the 10MB fetch cap), so operator
  coverage is inferred from legal scope, not observed.
- The PKP PLK regulamin full text was not retrieved.
- Poland's NAP may exist under a domain not reached; the search budget was
  exhausted, and the Polish half was completed by direct endpoint fetching
  rather than search. Coverage there is genuinely thinner.

## Sources

- https://portal.cisjr.cz/ and /pub/netex/ — official CZ, fetched
- https://data.gov.cz/ — licence resolved via SPARQL endpoint
- https://api.dane.gov.pl/1.4/datasets?q=GTFS — queried directly
- https://pdp-api.plk-sa.pl/ and /docs — official PL, gated
- https://portalpasazera.pl/ — official PKP PLK timetable portal
- https://raw.githubusercontent.com/public-transport/transitous/main/feeds/cz.json
- https://raw.githubusercontent.com/public-transport/transitous/main/feeds/pl.json
