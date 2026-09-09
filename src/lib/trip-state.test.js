import test from 'node:test';
import assert from 'node:assert/strict';
import { dayOffsetLabel, readSavedTrips, sanitizeSavedTrips, savedTripIdentity, validateTrip } from './trip-state.js';

const trip = { id: 'one', from: { name: 'Berlin', lat: 52.52, lon: 13.4 }, to: { name: 'Munich', lat: 48.14, lon: 11.58 }, date: '2026-09-10', adults: 1, budget: 150, costs: { fare: '35.20', baggage: '0' } };

test('corrupt saved data cannot inject invalid amounts, places, or renderable objects', () => {
  assert.deepEqual(readSavedTrips({ getItem: () => '{broken' }), []);
  assert.deepEqual(sanitizeSavedTrips([{ ...trip, budget: 'Infinity' }, { ...trip, from: { ...trip.from, name: {} } }]), []);
  const [saved] = sanitizeSavedTrips([{ ...trip, costs: { fare: true, baggage: '-5', originTransfer: '0', destinationTransfer: '4.50' } }]);
  assert.deepEqual(saved.costs, { fare: '', baggage: '', originTransfer: '0', destinationTransfer: '4.5' });
});

test('valid number-input amounts survive saved-trip reload with EUR cent rounding', () => {
  const [saved] = readSavedTrips({ getItem: () => JSON.stringify([{ ...trip, costs: { fare: '1e2', baggage: '0.123', originTransfer: '.5', destinationTransfer: '0' } }]) });
  assert.deepEqual(saved.costs, { fare: '100', baggage: '0.12', originTransfer: '0.5', destinationTransfer: '0' });
  const now = new Date('2026-09-10T00:30:00Z');
  assert.ok(validateTrip({ ...trip, date: '2026-09-09' }, now));
  assert.equal(validateTrip(trip, now), null);
});

test('saved identities distinguish airports and passenger counts and remove duplicates', () => {
  const two = { ...trip, adults: 2 };
  assert.notEqual(savedTripIdentity(trip), savedTripIdentity(two));
  const saved = sanitizeSavedTrips([trip, { ...trip, id: 'duplicate' }, two]);
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0].id, saved[1].id);
});

test('arrival labels handle multiple days and local dates across the date line', () => {
  assert.equal(dayOffsetLabel('2026-09-10T23:00:00', '2026-09-12T01:00:00'), ' (+2 days)');
  assert.equal(dayOffsetLabel('2026-09-10T01:00:00', '2026-09-09T23:00:00'), ' (-1 day)');
  assert.equal(dayOffsetLabel('2026-09-10T01:00:00', '2026-09-10T23:00:00'), '');
});

test('trip validation enforces real dates, coordinates, passenger limits and API horizon', () => {
  const now = new Date('2026-09-09T23:30:00Z');
  assert.equal(validateTrip(trip, now), null);
  for (const patch of [{ date: '2026-02-30' }, { date: '2027-09-10' }, { adults: 0 }, { to: trip.from }, { from: { ...trip.from, lat: NaN } }]) assert.ok(validateTrip({ ...trip, ...patch }, now));
});
