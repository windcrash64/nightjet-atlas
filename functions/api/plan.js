/**
 * Cloudflare Pages Function: POST /api/plan
 *
 * Proxies journey queries to Transitous. This runs server-side for three
 * reasons: the User-Agent that Transitous's policy requires cannot be set from
 * a browser, responses can be cached at the edge to keep load off a volunteer
 * service, and the client never needs to know the upstream shape.
 *
 * Cloudflare free-tier budget this must live inside:
 *   10ms CPU per request (this is all I/O, so CPU is not the constraint)
 *   50 subrequests per request (we make exactly one)
 *   100,000 requests/day
 * https://developers.cloudflare.com/workers/platform/limits/
 */

const UPSTREAM = 'https://api.transitous.org/api/v6/plan';

// Transitous requires an identifying User-Agent with a means of contact.
// https://transitous.org/api/
const USER_AGENT =
  'NightjetAtlas/0.1 (+https://github.com/windcrash64/nightjet-atlas)';

const MODE_GROUPS = {
  rail: ['RAIL'],
  bus: ['BUS', 'COACH'],
  ferry: ['FERRY'],
  metro: ['SUBWAY', 'TRAM'],
};

function bad(message, status = 400) {
  return Response.json({ error: message }, { status });
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

export async function onRequestPost({ request, waitUntil, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad('Body must be JSON.');
  }

  const { from, to, departAt, modes } = body ?? {};

  if (!from || !to || !isFiniteNumber(from.lat) || !isFiniteNumber(from.lon)
      || !isFiniteNumber(to.lat) || !isFiniteNumber(to.lon)) {
    return bad('from and to must each be {lat, lon} numbers.');
  }
  if (Math.abs(from.lat) > 90 || Math.abs(to.lat) > 90
      || Math.abs(from.lon) > 180 || Math.abs(to.lon) > 180) {
    return bad('Coordinates out of range.');
  }

  const when = departAt ? new Date(departAt) : new Date();
  if (Number.isNaN(when.getTime())) return bad('departAt is not a valid date.');

  const selected = Array.isArray(modes) && modes.length ? modes : ['rail'];
  const transitModes = [...new Set(selected.flatMap((m) => MODE_GROUPS[m] ?? []))];
  if (!transitModes.length) return bad('No valid transit modes selected.');

  const url = new URL(UPSTREAM);
  url.searchParams.set('fromPlace', `${from.lat},${from.lon}`);
  url.searchParams.set('toPlace', `${to.lat},${to.lon}`);
  url.searchParams.set('time', when.toISOString());
  url.searchParams.set('transitModes', transitModes.join(','));
  url.searchParams.set('numItineraries', '6');
  // Long enough to admit a 25h Naples->Amsterdam sleeper, bounded so a
  // pathological query cannot ask the upstream for the world.
  url.searchParams.set('maxTravelTime', '1800');
  url.searchParams.set('arriveBy', 'false');

  // Edge cache. Transitous publishes no rate limit, which means there is no
  // quota to engineer against — so we simply ask it as little as possible.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const payload = await cached.json();
    return Response.json({ ...payload, cached: true });
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    // Honest failure. We do not synthesise a journey when routing is down.
    return Response.json(
      { error: 'The routing service did not respond.', upstream: 'transitous', retryable: true },
      { status: 503 },
    );
  }

  if (!upstream.ok) {
    return Response.json(
      { error: `Routing service returned ${upstream.status}.`, upstream: 'transitous', retryable: upstream.status >= 500 },
      { status: 502 },
    );
  }

  const data = await upstream.json();
  const payload = {
    itineraries: data.itineraries ?? [],
    fetchedAt: new Date().toISOString(),
    source: 'transitous',
    cached: false,
  };

  const toCache = Response.json(payload, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
  waitUntil(cache.put(cacheKey, toCache.clone()));

  return Response.json(payload);
}
