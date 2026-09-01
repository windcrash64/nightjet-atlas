/**
 * Builds the city list the globe shows.
 *
 * The globe needs cities a traveller would name — Berlin, Paris, Tokyo — not
 * the stops the feeds happen to contain. Two attempts at deriving that list
 * from the data failed for the same reason, and the failures are the argument
 * for this file existing:
 *
 *   Ranked by service count, the top 25 places in the network are ALL Swiss
 *   (Zürich, Basel, Olten, Sargans, Biberbrugg) because the Swiss feed is
 *   dense with regional trains. Berlin and Paris did not appear.
 *
 *   Ranked by distinct long-distance services per STOP, "Zürich HB" occupied
 *   twelve of the top twenty rows, because each feed carries its own record
 *   for the same station.
 *
 * So the city list is curated — real places with real coordinates — and only
 * the SCORE comes from the data: how many distinct long-distance services can
 * be reached from within 8km of that point, using the same accessStops the
 * router uses, so the number means the same thing the search does.
 *
 * Cities deliberately outside coverage are included and scored 0. A globe that
 * only draws where we work is a globe that lies about being a world product;
 * showing Tokyo as present-but-unserved is the honest version, and it makes
 * "Europe now, the world later" a visible fact rather than a promise.
 *
 * Run: node scripts/build-cities.mjs   (writes src/data/cities.json)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { buildIndex, accessStops, isLongDistance } from '../src/lib/router.js';

/**
 * [name, lat, lon, country] — the places a person types.
 *
 * Coordinates are the CITY, not its main station: accessStops sweeps 8km, so
 * a city centre finds every terminus, while a station coordinate biases the
 * score toward whichever terminus was picked. Paris is the case that proves
 * it — Gare de Lyon is 4,248m from Gare du Nord.
 */
