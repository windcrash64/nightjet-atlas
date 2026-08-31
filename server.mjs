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

// Assigned below, once buildPlaceIndex and the constants it closes over have
// been initialised. `const` declarations are not hoisted, so calling it here
// would throw "Cannot access 'STATION_QUALIFIER' before initialization".
let placeIndex = [];

/**
 * The city part of a station name.
 *
 * Station names carry a qualifier the city itself does not: "Berlin Südkreuz",
 * "Madrid-Puerta de Atocha-Almudena Grandes", "Paris Gare de Lyon Hall 1 - 2".
 * Cut at the first token that names a station rather than a place.
 */
const STATION_QUALIFIER = new RegExp(
  '^(hbf|hauptbahnhof|bahnhof|bf|hb|gare|gara|estacion|estación|stazione|'
  + 'centraal|central|centrale|nord|sud|süd|sued|est|ost|west|ouest|norte|sur|'
  + 'este|oeste|südkreuz|suedkreuz|ostbahnhof|westbahnhof|puerta|hall|term|'
  + 'terminal|flughafen|aeropuerto|aeroport|airport|cercanias|cercanías)$',
  'i',
);

function cityNameFrom(stationName) {
  const head = stationName.split(/[,(]/)[0].trim();
  const tokens = head.split(/[\s\-–]+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (out.length && STATION_QUALIFIER.test(t)) break;
    out.push(t);
  }
  // A blunt two-word cap turned "Lyon Part Dieu" into "Lyon Part". Keep the
  // second word only when it looks like part of a compound place name
  // (Frankfurt Main, Den Haag), not the start of a station's own name.
  if (out.length > 1 && !COMPOUND_CITY_WORD.test(out[1])) return out[0];
  return out.slice(0, 2).join(' ') || head;
}

/**
 * Second words that genuinely belong to a city name rather than to a station.
 * Everything else after the first token is treated as a station qualifier.
 */
const COMPOUND_CITY_WORD = /^(am|an|auf|der|den|des|del|de|la|le|les|sur|upon|main|oder|rhein|ruhr|saale|elbe|havel|neckar|donau|isar|lech|inn|haag|bosch)$/i;

/**
 * Places a traveller can search for, at two levels.
 *
 * "Paris" should offer the CITY, so a search leaves from whichever of its
 * stations serves the route — and it should also offer Gare de Lyon and Gare
 * du Nord by name, because a traveller who knows which station they want
 * should be able to say so. An earlier version grouped every Paris station
 * into one entry labelled "Paris Est", which hid Gare de Lyon entirely.
 */
function buildPlaceIndex(net, index) {
  const LONG_DISTANCE = new Set([
    'ICE', 'ICN', 'IC', 'EC', 'ECE', 'EN', 'NJ', 'RJ', 'RJX',
    'TGV', 'THA', 'FR', 'AVE', 'AVLO', 'ALVIA', 'AVANT', 'IR', 'EST', 'FLX',
  ]);
  const serviceScore = (stopIdx) => {
    let n = 0;
    for (const [svcIdx] of index.byStop.get(stopIdx) ?? []) {
      const svc = net.services[svcIdx];
      const cls = (svc.s || '').trim().toUpperCase().split(/[\s\d]/)[0];
      if (svc.m === 'night_rail' || LONG_DISTANCE.has(cls)) n++;
    }
    return n;
  };

  const cities = new Map();
  const stations = new Map();

  for (let i = 0; i < net.stops.length; i++) {
    const s = net.stops[i];
    const clean = s.n
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/\b(hbf|hauptbahnhof|bahnhof|bf|hb|centraal|central|station|gl\.?\s*\d.*)\b/g, ' ')
      .replace(/[^a-zà-ÿ0-9]+/g, ' ')
      .trim();
    if (!clean) continue;
    const cityKey = clean.split(' ')[0];
    if (cityKey.length < 2) continue;

    const score = serviceScore(i);

    // City entry: the centroid of everything sharing the first word.
    let c = cities.get(cityKey);
    if (!c) { c = { kind: 'city', key: cityKey, name: null, count: 0, lat: 0, lon: 0, score: 0 }; cities.set(cityKey, c); }
    c.count++; c.lat += s.y; c.lon += s.x; c.score += score;
    // Take the city's own name from the leading words of the station name,
    // stopping at the first token that is clearly a station qualifier. Using
    // the whole best-served station name instead labelled the city "Berlin
    // Südkreuz" and "Madrid-Puerta de Atocha-Almudena Grandes".
    if (!c.name || score > (c.bestScore ?? -1)) {
      c.bestScore = score;
      c.name = cityNameFrom(s.n);
    }

    // Station entry, but only for stations that actually see long-distance
    // service — otherwise 27,588 stops drown the suggestion list.
    if (score >= 3) {
      const key = s.n.toLowerCase();
      const st = stations.get(key);
      if (!st || score > st.score) {
        stations.set(key, { kind: 'station', key, name: s.n, lat: s.y, lon: s.x, count: 1, score });
      }
    }
  }

  const cityList = [...cities.values()].map((c) => ({
    kind: 'city', key: c.key,
    name: c.name,
    count: c.count, score: c.score,
    lat: c.lat / c.count, lon: c.lon / c.count,
  }));

  return [...cityList, ...stations.values()];
}

placeIndex = buildPlaceIndex(network, index);
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

/**
 * English (and common) names for cities the feeds label locally.
 *
 * A traveller types "Vienna", "Munich" or "Cologne"; the GTFS says "Wien",
 * "München", "Köln". Without this, searching in English silently returns
 * nothing, which reads as missing coverage rather than a naming mismatch.
 */
const CITY_ALIASES = {
  vienna: 'wien', munich: 'münchen', muenchen: 'münchen',
  cologne: 'köln', koeln: 'köln', nuremberg: 'nürnberg', nuernberg: 'nürnberg',
  frankfurt: 'frankfurt', hanover: 'hannover', brunswick: 'braunschweig',
  prague: 'praha', warsaw: 'warszawa', florence: 'firenze', venice: 'venezia',
  milan: 'milano', rome: 'roma', naples: 'napoli', turin: 'torino',
  geneva: 'genève', zurich: 'zürich', basle: 'basel', lucerne: 'luzern',
  seville: 'sevilla', saragossa: 'zaragoza', corunna: 'coruña',
  lisbon: 'lisboa', copenhagen: 'københavn', gothenburg: 'göteborg',
  brussels: 'bruxelles', antwerp: 'antwerpen', ghent: 'gent',
  thehague: 'den haag', 'the hague': 'den haag',
};

function handlePlaces(url, res) {
  const raw = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (raw.length < 2) return json(res, 200, { places: [] });
  const q = CITY_ALIASES[raw] ?? raw;
  // Rank by how well the query matches the START of the place name, then by
  // how many stops the place has. A plain substring match puts "Überlingen"
  // and "Oberlinxweiler" above "Berlin", which is nonsense to a traveller.
  const scored = [];
  for (const p of placeIndex) {
    const name = p.name.toLowerCase();
    let score;
    if (p.key === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (p.key.startsWith(q)) score = 2;
    else if (name.includes(` ${q}`)) score = 3;
    else continue;               // no prefix match anywhere: not a hit
    // A city outranks any single one of its stations at the same match quality:
    // "Paris" should offer Paris before Paris Est.
    if (p.kind === 'city') score -= 0.5;
    scored.push({ p, score });
  }
  scored.sort((a, b) => a.score - b.score || b.p.score - a.p.score);
  const hits = scored.slice(0, 8).map(({ p }) => ({
    name: p.name, lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4),
    stops: p.count, kind: p.kind,
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
