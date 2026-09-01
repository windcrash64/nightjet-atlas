/**
 * Ingests real GTFS feeds into a compact network file the app can query.
 *
 * Sources and licences are declared in data/sources/registry.json. Every feed
 * here permits commercial use; see DATA_SOURCES.md for the evidence. We fetch
 * from the publishers directly — never through Transitous, whose service terms
 * forbid commercial use even though their feed catalogue is CC0.
 *
 * Run: node scripts/ingest.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const REGISTRY = JSON.parse(readFileSync('data/sources/registry.json', 'utf8'));
const CACHE = 'data/cache';
const OUT = 'src/data';

/** Minimal CSV reader for GTFS. Handles quoted fields containing commas. */
function parseCsv(text) {
  const lines = text.split('\n');
  if (!lines.length) return [];
  const header = splitLine(lines[0]).map((h) => h.replace(/^﻿/, '').trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const v = splitLine(lines[i]);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = (v[c] ?? '').trim();
    out.push(row);
  }
  return out;
}

function splitLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.replace(/^"|"$/g, ''));
}

/** Reuse a download for this long before fetching again. */
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

async function download(feed, { force = false } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const zip = join(CACHE, `${feed.id}.zip`);
  const dir = join(CACHE, feed.id);

  // Re-fetching 213MB on every run is slow and rude — OVapi returned HTTP 429
  // after a few iterations of exactly that. Timetables change daily at most, so
  // a cached copy from this morning is the same data.
  if (!force && existsSync(zip) && existsSync(join(dir, 'stop_times.txt'))) {
    const age = Date.now() - statSync(zip).mtimeMs;
    if (age < CACHE_MAX_AGE_MS) {
      console.log(`  ${feed.id}: cached (${(age / 3600000).toFixed(1)}h old)`);
      return dir;
    }
  }

  process.stdout.write(`  ${feed.id}: fetching… `);
  const res = await fetch(feed.url, { redirect: 'follow' });
  if (!res.ok) {
    // A rate limit or an outage should not throw away a usable local copy.
    if (existsSync(join(dir, 'stop_times.txt'))) {
      console.log(`HTTP ${res.status} — using the cached copy`);
      return dir;
    }
    throw new Error(`${feed.id}: HTTP ${res.status} and no cached copy to fall back on`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(zip, buf);
  console.log(`${(buf.length / 1048576).toFixed(1)} MB`);

  mkdirSync(dir, { recursive: true });
  // unzip is available in git-bash on Windows and everywhere else we run.
  execSync(`unzip -o -q "${zip}" -d "${dir}"`, { stdio: 'pipe' });
  return dir;
}

function table(dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) return [];
  return parseCsv(readFileSync(p, 'utf8'));
}

/**
 * Which of a route's two names a traveller would actually recognise.
 *
 * A named service class ("ICE 29", "AVE", "TGV", "NJ 40233") is what is printed
 * on the train and on the departure board, so it always wins. Otherwise prefer
 * a corridor description ("Marseille - Toulon - Hyeres") over an internal line
 * code ("C30"), which means nothing to anyone outside the operator.
 */
const SERVICE_CLASS = /^(ICE|ICN|IC|ECE|EC|EN|NJ|RJX|RJ|TGV|THA|FR|AVE|AVLO|ALVIA|AVANT|IR|EST|FLX|MD|REG)\b/i;

function pickLabel(short, long) {
  if (short && SERVICE_CLASS.test(short)) return short;
  if (long && long.length <= 48) return long;
  return short || long || null;
}

/**
 * Adds the train number to a bare service class: "NJ" becomes "NJ 470".
 *
 * Only when the label really is just a class. A label that already carries a
 * number ("ICE 29") or names a corridor ("Paris - Côte d'Azur TGV") is left
 * alone — appending to those produces noise, not precision.
 */
function withNumber(label, number) {
  if (!label || !number) return label;
  if (!/^[A-Z]{1,4}$/.test(label.trim())) return label;
  return `${label.trim()} ${number}`;
}

/**
 * Whether a route is long-distance, decided from the feed rather than the name.
 *
 * GTFS extended route types: 101 high-speed, 102 long-distance, 103 inter-
 * regional, 105 sleeper. Types 106+ are regional. The plain type 2 says only
 * "rail", so for those feeds we still fall back to the service designation.
 * https://gtfs.org/schedule/reference/#routestxt
 */
const SERVICE_CLASSES = new Set([
  'ICE', 'ICN', 'IC', 'EC', 'ECE', 'EN', 'NJ', 'RJ', 'RJX',
  'TGV', 'THA', 'FR', 'AVE', 'AVLO', 'ALVIA', 'AVANT', 'IR', 'EST', 'FLX', 'D',
]);

function isLongDistanceRouteType(routeType, shortName = '', longName = '') {
  const t = Number(routeType);
  if (t >= 100 && t <= 105) return true;
  if (t >= 106 && t < 200) return false;      // regional: the feed is explicit

  // Plain type 2 says only "rail", so read the designation. SNCF puts an
  // internal code in route_short_name ("631B") and the class at the END of
  // route_long_name ("Paris - Marseille - Toulon TGV"), so both fields have to
  // be checked — reading only the short name made every French TGV a local
  // train and left Paris-Marseille with no direct service at all.
  const cls = shortName.trim().toUpperCase().split(/[\s\d]/)[0];
  if (SERVICE_CLASSES.has(cls)) return true;

  for (const token of longName.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (token && SERVICE_CLASSES.has(token.replace(/\d+$/, '') || token)) return true;
  }
  return false;
}

/** GTFS route_type -> our mode vocabulary. https://gtfs.org/schedule/reference/#routestxt */
function modeFor(routeType, shortName = '') {
  const t = Number(routeType);
  // Night trains are not a GTFS route_type; they are identified by the
  // service designation the operator prints on the train (NJ, EN).
  if (/^(NJ|EN)\b/i.test(shortName.trim())) return 'night_rail';
  if (t === 2 || (t >= 100 && t < 200)) return 'rail';
  if (t === 3 || (t >= 700 && t < 800) || t === 200) return 'coach';
  if (t === 4 || (t >= 1000 && t < 1100)) return 'ferry';
  if (t === 1 || (t >= 400 && t < 500)) return 'metro';
  if (t === 0 || (t >= 900 && t < 1000)) return 'tram';
  return 'rail';
}

function hhmmToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m; // GTFS allows >24h for trips past midnight; we keep that.
}

