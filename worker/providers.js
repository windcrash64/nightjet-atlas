import { ApiError, dateEpoch, finite, isObject, localDateTime, readJsonLimited, safeUrl, shortText } from './validation.js';

const FLIGHTS_URL = 'https://partners.api.skyscanner.net/apiservices/v3/flights/live/search';
const MAX_PROVIDER_BODY = 4 * 1024 * 1024;
const PRICE_DIVISORS = { PRICE_UNIT_WHOLE: 1, PRICE_UNIT_CENTI: 100, PRICE_UNIT_MILLI: 1000, PRICE_UNIT_MICRO: 1_000_000 };
const result = (id, status, message, journeys = [], extra = {}) => ({ provider: { id, status, message, ...extra }, journeys });

export async function fetchProviderJson(url, init, fetcher = fetch, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new ApiError(502, response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable', 'The provider could not complete this search.');
    return await readJsonLimited(response, MAX_PROVIDER_BODY);
  } finally { clearTimeout(timer); }
}

function money(price, currency) {
  if (!isObject(price) || !Object.hasOwn(PRICE_DIVISORS, price.unit)) return null;
  if ((typeof price.amount !== 'string' && typeof price.amount !== 'number') || !/^\d+(\.\d+)?$/.test(String(price.amount))) return null;
  const amount = Number(price.amount) / PRICE_DIVISORS[price.unit];
  return finite(amount, 0.01, 10_000_000) ? { amount, currency } : null;
}

function flightPlace(place, fallback) {
  return {
    name: shortText(place?.name) || fallback?.name || 'Airport',
    iata: /^[A-Z]{3}$/.test(place?.iata) ? place.iata : fallback?.iata || null,
    lat: finite(place?.coordinates?.latitude, -90, 90) ? place.coordinates.latitude : fallback?.lat ?? null,
    lon: finite(place?.coordinates?.longitude, -180, 180) ? place.coordinates.longitude : fallback?.lon ?? null,
  };
}

function flightSegment(segment, data, from, to) {
  if (!isObject(segment) || !finite(segment.durationInMinutes, 1, 10_080)) return null;
  const departure = localDateTime(segment.departureDateTime);
  const arrival = localDateTime(segment.arrivalDateTime);
  if (!departure || !arrival) return null;
  const carrier = data.carriers?.[segment.marketingCarrierId];
  return { mode: 'plane', from: flightPlace(data.places?.[segment.originPlaceId], from), to: flightPlace(data.places?.[segment.destinationPlaceId], to), departure, arrival,
    durationMinutes: segment.durationInMinutes, operator: shortText(carrier?.name), service: shortText(segment.marketingFlightNumber, 20), timeBasis: 'airport_local' };
}

