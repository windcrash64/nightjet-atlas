/**
 * Journey search over an ingested GTFS network.
 *
 * This is a RAPTOR-style round-based search: each round adds one more ride,
 * so a k-round search finds journeys with at most k-1 transfers. RAPTOR is the
 * right shape here because it optimises arrival time per round without needing
 * a priority queue, and it naturally produces the "fewer transfers vs. earlier
 * arrival" set that a comparison UI wants to show.
 *
 * Reference: Delling, Pajor & Werneck, "Round-Based Public Transit Routing"
 * (Microsoft Research, 2012).
 *
 * Deliberately NOT modelled: fares. The feeds carry schedules, not prices.
 * Anything this returns has price === null, and there is no code path that
 * invents one.
 */

const WALK_METRES_PER_MIN = 80;   // ~4.8 km/h, a real walking pace with luggage
const MAX_TRANSFER_WALK_M = 800;  // beyond this, it isn't a transfer, it's a leg
const MIN_TRANSFER_MIN = 5;       // minimum time to change platforms
const MAX_CONNECTION_WAIT_MIN = 180;   // 3h waiting is already a bad connection
const MAX_SLEEPER_WAIT_MIN = 300;      // you do wait for a night train, but not all evening

/**
 * Named long-distance service classes. GTFS route_type marks German S-Bahn as
 * rail exactly like an ICE, so the designation printed on the train is the only
 * reliable signal of what kind of journey it is.
 *
 * A Set rather than a regex on purpose: an earlier version of this used a
 * pattern whose word-boundary escape was mangled into a literal control
 * character by a shell edit, so it matched NOTHING. Every service silently
 * counted as local, which blocked every transfer in the app — and the failure
 * was invisible because a broken regex looks exactly like a working one.
 */
const LONG_DISTANCE_CLASSES = new Set([
  'ICE', 'ICN', 'IC', 'EC', 'ECE', 'EN', 'NJ', 'RJ', 'RJX',
  'TGV', 'THA', 'FR', 'AVE', 'IR', 'EST', 'FLX', 'D',
]);

export function isLongDistance(svc) {
  if (svc.m === 'night_rail') return true;
  const name = (svc.s || '').trim().toUpperCase();
  if (!name) return false;

  // Most feeds put the class first: "ICE 29", "FLX20", "AVE".
  if (LONG_DISTANCE_CLASSES.has(name.split(/[\s\d]/)[0])) return true;

  // The Dutch feed instead labels a service by its corridor and appends the
  // code — "Rotterdam Centraal <-> Utrecht Centraal IC2800" — so reading only
  // the first word saw "ROTTERDAM" and classified every Dutch intercity as
  // local. That left Amsterdam-Rotterdam, one of Europe's busiest lines,
  // returning no journeys at all.
  for (const token of name.split(/[^A-Z0-9]+/)) {
    if (!token) continue;
    const cls = token.replace(/\d+$/, '');
    if (cls && cls !== token && LONG_DISTANCE_CLASSES.has(cls)) return true;
  }
  return false;
}

export function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Builds the lookup structures a round-based search needs. Done once at
 * startup, not per query.
 */
