import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgesFor, cadenceOf, spineOf, FASTEST_MARGIN_MIN } from './summarise.js';

/** A journey, shaped like the router's output but only as far as these rules read. */
function j({ depart = 600, dur = 240, transfers = 0, sleeper = false, services = ['ICE 29'] }) {
  return {
    departMin: depart,
    arriveMin: depart + dur,
    durationMin: dur,
    transfers,
    hasSleeper: sleeper,
    legs: [
      { mode: 'walk', service: null },
      ...services.map((s) => ({ mode: sleeper ? 'night_rail' : 'rail', service: s })),
      { mode: 'walk', service: null },
    ],
  };
}

/* ---------- spineOf ---------- */

test('the spine ignores the walks at either end', () => {
  assert.equal(spineOf(j({ services: ['IC 480', 'NJ 470'] })), 'IC 480 > NJ 470');
});

/* ---------- badgesFor ---------- */

test('a single option is always the fastest one', () => {
  const list = [j({ dur: 200 })];
  assert.equal(badgesFor(list)[0], 'Fastest');
});

test('Fastest is withheld when the win is trivial', () => {
  // Paris-Marseille, live: 3h04m against 3h11m. Seven minutes is not a reason
  // to take a different train, so the label would be pointing at nothing.
  const list = [j({ depart: 550, dur: 184 }), j({ depart: 682, dur: 191 })];
  const b = badgesFor(list);
  assert.equal(Object.values(b).includes('Fastest'), false);
  assert.equal(b[0], 'No changes', 'the row still earns a badge it deserves');
});

test('Fastest is awarded when the win is real', () => {
  // Zurich-Hamburg, live: 7h23m against 8h23m. A full hour is worth the wait.
  const list = [j({ depart: 1177, dur: 503, transfers: 1 }), j({ depart: 1237, dur: 443, transfers: 1 })];
  assert.equal(badgesFor(list)[1], 'Fastest');
});

test('the margin is inclusive at its boundary', () => {
  // Madrid-Barcelona, live: 3h02m against 3h17m is exactly 15 minutes, and the
  // label held. A test at the boundary stops a later ">" / ">=" edit from
  // silently changing which corridors explain themselves.
  const list = [j({ dur: 182 }), j({ dur: 182 + FASTEST_MARGIN_MIN })];
  assert.equal(badgesFor(list)[0], 'Fastest');

  const narrower = [j({ dur: 182 }), j({ dur: 182 + FASTEST_MARGIN_MIN - 1 })];
  assert.equal(Object.values(badgesFor(narrower)).includes('Fastest'), false);
});

test('one row never carries two badges', () => {
  const list = [j({ dur: 200, transfers: 0 }), j({ dur: 400, transfers: 2 })];
  const b = badgesFor(list);
  assert.equal(b[0], 'Fastest');
  assert.equal(b[1], undefined, 'the slow two-change option earns nothing');
});

test('the sleeper is labelled even when it is neither fastest nor direct', () => {
  const list = [
    j({ dur: 300, transfers: 0 }),
    j({ dur: 700, transfers: 1, sleeper: true, services: ['IC 480', 'NJ 470'] }),
  ];
  assert.equal(badgesFor(list)[1], 'Sleep through it');
});

test('an empty list produces no badges rather than throwing', () => {
  assert.deepEqual(badgesFor([]), {});
});

/* ---------- cadenceOf ---------- */

test('a short list is left to speak for itself', () => {
  assert.equal(cadenceOf([j({}), j({ depart: 660 }), j({ depart: 720 })]), null);
});

test('the dominant service is named even when others are in the mix', () => {
  // The live Berlin-Munich answer: five ICE 29 among eight, with ICE 28 and
  // ICE 91 present. The previous rule required EVERY row to match and so said
  // nothing here — the exact case it was written for.
  const list = [
    j({ depart: 515, services: ['ICE 28'], dur: 273 }),
    j({ depart: 522, dur: 244 }),
    j({ depart: 582, dur: 241 }),
    j({ depart: 633, services: ['ICE 28'], dur: 273 }),
    j({ depart: 643, dur: 243 }),
    j({ depart: 702, dur: 241 }),
    j({ depart: 755, services: ['ICE 91'], dur: 274 }),
    j({ depart: 763, dur: 242 }),
  ];
  const c = cadenceOf(list);
  assert.equal(c.spine, 'ICE 29');
  assert.equal(c.count, 5);
  assert.equal(c.total, 8);
  assert.equal(c.every, 'about hourly');
});

test('a genuinely varied list gets no note', () => {
  // Paris-Marseille, live: four distinct spines across six options. Claiming
  // one service runs the corridor would be false.
  const list = [
    j({ services: ["Paris - Côte d'Azur TGV"] }),
    j({ depart: 550, services: ["Paris - Côte d'Azur TGV", 'C2'], transfers: 1 }),
    j({ depart: 578, services: ['Paris - Marseille - Toulon TGV'] }),
    j({ depart: 600, services: ['631B'] }),
    j({ depart: 682, services: ["Paris - Côte d'Azur TGV"] }),
  ];
  assert.equal(cadenceOf(list), null, 'no service holds half the list');
});

test('the median gap ignores one long outlier', () => {
  // Four departures an hour apart, then a five-hour evening gap. The mean
  // would report the corridor as roughly two-hourly, which is wrong for
  // almost the whole day.
  const list = [
    j({ depart: 480 }), j({ depart: 540 }), j({ depart: 600 }),
    j({ depart: 660 }), j({ depart: 960 }),
  ];
  const c = cadenceOf(list);
  assert.equal(c.medianGapMin, 60);
  assert.equal(c.every, 'about hourly');
});

test('a frequent corridor is described as such', () => {
  const list = [j({ depart: 480 }), j({ depart: 510 }), j({ depart: 540 }), j({ depart: 570 })];
  assert.equal(cadenceOf(list).every, 'every half hour or so');
});

test('a sparse corridor reports its real spacing', () => {
  const list = [j({ depart: 360 }), j({ depart: 540 }), j({ depart: 720 }), j({ depart: 900 })];
  assert.equal(cadenceOf(list).every, 'about every 3 hours');
});

test('a service holding exactly half the list still counts', () => {
  const list = [
    j({ depart: 480 }), j({ depart: 540 }), j({ depart: 600 }),
    j({ depart: 660, services: ['ICE 28'] }),
    j({ depart: 720, services: ['ICE 91'] }),
    j({ depart: 780, services: ['ICE 12'] }),
  ];
  const c = cadenceOf(list);
  assert.equal(c.spine, 'ICE 29');
  assert.equal(c.count, 3);
});