/**
 * Which of the next HORIZON_DAYS each service runs, as a bitmask.
 *
 * Storing a date list per service would be enormous — the Swiss feed alone has
 * 10.7 million calendar_dates rows. A 60-day horizon fits in a single number
 * per service if we use a BigInt-free pair of 32-bit halves, but plain JS
 * numbers are exact to 53 bits, so one number covers 53 days and two cover
 * anything we need. 60 days is more than a journey planner needs to answer
 * "today and the next few weeks", and the feeds themselves only publish a
 * season ahead.
 *
 * calendar_dates.txt is streamed for the same reason stop_times.txt is: at
 * 278MB the Swiss file cannot be held as one string.
 */
const HORIZON_DAYS = 60;

/** Day 0 of the horizon: the date this ingest ran, as a local calendar day. */
const EPOCH_YMD = (() => {
  const now = new Date();
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
})();

/**
 * Pack a 60-day run mask into two 30-bit integers, `[days0_29, days30_59]`.
 *
 * Bitwise operators in JS coerce to int32, so 30 bits per half stays clear of
 * the sign bit. A service the calendar never mentions returns null rather than
 * all-zero: "we do not know" and "runs on no day" are different claims, and
 * the router must be free to treat an unknown service as runnable rather than
 * silently deleting a feed that ships no calendar at all.
 */
function packDays(slots) {
  if (!slots) return null;
  let lo = 0, hi = 0;
  for (let n = 0; n < 30; n++) if (slots[n]) lo |= (1 << n);
  for (let n = 30; n < HORIZON_DAYS; n++) if (slots[n]) hi |= (1 << (n - 30));
  return [lo, hi];
}

function ymdToDayNumber(ymd, epochYmd) {
  const toUtc = (v) => Date.UTC(
    Math.floor(v / 10000), Math.floor(v / 100) % 100 - 1, v % 100,
  );
  return Math.round((toUtc(ymd) - toUtc(epochYmd)) / 86400000);
}

