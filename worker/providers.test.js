import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProviderJson, normalizeFlights, normalizeRail, searchFlights, searchRail } from './providers.js';
import { ApiError, readJsonLimited, safeUrl, validatePlan } from './validation.js';

const input = { from: { name: 'Istanbul', lat: 41.01, lon: 28.97, iata: 'IST' }, to: { name: 'Berlin', lat: 52.52, lon: 13.4, iata: 'BER' }, date: '2026-10-15', adults: 2, cabin: 'economy', modes: ['plane', 'train', 'bus', 'metro'] };
const now = new Date('2026-09-09T12:00:00Z');
const dt = (hour, minute = 0) => ({ year: 2026, month: 10, day: 15, hour, minute });

function flightData(amount = '129500000', unit = 'PRICE_UNIT_MICRO') {
  return {
    itineraries: { flight1: { legIds: ['leg1'], pricingOptions: [{ price: { amount, unit }, items: [{ agentId: 'airline1', deepLink: 'https://www.airline.example/book?id=1' }], transferType: 'TRANSFER_TYPE_MANAGED' }] } },
    legs: { leg1: { originPlaceId: 'ist', destinationPlaceId: 'ber', departureDateTime: dt(12), arrivalDateTime: dt(14), durationInMinutes: 180, stopCount: 0, segmentIds: ['s1'], marketingCarrierIds: ['c1'] } },
    segments: { s1: { originPlaceId: 'ist', destinationPlaceId: 'ber', departureDateTime: dt(12), arrivalDateTime: dt(14), durationInMinutes: 180, marketingCarrierId: 'c1', marketingFlightNumber: 'TEST42' } },
    places: { ist: { name: 'Istanbul Airport', iata: 'IST' }, ber: { name: 'Berlin Brandenburg', iata: 'BER' } },
    carriers: { c1: { name: 'Test airline' } }, agents: { airline1: { name: 'Test airline' } },
  };
}

const railData = () => ({
  date: 20261015, calendar: { from: 20261001, days: 31 }, generatedAt: '2026-09-09T10:00:00Z',
  sources: [{ id: 'test_gtfs', name: 'Test public feed', url: 'https://transit.example/feed.zip', license: 'CC0', fetchedAt: '2026-09-09T10:00:00Z' }],
  journeys: [{ departMin: 1380, arriveMin: 1500, durationMin: 120, transfers: 0, hasSleeper: true, price: null,
    legs: [{ mode: 'night_rail', from: { name: 'Central A', lat: 40, lon: 10 }, to: { name: 'Central B', lat: 42, lon: 12 }, departMin: 1380, arriveMin: 1500, operator: 'Test operator', service: 'NJ 1', price: null }] }],
});

test('strict validation rejects impossible, past, distant dates and invalid scalar types', () => {
  assert.deepEqual(validatePlan(input, now), input);
  for (const date of ['2026-02-30', '2026-13-01', '2026-09-08', '2028-01-01', '15/10/2026', null]) {
    assert.throws(() => validatePlan({ ...input, date }, now), /real date/);
  }
  for (const adults of [0, 9, 1.2, '2', null]) assert.throws(() => validatePlan({ ...input, adults }, now), /adult travelers/);
  assert.throws(() => validatePlan({ ...input, from: { ...input.from, lat: '41' } }, now), /latitude/);
  assert.throws(() => validatePlan({ ...input, to: input.from }, now), /different destination/);
  assert.throws(() => validatePlan({ ...input, modes: ['plane', 'plane'] }, now), /without duplicates/);
  assert.throws(() => validatePlan({ ...input, modes: ['boat'] }, now), /without duplicates/);
  assert.throws(() => validatePlan({ ...input, cabin: '__proto__' }, now), /cabin/);
});

