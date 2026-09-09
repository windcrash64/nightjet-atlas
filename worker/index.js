import { ApiError, cancelled, readJsonLimited, throwIfAborted, validatePlan, withSignal } from './validation.js';
import { searchFlights, searchRail } from './providers.js';
import { edgeRailSearch } from './edge-rail.js';

const responseHeaders = {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin', vary: 'Accept',
};
const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), { status, headers: { ...responseHeaders, ...extraHeaders } });

function searchScope(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new ApiError(504, 'provider_timeout', 'The search reached its time limit.')), timeoutMs);
  return { controller, signal: controller.signal, cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

async function providerResult(id, run) {
  try {
    const value = await run();
    if (value?.provider?.id !== id || !Array.isArray(value.journeys) || !['ok', 'empty', 'partial', 'error', 'unavailable', 'not_configured'].includes(value.provider.status)) throw new Error('Invalid adapter response');
    return value;
  } catch {
    return { provider: { id, status: 'error', code: 'invalid_provider_response', message: 'This transport provider could not complete the search.' }, journeys: [] };
  }
}

function streamSearch(input, providers, scope) {
  const encoder = new TextEncoder();
  let closed = false;
  let onAbort;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event) => { if (!closed) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')); };
      const close = () => { if (!closed) { closed = true; controller.close(); } };
      onAbort = () => { if (scope.signal.reason?.code === 'request_cancelled') close(); };
      scope.signal.addEventListener('abort', onAbort);
      onAbort();
      send({ type: 'start', query: input });
      // Each supplier publishes independently; rail results need not wait for flights.
      void Promise.all(providers.map(async ({ id, run }) => {
        const value = await providerResult(id, run);
        if (scope.signal.reason?.code !== 'request_cancelled') send({ type: 'provider', ...value });
      })).then(() => {
        send({ type: 'complete', searchedAt: new Date().toISOString() });
        close();
      }).catch(() => {
        // An encoding/stream failure must still end the response and stop upstream work.
        close();
        scope.controller.abort(cancelled());
      }).finally(() => {
        scope.signal.removeEventListener('abort', onAbort);
        scope.cleanup();
      });
    },
    cancel() {
      closed = true;
      scope.controller.abort(cancelled());
      scope.signal.removeEventListener('abort', onAbort);
      scope.cleanup();
    },
  });
  return new Response(stream, { headers: { ...responseHeaders, 'content-type': 'application/x-ndjson; charset=utf-8' } });
}

/** Exported separately so Node tests exercise the real HTTP handler with mocked providers. */
export async function handleRequest(request, env = {}, deps = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  }
  if (url.pathname === '/api/health') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed', message: 'Use GET for health.' }, 405, { allow: 'GET' });
    return json({ ok: true, service: 'Travel Freely', buildId: typeof env.BUILD_ID === 'string' ? env.BUILD_ID : null, providers: [
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
    throwIfAborted(request.signal);
    if (env.SEARCH_RATE_LIMITER) {
      let success;
      const rateScope = searchScope(request.signal, 3000);
      try { ({ success } = await withSignal(() => env.SEARCH_RATE_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' }), rateScope.signal)); }
      catch {
        throwIfAborted(request.signal);
        throw new ApiError(503, 'rate_limit_unavailable', 'Search is temporarily unavailable. Please try again shortly.');
      } finally { rateScope.cleanup(); }
      if (!success) return json({ error: 'rate_limited', message: 'A few too many searches. Please try again in a minute.' }, 429, { 'retry-after': '60' });
    }
    const input = validatePlan(await readJsonLimited(request), deps.now || new Date());
    throwIfAborted(request.signal);
    // Test dependencies may shorten the deadline; public requests cannot extend it.
    const timeoutMs = Number.isFinite(deps.searchTimeoutMs) ? Math.max(1, Math.min(deps.searchTimeoutMs, 12_000)) : 12_000;
    const scope = searchScope(request.signal, timeoutMs);
    const providerDeps = { ...deps, signal: scope.signal };
    const providers = [];
    if (input.modes.includes('plane')) providers.push({ id: 'skyscanner', run: () => searchFlights(input, env, providerDeps) });
    if (input.modes.some((mode) => mode !== 'plane')) providers.push({ id: 'rail', run: () => searchRail(input, env, { ...providerDeps, edgeRailSearch: deps.edgeRailSearch || edgeRailSearch }) });
    const streaming = (request.headers.get('accept') || '').split(',').some((value) => /^application\/x-ndjson(?:\s*;|$)/i.test(value.trim()) && !/;\s*q=0(?:\.0*)?(?:\s*;|$)/i.test(value));
    if (streaming) return streamSearch(input, providers, scope);
    try {
      const results = await Promise.all(providers.map(({ id, run }) => providerResult(id, run)));
      if (scope.signal.reason?.code === 'request_cancelled') throw cancelled();
      return json({ query: input, providers: results.map((entry) => entry.provider), journeys: results.flatMap((entry) => entry.journeys), searchedAt: new Date().toISOString() });
    } finally { scope.cleanup(); }
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: 'search_failed', message: 'The search could not be completed. Please try again.' }, 500);
  }
}

export default { fetch(request, env) { return handleRequest(request, env); } };
