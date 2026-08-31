/**
 * Solar position math — used to compute real twilight bands behind a journey.
 *
 * Everything here is pure: given a UTC instant and a lat/lon, it returns the
 * sun's altitude in degrees. No network, no API key, no map tiles. That matters
 * because the twilight bands are the background of the whole product, and they
 * have to be right at any point on Earth without asking anyone's permission.
 *
 * Algorithm: NOAA solar position (low-precision), which is accurate to well
 * under a degree — far finer than the 6° bands we draw with it.
 * Reference: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
 */

const RAD = Math.PI / 180;

/** Days (fractional) since the J2000.0 epoch, 2000-01-01T12:00:00Z. */
function daysSinceJ2000(date) {
  return date.getTime() / 86400000 - 10957.5;
}

/**
 * Sun altitude in degrees above the horizon.
 * Negative values are below the horizon — which is where twilight lives.
 */
export function sunAltitude(date, lat, lon) {
  const d = daysSinceJ2000(date);

  // Mean anomaly and ecliptic longitude of the sun.
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;

  // Obliquity of the ecliptic.
  const e = (23.439 - 0.00000036 * d) * RAD;

  // Right ascension and declination.
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));

  // Greenwich mean sidereal time -> local hour angle.
  const gmst = 18.697374558 + 24.06570982441908 * d;
  const lst = ((gmst % 24) + 24) % 24 * 15 * RAD + lon * RAD;
  const ha = lst - ra;

  const phi = lat * RAD;
  const alt = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha),
  );
  return alt / RAD;
}

/**
 * Twilight band for a sun altitude, using the standard astronomical
 * definitions. These bands are unequal on purpose — they are earned
 * divisions of the real sky, not a decorative gradient.
 * https://www.timeanddate.com/astronomy/different-types-twilight.html
 */
export function twilightBand(altitudeDeg) {
  if (altitudeDeg > 0) return 'day';
  if (altitudeDeg > -6) return 'civil';
  if (altitudeDeg > -12) return 'nautical';
  if (altitudeDeg > -18) return 'astronomical';
  return 'night';
}

/**
 * Samples the sky along a journey. Position is interpolated between the
 * endpoints so the bands follow the traveller, not a fixed city — an
 * eastbound night train really does meet dawn earlier than its origin does.
 */
export function skyAlongJourney(startMs, endMs, from, to, samples = 160) {
  const out = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const when = new Date(startMs + (endMs - startMs) * t);
    const lat = from.lat + (to.lat - from.lat) * t;
    const lon = from.lon + (to.lon - from.lon) * t;
    const alt = sunAltitude(when, lat, lon);
    out.push({ t, ms: when.getTime(), altitude: alt, band: twilightBand(alt) });
  }
  return out;
}

/** Fraction of a journey spent with the sun below the horizon. */
export function darkFraction(sky) {
  if (!sky.length) return 0;
  const dark = sky.filter((s) => s.altitude <= 0).length;
  return dark / sky.length;
}
