import { readFileSync } from 'node:fs';
import { buildIndex, accessStops, search } from '../src/lib/router.js';
const net = JSON.parse(readFileSync('src/data/network.json','utf8'));
const idx = buildIndex(net);
const O = accessStops(idx, 52.5118, 13.3782, 4000, 8);
const D = accessStops(idx, 48.140, 11.560, 4000, 8);

// One probe, timed per round, with the real code path.
const runs = [];
for (let i = 0; i < 5; i++) {
  const t = Date.now();
  search(idx, O, D, (8 + i*3) * 60, { maxRounds: 3, maxJourneys: 6 });
  runs.push(Date.now() - t);
}
console.log('single search runs:', runs.join('ms, ') + 'ms');
console.log('mean:', (runs.reduce((a,b)=>a+b,0)/runs.length).toFixed(0) + 'ms');

// How big does the frontier get now?
console.log('\nservices with >30 calls:', net.services.filter(s=>s.c.length>30).length);
console.log('total calls:', net.services.reduce((n,s)=>n+s.c.length,0).toLocaleString());
