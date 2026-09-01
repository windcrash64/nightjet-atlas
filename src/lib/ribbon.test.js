import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  timeAxis, positionOn, instantFor, skyBands, ribbonFor, sortsFor,
} from './ribbon.js';

const FRA = { name: 'Frankfurt Hbf', lat: 50.1067, lon: 8.6628 };
const WIEN = { name: 'Wien Hbf', lat: 48.1856, lon: 16.3367 };
const BER = { name: 'Berlin Hbf', lat: 52.5251, lon: 13.3694 };
const MUC = { name: 'München Hbf', lat: 48.1403, lon: 11.5583 };

/** A journey shaped like the router's output. */
function j({ depart, arrive, transfers = 0, sleeper = 0, legs }) {
  return {
    departMin: depart,
    arriveMin: arrive,
    durationMin: arrive - depart,
    transfers,
    hasSleeper: sleeper > 0,
    sleeperMin: sleeper,
    legs: legs ?? [{
      mode: 'rail', service: 'ICE 1', operator: 'DB',
      from: BER, to: MUC, departMin: depart, arriveMin: arrive, intermediateStops: 3,
    }],
  };
}

/* ---------- the shared axis ---------- */

test('every ribbon is measured against the same window', () => {
  // The whole comparison rests on this. Normalising each row to its own width
  // — the obvious implementation — makes a 4h option and a 15h one the same
  // length, which destroys the only thing the ribbon exists to show.
  const set = [j({ depart: 576, arrive: 823 }), j({ depart: 962, arrive: 1860 })];
  const axis = timeAxis(set, 0);
  const short = ribbonFor(set[0], axis, 20260901);
  const long = ribbonFor(set[1], axis, 20260901);
  assert.ok(long.width > short.width * 3,
    `the 15h journey must be far longer than the 4h one, got ${long.width} vs ${short.width}`);
});

test('the axis spans the whole result set with padding at both ends', () => {
  const axis = timeAxis([j({ depart: 600, arrive: 700 }), j({ depart: 500, arrive: 900 })], 20);
  assert.equal(axis.startMin, 480);
  assert.equal(axis.endMin, 920);
  assert.equal(axis.spanMin, 440);
});

test('an empty result set does not produce a zero-width axis', () => {
  const axis = timeAxis([]);
  assert.ok(axis.spanMin > 0, 'a zero span would divide by zero in positionOn');
});

test('positions run 0 to 1 across the axis', () => {
  const axis = timeAxis([j({ depart: 600, arrive: 800 })], 0);
  assert.equal(positionOn(axis, 600), 0);
  assert.equal(positionOn(axis, 800), 1);
  assert.equal(positionOn(axis, 700), 0.5);
});

/* ---------- local time to a real instant ---------- */

test('a departure minute becomes the right UTC instant', () => {
  // 2026-09-01 08:00 in CEST (UTC+2) is 06:00 UTC. The offset is derived from
  // the date, not passed — see the DST test below for why.
  assert.equal(new Date(instantFor(20260901, 8 * 60)).toISOString(),
    '2026-09-01T06:00:00.000Z');
});

test('a time past midnight lands on the next day', () => {
  // GTFS runs past 24:00 for overnight services: 1860 is 07:00 the NEXT day,
  // and getting this wrong would draw a sleeper's dawn on the wrong date.
  assert.equal(new Date(instantFor(20260901, 1860)).toISOString(),
    '2026-09-02T05:00:00.000Z');
});

test('the offset override is in MINUTES, not hours', () => {
  // This test exists because the parameter changed units. Passing 2 meaning
  // "+2 hours" silently produced a 118-minute error — the value is accepted,
  // nothing throws, and the sky lands two hours off. Pin the unit.
  assert.equal(new Date(instantFor(20260901, 8 * 60, 120)).toISOString(),
    '2026-09-01T06:00:00.000Z', '120 minutes is +2h');
  assert.equal(new Date(instantFor(20260901, 8 * 60, 60)).toISOString(),
    '2026-09-01T07:00:00.000Z', '60 minutes is +1h');
});

test('the CET/CEST boundary is computed, because it falls inside the horizon', () => {
  // The 60-day horizon opening 2026-09-01 closes 2026-10-30, and CEST ends at
  // 01:00 UTC on Sunday 2026-10-25. A hardcoded +2 would put the sky an hour
  // wrong for the last five bookable days of the window.
  assert.equal(new Date(instantFor(20261020, 12 * 60)).toISOString(),
    '2026-10-20T10:00:00.000Z', 'before the change: CEST, UTC+2');
  assert.equal(new Date(instantFor(20261027, 12 * 60)).toISOString(),
    '2026-10-27T11:00:00.000Z', 'after the change: CET, UTC+1');
});

/* ---------- the sky ---------- */

