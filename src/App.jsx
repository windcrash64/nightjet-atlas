import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Stringline from './components/Stringline.jsx';
import { normaliseItinerary, isOvernightJourney, formatDuration } from './lib/journey.js';
import { skyAlongJourney, darkFraction } from './lib/sun.js';

/** Places we can prove have a real sleeper, from a live scan on 2026-08-31. */
const SEEDS = [
  { label: 'Vienna → Rome', from: { name: 'Vienna', lat: 48.1852, lon: 16.376 }, to: { name: 'Rome', lat: 41.901, lon: 12.501 } },
  { label: 'Prague → Florence', from: { name: 'Prague', lat: 50.083, lon: 14.4356 }, to: { name: 'Florence', lat: 43.7764, lon: 11.248 } },
  { label: 'Venice → Warsaw', from: { name: 'Venice', lat: 45.4408, lon: 12.3155 }, to: { name: 'Warsaw', lat: 52.2288, lon: 21.003 } },
  { label: 'Zagreb → Zurich', from: { name: 'Zagreb', lat: 45.8046, lon: 15.9789 }, to: { name: 'Zurich', lat: 47.3779, lon: 8.5403 } },
  { label: 'Ljubljana → Budapest', from: { name: 'Ljubljana', lat: 46.0577, lon: 14.5058 }, to: { name: 'Budapest', lat: 47.5005, lon: 19.0844 } },
];

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