export function normalizeFlights(data, input, currency = 'EUR', fetchedAt = new Date().toISOString()) {
  if (!isObject(data?.itineraries)) return [];
  return Object.entries(data.itineraries).slice(0, 500).flatMap(([id, itinerary]) => {
    // This endpoint asks for a one-way journey, so only one-leg itineraries answer it.
    if (!Array.isArray(itinerary?.legIds) || itinerary.legIds.length !== 1) return [];
    const leg = data.legs?.[itinerary.legIds[0]];
    if (!isObject(leg) || !finite(leg.durationInMinutes, 1, 10_080)) return [];
    const departure = localDateTime(leg.departureDateTime);
    const arrival = localDateTime(leg.arrivalDateTime);
    if (!departure || !arrival || departure.slice(0, 10) !== input.date) return [];
    const options = (Array.isArray(itinerary.pricingOptions) ? itinerary.pricingOptions : []).flatMap((option) => {
      const price = money(option?.price, currency);
      if (!price) return [];
      const items = Array.isArray(option.items) ? option.items : [];
      const bookingLinks = items.map((item) => ({ url: safeUrl(item?.deepLink), agent: shortText(data.agents?.[item?.agentId]?.name) })).filter((item) => item.url);
      return [{ price, bookingLinks, completeBooking: items.length > 0 && items.length === bookingLinks.length, transferType: shortText(option.transferType, 64) }];
    }).sort((a, b) => a.price.amount - b.price.amount);
    if (!options.length) return [];
    const option = options[0];
    const from = flightPlace(data.places?.[leg.originPlaceId], input.from);
    const to = flightPlace(data.places?.[leg.destinationPlaceId], input.to);
    const segments = (Array.isArray(leg.segmentIds) ? leg.segmentIds : []).map((segmentId) => flightSegment(data.segments?.[segmentId], data, from, to));
    const legs = segments.length && segments.every(Boolean) ? segments : [{ mode: 'plane', from, to, departure, arrival, durationMinutes: leg.durationInMinutes, timeBasis: 'airport_local' }];
    return [{ id: `skyscanner:${shortText(id, 300)}`, provider: 'skyscanner', mode: 'plane', modes: ['plane'], from, to, date: input.date, departure, arrival,
      durationMinutes: leg.durationInMinutes, changes: Number.isInteger(leg.stopCount) && leg.stopCount >= 0 ? leg.stopCount : null,
      price: { ...option.price, basis: 'all_travelers', travelers: input.adults },
      bookingUrl: option.completeBooking && option.bookingLinks.length === 1 ? option.bookingLinks[0].url : null,
      bookingLinks: option.completeBooking ? option.bookingLinks : [], transferType: option.transferType,
      operators: (Array.isArray(leg.marketingCarrierIds) ? leg.marketingCarrierIds : []).map((carrierId) => shortText(data.carriers?.[carrierId]?.name)).filter(Boolean),
      baggage: { cabin: 'unknown', checked: 'unknown' }, fareStatus: 'live_quote', timeBasis: 'airport_local', legs,
      source: { name: 'Skyscanner Live Prices', url: 'https://www.skyscanner.net/', fetchedAt },
      notes: ['Airport-to-airport duration. Ground transfers are not included.', 'Price is for all selected travelers. Recheck the final price and baggage on the booking site.'],
    }];
  });
}

function mergeFlightResults(previous, response) {
  if (response.action === 'RESULT_ACTION_NOT_MODIFIED' || response.action === 'RESULT_ACTION_OMITTED') return previous;
  const incoming = response.content?.results;
  if (!isObject(incoming)) return previous;
  if (response.action === 'RESULT_ACTION_REPLACED') return incoming;
  const next = { ...previous };
  for (const [key, value] of Object.entries(incoming)) next[key] = isObject(value) ? { ...(previous?.[key] || {}), ...value } : value;
  return next;
}

export async function searchFlights(input, env, deps = {}) {
  if (!input.from.iata || !input.to.iata) return result('skyscanner', 'unavailable', 'Choose cities with an airport code to search live flights.');
  if (input.from.iata === input.to.iata) return result('skyscanner', 'unavailable', 'These places share the same airport. Compare ground transport for this route.');
  if (!env.SKYSCANNER_API_KEY) return result('skyscanner', 'not_configured', 'Live flight prices need an approved Skyscanner connection. Compare this route directly with airlines while it is being connected.');
  const fetcher = deps.fetcher || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const currency = /^[A-Z]{3}$/.test(env.SKYSCANNER_CURRENCY) ? env.SKYSCANNER_CURRENCY : 'EUR';
  const market = /^[A-Z]{2}$/.test(env.SKYSCANNER_MARKET) ? env.SKYSCANNER_MARKET : 'TR';
  const locale = /^[a-z]{2}-[A-Z]{2}$/.test(env.SKYSCANNER_LOCALE) ? env.SKYSCANNER_LOCALE : 'en-GB';
  const [year, month, day] = input.date.split('-').map(Number);
  const headers = { 'content-type': 'application/json', 'x-api-key': env.SKYSCANNER_API_KEY };
  let data = {};
  let status;
  try {
    let response = await fetchProviderJson(`${FLIGHTS_URL}/create`, { method: 'POST', headers, body: JSON.stringify({ query: {
      market, locale, currency, adults: input.adults, cabinClass: `CABIN_CLASS_${input.cabin.toUpperCase()}`,
      queryLegs: [{ originPlaceId: { iata: input.from.iata }, destinationPlaceId: { iata: input.to.iata }, date: { year, month, day } }],
    } }) }, fetcher);
    data = mergeFlightResults(data, response);
    status = response.status;
    const token = response.sessionToken;
    // A bounded poll keeps one unavailable supplier from trapping the entire search.
    for (let poll = 0; poll < 3 && status !== 'RESULT_STATUS_COMPLETE' && status !== 'RESULT_STATUS_FAILED'; poll++) {
      if (typeof token !== 'string' || !token.length || token.length > 8192) break;
      await sleep(900);
      response = await fetchProviderJson(`${FLIGHTS_URL}/poll/${encodeURIComponent(token)}`, { method: 'POST', headers, body: '{}' }, fetcher, 5000);
      data = mergeFlightResults(data, response);
      status = response.status;
    }
    if (status === 'RESULT_STATUS_FAILED') throw new Error('Provider search failed');
    const journeys = normalizeFlights(data, input, currency);
    const complete = status === 'RESULT_STATUS_COMPLETE';
    return result('skyscanner', complete ? (journeys.length ? 'ok' : 'empty') : 'partial', complete
      ? (journeys.length ? 'Live quotes from Skyscanner. Final availability and extras are confirmed at booking.' : 'No bookable flights were returned for this route and date.')
      : 'Some suppliers are still searching. These are partial quotes; try again for more results.', journeys);
  } catch (error) {
    const journeys = normalizeFlights(data, input, currency);
    return result('skyscanner', journeys.length ? 'partial' : 'error', error?.code === 'provider_rate_limited'
      ? 'The flight provider is busy. Please try again shortly.'
      : 'The flight provider could not finish. Other transport options are still available.', journeys);
  }
}

