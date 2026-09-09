export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
export const shortText = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null;

export const cancelled = () => new ApiError(499, 'request_cancelled', 'This search was cancelled.');
export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof ApiError ? signal.reason : cancelled();
}

/** Also bounds adapters that do not settle their promise when the signal aborts. */
export function withSignal(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); try { throwIfAborted(signal); } catch (error) { reject(error); } };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { throwIfAborted(signal); return work(); }).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); try { throwIfAborted(signal); } catch (error) { reject(error); } };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function city(value, field) {
  if (!isObject(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120
    || /[\u0000-\u001f\u007f]/.test(value.name) || !finite(value.lat, -90, 90) || !finite(value.lon, -180, 180)) {
    throw new ApiError(400, 'invalid_city', `${field} must contain a name and valid numeric latitude and longitude.`);
  }
  if (value.iata !== undefined && (typeof value.iata !== 'string' || !/^[A-Z]{3}$/.test(value.iata))) {
    throw new ApiError(400, 'invalid_iata', `${field}.iata must be a three-letter uppercase airport or city code.`);
  }
  return { name: value.name.trim(), lat: value.lat, lon: value.lon, ...(value.iata ? { iata: value.iata } : {}) };
}

export function dateEpoch(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value ? epoch : null;
}

export function validatePlan(body, now = new Date()) {
  if (!isObject(body)) throw new ApiError(400, 'invalid_request', 'Send a JSON object with your route and travel date.');
  const from = city(body.from, 'from');
  const to = city(body.to, 'to');
  if (from.lat === to.lat && from.lon === to.lon) {
    throw new ApiError(400, 'same_place', 'Choose a different destination.');
  }
  const day = dateEpoch(body.date);
  const today = dateEpoch(now.toISOString().slice(0, 10));
  if (day === null || day < today || day > today + 365 * 86_400_000) {
    throw new ApiError(400, 'invalid_date', 'Choose a real date from today through the next 365 days.');
  }
  const adults = body.adults === undefined ? 1 : body.adults;
  if (!Number.isInteger(adults) || adults < 1 || adults > 8) throw new ApiError(400, 'invalid_adults', 'Choose between 1 and 8 adult travelers.');
  const cabin = body.cabin === undefined ? 'economy' : body.cabin;
  if (!['economy', 'premium_economy', 'business', 'first'].includes(cabin)) throw new ApiError(400, 'invalid_cabin', 'Choose a supported cabin class.');
  const modes = body.modes === undefined ? ['plane', 'train', 'bus', 'metro'] : body.modes;
  if (!Array.isArray(modes) || !modes.length || modes.length > 4 || modes.some((mode) => !['plane', 'train', 'bus', 'metro'].includes(mode)) || new Set(modes).size !== modes.length) {
    throw new ApiError(400, 'invalid_modes', 'Choose at least one of plane, train, bus, or metro, without duplicates.');
  }
  return { from, to, date: body.date, adults, cabin, modes };
}

/** Bounded streaming reads protect the Worker from both client and upstream bodies. */
export async function readJsonLimited(message, maxBytes = 8192, timeoutMs = 5000, signal = message.signal) {
  throwIfAborted(signal);
  const declared = message.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    void message.body?.cancel().catch(() => {});
    throw new ApiError(413, 'body_too_large', 'The request or provider response is too large.');
  }
  if (!message.body) throw new ApiError(400, 'invalid_json', 'A JSON body is required.');
  const reader = message.body.getReader();
  const chunks = [];
  let size = 0;
  let interrupted;
  const stop = (error) => { interrupted = error; void reader.cancel().catch(() => {}); };
  const onAbort = () => { try { throwIfAborted(signal); } catch (error) { stop(error); } };
  const timer = setTimeout(() => stop(new ApiError(408, 'body_timeout', 'The request or provider response took too long to arrive.')), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new ApiError(413, 'body_too_large', 'The request or provider response is too large.');
      }
      chunks.push(value);
    }
  } catch (error) {
    throw interrupted || (error instanceof ApiError ? error : new ApiError(400, 'invalid_json', 'The JSON body could not be read.'));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  if (interrupted) throw interrupted;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'invalid_json', 'The JSON body could not be read.'); }
}

/** Only direct public HTTPS links supplied by a provider are returned to browsers. */
export function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    // Booking providers use public DNS names. IP literals and local-only names are never useful here.
    if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal')
      || host.includes(':') || /^[\d.]+$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}

export function localDateTime(parts) {
  if (!isObject(parts)) return null;
  const { year, month, day, hour, minute, second = 0 } = parts;
  if (![year, month, day, hour, minute, second].every(Number.isInteger) || year < 2000 || year > 2200
    || !finite(hour, 0, 23) || !finite(minute, 0, 59) || !finite(second, 0, 59)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${year}-${pad(month)}-${pad(day)}`;
  return dateEpoch(date) === null ? null : `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}
