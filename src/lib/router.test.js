import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, stopsNear, search, searchWindow, haversineM, isLongDistance, runsOnDay, dayNumberFor } from './router.js';

/**
 * A tiny hand-built network. Real enough to exercise transfers, walking and
 * sleepers, small enough that every expected answer can be reasoned about by
 * hand — which is what makes a failure here diagnostic rather than mysterious.
 *
 *   A ──ICE1──▶ B ──ICE2──▶ C          (fast, one transfer at B)
 *   A ─────────NJ9─────────▶ C          (slow, overnight, no transfer)
 *   B' is a 300m walk from B            (tests footpath transfers)
 */
function fixture() {
  return {
    stops: [
      { n: 'A Hbf',      y: 52.5251, x: 13.3694 }, // 0
      { n: 'B Hbf',      y: 52.3759, x: 9.7410 },  // 1
      { n: 'C Hbf',      y: 50.9430, x: 6.9589 },  // 2
      { n: 'B Nord',     y: 52.3785, x: 9.7410 },  // 3  ~290m from B Hbf
      { n: 'Far Away',   y: 40.0000, x: 20.0000 }, // 4  unreachable
    ],
    services: [
      { s: 'ICE 1', m: 'rail', o: 'DB', h: 'B', c: [[0, null, 480], [1, 540, 545]] },
      { s: 'ICE 2', m: 'rail', o: 'DB', h: 'C', c: [[1, null, 600], [2, 700, null]] },
      { s: 'NJ 9',  m: 'night_rail', o: 'ÖBB', h: 'C', c: [[0, null, 1200], [2, 1800, null]] },
      { s: 'RE 7',  m: 'rail', o: 'DB', h: 'C', c: [[3, null, 610], [2, 740, null]] },
    ],
  };
}

const idx = buildIndex(fixture());

test('a service class is recognised wherever the feed puts it', () => {
  // Most feeds lead with the class. The Dutch feed appends it to a corridor
  // description — "Rotterdam Centraal <-> Utrecht Centraal IC2800" — and
  // reading only the first word classified every Dutch intercity as local,
  // which left Amsterdam-Rotterdam returning no journeys at all.
  const long = [
    { s: 'ICE 29', m: 'rail' },
    { s: 'FLX20', m: 'rail' },
    { s: 'AVE', m: 'rail' },
    { s: 'Rotterdam Centraal <-> Utrecht Centraal IC2800', m: 'rail' },
    { s: 'Paris-Nord <-> Amsterdam Centraal EST9300', m: 'rail' },
    { s: 'anything at all', m: 'night_rail' },
  ];
  const local = [
    { s: 'S2', m: 'rail' },
    { s: 'RE4', m: 'rail' },
    { s: 'Uitgeest <-> Driebergen-Zeist SPR7400', m: 'rail' },
    { s: '', m: 'rail' },
  ];
  for (const s of long) assert.ok(isLongDistance(s), `${s.s} should be long-distance`);
  for (const s of local) assert.ok(!isLongDistance(s), `${s.s} should be local`);
});

test('haversine matches a known distance', () => {
  // Berlin Hbf to Hamburg Hbf is ~255 km.
  const d = haversineM(52.5251, 13.3694, 53.5528, 10.0067) / 1000;
  assert.ok(d > 250 && d < 260, `expected ~255km, got ${d.toFixed(1)}km`);
});

test('stopsNear finds stops in distance order and respects the radius', () => {
  const near = stopsNear(idx, 52.5251, 13.3694, 5000);
  assert.equal(near[0].idx, 0, 'A Hbf is the nearest stop to itself');
  assert.equal(near[0].distanceM, 0);
  assert.ok(!near.some((n) => n.idx === 4), 'Far Away must be outside the radius');
});

test('finds a direct ride', () => {
  const js = search(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 1, distanceM: 0 }], 400);
  assert.ok(js.length, 'expected a journey A -> B');
  const j = js[0];
  assert.equal(j.transfers, 0);
  assert.equal(j.legs[0].service, 'ICE 1');
  assert.equal(j.departMin, 480);
  assert.equal(j.arriveMin, 540);
});

