import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchController, hasMapCoordinates, journeyMapLegs, journeyMapStops, searchPlan } from './search-pipeline.js';

const query = { from: { name: 'Berlin', lat: 52.52, lon: 13.405 }, to: { name: 'Munich', lat: 48.137, lon: 11.575 }, date: '2026-09-10', adults: 1, modes: ['plane', 'train'] };
const time = '2026-09-09T14:00:00Z';
const rail = { type: 'provider', provider: { id: 'rail', status: 'empty', message: 'No train in this test.' }, journeys: [] };
const flights = { type: 'provider', provider: { id: 'skyscanner', status: 'not_configured', message: 'Open the comparison site.' }, journeys: [] };
const start = { type: 'start', query };
const complete = { type: 'complete', searchedAt: time };
const bytes = (event) => new TextEncoder().encode(JSON.stringify(event) + '\n');
const response = (events) => new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });

test('provider results arrive before the slower provider and survive chunk boundaries', async () => {
  let send;
  const stream = new ReadableStream({ start(controller) { send = controller; } });
  const seen = [];
  const running = searchPlan(query, { fetcher: async () => new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }), onEvent: (event) => seen.push(event.type + ':' + (event.provider?.id || '')) });
  send.enqueue(bytes(start));
  const railBytes = bytes(rail);
  send.enqueue(railBytes.slice(0, 17)); send.enqueue(railBytes.slice(17));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seen, ['start:', 'provider:rail']);
  send.enqueue(bytes(flights)); send.enqueue(bytes(complete)); send.close();
  await running;
  assert.deepEqual(seen, ['start:', 'provider:rail', 'provider:skyscanner', 'complete:']);
});

test('JSON fallback and HTTP 429 return structured, bounded retry details', async () => {
  const events = [];
  await searchPlan(query, { fetcher: async () => Response.json({ query, providers: [rail.provider, flights.provider], journeys: [], searchedAt: time }), onEvent: (e) => events.push(e.type) });
  assert.deepEqual(events, ['start', 'provider', 'provider', 'complete']);
  await assert.rejects(searchPlan(query, { fetcher: async () => Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '60' } }) }), (e) => e.code === 'rate_limited' && e.retryAfter === 60);
});

test('incomplete or malformed streams cannot be reported as a successful search', async () => {
  await assert.rejects(searchPlan(query, { fetcher: async () => response([start, rail]) }), (e) => e.code === 'interrupted');
  await assert.rejects(searchPlan(query, { fetcher: async () => response([start, rail, complete]) }), (e) => e.code === 'invalid_response');
  await assert.rejects(searchPlan(query, { fetcher: async () => response([start, { ...rail, journeys: [{ id: 'broken' }] }]) }), (e) => e.code === 'invalid_response');
});

test('deadline stops a stalled response and retains provider results already received', async () => {
  let cancelled = false;
  const controller = createSearchController({ timeoutMs: 15, fetcher: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(bytes(start)); c.enqueue(bytes(rail)); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/x-ndjson' } }) });
  await controller.start(query);
  const state = controller.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.providers.find((p) => p.id === 'rail').status, 'empty');
  assert.equal(state.providers.find((p) => p.id === 'skyscanner').code, 'timeout');
  assert.equal(cancelled, true);
});

test('a cancelled or superseded response cannot overwrite the latest route', async () => {
  let release;
  const old = new Promise((resolve) => { release = resolve; });
  let call = 0;
  const controller = createSearchController({ fetcher: (_url, init) => ++call === 1 ? old : Promise.resolve(response([{ ...start, query: JSON.parse(init.body) }, flights, rail, complete])) });
  const first = controller.start(query);
  await Promise.resolve(); await Promise.resolve();
  const updated = { ...query, to: { name: 'Hamburg', lat: 53.55, lon: 9.99 } };
  await controller.start(updated);
  release(response([start, { ...rail, provider: { ...rail.provider, message: 'Old route' } }, flights, complete]));
  await first;
  assert.equal(controller.getState().query.to.name, 'Hamburg');
  assert.equal(controller.getState().status, 'done');
  assert.notEqual(controller.getState().providers.find((p) => p.id === 'rail').message, 'Old route');
});

test('provider retry requests only its modes and keeps the other completed provider', async () => {
  const bodies = [];
  const controller = createSearchController({ fetcher: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return response(bodies.length === 1 ? [start, rail, flights, complete] : [{ ...start, query: bodies.at(-1) }, flights, complete]);
  } });
  await controller.start(query);
  await controller.start(query, { retryProvider: 'skyscanner' });
  assert.deepEqual(bodies[1].modes, ['plane']);
  assert.equal(controller.getState().providers.find((p) => p.id === 'rail').status, 'empty');
  assert.equal(controller.getState().providers.length, 2);
});

