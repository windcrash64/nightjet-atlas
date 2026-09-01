import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packCalls, Calls } from './calls.js';

const SERVICES = [
  { c: [[0, 427, 427], [468, 441, 442], [372, 449, 450]] },
  { c: [[91, 600, 601], [12, 640, 640]] },
  { c: [[7, 1400, 1402], [8, 1500, 1505], [9, 1600, 1601], [10, 1700, 1700]] },
];

test('every row survives the pack', () => {
  const calls = packCalls(SERVICES);
  assert.equal(calls.rows, 9);
  for (let si = 0; si < SERVICES.length; si++) {
    assert.equal(calls.count(si), SERVICES[si].c.length);
    for (let ci = 0; ci < SERVICES[si].c.length; ci++) {
      const [s, a, d] = SERVICES[si].c[ci];
      assert.equal(calls.stopAt(si, ci), s);
      assert.equal(calls.arriveAt(si, ci), a);
      assert.equal(calls.departAt(si, ci), d);
    }
  }
});

test('services do not bleed into each other', () => {
  // The whole risk of a CSR layout is an off-by-one in the offsets showing up
  // as one service reading the next one's stops.
  const calls = packCalls(SERVICES);
  assert.equal(calls.stopAt(0, 0), 0);
  assert.equal(calls.stopAt(1, 0), 91, 'service 1 starts at its own first row');
  assert.equal(calls.stopAt(2, 0), 7);
  assert.equal(calls.stopAt(2, 3), 10, 'and reads to its own last row');
});

test('stopsOf is a view of exactly this service', () => {
  const calls = packCalls(SERVICES);
  assert.deepEqual([...calls.stopsOf(0)], [0, 468, 372]);
  assert.deepEqual([...calls.stopsOf(1)], [91, 12]);
  assert.deepEqual([...calls.stopsOf(2)], [7, 8, 9, 10]);
});

test('times past midnight are preserved', () => {
  // GTFS runs past 24:00 for services that cross midnight, so 1440+ is normal
  // and Uint16 must hold it. A Uint8 or a wrapped modulo would silently break
  // every night train in the network.
  const calls = packCalls([{ c: [[1, 1439, 1440], [2, 1500, 2238]] }]);
  assert.equal(calls.arriveAt(0, 0), 1439);
  assert.equal(calls.departAt(0, 0), 1440);
  assert.equal(calls.departAt(0, 1), 2238, 'the observed maximum in the network');
});

test('a missing time falls back to its neighbour, not to zero', () => {
  // Uint16 has no null. Storing 0 for a missing arrival would put the call at
  // midnight and make the service look boardable at any hour.
  const calls = packCalls([{ c: [[1, null, 700], [2, 800, null]] }]);
  assert.equal(calls.arriveAt(0, 0), 700);
  assert.equal(calls.departAt(0, 1), 800);
});

test('an empty service occupies no rows and reads as empty', () => {
  const calls = packCalls([{ c: [] }, { c: [[5, 100, 101]] }]);
  assert.equal(calls.count(0), 0);
  assert.equal(calls.count(1), 1);
  assert.equal(calls.stopAt(1, 0), 5, 'the next service is not shifted by it');
});

test('the packed size is what the memory claim depends on', () => {
  // 8 bytes per row (Int32 stop + two Uint16 times) plus one Int32 offset per
  // service. If a column widens, this fails and the deployment maths changes.
  const calls = packCalls(SERVICES);
  assert.equal(calls.bytes, 9 * 8 + 4 * 4);
});

test('stop indices span the whole network', () => {
  // 189,208 stops means Int32; a Uint16 column would wrap at 65,535 and
  // silently reroute journeys to the wrong stations.
  const calls = packCalls([{ c: [[189208, 10, 11]] }]);
  assert.equal(calls.stopAt(0, 0), 189208);
});

test('a hand-built Calls reads the same way', () => {
  const calls = new Calls(
    Int32Array.from([4, 5]), Uint16Array.from([10, 20]),
    Uint16Array.from([11, 21]), Int32Array.from([0, 2]),
  );
  assert.equal(calls.count(0), 2);
  assert.equal(calls.stopAt(0, 1), 5);
  assert.equal(calls.departAt(0, 1), 21);
});
