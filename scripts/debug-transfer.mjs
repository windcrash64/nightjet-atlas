import { buildIndex, search } from '../src/lib/router.js';
// Absolute minimum: two long-distance trains, one transfer, nothing else.
const fx = {
  stops: [{n:'A',y:52.5,x:13.3},{n:'B',y:51.0,x:10.0},{n:'C',y:50.0,x:8.0}],
  services: [
    {s:'ICE 1', m:'rail', o:'DB', c:[[0,null,480],[1,540,null]]},
    {s:'ICE 2', m:'rail', o:'DB', c:[[1,null,600],[2,700,null]]},
  ],
};
const idx = buildIndex(fx);
console.log('byStop:', [...idx.byStop.entries()].map(([k,v])=>`${k}:${JSON.stringify(v)}`).join('  '));
const js = search(idx, [{idx:0,distanceM:0}], [{idx:2,distanceM:0}], 400, {maxRounds:4});
console.log('journeys:', js.length);
js.forEach(j => console.log('  ', j.transfers+'tr', j.legs.map(l=>l.service||l.mode).join(' > ')));