test('explicit cancellation exits a fetch that never resolves', async () => {
  const controller = createSearchController({ fetcher: () => new Promise(() => {}) });
  const running = controller.start(query);
  controller.cancel();
  await running;
  assert.equal(controller.getState().status, 'cancelled');
  assert.ok(controller.getState().providers.every((p) => p.status === 'cancelled'));
});

const journey = () => ({
  id: 'rail:fixture', provider: 'rail', mode: 'train', modes: ['train'], from: query.from, to: query.to,
  date: query.date, departure: `${query.date}T08:00:00`, arrival: `${query.date}T12:00:00`, durationMinutes: 240, price: null,
  changes: 0, source: { name: 'Published feed', url: 'https://transit.example/feed', fetchedAt: time }, notes: [], sources: [], bookingLinks: [],
  legs: [{ mode: 'train', from: query.from, to: query.to, departure: `${query.date}T08:00:00`, arrival: `${query.date}T12:00:00`, service: 'IC 1' }],
});
const withJourney = (value) => response([start, { ...rail, provider: { ...rail.provider, status: 'ok' }, journeys: [value] }, flights, complete]);

test('known stops remain drawable when an intermediate airport has no coordinates', async () => {
  const data = journey();
  const unknown = { name: 'Transfer airport', lat: null, lon: null };
  data.legs = [
    { ...data.legs[0], to: unknown, arrival: `${query.date}T09:00:00` },
    { ...data.legs[0], from: unknown, departure: `${query.date}T10:00:00` },
  ];
  let received;
  await searchPlan(query, { fetcher: async () => withJourney(data), onEvent(event) { if (event.provider?.id === 'rail') received = event.journeys[0]; } });
  assert.equal(received.legs[0].to.lat, null);
  assert.deepEqual(journeyMapLegs(received), []);
  assert.deepEqual(journeyMapStops(received), [query.from, query.to]);
});

test('globe guards reject missing, non-numeric and out-of-range coordinates without inventing zeroes', () => {
  for (const point of [null, {}, { lat: 50 }, { lat: 50, lon: null }, { lat: '50', lon: 10 }, { lat: 91, lon: 10 }, { lat: 50, lon: 181 }, { lat: NaN, lon: 10 }, { lat: 50, lon: Infinity }]) {
    assert.equal(hasMapCoordinates(point), false);
    assert.deepEqual(journeyMapLegs({ legs: [{ from: query.from, to: point }] }), []);
  }
  assert.equal(hasMapCoordinates({ lat: 0, lon: 0 }), true);
  for (const invalid of [null, {}, { legs: null }, { legs: [null, {}] }]) {
    assert.deepEqual(journeyMapLegs(invalid), []);
    assert.deepEqual(journeyMapStops(invalid), []);
  }
  assert.equal(journeyMapLegs(journey()).length, 1);
});