test('a night journey is mostly dark and a day journey is not', () => {
  // The real Frankfurt->Vienna sleeper (16:02 -> 07:00+1) against the real
  // Berlin->Munich morning ICE. This is the comparison the product is for.
  const set = [
    j({ depart: 962, arrive: 1860, sleeper: 482, legs: [{ mode: 'night_rail', service: 'NJ 40490', from: FRA, to: WIEN, departMin: 962, arriveMin: 1860, intermediateStops: 8 }] }),
    j({ depart: 576, arrive: 823, legs: [{ mode: 'rail', service: 'ICE 29', from: BER, to: MUC, departMin: 576, arriveMin: 823, intermediateStops: 5 }] }),
  ];
  const axis = timeAxis(set);
  const night = ribbonFor(set[0], axis, 20260901);
  const day = ribbonFor(set[1], axis, 20260901);
  assert.ok(night.dark > 0.5, `sleeper should be majority dark, got ${night.dark.toFixed(2)}`);
  assert.equal(day.dark, 0, 'a 09:36 to 13:43 journey sees no darkness in September');
});

test('the sky follows the traveller, not the origin', () => {
  // An eastbound sleeper meets dawn before the city it left. Measured on
  // Frankfurt->Vienna: about half an hour earlier. If this ever equals the
  // stationary case, the interpolation in sun.js has been lost.
  const moving = ribbonFor(
    j({ depart: 962, arrive: 1860, legs: [{ mode: 'night_rail', service: 'NJ', from: FRA, to: WIEN, departMin: 962, arriveMin: 1860, intermediateStops: 8 }] }),
    timeAxis([j({ depart: 962, arrive: 1860 })]), 20260901,
  );
  const still = ribbonFor(
    j({ depart: 962, arrive: 1860, legs: [{ mode: 'night_rail', service: 'NJ', from: FRA, to: FRA, departMin: 962, arriveMin: 1860, intermediateStops: 8 }] }),
    timeAxis([j({ depart: 962, arrive: 1860 })]), 20260901,
  );
  assert.ok(moving.dark < still.dark,
    `travelling east must shorten the darkness: moving ${moving.dark.toFixed(3)} vs still ${still.dark.toFixed(3)}`);
});

test('bands are contiguous, ordered, and cover the whole ribbon', () => {
  const sky = [
    { t: 0, band: 'day' }, { t: 0.25, band: 'day' },
    { t: 0.5, band: 'civil' }, { t: 0.75, band: 'night' }, { t: 1, band: 'night' },
  ];
  const bands = skyBands(sky);
  assert.deepEqual(bands.map((b) => b.band), ['day', 'civil', 'night']);
  assert.equal(bands[0].start, 0);
  assert.equal(bands[bands.length - 1].end, 1);
  for (let i = 1; i < bands.length; i++) {
    assert.equal(bands[i].start, bands[i - 1].end, 'no gap between bands');
  }
});

test('a band that lasts a single sample still has width', () => {
  // A brief twilight between two long bands must not render as an invisible
  // sliver. Sampled at the real density (96 samples), the civil band here is
  // one sample wide and must still be drawn.
  const sky = [];
  for (let i = 0; i <= 96; i++) {
    const t = i / 96;
    sky.push({ t, band: i < 48 ? 'day' : i === 48 ? 'civil' : 'night' });
  }
  const bands = skyBands(sky);
  assert.deepEqual(bands.map((b) => b.band), ['day', 'civil', 'night']);
  for (const b of bands) assert.ok(b.end > b.start, `${b.band} must have width`);
});

test('a journey with no coordinates degrades to no sky rather than throwing', () => {
  const bad = { departMin: 600, arriveMin: 700, durationMin: 100, transfers: 0, legs: [{ mode: 'walk' }] };
  const r = ribbonFor(bad, timeAxis([bad]), 20260901);
  assert.equal(r.dark, 0);
  assert.deepEqual(r.bands, []);
});

/* ---------- legs as the shape of the journey ---------- */

test('transfers are the gaps, so a direct journey is one unbroken bar', () => {
  const direct = j({ depart: 600, arrive: 800 });
  const changing = j({
    depart: 600, arrive: 800, transfers: 1,
    legs: [
      { mode: 'rail', service: 'A', from: BER, to: MUC, departMin: 600, arriveMin: 680, intermediateStops: 2 },
      { mode: 'rail', service: 'B', from: MUC, to: WIEN, departMin: 720, arriveMin: 800, intermediateStops: 1 },
    ],
  });
  const axis = timeAxis([direct, changing], 0);
  assert.equal(ribbonFor(direct, axis, 20260901).legs.length, 1);

  const legs = ribbonFor(changing, axis, 20260901).legs;
  assert.equal(legs.length, 2);
  assert.ok(legs[1].left > legs[0].left + legs[0].width,
    'the 40-minute wait must be a visible gap, not an overlap');
});

test('walking legs are not drawn as rides', () => {
  const withWalk = j({
    depart: 600, arrive: 800,
    legs: [
      { mode: 'rail', service: 'A', from: BER, to: MUC, departMin: 600, arriveMin: 680, intermediateStops: 2 },
      { mode: 'walk', service: null, from: MUC, to: MUC, departMin: 680, arriveMin: 685, intermediateStops: 0 },
      { mode: 'rail', service: 'B', from: MUC, to: WIEN, departMin: 700, arriveMin: 800, intermediateStops: 1 },
    ],
  });
  const r = ribbonFor(withWalk, timeAxis([withWalk], 0), 20260901);
  assert.equal(r.legs.length, 2);
  assert.deepEqual(r.legs.map((l) => l.service), ['A', 'B']);
});

