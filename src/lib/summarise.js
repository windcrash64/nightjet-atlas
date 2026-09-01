/**
 * What the list SAYS about itself.
 *
 * Two decisions live here, and both were wrong in the UI before they were
 * pulled out where they could be tested:
 *
 *  - which options deserve a badge, and
 *  - whether the list is really one train repeating.
 *
 * Both are pure functions of the journey array. They are the difference
 * between a list of eight rows and an answer.
 */

/** A journey's chain of services, ignoring the walks at either end. */
export function spineOf(journey) {
  return journey.legs
    .filter((l) => l.mode !== 'walk')
    .map((l) => l.service)
    .join(' > ');
}

/**
 * "Fastest" has to be worth acting on.
 *
 * On Berlin-Munich the label landed on a 4h01m train three minutes quicker
 * than the one leaving an hour earlier — advice to wait an hour to save three
 * minutes. A badge that does not change a decision is noise, so a winner must
 * beat the runner-up by a margin a traveller would actually feel.
 */
export const FASTEST_MARGIN_MIN = 15;

export function badgesFor(journeys) {
  const out = {};
  if (!journeys.length) return out;

  const byDur = [...journeys].sort((a, b) => a.durationMin - b.durationMin);
  if (byDur.length === 1
      || byDur[1].durationMin - byDur[0].durationMin >= FASTEST_MARGIN_MIN) {
    out[journeys.indexOf(byDur[0])] = 'Fastest';
  }

  const direct = journeys.filter((x) => x.transfers === 0)
    .sort((a, b) => a.durationMin - b.durationMin)[0];
  if (direct && out[journeys.indexOf(direct)] == null) {
    out[journeys.indexOf(direct)] = 'No changes';
  }

  const sleeper = journeys.find((x) => x.hasSleeper);
  if (sleeper && out[journeys.indexOf(sleeper)] == null) {
    out[journeys.indexOf(sleeper)] = 'Sleep through it';
  }
  return out;
}

/**
 * A corridor served by one train all day produces a list where most rows are
 * the same journey at a different time. That reads as a bug, and the honest
 * answer is a fact about the corridor: which service dominates it, and how
 * often it goes.
 *
 * Berlin-Munich forced this. Six of eight rows were ICE 29, but ICE 28 and
 * ICE 91 in the mix meant the previous all-rows-identical test never fired —
 * so the list explained itself only in the trivial case, and stayed silent
 * exactly when it looked most repetitive.
 *
 * Returns null when no single service dominates; the list speaks for itself.
 */
export function cadenceOf(journeys) {
  if (journeys.length < 4) return null;

  const runs = new Map();
  for (const x of journeys) {
    const s = spineOf(x);
    runs.set(s, (runs.get(s) || 0) + 1);
  }
  const [spine, count] = [...runs].sort((a, b) => b[1] - a[1])[0];
  if (count < 3 || count / journeys.length < 0.5) return null;

  // Median gap, not mean: one long evening gap should not report a corridor as
  // less frequent than it is for most of the day.
  const times = journeys.filter((x) => spineOf(x) === spine)
    .map((x) => x.departMin)
    .sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];

  const every = med < 45 ? 'every half hour or so'
    : med < 80 ? 'about hourly'
    : `about every ${Math.round(med / 60)} hours`;

  return { spine, count, total: journeys.length, every, medianGapMin: med };
}
