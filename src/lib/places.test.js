import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './router.js';
import { buildPlaceIndex, searchPlaces, cityNameFrom } from './places.js';

/**
 * Every test here corresponds to a bug that actually shipped. The place index
 * looks trivial and is not: it has produced four separate defects, each of
 * which a user would hit within a minute of opening the app.
 */

test('a city takes its own name, not its biggest station\'s', () => {
  // Shipped: "Berlin Südkreuz" and "Madrid-Puerta de Atocha-Almudena Grandes"
  // were offered as the names of cities.
  assert.equal(cityNameFrom('Berlin Südkreuz'), 'Berlin');
  assert.equal(cityNameFrom('Berlin Hbf'), 'Berlin');
  assert.equal(cityNameFrom('Madrid-Puerta de Atocha-Almudena Grandes'), 'Madrid');
  assert.equal(cityNameFrom('Paris Gare de Lyon Hall 1 - 2'), 'Paris');
  assert.equal(cityNameFrom('München Hbf'), 'München');
  assert.equal(cityNameFrom('Wien Meidling'), 'Wien');
  assert.equal(cityNameFrom('Barcelona-Sants'), 'Barcelona');
});

test('a compound city name keeps its second word', () => {
  // Shipped: a blunt two-word cap turned "Lyon Part Dieu" into "Lyon Part".
  assert.equal(cityNameFrom('Lyon Part Dieu'), 'Lyon');
  assert.equal(cityNameFrom('Frankfurt am Main'), 'Frankfurt am');
  assert.equal(cityNameFrom('Den Haag Centraal'), 'Den Haag');
});

/**
 * A network with the three shapes that broke the index: a city whose stations
 * have different names, a same-named city far away, and a minor halt.
 */
function fixture() {
  return {
    stops: [
      { n: 'Frankfurt(Main)Hbf', y: 50.1067, x: 8.6628 },   // 0  major
      { n: 'Frankfurt(Main)Süd', y: 50.0994, x: 8.6857 },   // 1  minor
      { n: 'Frankfurt(Oder)', y: 52.3411, x: 14.5506 },     // 2  500km east
      { n: 'Paris Gare de Lyon Hall 1 - 2', y: 48.8449, x: 2.3735 }, // 3
      { n: 'Paris Est', y: 48.8766, x: 2.3590 },            // 4
      { n: 'Wien Hbf', y: 48.1856, x: 16.3367 },            // 5
      { n: 'Überlingen', y: 47.7656, x: 9.1649 },           // 6  must not match "berlin"
      { n: 'Berlin Hbf', y: 52.5251, x: 13.3694 },          // 7
    ],
    services: [
      // Frankfurt Hbf is heavily served; Frankfurt (Oder) barely.
      ...Array.from({ length: 8 }, (_, i) => ({
        s: `ICE ${i}`, m: 'rail', o: 'DB', c: [[0, null, 480 + i], [7, 700 + i, null]],
      })),
      { s: 'RB 1', m: 'rail', o: 'DB', c: [[1, null, 500], [0, 510, null]] },
      { s: 'RB 2', m: 'rail', o: 'DB', c: [[2, null, 520], [7, 620, null]] },
      // Paris: Gare de Lyon well served, Est less so.
      ...Array.from({ length: 6 }, (_, i) => ({
        s: `TGV ${i}`, m: 'rail', o: 'SNCF', c: [[3, null, 600 + i], [5, 900 + i, null]],
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        s: `ICE ${20 + i}`, m: 'rail', o: 'DB', c: [[4, null, 610 + i], [7, 880 + i, null]],
      })),
      { s: 'S 1', m: 'rail', o: 'SBB', c: [[6, null, 400], [5, 480, null]] },
      ...Array.from({ length: 5 }, (_, i) => ({
        s: `RJ ${i}`, m: 'rail', o: 'ÖBB', c: [[5, null, 700 + i], [0, 1000 + i, null]],
      })),
    ],
  };
}

const net = fixture();
const index = buildIndex(net);
const places = buildPlaceIndex(net, index);

test('a city is anchored to a real station, not to a centroid', () => {
  // Shipped: averaging every "Frankfurt*" coordinate put the city 60km away in
  // open countryside, and searching for it found no station at all.
  const [frankfurt] = searchPlaces(places, 'frankfurt');
  assert.equal(frankfurt.kind, 'city');
  assert.ok(Math.abs(frankfurt.lat - 50.1067) < 0.05, `lat drifted: ${frankfurt.lat}`);
  assert.ok(Math.abs(frankfurt.lon - 8.6628) < 0.05, `lon drifted: ${frankfurt.lon}`);
});

test('a city outranks its own stations', () => {
  const hits = searchPlaces(places, 'paris');
  assert.equal(hits[0].kind, 'city', 'the city should come first');
  assert.equal(hits[0].name, 'Paris');
});

test('well-served stations are individually searchable', () => {
  // Shipped: every Paris station collapsed into one entry labelled "Paris Est",
  // so Gare de Lyon — where trains from the south arrive — could not be chosen.
  const names = searchPlaces(places, 'paris').map((p) => p.name);
  assert.ok(names.some((n) => /Gare de Lyon/.test(n)),
    `Gare de Lyon must be selectable; got ${names.join(', ')}`);
});

test('a quiet halt does not clutter the list', () => {
  // Überlingen has one service; it should not appear as a station entry.
  const stationNames = places.filter((p) => p.kind === 'station').map((p) => p.name);
  assert.ok(!stationNames.includes('Überlingen'));
});

test('substring matches do not outrank prefix matches', () => {
  // Shipped: searching "berlin" returned "Überlingen" and "Oberlinxweiler"
  // above Berlin.
  const hits = searchPlaces(places, 'berlin');
  assert.ok(hits.length, 'expected a hit');
  assert.match(hits[0].name, /^Berlin/, `got ${hits[0].name}`);
});

test('English names find locally-named cities', () => {
  // Shipped: "Vienna" returned nothing, because the feeds say "Wien".
  const hits = searchPlaces(places, 'Vienna');
  assert.ok(hits.length, 'Vienna must resolve');
  assert.match(hits[0].name, /^Wien/);
});

test('a query too short to be meaningful returns nothing', () => {
  assert.deepEqual(searchPlaces(places, 'b'), []);
  assert.deepEqual(searchPlaces(places, ''), []);
  assert.deepEqual(searchPlaces(places, null), []);
});

test('a query matching nothing returns nothing, not a guess', () => {
  assert.deepEqual(searchPlaces(places, 'zzzznowhere'), []);
});

test('every returned place carries usable coordinates', () => {
  for (const q of ['frankfurt', 'paris', 'berlin', 'wien']) {
    for (const p of searchPlaces(places, q)) {
      assert.ok(Number.isFinite(p.lat) && Math.abs(p.lat) <= 90, `${p.name} lat`);
      assert.ok(Number.isFinite(p.lon) && Math.abs(p.lon) <= 180, `${p.name} lon`);
      assert.ok(p.name, 'every place needs a name');
      assert.ok(p.kind === 'city' || p.kind === 'station');
    }
  }
});

test('results are capped so the list stays usable', () => {
  assert.ok(searchPlaces(places, 'a', 8).length <= 8);
  assert.ok(searchPlaces(places, 'paris', 2).length <= 2);
});