test('body cap works without content-length and malformed UTF-8 is rejected', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4000)); controller.enqueue(new Uint8Array(5000)); controller.close(); } });
  await assert.rejects(readJsonLimited(new Response(stream)), (error) => error.status === 413);
  await assert.rejects(readJsonLimited(new Response(new Uint8Array([0xff]))), (error) => error.code === 'invalid_json');
  await assert.rejects(readJsonLimited(new Response('{}', { headers: { 'content-length': '9000' } })), (error) => error.status === 413);
  await assert.rejects(readJsonLimited(new Response(new ReadableStream({ start() {} })), 8192, 5), (error) => error.code === 'body_timeout');
});

test('cities sharing an airport remain valid for ground travel and never trigger a same-airport flight search', async () => {
  const shared = { ...input, from: { name: 'Zurich', lat: 47.3769, lon: 8.5417, iata: 'ZRH' }, to: { name: 'Winterthur', lat: 47.5, lon: 8.75, iata: 'ZRH' } };
  assert.deepEqual(validatePlan(shared, now), shared);
  let fetched = false;
  const response = await searchFlights(shared, { SKYSCANNER_API_KEY: 'test' }, { fetcher: async () => { fetched = true; throw new Error('Should not search'); } });
  assert.equal(response.provider.status, 'unavailable');
  assert.equal(fetched, false);
  const noAirport = { ...shared, to: { name: 'Winterthur', lat: 47.5, lon: 8.75 } };
  assert.deepEqual(validatePlan(noAirport, now), noAirport);
});

test('booking URLs reject dangerous schemes, embedded credentials and local targets', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', '//book.example/path', 'http://book.example', 'https://user:pass@book.example', 'https://localhost/', 'https://localhost./', 'https://127.0.0.1', 'https://169.254.169.254/', 'https://[::1]/', 'https://router.local', 'https://router.local.']) assert.equal(safeUrl(url), null);
  assert.equal(safeUrl('https://booking.example/flight?route=IST-BER'), 'https://booking.example/flight?route=IST-BER');
});

test('flights preserve provider duration across time zones and quote total for all adults', () => {
  const [journey] = normalizeFlights(flightData(), input, 'EUR', now.toISOString());
  assert.equal(journey.durationMinutes, 180); // Local clocks differ by 120 min; subtraction would lie.
  assert.equal(journey.price.amount, 129.5);
  assert.equal(journey.price.travelers, 2);
  assert.equal(journey.price.basis, 'all_travelers');
  assert.equal(journey.departure, '2026-10-15T12:00:00');
  assert.equal(journey.source.fetchedAt, now.toISOString());
  assert.equal(journey.baggage.checked, 'unknown');
});

test('all documented monetary units normalize and unspecified or missing units never produce fares', () => {
  for (const [unit, raw] of [['PRICE_UNIT_WHOLE', '129.5'], ['PRICE_UNIT_CENTI', '12950'], ['PRICE_UNIT_MILLI', '129500'], ['PRICE_UNIT_MICRO', '129500000']]) assert.equal(normalizeFlights(flightData(raw, unit), input)[0].price.amount, 129.5);
  assert.deepEqual(normalizeFlights(flightData('100', 'PRICE_UNIT_UNSPECIFIED'), input), []);
  assert.deepEqual(normalizeFlights(flightData('-5'), input), []);
});

test('missing duration and wrong-date itineraries do not become plausible journeys', () => {
  const data = flightData();
  delete data.legs.leg1.durationInMinutes;
  assert.deepEqual(normalizeFlights(data, input), []);
  assert.deepEqual(normalizeFlights(flightData(), { ...input, date: '2026-10-16' }), []);
});

test('multi-ticket options never advertise the first booking item as the whole fare', () => {
  const data = flightData();
  data.itineraries.flight1.pricingOptions[0].items.push({ agentId: 'airline1', deepLink: 'https://another.example/book' });
  const [journey] = normalizeFlights(data, input);
  assert.equal(journey.bookingUrl, null);
  assert.equal(journey.bookingLinks.length, 2);
  data.itineraries.flight1.pricingOptions[0].items[0].deepLink = 'javascript:alert(1)';
  assert.deepEqual(normalizeFlights(data, input), []);
});

