/** Build the bounded Germany long-distance timetable. Node.js >=22.2.
 * Run from the repository root: node scripts/ingest-edge.mjs [--force]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { crc32, gzipSync, inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { buildIndex, haversineM } from '../src/lib/router.js';

const URL = 'https://download.gtfs.de/germany/fv_free/latest.zip';
const DAY = 86_400_000;
const MAX_DOWNLOAD = 16 * 1024 * 1024;
const MAX_TABLE = 32 * 1024 * 1024;
const MAX_UNPACKED = 64 * 1024 * 1024;
const REQUIRED = ['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt'];
const TABLES = new Set([...REQUIRED, 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt', 'attributions.txt', 'transfers.txt', 'frequencies.txt']);

/** Strict ZIP32 reader. Never writes archive paths or trusts declared inflate size. */
export function readGtfsArchive(zip) {
  const fail = (message) => { throw new Error(`Invalid GTFS archive: ${message}`); };
  if (zip.length > MAX_DOWNLOAD || zip.length < 22) fail('compressed size outside the 16 MiB limit');
  let end = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 65557); p--) {
    if (zip.readUInt32LE(p) === 0x06054b50 && p + 22 + zip.readUInt16LE(p + 20) === zip.length) { end = p; break; }
  }
  if (end < 0) fail('missing end record');
  const count = zip.readUInt16LE(end + 10), centralSize = zip.readUInt32LE(end + 12), central = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 8) !== count || count > 128 || central + centralSize !== end) fail('unsupported multi-disk, ZIP64 or directory layout');
  let p = central, total = 0;
  const names = new Set(), tables = new Map(), ranges = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || zip.readUInt32LE(p) !== 0x02014b50) fail('truncated central directory');
    const flags = zip.readUInt16LE(p + 8), method = zip.readUInt16LE(p + 10), crc = zip.readUInt32LE(p + 16);
    const compressed = zip.readUInt32LE(p + 20), size = zip.readUInt32LE(p + 24);
    const nameSize = zip.readUInt16LE(p + 28), extraSize = zip.readUInt16LE(p + 30), commentSize = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42), next = p + 46 + nameSize + extraSize + commentSize;
    if (next > end) fail('truncated entry');
    const nameBytes = zip.subarray(p + 46, p + 46 + nameSize), name = nameBytes.toString('utf8');
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || names.has(name) || name === '.' || name === '..') fail(`unsafe or duplicate filename: ${name}`);
    names.add(name);
    if (flags & ~0x080e || flags & 1 || ![0, 8].includes(method) || zip.readUInt16LE(p + 34)) fail(`unsupported encoding: ${name}`);
    const mode = (zip.readUInt32LE(p + 38) >>> 16) & 0xf000;
    if (mode && mode !== 0x8000) fail(`non-file entry: ${name}`);
    total += size;
    if (size > MAX_TABLE || total > MAX_UNPACKED) fail('uncompressed size exceeds the 32 MiB table / 64 MiB archive limit');
    if (local + 30 > central || zip.readUInt32LE(local) !== 0x04034b50) fail(`invalid local header: ${name}`);
    const localNameSize = zip.readUInt16LE(local + 26), localExtraSize = zip.readUInt16LE(local + 28);
    const start = local + 30 + localNameSize + localExtraSize;
    if (start + compressed > central || !zip.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes)
      || zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method) fail(`inconsistent local header: ${name}`);
    if (!(flags & 8) && (zip.readUInt32LE(local + 14) !== crc || zip.readUInt32LE(local + 18) !== compressed || zip.readUInt32LE(local + 22) !== size)) fail(`inconsistent local sizes: ${name}`);
    ranges.push([local, start + compressed]);
    if (TABLES.has(name)) {
      const raw = zip.subarray(start, start + compressed);
      const decoded = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
      if (decoded.length !== size || crc32(decoded) !== crc) fail(`size or CRC mismatch: ${name}`);
      tables.set(name, new TextDecoder('utf-8', { fatal: true }).decode(decoded));
    }
    p = next;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (p !== end || ranges.some((r, i) => i && r[0] < ranges[i - 1][1])) fail('overlapping entries or directory mismatch');
  for (const name of REQUIRED) if (!tables.has(name)) fail(`missing table: ${name}`);
  if (!tables.has('calendar.txt') && !tables.has('calendar_dates.txt')) fail('missing calendar.txt and calendar_dates.txt');
  return tables;
}