export function buildIndex(network) {
  const { stops, services } = network;

  // Group trips that call at exactly the same stops in the same order. In this
  // network 113,835 trips collapse to 15,546 patterns — 7.3 trips per pattern,
  // and up to 460 for a busy S-Bahn line. That is the whole point of RAPTOR:
  // scan each PATTERN once and take only the earliest boardable trip on it,
  // instead of re-walking every hourly repetition of the same journey.
  const patternOf = new Int32Array(services.length);
  const patterns = [];        // patterns[p] = { stops: Int32Array, trips: number[] }
  const patternIds = new Map();
  for (let si = 0; si < services.length; si++) {
    const calls = services[si].c;
    let key = '';
    for (let ci = 0; ci < calls.length; ci++) key += calls[ci][0] + ',';
    let p = patternIds.get(key);
    if (p === undefined) {
      p = patterns.length;
      patternIds.set(key, p);
      patterns.push({ stops: Int32Array.from(calls.map((c) => c[0])), trips: [] });
    }
    patternOf[si] = p;
    patterns[p].trips.push(si);
  }
  // Trips within a pattern in departure order, so the first boardable one is
  // found by scanning forward rather than by sorting per query.
  for (const p of patterns) {
    p.trips.sort((a, b) => (services[a].c[0][2] ?? 0) - (services[b].c[0][2] ?? 0));
  }

  // Which patterns call at each stop, and at which position along them.
  const patternsAtStop = new Map();
  for (let p = 0; p < patterns.length; p++) {
    const st = patterns[p].stops;
    for (let i = 0; i < st.length; i++) {
      let arr = patternsAtStop.get(st[i]);
      if (!arr) { arr = []; patternsAtStop.set(st[i], arr); }
      arr.push([p, i]);
    }
  }

  // Which services call at each stop, and at which position in their run.
  const byStop = new Map();
  for (let si = 0; si < services.length; si++) {
    const calls = services[si].c;
    for (let ci = 0; ci < calls.length; ci++) {
      const stopIdx = calls[ci][0];
      let arr = byStop.get(stopIdx);
      if (!arr) { arr = []; byStop.set(stopIdx, arr); }
      arr.push([si, ci]);
    }
  }

  // Stops close enough to walk between, for transfers between nearby stations.
  // Bucketed by rounded lat/lon so this stays near-linear instead of O(n²).
  const grid = new Map();
  const cell = (lat, lon) => `${Math.round(lat * 100)}:${Math.round(lon * 100)}`;
  for (let i = 0; i < stops.length; i++) {
    const k = cell(stops[i].y, stops[i].x);
    let b = grid.get(k);
    if (!b) { b = []; grid.set(k, b); }
    b.push(i);
  }

  const footpaths = new Map();
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const near = [];
    const cy = Math.round(s.y * 100), cx = Math.round(s.x * 100);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = grid.get(`${cy + dy}:${cx + dx}`);
        if (!b) continue;
        for (const j of b) {
          if (j === i) continue;
          const d = haversineM(s.y, s.x, stops[j].y, stops[j].x);
          if (d <= MAX_TRANSFER_WALK_M) {
            near.push([j, Math.max(1, Math.round(d / WALK_METRES_PER_MIN))]);
          }
        }
      }
    }
    if (near.length) footpaths.set(i, near);
  }

  return { network, byStop, footpaths, patterns, patternsAtStop, patternOf };
}

