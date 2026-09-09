import test from 'node:test';
import assert from 'node:assert/strict';
import { createEdgeRailSearch, edgeRailSearch, pruneDominatedJourneys } from './edge-rail.js';
import { ingestEdge, readGtfsArchive, visitCsv } from '../scripts/ingest-edge.mjs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, deflateRawSync } from 'node:zlib';

const pairwise = (journeys) => journeys.filter((j) => !journeys.some((p) => p !== j
  && p.departMin >= j.departMin && p.arriveMin + 60 < j.arriveMin && p.transfers <= j.transfers));

test('rail dominance preserves equal-time order, strict sixty-minute boundary and transfer preference', () => {
  const direct = { id: 'direct', departMin: 600, arriveMin: 900, transfers: 0 };
  const tied = { ...direct, id: 'tied' };
  const atBoundary = { id: 'sixty', departMin: 600, arriveMin: 960, transfers: 1 };
  const beaten = { id: 'sixty-one', departMin: 600, arriveMin: 961, transfers: 1 };
  const later = { id: 'later-departure', departMin: 601, arriveMin: 1000, transfers: 0 };
  const moreChanges = { id: 'more-changes', departMin: 601, arriveMin: 850, transfers: 1 };
  const input = [atBoundary, beaten, tied, later, direct, moreChanges];
  const copy = [...input];
  assert.deepEqual(pruneDominatedJourneys(input), pairwise(input));
  assert.deepEqual(pruneDominatedJourneys([atBoundary, direct, tied]), [atBoundary, direct, tied]);
  assert.deepEqual(pruneDominatedJourneys([later, moreChanges]), [later, moreChanges]);
  assert.deepEqual(input, copy);
});

test('rail dominance matches the pairwise specification across generated timetables', () => {
  let state = 246813579;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (let scenario = 0; scenario < 80; scenario++) {
    const count = scenario < 3 ? scenario : 20 + random() % 400;
    const trips = Array.from({ length: count }, (_, id) => {
      const departMin = (random() % 72) * 20;
      return { id, departMin, arriveMin: departMin + 30 + (random() % 60) * 10, transfers: random() % 2 };
    });
    assert.deepEqual(pruneDominatedJourneys(trips), pairwise(trips), `scenario ${scenario}`);
  }
});