test('malformed rendering metadata and unsafe links stop at the response boundary', async () => {
  for (const mutate of [
    (j) => { j.notes = 'not an array'; },
    (j) => { j.notes = [{}]; },
    (j) => { j.sources = {}; },
    (j) => { j.sources = [null]; },
    (j) => { delete j.source; },
    (j) => { j.source.name = {}; },
    (j) => { j.source.fetchedAt = {}; },
    (j) => { j.legs[0].service = {}; },
    (j) => { j.legs[0].operator = []; },
    (j) => { j.bookingLinks = 'not an array'; },
    (j) => { j.bookingLinks = [null]; },
    (j) => { j.bookingLinks = [{ url: 'https://booking.example', agent: {} }]; },
    (j) => { j.bookingUrl = 'javascript:alert(1)'; },
    (j) => { j.source.url = 'https://localhost./'; },
    (j) => { j.legs[0].to = { name: 'Broken', lat: 50, lon: '10' }; },
    (j) => { j.price = { amount: 10, currency: { toString: null } }; },
  ]) {
    const data = structuredClone(journey()); mutate(data);
    await assert.rejects(searchPlan(query, { fetcher: async () => withJourney(data) }), (error) => error.code === 'invalid_response');
  }
  await assert.rejects(searchPlan(query, { fetcher: async () => response([start, { ...rail, provider: { ...rail.provider, sources: 'invalid' } }, flights, complete]) }), (error) => error.code === 'invalid_response');
});

test('impossible dates and malformed local clocks are rejected before date formatting', async () => {
  for (const mutate of [
    (j) => { j.date = '2026-02-30'; },
    (j) => { j.departure = '2026-09-10T25:00:00'; },
    (j) => { j.arrival = '2026-02-30T12:00:00'; },
    (j) => { j.legs[0].arrival = '2026-09-10T12:00:00Z'; },
    (j) => { j.date = '2026-09-11'; j.departure = '2026-09-11T08:00:00'; },
  ]) {
    const data = journey(); mutate(data);
    await assert.rejects(searchPlan(query, { fetcher: async () => withJourney(data) }), (error) => error.code === 'invalid_response');
  }
});

test('a response for another query cannot be accepted for the current trip', async () => {
  for (const mismatch of [
    { ...query, to: { ...query.to, name: 'Other city' } },
    { ...query, to: { ...query.to, lon: 15 } },
    { ...query, date: '2026-09-11' },
    { ...query, adults: 2 },
    { ...query, cabin: 'business' },
    { ...query, modes: ['plane'] },
  ]) {
    await assert.rejects(searchPlan(query, { fetcher: async () => response([{ ...start, query: mismatch }, rail, flights, complete]) }), (error) => error.code === 'invalid_response');
  }
});

test('JSON fallback rejects orphaned or null journeys rather than silently dropping them', async () => {
  for (const invalid of [null, { ...journey(), provider: 'unexpected' }]) {
    await assert.rejects(searchPlan(query, { fetcher: async () => Response.json({ query, providers: [rail.provider, flights.provider], journeys: [invalid], searchedAt: time }) }), (error) => error.code === 'invalid_response');
  }
});

test('pre-cancellation never starts a network request and late aborted responses are released', async () => {
  const cancelled = new AbortController(); cancelled.abort(new DOMException('Stopped', 'AbortError'));
  let fetched = 0;
  await assert.rejects(searchPlan(query, { signal: cancelled.signal, fetcher: async () => { fetched++; return response([]); } }), (error) => error.name === 'AbortError');
  assert.equal(fetched, 0);
  const active = new AbortController();
  let release, bodyCancelled = false;
  const pending = searchPlan(query, { signal: active.signal, fetcher: () => new Promise((resolve) => { release = resolve; }) });
  await Promise.resolve(); await Promise.resolve();
  active.abort(new DOMException('Stopped', 'AbortError'));
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  release(new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(bodyCancelled, true);
});

test('a transport that stays open after its complete event is still cancelled at the deadline', async () => {
  let cancelled = false;
  await assert.rejects(searchPlan(query, { timeoutMs: 10, fetcher: async () => new Response(new ReadableStream({
    start(stream) { for (const event of [start, rail, flights, complete]) stream.enqueue(bytes(event)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/x-ndjson' } }) }), (error) => error.code === 'timeout');
  assert.equal(cancelled, true);
});
