/**
 * Normalising MOTIS itineraries into the shape this app reasons about.
 *
 * The guiding rule, borrowed from the route-honesty pattern in
 * bilawalsidhu/gods-eye-view (MIT): a value that was not obtained is null and
 * is rendered as "unavailable" — never silently replaced with an estimate that
 * looks computed. Open transit feeds have no fares, so `price` is ALWAYS null
 * here. There is no code path that invents one.
 */

/** Modes MOTIS reports that mean "you are asleep in a bed on a train". */
const SLEEPER_MODES = new Set(['NIGHT_RAIL']);

/** Modes that are a vehicle rather than the traveller's own legs. */
const TRANSIT_MODES = new Set([
  'RAIL', 'HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL', 'REGIONAL_RAIL',
  'REGIONAL_FAST_RAIL', 'SUBURBAN', 'METRO', 'SUBWAY', 'TRAM', 'BUS', 'COACH',
  'FERRY', 'AIRPLANE', 'FUNICULAR', 'CABLE_CAR', 'AREAL_LIFT',
]);

/**
 * Source state for a single leg. This vocabulary is deliberately small and
 * every value means something a traveller can act on.
 *
 *   live      — the operator is reporting realtime data for this service
 *   scheduled — a published timetable, no realtime signal
 *   walking   — the traveller's own movement, no service to be late
 */
export function legSourceState(leg) {
  if (!TRANSIT_MODES.has(leg.mode)) return 'walking';
  return leg.realTime ? 'live' : 'scheduled';
}

export function normaliseLeg(leg) {
  const isTransit = TRANSIT_MODES.has(leg.mode);
  return {
    mode: leg.mode,
    isTransit,
    isSleeper: SLEEPER_MODES.has(leg.mode),
    // MOTIS uses routeShortName for the service number a passenger sees
    // on the platform board ("NJ 40233", "ICE 18").
    service: leg.routeShortName || leg.routeLongName || null,
    operator: leg.agencyName || null,
    from: { name: leg.from?.name ?? null, lat: leg.from?.lat ?? null, lon: leg.from?.lon ?? null },
    to: { name: leg.to?.name ?? null, lat: leg.to?.lat ?? null, lon: leg.to?.lon ?? null },
    departure: leg.startTime ?? null,
    arrival: leg.endTime ?? null,
    durationSeconds:
      leg.startTime && leg.endTime
        ? Math.round((Date.parse(leg.endTime) - Date.parse(leg.startTime)) / 1000)
        : null,
    sourceState: legSourceState(leg),
    // Where a ticket is actually sold, when the feed says so. We link out;
    // we never quote a number we did not receive.
    fareUrl: leg.agencyFareUrl ?? null,
    // There is no fare in open transit feeds. This is not a TODO.
    price: null,
  };
}

export function normaliseItinerary(itin, index) {
  const legs = (itin.legs ?? []).map(normaliseLeg);
  const sleeperLegs = legs.filter((l) => l.isSleeper);
  const transitLegs = legs.filter((l) => l.isTransit);

  const sleeperSeconds = sleeperLegs.reduce((n, l) => n + (l.durationSeconds ?? 0), 0);

  return {
    id: `itin-${index}`,
    departure: itin.startTime ?? null,
    arrival: itin.endTime ?? null,
    durationSeconds: itin.duration ?? null,
    transfers: itin.transfers ?? Math.max(0, transitLegs.length - 1),
    legs,
    // The things this product exists to surface:
    hasSleeper: sleeperLegs.length > 0,
    sleeperSeconds,
    sleeperServices: sleeperLegs.map((l) => ({ service: l.service, operator: l.operator })),
    // If any leg is live, the itinerary carries live data somewhere.
    anyLive: legs.some((l) => l.sourceState === 'live'),
    price: null,
  };
}

/**
 * A night train earns its keep when it replaces a hotel night AND spares you
 * a day of travelling. We only make that claim when the sleeping portion is
 * substantial — a 40-minute NIGHT_RAIL hop at 22:00 is not a bed for the night.
 */
export const MIN_USEFUL_SLEEP_SECONDS = 5 * 3600;

export function isOvernightJourney(itinerary) {
  return itinerary.hasSleeper && itinerary.sleeperSeconds >= MIN_USEFUL_SLEEP_SECONDS;
}

export function formatDuration(seconds) {
  if (seconds == null) return 'unavailable';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  // Narrow no-break space: tabular figures pad a normal space out to a full
  // digit width, which reads as an accidental double space.
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
