/**
 * Journey search API.
 *
 * The network (17k stops, 113k services) is loaded once and held in memory —
 * roughly 35MB of JSON, well inside a small VPS. Requests are pure computation
 * against it: no upstream API, no per-query cost, no rate limit to respect.
 * That is the whole point of owning the data rather than proxying someone else's.
 *
 * Run: node server.mjs   (PORT env var, default 8080)
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { buildIndex, stopsNear, accessStops, searchWindow } from './src/lib/router.js';

const PORT = Number(process.env.PORT || 8080);
const DIST = 'dist';

console.log('Loading network…');
const network = JSON.parse(readFileSync('src/data/network.json', 'utf8'));
const index = buildIndex(network);
console.log(`  ${network.stops.length.toLocaleString()} stops, ${network.services.length.toLocaleString()} services`);

// Places people can search for. Stop names in GTFS are station names
// ("Berlin Hbf"), not city names, so we resolve a typed query to coordinates
// by matching stop names and returning the busiest cluster.
// Repeat searches for the same pair are common (changing the hour, going back
// and forth). The network never changes at runtime, so results are stable.
const cache = new Map();

const placeIndex = buildPlaceIndex(network);
console.log(`  ${placeIndex.length.toLocaleString()} searchable places`);

function buildPlaceIndex(net) {
  // Group stops by a normalised name root so "Berlin Hbf", "Berlin Ostbahnhof"
  // and "Berlin Südkreuz" all answer to "berlin".
  const groups = new Map();
  for (let i = 0; i < net.stops.length; i++) {
    const s = net.stops[i];
    const root = s.n
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/\b(hbf|hauptbahnhof|bahnhof|bf|hb|centraal|central|station|st|gl\.?\s*\d.*)\b/g, ' ')
      .replace(/[^a-zà-ÿ0-9]+/g, ' ')
      .trim();
    if (!root) continue;
    const key = root.split(' ')[0];
    if (key.length < 2) continue;
    let g = groups.get(key);
    if (!g) { g = { key, name: s.n, count: 0, lat: 0, lon: 0 }; groups.set(key, g); }
    g.count++;
    g.lat += s.y;
    g.lon += s.x;
    // Prefer a main-station name as the display label.
    if (/hbf|hauptbahnhof|centraal|central/i.test(s.n) && !/hbf|central/i.test(g.name)) g.name = s.n;
  }
  return [...groups.values()]
    .map((g) => ({ key: g.key, name: g.name, count: g.count, lat: g.lat / g.count, lon: g.lon / g.count }))
    .filter((g) => g.count >= 1)
    .sort((a, b) => b.count - a.count);
}

function json(res, status, body, headers = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(s);
}

function handlePlaces(url, res) {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return json(res, 200, { places: [] });
  // Rank by how well the query matches the START of the place name, then by
  // how many stops the place has. A plain substring match puts "Überlingen"
  // and "Oberlinxweiler" above "Berlin", which is nonsense to a traveller.
  const scored = [];
  for (const p of placeIndex) {
    const name = p.name.toLowerCase();
    let score;
    if (p.key === q) score = 0;
    else if (p.key.startsWith(q)) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (name.includes(` ${q}`)) score = 3;
    else continue;               // no prefix match anywhere: not a hit
    scored.push({ p, score });
  }
  scored.sort((a, b) => a.score - b.score || b.p.count - a.p.count);
  const hits = scored.slice(0, 8).map(({ p }) => ({
    name: p.name, lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4), stops: p.count,
  }));
  json(res, 200, { places: hits });
}

function handleSearch(body, res) {
  const { from, to, departHour = 8 } = body ?? {};
  const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
  if (!ok(from) || !ok(to)) {
    return json(res, 400, { error: 'from and to must each be {lat, lon}.' });
  }

  const t0 = Date.now();
  // A 25km sweep pulls in suburban halts that beat the main station by a few
  // hundred metres, so every journey gained a pointless local hop before the
  // real train. 4km covers a city's own stations without reaching its
  // commuter belt, and treating access distance as zero within that radius
  // stops a 300m walk from deciding which station "wins".
  const origins = accessStops(index, from.lat, from.lon, 4000, 8);
  const dests = accessStops(index, to.lat, to.lon, 4000, 8);

  if (!origins.length || !dests.length) {
    return json(res, 200, {
      journeys: [],
      coverage: !origins.length
        ? 'No station in our data is near that origin.'
        : 'No station in our data is near that destination.',
      sources: network.sources,
      generatedAt: network.generatedAt,
      tookMs: Date.now() - t0,
    });
  }

  // 3 rounds finds direct, one-change and two-change journeys, which covers
  // essentially every intercity trip; the 4th round tripled the search time to
  // surface options nobody picks.
  const key = `${origins[0].idx}:${dests[0].idx}:${departHour}`;
  let journeys = cache.get(key);
  if (!journeys) {
    journeys = searchWindow(index, origins, dests, Number(departHour) * 60, {
      windowMin: 12 * 60, stepMin: 180, maxRounds: 3, maxJourneys: 8,
    });
    if (cache.size > 500) cache.clear();
    cache.set(key, journeys);
  }

  json(res, 200, {
    journeys,
    sources: network.sources,
    // EU Delegated Regulation 2017/1926 Art. 8(3) requires the source and the
    // last-update time of static data to be shown wherever it is reused.
    generatedAt: network.generatedAt,
    tookMs: Date.now() - t0,
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (url.pathname === '/api/places' && req.method === 'GET') return handlePlaces(url, res);

  if (url.pathname === '/api/search' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return json(res, 400, { error: 'Body must be JSON.' }); }
    return handleSearch(body, res);
  }

  // Static files.
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(DIST, safe);
  if (existsSync(file) && !file.includes('..')) {
    const buf = readFileSync(file);
    return res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(buf);
  }
  const fallback = join(DIST, 'index.html');
  if (existsSync(fallback)) {
    return res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(readFileSync(fallback));
  }
  res.writeHead(404).end('Not found');
}).listen(PORT, () => {
  console.log(`\nReady on http://127.0.0.1:${PORT}`);
});