function zipFixture(tables, { declaredSize, localName, duplicate, corruptCrc = false } = {}) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [name, text] of Object.entries(tables)) {
    const bytes = Buffer.from(text), compressed = deflateRawSync(bytes), filename = Buffer.from(name);
    const localFilename = Buffer.from(localName ?? name);
    const crc = (crc32(bytes) + (corruptCrc ? 1 : 0)) >>> 0, size = declaredSize ?? bytes.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(localFilename.length, 26);
    locals.push(local, localFilename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    if (duplicate) directory.push(central, filename);
    offset += local.length + localFilename.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22), count = Object.keys(tables).length * (duplicate ? 2 : 1);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function fixtureTables() {
  return {
    'agency.txt': 'agency_id,agency_name,agency_timezone\nA,Example Rail,Europe/Berlin\n',
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,50,10\nB,Bravo,51,10\nC,Charlie,52,10\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_type\nR,A,ICE,2\n',
    'trips.txt': 'route_id,service_id,trip_id\nR,W,slow\nR,W,fast\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nslow,10:00:00,10:00:00,A,1,0,0\nslow,11:00:00,11:00:00,B,2,0,0\nslow,15:00:00,15:00:00,C,3,0,0\nfast,11:10:00,11:10:00,B,1,0,0\nfast,12:00:00,12:00:00,C,2,0,0\n',
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nW,1,1,1,1,1,1,1,20260905,20261005\n',
    'calendar_dates.txt': 'service_id,date,exception_type\nW,20260909,2\n',
  };
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'edge-ingest-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'data/sources'), { recursive: true });
  writeFileSync(join(dir, 'data/sources/registry.json'), JSON.stringify({ feeds: [{ id: 'de-longdistance', publisher: 'Fixture publisher', licence: 'CC-BY-4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Fixture attribution' }] }));
  return dir;
}
const ingestFixture = (dir, tables, options = {}) => ingestEdge({ workspaceDir: dir, force: true, log() {}, fetcher: async () => new Response(zipFixture(tables), { headers: { 'last-modified': 'Sat, 05 Sep 2026 00:00:00 GMT' } }), ...options });
const readNetwork = (dir) => JSON.parse(readFileSync(join(dir, 'src/data/edge-network.json'), 'utf8'));
const query = { from: { lat: 50, lon: 10 }, to: { lat: 52, lon: 10 }, date: '2026-09-10', departHour: 8 };

test('CSV records retain quoted commas, escaped quotes, multiline text and BOM/CRLF', () => {
  const out = [];
  visitCsv('\uFEFFid,name\r\n1,"Name, with ""quotes""\nsecond line"\r\n2,Plain', 'fixture.txt', ['id', 'name'], (r) => out.push(r));
  assert.deepEqual(out, [{ id: '1', name: 'Name, with "quotes"\nsecond line' }, { id: '2', name: 'Plain' }]);
  for (const text of ['id,id\n1,2', 'name\ntext', 'id,name\n1', 'id,name\n1,un"quoted', 'id,name\n1,"open', 'id,name\n1,"closed"junk']) {
    assert.throws(() => visitCsv(text, 'bad.txt', ['id', 'name'], () => {}), /bad.txt, record/);
  }
});

test('ZIP parser rejects traversal, duplicated files, corrupt CRC, local mismatch and decompression bombs', () => {
  const tables = fixtureTables();
  assert.equal(readGtfsArchive(zipFixture(tables)).get('trips.txt'), tables['trips.txt']);
  for (const bad of [
    zipFixture({ '../agency.txt': 'bad' }), zipFixture(tables, { duplicate: true }), zipFixture(tables, { corruptCrc: true }),
    zipFixture(tables, { localName: 'other.txt' }), zipFixture(tables, { declaredSize: 33 * 1024 * 1024 }),
    zipFixture({ 'agency.txt': 'x'.repeat(100_000) }, { declaredSize: 10 }),
    zipFixture(tables).subarray(0, 10),
  ]) assert.throws(() => readGtfsArchive(bad));
  const missing = { ...tables }; delete missing['calendar.txt']; delete missing['calendar_dates.txt'];
  assert.throws(() => readGtfsArchive(zipFixture(missing)), /missing calendar/);
});

test('ingest preserves calendar removals and bit 30; router finds faster transfer despite a direct train', async (t) => {
  const dir = workspace(t), report = await ingestFixture(dir, fixtureTables()), network = readNetwork(dir);
  assert.equal(report.calendarDays, 31);
  assert.equal(report.calls, 5);
  assert.equal(network.services[0].d[0] & (1 << 4), 0);
  assert.equal(network.services[0].d[1] & 1, 1);
  const search = createEdgeRailSearch(network), result = search(query);
  assert.equal(result.journeys.length, 2);
  const direct = result.journeys.find((j) => j.transfers === 0), change = result.journeys.find((j) => j.transfers === 1);
  assert.deepEqual(change.legs.map((l) => [l.serviceId, l.departMin, l.arriveMin]), [['slow', 600, 660], ['fast', 670, 720]]);
  assert.equal(direct.arriveMin, 900);
  assert.equal(change.durationMin, 120);
  assert.ok(change.legs.every((l) => l.service === 'ICE' && l.price === null));
  assert.equal(search({ ...query, date: '2026-09-09' }).journeys.length, 0);
  assert.ok(search({ ...query, date: 20261005 }).journeys.length);
  assert.equal(search({ ...query, date: '2026-10-06' }).error, 'date_out_of_coverage');
  for (const date of ['2026-0-910', '20-26-09-10', '20260910', '2026-02-30']) assert.equal(search({ ...query, date }).error, 'invalid_date');
  assert.equal(search(null).error, 'invalid_coordinates');
  assert.equal(edgeRailSearch([]).error, 'invalid_coordinates');
});

test('boarding/alighting restrictions and minimum interchange prevent impossible connections', async (t) => {
  const dir = workspace(t);
  for (const [before, after] of [
    ['slow,11:00:00,11:00:00,B,2,0,0', 'slow,11:00:00,11:00:00,B,2,0,1'],
    ['fast,11:10:00,11:10:00,B,1,0,0', 'fast,11:10:00,11:10:00,B,1,2,0'],
    ['fast,11:10:00,11:10:00,B,1,0,0', 'fast,11:07:00,11:07:00,B,1,0,0'],
  ]) {
    const tables = fixtureTables(); tables['stop_times.txt'] = tables['stop_times.txt'].replace(before, after);
    await ingestFixture(dir, tables);
    assert.equal(createEdgeRailSearch(readNetwork(dir))(query).journeys.some((j) => j.transfers === 1), false);
  }
});

test('failed refresh leaves last good output AND cache byte-for-byte intact', async (t) => {
  const dir = workspace(t); await ingestFixture(dir, fixtureTables());
  const files = ['src/data/edge-network.json', 'data/cache/edge-fv-free.zip', 'data/cache/edge-fv-free-meta.json'];
  const previous = files.map((name) => readFileSync(join(dir, name)));
  const cases = [
    ['calendar.txt', 'W,1,1,1,1,1,1,1', 'W,1,1,x,1,1,1,1', /weekly calendar/],
    ['calendar_dates.txt', ',2\n', ',7\n', /calendar exception/],
    ['stop_times.txt', ',A,1,0,0', ',A,NaN,0,0', /sequence/],
    ['stop_times.txt', ',A,1,0,0', ',A,1,4,0', /pickup_type/],
    ['trips.txt', 'R,W,fast', 'R,UNKNOWN,fast', /unknown service calendar/],
    ['agency.txt', 'Europe/Berlin', 'Europe/Paris', /Unsupported timetable clocks/],
  ];
  for (const [table, before, after, error] of cases) {
    const tables = fixtureTables(); tables[table] = tables[table].replace(before, after);
    await assert.rejects(ingestFixture(dir, tables), error);
    files.forEach((name, i) => assert.deepEqual(readFileSync(join(dir, name)), previous[i]));
  }
  await assert.rejects(ingestFixture(dir, fixtureTables(), { fetcher: async () => new Response('unavailable', { status: 503 }) }), /HTTP 503/);
  files.forEach((name, i) => assert.deepEqual(readFileSync(join(dir, name)), previous[i]));
});

test('exception-only calendar, feed bounds and absent optional tables use only the new archive', async (t) => {
  const dir = workspace(t); await ingestFixture(dir, fixtureTables());
  const tables = fixtureTables(); delete tables['calendar.txt'];
  tables['calendar_dates.txt'] = 'service_id,date,exception_type\nW,20260909,1\nW,20260910,1\n';
  tables['feed_info.txt'] = 'feed_start_date,feed_end_date\n20260910,20260910\n';
  await ingestFixture(dir, tables);
  const network = readNetwork(dir);
  assert.equal(network.calendarEpoch, 20260910); assert.equal(network.calendarDays, 1);
  assert.deepEqual(network.services[0].d, [1, 0]);
  assert.ok(createEdgeRailSearch(network)(query).journeys.length);
  for (const file of ['transfers.txt', 'frequencies.txt']) {
    await assert.rejects(ingestFixture(dir, { ...tables, [file]: 'rule\nconstraint\n' }), /Unsupported GTFS rules/);
  }
});

test('walking interchanges include high-latitude neighbours and round walking time upwards', async (t) => {
  const dir = workspace(t), tables = fixtureTables();
  tables['stops.txt'] = 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,60,-1\nB,Bravo,60,0.0049\nD,Delta,60,0.0151\nC,Charlie,60,1\n';
  tables['stop_times.txt'] = tables['stop_times.txt'].replace('fast,11:10:00,11:10:00,B', 'fast,11:20:00,11:20:00,D');
  await ingestFixture(dir, tables);
  const network = readNetwork(dir), b = network.stops.findIndex((s) => s.n === 'Bravo'), d = network.stops.findIndex((s) => s.n === 'Delta');
  const offset = network.edge.footOffset[b], end = network.edge.footOffset[b + 1];
  assert.deepEqual(network.edge.footTo.slice(offset, end), [d]);
  assert.deepEqual(network.edge.footMin.slice(offset, end), [8]);
  const result = createEdgeRailSearch(network)({ ...query, from: { lat: 60, lon: -1 }, to: { lat: 60, lon: 1 } });
  assert.deepEqual(result.journeys.find((j) => j.transfers === 1).legs.map((l) => l.mode), ['rail', 'walk', 'rail']);
});