const CITIES = [
  // Germany
  ['Berlin', 52.5251, 13.3694, 'DE'], ['München', 48.1403, 11.5583, 'DE'],
  ['Hamburg', 53.5528, 10.0067, 'DE'], ['Köln', 50.9430, 6.9589, 'DE'],
  ['Frankfurt', 50.1067, 8.6628, 'DE'], ['Stuttgart', 48.7838, 9.1817, 'DE'],
  ['Düsseldorf', 51.2200, 6.7942, 'DE'], ['Leipzig', 51.3455, 12.3811, 'DE'],
  ['Hannover', 52.3767, 9.7411, 'DE'], ['Nürnberg', 49.4456, 11.0823, 'DE'],
  ['Dresden', 51.0400, 13.7322, 'DE'], ['Bremen', 53.0834, 8.8134, 'DE'],
  ['Essen', 51.4514, 7.0146, 'DE'], ['Karlsruhe', 48.9937, 8.4017, 'DE'],
  ['Freiburg', 47.9974, 7.8416, 'DE'], ['Mannheim', 49.4794, 8.4692, 'DE'],
  // France
  ['Paris', 48.8809, 2.3549, 'FR'], ['Lyon', 45.7602, 4.8596, 'FR'],
  ['Marseille', 43.3025, 5.3803, 'FR'], ['Bordeaux', 44.8259, -0.5560, 'FR'],
  ['Lille', 50.6379, 3.0714, 'FR'], ['Toulouse', 43.6111, 1.4536, 'FR'],
  ['Nice', 43.7047, 7.2618, 'FR'], ['Strasbourg', 48.5850, 7.7343, 'FR'],
  ['Nantes', 47.2172, -1.5423, 'FR'], ['Montpellier', 43.6045, 3.8800, 'FR'],
  ['Rennes', 48.1035, -1.6725, 'FR'], ['Avignon', 43.9214, 4.7861, 'FR'],
  // Spain
  ['Madrid', 40.4064, -3.6909, 'ES'], ['Barcelona', 41.3790, 2.1400, 'ES'],
  ['Sevilla', 37.3919, -5.9756, 'ES'], ['Valencia', 39.4667, -0.3772, 'ES'],
  ['Málaga', 36.7118, -4.4310, 'ES'], ['Zaragoza', 41.6590, -0.9110, 'ES'],
  ['Bilbao', 43.2603, -2.9350, 'ES'], ['Córdoba', 37.8891, -4.7900, 'ES'],
  ['Alicante', 38.3446, -0.4907, 'ES'], ['Granada', 37.1846, -3.6089, 'ES'],
  // Switzerland
  ['Zürich', 47.3779, 8.5403, 'CH'], ['Genève', 46.2103, 6.1424, 'CH'],
  ['Bern', 46.9490, 7.4390, 'CH'], ['Basel', 47.5476, 7.5896, 'CH'],
  ['Lausanne', 46.5169, 6.6291, 'CH'], ['Luzern', 47.0503, 8.3103, 'CH'],
  ['Lugano', 46.0050, 8.9470, 'CH'], ['Interlaken', 46.6863, 7.8632, 'CH'],
  ['St. Gallen', 47.4231, 9.3697, 'CH'], ['Winterthur', 47.5001, 8.7238, 'CH'],
  // Netherlands
  ['Amsterdam', 52.3791, 4.9003, 'NL'], ['Rotterdam', 51.9250, 4.4699, 'NL'],
  ['Utrecht', 52.0894, 5.1100, 'NL'], ['Den Haag', 52.0806, 4.3247, 'NL'],
  ['Eindhoven', 51.4433, 5.4797, 'NL'], ['Groningen', 53.2109, 6.5645, 'NL'],
  ['Maastricht', 50.8503, 5.7050, 'NL'], ['Arnhem', 51.9851, 5.8987, 'NL'],
  // Reached by cross-border services rather than by a feed of their own
  ['Wien', 48.1856, 16.3367, 'AT'], ['Salzburg', 47.8130, 13.0455, 'AT'],
  ['Innsbruck', 47.2632, 11.4010, 'AT'], ['Graz', 47.0725, 15.4165, 'AT'],
  ['Praha', 50.0830, 14.4356, 'CZ'], ['Brno', 49.1908, 16.6122, 'CZ'],
  ['Warszawa', 52.2288, 21.0030, 'PL'], ['Kraków', 50.0677, 19.9450, 'PL'],
  ['Poznań', 52.4014, 16.9113, 'PL'], ['Wrocław', 51.0989, 17.0366, 'PL'],
  ['Budapest', 47.5000, 19.0833, 'HU'], ['Bratislava', 48.1587, 17.1067, 'SK'],
  ['Milano', 45.4863, 9.2043, 'IT'], ['Roma', 41.9010, 12.5010, 'IT'],
  ['Venezia', 45.4413, 12.3216, 'IT'], ['Firenze', 43.8010, 11.2000, 'IT'],
  ['Torino', 45.0625, 7.6784, 'IT'], ['Napoli', 40.8523, 14.2681, 'IT'],
  ['Bologna', 44.5058, 11.3430, 'IT'], ['Verona', 45.4287, 10.9822, 'IT'],
  ['Bruxelles', 50.8358, 4.3353, 'BE'], ['Antwerpen', 51.2172, 4.4210, 'BE'],
  ['London', 51.5308, -0.1238, 'GB'], ['København', 55.6727, 12.5642, 'DK'],
  ['Zagreb', 45.8043, 15.9776, 'HR'], ['Ljubljana', 46.0576, 14.5062, 'SI'],
  ['Luxembourg', 49.5999, 6.1342, 'LU'],
  // Europe beyond current reach — drawn, unserved, honest
  ['Lisboa', 38.7139, -9.1229, 'PT'], ['Porto', 41.1489, -8.6099, 'PT'],
  ['Stockholm', 59.3300, 18.0586, 'SE'], ['Göteborg', 57.7089, 11.9746, 'SE'],
  ['Oslo', 59.9110, 10.7530, 'NO'], ['Helsinki', 60.1719, 24.9414, 'FI'],
  ['Dublin', 53.3496, -6.2603, 'IE'], ['Edinburgh', 55.9521, -3.1892, 'GB'],
  ['Manchester', 53.4774, -2.2309, 'GB'], ['Bucureşti', 44.4468, 26.0740, 'RO'],
  ['Sofia', 42.7128, 23.3196, 'BG'], ['Beograd', 44.8186, 20.4700, 'RS'],
  ['Athína', 37.9922, 23.7196, 'GR'], ['İstanbul', 41.0055, 28.9769, 'TR'],
  ['Kyiv', 50.4400, 30.4900, 'UA'], ['Riga', 56.9465, 24.1206, 'LV'],
  ['Tallinn', 59.4400, 24.7536, 'EE'], ['Vilnius', 54.6700, 25.2800, 'LT'],
  // The rest of the world. Every one of these is a region we intend to reach,
  // and drawing them unserved is what makes the intent legible.
  ['New York', 40.7506, -73.9935, 'US'], ['Chicago', 41.8786, -87.6398, 'US'],
  ['Los Angeles', 34.0561, -118.2365, 'US'], ['Toronto', 43.6453, -79.3806, 'CA'],
  ['Montréal', 45.4999, -73.5665, 'CA'], ['Ciudad de México', 19.4363, -99.1450, 'MX'],
  ['São Paulo', -23.5450, -46.6388, 'BR'], ['Buenos Aires', -34.6083, -58.3712, 'AR'],
  ['Tōkyō', 35.6812, 139.7671, 'JP'], ['Ōsaka', 34.7024, 135.4959, 'JP'],
  ['Seoul', 37.5547, 126.9707, 'KR'], ['Beijing', 39.9088, 116.4270, 'CN'],
  ['Shanghai', 31.2490, 121.4550, 'CN'], ['Hong Kong', 22.3049, 114.1722, 'HK'],
  ['Singapore', 1.2831, 103.8515, 'SG'], ['Bangkok', 13.7373, 100.5231, 'TH'],
  ['Delhi', 28.6420, 77.2190, 'IN'], ['Mumbai', 19.0176, 72.8562, 'IN'],
  ['Dubai', 25.2532, 55.3657, 'AE'], ['Cairo', 30.0626, 31.2497, 'EG'],
  ['Marrakesh', 31.6295, -7.9811, 'MA'], ['Cape Town', -33.9222, 18.4231, 'ZA'],
  ['Nairobi', -1.2921, 36.8219, 'KE'], ['Lagos', 6.4550, 3.3841, 'NG'],
  ['Sydney', -33.8830, 151.2065, 'AU'], ['Melbourne', -37.8183, 144.9671, 'AU'],
  ['Auckland', -36.8442, 174.7669, 'NZ'], ['Perth', -31.9505, 115.8605, 'AU'],
];

