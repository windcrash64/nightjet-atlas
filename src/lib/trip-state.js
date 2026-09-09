const COST_KEYS = ['fare', 'baggage', 'originTransfer', 'destinationTransfer'];
export const blankCosts = () => Object.fromEntries(COST_KEYS.map((key) => [key, '']));
export const hasCosts = (costs) => COST_KEYS.some((key) => costs?.[key] !== '' && costs?.[key] != null);

const point = (p) => p && typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= 120
  && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;
const validDay = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const boundedAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;

export function maximumTravelDate(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 365 * 86400000).toISOString().slice(0, 10);
}

export function validateTrip(query, now = new Date()) {
  if (!point(query.from) || !point(query.to)) return 'Choose an origin and destination from the suggestions.';
  if (query.from.lat === query.to.lat && query.from.lon === query.to.lon) return 'Choose two different places.';
  if (!validDay(query.date) || query.date < now.toISOString().slice(0, 10) || query.date > maximumTravelDate(now)) return 'Choose a valid date from today through the next 365 days.';
  if (!Number.isInteger(query.adults) || query.adults < 1 || query.adults > 8) return 'Choose between one and eight adult travelers.';
  return null;
}

export function dayOffsetLabel(departure, arrival) {
  const from = departure?.slice(0, 10), to = arrival?.slice(0, 10);
  if (!validDay(from) || !validDay(to)) return '';
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  return days ? ` (${days > 0 ? '+' : ''}${days} ${Math.abs(days) === 1 ? 'day' : 'days'})` : '';
}

function savedPlace(p) {
  if (!point(p)) return null;
  return { name: p.name.trim(), lat: p.lat, lon: p.lon,
    kind: p.kind === 'airport' ? 'airport' : 'city',
    ...(typeof p.id === 'string' && p.id.length <= 200 ? { id: p.id } : {}),
    ...(typeof p.country === 'string' && /^[A-Z]{2}$/.test(p.country) ? { country: p.country } : {}),
    ...(typeof p.countryName === 'string' && p.countryName.length <= 120 ? { countryName: p.countryName } : {}),
    ...(/^[A-Z]{3}$/.test(p.iata) ? { iata: p.iata } : {}),
  };
}

export function sanitizeSavedTrips(value) {
  if (!Array.isArray(value)) return [];
  const identities = new Set(), ids = new Set();
  return value.slice(0, 100).flatMap((trip, index) => {
    if (!trip || !validDay(trip.date) || !boundedAmount(trip.budget)) return [];
    const from = savedPlace(trip.from), to = savedPlace(trip.to);
    const adults = trip.adults ?? 1;
    if (!from || !to || !Number.isInteger(adults) || adults < 1 || adults > 8) return [];
    const identity = savedTripIdentity({ from, to, date: trip.date, adults });
    if (identities.has(identity)) return [];
    identities.add(identity);
    let id = typeof trip.id === 'string' && trip.id.length <= 200 ? trip.id : Number.isFinite(trip.id) ? String(trip.id) : `restored-${index}`;
    if (ids.has(id)) id = `restored-${index}-${id}`;
    ids.add(id);
    const costs = blankCosts();
    for (const key of COST_KEYS) {
      const amount = trip.costs?.[key];
      if ((typeof amount === 'number' || typeof amount === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(amount)) && boundedAmount(Number(amount))) costs[key] = String(Math.round(Number(amount) * 100) / 100);
    }
    return [{ id, from, to, date: trip.date, adults, budget: trip.budget,
      bag: ['backpack', 'cabin', 'checked'].includes(trip.bag) ? trip.bag : 'backpack', costs,
      mode: ['all', 'plane', 'train', 'bus', 'metro'].includes(trip.mode) ? trip.mode : 'all',
      ...(typeof trip.costsKey === 'string' && trip.costsKey.length < 1000 ? { costsKey: trip.costsKey } : {}),
    }];
  }).slice(0, 30);
}

export function savedTripIdentity(trip) {
  return JSON.stringify([trip.from.lat, trip.from.lon, trip.from.iata || '', trip.to.lat, trip.to.lon, trip.to.iata || '', trip.date, trip.adults ?? 1]);
}

export function readSavedTrips(storage) {
  try {
    const raw = storage.getItem('travel-freely.saved');
    return raw && raw.length <= 512_000 ? sanitizeSavedTrips(JSON.parse(raw)) : [];
  } catch { return []; }
}