test('finds a journey requiring one transfer', () => {
  const js = search(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 2, distanceM: 0 }], 400);
  const viaB = js.find((j) => j.legs.some((l) => l.service === 'ICE 2'));
  assert.ok(viaB, 'expected the ICE 1 -> ICE 2 connection');
  assert.equal(viaB.transfers, 1);
  assert.equal(viaB.arriveMin, 700);
});

test('never boards a departure that has already left', () => {
  // Asking to leave after ICE 1 has gone must not return ICE 1.
  const js = search(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 1, distanceM: 0 }], 500);
  assert.ok(!js.some((j) => j.legs.some((l) => l.service === 'ICE 1' && l.departMin === 480)));
});

test('walking transfers between nearby stations are found', () => {
  // A -> B Hbf by ICE 1, walk to B Nord, then RE 7 to C.
  const js = search(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 2, distanceM: 0 }], 400, { maxRounds: 4 });
  const viaWalk = js.find((j) => j.legs.some((l) => l.service === 'RE 7'));
  if (viaWalk) {
    assert.ok(viaWalk.legs.some((l) => l.mode === 'walk'), 'should include the walking leg');
  }
  // Not asserting it is chosen — ICE 2 arrives earlier. The point is the
  // footpath index exists and does not crash the search.
  const walkTargets = [...idx.footTo.subarray(idx.footOffset[1], idx.footOffset[2])];
  assert.ok(walkTargets.includes(3), 'B Hbf and B Nord must be linked');
});

test('a sleeper is detected and its duration measured', () => {
  const js = searchWindow(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 2, distanceM: 0 }], 400, {
    windowMin: 16 * 60, stepMin: 120, maxJourneys: 8,
  });
  const sleeper = js.find((j) => j.hasSleeper);
  assert.ok(sleeper, 'expected the NJ 9 overnight to appear');
  assert.equal(sleeper.sleeperMin, 600, 'NJ 9 runs 1200 -> 1800');
  assert.ok(sleeper.modes.includes('night_rail'));
});

test('price is null on every journey and every leg — always', () => {
  const js = searchWindow(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 2, distanceM: 0 }], 400);
  assert.ok(js.length);
  for (const j of js) {
    assert.equal(j.price, null, 'journey price must be null');
    for (const l of j.legs) assert.equal(l.price, null, 'leg price must be null');
  }
});

test('unreachable destinations return nothing rather than something invented', () => {
  const js = search(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 4, distanceM: 0 }], 400);
  assert.deepEqual(js, []);
});

test('searchWindow surfaces alternatives, not just the single earliest arrival', () => {
  const one = search(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 2, distanceM: 0 }], 400);
  const many = searchWindow(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 2, distanceM: 0 }], 400, {
    windowMin: 16 * 60, stepMin: 120,
  });
  assert.ok(many.length >= one.length, 'a window must not return fewer options than one instant');
  assert.ok(many.length > 1, 'a comparison product needs more than one option');
});

test('results are free of duplicate journeys riding the same services', () => {
  const js = searchWindow(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 2, distanceM: 0 }], 400, {
    windowMin: 16 * 60, stepMin: 60,
  });
  const spines = js.map((j) =>
    j.legs.filter((l) => l.mode !== 'walk').map((l) => `${l.service}@${l.departMin}`).join('>'),
  );
  assert.equal(new Set(spines).size, spines.length, 'every option must be genuinely distinct');
});

test('journeys are returned in departure order', () => {
  const js = searchWindow(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 2, distanceM: 0 }], 400, {
    windowMin: 16 * 60, stepMin: 120,
  });
  for (let i = 1; i < js.length; i++) {
    assert.ok(js[i].departMin >= js[i - 1].departMin, 'departures must be ascending');
  }
});

test('transfer count matches the number of rides minus one', () => {
  const js = searchWindow(idx, [{ idx: 0, distanceM: 0 }], [{ idx: 2, distanceM: 0 }], 400);
  for (const j of js) {
    const rides = j.legs.filter((l) => l.mode !== 'walk').length;
    assert.equal(j.transfers, Math.max(0, rides - 1));
  }
});