/** Parse records, including escaped quotes, BOM, CRLF and quoted newlines. */
export function visitCsv(text, name, columns, visit) {
  let header, values = [], field = '', quoted = false, closed = false, row = 1;
  const fail = (message) => { throw new Error(`${name}, record ${row}: ${message}`); };
  const finishField = () => { values.push(field); field = ''; closed = false; };
  const finishRow = () => {
    finishField();
    if (values.length === 1 && values[0] === '') { values = []; return; }
    if (!header) {
      header = values;
      if (header.some((key) => !key || key.trim() !== key) || new Set(header).size !== header.length) fail('empty, duplicate or padded header');
      for (const key of columns) if (!header.includes(key)) fail(`missing column ${key}`);
    } else {
      if (values.length !== header.length) fail(`expected ${header.length} fields, received ${values.length}`);
      visit(Object.fromEntries(header.map((key, i) => [key, values[i]])));
    }
    values = []; row++;
  };
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; }
      } else field += c;
    } else if (c === ',') finishField();
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; finishRow(); }
    else if (closed) fail('characters after closing quote');
    else if (c === '"') { if (field) fail('quote inside unquoted field'); quoted = true; }
    else field += c;
  }
  if (quoted) fail('unterminated quote');
  if (field || values.length || closed) finishRow();
  if (!header) fail('missing header');
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
function atomicWrite(target, value) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.new`;
  try { writeFileSync(temporary, value, { flag: 'wx' }); renameSync(temporary, target); }
  finally { rmSync(temporary, { force: true }); }
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function download({ force, workspaceDir, fetcher, now }) {
  const cache = join(workspaceDir, 'data/cache');
  const zipPath = join(cache, 'edge-fv-free.zip'), metadataPath = join(cache, 'edge-fv-free-meta.json');
  let provenance;
  try { provenance = JSON.parse(readFileSync(metadataPath, 'utf8')); } catch { /* Missing/broken metadata triggers a new download. */ }
  if (!force && provenance?.url === URL && Number.isFinite(Date.parse(provenance.retrievedAt)) && existsSync(zipPath)
    && statSync(zipPath).size <= MAX_DOWNLOAD && now - Date.parse(provenance.retrievedAt) >= 0 && now - Date.parse(provenance.retrievedAt) < 12 * 60 * 60 * 1000) {
    const bytes = readFileSync(zipPath);
    if (bytes.length === provenance.archiveBytes && (!provenance.sha256 || digest(bytes) === provenance.sha256)) return { bytes, provenance, zipPath, metadataPath };
  }
  const response = await fetcher(URL, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`GTFS publisher returned HTTP ${response.status}; existing output is unchanged.`);
  if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD) throw new Error('GTFS archive exceeds the 16 MiB compact-feed guard.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD) throw new Error('GTFS archive exceeds the 16 MiB compact-feed guard.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  provenance = { url: URL, retrievedAt: new Date(now).toISOString(), updatedAt: response.headers.get('last-modified'), archiveBytes: size, sha256: digest(bytes) };
  return { bytes, provenance, zipPath, metadataPath };
}

export async function ingestEdge({ force = false, workspaceDir = process.cwd(), fetcher = fetch, now = Date.now(), log = console.log } = {}) {
  workspaceDir = resolve(workspaceDir);
  const { bytes, provenance, zipPath, metadataPath } = await download({ force, workspaceDir, fetcher, now });
  const tables = readGtfsArchive(bytes);
  const rows = (name, columns, visit) => { if (tables.has(name)) visitCsv(tables.get(name), name, columns, visit); };
  for (const name of ['frequencies.txt', 'transfers.txt']) rows(name, [], () => { throw new Error(`Unsupported GTFS rules in ${name}; refusing to ignore service or transfer constraints.`); });
  const agencies = new Map(), stopsById = new Map(), routes = new Map(), trips = new Map();
  const weekly = [], exceptions = [], feedInfo = [];
  const unique = (map, id, value, name, allowEmpty = false) => {
    if ((!id && !allowEmpty) || map.has(id)) throw new Error(`${name}: empty or duplicate ID ${id}`);
    map.set(id, value);
  };
  rows('agency.txt', ['agency_name', 'agency_timezone'], (r) => unique(agencies, r.agency_id || '', r, 'agency', true));
  if (!agencies.size || (agencies.size > 1 && agencies.has(''))) throw new Error('Multiple agencies require unique agency_id values.');
  const zones = [...new Set([...agencies.values()].map((a) => a.agency_timezone))];
  if (zones.length !== 1 || zones[0] !== 'Europe/Berlin') throw new Error(`Unsupported timetable clocks: ${zones.join(', ')}`);
  rows('stops.txt', ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], (r) => {
    const y = Number(r.stop_lat), x = Number(r.stop_lon);
    if (!r.stop_name || !r.stop_lat || !r.stop_lon || !Number.isFinite(y) || !Number.isFinite(x) || Math.abs(y) > 90 || Math.abs(x) > 180) throw new Error(`Invalid coordinates/name for stop ${r.stop_id}`);
    unique(stopsById, r.stop_id, { n: r.stop_name, y: +y.toFixed(5), x: +x.toFixed(5) }, 'stop');
  });
  const allRoutes = new Map(), allTrips = new Map();
  rows('routes.txt', ['route_id', 'route_type'], (r) => {
    unique(allRoutes, r.route_id, r, 'route');
    if (!/^\d+$/.test(r.route_type)) throw new Error(`Invalid route_type for ${r.route_id}`);
    if (r.agency_id ? !agencies.has(r.agency_id) : agencies.size !== 1) throw new Error(`Unknown agency for route ${r.route_id}`);
    if (+r.route_type === 2 || (+r.route_type >= 100 && +r.route_type < 106)) routes.set(r.route_id, r);
  });
  rows('trips.txt', ['route_id', 'service_id', 'trip_id'], (r) => {
    unique(allTrips, r.trip_id, r, 'trip');
    if (!allRoutes.has(r.route_id) || !r.service_id) throw new Error(`Unknown route or missing service_id for trip ${r.trip_id}`);
    if (routes.has(r.route_id)) trips.set(r.trip_id, { ...r, calls: [] });
  });
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const calendarIds = new Set(), exceptionKeys = new Set(), calendarServices = new Set();
  rows('calendar.txt', ['service_id', ...weekdays, 'start_date', 'end_date'], (r) => {
    if (!r.service_id || calendarIds.has(r.service_id) || weekdays.some((d) => !['0', '1'].includes(r[d]))) throw new Error(`Invalid/duplicate weekly calendar ${r.service_id}`);
    r.start = utc(r.start_date); r.end = utc(r.end_date);
    if (r.end < r.start) throw new Error(`Reversed calendar interval for ${r.service_id}`);
    calendarIds.add(r.service_id); calendarServices.add(r.service_id); weekly.push(r);
  });
  rows('calendar_dates.txt', ['service_id', 'date', 'exception_type'], (r) => {
    const key = JSON.stringify([r.service_id, r.date]);
    if (!r.service_id || exceptionKeys.has(key) || !['1', '2'].includes(r.exception_type)) throw new Error(`Invalid/duplicate calendar exception ${key}`);
    r.time = utc(r.date); exceptionKeys.add(key); calendarServices.add(r.service_id); exceptions.push(r);
  });
  const knownServices = new Set([...trips.values()].map((t) => t.service_id));
  for (const id of knownServices) if (!calendarServices.has(id)) throw new Error(`Trip references unknown service calendar ${id}`);
  const boundaries = weekly.filter((r) => knownServices.has(r.service_id)).flatMap((r) => [r.start, r.end]);
  for (const r of exceptions) if (knownServices.has(r.service_id) && r.exception_type === '1') boundaries.push(r.time);
  if (!boundaries.length) throw new Error('No authoritative service calendars; refusing an undated timetable.');
  let first = Math.min(...boundaries), last = Math.max(...boundaries);
  rows('feed_info.txt', [], (r) => feedInfo.push(r));
  if (feedInfo.length > 1) throw new Error('Expected a single feed_info record.');
  const info = feedInfo[0];
  if (info?.feed_start_date || info?.feed_end_date) {
    if (!info.feed_start_date || !info.feed_end_date) throw new Error('feed_info must provide both coverage dates.');
    const start = utc(info.feed_start_date), end = utc(info.feed_end_date);
    if (end < start) throw new Error('Reversed feed_info coverage interval.');
    first = Math.max(first, start); last = Math.min(last, end);
  }
  const calendarDays = (last - first) / DAY + 1;
  if (!Number.isInteger(calendarDays) || calendarDays < 1 || calendarDays > 60) throw new Error(`Calendar spans ${calendarDays} days; the compact format supports 1 through 60.`);
  const masks = new Map([...knownServices].map((id) => [id, [0, 0]]));
  const setDay = (id, n, runs) => {
    if (n < 0 || n >= calendarDays || !masks.has(id)) return;
    const mask = masks.get(id), half = Math.floor(n / 30), bit = 1 << (n % 30);
    mask[half] = runs ? mask[half] | bit : mask[half] & ~bit;
  };
  for (const r of weekly) for (let n = 0; n < calendarDays; n++) {
    const time = first + n * DAY;
    if (time >= r.start && time <= r.end && r[weekdays[new Date(time).getUTCDay()]] === '1') setDay(r.service_id, n, true);
  }
  for (const r of exceptions) setDay(r.service_id, (r.time - first) / DAY, r.exception_type === '1');
  rows('stop_times.txt', ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'], (r) => {
    if (!allTrips.has(r.trip_id)) throw new Error(`Stop time references unknown trip ${r.trip_id}`);
    const trip = trips.get(r.trip_id);
    if (!trip) return;
    const arrival = minutes(r.arrival_time), departure = minutes(r.departure_time), sequence = Number(r.stop_sequence);
    if (!stopsById.has(r.stop_id) || arrival === null || departure === null || arrival > departure || !/^\d+$/.test(r.stop_sequence) || !Number.isSafeInteger(sequence)) throw new Error(`Invalid stop/time/sequence for trip ${r.trip_id}; minute precision and times below 48:00 are required.`);
    for (const key of ['pickup_type', 'drop_off_type']) if (r[key] && !['0', '1', '2', '3'].includes(r[key])) throw new Error(`Invalid ${key} for trip ${r.trip_id}`);
    const board = !r.pickup_type || r.pickup_type === '0', alight = !r.drop_off_type || r.drop_off_type === '0';
    trip.calls.push({ sequence, id: r.stop_id, arrival, departure, permission: (board ? 1 : 0) | (alight ? 2 : 0), headsign: r.stop_headsign });
  });
  const stops = [], stopIndex = new Map(), services = [];
  for (const [id, trip] of trips) {
    const mask = masks.get(trip.service_id);
    trip.calls.sort((a, b) => a.sequence - b.sequence);
    if (trip.calls.length < 2 || trip.calls.some((c, i) => i && (c.sequence <= trip.calls[i - 1].sequence || c.arrival < trip.calls[i - 1].departure))) throw new Error(`Trip ${id} has missing, duplicate or non-monotonic calls.`);
    if (!(mask[0] || mask[1])) continue;
    const route = routes.get(trip.route_id);
    let label = route.route_short_name || route.route_long_name || 'Train';
    if (trip.trip_short_name && /^[A-Z]{1,4}$/.test(label)) label += ` ${trip.trip_short_name}`;
    const calls = trip.calls.map((c) => {
      if (!stopIndex.has(c.id)) { stopIndex.set(c.id, stops.length); stops.push(stopsById.get(c.id)); }
      return [stopIndex.get(c.id), c.arrival, c.departure];
    });
    const agency = route.agency_id ? agencies.get(route.agency_id) : agencies.values().next().value;
    services.push({ i: id, s: label, m: /^(NJ|EN)\b/.test(label) ? 'night_rail' : 'rail', o: agency.agency_name || null, h: trip.trip_headsign || trip.calls[0].headsign || null, l: 1, f: 'de-longdistance', d: mask, c: calls, p: trip.calls.map((c) => c.permission) });
  }
  if (!services.length) throw new Error('The source produced no date-valid trips.');
  const callCount = services.reduce((n, s) => n + s.c.length, 0);
  if (stops.length > 3000 || services.length > 25000 || callCount > 250000) throw new Error('Timetable exceeds the compact 3,000-stop / 25,000-trip / 250,000-call build guard.');
  const feed = JSON.parse(readFileSync(join(workspaceDir, 'data/sources/registry.json'), 'utf8')).feeds.find((f) => f.id === 'de-longdistance');
  if (!feed?.publisher || !feed.licence || !feed.licenceUrl || !feed.attribution) throw new Error('Missing source licence/attribution registry entry.');
  const network = {
    generatedAt: new Date(now).toISOString(), calendarEpoch: ymd(first), calendarDays,
    sources: [{ id: feed.id, publisher: feed.publisher, licence: feed.licence, licenceUrl: feed.licenceUrl, attribution: feed.attribution, timezones: zones, url: URL, retrievedAt: provenance.retrievedAt, updatedAt: provenance.updatedAt, coverage: 'Germany long-distance rail and international services present in this feed; no local transit or fares.' }], stops, services,
  };
  const index = buildIndex(structuredClone(network));
  const boardings = Array.from({ length: stops.length }, () => []), arrivals = Array.from({ length: stops.length }, () => []);
  for (let si = 0; si < services.length; si++) for (let ci = 0; ci < services[si].c.length; ci++) {
    const [stop, , departure] = services[si].c[ci];
    if ((services[si].p[ci] & 1) && ci < services[si].c.length - 1) boardings[stop].push([si, ci, departure]);
    if ((services[si].p[ci] & 2) && ci > 0) arrivals[stop].push([si, ci]);
  }
  for (const list of boardings) list.sort((a, b) => a[2] - b[2]);
  // This compact feed is small enough for an exact build-time distance sweep.
  // The full router's longitude grid can miss neighbours at higher latitudes.
  const footOffset = [0], footTo = [], footMin = [];
  for (let i = 0; i < stops.length; i++) {
    for (let j = 0; j < stops.length; j++) if (i !== j) {
      const distance = haversineM(stops[i].y, stops[i].x, stops[j].y, stops[j].x);
      if (distance <= 800) { footTo.push(j); footMin.push(Math.max(1, Math.ceil(distance / 80))); }
    }
    footOffset.push(footTo.length);
  }
  network.edge = {
    boardings, arrivals, calls: { stop: [...index.calls.stop], arrive: [...index.calls.arrive], depart: [...index.calls.depart], offset: [...index.calls.offset] },
    stopServiceOffset: [...index.stopServiceOffset], stopServices: [...index.stopServices], footOffset, footTo, footMin, dayLo: [...index.dayLo], dayHi: [...index.dayHi],
  };
  const json = JSON.stringify(network), gzipBytes = gzipSync(json).byteLength;
  if (gzipBytes > 2 * 1024 * 1024) throw new Error(`Network gzip is ${gzipBytes} bytes; leaves insufficient room in the 3 MiB free Worker bundle.`);
  // Validate everything before promoting either downloaded cache or output.
  // A hash ties cache metadata to its archive if interrupted between renames.
  atomicWrite(zipPath, bytes);
  atomicWrite(metadataPath, JSON.stringify({ ...provenance, sha256: digest(bytes) }));
  atomicWrite(join(workspaceDir, 'src/data/edge-network.json'), json);
  const report = { stops: stops.length, services: services.length, calls: callCount, calendarFrom: network.calendarEpoch, calendarTo: ymd(last), calendarDays, rejectedTrips: 0, bytes: Buffer.byteLength(json), gzipBytes, sourceUpdatedAt: provenance.updatedAt };
  log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  ingestEdge({ force: process.argv.includes('--force') }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