function isoCalendarDate(value) {
  const text = String(value ?? '');
  const date = /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
  return dateEpoch(date) !== null ? date : null;
}

function minuteTime(date, minute) {
  if (!finite(minute, 0, 7 * 1440)) return null;
  return new Date(dateEpoch(date) + minute * 60_000).toISOString().slice(0, 19);
}

function railMode(mode) {
  if (['rail', 'night_rail', 'high_speed', 'regional_rail', 'train'].includes(mode)) return 'train';
  if (['metro', 'subway', 'tram', 'urban_rail'].includes(mode)) return 'metro';
  if (['bus', 'coach'].includes(mode)) return 'bus';
  return mode === 'walk' ? 'walk' : null;
}

function railPlace(place, fallback) {
  return { name: shortText(place?.name) || fallback.name, lat: finite(place?.lat, -90, 90) ? place.lat : fallback.lat, lon: finite(place?.lon, -180, 180) ? place.lon : fallback.lon };
}

export function normalizeRail(payload, input) {
  if (!isObject(payload) || !Array.isArray(payload.journeys)) throw new Error('Invalid rail response');
  const sources = Array.isArray(payload.sources) ? payload.sources.slice(0, 40).map((source) => ({
    id: shortText(source?.id, 80), name: shortText(source?.name || source?.publisher || source?.id), publisher: shortText(source?.publisher), url: safeUrl(source?.url),
    license: shortText(source?.license || source?.licence, 200), licence: shortText(source?.licence || source?.license, 200),
    licenceUrl: safeUrl(source?.licenceUrl || source?.licenseUrl), attribution: shortText(source?.attribution, 500),
    timezones: Array.isArray(source?.timezones) ? source.timezones.slice(0, 10).map((zone) => shortText(zone, 60)).filter(Boolean) : [],
    retrievedAt: shortText(source?.retrievedAt, 60), updatedAt: shortText(source?.updatedAt || source?.fetchedAt || source?.downloadedAt, 60),
    coverage: shortText(source?.coverage, 300),
  })) : [];
  const generatedAt = shortText(payload.generatedAt, 60);
  const from = isoCalendarDate(payload.calendar?.from);
  const days = payload.calendar?.days;
  const queriedDate = isoCalendarDate(payload.date);
  const day = dateEpoch(input.date);
  if (!from || !Number.isInteger(days) || days < 1 || days > 730 || day < dateEpoch(from) || day >= dateEpoch(from) + days * 86_400_000
    || (queriedDate && queriedDate !== input.date)) {
    return result('rail', 'unavailable', 'This rail timetable does not cover your travel date. Check current departures with the operator.', [], { sources, generatedAt, calendar: { from, days: Number.isInteger(days) ? days : 0 } });
  }
  const journeys = payload.journeys.slice(0, 40).flatMap((journey, index) => {
    if (!Array.isArray(journey?.legs) || !journey.legs.length || journey.legs.length > 30 || !finite(journey.durationMin, 1, 10_080)) return [];
    const legs = journey.legs.map((leg) => {
      const mode = railMode(leg?.mode);
      const departure = minuteTime(input.date, leg?.departMin);
      const arrival = minuteTime(input.date, leg?.arriveMin);
      if (!mode || !departure || !arrival || leg.arriveMin < leg.departMin) return null;
      return { mode, originalMode: shortText(leg.mode, 40), from: railPlace(leg.from, input.from), to: railPlace(leg.to, input.to), departure, arrival,
        durationMinutes: leg.arriveMin - leg.departMin, operator: shortText(leg.operator), service: shortText(leg.service), price: null,
        ...(finite(leg.distanceM, 0, 1_000_000) ? { distanceM: leg.distanceM } : {}), timeBasis: 'agency_local' };
    });
    if (legs.some((leg) => !leg)) return [];
    const modes = [...new Set(legs.filter((leg) => leg.mode !== 'walk').map((leg) => leg.mode))];
    if (!modes.length || modes.some((mode) => !input.modes.includes(mode))) return [];
    const departure = minuteTime(input.date, journey.departMin);
    const arrival = minuteTime(input.date, journey.arriveMin);
    if (!departure || !arrival || journey.arriveMin - journey.departMin !== journey.durationMin) return [];
    return [{ id: `rail:${input.date}:${index}:${journey.departMin}`, provider: 'rail', mode: modes.includes('train') ? 'train' : modes[0], modes,
      from: input.from, to: input.to, date: input.date, departure, arrival, durationMinutes: journey.durationMin,
      changes: Number.isInteger(journey.transfers) && journey.transfers >= 0 ? journey.transfers : null,
      hasSleeper: Boolean(journey.hasSleeper), price: null, bookingUrl: null, bookingLinks: [], fareStatus: 'unavailable', timeBasis: 'agency_local', legs,
      operators: [...new Set(legs.map((leg) => leg.operator).filter(Boolean))], sources,
      source: { name: sources[0]?.name || 'Open transport timetables', url: sources[0]?.url || null, generatedAt, fetchedAt: sources[0]?.retrievedAt || generatedAt },
      notes: [shortText(payload.searchScope, 400) || 'Published timetable, not a live running-time guarantee.', 'The timetable does not include fares. Confirm the price with the operator.'],
    }];
  });
  return result('rail', journeys.length ? 'ok' : 'empty', journeys.length ? (shortText(payload.searchScope, 400) || 'Scheduled connections from published transport data. Fares are not provided.')
    : shortText(payload.coverage, 240) || 'No scheduled connections in this timetable for your route, date, and selected transport modes.', journeys,
  { sources, generatedAt, calendar: { from, days }, searchScope: shortText(payload.searchScope, 400) });
}

export async function searchRail(input, env, deps = {}) {
  if (!env.RAIL_API_URL) {
    if (!deps.edgeRailSearch) return result('rail', 'not_configured', 'Train, bus, and metro timetables have not been connected yet.');
    try { return normalizeRail(await deps.edgeRailSearch({ ...input, departHour: 0 }), input); }
    catch { return result('rail', 'error', 'The local timetable could not complete this search. Try the operator for this route.'); }
  }
  const origin = safeUrl(env.RAIL_API_URL);
  if (!origin) return result('rail', 'error', 'The timetable connection needs a valid HTTPS endpoint.');
  try {
    const url = new URL(origin);
    url.pathname = '/api/search';
    url.search = '';
    url.hash = '';
    const payload = await fetchProviderJson(url.href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      from: input.from, to: input.to, date: Number(input.date.replaceAll('-', '')), departHour: 0,
    }) }, deps.fetcher || fetch, 10_000);
    return normalizeRail(payload, input);
  } catch {
    return result('rail', 'error', 'The timetable service is temporarily unavailable. Flight searches can still continue.');
  }
}
