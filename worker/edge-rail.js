import network from '../src/data/edge-network.json' with { type: 'json' };
import { accessStops, dayNumberFor, runsOnDay } from '../src/lib/router.js';
import { Calls } from '../src/lib/calls.js';

// Timetable-only shared state. No request, traveller or result data is retained.
// Hydrate static columns during module startup so the first search does not
// spend its request CPU allowance preparing the same immutable timetable.
const timetable = initializeTimetable();

function initializeTimetable() {
  // Lookup tables are computed during ingest. Startup only hydrates typed
  // columns; no network request, filesystem access or traveller state is used.
  const edge = network.edge;
  const calls = new Calls(Int32Array.from(edge.calls.stop), Uint16Array.from(edge.calls.arrive), Uint16Array.from(edge.calls.depart), Int32Array.from(edge.calls.offset));
  const { boardings, arrivals } = edge;
  const index = {
    network, calls, calendarEpoch: network.calendarEpoch, calendarDays: network.calendarDays,
    stopServiceOffset: Int32Array.from(edge.stopServiceOffset), stopServices: Int32Array.from(edge.stopServices),
    dayLo: Int32Array.from(edge.dayLo), dayHi: Int32Array.from(edge.dayHi),
    footOffset: Int32Array.from(edge.footOffset), footTo: Int32Array.from(edge.footTo), footMin: Uint8Array.from(edge.footMin),
  };
  for (const service of network.services) service.c = null;
  network.edge = null;
  return { index, boardings, arrivals };
}

function dateNumber(value) {
  const iso = value == null ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) : String(value);
  const compact = iso.replaceAll('-', '');
  if (!/^\d{8}$/.test(compact)) return null;
  const time = Date.UTC(+compact.slice(0, 4), +compact.slice(4, 6) - 1, +compact.slice(6, 8));
  if (new Date(time).toISOString().slice(0, 10).replaceAll('-', '') !== compact) return null;
  return Number(compact);
}

function stopAt(index, si, ci) {
  const stop = network.stops[index.calls.stopAt(si, ci)];
  return { name: stop.n, lat: stop.y, lon: stop.x };
}

function leg(index, si, board, alight) {
  const service = network.services[si];
  return {
    mode: service.m, service: service.s, serviceId: service.i,
    operator: service.o, headsign: service.h,
    from: stopAt(index, si, board), to: stopAt(index, si, alight),
    departMin: index.calls.departAt(si, board), arriveMin: index.calls.arriveAt(si, alight),
    intermediateStops: alight - board - 1, price: null,
  };
}

function journey(legs) {
  const rides = legs.filter((l) => l.mode !== 'walk');
  const sleeperMin = rides.filter((l) => l.mode === 'night_rail').reduce((n, l) => n + l.arriveMin - l.departMin, 0);
  return {
    legs, departMin: legs[0].departMin, arriveMin: legs.at(-1).arriveMin,
    durationMin: legs.at(-1).arriveMin - legs[0].departMin,
    transfers: rides.length - 1, modes: [...new Set(rides.map((l) => l.mode))],
    hasSleeper: sleeperMin > 0, sleeperMin, price: null,
  };
}

function lowerBound(list, time) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid][2] < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Real direct and one-change rail journeys, with GTFS boarding permissions.
 * The pre-existing router does not represent those permissions, so only its
 * packed index and station selection are reused. Train identity is the trip ID,
 * never the generic route label (separate ICE services must stay separate).
 */
