/** Build a small, date-bounded Germany long-distance timetable for Workers.
 * Run from the repository root: node scripts/ingest-edge.mjs [--force]
 * The full, multi-country ingest and network are intentionally untouched.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { buildIndex } from '../src/lib/router.js';

const CACHE = resolve('data/cache');
const URL = 'https://download.gtfs.de/germany/fv_free/latest.zip';
const DAY = 86_400_000;
const MAX_DOWNLOAD = 16 * 1024 * 1024;

function fields(line) {
  const values = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { value += c; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { values.push(value.trim()); value = ''; }
    else value += c;
  }
  values.push(value.trim());
  return values;
}

async function rows(dir, name, visit, required = true) {
  const file = join(dir, name);
  if (!existsSync(file)) {
    if (required) throw new Error(`Missing GTFS table: ${name}`);
    return;
  }
  let header;
  for await (const line of createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const values = fields(line);
    if (!header) { header = values.map((v) => v.replace(/^\uFEFF/, '')); continue; }
    const row = {};
    header.forEach((key, i) => { row[key] = values[i] ?? ''; });
    visit(row);
  }
}

function utc(ymd) {
  const s = String(ymd);
  if (!/^\d{8}$/.test(s)) throw new Error(`Invalid GTFS date: ${s}`);
  const t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  if (new Date(t).toISOString().slice(0, 10).replaceAll('-', '') !== s) throw new Error(`Invalid GTFS date: ${s}`);
  return t;
}

function ymd(t) { return Number(new Date(t).toISOString().slice(0, 10).replaceAll('-', '')); }

function minutes(value) {
  if (!/^\d{1,3}:\d{2}:\d{2}$/.test(value)) return null;
  const [h, m, s] = value.split(':').map(Number);
  return m < 60 && s === 0 && h < 48 ? h * 60 + m : null;
}

async function download(force) {
  mkdirSync(CACHE, { recursive: true });
  const zip = join(CACHE, 'edge-fv-free.zip');
  const metadata = join(CACHE, 'edge-fv-free-meta.json');
  let provenance = existsSync(metadata) ? JSON.parse(readFileSync(metadata, 'utf8')) : null;
  if (force || !existsSync(zip) || !provenance || Date.now() - statSync(zip).mtimeMs > 12 * 60 * 60 * 1000) {
    const response = await fetch(URL, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
    if (!response.ok) throw new Error(`GTFS publisher returned HTTP ${response.status}; existing output is unchanged.`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_DOWNLOAD) throw new Error('GTFS archive exceeds the 16 MiB compact-feed guard.');
      chunks.push(chunk);
    }
    writeFileSync(`${zip}.new`, Buffer.concat(chunks));
    renameSync(`${zip}.new`, zip);
    provenance = { url: URL, retrievedAt: new Date().toISOString(), updatedAt: response.headers.get('last-modified'), archiveBytes: size };
    writeFileSync(metadata, JSON.stringify(provenance));
  }
  const dir = join(CACHE, 'edge-fv-free');
  mkdirSync(dir, { recursive: true });
  const gitUnzip = 'C:/Program Files/Git/usr/bin/unzip.exe';
  const unzip = process.env.EDGE_UNZIP || (process.platform === 'win32' && existsSync(gitUnzip) ? gitUnzip : 'unzip');
  const names = ['agency.txt', 'attributions.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt'];
  // Named extraction avoids archive traversal and leaves unrelated caches alone.
  execFileSync(unzip, ['-o', '-q', zip, ...names, '-d', dir], { stdio: 'pipe' });
  return { dir, provenance };
}

export async function ingestEdge({ force = false } = {}) {
  const { dir, provenance } = await download(force);
  const agencies = new Map(), stopsById = new Map(), routes = new Map(), trips = new Map();
  const weekly = [], exceptions = [];
  await rows(dir, 'agency.txt', (r) => agencies.set(r.agency_id, r));
  const zones = [...new Set([...agencies.values()].map((a) => a.agency_timezone))];
  if (zones.length !== 1 || zones[0] !== 'Europe/Berlin') throw new Error(`Unsupported timetable clocks: ${zones.join(', ')}`);
  await rows(dir, 'stops.txt', (r) => {
    const y = +r.stop_lat, x = +r.stop_lon;
    if (r.stop_lat && r.stop_lon && Number.isFinite(y) && Number.isFinite(x) && Math.abs(y) <= 90 && Math.abs(x) <= 180) {
      stopsById.set(r.stop_id, { n: r.stop_name, y: +y.toFixed(5), x: +x.toFixed(5) });
    }
  });
  await rows(dir, 'routes.txt', (r) => {
    const t = Number(r.route_type);
    if (t === 2 || (t >= 100 && t < 106)) routes.set(r.route_id, r);
  });
  await rows(dir, 'trips.txt', (r) => { if (routes.has(r.route_id)) trips.set(r.trip_id, { ...r, calls: [] }); });
  await rows(dir, 'calendar.txt', (r) => weekly.push(r), false);
  await rows(dir, 'calendar_dates.txt', (r) => exceptions.push(r), false);
  const knownServices = new Set([...trips.values()].map((t) => t.service_id));
  const boundaries = weekly.filter((r) => knownServices.has(r.service_id)).flatMap((r) => [utc(r.start_date), utc(r.end_date)]);
  for (const r of exceptions) if (knownServices.has(r.service_id) && r.exception_type === '1') boundaries.push(utc(r.date));
  if (!boundaries.length) throw new Error('No authoritative service calendars; refusing an undated timetable.');
  const first = Math.min(...boundaries), last = Math.max(...boundaries);
  const calendarDays = (last - first) / DAY + 1;
  if (!Number.isInteger(calendarDays) || calendarDays < 1 || calendarDays > 60) throw new Error(`Calendar spans ${calendarDays} days; the compact format supports at most 60.`);
  const masks = new Map();
  const ensure = (id) => {
    if (!masks.has(id)) masks.set(id, [0, 0]);
    return masks.get(id);
  };
  const setDay = (id, n, runs) => {
    if (n < 0 || n >= calendarDays || !knownServices.has(id)) return;
    const mask = ensure(id), half = Math.floor(n / 30), bit = 1 << (n % 30);
    mask[half] = runs ? mask[half] | bit : mask[half] & ~bit;
  };
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const r of weekly) {
    ensure(r.service_id);
    for (let n = 0; n < calendarDays; n++) {
      const time = first + n * DAY;
      if (time >= utc(r.start_date) && time <= utc(r.end_date) && r[weekdays[new Date(time).getUTCDay()]] === '1') setDay(r.service_id, n, true);
    }
  }
  for (const r of exceptions) {
    if (r.exception_type === '1' || r.exception_type === '2') setDay(r.service_id, (utc(r.date) - first) / DAY, r.exception_type === '1');
  }
  let rejectedTrips = 0;
  await rows(dir, 'stop_times.txt', (r) => {
    const trip = trips.get(r.trip_id);
    if (!trip) return;
    const arrival = minutes(r.arrival_time), departure = minutes(r.departure_time);
    if (!stopsById.has(r.stop_id) || arrival === null || departure === null || arrival > departure) { trip.invalid = true; return; }
    // On-request boarding is not bookable here. Only regular public calls qualify.
    const board = !r.pickup_type || r.pickup_type === '0';
    const alight = !r.drop_off_type || r.drop_off_type === '0';
    trip.calls.push({ sequence: Number(r.stop_sequence), id: r.stop_id, arrival, departure, permission: (board ? 1 : 0) | (alight ? 2 : 0), headsign: r.stop_headsign });
  });
  const stops = [], stopIndex = new Map(), services = [];
  for (const [id, trip] of trips) {
    const mask = masks.get(trip.service_id);
    if (!mask || !(mask[0] || mask[1])) continue;
    trip.calls.sort((a, b) => a.sequence - b.sequence);
    if (trip.invalid || trip.calls.length < 2 || trip.calls.some((c, i) => i && (c.sequence <= trip.calls[i - 1].sequence || c.arrival < trip.calls[i - 1].departure))) { rejectedTrips++; continue; }
    const route = routes.get(trip.route_id);
    let label = route.route_short_name || route.route_long_name || 'Train';
    if (trip.trip_short_name && /^[A-Z]{1,4}$/.test(label)) label += ` ${trip.trip_short_name}`;
    const calls = trip.calls.map((c) => {
      if (!stopIndex.has(c.id)) { stopIndex.set(c.id, stops.length); stops.push(stopsById.get(c.id)); }
      return [stopIndex.get(c.id), c.arrival, c.departure];
    });
    services.push({ i: id, s: label, m: /^(NJ|EN)\b/.test(label) ? 'night_rail' : 'rail', o: agencies.get(route.agency_id)?.agency_name || null, h: trip.trip_headsign || trip.calls[0].headsign || null, l: 1, f: 'de-longdistance', d: mask, c: calls, p: trip.calls.map((c) => c.permission) });
  }
  if (!services.length) throw new Error('The source produced no date-valid trips.');
  const feed = JSON.parse(readFileSync('data/sources/registry.json', 'utf8')).feeds.find((f) => f.id === 'de-longdistance');
  const network = {
    generatedAt: new Date().toISOString(), calendarEpoch: ymd(first), calendarDays,
    sources: [{ id: feed.id, publisher: feed.publisher, licence: feed.licence, licenceUrl: feed.licenceUrl, attribution: feed.attribution, timezones: zones, url: URL, retrievedAt: provenance.retrievedAt, updatedAt: provenance.updatedAt, coverage: 'Germany long-distance rail and international services present in this feed; no local transit or fares.' }],
    stops, services,
  };
  // Compute immutable timetable lookup tables at build time. The Worker
  // hydrates their typed arrays during module startup, keeping preparation,
  // pattern construction and sorting outside the request CPU allowance.
  const index = buildIndex(structuredClone(network));
  const boardings = Array.from({ length: stops.length }, () => []);
  const arrivals = Array.from({ length: stops.length }, () => []);
  for (let si = 0; si < services.length; si++) {
    const service = services[si];
    for (let ci = 0; ci < service.c.length; ci++) {
      const [stop, , departure] = service.c[ci];
      if ((service.p[ci] & 1) && ci < service.c.length - 1) boardings[stop].push([si, ci, departure]);
      if ((service.p[ci] & 2) && ci > 0) arrivals[stop].push([si, ci]);
    }
  }
  for (const list of boardings) list.sort((a, b) => a[2] - b[2]);
  network.edge = {
    boardings, arrivals,
    calls: { stop: [...index.calls.stop], arrive: [...index.calls.arrive], depart: [...index.calls.depart], offset: [...index.calls.offset] },
    stopServiceOffset: [...index.stopServiceOffset], stopServices: [...index.stopServices],
    footOffset: [...index.footOffset], footTo: [...index.footTo], footMin: [...index.footMin],
    dayLo: [...index.dayLo], dayHi: [...index.dayHi],
  };
  const json = JSON.stringify(network), gzipBytes = gzipSync(json).byteLength;
  if (gzipBytes > 2 * 1024 * 1024) throw new Error(`Network gzip is ${gzipBytes} bytes; leaves insufficient room in the 3 MiB free Worker bundle.`);
  const target = resolve('src/data/edge-network.json');
  writeFileSync(`${target}.new`, json);
  renameSync(`${target}.new`, target);
  const report = { stops: stops.length, services: services.length, calls: services.reduce((n, s) => n + s.c.length, 0), calendarFrom: network.calendarEpoch, calendarTo: ymd(last), calendarDays, rejectedTrips, bytes: Buffer.byteLength(json), gzipBytes, sourceUpdatedAt: provenance.updatedAt };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  ingestEdge({ force: process.argv.includes('--force') }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
