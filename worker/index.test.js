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
