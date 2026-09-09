import { test } from 'node:test';
import assert from 'node:assert/strict';
import { places, searchPlaces, nearestAirports, haversineKm, providerLinks,
  formatDuration, budgetTotal, rankJourneys } from './planner.js';

test('English, local, Turkish and diacritic spellings resolve to the same city', () => {
  for (const query of ['İstanbul', 'Istanbul', 'ISTANBUL', 'ıstanbul', 'istanbul']) {
    assert.equal(searchPlaces(query)[0].name, 'Istanbul', query);
  }
  for (const [query, name] of [['Wien', 'Vienna'], ['Vienna', 'Vienna'], ['München', 'Munich'],
    ['muenchen', 'Munich'], ['ZURICH', 'Zurich'], ['Zürich', 'Zurich'],
    ['København', 'Copenhagen'], ['Koebenhavn', 'Copenhagen'], ['Wrocław', 'Wroclaw']]) {
    assert.equal(searchPlaces(query)[0].name, name, query);
  }
  assert.equal(places.find(p => p.name === 'Vienna').localName, 'Wien');
  assert.equal(new Set(places.map(p => p.id)).size, places.length);
});

test('suggestions distinguish exact airport codes from cities and support countries', () => {
  const airport = searchPlaces('saw')[0];
  assert.equal(airport.kind, 'airport');
  assert.equal(airport.iata, 'SAW');
  assert.equal(airport.country, 'TR');
  assert.equal(searchPlaces('Istanbul Turkey')[0].name, 'Istanbul');
  assert.equal(searchPlaces('Istanbul Türkiye')[0].name, 'Istanbul');
  assert.deepEqual(searchPlaces(''), []);
  assert.deepEqual(searchPlaces('constructor'), []);
  assert.deepEqual(searchPlaces('__proto__'), []);
  assert.equal(searchPlaces('a', 2).length, 2);
  assert.equal(searchPlaces('a', 0).length, 0);
});

test('airport distances are geographical and retain the source airport coordinates', () => {
  const city = places.find(p => p.name === 'Vienna');
  const nearest = nearestAirports(city);
  assert.equal(nearest.length, 3);
  assert.ok(nearest.every((a, i) => i === 0 || a.distanceKm >= nearest[i - 1].distanceKm));
  const vie = nearest.find(a => a.iata === 'VIE');
  assert.ok(vie.distanceKm > 18 && vie.distanceKm < 25);
  assert.equal(nearestAirports(vie, 1)[0].distanceKm, 0);
  assert.ok(!Object.hasOwn(vie, 'price'));
  assert.deepEqual(nearestAirports({ lat: null, lon: 0 }), []);
  assert.deepEqual(nearestAirports(city, -2), []);
});

test('haversine handles a known corridor, identical points and invalid coordinates', () => {
  const berlinHamburg = haversineKm(52.5251, 13.3694, 53.5528, 10.0067);
  assert.ok(berlinHamburg > 250 && berlinHamburg < 260);
  assert.equal(haversineKm(0, 0, 0, 0), 0);
  assert.ok(Math.abs(haversineKm(0, 0, 0, 180) - 20015.11) < 0.1);
  assert.equal(haversineKm(null, 0, 0, 0), null);
  assert.equal(haversineKm(91, 0, 0, 0), null);
});

test('Skyscanner handoff contains the airport pair, exact date and one-way settings', () => {
  const links = providerLinks('Istanbul', 'Wien', '2026-12-09');
  const sky = links.find(link => link.id === 'skyscanner');
  const url = new URL(sky.url);
  assert.equal(url.hostname, 'www.skyscanner.net');
  assert.equal(url.pathname, '/transport/flights/ist/vie/261209/');
  assert.equal(url.searchParams.get('rtn'), '0');
  assert.equal(url.searchParams.get('adultsv2'), '1');
  assert.equal(sky.prefilled, true);
  assert.equal(sky.mode, 'plane');
  const google = new URL(links.find(link => link.id === 'google-flights').url);
  assert.match(google.searchParams.get('q'), /from IST to VIE on 2026-12-09/);
  assert.ok(links.some(link => link.id === 'obb'));
  assert.ok(links.some(link => link.id === 'tcdd'));
  for (const link of links.filter(link => ['train', 'bus'].includes(link.mode))) {
    assert.equal(link.prefilled, false);
    assert.equal(new URL(link.url).search, '');
  }
});

test('flight handoffs preserve the selected adult count without silently substituting one', () => {
  for (const adults of [1, 2, 8]) {
    const links = providerLinks('IST', 'VIE', '2026-12-09', { adults });
    const sky = links.find(link => link.id === 'skyscanner');
    assert.equal(new URL(sky.url).searchParams.get('adultsv2'), String(adults));
    assert.match(sky.note, new RegExp(`${adults} adult`));
    assert.match(new URL(links.find(link => link.id === 'google-flights').url).searchParams.get('q'),
      new RegExp(`for ${adults} adult`));
  }
  for (const adults of [0, 9, 2.5, null, '', true, [2], Infinity, 'invalid']) {
    assert.equal(providerLinks('IST', 'VIE', '2026-12-09', { adults })[0].prefilled, false);
  }
  assert.ok(providerLinks('IST', 'VIE', '2026-12-09').every(link => ['plane', 'train', 'bus', 'metro'].includes(link.mode)));
});

