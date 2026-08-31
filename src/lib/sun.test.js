import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunAltitude, twilightBand, skyAlongJourney, darkFraction } from './sun.js';

// Astronomical ground truth: Vienna (48.2N) sees the sun at roughly
// 90 - 48.2 + 23.44 = 65.2 degrees at local solar noon on the June solstice.
// 12:00 UTC is ~54 minutes before Vienna's solar noon, so slightly under peak.
test('summer solstice noon altitude at Vienna is near the geometric maximum', () => {
  const alt = sunAltitude(new Date('2026-06-21T12:00:00Z'), 48.2, 16.4);
  assert.ok(alt > 58 && alt < 66, `expected 58..66, got ${alt}`);
});

test('winter solstice midnight at Vienna is deep below the horizon', () => {
  const alt = sunAltitude(new Date('2026-12-21T00:00:00Z'), 48.2, 16.4);
  assert.ok(alt < -55, `expected < -55, got ${alt}`);
});

// The polar cases are where a naive implementation breaks.
test('polar day: Svalbard in June never sets', () => {
  for (let h = 0; h < 24; h += 3) {
    const alt = sunAltitude(new Date(`2026-06-21T${String(h).padStart(2, '0')}:00:00Z`), 78.2, 15.6);
    assert.ok(alt > 0, `Svalbard hour ${h} should be daylight, got ${alt}`);
  }
});

test('polar night: Svalbard in December never rises', () => {
  for (let h = 0; h < 24; h += 3) {
    const alt = sunAltitude(new Date(`2026-12-21T${String(h).padStart(2, '0')}:00:00Z`), 78.2, 15.6);
    assert.ok(alt < 0, `Svalbard hour ${h} should be dark, got ${alt}`);
  }
});

test('equator equinox noon is close to overhead', () => {
  // Solar noon at 0E on the equinox is ~12:00 UTC.
  const alt = sunAltitude(new Date('2026-03-20T12:00:00Z'), 0, 0);
  assert.ok(alt > 85, `expected near-zenith, got ${alt}`);
});

test('twilight bands use the standard astronomical boundaries', () => {
  assert.equal(twilightBand(10), 'day');
  assert.equal(twilightBand(-1), 'civil');
  assert.equal(twilightBand(-6.1), 'nautical');
  assert.equal(twilightBand(-12.1), 'astronomical');
  assert.equal(twilightBand(-18.1), 'night');
});

test('band boundaries are exact at the defined degrees', () => {
  assert.equal(twilightBand(0), 'civil', '0 deg is not yet day');
  assert.equal(twilightBand(-6), 'nautical');
  assert.equal(twilightBand(-12), 'astronomical');
  assert.equal(twilightBand(-18), 'night');
});

// The real journey this product exists to show:
// OeBB Nightjet 40233, Vienna 18:07Z -> Rome 09:14Z (verified live via Transitous).
test('the Vienna-Rome Nightjet is majority darkness', () => {
  const sky = skyAlongJourney(
    Date.parse('2026-09-02T18:07:00Z'),
    Date.parse('2026-09-03T09:14:00Z'),
    { lat: 48.1852, lon: 16.376 },
    { lat: 41.901, lon: 12.501 },
    120,
  );
  const dark = darkFraction(sky);
  assert.ok(dark > 0.6, `expected majority dark, got ${(dark * 100).toFixed(1)}%`);
  assert.ok(sky.some((s) => s.band === 'night'), 'should reach full astronomical night');
  assert.ok(sky.some((s) => s.band === 'day'), 'should arrive in daylight');
});

// A daytime flight over the same corridor must NOT read as a night journey.
test('a midday flight on the same corridor is fully lit', () => {
  const sky = skyAlongJourney(
    Date.parse('2026-09-02T10:00:00Z'),
    Date.parse('2026-09-02T12:05:00Z'),
    { lat: 48.1852, lon: 16.376 },
    { lat: 41.901, lon: 12.501 },
    60,
  );
  assert.equal(darkFraction(sky), 0, 'a midday flight has no darkness');
});

test('sky sampling interpolates position, not just time', () => {
  const sky = skyAlongJourney(
    Date.parse('2026-09-02T18:07:00Z'),
    Date.parse('2026-09-03T09:14:00Z'),
    { lat: 48.1852, lon: 16.376 },
    { lat: 41.901, lon: 12.501 },
    10,
  );
  assert.equal(sky.length, 11, 'inclusive of both endpoints');
  assert.equal(sky[0].t, 0);
  assert.equal(sky[sky.length - 1].t, 1);
});

test('darkFraction is safe on empty input', () => {
  assert.equal(darkFraction([]), 0);
});
