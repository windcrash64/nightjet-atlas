import { readFileSync } from 'node:fs';
import { buildIndex, accessStops, search } from '../src/lib/router.js';
const net = JSON.parse(readFileSync('src/data/network.json','utf8'));

let t = Date.now();
const idx = buildIndex(net);
console.log(`buildIndex: ${Date.now()-t}ms  (once at startup, not per query)`);

const O = accessStops(idx, 52.5118, 13.3782, 4000, 8);
const D = accessStops(idx, 48.140, 11.560, 4000, 8);

t = Date.now(); accessStops(idx, 52.5118, 13.3782, 4000, 8); 
console.log(`accessStops: ${Date.now()-t}ms  <- called twice per request`);

// footpath scan size
let fpTotal = 0;
for (const [,v] of idx.footpaths) fpTotal += v.length;
console.log(`footpath edges: ${fpTotal} across ${idx.footpaths.size} stops`);

t = Date.now();
const r = search(idx, O, D, 8*60, { maxRounds: 3, maxJourneys: 6 });
console.log(`full search(): ${Date.now()-t}ms -> ${r.length} journeys`);