function dayNumberToYmd(n, epochYmd) {
  const base = Date.UTC(
    Math.floor(epochYmd / 10000), Math.floor(epochYmd / 100) % 100 - 1, epochYmd % 100,
  );
  const d = new Date(base + n * 86400000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/**
 * Resolve `service_id -> boolean[HORIZON_DAYS]`, starting at `epochYmd`.
 * Reads calendar.txt for the weekly pattern and streams calendar_dates.txt for
 * the exceptions. A feed may ship either or both — the Netherlands and France
 * ship no calendar.txt at all, so a weekly-pattern-only reader loses them.
 */
async function readCalendar(dir, epochYmd) {
  const runs = new Map();
  const ensure = (id) => {
    let d = runs.get(id);
    if (!d) { d = new Uint8Array(HORIZON_DAYS); runs.set(id, d); }
    return d;
  };

  const calPath = join(dir, 'calendar.txt');
  if (existsSync(calPath)) {
    for (const row of table(dir, 'calendar.txt')) {
      const id = (row.service_id || '').trim();
      if (!id) continue;
      const days = [
        row.monday, row.tuesday, row.wednesday, row.thursday,
        row.friday, row.saturday, row.sunday,
      ].map((v) => ((v || '').trim() === '1' ? 1 : 0));
      const start = Number((row.start_date || '').trim()) || 0;
      const end = Number((row.end_date || '').trim()) || 99999999;
      const slots = ensure(id);
      for (let n = 0; n < HORIZON_DAYS; n++) {
        const ymd = dayNumberToYmd(n, epochYmd);
        if (ymd < start || ymd > end) continue;
        // Monday-first, matching the column order above.
        const dow = (new Date(Date.UTC(
          Math.floor(ymd / 10000), Math.floor(ymd / 100) % 100 - 1, ymd % 100,
        )).getUTCDay() + 6) % 7;
        if (days[dow]) slots[n] = 1;
      }
    }
  }

  const datesPath = join(dir, 'calendar_dates.txt');
  if (existsSync(datesPath)) {
    await new Promise((resolve, reject) => {
      const rl = createInterface({
        input: createReadStream(datesPath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      let cols = null;
      rl.on('line', (line) => {
        if (!line) return;
        const c = splitLine(line);
        if (!cols) {
          // Column ORDER differs between feeds: the German ones write
          // service_id,exception_type,date while everyone else writes
          // service_id,date,exception_type. Reading by position gets a date
          // where the exception type should be.
          cols = {};
          c.forEach((name, i) => {
            cols[name.replace(/^﻿/, '').trim().replace(/^"(.*)"$/, '$1')] = i;
          });
          return;
        }
        const clean = (v) => (v ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
        const id = clean(c[cols.service_id]);
        const ymd = Number(clean(c[cols.date]));
        const kind = clean(c[cols.exception_type]);
        if (!id || !ymd) return;
        const n = ymdToDayNumber(ymd, epochYmd);
        if (n < 0 || n >= HORIZON_DAYS) return;
        if (kind === '1') ensure(id)[n] = 1;
        else if (kind === '2') { const d = runs.get(id); if (d) d[n] = 0; }
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });
  }

  return runs;
}

async function ingestFeed(feed) {
  const dir = await download(feed);

  // GTFS times are LOCAL TO THE AGENCY, not UTC — 08:51 in the Renfe feed is
  // 08:51 in Madrid. Every country ingested so far is on CET, so times are
  // directly comparable; record the zone anyway so the first non-CET feed does
  // not silently produce journeys that are hours wrong.
  const agencyRows = table(dir, 'agency.txt');
  const agencies = Object.fromEntries(agencyRows.map((a) => [a.agency_id, a.agency_name]));
  const zones = [...new Set(agencyRows.map((a) => (a.agency_timezone || '').trim()).filter(Boolean))];
  const stopRows = table(dir, 'stops.txt');
  const routeRows = table(dir, 'routes.txt');
  const tripRows = table(dir, 'trips.txt');

  // Which days each service_id actually runs. Without this the planner offers
  // every trip on every date: on the German long-distance feed only 160 of 899
  // service_ids run all seven days, so 82% of them would be offered on days
  // they do not operate.
  const calendarRuns = await readCalendar(dir, EPOCH_YMD);

  const stops = new Map();
  for (const s of stopRows) {
    const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stops.set(s.stop_id, { id: s.stop_id, name: s.stop_name, lat, lon });
  }

  const routes = new Map();
  let droppedRoutes = 0;
  for (const r of routeRows) {
    const short = (r.route_short_name || '').trim();
    const long = (r.route_long_name || '').trim();

    // Some national feeds ship the whole country: Switzerland's is 232MB
    // zipped and 3.7GB unpacked, most of it municipal buses. `keepModes` in
    // the registry keeps such a feed to the modes an intercity planner uses,
    // dropping the rest before it reaches the graph.
    if (feed.keepModes) {
      const mode = modeFor(r.route_type, short);
      if (!feed.keepModes.includes(mode)) { droppedRoutes++; continue; }
    }
    // A finer filter for feeds that ship a whole country's rail network.
    // Switzerland's regional and S-Bahn services alone were 381,581 of the
    // 541,447 services in the graph — 70% of the cost for one small country's
    // local trains — and they tripled search latency. GTFS extended route types
    // separate them: 100-105 are long-distance and express, 106+ are regional.
    // https://gtfs.org/schedule/reference/#routestxt
    if (feed.maxRouteType != null) {
      const t = Number(r.route_type);
      // Applies to the RAIL range only. Ferries are 1000-1099 and would all be
      // above any sane rail cap, which silently dropped 2,033 Swiss lake boats.
      if (t >= 100 && t < 200 && t > feed.maxRouteType) { droppedRoutes++; continue; }
    }

    routes.set(r.route_id, {
      short,
      long,
      // GTFS extended route types 101-105 mean high-speed and long-distance
      // rail. Recording that here is the only reliable signal for a feed like
      // SNCF's, whose labels are corridor descriptions ("Paris - Marseille -
      // Toulon TGV") with no service-class token for a name-based classifier to
      // find. Without it every French TGV counted as a local train, and
      // Paris-Marseille returned no journeys at all.
      longDistance: isLongDistanceRouteType(r.route_type, short, long),
      // The label a traveller would recognise. German feeds put the service
      // designation in route_short_name ("ICE 29"); SNCF puts an internal line
      // code there ("C30", "P53") and the actual corridor in route_long_name
      // ("Marseille - Toulon - Hyeres"), which is far more use on a results row.
      label: pickLabel(short, long),
      mode: modeFor(r.route_type, short),
      operator: agencies[r.agency_id] || null,
    });
  }

  // Only trips on routes that survived the mode filter. Everything downstream
  // keys off this, so a dropped route costs nothing further.
  const trips = new Map();
  for (const t of tripRows) {
    if (!routes.has(t.route_id)) continue;
    trips.set(t.trip_id, {
      routeId: t.route_id,
      headsign: (t.trip_headsign || '').trim(),
      // The train number a passenger sees on the platform board. The German
      // feed omits it entirely (its trips.txt has three columns), so every
      // Nightjet there is just "NJ"; the Swiss feed carries it on all 2.1
      // million of its trips, which turns "NJ" into "NJ 470".
      number: (t.trip_short_name || '').trim(),
      serviceId: t.service_id,
    });
  }
  if (droppedRoutes) {
    console.log(`    filtered out ${droppedRoutes.toLocaleString()} routes not in [${feed.keepModes.join(', ')}]`);
  }

  // stop_times is by far the largest table — Switzerland's is 2.87GB, which
  // readFileSync cannot hold and Node cannot even represent as one string.
  // Stream it a line at a time and keep only the rows for trips that survived
  // the mode filter.
  const byTrip = new Map();
  await new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(join(dir, 'stop_times.txt'), { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let iTrip = -1, iArr = -1, iDep = -1, iStop = -1, iSeq = -1;
    let first = true;

    rl.on('line', (line) => {
      if (first) {
        first = false;
        const h = splitLine(line).map((x) => x.replace(/^﻿/, '').trim());
        iTrip = h.indexOf('trip_id');
        iArr = h.indexOf('arrival_time');
        iDep = h.indexOf('departure_time');
        iStop = h.indexOf('stop_id');
        iSeq = h.indexOf('stop_sequence');
        return;
      }
      if (!line) return;
      const v = splitLine(line);
      const tripId = v[iTrip];
      if (!trips.has(tripId)) return;
      const stopId = v[iStop];
      if (!stops.has(stopId)) return;
      let arr = byTrip.get(tripId);
      if (!arr) { arr = []; byTrip.set(tripId, arr); }
      arr.push({
        seq: Number(v[iSeq]),
        stopId,
        arr: hhmmToMinutes(v[iArr]),
        dep: hhmmToMinutes(v[iDep]),
      });
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  // Collapse to services: one entry per trip, with its ordered calls.
  const services = [];
  for (const [tripId, calls] of byTrip) {
    if (calls.length < 2) continue;
    calls.sort((a, b) => a.seq - b.seq);
    const trip = trips.get(tripId);
    const route = routes.get(trip.routeId);
    if (!route) continue;
    services.push({
      id: tripId,
      // "NJ" alone cannot tell one Nightjet from another; "NJ 470" can. Append
      // the train number when the feed supplies one and the label is a bare
      // service class rather than an already-specific name.
      service: withNumber(route.label, trip.number) || trip.headsign || null,
      longDistance: route.longDistance,
      mode: route.mode,
      operator: route.operator,
      headsign: trip.headsign || null,
      serviceId: trip.serviceId,
      // The 60-day horizon as two 30-bit integers. A per-service array would
      // add 60 numbers to each of 384,515 services; two ints add two. Days
      // 0-29 in the first, 30-59 in the second, bit n = day n.
      days: packDays(calendarRuns.get(trip.serviceId)),
      calls: calls.map((c) => [c.stopId, c.arr, c.dep]),
    });
  }

  return { feed, stops, services, zones };
}

async function main() {
  console.log('Ingesting real GTFS feeds\n');
  const parts = [];
  for (const feed of REGISTRY.feeds) {
    parts.push(await ingestFeed(feed));
  }

  // Merge. Stop ids collide across feeds, so namespace them by feed.
  const stops = [];
  const services = [];
  const stopIndex = new Map();
  for (const p of parts) {
    for (const s of p.stops.values()) {
      const key = `${p.feed.id}:${s.id}`;
      stopIndex.set(key, stops.length);
      stops.push({ n: s.name, y: +s.lat.toFixed(5), x: +s.lon.toFixed(5) });
    }
    for (const svc of p.services) {
      const calls = svc.calls
        .map(([sid, a, d]) => [stopIndex.get(`${p.feed.id}:${sid}`), a, d])
        .filter(([i]) => i !== undefined);
      if (calls.length < 2) continue;
      services.push({
        s: svc.service, m: svc.mode, o: svc.operator,
        h: svc.headsign, c: calls, f: p.feed.id,
        l: svc.longDistance ? 1 : 0,
        // Which of the next 60 days this runs, as [days0_29, days30_59].
        // Omitted entirely when the feed's calendar never mentions the
        // service — absent means "unknown", which is not the same as "never".
        ...(svc.days ? { d: svc.days } : {}),
      });
    }
  }

  mkdirSync(OUT, { recursive: true });
  const network = {
    generatedAt: new Date().toISOString(),
    // Day 0 of every service's `d` bitmask. Without this the masks cannot be
    // read back, and a stale network.json would silently answer for the wrong
    // dates rather than refusing to.
    calendarEpoch: EPOCH_YMD,
    calendarDays: HORIZON_DAYS,
    sources: REGISTRY.feeds.map((f) => {
      const part = parts.find((p) => p.feed.id === f.id);
      return {
        id: f.id, publisher: f.publisher, licence: f.licence,
        licenceUrl: f.licenceUrl, attribution: f.attribution,
        timezones: part?.zones ?? [],
      };
    }),
    stops,
    services,
  };
  const json = JSON.stringify(network);
  writeFileSync(join(OUT, 'network.json'), json);

  const modes = {};
  for (const s of services) modes[s.m] = (modes[s.m] || 0) + 1;

  // GTFS times are local to the operating agency. While every feed sits in the
  // same zone those minutes are directly comparable and the router can treat
  // them as one clock. The moment a feed from another zone arrives, that stops
  // being true and journeys spanning the boundary will be silently wrong — so
  // fail loudly here rather than ship plausible nonsense.
  // Compare OFFSETS, not zone names: Europe/Berlin, Europe/Madrid and
  // Europe/Paris are three names for the same clock, and warning about them
  // would be noise that trains people to ignore the warning that matters.
  const allZones = [...new Set(parts.flatMap((p) => p.zones))];
  const offsetOf = (zone) => {
    try {
      const d = new Date('2026-07-01T12:00:00Z');   // summer, so DST is in effect
      const s = d.toLocaleString('en-US', { timeZone: zone, hour12: false, hour: '2-digit' });
      return Number(s);
    } catch { return NaN; }
  };
  const offsets = [...new Set(allZones.map(offsetOf))];
  if (offsets.length > 1) {
    console.error(`\n  ⚠  Feeds span ${offsets.length} DIFFERENT clocks: ${allZones.join(', ')}`);
    console.error('     GTFS times are agency-local, so minutes from different offsets are');
    console.error('     NOT comparable. The router must convert before this ships.');
  } else {
    console.log(`  timezones: ${allZones.join(', ')} — one clock, times comparable`);
  }

  console.log(`\n  stops:    ${stops.length.toLocaleString()}`);
  console.log(`  services: ${services.length.toLocaleString()}`);
  console.log(`  by mode:  ${Object.entries(modes).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`  size:     ${(json.length / 1048576).toFixed(1)} MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