/* ---------- operating days ---------- */

/**
 * The same network, but with a calendar: ICE 1 runs only on horizon day 0,
 * NJ 9 only on day 5, and the rest carry no mask at all.
 */
function datedFixture() {
  const f = fixture();
  f.calendarEpoch = 20260901;
  f.calendarDays = 60;
  f.services[0].d = [1 << 0, 0];        // ICE 1: day 0 only
  f.services[2].d = [1 << 5, 0];        // NJ 9:  day 5 only
  f.services[3].d = [0, 1 << 1];        // RE 7:  day 31, in the high half
  // ICE 2 deliberately has no `d` — the "unknown" case.
  return f;
}

test('a service runs only on the days its mask names', () => {
  const i = buildIndex(datedFixture());
  assert.equal(runsOnDay(i, 0, 0), true, 'ICE 1 on day 0');
  assert.equal(runsOnDay(i, 0, 1), false, 'ICE 1 not on day 1');
  assert.equal(runsOnDay(i, 2, 5), true, 'NJ 9 on day 5');
  assert.equal(runsOnDay(i, 2, 0), false, 'NJ 9 not on day 0');
});

test('the high half of the mask is read correctly', () => {
  // Days 30-59 live in a second 30-bit integer. An off-by-30 here would make
  // every service in the second month either always or never run.
  const i = buildIndex(datedFixture());
  assert.equal(runsOnDay(i, 3, 31), true, 'RE 7 on day 31');
  assert.equal(runsOnDay(i, 3, 1), false, 'and not on day 1, the same bit in the low half');
});

test('a service with no calendar entry is treated as running, not as never', () => {
  // 18,398 real services have no mask — SNCF 7,732, NL 5,954 — because their
  // service_id falls outside the horizon. Zeroing them would delete real
  // trains from the answer on the strength of missing metadata.
  const i = buildIndex(datedFixture());
  assert.equal(runsOnDay(i, 1, 0), true);
  assert.equal(runsOnDay(i, 1, 42), true);
});

test('asking for no particular day runs everything', () => {
  const i = buildIndex(datedFixture());
  for (let si = 0; si < 4; si++) assert.equal(runsOnDay(i, si, -1), true);
});

test('a date maps to its horizon day, and out-of-range disables filtering', () => {
  const i = buildIndex(datedFixture());
  assert.equal(dayNumberFor(i, 20260901), 0, 'the epoch itself');
  assert.equal(dayNumberFor(i, 20260906), 5);
  assert.equal(dayNumberFor(i, 20261001), 30, 'across a month boundary');
  // Refusing to answer for a date we have no calendar for would be worse than
  // answering approximately, so -1 means "do not filter".
  assert.equal(dayNumberFor(i, 20260831), -1, 'before the epoch');
  assert.equal(dayNumberFor(i, 20270101), -1, 'past the horizon');
});

test('the search only offers trains that run on the day asked for', () => {
  // The defect this exists to fix, end to end: NJ 9 is the only A->C service
  // and it runs on day 5 alone.
  const i = buildIndex(datedFixture());
  const O = [{ idx: 0, distanceM: 0 }], D = [{ idx: 2, distanceM: 0 }];

  const onDay5 = searchWindow(i, O, D, 1100, { windowMin: 300, dayNumber: 5 });
  assert.ok(onDay5.some((j) => j.legs.some((l) => l.service === 'NJ 9')),
    'the sleeper is offered on the day it runs');

  const onDay1 = searchWindow(i, O, D, 1100, { windowMin: 300, dayNumber: 1 });
  assert.equal(onDay1.some((j) => j.legs.some((l) => l.service === 'NJ 9')), false,
    'and not on a day it does not');
});

test('an undated search still finds everything', () => {
  const i = buildIndex(datedFixture());
  const js = searchWindow(i, [{ idx: 0, distanceM: 0 }], [{ idx: 2, distanceM: 0 }], 400, {
    windowMin: 16 * 60, stepMin: 120,
  });
  assert.ok(js.some((j) => j.legs.some((l) => l.service === 'NJ 9')),
    'no date means no day filter, so the old behaviour is intact');
});
