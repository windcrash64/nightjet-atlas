/**
 * Turning what a traveller types into a place the router can search from.
 *
 * This is deceptively fiddly, and every rule below exists because a plausible
 * simpler version shipped a real bug:
 *
 *  - Grouping every station of a city into one entry hid Paris Gare de Lyon,
 *    where trains from Spain actually arrive.
 *  - Naming a city after its best-served station produced "Berlin Südkreuz"
 *    and "Madrid-Puerta de Atocha-Almudena Grandes".
 *  - Averaging the coordinates of everything called "Frankfurt*" put the city
 *    60km from its own Hauptbahnhof, because Frankfurt (Oder) is 500km east.
 *  - Matching substrings ranked "Überlingen" above "Berlin".
 *  - Searching in English returned nothing, because the feeds say Wien.
 */

/** Service classes that mark a station as somewhere long-distance trains stop. */
const LONG_DISTANCE = new Set([
  'ICE', 'ICN', 'IC', 'EC', 'ECE', 'EN', 'NJ', 'RJ', 'RJX',
  'TGV', 'THA', 'FR', 'AVE', 'AVLO', 'ALVIA', 'AVANT', 'IR', 'EST', 'FLX',
]);

/**
 * Words that name a STATION rather than a place. A city's own name stops here.
 */
const STATION_QUALIFIER = new RegExp(
  '^(hbf|hauptbahnhof|bahnhof|bf|hb|gare|gara|estacion|estación|stazione|'
  + 'centraal|central|centrale|nord|sud|süd|sued|est|ost|west|ouest|norte|sur|'
  + 'este|oeste|südkreuz|suedkreuz|ostbahnhof|westbahnhof|puerta|hall|term|'
  + 'terminal|flughafen|aeropuerto|aeroport|airport|cercanias|cercanías)$',
  'i',
);

/** Second words that genuinely belong to a city name (Frankfurt am Main). */
const COMPOUND_CITY_WORD =
  /^(am|an|auf|der|den|des|del|de|la|le|les|sur|upon|main|oder|rhein|ruhr|saale|elbe|havel|neckar|donau|isar|lech|inn|haag|bosch)$/i;

/**
 * English and other common exonyms for cities the feeds label locally. Without
 * these, searching "Vienna" returns nothing, which reads as missing coverage
 * rather than as a naming mismatch.
 */
export const CITY_ALIASES = {
  vienna: 'wien', munich: 'münchen', muenchen: 'münchen',
  cologne: 'köln', koeln: 'köln', nuremberg: 'nürnberg', nuernberg: 'nürnberg',
  hanover: 'hannover', brunswick: 'braunschweig',
  prague: 'praha', warsaw: 'warszawa', florence: 'firenze', venice: 'venezia',
  milan: 'milano', rome: 'roma', naples: 'napoli', turin: 'torino',
  geneva: 'genève', zurich: 'zürich', basle: 'basel', lucerne: 'luzern',
  seville: 'sevilla', saragossa: 'zaragoza', corunna: 'coruña',
  lisbon: 'lisboa', copenhagen: 'københavn', gothenburg: 'göteborg',
  brussels: 'bruxelles', antwerp: 'antwerpen', ghent: 'gent',
  'the hague': 'den haag', thehague: 'den haag',
};

/** The city part of a station name. */
export function cityNameFrom(stationName) {
  const head = String(stationName).split(/[,(]/)[0].trim();
  const tokens = head.split(/[\s\-–]+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (out.length && STATION_QUALIFIER.test(t)) break;
    out.push(t);
  }
  // A blunt two-word cap turned "Lyon Part Dieu" into "Lyon Part". Keep a
  // second word only when it belongs to a compound place name.
  if (out.length > 1 && !COMPOUND_CITY_WORD.test(out[1])) return out[0];
  return out.slice(0, 2).join(' ') || head;
}

/** How much long-distance service a stop sees. */
export function serviceScore(network, index, stopIdx) {
  let n = 0;
  for (const [svcIdx] of index.byStop.get(stopIdx) ?? []) {
    const svc = network.services[svcIdx];
    const cls = (svc.s || '').trim().toUpperCase().split(/[\s\d]/)[0];
    if (svc.m === 'night_rail' || LONG_DISTANCE.has(cls)) n++;
  }
  return n;
}

/**
 * Builds the searchable place list: one entry per city, plus named entries for
 * stations that genuinely see long-distance service.
 */
export function buildPlaceIndex(network, index, { minStationScore = 3 } = {}) {
  const cities = new Map();
  const stations = new Map();

  for (let i = 0; i < network.stops.length; i++) {
    const s = network.stops[i];
    const clean = s.n
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/\b(hbf|hauptbahnhof|bahnhof|bf|hb|centraal|central|station|gl\.?\s*\d.*)\b/g, ' ')
      .replace(/[^a-zà-ÿ0-9]+/g, ' ')
      .trim();
    if (!clean) continue;
    const cityKey = clean.split(' ')[0];
    if (cityKey.length < 2) continue;

    const score = serviceScore(network, index, i);

    let c = cities.get(cityKey);
    if (!c) {
      c = { kind: 'city', key: cityKey, name: null, count: 0, lat: 0, lon: 0, score: 0, bestScore: -1 };
      cities.set(cityKey, c);
    }
    c.count++;
    c.score += score;
    // Anchor the city to its best-served station. Averaging coordinates across
    // same-named places puts a city in the wrong country.
    if (score > c.bestScore) {
      c.bestScore = score;
      c.name = cityNameFrom(s.n);
      c.lat = s.y;
      c.lon = s.x;
    }

    if (score >= minStationScore) {
      const key = s.n.toLowerCase();
      const st = stations.get(key);
      if (!st || score > st.score) {
        stations.set(key, { kind: 'station', key, name: s.n, lat: s.y, lon: s.x, count: 1, score });
      }
    }
  }

  // A station whose name IS the city name is not a second thing to choose —
  // "Genève" appeared twice, once as the city and once as a station.
  for (const c of cities.values()) {
    stations.delete(c.name.toLowerCase());
  }

  return [...cities.values(), ...stations.values()];
}

/** Ranked matches for a typed query. */
export function searchPlaces(placeIndex, rawQuery, limit = 8) {
  const raw = String(rawQuery ?? '').trim().toLowerCase();
  if (raw.length < 2) return [];
  const q = CITY_ALIASES[raw] ?? raw;

  const scored = [];
  for (const p of placeIndex) {
    const name = p.name.toLowerCase();
    let score;
    if (p.key === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (p.key.startsWith(q)) score = 2;
    else if (name.includes(` ${q}`)) score = 3;
    else continue;                    // no prefix match: not a hit at all
    // A city outranks any one of its own stations at equal match quality.
    if (p.kind === 'city') score -= 0.5;
    scored.push({ p, score });
  }

  scored.sort((a, b) => a.score - b.score || b.p.score - a.p.score);
  return scored.slice(0, limit).map(({ p }) => ({
    name: p.name,
    lat: +p.lat.toFixed(4),
    lon: +p.lon.toFixed(4),
    stops: p.count,
    kind: p.kind,
  }));
}
