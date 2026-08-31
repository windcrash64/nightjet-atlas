/**
 * Search benchmark. Run after any change to the router:
 *   node scripts/bench.mjs
 *
 * Reports cold search latency per corridor, which is what a first-time visitor
 * feels. The server caches results, so this is the worst case, not the typical.
 */
import { readFileSync } from 'node:fs';
import { buildIndex, accessStops, searchWindow } from '../src/lib/router.js';

const ROUTES = [
  ['Berlin → Munich',     [52.5118, 13.3782], [48.1402, 11.5600], 8],
  ['Hamburg → Cologne',   [53.5528, 10.0067], [50.9430,  6.9589], 9],
  ['Frankfurt → Vienna',  [50.1070,  8.6638], [48.1856, 16.3367], 16],
  ['Stuttgart → Leipzig', [48.7838,  9.1817], [51.3456, 12.3823], 8],
  ['Munich → Hamburg',    [48.1402, 11.5600], [53.5528, 10.0067], 7],
];

let t = Date.now();
const net = JSON.parse(readFileSync('src/data/network.json', 'utf8'));
console.log(`load:       ${Date.now() - t}ms  (${net.stops.length.toLocaleString()} stops, ${net.services.length.toLocaleString()} services)`);

t = Date.now();
const index = buildIndex(net);
console.log(`buildIndex: ${Date.now() - t}ms  (once at startup)\n`);

const times = [];
for (const [name, from, to, hour] of ROUTES) {
  const o = accessStops(index, ...from, 4000, 8);
  const d = accessStops(index, ...to, 4000, 8);
  const started = Date.now();
  const js = searchWindow(index, o, d, hour * 60, {
    windowMin: 12 * 60, stepMin: 180, maxRounds: 3, maxJourneys: 8,
  });
  const ms = Date.now() - started;
  times.push(ms);
  const sleepers = js.filter((j) => j.hasSleeper).length;
  const withChanges = js.filter((j) => j.transfers > 0).length;
  console.log(
    `${name.padEnd(22)} ${String(ms).padStart(5)}ms  ${js.length} options` +
    `  (${withChanges} with changes${sleepers ? `, ${sleepers} sleeper` : ''})`,
  );
}

times.sort((a, b) => a - b);
console.log(`\nmedian ${times[Math.floor(times.length / 2)]}ms   worst ${times[times.length - 1]}ms`);