test('Google Maps transit handoff uses the selected coordinates without promising date, metro-only routes or fares', () => {
  const from = { name: 'Origin', lat: 0, lon: -73.99 };
  const to = { name: 'Destination', lat: 40.75, lon: 0 };
  const link = providerLinks(from, to, '2026-12-09', { adults: 2 }).find(link => link.id === 'google-transit');
  const url = new URL(link.url);
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.pathname, '/maps/dir/');
  assert.equal(url.searchParams.get('api'), '1');
  assert.equal(url.searchParams.get('travelmode'), 'transit');
  assert.equal(url.searchParams.get('origin'), '0,-73.99');
  assert.equal(url.searchParams.get('destination'), '40.75,0');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['api', 'destination', 'origin', 'travelmode']);
  assert.equal(link.mode, 'metro');
  assert.equal(link.prefilled, false);
  assert.match(link.note, /Choose the date and time in Google Maps/);
  assert.match(link.note, /may include buses, trains or metro/);
  assert.match(link.note, /check availability and fares/);
  assert.ok(!link.url.includes('2026-12-09'));
  const city = places.find(place => place.name === 'Vienna');
  const cityUrl = new URL(providerLinks('Wien', 'Berlin', '2026-12-09').find(link => link.id === 'google-transit').url);
  assert.equal(cityUrl.searchParams.get('origin'), `${city.lat},${city.lon}`);
});

test('Google Maps transit never passes missing or invalid coordinates as a selected route', () => {
  for (const from of [{ name: 'Unknown' }, { lat: null, lon: 0 }, { lat: 91, lon: 0 }, { lat: 0, lon: Infinity }, { lat: '0', lon: 0 }]) {
    const link = providerLinks(from, { lat: 40, lon: 10 }, '2026-12-09').find(link => link.id === 'google-transit');
    const url = new URL(link.url);
    assert.equal(url.searchParams.has('origin'), false);
    assert.equal(url.searchParams.has('destination'), false);
    assert.equal(link.prefilled, false);
    assert.match(link.note, /Enter your route/);
  }
});

test('invalid dates and missing airports never form broken prefilled flight links', () => {
  for (const date of ['2026-02-30', '2026-13-01', 'not-a-date', null]) {
    const sky = providerLinks('IST', 'VIE', date).find(link => link.id === 'skyscanner');
    assert.equal(sky.prefilled, false, String(date));
    assert.equal(sky.url, 'https://www.skyscanner.net/');
  }
  const sky = providerLinks({ name: 'Small Town' }, { name: 'Other Town' }, '2026-12-09')[0];
  assert.equal(sky.prefilled, false);
  assert.ok(!sky.url.includes('undefined'));
  assert.equal(providerLinks('IST', 'IST', '2026-12-09')[0].prefilled, false);
});

test('budget total requires every cost, distinguishing unknown from explicit zero', () => {
  const costs = { fare: 35.1, baggage: 0, originTransfer: 3.2, destinationTransfer: 1.7 };
  assert.equal(budgetTotal(costs), 40);
  assert.equal(budgetTotal({ fare: '35.10', baggage: '0', originTransfer: '3.20', destinationTransfer: '1.70' }), 40);
  assert.equal(budgetTotal({ fare: 0, baggage: 0, originTransfer: 0, destinationTransfer: 0 }), 0);
  for (const field of Object.keys(costs)) {
    for (const unknown of [null, undefined, '', ' ', false, NaN, Infinity, -1, '€12']) {
      assert.equal(budgetTotal({ ...costs, [field]: unknown }), null, `${field} ${unknown}`);
    }
  }
  assert.equal(budgetTotal(), null);
});

test('cheapest compares known EUR fares and keeps incomplete or unknown totals last', () => {
  const rows = [
    { id: 'unknown', price: null, currency: 'EUR' },
    { id: 'usd', price: { amount: 1, currency: 'USD' } },
    { id: 'expensive', price: { amount: 40, currency: 'EUR' } },
    { id: 'partial', price: { amount: 2, currency: 'EUR', includesAllLegs: false } },
    { id: 'cheap', price: 10, currency: 'EUR' },
    { id: 'free', price: { amount: 0, currency: 'EUR' } },
    { id: 'invalid', price: { amount: NaN, currency: 'EUR' } },
  ];
  assert.deepEqual(rankJourneys(rows, 'cheapest').map(row => row.id),
    ['free', 'cheap', 'expensive', 'unknown', 'usd', 'partial', 'invalid']);
  assert.equal(rows[0].id, 'unknown', 'sorting must not mutate the input');
});

test('fastest ranks finite duration values, including router durationMin, with stable ties', () => {
  const rows = [{ id: 'missing' }, { id: 'slow', durationMinutes: 180 },
    { id: 'fast', durationMin: 60 }, { id: 'invalid', durationMinutes: Infinity },
    { id: 'same', durationMinutes: 60 }, { id: 'null', durationMinutes: null }];
  assert.deepEqual(rankJourneys(rows, 'fastest').map(row => row.id),
    ['fast', 'same', 'slow', 'missing', 'invalid', 'null']);
  assert.deepEqual(rankJourneys(rows, 'recommended'), rows);
});

test('duration labels preserve unknown values and round before splitting hours', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(Infinity), '—');
  assert.equal(formatDuration(-1), '—');
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(59.6), '1h');
  assert.equal(formatDuration(125), '2h 5m');
});
