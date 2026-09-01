/**
 * A journey, as a shape you can read without reading.
 *
 * There are no prices in this product and there never will be — open transit
 * feeds carry schedules, not fares. So the axis a traveller compares options
 * along cannot be money. It is TIME, CHANGES, and DARKNESS, and the last of
 * those is the one nobody else draws.
 *
 * Skyscanner and Google Maps both render a ten-hour sleeper and a four-hour
 * express as the same grey row differing by a number. Measured on the real
 * network, in plain ASCII, with no styling at all:
 *
 *   FRA->WIEN sleeper   ..........::++################++::......   69% dark
 *   BER->MUC day        ......................................      0% dark
 *
 * That is the whole product. You do not read "482 minutes asleep"; you see a
 * line cross into the dark and come out the other side.
 *
 * BUT DARKNESS CANNOT CARRY THE PRIMARY READ, and a design panel measuring
 * this against the real network is the reason it does not. Berlin to Munich,
 * the eight departures the router actually returns across its 12-hour window
 * on 15 September:
 *
 *   06:00 dark 0.196   08:00 dark 0.000   10:00 dark 0.000   12:00 dark 0.000
 *   14:00 dark 0.000   16:00 dark 0.186   18:00 dark 0.680   20:00 dark 1.000
 *
 * Four of eight rows are identically, flatly lit. On an ordinary daytime
 * corridor — which is most searches — the sky differentiates nothing. Worse,
 * a sleeper cannot be identified BY its blackness either: the same panel
 * measured a Zurich-Hamburg sleeper at dark 1.000 in December and 0.752 in
 * June, when it never reaches true night at all. A design that says "the dark
 * one is the sleeper" is wrong for a third of the year.
 *
 * So the layers are ranked, and lower numbers win when they conflict:
 *
 *   1. LENGTH ON ONE SHARED AXIS. Every ribbon is positioned and scaled
 *      against the same start and end minute, so a 4h option is physically
 *      shorter than a 15h one. This carries the comparison. Normalising each
 *      row to its own width — the obvious implementation — makes them the
 *      same length and destroys the only thing the ribbon exists to do.
 *   2. THE SLEEPER IS MARKED EXPLICITLY, from `hasSleeper` and `sleeperMin`,
 *      never inferred from hue. That is data the router gives us; darkness is
 *      an atmosphere that happens to correlate with it most of the year.
 *   3. THE SKY IS COMPUTED, NOT DECORATIVE — the second thing you notice,
 *      never the first. lib/sun.js interpolates the sun's altitude along the
 *      moving route, so an eastbound sleeper meets dawn before the city it
 *      left. Measured on Frankfurt->Vienna: 30 minutes earlier than if you had
 *      stayed put. A real fact about the journey, drawn.
 */

import { skyAlongJourney, darkFraction } from './sun.js';

/**
 * The window every ribbon in a result set is drawn against.
 *
 * Padded by a few minutes so the earliest departure and latest arrival do not
 * sit flush against the edges and read as clipped.
 */
export function timeAxis(journeys, padMin = 20) {
  if (!journeys.length) return { startMin: 0, endMin: 1440, spanMin: 1440 };
  let lo = Infinity, hi = -Infinity;
  for (const j of journeys) {
    if (j.departMin < lo) lo = j.departMin;
    if (j.arriveMin > hi) hi = j.arriveMin;
  }
  const startMin = lo - padMin;
  const endMin = hi + padMin;
  return { startMin, endMin, spanMin: Math.max(1, endMin - startMin) };
}

/** Where a minute falls on the shared axis, as 0..1. */
export function positionOn(axis, min) {
  return (min - axis.startMin) / axis.spanMin;
}

/**
 * The UTC instant a local departure minute corresponds to.
 *
 * GTFS times are agency-local with no zone attached, and every country
 * ingested is on CET/CEST — so a fixed offset is right for today's coverage
 * and wrong the moment a feed outside that band is added. It is deliberately
 * a parameter rather than a constant so the caller must think about it, and
 * `src/lib/calendar.js` already fails loudly if a feed from another offset
 * appears. An hour of error at a 6-degree twilight boundary moves a band edge
 * by minutes, which is far below what a reader can see.
 */
export function instantFor(dateYmd, minutesPastMidnight, utcOffsetHours = 2) {
  const y = Math.floor(dateYmd / 10000);
  const m = (Math.floor(dateYmd / 100) % 100) - 1;
  const d = dateYmd % 100;
  return Date.UTC(y, m, d, 0, 0, 0)
    - utcOffsetHours * 3600e3
    + minutesPastMidnight * 60e3;
}

