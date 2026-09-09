import { ApiError, readJsonLimited, validatePlan } from './validation.js';
import { searchFlights, searchRail } from './providers.js';
import { edgeRailSearch } from './edge-rail.js';

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', ...extraHeaders,
  } });
}

/** Exported separately so Node tests exercise the real HTTP handler with mocked providers. */
export async function handleRequest(request, env = {}, deps = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  }
  if (url.pathname === '/api/health') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed', message: 'Use GET for health.' }, 405, { allow: 'GET' });
    return json({ ok: true, service: 'Travel Freely', providers: [
      { id: 'skyscanner', configured: Boolean(env.SKYSCANNER_API_KEY), status: env.SKYSCANNER_API_KEY ? 'configured' : 'not_configured' },
      { id: 'rail', configured: true, status: env.RAIL_API_URL ? 'configured' : 'bundled_timetable', runtime: env.RAIL_API_URL ? 'external' : 'cloudflare' },
    ] });
  }
  // No general proxy: in particular, /api/reload is never reachable through this Worker.
  if (url.pathname !== '/api/plan') return json({ error: 'not_found', message: 'This API route does not exist.' }, 404);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed', message: 'Use POST to search for a journey.' }, 405, { allow: 'POST' });
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'cross_origin', message: 'Start this search from Travel Freely.' }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return json({ error: 'unsupported_media_type', message: 'Send this request as application/json.' }, 415);
  }
  try {
    if (env.SEARCH_RATE_LIMITER) {
      const { success } = await env.SEARCH_RATE_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
      if (!success) return json({ error: 'rate_limited', message: 'A few too many searches. Please try again in a minute.' }, 429, { 'retry-after': '60' });
    }
    const input = validatePlan(await readJsonLimited(request), deps.now || new Date());
    const providers = [];
    if (input.modes.includes('plane')) providers.push(searchFlights(input, env, deps));
    if (input.modes.some((mode) => mode !== 'plane')) providers.push(searchRail(input, env, { ...deps, edgeRailSearch: deps.edgeRailSearch || edgeRailSearch }));
    const settled = await Promise.allSettled(providers);
    const results = settled.map((entry, index) => entry.status === 'fulfilled' ? entry.value : ({
      provider: { id: input.modes.includes('plane') && index === 0 ? 'skyscanner' : 'rail', status: 'error', message: 'This transport provider could not complete the search.' }, journeys: [],
    }));
    return json({ query: input, providers: results.map((entry) => entry.provider), journeys: results.flatMap((entry) => entry.journeys), searchedAt: new Date().toISOString() });
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: 'search_failed', message: 'The search could not be completed. Please try again.' }, 500);
  }
}

export default { fetch(request, env) { return handleRequest(request, env); } };
