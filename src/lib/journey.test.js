import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normaliseItinerary, normaliseLeg, legSourceState,
  isOvernightJourney, formatDuration, MIN_USEFUL_SLEEP_SECONDS,
} from './journey.js';

// This fixture is a REAL response from api.transitous.org for
// Vienna -> Rome, captured 2026-08-31. Field values are untouched; only
// unused keys were dropped. If Transitous changes shape, these tests break —
// which is the point.
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/vienna-rome.json', import.meta.url), 'utf8'),
);

test('fixture is real API output containing a real Nightjet', () => {
  const legs = fixture.itineraries.flatMap((i) => i.legs);
  const nj = legs.find((l) => l.mode === 'NIGHT_RAIL');
  assert.ok(nj, 'fixture must contain a NIGHT_RAIL leg');
  assert.equal(nj.routeShortName, 'NJ 40233');
  assert.match(nj.from.name, /Wien|Attnang/);
});

test('normalises the real Vienna-Rome overnight journey', () => {
  const overnight = fixture.itineraries
    .map(normaliseItinerary)
    .find((i) => i.hasSleeper);

  assert.ok(overnight, 'expected an itinerary with a sleeper');
  assert.ok(overnight.sleeperSeconds > 8 * 3600, 'NJ 40233 runs well over 8h');
  assert.ok(isOvernightJourney(overnight), 'should qualify as a real overnight');
  assert.equal(overnight.sleeperServices[0].service, 'NJ 40233');
  assert.match(overnight.sleeperServices[0].operator, /OEBB|ÖBB/);
});

test('price is null on every leg and every itinerary — always', () => {
  for (const itin of fixture.itineraries.map(normaliseItinerary)) {
    assert.equal(itin.price, null, 'itinerary price must be null');
    for (const leg of itin.legs) {
      assert.equal(leg.price, null, 'leg price must be null');
    }
  }
});

test('a fare link is surfaced when the feed provides one, without inventing a number', () => {
  const legs = fixture.itineraries.flatMap((i) => normaliseItinerary(i).legs);
  const withFareUrl = legs.filter((l) => l.fareUrl);
  // The feed may or may not carry fare URLs; whichever it is, price stays null.
  for (const leg of withFareUrl) {
    assert.equal(leg.price, null);
    assert.match(leg.fareUrl, /^https?:\/\//);
  }
});

test('source state distinguishes walking from scheduled from live', () => {
  assert.equal(legSourceState({ mode: 'WALK' }), 'walking');
  assert.equal(legSourceState({ mode: 'NIGHT_RAIL', realTime: false }), 'scheduled');
  assert.equal(legSourceState({ mode: 'NIGHT_RAIL', realTime: true }), 'live');
  assert.equal(legSourceState({ mode: 'HIGHSPEED_RAIL', realTime: true }), 'live');
});

test('walking legs are never marked as transit', () => {
  const leg = normaliseLeg({ mode: 'WALK', startTime: '2026-09-02T18:00:00Z', endTime: '2026-09-02T18:07:00Z' });
  assert.equal(leg.isTransit, false);
  assert.equal(leg.isSleeper, false);
  assert.equal(leg.sourceState, 'walking');
  assert.equal(leg.durationSeconds, 420);
});

test('a short NIGHT_RAIL hop does not count as a night in a bed', () => {
  const shortHop = {
    startTime: '2026-09-02T22:00:00Z', endTime: '2026-09-03T00:30:00Z',
    duration: 9000, transfers: 0,
    legs: [{ mode: 'NIGHT_RAIL', routeShortName: 'NJ 999',
      startTime: '2026-09-02T22:00:00Z', endTime: '2026-09-03T00:30:00Z' }],
  };
  const itin = normaliseItinerary(shortHop, 0);
  assert.equal(itin.hasSleeper, true, 'it is a night train');
  assert.equal(isOvernightJourney(itin), false, 'but 2.5h is not a night of sleep');
  assert.ok(MIN_USEFUL_SLEEP_SECONDS === 5 * 3600);
});

test('missing times yield null duration rather than a fabricated one', () => {
  const leg = normaliseLeg({ mode: 'RAIL', startTime: null, endTime: null });
  assert.equal(leg.durationSeconds, null);
  assert.equal(formatDuration(leg.durationSeconds), 'unavailable');
});

test('formatDuration renders hours and minutes', () => {
  // U+202F NARROW NO-BREAK SPACE between the hour and minute figures: these
  // are rendered with tabular numerals, which pad an ordinary space out to a
  // full digit width and make "15h 07m" read as an accidental double space.
  assert.equal(formatDuration(54420), '15h 07m');
  assert.equal(formatDuration(2700), '45m');
  assert.equal(formatDuration(null), 'unavailable');
});

test('the hour/minute separator never wraps across a line', () => {
  assert.ok(!formatDuration(54420).includes('15h 07m'), 'must not use an ordinary space');
  assert.ok(formatDuration(54420).includes(' '), 'uses a narrow no-break space');
});

test('transfers fall back to leg count when absent', () => {
  const itin = normaliseItinerary({
    legs: [
      { mode: 'WALK' },
      { mode: 'RAIL', routeShortName: 'A' },
      { mode: 'RAIL', routeShortName: 'B' },
    ],
  }, 0);
  assert.equal(itin.transfers, 1, 'two transit legs = one transfer');
});