/* ---------- sorting ---------- */

test('the sleep sort appears only when something can be slept through', () => {
  const noSleep = [j({ depart: 600, arrive: 800 })];
  assert.deepEqual(sortsFor(noSleep).map((s) => s.key), ['earliest', 'fastest', 'simplest']);

  const withSleep = [j({ depart: 600, arrive: 800 }), j({ depart: 962, arrive: 1860, sleeper: 482 })];
  assert.ok(sortsFor(withSleep).some((s) => s.key === 'sleep'),
    'a control that cannot change the order would lie about what the data holds');
});

test('each sort orders by what it claims', () => {
  const set = [
    j({ depart: 900, arrive: 1000, transfers: 2 }),
    j({ depart: 600, arrive: 900, transfers: 0 }),
    j({ depart: 700, arrive: 760, transfers: 1 }),
  ];
  const by = (k) => [...set].sort(sortsFor(set).find((s) => s.key === k).cmp).map((x) => x.departMin);
  assert.deepEqual(by('earliest'), [600, 700, 900]);
  assert.deepEqual(by('fastest'), [700, 900, 600]);
  assert.deepEqual(by('simplest'), [600, 700, 900]);
});

/* ---------- what darkness can and cannot be trusted to show ---------- */

test('an ordinary daytime corridor gives several identically-lit ribbons', () => {
  // Measured on the real network: Berlin->Munich across the router's 12h
  // window on 15 Sep returns dark = .196 .000 .000 .000 .000 .186 .680 1.000.
  // Four of eight are flat. This test exists so nobody rebuilds the list
  // around darkness as the primary differentiator — length on the shared axis
  // has to carry that read, and this is the evidence why.
  const BERn = { lat: 52.5251, lon: 13.3694 }, MUCn = { lat: 48.1403, lon: 11.5583 };
  const set = [8, 10, 12, 14].map((h) => j({
    depart: h * 60, arrive: h * 60 + 245,
    legs: [{ mode: 'rail', service: `ICE ${h}`, from: BERn, to: MUCn, departMin: h * 60, arriveMin: h * 60 + 245, intermediateStops: 5 }],
  }));
  const axis = timeAxis(set);
  const darks = set.map((x) => ribbonFor(x, axis, 20260915).dark);
  assert.deepEqual(darks, [0, 0, 0, 0],
    'four midday departures are all fully lit, so the sky separates none of them');
});

test('a sleeper is known from the data, never from how dark it looks', () => {
  // The same Zurich->Hamburg sleeper measures dark 1.000 in December and
  // 0.752 in June, when it never reaches true night. Identifying a sleeper by
  // blackness is wrong for a third of the year; hasSleeper is not.
  const ZRH = { lat: 47.3779, lon: 8.5403 }, HAM = { lat: 53.5528, lon: 10.0067 };
  const sleeper = (dateYmd) => {
    const x = j({
      depart: 1303, arrive: 1893, sleeper: 480,
      legs: [{ mode: 'night_rail', service: 'NJ 470', from: ZRH, to: HAM, departMin: 1303, arriveMin: 1893, intermediateStops: 9 }],
    });
    return { j: x, r: ribbonFor(x, timeAxis([x]), dateYmd) };
  };
  const dec = sleeper(20261221);
  const jun = sleeper(20260621);
  assert.ok(dec.r.dark > jun.r.dark + 0.15,
    `the same sleeper must measure much darker in winter: dec ${dec.r.dark.toFixed(3)} vs jun ${jun.r.dark.toFixed(3)}`);
  assert.equal(dec.j.hasSleeper, true);
  assert.equal(jun.j.hasSleeper, true, 'while hasSleeper is identical in both seasons');
});

test('a null coordinate produces no sky rather than a black ribbon', () => {
  // router.js builds the walk to the first station as {name:'Start', lat:null}.
  // A null latitude does not throw: it yields NaN altitudes, and
  // twilightBand(NaN) returns 'night' because NaN fails every > comparison and
  // falls through to the last branch. A midday journey would paint solid black
  // with no error anywhere — the kind of plausible silent failure that ships.
  const withNullStart = j({
    depart: 600, arrive: 800,
    legs: [
      { mode: 'walk', service: null, from: { name: 'Start', lat: null, lon: null }, to: BER, departMin: 600, arriveMin: 610, intermediateStops: 0 },
      { mode: 'rail', service: 'ICE 1', from: { name: 'Start', lat: null, lon: null }, to: MUC, departMin: 610, arriveMin: 800, intermediateStops: 4 },
    ],
  });
  const r = ribbonFor(withNullStart, timeAxis([withNullStart]), 20260915);
  assert.equal(r.dark, 0, 'unknown position must read as no sky, not as night');
  assert.deepEqual(r.bands, []);
});