/** Stops within `radiusM` of a coordinate, nearest first. */
export function stopsNear(index, lat, lon, radiusM = 5000, limit = 12) {
  const { stops } = index.network;
  const out = [];
  for (let i = 0; i < stops.length; i++) {
    const d = haversineM(lat, lon, stops[i].y, stops[i].x);
    if (d <= radiusM) out.push({ idx: i, distanceM: Math.round(d) });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out.slice(0, limit);
}

/**
 * Access points for a place, ranked so a main station beats a suburban halt.
 *
 * A large station's platforms are separate GTFS stops, and the S-Bahn platform
 * is often the one closest to a city-centre coordinate. Picking purely by
 * distance therefore starts every journey with a local hop to reach the
 * long-distance platforms of the same station. Ranking by how much
 * long-distance service a stop actually sees fixes that at the source.
 */
export function accessStops(index, lat, lon, radiusM = 4000, limit = 8) {
  const { stops, services } = index.network;
  const near = stopsNear(index, lat, lon, radiusM, 60);
  if (!near.length) return [];

  // GTFS route_type marks S-Bahn as rail too, so counting "rail" calls ranks a
  // busy commuter platform above the main station. What distinguishes a hub is
  // being served by named long-distance services — using the SAME classifier
  // the search uses, rather than a second copy that can drift out of step.
  const scored = near.map((n) => {
    const calls = index.byStop.get(n.idx) ?? [];
    let longDistance = 0;
    for (const [svcIdx] of calls) {
      if (isLongDistance(services[svcIdx])) longDistance++;
    }
    return { ...n, name: stops[n.idx].n, longDistance };
  });

  // Prefer stops that are actually served, then the nearer of those.
  scored.sort((a, b) => b.longDistance - a.longDistance || a.distanceM - b.distanceM);
  // Within a city the access walk is not the differentiator; zero it so the
  // search compares trains rather than which platform is 200m closer.
  return scored.slice(0, limit).map((s) => ({ idx: s.idx, distanceM: 0, name: s.name }));
}

/**
 * Finds journeys from any of `origins` to any of `destinations`.
 *
 * `origins`/`destinations` are [{idx, distanceM}] as returned by stopsNear —
 * so a search can start from several stations serving the same city, which is
 * what makes "from Vienna" work rather than "from Wien Hauptbahnhof".
 */
/**
 * Searches a window of departure times, not a single instant.
 *
 * A round-based search optimises earliest arrival, so a single run returns one
 * winner and hides every alternative — useless for a product whose whole job is
 * comparison. Running the search from several departure times surfaces the real
 * choice set: the fast expensive train, the later one, the slow scenic route,
 * the sleeper.
 */
export function searchWindow(index, origins, destinations, fromMin, opts = {}) {
  const { windowMin = 12 * 60, stepMin = 120, maxJourneys = 8 } = opts;
  const all = [];
  let cursor = fromMin;
  const end = fromMin + windowMin;

  // Hard iteration bound. Each probe is a full round-based search, so the count
  // is the entire cost of a request — leaving it to a loop condition is how a
  // 400ms search became 10s. Six probes gives a useful spread of departures
  // across the window while keeping the worst case predictable.
  // Each probe is a full round-based search, so this number IS the request cost.
  // Four probes across the window still surfaces morning/midday/evening choices;
  // going to six roughly doubled latency for options that mostly deduped away.
  const MAX_PROBES = 4;

  for (let probe = 0; probe < MAX_PROBES && cursor <= end; probe++) {
    const found = search(index, origins, destinations, cursor, { ...opts, maxJourneys: 6 });

    if (!found.length) {
      // An empty probe does NOT mean the day is over. Night trains leave late,
      // and a quiet afternoon on a sparse corridor says nothing about the
      // evening — stopping here is how the sleeper went missing. Jump by an
      // even share of the remaining window so a fixed number of probes still
      // reaches the late-evening departures at the far end of it.
      const probesLeft = Math.max(1, MAX_PROBES - probe - 1);
      cursor += Math.max(stepMin, Math.ceil((end - cursor) / probesLeft));
      continue;
    }
    all.push(...found);

    // Advance past the earliest departure we just found rather than by a fixed
    // hour: a fixed step re-finds the same train from several start times and
    // fills the list with identical rows. Never advance less than stepMin/2, so
    // a dense corridor cannot burn every probe on consecutive departures.
    const earliest = Math.min(...found.map((j) => j.departMin));
    cursor = Math.max(cursor + Math.round(stepMin / 2), earliest + 1);
  }

  return rank(dedupe(all), maxJourneys);
}

/**
 * Picks the set a traveller actually wants to see.
 *
 * Sorting purely by arrival time buries the interesting options: the direct
 * train that leaves later, the sleeper that costs a night instead of a day.
 * So we keep the winners on each axis people actually choose between, then
 * fill the rest by departure time.
 */
function rank(journeys, limit) {
  if (journeys.length <= limit) {
    return [...journeys].sort((a, b) => a.departMin - b.departMin);
  }
  const picked = new Set();
  const take = (j) => { if (j) picked.add(j); };

  const byDuration = [...journeys].sort((a, b) => a.durationMin - b.durationMin);
  const byTransfers = [...journeys].sort(
    (a, b) => a.transfers - b.transfers || a.durationMin - b.durationMin,
  );

  take(byDuration[0]);                        // fastest
  take(byTransfers[0]);                       // simplest
  take(journeys.find((j) => j.hasSleeper));   // sleep through it

  // A journey is worth showing only if nothing already shown beats it outright:
  // leaves no later, arrives sooner, and needs no more changes. A 500-minute
  // two-change crawl above a 250-minute direct train makes the whole list look
  // untrustworthy.
  // Two trains half an hour apart are a real choice even when one is slightly
  // quicker, so "beaten" means beaten CONVINCINGLY: leaves no earlier, arrives
  // at least an hour sooner, and needs no more changes.
  const BEATEN_BY_MIN = 60;
  const dominated = (j) => [...picked].some((p) =>
    p !== j
    && p.departMin >= j.departMin
    && p.arriveMin + BEATEN_BY_MIN < j.arriveMin
    && p.transfers <= j.transfers);

  // Earliest departure, but only when leaving sooner actually gets you there
  // sooner. A Berlin-Munich list led with an 08:00 that arrived at 16:20, above
  // a 09:36 direct arriving 13:43: leaving 96 minutes earlier to arrive 157
  // minutes later is nobody's preference.
  const earliest = [...journeys].sort((a, b) => a.departMin - b.departMin)[0];
  if (earliest && !dominated(earliest)) take(earliest);

  for (const j of [...journeys].sort((a, b) => a.departMin - b.departMin)) {
    if (picked.size >= limit) break;
    if (dominated(j)) continue;
    picked.add(j);
  }
  // If pruning left the list short, top it up with the best of what remains —
  // still refusing anything a shown option beats convincingly. Showing six
  // trustworthy options beats padding to eight with one that makes the list
  // look wrong.
  for (const j of [...journeys].sort(
    (a, b) => a.durationMin - b.durationMin || a.transfers - b.transfers,
  )) {
    if (picked.size >= limit) break;
    if (dominated(j)) continue;
    picked.add(j);
  }
  // `dominated` only compares against what was already picked, so an option
  // added LATER can beat an earlier one. Sweep the final set once so the list
  // is internally consistent, not merely consistent with its own build order.
  const chosen = [...picked];
  const survivors = chosen.filter((j) => !chosen.some((p) =>
    p !== j
    && p.departMin >= j.departMin
    && p.arriveMin + BEATEN_BY_MIN < j.arriveMin
    && p.transfers <= j.transfers));

  return survivors.sort((a, b) => a.departMin - b.departMin);
}

export function search(index, origins, destinations, departAfterMin, opts = {}) {
  const { maxRounds = 4, maxJourneys = 8 } = opts;
  const { services } = index.network;
  const destSet = new Map(destinations.map((d) => [d.idx, d.distanceM]));

  // best[stop] = earliest known arrival minute
  const best = new Map();
  // label[stop] = how we got there, for reconstruction
  const label = new Map();

  let frontier = new Set();
  for (const o of origins) {
    const walkMin = Math.round(o.distanceM / WALK_METRES_PER_MIN);
    const t = departAfterMin + walkMin;
    if (!best.has(o.idx) || t < best.get(o.idx)) {
      best.set(o.idx, t);
      label.set(o.idx, { kind: 'origin', at: t, walkMin, distanceM: o.distanceM, localRides: 0 });
      frontier.add(o.idx);
    }
  }

  const arrivals = [];

  for (let round = 0; round < maxRounds && frontier.size; round++) {
    const nextFrontier = new Set();

    // Collect the earliest boardable trip per (pattern, boarding position).
    // Scanning every trip re-walks each hourly repetition of the same journey:
    // 113,835 trips collapse to 15,546 patterns here, so this is ~7x less work
    // for an identical answer, and far more on a busy commuter line where one
    // pattern carries 460 trips.
    const toScan = new Map();   // patternIdx -> { boardAt, stopIdx, readyAt }
    for (const stopIdx of frontier) {
      const readyAt = best.get(stopIdx);
      const at = index.patternsAtStop.get(stopIdx);
      if (!at) continue;
      for (const [p, pos] of at) {
        const prev = toScan.get(p);
        // Board where we can be READY EARLIEST, not earliest along the pattern.
        // Taking the earliest position meant boarding a slow service at a stop
        // we happen to reach first, which produced a 782-minute Hamburg-Cologne
        // itinerary alongside a 219-minute direct train.
        if (!prev || readyAt < prev.readyAt || (readyAt === prev.readyAt && pos < prev.pos)) {
          toScan.set(p, { pos, stopIdx, readyAt });
        }
      }
    }

    for (const [patternIdx, { pos, stopIdx, readyAt }] of toScan) {
      const pattern = index.patterns[patternIdx];

      // Walk this pattern's trips in departure order and take the first that
      // we can actually catch.
      let svcIdx = -1;
      for (const candidate of pattern.trips) {
        const d = services[candidate].c[pos][2];
        if (d == null) continue;
        const buffer = label.get(stopIdx)?.kind === 'ride' ? MIN_TRANSFER_MIN : 0;
        if (d >= readyAt + buffer) { svcIdx = candidate; break; }
      }
      if (svcIdx < 0) continue;

      {
        const svc = services[svcIdx];
        const callIdx = pos;
        const dep = svc.c[callIdx][2];
        if (dep == null) continue;

        // Local services are how you reach and leave a city, not how you cross
        // a country. Boarding a third regional train mid-journey explodes the
        // search across every commuter line in Germany (it cost 4x round 2)
        // while producing journeys nobody would choose. So: long-distance
        // services are always boardable; local ones only for the first two
        // rides, which is enough for "local train to the hub, then intercity".
        // A journey may use local services to reach the intercity network and
        // to leave it, but not to hop across the country. Without this the
        // frontier explodes across every commuter line: measured at 515 stops
        // growing to 9,752 in one round, and 1,196ms of a 1,222ms search.
        if (!isLongDistance(svc) && label.get(stopIdx)?.localRides >= 1) continue;

        // Can we make it? First boarding needs no transfer buffer.
        const needBuffer = label.get(stopIdx)?.kind === 'ride' ? MIN_TRANSFER_MIN : 0;
        if (dep < readyAt + needBuffer) continue;
        // A connection you have to wait hours for is not a connection — it is
        // an unplanned night in a station. Boarding a sleeper is the exception:
        // you are meant to wait for it, so allow a longer gap there.
        const wait = dep - readyAt;
        const isSleeper = svc.m === 'night_rail';
        if (wait > (isSleeper ? MAX_SLEEPER_WAIT_MIN : MAX_CONNECTION_WAIT_MIN)) continue;

        // Ride to every later call on this service.
        for (let ci = callIdx + 1; ci < svc.c.length; ci++) {
          const [toStop, arr] = svc.c[ci];
          if (arr == null) continue;
          const known = best.get(toStop);
          if (known != null && arr >= known) continue;

          best.set(toStop, arr);
          label.set(toStop, {
            kind: 'ride', at: arr, svcIdx, fromCall: callIdx, toCall: ci, from: stopIdx,
            localRides: (label.get(stopIdx)?.localRides ?? 0) + (isLongDistance(svc) ? 0 : 1),
          });
          nextFrontier.add(toStop);

          if (destSet.has(toStop)) {
            // Reconstruct immediately. `label` is overwritten whenever the
            // search finds a better way to a stop, so rebuilding after the loop
            // yields only the last-written path — which is why a destination
            // reached twice (say by a fast train and by an overnight one)
            // produced a single journey instead of both.
            const j = reconstruct(index, label, toStop, destSet.get(toStop));
            if (j) arrivals.push(j);
          }
        }
      }
    }

    // Walking transfers between nearby stations, after each round of riding.
    //
    // Only walk from a stop we actually RODE to. Two consecutive walks are not
    // a transfer, and allowing them made the frontier balloon from 515 stops to
    // 9,752 in a single round — measured as 1,196ms of a 1,222ms search, since
    // every walk-reached stop then got scanned for boardings next round.
    const walkedTo = [];
    for (const stopIdx of nextFrontier) {
      if (label.get(stopIdx)?.kind !== 'ride') continue;
      const near = index.footpaths.get(stopIdx);
      if (!near) continue;
      const from = best.get(stopIdx);
      for (const [toStop, mins] of near) {
        const t = from + mins;
        const known = best.get(toStop);
        if (known != null && t >= known) continue;
        best.set(toStop, t);
        label.set(toStop, { kind: 'walk', at: t, from: stopIdx, mins, localRides: label.get(stopIdx)?.localRides ?? 0 });
        walkedTo.push(toStop);
      }
    }
    for (const s of walkedTo) nextFrontier.add(s);

    frontier = nextFrontier;
  }

  // `arrivals` already holds journeys, reconstructed as each one reached a
  // destination. dedupe() collapses those that ride the same services.
  return dedupe(arrivals).slice(0, maxJourneys);
}

/**
 * Two journeys that ride the same trains are the same journey to a traveller,
 * even when they end at different platforms of the same city. Without this the
 * results list shows the same ICE four times with a different final S-Bahn hop.
 */
/**
 * Rejects journeys with a wait no traveller would accept.
 *
 * The per-boarding check bounds the gap the search knew about at the time, but
 * a label can be improved after the fact so the wait in the FINAL itinerary can
 * end up longer. Checking the reconstructed journey is the only place the real
 * gap between two consecutive legs is unambiguous. (Caught by a test: a
 * Frankfurt-Vienna result sat at Ulm Hbf for 187 minutes.)
 */
function hasUnreasonableWait(journey) {
  const rides = journey.legs.filter((l) => l.mode !== 'walk');
  for (let i = 1; i < rides.length; i++) {
    const wait = rides[i].departMin - rides[i - 1].arriveMin;
    const boardingSleeper = rides[i].mode === 'night_rail';
    if (wait > (boardingSleeper ? MAX_SLEEPER_WAIT_MIN : MAX_CONNECTION_WAIT_MIN)) return true;
  }
  return false;
}

function dedupe(journeys) {
  // Identity is the long-distance spine: the services you actually ride for a
  // meaningful time. Two results that both ride ICE 29 at 08:36 are the same
  // journey to a traveller even if one ends a stop further on.
  const best = new Map();
  for (const j of journeys) {
    if (hasUnreasonableWait(j)) continue;
    // Identity is the sequence of services ridden and roughly when. Keying on
    // the exact departure minute made the SAME physical train appear several
    // times, because different probes board it at different stations and the
    // first leg's departure then differs by a few minutes. Bucketing to 20
    // minutes collapses those while still separating an hourly service's
    // genuinely distinct departures.
    const spine = j.legs
      .filter((l) => l.mode !== 'walk' && (l.arriveMin - l.departMin) >= 12)
      .map((l) => `${l.service ?? l.mode}@${Math.round(l.departMin / 20)}`)
      .join('>');
    if (!spine) continue;
    const prev = best.get(spine);
    // Among identical spines keep the simplest: fewest transfers, then shortest.
    if (!prev
      || j.transfers < prev.transfers
      || (j.transfers === prev.transfers && j.durationMin < prev.durationMin)) {
      best.set(spine, j);
    }
  }
  return [...best.values()].sort(
    (a, b) => a.departMin - b.departMin || a.durationMin - b.durationMin,
  );
}

function reconstruct(index, label, endStop, finalWalkM) {
  const { stops, services } = index.network;
  const legs = [];
  let cursor = endStop;
  let guard = 0;

  while (guard++ < 40) {
    const l = label.get(cursor);
    if (!l) return null;
    if (l.kind === 'origin') {
      if (l.walkMin > 0) {
        legs.unshift({
          mode: 'walk', service: null, operator: null,
          from: { name: 'Start', lat: null, lon: null },
          to: stopOf(stops, cursor),
          departMin: l.at - l.walkMin, arriveMin: l.at,
          distanceM: l.distanceM, price: null,
        });
      }
      break;
    }
    if (l.kind === 'walk') {
      legs.unshift({
        mode: 'walk', service: null, operator: null,
        from: stopOf(stops, l.from), to: stopOf(stops, cursor),
        departMin: l.at - l.mins, arriveMin: l.at, price: null,
      });
      cursor = l.from;
      continue;
    }
    const svc = services[l.svcIdx];
    legs.unshift({
      mode: svc.m, service: svc.s || null, operator: svc.o || null,
      headsign: svc.h || null,
      from: stopOf(stops, svc.c[l.fromCall][0]),
      to: stopOf(stops, svc.c[l.toCall][0]),
      departMin: svc.c[l.fromCall][2],
      arriveMin: svc.c[l.toCall][1],
      intermediateStops: l.toCall - l.fromCall - 1,
      price: null,
    });
    cursor = l.from;
  }

  if (!legs.length) return null;

  // Merge consecutive legs on the SAME service. The search can label a stop
  // twice along one train's run — at an intermediate stop it improved, then
  // again further along — which surfaced "ICE 83 > ICE 83" as though it were a
  // change of train. One train is one leg.
  for (let i = legs.length - 1; i > 0; i--) {
    const cur = legs[i], prev = legs[i - 1];
    if (cur.mode === 'walk' || prev.mode === 'walk') continue;
    if (!cur.service || cur.service !== prev.service) continue;
    if (cur.departMin < prev.arriveMin) continue;      // not actually contiguous
    prev.to = cur.to;
    prev.arriveMin = cur.arriveMin;
    prev.intermediateStops = (prev.intermediateStops ?? 0) + 1 + (cur.intermediateStops ?? 0);
    legs.splice(i, 1);
  }

  if (finalWalkM > 0) {
    const mins = Math.max(1, Math.round(finalWalkM / WALK_METRES_PER_MIN));
    const last = legs[legs.length - 1];
    legs.push({
      mode: 'walk', service: null, operator: null,
      from: last.to, to: { name: 'Destination', lat: null, lon: null },
      departMin: last.arriveMin, arriveMin: last.arriveMin + mins,
      distanceM: finalWalkM, price: null,
    });
  }

  const rides = legs.filter((l) => l.mode !== 'walk');
  const departMin = legs[0].departMin;
  const arriveMin = legs[legs.length - 1].arriveMin;
  const sleeperMin = rides
    .filter((l) => l.mode === 'night_rail')
    .reduce((n, l) => n + (l.arriveMin - l.departMin), 0);

  return {
    legs,
    departMin,
    arriveMin,
    durationMin: arriveMin - departMin,
    transfers: Math.max(0, rides.length - 1),
    modes: [...new Set(rides.map((l) => l.mode))],
    hasSleeper: sleeperMin > 0,
    sleeperMin,
    // Never a number. The feeds do not carry fares.
    price: null,
  };
}

function stopOf(stops, idx) {
  const s = stops[idx];
  return { name: s.n, lat: s.y, lon: s.x };
}
