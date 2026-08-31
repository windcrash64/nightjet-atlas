import { readFileSync } from 'node:fs';
import { buildIndex, stopsNear, searchWindow } from '../src/lib/router.js';

console.time('load');
const net = JSON.parse(readFileSync('src/data/network.json', 'utf8'));
console.timeEnd('load');
console.log(`stops=${net.stops.length} services=${net.services.length}`);

console.time('index');
const idx = buildIndex(net);
console.timeEnd('index');

function hhmm(m) {
  if (m == null) return '--:--';
  const d = Math.floor(m / 1440), r = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(r/60)).padStart(2,'0')}:${String(r%60).padStart(2,'0')}${d>0?`+${d}`:''}`;
}

function run(name, from, to, departHour) {
  const O = stopsNear(idx, from[0], from[1], 6000, 10);
  const D = stopsNear(idx, to[0], to[1], 6000, 10);
  console.log(`\n=== ${name} ===  origin stops=${O.length} dest stops=${D.length}`);
  if (!O.length || !D.length) { console.log('  no stops nearby'); return; }
  console.log(`  from: ${O.slice(0,3).map(o=>net.stops[o.idx].n).join(' | ')}`);
  console.time('  search');
  const js = searchWindow(idx, O, D, departHour*60, { maxRounds: 4, maxJourneys: 6, windowMin: 12*60, stepMin: 90 });
  console.timeEnd('  search');
  for (const j of js.slice(0,6)) {
    const h = Math.floor(j.durationMin/60), m = j.durationMin%60;
    console.log(`  ${hhmm(j.departMin)}->${hhmm(j.arriveMin)}  ${h}h${String(m).padStart(2,'0')}m  ${j.transfers} transfers${j.hasSleeper?'  [SLEEPER]':''}`);
    for (const l of j.legs.filter(x=>x.mode!=='walk')) {
      console.log(`      ${l.mode.padEnd(10)} ${(l.service||'').padEnd(10)} ${hhmm(l.departMin)} ${l.from.name} -> ${hhmm(l.arriveMin)} ${l.to.name}`);
    }
  }
}

run('Berlin -> Munich', [52.5251,13.3694], [48.1402,11.5600], 8);
run('Hamburg -> Cologne', [53.5528,10.0067], [50.9430,6.9589], 9);
run('Frankfurt -> Vienna', [50.1070,8.6638], [48.1852,16.3760], 16);
