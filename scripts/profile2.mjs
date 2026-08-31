import { readFileSync } from 'node:fs';
import { buildIndex, accessStops, search } from '../src/lib/router.js';
const net = JSON.parse(readFileSync('src/data/network.json','utf8'));
const idx = buildIndex(net);
const O = accessStops(idx, 52.5118, 13.3782, 4000, 8);
const D = accessStops(idx, 48.140, 11.560, 4000, 8);

// Where does one search spend its time?
const t0=Date.now();
const r = search(idx, O, D, 8*60, { maxRounds: 3, maxJourneys: 6 });
console.log(`one search: ${Date.now()-t0}ms`);

// How many (service,call) pairs exist at the busiest stops we start from?
let total=0, worst=0, worstName='';
for (const o of O) {
  const n = (idx.byStop.get(o.idx)||[]).length;
  total += n;
  if (n > worst) { worst = n; worstName = net.stops[o.idx].n; }
}
console.log(`origin stop calls: total=${total} worst=${worst} (${worstName})`);

// The real question: how many services does round 0 scan?
let scanned = 0;
for (const o of O) scanned += (idx.byStop.get(o.idx)||[]).length;
console.log(`round-0 boarding candidates: ${scanned}`);

// And how many stops does the frontier reach after round 0?
console.log(`stops in network: ${net.stops.length}, services: ${net.services.length}`);
const avgCalls = net.services.reduce((n,s)=>n+s.c.length,0)/net.services.length;
console.log(`avg calls per service: ${avgCalls.toFixed(1)}`);
