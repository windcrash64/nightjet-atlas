import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneDominatedJourneys } from './edge-rail.js';

const pairwise = (journeys) => journeys.filter((j) => !journeys.some((p) => p !== j
  && p.departMin >= j.departMin && p.arriveMin + 60 < j.arriveMin && p.transfers <= j.transfers));

test('rail dominance preserves equal-time order, strict sixty-minute boundary and transfer preference', () => {
  const direct = { id: 'direct', departMin: 600, arriveMin: 900, transfers: 0 };
  const tied = { ...direct, id: 'tied' };
  const atBoundary = { id: 'sixty', departMin: 600, arriveMin: 960, transfers: 1 };
  const beaten = { id: 'sixty-one', departMin: 600, arriveMin: 961, transfers: 1 };
  const later = { id: 'later-departure', departMin: 601, arriveMin: 1000, transfers: 0 };
  const moreChanges = { id: 'more-changes', departMin: 601, arriveMin: 850, transfers: 1 };
  const input = [atBoundary, beaten, tied, later, direct, moreChanges];
  const copy = [...input];
  assert.deepEqual(pruneDominatedJourneys(input), pairwise(input));
  assert.deepEqual(pruneDominatedJourneys([atBoundary, direct, tied]), [atBoundary, direct, tied]);
  assert.deepEqual(pruneDominatedJourneys([later, moreChanges]), [later, moreChanges]);
  assert.deepEqual(input, copy);
});

test('rail dominance matches the pairwise specification across generated timetables', () => {
  let state = 246813579;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (let scenario = 0; scenario < 80; scenario++) {
    const count = scenario < 3 ? scenario : 20 + random() % 400;
    const trips = Array.from({ length: count }, (_, id) => {
      const departMin = (random() % 72) * 20;
      return { id, departMin, arriveMin: departMin + 30 + (random() % 60) * 10, transfers: random() % 2 };
    });
    assert.deepEqual(pruneDominatedJourneys(trips), pairwise(trips), `scenario ${scenario}`);
  }
});
