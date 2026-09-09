const PROVIDERS = {
  skyscanner: { label: 'Flights', modes: ['plane'], message: 'Checking flight fares…' },
  rail: { label: 'Trains & local transport', modes: ['train', 'bus', 'metro'], message: 'Checking published timetables…' },
};
const TERMINAL = new Set(['ok', 'empty', 'partial', 'error', 'unavailable', 'not_configured', 'cancelled']);
const MODES = new Set(['plane', 'train', 'bus', 'metro', 'walk']);
const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT = 20_000;

export class SearchError extends Error {
  constructor(code, message, retryAfter = 0) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function tripKey({ from, to, date, adults = 1 }) {
  const place = (p) => [p?.name, p?.lat, p?.lon, p?.iata || null];
  return JSON.stringify([place(from), place(to), date, adults]);
}

export function providerIds(query) {
  const modes = query.modes || ['plane', 'train', 'bus', 'metro'];
  return Object.entries(PROVIDERS).filter(([, p]) => p.modes.some((mode) => modes.includes(mode))).map(([id]) => id);
}

const badResponse = () => new SearchError('invalid_response', 'The search service returned an incomplete response. Try again.');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validText = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;
const optionalText = (value, max = 500) => value == null || typeof value === 'string' && value.length <= max;
const validDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value)
  && validDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const localTime = (value) => validTime(value) && value.length === 19;
const bounded = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
export const hasMapCoordinates = (place) => record(place) && bounded(place.lat, -90, 90) && bounded(place.lon, -180, 180);
const validPlace = (place) => record(place) && validText(place.name) && (place.lat == null || bounded(place.lat, -90, 90))
  && (place.lon == null || bounded(place.lon, -180, 180)) && (place.iata == null || typeof place.iata === 'string' && /^[A-Z]{3}$/.test(place.iata));
const optionalArray = (value, check, max = 40) => value == null || Array.isArray(value) && value.length <= max && value.every(check);
const publicLink = (value) => {
  if (value == null) return true;
  if (!validText(value, 8192)) return false;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '');
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && host.includes('.') && !host.includes(':') && !/^[\d.]+$/.test(host) && !/\.(?:local|localhost|internal)$/.test(host);
  } catch { return false; }
};
const validSource = (source) => record(source)
  && ['id', 'name', 'publisher', 'attribution', 'license', 'licence', 'coverage', 'retrievedAt', 'updatedAt', 'fetchedAt', 'generatedAt'].every((key) => optionalText(source[key]))
  && ['url', 'licenceUrl', 'licenseUrl'].every((key) => publicLink(source[key]))
  && optionalArray(source.timezones, (zone) => validText(zone, 60), 10);

/** Unknown positions stay unknown; map consumers never coerce null into zero. */
export function journeyMapLegs(journey) {
  return (Array.isArray(journey?.legs) ? journey.legs.slice(0, 30) : [])
    .filter((leg) => leg && leg.mode !== 'walk' && hasMapCoordinates(leg.from) && hasMapCoordinates(leg.to));
}

