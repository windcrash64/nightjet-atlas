import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clean, headerIndex, toYmd, weekdayIndex,
  parseCalendar, runsByPattern, servicesOn,
} from './calendar.js';

/* ---------- field cleaning: every case here is a real feed ---------- */

test('quoted fields are unwrapped', () => {
  // The Swiss feed writes every value as "1", so a naive Number() gives NaN
  // and every service silently reads as not-running.
  assert.equal(clean('"1"'), '1');
  assert.equal(clean('"TA+00000"'), 'TA+00000');
});

test('a BOM on the first header cell is stripped', () => {
  // ch-national/calendar.txt opens with a BOM, which would make the first
  // column name "﻿service_id" and every lookup miss.
  const ix = headerIndex('﻿service_id,date,exception_type');
  assert.equal(ix.service_id, 0);
  assert.equal(ix.exception_type, 2);
});

test('padded headers still resolve', () => {
  // es-renfe pads its header line with trailing spaces.
  const ix = headerIndex('service_id,date,exception_type          ');
  assert.equal(ix.exception_type, 2);
});

test('column ORDER is never assumed', () => {
  // The German feeds write service_id,exception_type,date while everyone else
  // writes service_id,date,exception_type. Reading column 3 as the exception
  // type gets a date in Germany — the bug this test exists to prevent.
  const de = headerIndex('service_id,exception_type,date');
  const nl = headerIndex('service_id,date,exception_type');
  assert.equal(de.exception_type, 1);
  assert.equal(nl.exception_type, 2);
  assert.equal(de.date, 2);
  assert.equal(nl.date, 1);
});

/* ---------- dates ---------- */

test('a date becomes a comparable integer', () => {
  assert.equal(toYmd(new Date(2026, 8, 1)), 20260901);
  assert.equal(toYmd(new Date(2026, 11, 31)), 20261231);
});

test('weekdays are Monday-first, matching calendar.txt column order', () => {
  assert.equal(weekdayIndex(20260831), 0, '2026-08-31 is a Monday');
  assert.equal(weekdayIndex(20260901), 1, 'Tuesday');
  assert.equal(weekdayIndex(20260905), 5, 'Saturday');
  assert.equal(weekdayIndex(20260906), 6, 'Sunday');
});

/* ---------- weekly patterns ---------- */

const CAL = parseCalendar(
  'monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date,service_id\n'
  + '0,0,0,0,0,0,1,20260829,20260906,sunday-only\n'
  + '1,1,1,1,1,0,0,20260101,20261231,weekdays\n'
  + '1,1,1,1,1,1,1,20260101,20261231,daily\n',
);

test('the German column order in calendar.txt is read by name', () => {
  // de-longdistance puts service_id LAST. Position-based parsing would read
  // "0" as the service id for every row and collapse the whole map to one key.
  assert.equal(CAL.size, 3);
  assert.ok(CAL.has('sunday-only'));
});

test('a Sunday-only service does not run on a Tuesday', () => {
  // The defect this whole module exists to fix: 82% of German long-distance
  // service_ids do not run daily, and the planner was offering all of them
  // on every date.
  assert.equal(runsByPattern(CAL.get('sunday-only'), 20260901), false, 'Tuesday');
  assert.equal(runsByPattern(CAL.get('sunday-only'), 20260906), true, 'Sunday');
});

test('a service outside its date range does not run, pattern regardless', () => {
  // sunday-only ends 20260906. The Sunday after is still a Sunday.
  assert.equal(runsByPattern(CAL.get('sunday-only'), 20260913), false);
});

test('weekday services stop at the weekend', () => {
  assert.equal(runsByPattern(CAL.get('weekdays'), 20260904), true, 'Friday');
  assert.equal(runsByPattern(CAL.get('weekdays'), 20260905), false, 'Saturday');
});

test('a missing rule is not a running service', () => {
  assert.equal(runsByPattern(undefined, 20260901), false);
});

/* ---------- exceptions ---------- */

test('type 1 adds a date the pattern excludes', () => {
  const ex = new Map([['weekdays', new Map([[20260905, 1]])]]);
  const on = servicesOn(CAL, ex, 20260905);   // a Saturday
  assert.ok(on.has('weekdays'), 'the exception wins over the pattern');
});

test('type 2 removes a date the pattern includes', () => {
  const ex = new Map([['daily', new Map([[20260901, 2]])]]);
  assert.equal(servicesOn(CAL, ex, 20260901).has('daily'), false);
});

test('a service with no weekly pattern at all still runs on its listed dates', () => {
  // The Netherlands and France ship NO calendar.txt. Every operating day is a
  // type-1 row. Reading only calendar.txt drops both countries entirely.
  const ex = new Map([['nl-only', new Map([[20260901, 1]])]]);
  const on = servicesOn(new Map(), ex, 20260901);
  assert.ok(on.has('nl-only'));
  assert.equal(servicesOn(new Map(), ex, 20260902).has('nl-only'), false);
});

test('an exception on another date leaves this one alone', () => {
  const ex = new Map([['daily', new Map([[20260902, 2]])]]);
  assert.ok(servicesOn(CAL, ex, 20260901).has('daily'));
});

test('the whole set resolves for one day', () => {
  const on = servicesOn(CAL, new Map(), 20260906);   // a Sunday
  assert.deepEqual([...on].sort(), ['daily', 'sunday-only']);
});

test('an empty feed resolves to no services rather than throwing', () => {
  assert.equal(parseCalendar('').size, 0);
  assert.equal(servicesOn(new Map(), new Map(), 20260901).size, 0);
});
