import { readFileSync } from 'node:fs';
import { buildIndex, accessStops } from '../src/lib/router.js';
const net = JSON.parse(readFileSync('src/data/network.json','utf8'));
const idx = buildIndex(net);
const O = accessStops(idx, 52.5118, 13.3782, 4000, 8);
const D = accessStops(idx, 48.140, 11.560, 4000, 8);

// Replicate search() exactly but time each phase.
const services = net.services;
const destSet = new Map(D.map(d=>[d.idx,d.distanceM]));
const best=new Map(), label=new Map();
let frontier=new Set();
for(const o of O){ best.set(o.idx,480); label.set(o.idx,{kind:'origin',at:480,walkMin:0,distanceM:0}); frontier.add(o.idx); }

let rideMs=0, walkMs=0;
for(let round=0; round<3 && frontier.size; round++){
  const next=new Set();
  let t=Date.now();
  for(const stopIdx of frontier){
    const readyAt=best.get(stopIdx);
    const calls=idx.byStop.get(stopIdx);
    if(!calls) continue;
    for(const [si,ci] of calls){
      const svc=services[si];
      const dep=svc.c[ci][2];
      if(dep==null) continue;
      if(round>1 && !/^(ICE|IC|EC|ECE|EN|NJ|RJ|RJX|TGV|THA|FR|AVE|IR|D|EST|FLX)/i.test((svc.s||'').trim()) && svc.m!=='night_rail') continue;
      const needBuffer = label.get(stopIdx)?.kind==='ride'?5:0;
      if(dep < readyAt+needBuffer) continue;
      const wait=dep-readyAt;
      if(wait > (svc.m==='night_rail'?300:180)) continue;
      for(let k=ci+1;k<svc.c.length;k++){
        const [to,arr]=svc.c[k];
        if(arr==null) continue;
        const known=best.get(to);
        if(known!=null && arr>=known) continue;
        best.set(to,arr); label.set(to,{kind:'ride',at:arr}); next.add(to);
      }
    }
  }
  rideMs += Date.now()-t;
  t=Date.now();
  const walked=[];
  for(const s of next){
    const near=idx.footpaths.get(s); if(!near) continue;
    const from=best.get(s);
    for(const [to,mins] of near){
      const tt=from+mins; const known=best.get(to);
      if(known!=null&&tt>=known) continue;
      best.set(to,tt); label.set(to,{kind:'walk',at:tt}); walked.push(to);
    }
  }
  for(const s of walked) next.add(s);
  walkMs += Date.now()-t;
  console.log(`round ${round}: frontier=${frontier.size} -> next=${next.size} (walked ${walked.length})`);
  frontier=next;
}
console.log(`TOTAL ride phase: ${rideMs}ms   walk phase: ${walkMs}ms`);
