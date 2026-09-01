/**
 * One journey, drawn on the shared clock face.
 *
 * The three commitments, in the order that decides conflicts:
 *   1. Times and duration are TEXT, read instantly, never encoded only as
 *      position. They live in fixed columns either side of the track, never on
 *      the sky — which structurally removes the whole contrast-over-gradient
 *      risk rather than tuning around it. (Ink on the night band measured
 *      1.09:1. It cannot be mitigated, only avoided.)
 *   2. Duration is ALSO a length on the shared axis, so the set compares
 *      without arithmetic.
 *   3. The sky is atmosphere and a sortable fact, never the sole carrier of
 *      meaning — four of eight Berlin-Munich departures measure identically
 *      lit, so a design that leans on darkness alone says nothing on an
 *      ordinary daytime corridor.
 */

import { hhmm, dayOffset, dur } from '../lib/format.js';

const MODE_CLASS = {
  night_rail: 'leg--night_rail',
  ferry: 'leg--ferry',
  walk: 'leg--walk',
};

/**
 * Which ink a leg stroke takes, decided by what is underneath it.
 *
 * The losing concepts coloured strokes by mode while the fill varied by hour —
 * two independent variables painted on the same pixels, which measured 1.09:1
 * where ink met the night band. Mode is carried by weight and dash instead,
 * and the stroke simply flips to paper over the dark bands.
 */
function inkOver(bands, left, width) {
  const mid = left + width / 2;
  const under = bands.find((b) => mid >= b.start && mid <= b.end);
  return under && (under.band === 'astro' || under.band === 'night') ? ' leg--onDark' : '';
}

export default function JourneyRow({ journey, ribbon, badge, active, onSelect, onHover }) {
  const plus = dayOffset(journey.arriveMin) - dayOffset(journey.departMin);
  const pct = (n) => `${(n * 100).toFixed(3)}%`;

  return (
    <button
      type="button"
      className="row"
      aria-pressed={active}
      onClick={onSelect}
      onMouseEnter={onHover ? () => onHover(true) : undefined}
      onMouseLeave={onHover ? () => onHover(false) : undefined}
      onFocus={onHover ? () => onHover(true) : undefined}
      onBlur={onHover ? () => onHover(false) : undefined}
    >
      <span className="row-when">
        {badge && <span className="row-badge num">{badge}</span>}
        <span className="row-depart num">{hhmm(journey.departMin)}</span>
        <span className="row-arrive num">
          {hhmm(journey.arriveMin)}
          {plus > 0 && <sup className="row-plus num">+{plus}</sup>}
        </span>
      </span>

      <span className="track">
        <span
          className="ribbon"
          style={{ left: pct(ribbon.left), width: pct(ribbon.width) }}
        >
          {ribbon.bands.map((b, i) => (
            <span
              key={i}
              className={`band band--${b.band}`}
              style={{ left: pct(b.start), width: pct(b.end - b.start) }}
            />
          ))}
        </span>

        {/* Legs sit on the sky at their true extent, so the gaps between them
            ARE the transfers: a three-change journey is visibly broken up and
            a direct one is one unbroken bar. */}
        {ribbon.legs.map((l, i) => {
          const within = (l.left - ribbon.left) / ribbon.width;
          const wide = l.width / ribbon.width;
          return (
            <span
              key={i}
              className={`leg ${MODE_CLASS[l.mode] ?? ''}${inkOver(ribbon.bands, within, wide)}`}
              style={{ left: pct(l.left), width: pct(l.width) }}
            />
          );
        })}
      </span>

      <span className="row-right">
        <span className="row-dur num">{dur(journey.durationMin)}</span>
        <span className="row-meta">
          {journey.transfers === 0
            ? 'direct'
            : `${journey.transfers} change${journey.transfers > 1 ? 's' : ''}`}
          {journey.hasSleeper && (
            <>
              <br />
              <span className="row-sleep num">{dur(journey.sleeperMin)} asleep</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}
