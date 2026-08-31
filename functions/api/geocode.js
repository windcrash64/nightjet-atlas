/**
 * Cloudflare Pages Function: GET /api/geocode?q=...
 *
 * Turns typed place names into coordinates using Transitous's geocoder, so the
 * app accepts "Vienna" rather than forcing a dropdown of cities we chose.
 */

const UPSTREAM = 'https://api.transitous.org/api/v1/geocode';
const USER_AGENT =
  'NightjetAtlas/0.1 (+https://github.com/windcrash64/nightjet-atlas)';

export async function onRequestGet({ request, waitUntil }) {
  const q = new URL(request.url).searchParams.get('q')?.trim();
  if (!q || q.length < 2) {
    return Response.json({ places: [] });
  }

  const url = new URL(UPSTREAM);
  url.searchParams.set('text', q);

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return Response.json({ error: 'Place search is unavailable.', places: [] }, { status: 503 });
  }
  if (!upstream.ok) {
    return Response.json({ error: 'Place search is unavailable.', places: [] }, { status: 502 });
  }

  const raw = await upstream.json();
  const places = (Array.isArray(raw) ? raw : [])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .slice(0, 8)
    .map((p) => ({
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      type: p.type ?? null,
      area: p.areas?.find((a) => a.adminLevel <= 4)?.name ?? p.areas?.[0]?.name ?? null,
    }));

  const res = Response.json({ places }, {
    headers: { 'Cache-Control': 'public, max-age=86400' },
  });
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