test('create/poll replaces obsolete quotes and respects not-modified response', async () => {
  const calls = [];
  const responses = [
    { sessionToken: 'token/unsafe?', status: 'RESULT_STATUS_INCOMPLETE', content: { results: flightData('150', 'PRICE_UNIT_WHOLE') } },
    { status: 'RESULT_STATUS_INCOMPLETE', action: 'RESULT_ACTION_REPLACED', content: { results: flightData('120', 'PRICE_UNIT_WHOLE') } },
    { status: 'RESULT_STATUS_COMPLETE', action: 'RESULT_ACTION_NOT_MODIFIED', content: { results: {} } },
  ];
  const response = await searchFlights(input, { SKYSCANNER_API_KEY: 'test-secret' }, { sleep: async () => {}, fetcher: async (url, init) => { calls.push({ url, init }); return Response.json(responses.shift()); } });
  assert.equal(response.provider.status, 'ok');
  assert.equal(response.journeys[0].price.amount, 120);
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /token%2Funsafe%3F$/);
  const query = JSON.parse(calls[0].init.body).query;
  assert.equal(query.adults, 2);
  assert.equal(query.cabinClass, 'CABIN_CLASS_ECONOMY');
  assert.deepEqual(query.queryLegs[0].date, { year: 2026, month: 10, day: 15 });
  assert.equal(JSON.stringify(response).includes('test-secret'), false);
});

test('empty replacement removes obsolete flights; polling failure preserves clearly partial quotes', async () => {
  let call = 0;
  const deps = { sleep: async () => {}, fetcher: async () => Response.json(++call === 1
    ? { sessionToken: 'abc', status: 'RESULT_STATUS_INCOMPLETE', content: { results: flightData() } }
    : { status: 'RESULT_STATUS_COMPLETE', action: 'RESULT_ACTION_REPLACED', content: { results: {} } }) };
  assert.deepEqual((await searchFlights(input, { SKYSCANNER_API_KEY: 'secret' }, deps)).journeys, []);
  call = 0;
  deps.fetcher = async () => { if (++call === 1) return Response.json({ sessionToken: 'abc', status: 'RESULT_STATUS_INCOMPLETE', content: { results: flightData() } }); throw new Error('secret in upstream failure'); };
  const partial = await searchFlights(input, { SKYSCANNER_API_KEY: 'secret' }, deps);
  assert.equal(partial.provider.status, 'partial');
  assert.equal(partial.journeys.length, 1);
  assert.equal(JSON.stringify(partial).includes('secret'), false);
});

test('unconfigured providers never make requests and failures do not reveal secrets', async () => {
  const fetcher = async () => { throw new Error('SHOULD_NOT_FETCH'); };
  assert.equal((await searchFlights(input, {}, { fetcher })).provider.status, 'not_configured');
  assert.equal((await searchRail(input, {}, { fetcher })).provider.status, 'not_configured');
  const result = await searchFlights(input, { SKYSCANNER_API_KEY: 'secret' }, { fetcher });
  assert.equal(result.provider.status, 'error');
  assert.equal(JSON.stringify(result).includes('SHOULD_NOT_FETCH'), false);
});

test('upstream response body is bounded and requests have abort deadlines', async () => {
  await assert.rejects(fetchProviderJson('https://provider.example', {}, async () => new Response('x', { headers: { 'content-length': '5000000' } })), (error) => error.status === 413);
  await assert.rejects(fetchProviderJson('https://provider.example', {}, async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), 5), (error) => error.code === 'provider_timeout');
});

test('rail preserves overnight dates, source attribution and null fares', () => {
  const result = normalizeRail(railData(), input);
  assert.equal(result.provider.status, 'ok');
  assert.equal(result.journeys[0].arrival, '2026-10-16T01:00:00');
  assert.equal(result.journeys[0].durationMinutes, 120);
  assert.equal(result.journeys[0].price, null);
  assert.equal(result.journeys[0].sources[0].license, 'CC0');
  assert.equal(result.provider.generatedAt, '2026-09-09T10:00:00Z');
  assert.equal(result.journeys[0].source.fetchedAt, '2026-09-09T10:00:00Z');
  assert.equal(result.journeys[0].source.name, 'Test public feed');
  assert.equal(result.journeys[0].source.url, 'https://transit.example/feed.zip');
  assert.equal(result.journeys[0].legs[0].mode, 'train');
});

