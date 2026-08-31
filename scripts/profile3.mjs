import { readFileSync } from 'node:fs';
import { buildIndex, accessStops } from '../src/lib/router.js';
const net = JSON.parse(readFileSync('src/data/network.json','utf8'));
const idx = buildIndex(net);
const O = accessStops(idx, 52.5118, 13.3782, 4000, 8);

// Instrument: count the actual work each round does.
const services = net.services;
const best = new Map(); const label = new Map();
let frontier = new Set();
for (const o of O) { best.set(o.idx, 480); label.set(o.idx,{kind:'origin'}); frontier.add(o.idx); }

for (let round = 0; round < 3; round++) {
  const t = Date.now();
  let boardChecks = 0, rides = 0, improved = 0;
  const next = new Set();
  for (const stopIdx of frontier) {
    const readyAt = best.get(stopIdx);
    const calls = idx.byStop.get(stopIdx);
    if (!calls) continue;
    for (const [si, ci] of calls) {
      boardChecks++;
      const svc = services[si];
      const dep = svc.c[ci][2];
      if (dep == null || dep < readyAt) continue;
      if (dep - readyAt > 180) continue;
      for (let k = ci+1; k < svc.c.length; k++) {
        rides++;
        const [to, arr] = svc.c[k];
        if (arr == null) continue;
        const known = best.get(to);
        if (known != null && arr >= known) continue;
        improved++; best.set(to, arr); label.set(to,{kind:'ride'}); next.add(to);
      }
    }
  }
  console.log(`round ${round}: frontier=${frontier.size} boardChecks=${boardChecks} rides=${rides} improved=${improved} -> ${Date.now()-t}ms`);
  frontier = next;
}
