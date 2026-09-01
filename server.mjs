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
// listen(PORT) with no host binds EVERY interface, including IPv6 — while the
// startup log claimed 127.0.0.1. That false line is exactly what makes an
// operator skip a firewall rule. Default to loopback and require an explicit
// HOST=0.0.0.0 once a reverse proxy actually fronts this.
const HOST = process.env.HOST || '127.0.0.1';
const DIST = 'dist';

// A search payload is about 120 bytes. Without a cap, `for await (…) chunks.push`
// accumulates without bound and `Buffer.concat().toString()` then makes a second
// full copy: one 200MB POST added 618MB of RSS to a process already holding the
// network, and did not give it back.
const MAX_BODY = 64 * 1024;

// A cold search is ~400ms of CPU in a single-threaded process, so requests
// queue behind each other: eight concurrent searches took 3.6s for the last
// one, and an unrelated favicon went from 3.5ms to 3.2s. One person on a home
// connection can make the site unusable for everyone without trying.
const RATE = { windowMs: 60_000, max: 20 };
const MAX_INFLIGHT = 4;
const hits = new Map();          // ip -> { n, resetAt }
let inFlight = 0;

function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.resetAt) {
    if (hits.size > 10_000) hits.clear();   // same wholesale clear as `cache`
    hits.set(ip, { n: 1, resetAt: now + RATE.windowMs });
    return false;
  }
  return ++h.n > RATE.max;
}

// A crash-only server with no supervisor is one bad request from an outage,
// and two such requests were found: a malformed Host header, and
// `GET /api/places?q=constructor`. Both threw inside an async handler, which
// Node treats as a fatal unhandled rejection. Both are fixed at the source
// below; these are the net under them.
process.on('uncaughtException', (e) => console.error('[server] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[server] unhandled', e));

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
  // `= 8` only fires on undefined, so an explicit null fell through to
  // Number(null) === 0 and silently searched from midnight. `??` covers both.
  const { from, to } = body ?? {};
  const departHour = body?.departHour ?? 8;
  const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
  if (!ok(from) || !ok(to)) {
    return json(res, 400, { error: 'from and to must each be {lat, lon}.' });
  }
  // departHour had no validation at all, which did two kinds of damage.
  //
  // Silently: "abc" became NaN, 1e308 became Infinity and null became 0 (the
  // default only fires on undefined), each returning HTTP 200 with plausible
  // but wrong output — worse than an error, because a client cannot tell.
  //
  // Deliberately: the raw value went into the cache key, so 8.001, 8.002, …
  // minted unlimited distinct keys that every missed the cache and each cost a
  // full ~400ms search. Flooring to a real hour collapses that to 24 keys.
  const hour = Math.floor(Number(departHour));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return json(res, 400, { error: 'departHour must be an integer from 0 to 23.' });
  }

  const t0 = Date.now();
  // A city's main stations can sit further apart than a tight radius allows:
  // Paris Gare de Lyon is 4,248m from Gare du Nord, so a 4km sweep excluded it
  // by 248 metres and Paris-Marseille lost every TGV. 8km covers a large city's
  // termini; accessStops then ranks by long-distance service and spreads its
  // picks across DIFFERENT stations, which is what keeps suburban halts out.
  // 16 rather than 8: a major station appears once per FEED with a different
  // spelling — Marseille Saint-Charles has three records — so a tight cap can
  // drop the very record a service calls at. Extra origin stops cost one
  // pattern-scan each, which the search absorbs.
  const origins = accessStops(index, from.lat, from.lon, 8000, 16);
  const dests = accessStops(index, to.lat, to.lon, 8000, 16);

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
  const key = `${origins[0].idx}:${dests[0].idx}:${hour}`;
  let journeys = cache.get(key);
  if (!journeys) {
    journeys = searchWindow(index, origins, dests, hour * 60, {
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

const server = createServer(async (req, res) => {
  // `new URL` throws for an empty, spaced or bracketed Host header, and the
  // throw inside this async handler killed the process. Verified fatal with
  // Host: "", " ", "a b", "[".
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return json(res, 400, { error: 'Bad request.' }); }

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
    const ip = req.socket.remoteAddress ?? '?';
    // Behind a reverse proxy this must become the rightmost trusted
    // X-Forwarded-For entry. Until one exists, the header is client-controlled
    // and trusting it would hand every attacker a fresh identity per request.
    if (rateLimited(ip)) {
      return json(res, 429, { error: 'Too many searches. Try again shortly.' });
    }
    if (inFlight >= MAX_INFLIGHT) {
      return json(res, 503, { error: 'Busy. Try again shortly.' });
    }

    // Count while streaming. A Content-Length check alone is not enough —
    // chunked encoding omits it, and the body arrives anyway.
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) {
        json(res, 413, { error: 'Body too large.' });
        req.destroy();
        return;
      }
      chunks.push(c);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return json(res, 400, { error: 'Body must be JSON.' }); }

    inFlight++;
    try { return await handleSearch(body, res); }
    finally { inFlight--; }
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
});

// A malformed request line or header should close that socket, not travel
// further into the process.
server.on('clientError', (err, socket) => {
  if (!socket.destroyed) socket.destroy();
});
// So a trickled body cannot hold a connection open indefinitely.
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

server.listen(PORT, HOST, () => {
  console.log(`\nReady on http://${HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log('  Listening on ALL interfaces — put a reverse proxy in front.');
  }
});