test('stale/mismatched calendars and disallowed modes never become timetable answers', () => {
  assert.equal(normalizeRail({ ...railData(), calendar: { from: 20250101, days: 30 } }, input).provider.status, 'unavailable');
  assert.equal(normalizeRail({ ...railData(), date: 20261014 }, input).provider.code, 'invalid_provider_response');
  assert.equal(normalizeRail({ ...railData(), calendar: null }, input).provider.code, 'invalid_provider_response');
  assert.deepEqual(normalizeRail(railData(), { ...input, modes: ['bus'] }).journeys, []);
});

test('rail proxy sends exact date to only /api/search and optional edge fallback is used', async () => {
  let sent;
  const result = await searchRail(input, { RAIL_API_URL: 'https://rail.example/something?secret=no' }, { fetcher: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return Response.json(railData()); } });
  assert.equal(result.provider.status, 'ok');
  assert.equal(sent.url, 'https://rail.example/api/search');
  assert.equal(sent.body.date, 20261015);
  assert.equal(sent.body.departHour, 0);
  assert.equal((await searchRail(input, {}, { edgeRailSearch: async () => railData() })).provider.status, 'ok');
});

test('a broken cheapest booking option cannot hide a valid complete fare', () => {
  const data = flightData('80', 'PRICE_UNIT_WHOLE');
  data.itineraries.flight1.pricingOptions[0].items = [];
  data.itineraries.flight1.pricingOptions.push({ price: { amount: '95', unit: 'PRICE_UNIT_WHOLE' }, items: [{ agentId: 'airline1', deepLink: 'https://airline.example/complete' }] });
  const [journey] = normalizeFlights(data, input);
  assert.equal(journey.price.amount, 95);
  assert.equal(journey.bookingUrl, 'https://airline.example/complete');
});

test('intermediate flight airports never inherit origin or destination coordinates', () => {
  const data = flightData();
  data.places.vie = { name: 'Vienna', iata: 'VIE' };
  data.legs.leg1.segmentIds = ['s1', 's2'];
  data.legs.leg1.stopCount = 1;
  data.segments.s1 = { ...data.segments.s1, destinationPlaceId: 'vie', arrivalDateTime: dt(13), durationInMinutes: 60 };
  data.segments.s2 = { ...data.segments.s1, originPlaceId: 'vie', destinationPlaceId: 'ber', departureDateTime: dt(13, 30), arrivalDateTime: dt(14), durationInMinutes: 60 };
  const [journey] = normalizeFlights(data, input);
  assert.equal(journey.legs[0].from.lat, input.from.lat);
  assert.equal(journey.legs[0].to.iata, 'VIE');
  assert.equal(journey.legs[0].to.lat, null);
  assert.equal(journey.legs[0].to.lon, null);
  assert.equal(journey.legs[1].from.lat, null);
  assert.equal(journey.legs[1].to.lat, input.to.lat);
});

test('incomplete or internally inconsistent flight segments are omitted', () => {
  const missing = flightData();
  delete missing.segments.s1;
  assert.deepEqual(normalizeFlights(missing, input), []);
  const wrongEndpoint = flightData();
  wrongEndpoint.segments.s1.originPlaceId = 'other';
  assert.deepEqual(normalizeFlights(wrongEndpoint, input), []);
  const wrongTime = flightData();
  wrongTime.segments.s1.arrivalDateTime = dt(15);
  assert.deepEqual(normalizeFlights(wrongTime, input), []);
  const wrongDuration = flightData();
  wrongDuration.segments.s1.durationInMinutes = 181;
  assert.deepEqual(normalizeFlights(wrongDuration, input), []);
});