export function edgeRailSearch(input = {}) {
  const { from, to } = input;
  const date = dateNumber(input.date);
  const base = {
    journeys: [], sources: network.sources, generatedAt: network.generatedAt, date,
    calendar: { from: network.calendarEpoch, days: network.calendarDays },
    searchScope: 'Direct and one-change scheduled trains in the Germany long-distance feed. Station-to-station; local transit and fares are not included.',
  };
  const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
  if (!ok(from) || !ok(to)) return { ...base, error: 'invalid_coordinates', coverage: 'Choose an origin and destination with valid coordinates.' };
  if (date === null) return { ...base, error: 'invalid_date', coverage: 'Use a valid date in YYYY-MM-DD format.' };
  const hour = input.departHour ?? 8;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ...base, error: 'invalid_departure_hour', coverage: 'Departure hour must be between 0 and 23.' };
  // Never let the existing router's out-of-range fallback disable calendars.
  const day = dayNumberFor({ calendarEpoch: network.calendarEpoch, calendarDays: network.calendarDays }, date);
  if (day < 0) return { ...base, error: 'date_out_of_coverage', coverage: 'This date is outside the published rail timetable. Check directly with the operator.' };
  const { index, boardings, arrivals } = timetable;
  const origins = accessStops(index, from.lat, from.lon, 8000, 8);
  const destinations = accessStops(index, to.lat, to.lon, 8000, 8);
  if (!origins.length || !destinations.length) return {
    ...base, coverage: !origins.length ? 'The Germany long-distance feed has no station near this origin.' : 'The Germany long-distance feed has no station near this destination.',
  };
  const active = new Uint8Array(network.services.length);
  for (let si = 0; si < active.length; si++) active[si] = runsOnDay(index, si, day) ? 1 : 0;
  const destinationCalls = new Map();
  for (const destination of destinations) {
    for (const [si, ci] of arrivals[destination.idx]) {
      if (!active[si]) continue;
      if (!destinationCalls.has(si)) destinationCalls.set(si, []);
      destinationCalls.get(si).push(ci);
    }
  }
  for (const calls of destinationCalls.values()) calls.sort((a, b) => a - b);
  // Filter once instead of walking every unrelated train for every possible
  // transfer. This keeps warm requests within the small edge CPU budget.
  const connections = boardings.map((list) => list.filter(([si]) => active[si] && destinationCalls.has(si)));
  const firstDestination = (si, board) => destinationCalls.get(si)?.find((ci) => ci > board);
  const results = new Map();
  const add = (legs) => {
    const result = journey(legs);
    const key = result.legs.filter((l) => l.mode !== 'walk').map((l) => l.serviceId).join('|');
    const previous = results.get(key);
    if (result.durationMin > 0 && result.durationMin <= 30 * 60 && (!previous || result.durationMin < previous.durationMin)) results.set(key, result);
  };
  const visitedBoardings = new Set();
  for (const origin of origins) {
    const starts = boardings[origin.idx];
    for (let start = lowerBound(starts, hour * 60); start < starts.length; start++) {
      const [si, ci, departure] = starts[start];
      if (departure >= 1440) break; // The chosen date is the actual boarding day.
      if (!active[si] || visitedBoardings.has(`${si}:${ci}`)) continue;
      visitedBoardings.add(`${si}:${ci}`);
      const direct = firstDestination(si, ci);
      if (direct !== undefined) { add([leg(index, si, ci, direct)]); continue; }
      // Look for one change at each permissible arrival. The GTFS service-day
      // minute values, including >24:00, are retained without fabricated times.
      for (let transferCall = ci + 1; transferCall < index.calls.count(si); transferCall++) {
        if (!(network.services[si].p[transferCall] & 2)) continue;
        const at = index.calls.stopAt(si, transferCall);
        const arrival = index.calls.arriveAt(si, transferCall);
        const options = [[at, 0]];
        for (let f = index.footOffset[at]; f < index.footOffset[at + 1]; f++) options.push([index.footTo[f], index.footMin[f]]);
        for (const [transferStop, walkMin] of options) {
          const next = connections[transferStop];
          const ready = arrival + walkMin + 8;
          for (let b = lowerBound(next, ready); b < next.length && next[b][2] <= ready + 180; b++) {
            const [nextSi, nextCi] = next[b];
            if (nextSi === si || !active[nextSi]) continue;
            const destination = firstDestination(nextSi, nextCi);
            if (destination === undefined) continue;
            const firstLeg = leg(index, si, ci, transferCall);
            const lastLeg = leg(index, nextSi, nextCi, destination);
            const legs = [firstLeg];
            if (walkMin) legs.push({ mode: 'walk', service: null, operator: null, from: firstLeg.to, to: lastLeg.from, departMin: arrival, arriveMin: arrival + walkMin, price: null });
            legs.push(lastLeg);
            add(legs);
          }
        }
      }
    }
  }
  const found = [...results.values()];
  const candidates = found.filter((j) => !found.some((p) => p !== j && p.departMin >= j.departMin && p.arriveMin + 60 < j.arriveMin && p.transfers <= j.transfers))
    .sort((a, b) => a.durationMin - b.durationMin || a.transfers - b.transfers || a.departMin - b.departMin);
  // Keep useful alternatives across the day without dozens of near-identical
  // connection combinations. The API never calls this an exhaustive search.
  const selected = [], seen = new Set();
  const take = (j) => { if (j && !seen.has(j)) { selected.push(j); seen.add(j); } };
  take(candidates[0]);
  take(candidates.find((j) => j.transfers === 0));
  take(candidates.find((j) => j.hasSleeper));
  for (const j of [...candidates].sort((a, b) => a.departMin - b.departMin || a.durationMin - b.durationMin)) {
    if (selected.length >= 8) break;
    if (selected.some((p) => p.departMin >= j.departMin && p.arriveMin + 60 < j.arriveMin && p.transfers <= j.transfers)) continue;
    if (selected.some((p) => Math.abs(p.departMin - j.departMin) < 25 && p.durationMin <= j.durationMin && p.transfers <= j.transfers)) continue;
    take(j);
  }
  return { ...base, journeys: selected.sort((a, b) => a.departMin - b.departMin), ...(!selected.length ? { coverage: 'No direct or one-change train found for this route and date in this feed. Other operators or routes may exist.' } : {}) };
}
