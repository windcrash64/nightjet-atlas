/**
 * Which days a service actually runs.
 *
 * Without this the planner answers "on some unspecified day". Measured on the
 * German long-distance feed, only 160 of 899 service_ids run all seven days —
 * 82% do not — so offering every trip on every date means offering people
 * Sunday-only trains on a Tuesday.
 *
 * GTFS says this in two files and a feed may use either or both:
 *
 *   calendar.txt        a weekly pattern plus a date range
 *   calendar_dates.txt  exceptions — type 1 adds a date, type 2 removes one
 *
 * The Netherlands and France ship NO calendar.txt at all; every operating day
 * is an explicit type-1 row. Any implementation that reads only the weekly
 * pattern silently drops both countries.
 *
 * Three real format traps, all of which break a positional parser:
 *   - the German feeds order columns `service_id,exception_type,date` while
 *     everyone else writes `service_id,date,exception_type`
 *   - the Swiss feed quotes every field ("1", not 1) and opens with a BOM
 *   - the Spanish header is padded with trailing spaces
 * So: parse by header name, strip quotes and BOM, and trim.
 *
 * Dates are handled as YYYYMMDD integers. That keeps comparison and equality
 * exact, avoids constructing 10.7M Date objects for the Swiss feed, and
 * sidesteps timezones entirely — a GTFS service date is a local calendar day,
 * not an instant.
 */

/** Strip a BOM, surrounding quotes and whitespace from one CSV field. */
export function clean(value) {
  if (value == null) return '';
  return value.replace(/^﻿/, '').trim().replace(/^"(.*)"$/s, '$1').trim();
}

/** Split a header line into cleaned column names. */
export function headerIndex(line) {
  const cols = clean(line).split(',').map(clean);
  const ix = {};
  cols.forEach((c, i) => { ix[c] = i; });
  return ix;
}

/** `20260901` for 2026-09-01. Local calendar day, never an instant. */
export function toYmd(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/** 0 = Monday … 6 = Sunday, matching the column order in calendar.txt. */
export function weekdayIndex(ymd) {
  const y = Math.floor(ymd / 10000);
  const m = Math.floor(ymd / 100) % 100;
  const d = ymd % 100;
  // Zeller-free: construct in UTC so a local DST shift cannot move the day.
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();  // 0 = Sunday
  return (js + 6) % 7;                                      // 0 = Monday
}

const DAY_COLUMNS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

/**
 * Parse calendar.txt into `service_id -> { days, start, end }`.
 * `days` is a 7-element 0/1 array indexed Monday-first.
 */
export function parseCalendar(text) {
  const out = new Map();
  if (!text) return out;
  const lines = text.split(/\r?\n/);
  if (!lines.length) return out;

  const ix = headerIndex(lines[0]);
  if (ix.service_id == null) return out;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = lines[i].split(',');
    const days = DAY_COLUMNS.map((d) => (clean(c[ix[d]]) === '1' ? 1 : 0));
    out.set(clean(c[ix.service_id]), {
      days,
      start: Number(clean(c[ix.start_date])) || 0,
      end: Number(clean(c[ix.end_date])) || 99999999,
    });
  }
  return out;
}

/**
 * Does this weekly rule run on `ymd`?
 * A service outside its own date range does not run, whatever its pattern says.
 */
export function runsByPattern(rule, ymd) {
  if (!rule) return false;
  if (ymd < rule.start || ymd > rule.end) return false;
  return rule.days[weekdayIndex(ymd)] === 1;
}

/**
 * Resolve which services run on one date.
 *
 * `exceptions` is `service_id -> Map(ymd -> 1 | 2)`, as produced by streaming
 * calendar_dates.txt. Type 1 adds the date even when the weekly pattern says
 * no (and even when there is no pattern at all); type 2 removes it. The
 * exception always wins — that is the point of it.
 */
export function servicesOn(calendar, exceptions, ymd) {
  const active = new Set();

  for (const [id, rule] of calendar) {
    if (runsByPattern(rule, ymd)) active.add(id);
  }
  for (const [id, byDate] of exceptions) {
    const kind = byDate.get(ymd);
    if (kind === 1) active.add(id);
    else if (kind === 2) active.delete(id);
  }
  return active;
}
