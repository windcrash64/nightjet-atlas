import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './index.js';

const now = new Date('2026-09-09T12:00:00Z');
const payload = { from: { name: 'Berlin', lat: 52.52, lon: 13.405, iata: 'BER' }, to: { name: 'Munich', lat: 48.137, lon: 11.575, iata: 'MUC' }, date: '2026-09-10', adults: 1, cabin: 'economy', modes: ['plane', 'train', 'bus', 'metro'] };
const request = (body = payload, headers = {}) => new Request('https://travel.example/api/plan', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('health reports configuration without secrets or upstream locations', async () => {
  const response = await handleRequest(new Request('https://travel.example/api/health'), { SKYSCANNER_API_KEY: 'VERY_SECRET', RAIL_API_URL: 'https://private-upstream.example' });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes('VERY_SECRET'), false);
  assert.equal(text.includes('private-upstream'), false);
  assert.equal(JSON.parse(text).providers[0].configured, true);
});

test('only explicit routes and methods are exposed; foreign websites cannot start searches', async () => {
  assert.equal((await handleRequest(new Request('https://travel.example/api/reload', { method: 'POST' }))).status, 404);
  assert.equal((await handleRequest(new Request('https://travel.example/api/search', { method: 'POST' }))).status, 404);
  assert.equal((await handleRequest(new Request('https://travel.example/api/plan'))).status, 405);
  assert.equal((await handleRequest(request(payload, { origin: 'https://foreign.example' }))).status, 403);
  assert.equal((await handleRequest(request(payload, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await handleRequest(request({ ...payload, date: '2026-02-30' }), {}, { now })).status, 400);
});

test('rate binding limits requests before any upstream search', async () => {
  const response = await handleRequest(request(), { SEARCH_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
});

test('bundled real rail search survives an unconfigured flight provider', async () => {
  const response = await handleRequest(request(), {}, { now });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.providers.find((provider) => provider.id === 'skyscanner').status, 'not_configured');
  assert.equal(body.providers.find((provider) => provider.id === 'rail').status, 'ok');
  assert.ok(body.journeys.length > 0);
  for (const journey of body.journeys) {
    assert.equal(journey.provider, 'rail');
    assert.equal(journey.price, null);
    assert.ok(journey.durationMinutes > 0);
    assert.ok(journey.sources.length > 0);
    assert.equal(journey.sources[0].licence, 'CC-BY-4.0');
    assert.match(journey.sources[0].attribution, /DELFI/);
    assert.ok(journey.sources[0].updatedAt);
    assert.equal(journey.date, payload.date);
  }
});

test('upstream flight failure is isolated from the bundled timetable', async () => {
  const response = await handleRequest(request(), { SKYSCANNER_API_KEY: 'secret' }, { now, fetcher: async () => { throw new Error('upstream problem secret'); } });
  const body = await response.json();
  assert.equal(body.providers.find((provider) => provider.id === 'skyscanner').status, 'error');
  assert.equal(body.providers.find((provider) => provider.id === 'rail').status, 'ok');
  assert.ok(body.journeys.length);
  assert.equal(JSON.stringify(body).includes('secret'), false);
});

test('non-API requests pass through to the static assets binding', async () => {
  const response = await handleRequest(new Request('https://travel.example/saved'), { ASSETS: { fetch: async (req) => new Response(new URL(req.url).pathname) } });
  assert.equal(await response.text(), '/saved');
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function events(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return { reader, async next() {
    while (!buffer.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) { assert.equal(buffer, ''); return null; }
      buffer += decoder.decode(value, { stream: true });
    }
    const end = buffer.indexOf('\n');
    const event = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    return event;
  } };
}

test('streaming publishes real rail before a pending flight provider and checks the rate once', async () => {
  const flight = deferred();
  let rateChecks = 0;
  const response = await handleRequest(request(payload, { accept: 'application/x-ndjson', 'cf-connecting-ip': '192.0.2.1' }), {
    SKYSCANNER_API_KEY: 'secret', SEARCH_RATE_LIMITER: { limit: async ({ key }) => { assert.equal(key, '192.0.2.1'); rateChecks++; return { success: true }; } },
  }, { now, fetcher: () => flight.promise });
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('vary'), 'Accept');
  const stream = events(response);
  assert.deepEqual(await stream.next(), { type: 'start', query: payload });
  const rail = await stream.next();
  assert.equal(rail.type, 'provider');
  assert.equal(rail.provider.id, 'rail');
  assert.equal(rail.provider.status, 'ok');
  assert.ok(rail.journeys.length);
  flight.resolve(Response.json({ status: 'RESULT_STATUS_COMPLETE', content: { results: {} } }));
  const flights = await stream.next();
  assert.equal(flights.provider.id, 'skyscanner');
  assert.equal(flights.provider.status, 'empty');
  assert.equal((await stream.next()).type, 'complete');
  assert.equal(await stream.next(), null);
  assert.equal(rateChecks, 1);
});

test('streaming validation and throttling failures remain ordinary structured JSON', async () => {
  let searches = 0;
  const response = await handleRequest(request({ ...payload, date: '2026-02-30' }, { accept: 'application/x-ndjson' }), {}, { now, fetcher: async () => { searches++; } });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal((await response.json()).error, 'invalid_date');
  const limited = await handleRequest(request(payload, { accept: 'application/x-ndjson' }), { SEARCH_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, 'rate_limited');
  assert.equal(searches, 0);
});

test('malformed flight JSON produces an isolated provider error event and still completes', async () => {
  const response = await handleRequest(request(payload, { accept: 'application/x-ndjson' }), { SKYSCANNER_API_KEY: 'secret' }, { now, fetcher: async () => Response.json(null) });
  const records = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(records[0].type, 'start');
  assert.equal(records.at(-1).type, 'complete');
  const providers = records.filter((event) => event.type === 'provider');
  assert.equal(providers.length, 2);
  const flight = providers.find((event) => event.provider.id === 'skyscanner');
  assert.equal(flight.provider.status, 'error');
  assert.equal(flight.provider.code, 'invalid_provider_response');
  assert.ok(providers.find((event) => event.provider.id === 'rail').journeys.length);
  assert.equal(JSON.stringify(records).includes('secret'), false);
});

test('cancelling a response stream aborts an active provider request', async () => {
  const started = deferred();
  const aborted = deferred();
  const response = await handleRequest(request(payload, { accept: 'application/x-ndjson' }), { SKYSCANNER_API_KEY: 'secret' }, {
    now, fetcher: async (_url, { signal }) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      return new Promise(() => {});
    },
  });
  const stream = events(response);
  await stream.next();
  await started.promise;
  await stream.reader.cancel();
  await aborted.promise;
});

test('cancelling during the flight poll delay starts no later poll', async () => {
  const sleeping = deferred();
  const aborted = deferred();
  let calls = 0;
  const response = await handleRequest(request(payload, { accept: 'application/x-ndjson' }), { SKYSCANNER_API_KEY: 'secret' }, {
    now,
    fetcher: async () => { calls++; return Response.json({ sessionToken: 'private-session', status: 'RESULT_STATUS_INCOMPLETE', content: { results: {} } }); },
    sleep: (_ms, signal) => { sleeping.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true }); return new Promise(() => {}); },
  });
  const stream = events(response);
  await stream.next();
  await sleeping.promise;
  await stream.reader.cancel();
  await aborted.promise;
  assert.equal(calls, 1);
});

test('the shared deadline finishes a stream even if a provider ignores its abort signal', async () => {
  const response = await handleRequest(request(payload, { accept: 'application/x-ndjson' }), { SKYSCANNER_API_KEY: 'secret' }, {
    now, searchTimeoutMs: 25, fetcher: () => new Promise(() => {}),
  });
  const stream = events(response);
  assert.equal((await stream.next()).type, 'start');
  const rail = await stream.next();
  assert.equal(rail.provider.id, 'rail');
  assert.ok(rail.journeys.length);
  const flight = await stream.next();
  assert.equal(flight.provider.code, 'provider_timeout');
  assert.equal(flight.provider.status, 'error');
  assert.equal((await stream.next()).type, 'complete');
  assert.equal(await stream.next(), null);
});

test('request cancellation produces structured 499 in the JSON path without exposing abort reasons', async () => {
  const controller = new AbortController();
  const started = deferred();
  const req = new Request('https://travel.example/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
  const pending = handleRequest(req, { SKYSCANNER_API_KEY: 'secret' }, { now, fetcher: async () => { started.resolve(); return new Promise(() => {}); } });
  await started.promise;
  controller.abort(new Error('private cancellation detail'));
  const response = await pending;
  assert.equal(response.status, 499);
  assert.deepEqual(await response.json(), { error: 'request_cancelled', message: 'This search was cancelled.' });
});

test('incoming request cancellation closes its NDJSON stream and aborts upstream work', async () => {
  const controller = new AbortController();
  const started = deferred();
  let upstreamSignal;
  const req = new Request('https://travel.example/api/plan', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify(payload), signal: controller.signal });
  const response = await handleRequest(req, { SKYSCANNER_API_KEY: 'secret' }, { now, fetcher: async (_url, { signal }) => { upstreamSignal = signal; started.resolve(); return new Promise(() => {}); } });
  const stream = events(response);
  assert.equal((await stream.next()).type, 'start');
  assert.equal((await stream.next()).provider.id, 'rail');
  await started.promise;
  controller.abort();
  assert.equal(await stream.next(), null);
  assert.equal(upstreamSignal.aborted, true);
});

test('cancelling during a stalled rate check returns immediately without searching', async () => {
  const controller = new AbortController();
  const started = deferred();
  let searched = false;
  const req = new Request('https://travel.example/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
  const pending = handleRequest(req, { SEARCH_RATE_LIMITER: { limit: () => { started.resolve(); return new Promise(() => {}); } } }, { now, fetcher: async () => { searched = true; } });
  await started.promise;
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal((await response.json()).error, 'request_cancelled');
  assert.equal(searched, false);
});

test('a stalled timetable adapter also obeys the shared deadline', async () => {
  const response = await handleRequest(request({ ...payload, modes: ['train'] }), {}, { now, searchTimeoutMs: 5, edgeRailSearch: () => new Promise(() => {}) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.providers[0].status, 'error');
  assert.equal(body.providers[0].code, 'provider_timeout');
  assert.deepEqual(body.journeys, []);
});

test('rate binding failure is explicit and health includes only the public build id', async () => {
  const unavailable = await handleRequest(request(), { SEARCH_RATE_LIMITER: { limit: async () => { throw new Error('private binding details'); } } });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'rate_limit_unavailable', message: 'Search is temporarily unavailable. Please try again shortly.' });
  const health = await handleRequest(new Request('https://travel.example/api/health'), { BUILD_ID: 'verified-artifact', SKYSCANNER_API_KEY: 'secret' });
  assert.equal((await health.json()).buildId, 'verified-artifact');
});