const net = JSON.parse(readFileSync('src/data/network.json', 'utf8'));
const index = buildIndex(net);

const out = CITIES.map(([name, lat, lon, country]) => {
  // The same 8km/16 sweep the search uses, so "served" here means exactly what
  // it means when someone runs a query.
  const access = accessStops(index, lat, lon, 8000, 16);
  const services = new Set();
  for (const a of access) {
    const s = index.stopServiceOffset[a.idx];
    const e = index.stopServiceOffset[a.idx + 1];
    for (let k = s; k < e; k++) {
      const svc = net.services[index.stopServices[k]];
      if (isLongDistance(svc) && svc.s) services.add(svc.s.trim());
    }
  }
  return { name, lat, lon, country, stops: access.length, services: services.size };
});

// Three tiers, because a globe cannot label 130 cities at once and the ones it
// labels first should be the ones you can actually travel through.
const served = out.filter((c) => c.services > 0).sort((a, b) => b.services - a.services);
const tierOf = (c) => {
  if (c.services === 0) return 2;                       // drawn, unserved
  return served.indexOf(c) < 24 ? 0 : 1;                // hub, or served
};
for (const c of out) c.tier = tierOf(c);

writeFileSync('src/data/cities.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: 'Scores are distinct long-distance services reachable within 8km, measured with the same accessStops the router uses. tier 0 = hub, 1 = served, 2 = drawn but not yet reachable.',
  cities: out,
}, null, 0) + '\n');

const t = [0, 1, 2].map((n) => out.filter((c) => c.tier === n).length);
console.log(`${out.length} cities: ${t[0]} hubs, ${t[1]} served, ${t[2]} not yet reachable`);
console.log('top hubs:', served.slice(0, 12).map((c) => `${c.name}(${c.services})`).join(' '));
