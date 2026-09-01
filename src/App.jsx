import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Globe from './components/Globe.jsx';
import { badgesFor, cadenceOf } from './lib/summarise.js';

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

/** Today as YYYY-MM-DD, for a native date input. Local, not UTC. */
function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "2026-09-01" -> 20260901, the compact form the API takes. */
function isoToYmd(iso) {
  return Number(iso.replace(/-/g, '')) || 0;
}

/** YYYYMMDD plus n days, back as an ISO string for the input's max. */
function isoPlusDays(ymd, n) {
  const d = new Date(Date.UTC(Math.floor(ymd / 10000), (Math.floor(ymd / 100) % 100) - 1, ymd % 100));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Today", "Tomorrow", or a short weekday-and-date. */
function dayLabel(iso) {
  const today = isoToday();
  if (iso === today) return 'Today';
  const t = new Date(`${today}T00:00:00`);
  t.setDate(t.getDate() + 1);
  if (iso === `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`) {
    return 'Tomorrow';
  }
  // 'en-GB' rather than the browser's locale: the rest of the page is English,
  // and a machine set to another language rendered this one label as
  // "6 Eyl Paz" beside otherwise English copy. Day-before-month also matches
  // how every country in the data writes a date.
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
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
        // Select the whole value on focus so typing REPLACES the current
        // station. Without this, clicking into a field holding "Berlin Hbf"
        // and typing "Madrid" leaves "MadridBerlin Hbf", which matches nothing.
        onFocus={(e) => { e.target.select(); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
      />
      {place?.stops > 0 && !open && <span className="field-note">{place.stops} stops</span>}
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

/**
 * Journeys worth showing someone who has just arrived. Each is real, verified
 * against the timetable, and demonstrates something the app does that a form
 * on its own does not advertise: a sleeper, a border crossing, a high-speed
 * line, the Eurostar.
 */
const EXAMPLES = [
  { label: 'Frankfurt → Vienna, overnight',
    from: { name: 'Frankfurt', lat: 50.1067, lon: 8.6628 },
    to: { name: 'Wien', lat: 48.1856, lon: 16.3367 }, hour: 16 },
  { label: 'Paris → Marseille',
    from: { name: 'Paris', lat: 48.8809, lon: 2.3549 },
    to: { name: 'Marseille', lat: 43.3025, lon: 5.3803 }, hour: 8 },
  { label: 'Zurich → Milano',
    from: { name: 'Zürich', lat: 47.3779, lon: 8.5403 },
    to: { name: 'Milano', lat: 45.4863, lon: 9.2043 }, hour: 8 },
  { label: 'Madrid → Barcelona',
    from: { name: 'Madrid', lat: 40.4064, lon: -3.6909 },
    to: { name: 'Barcelona', lat: 41.3790, lon: 2.1400 }, hour: 8 },
  { label: 'Paris → London',
    from: { name: 'Paris', lat: 48.8809, lon: 2.3549 },
    to: { name: 'London', lat: 51.5308, lon: -0.1238 }, hour: 8 },
  { label: 'Berlin → Warszawa',
    from: { name: 'Berlin', lat: 52.5118, lon: 13.3782 },
    to: { name: 'Warszawa', lat: 52.2288, lon: 21.0030 }, hour: 8 },
  { label: 'Zurich → Hamburg, sleeper',
    from: { name: 'Zürich', lat: 47.3779, lon: 8.5403 },
    to: { name: 'Hamburg', lat: 53.5528, lon: 10.0067 }, hour: 19 },
];

export default function App() {
  const [fromText, setFromText] = useState(START.from.name);
  const [toText, setToText] = useState(START.to.name);
  const [from, setFrom] = useState(START.from);
  const [to, setTo] = useState(START.to);
  const [departHour, setDepartHour] = useState(8);
  // An ISO date for the input, defaulting to today. The trains that run vary
  // by the day — only about a quarter of the network operates on any given
  // date — so this is not a refinement, it is what makes the answer true.
  const [date, setDate] = useState(() => isoToday());
  const [state, setState] = useState({ status: 'idle', journeys: [] });
  const [selected, setSelected] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const run = useCallback(async (o = from, d = to, h = departHour, when = date) => {
    setState({ status: 'loading', journeys: [] });
    setSelected(0);
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: { lat: o.lat, lon: o.lon }, to: { lat: d.lat, lon: d.lon },
          departHour: h, date: isoToYmd(when),
        }),
      });
      const data = await r.json();
      if (!r.ok) { setState({ status: 'error', message: data.error, journeys: [] }); return; }
      setState({
        status: 'done', journeys: data.journeys ?? [],
        coverage: data.coverage, sources: data.sources,
        generatedAt: data.generatedAt, tookMs: data.tookMs,
        calendar: data.calendar,
      });
    } catch {
      setState({ status: 'error', message: 'The search service is not responding.', journeys: [] });
    }
  }, [from, to, departHour, date]);

  useEffect(() => { run(); /* eslint-disable-next-line */ }, []);

  // Both rules live in lib/summarise.js, where their edge cases are tested.
  const badges = useMemo(() => badgesFor(state.journeys), [state.journeys]);
  const cadence = useMemo(() => cadenceOf(state.journeys), [state.journeys]);

  const active = state.journeys[selected] ?? null;

  return (
    <div className="app">
      <header className="masthead">
        <h1>How do I actually get<br /><em>from here to there?</em></h1>
        <p>
          Real timetables, drawn on the world and ranked by what matters — time,
          changes, and whether you can sleep through it. Built from five
          countries&rsquo; open data, and reaching wherever their trains run —
          as far as Warsaw, Copenhagen, Budapest and London.
        </p>
      </header>

      <form className="search" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <PlaceField
          id="from" label="From" value={fromText} place={from}
          placeholder="Any station or city"
          onText={setFromText}
          onPick={(p) => { setFrom(p); setFromText(p.name); run(p, to, departHour, date); }}
        />
        <PlaceField
          id="to" label="To" value={toText} place={to}
          placeholder="Where you're going"
          onText={setToText}
          onPick={(p) => { setTo(p); setToText(p.name); run(from, p, departHour, date); }}
        />
        <div className="field field--date">
          <label htmlFor="when">On</label>
          <input
            id="when" type="date" value={date}
            min={isoToday()}
            // Bounded by the calendars we actually ingested. Beyond the
            // horizon the server stops filtering by day, so the answer would
            // quietly go back to "every train, any day" — better to not offer
            // the date at all than to answer it wrongly.
            max={state.calendar?.from
              ? isoPlusDays(state.calendar.from, (state.calendar.days ?? 1) - 1)
              : undefined}
            onChange={(e) => {
              const v = e.target.value || isoToday();
              setDate(v); run(from, to, departHour, v);
            }}
          />
          <span className="field-note">{dayLabel(date)}</span>
        </div>
        <div className="field field--time">
          <label htmlFor="depart">Leave after</label>
          <select id="depart" value={departHour}
                  onChange={(e) => { const h = Number(e.target.value); setDepartHour(h); run(from, to, h, date); }}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
            ))}
          </select>
        </div>
        <button className="go" type="submit" disabled={state.status === 'loading'}>
          {state.status === 'loading' ? 'Searching…' : 'Find the ways'}
        </button>
      </form>

      <nav className="examples" aria-label="Example journeys">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            type="button"
            onClick={() => {
              setFrom(ex.from); setTo(ex.to); setDepartHour(ex.hour);
              setFromText(ex.from.name); setToText(ex.to.name);
              run(ex.from, ex.to, ex.hour, date);
            }}
          >
            {ex.label}
          </button>
        ))}
      </nav>

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
            // Two different failures used to read as one. `coverage` means we
            // have no station near that place at all; without it, the places
            // are known and it is this DAY and hour that has nothing — which
            // is a normal answer now that only about a quarter of the network
            // runs on any given date. Saying "we don't go there" to someone
            // who picked a quiet Tuesday evening is simply untrue.
            <div className="notice">
              {state.coverage ? (
                <p>
                  {state.coverage} We carry the published timetables of Germany,
                  France, Spain, Switzerland and the Netherlands, which reach
                  their neighbours wherever a train crosses the border.
                  Somewhere further afield will not be here yet.
                </p>
              ) : (
                <>
                  <p>
                    {/* "on today" reads wrong; "today" and "tomorrow" are
                        adverbs, a weekday needs the preposition. */}
                    Nothing runs this way {dayLabel(date) === 'Today' || dayLabel(date) === 'Tomorrow'
                      ? dayLabel(date).toLowerCase()
                      : `on ${dayLabel(date)}`} after {String(departHour).padStart(2, '0')}:00.
                    {' '}The trains that run vary by the day, so another date or an
                    earlier start often has one.
                  </p>
                  <p className="notice-actions">
                    <button type="button" onClick={() => {
                      const h = Math.max(0, departHour - 4);
                      setDepartHour(h); run(from, to, h, date);
                    }}>Leave earlier</button>
                    <button type="button" onClick={() => {
                      const next = isoPlusDays(isoToYmd(date), 1);
                      setDate(next); run(from, to, departHour, next);
                    }}>Try the next day</button>
                  </p>
                </>
              )}
            </div>
          )}

          {state.status === 'done' && state.journeys.length > 0 && (
            <>
              <h2 className="list-head">
                {state.journeys.length} way{state.journeys.length > 1 ? 's' : ''} to get there
                <span className="list-took mono">{state.tookMs}ms</span>
              </h2>
              {cadence && (
                <p className="list-note">
                  <strong>{cadence.spine}</strong> runs this route {cadence.every}
                  {cadence.count < cadence.total
                    ? ` — ${cadence.count} of these ${cadence.total} options are that train`
                    : ''}
                  . The choice here is mostly when you leave.
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
