import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Globe from './components/Globe.jsx';

/* ---------- formatting ---------- */

const MODE_LABEL = {
  night_rail: 'Night train', rail: 'Train', coach: 'Coach',
  ferry: 'Ferry', metro: 'Metro', tram: 'Tram', walk: 'Walk',
};

function hhmm(min) {
  if (min == null) return '--:--';
  const r = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
}

function dayOffset(min) {
  return Math.floor(min / 1440);
}

function dur(min) {
  if (min == null) return 'unavailable';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/* ---------- place search ---------- */

function PlaceField({ id, label, value, place, onText, onPick, placeholder }) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState([]);
  const timer = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    if (!open || value.trim().length < 2) { setHits([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/places?q=${encodeURIComponent(value.trim())}`);
        const d = await r.json();
        setHits(d.places ?? []);
      } catch { setHits([]); }
    }, 180);
    return () => clearTimeout(timer.current);
  }, [value, open]);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id} value={value} placeholder={placeholder} autoComplete="off"
        onChange={(e) => { onText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
      />
      {place && !open && <span className="field-note">{place.stops} stops</span>}
      {open && hits.length > 0 && (
        <ul className="suggestions">
          {hits.map((p, i) => (
            <li key={`${p.name}-${i}`}>
              <button type="button" onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { onPick(p); setOpen(false); setHits([]); }}>
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- one option in the list ---------- */

function Option({ journey, index, active, badge, onSelect }) {
  const rides = journey.legs.filter((l) => l.mode !== 'walk');
  const plus = dayOffset(journey.arriveMin) - dayOffset(journey.departMin);

  return (
    <button
      type="button"
      className={`option${active ? ' option--active' : ''}${journey.hasSleeper ? ' option--sleeper' : ''}`}
      onClick={onSelect}
      aria-pressed={active}
    >
      <span className="option-rank mono">{String(index + 1).padStart(2, '0')}</span>

      <span className="option-body">
        {badge && <span className="option-badge">{badge}</span>}
        <span className="option-times mono">
          {hhmm(journey.departMin)}
          <span className="option-arrow">→</span>
          {hhmm(journey.arriveMin)}
          {plus > 0 && <sup className="option-plus">+{plus}</sup>}
        </span>
        <span className="option-chain">
          {rides.map((l, i) => (
            <span key={i} className={`chip chip--${l.mode}`}>{l.service || MODE_LABEL[l.mode]}</span>
          ))}
        </span>
      </span>

      <span className="option-right">
        <span className="option-dur mono">{dur(journey.durationMin)}</span>
        <span className="option-transfers">
          {journey.transfers === 0 ? 'direct' : `${journey.transfers} change${journey.transfers > 1 ? 's' : ''}`}
        </span>
        {journey.hasSleeper && (
          <span className="option-sleep">{dur(journey.sleeperMin)} asleep</span>
        )}
      </span>
    </button>
  );
}

/* ---------- detail for the selected option ---------- */

function Detail({ journey }) {
  if (!journey) return null;
  return (
    <div className="detail">
      <ol className="legs">
        {journey.legs.map((l, i) => (
          <li key={i} className={`leg leg--${l.mode}`}>
            <div className="leg-time mono">
              <span>{hhmm(l.departMin)}</span>
              <span className="leg-time-arr">{hhmm(l.arriveMin)}</span>
            </div>
            <div className="leg-main">
              <p className="leg-head">
                <span className="leg-service">{l.service || MODE_LABEL[l.mode]}</span>
                {l.operator && <span className="leg-op"> · {l.operator}</span>}
                {l.mode === 'night_rail' && <span className="leg-tag">sleeper</span>}
              </p>
              <p className="leg-stops">
                {l.from.name} → {l.to.name}
                {l.intermediateStops > 0 && (
                  <span className="leg-via"> · {l.intermediateStops} stops on the way</span>
                )}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <p className="no-fare">
        No price shown. These are published timetables, not ticket inventory —
        fares live with the operator, and we will not invent one.
      </p>
    </div>
  );
}

/* ---------- app ---------- */

const START = {
  from: { name: 'Berlin Hbf', lat: 52.5118, lon: 13.3782, stops: 102 },
  to: { name: 'München Hbf', lat: 48.1402, lon: 11.5600, stops: 60 },
};

export default function App() {
  const [fromText, setFromText] = useState(START.from.name);
  const [toText, setToText] = useState(START.to.name);
  const [from, setFrom] = useState(START.from);
  const [to, setTo] = useState(START.to);
  const [departHour, setDepartHour] = useState(8);
  const [state, setState] = useState({ status: 'idle', journeys: [] });
  const [selected, setSelected] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const run = useCallback(async (o = from, d = to, h = departHour) => {
    setState({ status: 'loading', journeys: [] });
    setSelected(0);
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: { lat: o.lat, lon: o.lon }, to: { lat: d.lat, lon: d.lon }, departHour: h }),
      });
      const data = await r.json();
      if (!r.ok) { setState({ status: 'error', message: data.error, journeys: [] }); return; }
      setState({
        status: 'done', journeys: data.journeys ?? [],
        coverage: data.coverage, sources: data.sources,
        generatedAt: data.generatedAt, tookMs: data.tookMs,
      });
    } catch {
      setState({ status: 'error', message: 'The search service is not responding.', journeys: [] });
    }
  }, [from, to, departHour]);

  useEffect(() => { run(); /* eslint-disable-next-line */ }, []);

  // Which options deserve a badge. Computed from the set, not hardcoded.
  const badges = useMemo(() => {
    const j = state.journeys;
    if (!j.length) return {};
    const out = {};
    const fastest = j.reduce((a, b) => (b.durationMin < a.durationMin ? b : a));
    out[j.indexOf(fastest)] = 'Fastest';
    const direct = j.filter((x) => x.transfers === 0)
      .sort((a, b) => a.durationMin - b.durationMin)[0];
    if (direct && !out[j.indexOf(direct)]) out[j.indexOf(direct)] = 'No changes';
    const sleeper = j.find((x) => x.hasSleeper);
    if (sleeper && !out[j.indexOf(sleeper)]) out[j.indexOf(sleeper)] = 'Sleep through it';
    return out;
  }, [state.journeys]);

  /**
   * When a corridor is served by one train running hourly, every option is the
   * same service at a different time. Six identical rows look like a bug, so
   * say plainly that the choice is only departure time.
   */
  const sameService = useMemo(() => {
    const j = state.journeys;
    if (j.length < 3) return null;
    const spines = j.map((x) =>
      x.legs.filter((l) => l.mode !== 'walk').map((l) => l.service).join('>'),
    );
    return new Set(spines).size === 1 ? spines[0] : null;
  }, [state.journeys]);

  const active = state.journeys[selected] ?? null;

  return (
    <div className="app">
      <header className="masthead">
        <h1>How do I actually get<br /><em>from here to there?</em></h1>
        <p>
          Real timetables, drawn on the world and ranked by what matters — time,
          changes, and whether you can sleep through it. Today that means trains
          across Germany and its long-distance links into its neighbours.
        </p>
      </header>

      <form className="search" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <PlaceField
          id="from" label="From" value={fromText} place={from}
          placeholder="Any station or city"
          onText={setFromText}
          onPick={(p) => { setFrom(p); setFromText(p.name); run(p, to, departHour); }}
        />
        <PlaceField
          id="to" label="To" value={toText} place={to}
          placeholder="Where you're going"
          onText={setToText}
          onPick={(p) => { setTo(p); setToText(p.name); run(from, p, departHour); }}
        />
        <div className="field field--time">
          <label htmlFor="depart">Leave after</label>
          <select id="depart" value={departHour}
                  onChange={(e) => { const h = Number(e.target.value); setDepartHour(h); run(from, to, h); }}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
            ))}
          </select>
        </div>
        <button className="go" type="submit" disabled={state.status === 'loading'}>
          {state.status === 'loading' ? 'Searching…' : 'Find the ways'}
        </button>
      </form>

      <div className="workspace">
        <div className="map-pane">
          <Globe journeys={state.journeys} activeIndex={selected} reduced={reduced} />
          {active && (
            <div className="map-caption">
              <strong>{active.legs[0].from.name}</strong> → <strong>{active.legs[active.legs.length - 1].to.name}</strong>
            </div>
          )}
        </div>

        <div className="list-pane">
          {state.status === 'loading' && <p className="notice">Reading the timetables…</p>}

          {state.status === 'error' && (
            <p className="notice notice--error">{state.message}</p>
          )}

          {state.status === 'done' && !state.journeys.length && (
            <p className="notice">
              {state.coverage ?? 'No journey found between those places on this data.'}
              {' '}Our timetables currently cover Germany and its long-distance
              connections into neighbouring countries.
            </p>
          )}

          {state.status === 'done' && state.journeys.length > 0 && (
            <>
              <h2 className="list-head">
                {state.journeys.length} way{state.journeys.length > 1 ? 's' : ''} to get there
                <span className="list-took mono">{state.tookMs}ms</span>
              </h2>
              {sameService && (
                <p className="list-note">
                  One service runs this route — <strong>{sameService}</strong>. The
                  only real choice here is when you leave.
                </p>
              )}
              <div className="options">
                {state.journeys.map((j, i) => (
                  <Option key={i} journey={j} index={i} active={i === selected}
                          badge={badges[i]} onSelect={() => setSelected(i)} />
                ))}
              </div>
              <Detail journey={active} />
            </>
          )}
        </div>
      </div>

      <footer>
        <p>
          {/* Feeds from one publisher share an attribution string; printing it
              once per feed reads as a bug, not as diligence. */}
          {[...new Set((state.sources ?? []).map((s) => s.attribution))].join(' · ')}
          {state.generatedAt && (
            <> · Timetable data retrieved {new Date(state.generatedAt).toISOString().slice(0, 10)}</>
          )}
        </p>
        <p>
          Schedules are not tickets. Confirm times and buy with the operator before
          you travel. Country geometry: Natural Earth (public domain).
        </p>
      </footer>
    </div>
  );
}
