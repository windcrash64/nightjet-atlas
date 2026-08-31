import { useEffect, useId, useMemo, useState } from 'react';
import { skyAlongJourney, darkFraction } from '../lib/sun.js';

/**
 * A Marey/Ibry graphical train schedule (1878) for a single journey.
 *
 * Time runs left to right; distance travelled runs bottom to top. The slope of
 * the line is speed; a horizontal step is a stop or transfer. Behind it, the
 * real computed sky at the traveller's moving position — civil, nautical and
 * astronomical twilight are the standard unequal bands, not a decorative
 * gradient.
 *
 * The whole argument of this product is in this picture: a night train draws a
 * long line through the dark and lands in the morning. A day journey draws a
 * short scratch across the light.
 */

const BAND_FILL = {
  day: 'var(--sky-day)',
  civil: 'var(--sky-civil)',
  nautical: 'var(--sky-nautical)',
  astronomical: 'var(--sky-astronomical)',
  night: 'var(--sky-night)',
};

// Generous top/right inset so the arrival point never collides with the frame —
// the last stop is the payoff of the picture and needs air around it.
const PAD = { top: 40, right: 46, bottom: 44, left: 30 };

// A 900x340 box is right on a desktop, but scaled into a 358px-wide phone it
// becomes ~135px tall and every label turns into an unreadable speck. Below
// 720px the chart uses a squarer box so the drawing keeps real height.
const DESKTOP = { w: 900, h: 340 };
const MOBILE = { w: 420, h: 300 };

function useChartBox() {
  const [narrow, setNarrow] = useState(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow ? MOBILE : DESKTOP;
}

function haversineKm(a, b) {
  if (!a?.lat || !b?.lat) return 0;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export default function Stringline({ itinerary, from, to, reducedMotion }) {
  const { w: W, h: H } = useChartBox();
  // Six charts share one page; a duplicated clipPath id makes every chart clip
  // to the first one's geometry.
  const clipId = useId();

  const model = useMemo(() => {
    const startMs = Date.parse(itinerary.departure);
    const endMs = Date.parse(itinerary.arrival);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

    const span = endMs - startMs;
    const sky = skyAlongJourney(startMs, endMs, from, to, 240);

    // Cumulative distance so the y-axis is real ground covered, which is what
    // makes slope mean speed.
    let cum = 0;
    const points = [];
    for (const leg of itinerary.legs) {
      const d = haversineKm(leg.from, leg.to);
      const legStart = Date.parse(leg.departure);
      const legEnd = Date.parse(leg.arrival);
      if (!Number.isFinite(legStart) || !Number.isFinite(legEnd)) continue;
      points.push({ ms: legStart, km: cum, leg });
      cum += d;
      points.push({ ms: legEnd, km: cum, leg });
    }
    const totalKm = Math.max(cum, 1);

    const x = (ms) => PAD.left + ((ms - startMs) / span) * (W - PAD.left - PAD.right);
    const y = (km) => H - PAD.bottom - (km / totalKm) * (H - PAD.top - PAD.bottom);

    // Contiguous runs of the same twilight band become one rect each. Each band
    // must END where the next BEGINS — otherwise a one-sample gap opens between
    // them and the sky renders as stripes instead of a continuous dusk.
    const bands = [];
    for (const s of sky) {
      const last = bands[bands.length - 1];
      if (last && last.band === s.band) last.endMs = s.ms;
      else {
        if (last) last.endMs = s.ms;
        bands.push({ band: s.band, startMs: last ? s.ms : startMs, endMs: s.ms });
      }
    }
    if (bands.length) bands[bands.length - 1].endMs = endMs;

    // Midnight markers — the axis the product is really about.
    const midnights = [];
    const d = new Date(startMs);
    d.setUTCHours(24, 0, 0, 0);
    while (d.getTime() < endMs) {
      midnights.push(d.getTime());
      d.setUTCDate(d.getUTCDate() + 1);
    }

    return { startMs, endMs, span, sky, points, totalKm, x, y, bands, midnights,
             dark: darkFraction(sky) };
  }, [itinerary, from, to, W, H]);

  if (!model) {
    return <p className="stringline-unavailable">This journey has no usable times to draw.</p>;
  }

  const { points, x, y, bands, midnights, dark } = model;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.ms).toFixed(1)} ${y(p.km).toFixed(1)}`).join(' ');
  const sleeperSegments = [];
  for (let i = 0; i < points.length - 1; i += 2) {
    if (points[i].leg?.isSleeper) {
      const x1 = x(points[i].ms), y1 = y(points[i].km);
      const x2 = x(points[i + 1].ms), y2 = y(points[i + 1].km);
      sleeperSegments.push({
        d: `M ${x1} ${y1} L ${x2} ${y2}`,
        midX: (x1 + x2) / 2,
        midY: (y1 + y2) / 2,
        // Run the label along the line, as a Marey chart labels its trains.
        angle: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI,
        leg: points[i].leg,
      });
    }
  }

  return (
    <figure className="stringline">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
           preserveAspectRatio="xMidYMid meet"
           aria-label={`Journey diagram: ${Math.round(dark * 100)} percent of this journey is after dark.`}>
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right}
                  height={H - PAD.top - PAD.bottom} />
          </clipPath>
        </defs>

        <g clipPath={`url(#${clipId})`}>
          {bands.map((b, i) => (
            <rect key={i} x={x(b.startMs)} y={PAD.top}
                  width={Math.max(0.6, x(b.endMs) - x(b.startMs))}
                  height={H - PAD.top - PAD.bottom}
                  fill={BAND_FILL[b.band]} />
          ))}

          {midnights.map((ms) => (
            <g key={ms}>
              <line x1={x(ms)} x2={x(ms)} y1={PAD.top} y2={H - PAD.bottom}
                    className="midnight-rule" />
              <text x={x(ms) + 6} y={PAD.top + 13} className="midnight-label">midnight</text>
            </g>
          ))}

          <path d={path} className={`journey-line${reducedMotion ? '' : ' journey-line--draw'}`} />

          {sleeperSegments.map((s, i) => (
            <g key={i}>
              <path d={s.d} className="journey-line journey-line--sleeper" />
              {/* Name the gold line on the chart itself. An unlabelled colour
                  makes the reader do work the picture should do for them. */}
              <text x={s.midX} y={s.midY - 18} textAnchor="middle" className="sleeper-label"
                    transform={`rotate(${s.angle} ${s.midX} ${s.midY - 18})`}>
                {s.leg.service ? `asleep · ${s.leg.service}` : 'asleep'}
              </text>
            </g>
          ))}

          {points.filter((p, i) => i % 2 === 0).map((p, i) => (
            <circle key={i} cx={x(p.ms)} cy={y(p.km)} r="3.5" className="stop-dot" />
          ))}
        </g>

        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom}
              className="axis" />
        <text x={PAD.left} y={H - 18} className="axis-label">
          {new Date(model.startMs).toUTCString().slice(17, 22)}
        </text>
        <text x={W - PAD.right} y={H - 18} textAnchor="end" className="axis-label">
          {new Date(model.endMs).toUTCString().slice(17, 22)}
        </text>
      </svg>

      <figcaption>
        Time runs left to right, distance bottom to top — the slope is speed, a
        flat step is a stop. Sky bands are computed from the sun&rsquo;s real
        position along the route.
      </figcaption>
    </figure>
  );
}