test('malformed flight responses and provider rate limits have stable codes without leaking details', async () => {
  for (const invalid of [null, [], {}, { status: 'RESULT_STATUS_COMPLETE' }, { status: 'UNKNOWN', content: { results: {} } }]) {
    const response = await searchFlights(input, { SKYSCANNER_API_KEY: 'private-key' }, { fetcher: async () => Response.json(invalid) });
    assert.equal(response.provider.status, 'error');
    assert.equal(response.provider.code, 'invalid_provider_response');
    assert.deepEqual(response.journeys, []);
  }
  const response = await searchFlights(input, { SKYSCANNER_API_KEY: 'private-key' }, { fetcher: async () => new Response('Private upstream error', { status: 429 }) });
  assert.equal(response.provider.code, 'provider_rate_limited');
  assert.equal(JSON.stringify(response).includes('Private upstream'), false);
});

test('deadline during polling keeps verified quotes and stops further network work', async () => {
  const controller = new AbortController();
  let calls = 0;
  const response = await searchFlights(input, { SKYSCANNER_API_KEY: 'secret' }, {
    signal: controller.signal,
    fetcher: async () => { calls++; return Response.json({ sessionToken: 'session', status: 'RESULT_STATUS_INCOMPLETE', content: { results: flightData() } }); },
    sleep: async () => { controller.abort(new ApiError(504, 'provider_timeout', 'Search deadline')); },
  });
  assert.equal(calls, 1);
  assert.equal(response.provider.status, 'partial');
  assert.equal(response.provider.code, 'provider_timeout');
  assert.equal(response.journeys[0].price.amount, 129.5);
});

test('pre-cancelled and mid-flight requests abort even an adapter that ignores the signal', async () => {
  const pre = new AbortController();
  pre.abort();
  let calls = 0;
  await assert.rejects(fetchProviderJson('https://provider.example', { signal: pre.signal }, async () => { calls++; return Response.json({}); }), (error) => error.code === 'request_cancelled');
  assert.equal(calls, 0);
  const active = new AbortController();
  let providerSignal;
  const request = fetchProviderJson('https://provider.example', { signal: active.signal }, async (_url, init) => {
    providerSignal = init.signal;
    queueMicrotask(() => active.abort());
    return new Promise(() => {});
  });
  await assert.rejects(request, (error) => error.code === 'request_cancelled');
  assert.equal(providerSignal.aborted, true);
});

test('streamed bodies stop on caller cancellation and oversized bodies never await a stuck cancel hook', async () => {
  const controller = new AbortController();
  let bodyCancelled = false;
  const pending = readJsonLimited(new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })), 8192, 5000, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'request_cancelled');
  assert.equal(bodyCancelled, true);
  const oversized = new Response(new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array(10)); },
    cancel() { return new Promise(() => {}); },
  }));
  await assert.rejects(readJsonLimited(oversized, 5), (error) => error.code === 'body_too_large');
});

test('rail rejects malformed dates, departures on a different day and inconsistent leg boundaries', () => {
  for (const date of ['invalid', null, 20260230, 20261014]) {
    assert.equal(normalizeRail({ ...railData(), date }, input).provider.code, 'invalid_provider_response');
  }
  for (const mutate of [
    (journey) => { journey.legs[0].departMin++; },
    (journey) => { journey.legs[0].arriveMin--; },
    (journey) => { journey.departMin += 1440; journey.arriveMin += 1440; journey.legs[0].departMin += 1440; journey.legs[0].arriveMin += 1440; },
  ]) {
    const data = railData(); mutate(data.journeys[0]);
    const response = normalizeRail(data, input);
    assert.equal(response.provider.code, 'invalid_provider_response');
    assert.deepEqual(response.journeys, []);
  }
});

test('overlapping rail connections are omitted while valid journeys remain clearly partial', () => {
  const data = railData();
  const invalid = structuredClone(data.journeys[0]);
  invalid.legs[0].arriveMin = 1450;
  invalid.legs.push({ ...invalid.legs[0], departMin: 1440, arriveMin: 1500 });
  data.journeys.push(invalid);
  const response = normalizeRail(data, input);
  assert.equal(response.journeys.length, 1);
  assert.equal(response.provider.status, 'partial');
  assert.equal(response.provider.code, 'invalid_provider_response');
  assert.equal(response.journeys[0].price, null);
});
