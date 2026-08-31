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
import { buildPlaceIndex, searchPlaces } from './src/lib/places.js';

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

const placeIndex = buildPlaceIndex(network, index);
console.log(`  ${placeIndex.length.toLocaleString()} searchable places`);

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
  json(res, 200, { places: searchPlaces(placeIndex, url.searchParams.get('q')) });
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
