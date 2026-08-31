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

import { mkdirSync, writeFileSync, readFileSync, existsSync, createReadStream } from 'node:fs';
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

async function download(feed) {
  mkdirSync(CACHE, { recursive: true });
  const zip = join(CACHE, `${feed.id}.zip`);
  const dir = join(CACHE, feed.id);

  process.stdout.write(`  ${feed.id}: fetching… `);
  const res = await fetch(feed.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${feed.id}: HTTP ${res.status}`);
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
    trips.set(t.trip_id, { routeId: t.route_id, headsign: (t.trip_headsign || '').trim(), serviceId: t.service_id });
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
      service: route.label || trip.headsign || null,
      mode: route.mode,
      operator: route.operator,
      headsign: trip.headsign || null,
      serviceId: trip.serviceId,
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
      });
    }
  }

  mkdirSync(OUT, { recursive: true });
  const network = {
    generatedAt: new Date().toISOString(),
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
