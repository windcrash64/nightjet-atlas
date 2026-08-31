import { readFileSync } from 'node:fs';
import { buildIndex, accessStops, search } from '../src/lib/router.js';
const net = JSON.parse(readFileSync('src/data/network.json','utf8'));
const idx = buildIndex(net);
const O = accessStops(idx, 52.5118, 13.3782, 4000, 8);
const D = accessStops(idx, 48.140, 11.560, 4000, 8);
console.log('origins', O.length, 'dests', D.length);
for (const rounds of [2,3,4]) {
  const t=Date.now();
  const r = search(idx, O, D, 8*60, { maxRounds: rounds, maxJourneys: 6 });
  console.log(`  maxRounds=${rounds}: ${Date.now()-t}ms -> ${r.length} journeys`);
}
// how many (service,call) pairs does one round actually touch?
let calls=0;
for (const o of O) calls += (idx.byStop.get(o.idx)||[]).length;
console.log('calls at origin stops:', calls);
console.log('footpath entries:', idx.footpaths.size);
