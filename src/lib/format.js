/**
 * Turning minutes into things a person reads.
 *
 * Extracted from App.jsx so the row component and the app share one
 * implementation. GTFS minutes run past 1440 for services that cross midnight,
 * which is why none of these can be a naive division.
 */

/** 962 -> "16:02". Wraps past midnight; the day offset is reported separately. */
export function hhmm(min) {
  if (min == null) return '--:--';
  const r = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
}

/** How many midnights a minute is past the search date. 1860 -> 1. */
export function dayOffset(min) {
  return Math.floor(min / 1440);
}

/** 898 -> "14h 58m". */
export function dur(min) {
  if (min == null) return 'unavailable';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** Today as YYYY-MM-DD for a date input. Local calendar day, not an instant. */
export function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "2026-09-01" -> 20260901, the compact form the API takes. */
export function isoToYmd(iso) {
  return Number(String(iso).replace(/-/g, '')) || 0;
}

/** 20260901 plus n days, as an ISO string. */
export function isoPlusDays(ymd, n) {
  const d = new Date(Date.UTC(
    Math.floor(ymd / 10000), (Math.floor(ymd / 100) % 100) - 1, ymd % 100,
  ));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * "Today", "Tomorrow", or a short weekday and date.
 *
 * 'en-GB' rather than the browser's locale: the rest of the page is English,
 * and a machine set to another language rendered this one label as "6 Eyl Paz"
 * beside otherwise English copy. Day-before-month also matches how every
 * country in the data writes a date.
 */
export function dayLabel(iso) {
  const today = isoToday();
  if (iso === today) return 'Today';
  const t = new Date(`${today}T00:00:00`);
  t.setDate(t.getDate() + 1);
  const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  if (iso === tomorrow) return 'Tomorrow';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}