function PlaceField({ id, label, value, onChange, onPick, placeholder }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    if (!value || value.length < 2 || !open) return;
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(value)}`);
        const data = await res.json();
        setSuggestions(data.places ?? []);
      } catch {
        setSuggestions([]);
      }
    }, 260);
    return () => clearTimeout(timer.current);
  }, [value, open]);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
      />
      {open && suggestions.length > 0 && (
        <ul className="suggestions">
          {suggestions.map((p, i) => (
            <li key={`${p.name}-${i}`}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(p); setOpen(false); setSuggestions([]); }}
              >
                {p.name}
                {p.area && <span className="area"> · {p.area}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function hhmm(iso) {
  if (!iso) return '--:--';
  return new Date(iso).toISOString().slice(11, 16);
}

function dayOffset(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const a = new Date(startIso), b = new Date(endIso);
  return Math.round((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate())
    - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / 86400000);
}

function Journey({ itinerary, from, to, reducedMotion }) {
  const overnight = isOvernightJourney(itinerary);
  const plus = dayOffset(itinerary.departure, itinerary.arrival);

  const dark = useMemo(() => {
    const s = Date.parse(itinerary.departure), e = Date.parse(itinerary.arrival);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
    return darkFraction(skyAlongJourney(s, e, from, to, 120));
  }, [itinerary, from, to]);

  return (
    <article className={`journey${overnight ? ' journey--overnight' : ''}`}>
      <div className="journey-head">
        <div>
          <p className="journey-times mono">
            {hhmm(itinerary.departure)}
            <span className="arrow">→</span>
            {hhmm(itinerary.arrival)}
            {plus > 0 && <span className="nextday">+{plus}</span>}
          </p>
          <p className="journey-meta">
            {[
              formatDuration(itinerary.durationSeconds),
              itinerary.transfers === 0
                ? 'direct'
                : `${itinerary.transfers} transfer${itinerary.transfers === 1 ? '' : 's'}`,
              dark != null ? `${Math.round(dark * 100)}% after dark` : null,
            ].filter(Boolean).join('  ·  ')}
          </p>
        </div>
      </div>

      {overnight && (
        <p className="sleep-claim">
          <span className="figure mono">{formatDuration(itinerary.sleeperSeconds)}</span>{' '}
          in a bed on {itinerary.sleeperServices.map((s) => s.service).filter(Boolean).join(', ')}
          {plus > 0 && ' — you arrive the next morning without paying for a hotel night'}
        </p>
      )}

      <Stringline itinerary={itinerary} from={from} to={to} reducedMotion={reducedMotion} />

      <ul className="legs">
        {itinerary.legs.filter((l) => l.isTransit).map((leg, i) => (
          <li key={i} className={`leg${leg.isSleeper ? ' leg--sleeper' : ''}${leg.sourceState === 'live' ? ' leg--live' : ''}`}>
            <p>
              <span className="leg-service">{leg.service ?? leg.mode.toLowerCase().replace(/_/g, ' ')}</span>
              {leg.operator && <span className="leg-where"> · {leg.operator}</span>}
              <span className={`state state--${leg.sourceState}`}>{leg.sourceState}</span>
            </p>
            <p className="leg-where mono">
              {hhmm(leg.departure)} {leg.from.name} → {hhmm(leg.arrival)} {leg.to.name}
            </p>
          </li>
        ))}
      </ul>

      <p className="no-price">
        No fare shown: open transit data carries schedules, not prices.
        {itinerary.legs.find((l) => l.fareUrl) && (
          <> Buy from{' '}
            <a href={itinerary.legs.find((l) => l.fareUrl).fareUrl} target="_blank" rel="noopener noreferrer">
              the operator
            </a>.
          </>
        )}
      </p>
    </article>
  );
}

export default function App() {
  const reducedMotion = useReducedMotion();
  const [fromText, setFromText] = useState('Vienna');
  const [toText, setToText] = useState('Rome');
  const [from, setFrom] = useState({ name: 'Vienna', lat: 48.1852, lon: 16.376 });
  const [to, setTo] = useState({ name: 'Rome', lat: 41.901, lon: 12.501 });
  const [state, setState] = useState({ status: 'idle', itineraries: [] });

  const search = useCallback(async (origin = from, dest = to) => {
    setState({ status: 'loading', itineraries: [] });

    // Night trains only appear if you ask from the afternoon — query at 22:00
    // and every sleeper has already left. Verified: a 16:00 query surfaces all
    // three Vienna->Rome Nightjets; a 22:00 query surfaces none.
    const when = new Date();
    when.setUTCHours(15, 0, 0, 0);
    if (when.getTime() < Date.now()) when.setUTCDate(when.getUTCDate() + 1);

    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: { lat: origin.lat, lon: origin.lon },
          to: { lat: dest.lat, lon: dest.lon },
          departAt: when.toISOString(),
          modes: ['rail', 'bus', 'ferry', 'metro'],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState({ status: 'error', message: data.error ?? 'Routing failed.', itineraries: [] });
        return;
      }
      const itineraries = (data.itineraries ?? []).map(normaliseItinerary);
      itineraries.sort((a, b) => Number(isOvernightJourney(b)) - Number(isOvernightJourney(a)));
      setState({ status: 'done', itineraries, fetchedAt: data.fetchedAt });
    } catch {
      setState({ status: 'error', message: 'Could not reach the routing service.', itineraries: [] });
    }
  }, [from, to]);

  useEffect(() => { search(); /* eslint-disable-next-line */ }, []);

  const overnightCount = state.itineraries.filter(isOvernightJourney).length;

  return (
    <div className="shell">
      <header className="masthead">
        <h1>Some journeys<br />happen <em>while you sleep.</em></h1>
        <p>
          Europe still runs night trains. Flight search cannot show you why that
          matters, because a bed is not a price and darkness is not a duration.
          This draws the journey against the real sky instead.
        </p>
      </header>

      <form className="search" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <PlaceField
          id="from" label="From" value={fromText} placeholder="Any station, city or address"
          onChange={setFromText}
          onPick={(p) => { setFrom({ name: p.name, lat: p.lat, lon: p.lon }); setFromText(p.name); }}
        />
        <PlaceField
          id="to" label="To" value={toText} placeholder="Where you want to wake up"
          onChange={setToText}
          onPick={(p) => { setTo({ name: p.name, lat: p.lat, lon: p.lon }); setToText(p.name); }}
        />
        <button className="go" type="submit" disabled={state.status === 'loading'}>
          {state.status === 'loading' ? 'Searching…' : 'Draw the journey'}
        </button>
      </form>

      <nav aria-label="Routes with a verified sleeper" style={{ marginBottom: '2rem' }}>
        {SEEDS.map((s) => (
          <button
            key={s.label} type="button"
            style={{
              background: 'none', border: '1px solid var(--line)', color: 'var(--text-dim)',
              font: 'inherit', fontSize: '0.85rem', padding: '4px 10px', marginRight: '6px',
              marginBottom: '6px', cursor: 'pointer', borderRadius: 2,
            }}
            onClick={() => {
              setFrom(s.from); setTo(s.to);
              setFromText(s.from.name); setToText(s.to.name);
              search(s.from, s.to);
            }}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {state.status === 'loading' && <p className="notice">Asking the timetables…</p>}

      {state.status === 'error' && (
        <p className="notice notice--error">
          {state.message} Nothing is shown rather than something invented.
        </p>
      )}

      {state.status === 'done' && state.itineraries.length === 0 && (
        <p className="notice">
          No journey found. Open transit coverage is uneven — it is strong across
          Europe, Japan and parts of North America, and thin or absent elsewhere.
          That is a gap in the data, not proof that no route exists.
        </p>
      )}

      {state.status === 'done' && state.itineraries.length > 0 && (
        <>
          <h2 style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.1em',
                       color: 'var(--text-faint)', marginBottom: '1rem' }}>
            {overnightCount > 0
              ? `${overnightCount} of ${state.itineraries.length} let you sleep through it`
              : `${state.itineraries.length} journeys — none overnight on this corridor`}
          </h2>
          {state.itineraries.map((itin) => (
            <Journey key={itin.id} itinerary={itin} from={from} to={to} reducedMotion={reducedMotion} />
          ))}
        </>
      )}

      <footer>
        <p>
          Routing and place search by{' '}
          <a href="https://transitous.org/" target="_blank" rel="noopener noreferrer">Transitous</a>
          {' '}(MOTIS) over open transit feeds —{' '}
          <a href="https://transitous.org/sources/" target="_blank" rel="noopener noreferrer">data sources</a>.
          Geometry © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>.
          Airport data from <a href="https://ourairports.com/data/" target="_blank" rel="noopener noreferrer">OurAirports</a> (public domain).
        </p>
        <p>
          Times are shown in UTC. Schedules are not tickets: confirm with the
          operator before travelling. This is a non-commercial, open-source
          project — a condition of using the Transitous service.
        </p>
      </footer>
    </div>
  );
}