/**
 * Collapse the sky samples into contiguous bands.
 *
 * 160 samples would be 160 DOM nodes or gradient stops per row. A journey
 * crosses at most nine band boundaries (day, dusk through three twilights,
 * night, and back), so the drawable form is a handful of spans with their
 * own start and end on the ribbon.
 */
export function skyBands(sky) {
  if (!sky.length) return [];
  const out = [];
  for (let i = 0; i < sky.length; i++) {
    const last = out[out.length - 1];
    if (!last || last.band !== sky[i].band) out.push({ band: sky[i].band, start: sky[i].t, end: sky[i].t });
  }
  // Each band runs up to where the NEXT one begins, and the last runs to the
  // end. Ending a band at its own final SAMPLE instead leaves an unpainted
  // sliver at every twilight boundary and gives the final band zero width —
  // on a ribbon that is a visible crack exactly where dusk falls.
  for (let i = 0; i < out.length; i++) {
    out[i].end = i + 1 < out.length ? out[i + 1].start : 1;
  }
  return out;
}

/**
 * Everything needed to draw one journey, computed once.
 *
 * `legs` carries each ride as a fraction of the SHARED axis, so the gaps
 * between them are the transfers — a three-change journey is visibly broken
 * up and a direct one is a single unbroken bar, without anyone reading the
 * transfer count.
 */
export function ribbonFor(journey, axis, dateYmd, utcOffsetHours = 2) {
  const rides = journey.legs.filter((l) => l.mode !== 'walk');
  const first = rides[0] ?? journey.legs[0];
  const last = rides[rides.length - 1] ?? journey.legs[journey.legs.length - 1];

  const startMs = instantFor(dateYmd, journey.departMin, utcOffsetHours);
  const endMs = instantFor(dateYmd, journey.arriveMin, utcOffsetHours);

  // Coordinates must be real numbers, not merely present. router.js builds the
  // walk to the first station as `{ name: 'Start', lat: null, lon: null }`
  // (router.js:752, :805), and a null latitude does not throw — it produces
  // NaN altitudes, and twilightBand(NaN) returns 'night' because NaN fails
  // every `>` comparison and falls through to the last branch. The result is a
  // ribbon painted solid black for a midday journey, with no error anywhere.
  // A plausible silent failure is the kind that ships.
  const usable = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

  // 96 samples is about a band edge every 10 minutes on a 15-hour journey —
  // finer than the eye resolves at any width this is drawn at, and cheap.
  const sky = (usable(first?.from) && usable(last?.to))
    ? skyAlongJourney(startMs, endMs, first.from, last.to, 96)
    : [];

  const left = positionOn(axis, journey.departMin);
  const right = positionOn(axis, journey.arriveMin);

  return {
    left,
    width: Math.max(0.004, right - left),   // a 0-minute journey still shows
    dark: sky.length ? darkFraction(sky) : 0,
    bands: skyBands(sky),
    legs: rides.map((l) => ({
      mode: l.mode,
      service: l.service,
      operator: l.operator,
      from: l.from,
      to: l.to,
      departMin: l.departMin,
      arriveMin: l.arriveMin,
      intermediateStops: l.intermediateStops,
      left: positionOn(axis, l.departMin),
      width: Math.max(0.002, positionOn(axis, l.arriveMin) - positionOn(axis, l.departMin)),
    })),
  };
}

/**
 * Sort orders that replace "cheapest / fastest / best".
 *
 * `sleep` is offered only when something in the set actually has a sleeper,
 * because a sort control that cannot change the order is a control that lies
 * about what the data holds.
 */
export const SORTS = {
  earliest: { label: 'Earliest', cmp: (a, b) => a.departMin - b.departMin },
  fastest: { label: 'Fastest', cmp: (a, b) => a.durationMin - b.durationMin },
  simplest: { label: 'Fewest changes', cmp: (a, b) => a.transfers - b.transfers || a.durationMin - b.durationMin },
  sleep: { label: 'Sleep through it', cmp: (a, b) => (b.sleeperMin || 0) - (a.sleeperMin || 0) },
};

export function sortsFor(journeys) {
  const keys = ['earliest', 'fastest', 'simplest'];
  if (journeys.some((j) => j.hasSleeper)) keys.push('sleep');
  return keys.map((k) => ({ key: k, ...SORTS[k] }));
}