export function journeyMapStops(journey) {
  const seen = new Set();
  return (Array.isArray(journey?.legs) ? journey.legs.slice(0, 30) : []).flatMap((leg) => [leg?.from, leg?.to])
    .filter((place) => { if (!hasMapCoordinates(place)) return false; const key = `${place.lat},${place.lon}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

function sameQuery(actual, expected) {
  if (!record(actual) || !record(actual.from) || !record(actual.to) || !Array.isArray(actual.modes)
    || actual.modes.some((mode) => !MODES.has(mode) || mode === 'walk') || new Set(actual.modes).size !== actual.modes.length) return false;
  const signature = (value) => JSON.stringify([
    ...[value.from, value.to].map((place) => [place?.name?.trim(), place?.lat, place?.lon, place?.iata || null]),
    value.date, value.adults ?? 1, value.cabin ?? 'economy', [...(value.modes || ['plane', 'train', 'bus', 'metro'])].sort(),
  ]);
  return validText(actual.from.name) && validText(actual.to.name) && signature(actual) === signature(expected);
}

// Check the data boundary before it reaches rendering, currency formatting or
// the map. A broken response must not crash the whole planner.
function validJourney(j, provider, query) {
  return record(j) && validText(j.id) && j.provider === provider && MODES.has(j.mode) && j.mode !== 'walk'
    && bounded(j.durationMinutes, 1, 10080)
    && localTime(j.departure) && localTime(j.arrival) && validDay(j.date) && j.date === query.date && j.departure.slice(0, 10) === j.date
    && validPlace(j.from) && validPlace(j.to)
    && (j.price === null || (record(j.price) && bounded(j.price.amount, 0, 10_000_000) && typeof j.price.currency === 'string' && /^[A-Z]{3}$/.test(j.price.currency)
      && optionalText(j.price.basis) && (j.price.travelers == null || Number.isInteger(j.price.travelers) && bounded(j.price.travelers, 1, 8))))
    && (j.changes == null || Number.isInteger(j.changes) && bounded(j.changes, 0, 30))
    && ['timeBasis', 'fareStatus', 'transferType'].every((key) => optionalText(j[key]))
    && optionalArray(j.modes, (mode) => MODES.has(mode), 5) && optionalArray(j.operators, (operator) => validText(operator))
    && optionalArray(j.notes, (note) => validText(note)) && validSource(j.source) && optionalArray(j.sources, validSource)
    && publicLink(j.bookingUrl) && optionalArray(j.bookingLinks, (link) => record(link) && validText(link.url, 8192) && publicLink(link.url) && optionalText(link.agent), 30)
    && Array.isArray(j.legs) && j.legs.length > 0 && j.legs.length <= 30
    && j.legs.every((leg) => record(leg) && MODES.has(leg.mode) && validPlace(leg.from) && validPlace(leg.to)
      && optionalText(leg.service) && optionalText(leg.operator) && optionalText(leg.timeBasis)
      && (leg.durationMinutes == null || bounded(leg.durationMinutes, 0, 10080)) && localTime(leg.departure) && localTime(leg.arrival));
}

function providerEvent(value, allowed, query) {
  const provider = value?.provider;
  if (!provider || !allowed.includes(provider.id) || !TERMINAL.has(provider.status)
    || !optionalText(provider.message) || !validText(provider.message) || !optionalText(provider.code, 80)
    || !optionalText(provider.generatedAt) || !optionalArray(provider.sources, validSource)
    || !Array.isArray(value.journeys) || value.journeys.length > 500
    || value.journeys.some((j) => !validJourney(j, provider.id, query))) throw badResponse();
  const ids = new Set();
  const journeys = value.journeys.filter((j) => !ids.has(j.id) && ids.add(j.id));
  return { type: 'provider', provider, journeys };
}

function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return work(); }).then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error) => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

function retrySeconds(value) {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(1, Math.ceil(seconds))) : 0;
}

/** One search request, progressive provider results, bounded reads and lifetime. */
export async function searchPlan(query, { signal, fetcher = fetch, onEvent = () => {}, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const control = new AbortController();
  const abort = () => control.abort(signal.reason || new DOMException('Search stopped.', 'AbortError'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => control.abort(new SearchError('timeout', 'The search took too long. Results already received are still available.')), timeoutMs);
  let reader;
  let complete = false;
  let ended = false;
  try {
    const response = await abortable(async () => {
      const response = await fetcher('/api/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify(query), signal: control.signal,
      });
      if (control.signal.aborted) { void response.body?.cancel().catch(() => {}); throw control.signal.reason; }
      return response;
    }, control.signal);
    const contentType = response.headers.get('content-type') || '';
    if (!response.body) throw badResponse();
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, buffer = '', started = false;
    const allowed = providerIds(query);
    const received = new Set();
    const deliver = (value) => {
      if (!value || typeof value !== 'object' || complete) throw badResponse();
      if (value.type === 'start' && !started && sameQuery(value.query, query)) { started = true; onEvent(value); return; }
      if (!started) throw badResponse();
      if (value.type === 'provider' && !received.has(value.provider?.id)) {
        const event = providerEvent(value, allowed, query);
        received.add(event.provider.id);
        onEvent(event);
        return;
      }
      if (value.type === 'complete' && allowed.every((id) => received.has(id)) && validTime(value.searchedAt)) {
        complete = true;
        onEvent(value);
        return;
      }
      throw badResponse();
    };
    const streaming = response.ok && /^application\/(?:x-)?ndjson(?:\s*;|$)/i.test(contentType);
    if (response.ok && !streaming && !/^application\/json(?:\s*;|$)/i.test(contentType)) throw badResponse();
    while (true) {
      const { done, value } = await abortable(() => reader.read(), control.signal);
      if (done) { ended = true; buffer += decoder.decode(); break; }
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw badResponse();
      buffer += decoder.decode(value, { stream: true });
      if (streaming) {
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (line) deliver(JSON.parse(line));
        }
      }
    }
    if (!response.ok) {
      let body;
      try { body = JSON.parse(buffer); } catch { /* An edge error may be HTML. */ }
      const retryAfter = retrySeconds(response.headers.get('retry-after'));
      throw new SearchError(validText(body?.error, 80) ? body.error : `http_${response.status}`, response.status === 429
        ? 'Too many searches at once. Give it a moment, then try again.'
        : (typeof body?.message === 'string' ? body.message.slice(0, 500) : 'The search service is temporarily unavailable. Try again.'), retryAfter);
    }
    if (streaming) {
      if (buffer.trim()) deliver(JSON.parse(buffer));
    } else {
      // Compatible with earlier deployments and conventional JSON API clients.
      const body = JSON.parse(buffer);
      if (!record(body) || !Array.isArray(body.providers) || !Array.isArray(body.journeys) || body.journeys.length > allowed.length * 500
        || body.journeys.some((journey) => !record(journey) || !allowed.includes(journey.provider))) throw badResponse();
      deliver({ type: 'start', query: body.query });
      for (const provider of body.providers) deliver({ type: 'provider', provider, journeys: body.journeys.filter((j) => j.provider === provider.id) });
      deliver({ type: 'complete', searchedAt: body.searchedAt });
    }
    if (!complete) throw new SearchError('interrupted', 'The connection ended before every provider finished. Results already received are still available.');
  } catch (error) {
    if (control.signal.aborted) throw control.signal.reason;
    if (error instanceof SearchError) throw error;
    if (error instanceof SyntaxError || error instanceof TypeError && error.message.includes('encoded data')) throw badResponse();
    throw new SearchError('network_error', 'The search service could not be reached. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (reader) {
      if (!ended) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export const emptySearch = () => ({ status: 'idle', query: null, key: '', journeys: [], providers: [], message: '', searchedAt: null, retryAt: 0 });

/** Latest search wins; late completions cannot overwrite a new route or retry. */
export function createSearchController({ onState = () => {}, fetcher, timeoutMs } = {}) {
  let current = emptySearch(), generation = 0, control;
  const publish = (next) => { current = next; onState(next); };
  return {
    getState: () => current,
    cancel({ silent = false } = {}) {
      generation++;
      control?.abort(new DOMException('Search stopped.', 'AbortError'));
      if (!silent && current.status === 'loading') publish({ ...current, status: 'cancelled', message: 'Search stopped. Results already received are still available.',
        providers: current.providers.map((p) => p.status === 'loading' ? { ...p, status: 'cancelled', message: 'Search stopped.' } : p) });
    },
    async start(query, { retryProvider } = {}) {
      this.cancel({ silent: true });
      const token = generation;
      control = new AbortController();
      const key = tripKey(query);
      const retry = retryProvider && key === current.key && PROVIDERS[retryProvider];
      const body = retry ? { ...query, modes: PROVIDERS[retryProvider].modes } : query;
      const ids = providerIds(body);
      const loading = ids.map((id) => ({ id, status: 'loading', message: PROVIDERS[id].message }));
      publish({ ...emptySearch(), query, key, status: 'loading',
        journeys: retry ? current.journeys.filter((j) => !ids.includes(j.provider)) : [],
        providers: retry ? [...current.providers.filter((p) => !ids.includes(p.id)), ...loading] : loading });
      try {
        await searchPlan(body, { fetcher, timeoutMs, signal: control.signal, onEvent(event) {
          if (token !== generation) return;
          if (event.type === 'provider') publish({ ...current,
            providers: current.providers.map((p) => p.id === event.provider.id ? event.provider : p),
            journeys: [...current.journeys.filter((j) => j.provider !== event.provider.id), ...event.journeys] });
          if (event.type === 'complete') publish({ ...current, status: 'done', searchedAt: event.searchedAt });
        } });
      } catch (error) {
        if (token !== generation) return;
        const stopped = error?.name === 'AbortError';
        publish({ ...current, status: stopped ? 'cancelled' : 'error', message: error?.message || 'Search failed. Try again.',
          retryAt: error?.retryAfter ? Date.now() + error.retryAfter * 1000 : 0,
          providers: current.providers.map((p) => p.status === 'loading' ? { ...p, status: stopped ? 'cancelled' : 'error', code: error?.code || 'network_error', message: error?.message || 'Search failed.' } : p) });
      }
    },
  };
}
