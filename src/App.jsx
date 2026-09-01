/**
 * THE CLOCK FACE
 *
 * A person types two places and needs to see, in about twenty seconds, which
 * way to go and whether they can sleep through it.
 *
 * The results are one object, not eight rows: a single shared time ruler with
 * the real computed sky behind it. That is what replaces price, because there
 * is no price — open feeds carry schedules, not fares, and there is no code
 * path here that invents one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Globe from './components/Globe.jsx';
import JourneyRow from './components/JourneyRow.jsx';
import { badgesFor, cadenceOf } from './lib/summarise.js';
import { timeAxis, ribbonFor, sortsFor, positionOn } from './lib/ribbon.js';
import { hhmm, dur, isoToday, isoToYmd, isoPlusDays, dayLabel } from './lib/format.js';

/* ---------- place field ---------- */

function PlaceField({ id, label, value, onText, onPick, placeholder }) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState([]);
  const timer = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    if (!open || value.trim().length < 2) { setHits([]); return; }
    // /api/places is a synchronous in-memory scan and is NOT rate limited —
    // only /api/search is. So debounced-per-keystroke is fine here.
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
        // Select the whole value on focus so typing REPLACES the station.
        // Without this, clicking into a field holding "Berlin Hbf" and typing
        // "Madrid" leaves "MadridBerlin Hbf", which matches nothing.
        onFocus={(e) => { e.target.select(); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
      />
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

/* ---------- the detail of one journey ---------- */

function Detail({ journey }) {
  if (!journey) return null;
  return (
    <div className="detail">
      <ol className="legs">
        {journey.legs.map((l, i) => (
          <li key={i} className={`leg-row leg-row--${l.mode}`}>
            <span className="leg-time num">
              {hhmm(l.departMin)}<br />
              <span className="leg-time-arr">{hhmm(l.arriveMin)}</span>
            </span>
            <span className="leg-body">
              <span className="leg-name">{l.service || (l.mode === 'walk' ? 'Walk' : 'Train')}</span>
              {l.operator && <span className="leg-op"> · {l.operator}</span>}
              {l.mode === 'night_rail' && <span className="leg-tag num">SLEEPER</span>}
              <br />
              <span className="leg-stops">
                {l.from.name} → {l.to.name}
                {/* intermediateStops is an INTEGER, not a list of positions.
                    Drawing tick marks along the route would be fabricating
                    coordinates the data does not contain. */}
                {l.intermediateStops > 0 && <span className="leg-via"> · {l.intermediateStops} stops</span>}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------- app ---------- */

const START = {
  from: { name: 'Frankfurt(Main)Hbf', lat: 50.1067, lon: 8.6628 },
  to: { name: 'Wien Hbf', lat: 48.1856, lon: 16.3367 },
};

export default function App() {
  const [fromText, setFromText] = useState(START.from.name);
  const [toText, setToText] = useState(START.to.name);
  const [from, setFrom] = useState(START.from);
  const [to, setTo] = useState(START.to);
  const [departHour, setDepartHour] = useState(16);
  const [date, setDate] = useState(() => isoToday());
  const [state, setState] = useState({ status: 'idle', journeys: [] });
  const [selected, setSelected] = useState(0);
  const [hovered, setHovered] = useState(-1);
  const [sort, setSort] = useState('earliest');
  const [reduced, setReduced] = useState(false);
  const inflight = useRef(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const run = useCallback(async (o = from, d = to, h = departHour, when = date) => {
    // Never more than one search in flight. The server answers 503 at four
    // concurrent and 429 above twenty a minute, and a stale response landing
    // after a newer one would show the wrong answer for the current inputs.
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;

    setState((s) => ({ ...s, status: 'loading' }));
    setSelected(0);
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: { lat: o.lat, lon: o.lon }, to: { lat: d.lat, lon: d.lon },
          departHour: h, date: isoToYmd(when),
        }),
        signal: ctl.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (ctl.signal.aborted) return;

      // 429 and 503 are distinct, recoverable states — not "the server is
      // down". Collapsing them into one message is how a rate limit looks
      // like an outage.
      if (r.status === 429) {
        setState({ status: 'error', kind: 'rate', message: 'That is a lot of searches in a minute. Give it a moment.', journeys: [] });
        return;
      }
      if (r.status === 503) {
        setState({ status: 'error', kind: 'busy', message: 'Busy right now. Try that again.', journeys: [] });
        return;
      }
      if (!r.ok) {
        setState({ status: 'error', message: data.error ?? 'That search could not be run.', journeys: [] });
        return;
      }
      setState({
        status: 'done', journeys: data.journeys ?? [],
        coverage: data.coverage, sources: data.sources,
        generatedAt: data.generatedAt, date: data.date, calendar: data.calendar,
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
      setState({ status: 'error', message: 'The search service is not responding.', journeys: [] });
    }
  }, [from, to, departHour, date]);

  useEffect(() => { run(); /* eslint-disable-next-line */ }, []);

  const journeys = state.journeys ?? [];

  // Every ribbon is measured against ONE axis, so a 4h option is physically
  // shorter than a 15h one. Per-row normalising would make them the same
  // length and destroy the only comparison this list exists to make.
  const axis = useMemo(() => timeAxis(journeys), [journeys]);
  const ymd = state.date ?? isoToYmd(date);
  const ribbons = useMemo(
    () => journeys.map((j) => ribbonFor(j, axis, ymd)),
    [journeys, axis, ymd],
  );

  const sorts = useMemo(() => sortsFor(journeys), [journeys]);
  const order = useMemo(() => {
    const cmp = sorts.find((s) => s.key === sort)?.cmp;
    const idx = journeys.map((_, i) => i);
    return cmp ? idx.sort((a, b) => cmp(journeys[a], journeys[b])) : idx;
  }, [journeys, sorts, sort]);

  const badges = useMemo(() => badgesFor(journeys), [journeys]);
  const cadence = useMemo(() => cadenceOf(journeys), [journeys]);
  const active = journeys[selected] ?? null;

  // Hour ticks across the shared axis. Three at 360px, six above it — a ruler
  // nobody can read is decoration.
  const ticks = useMemo(() => {
    const out = [];
    const startHour = Math.ceil(axis.startMin / 360) * 360;
    for (let m = startHour; m <= axis.endMin; m += 360) {
      out.push({ min: m, at: positionOn(axis, m), midnight: ((m % 1440) + 1440) % 1440 === 0 });
    }
    return out;
  }, [axis]);

  return (
    <div className="app">
      <header className="masthead">
        <h1>Where next</h1>
        <p className="masthead-stats num">
          189,209 STOPS · 384,515 SERVICES · 6 FEEDS
        </p>
      </header>

      <form className="search" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <PlaceField
          id="from" label="From" value={fromText}
          placeholder="Where you are"
          onText={setFromText}
          onPick={(p) => { setFrom(p); setFromText(p.name); run(p, to, departHour, date); }}
        />
        <button
          type="button" className="swap" aria-label="Swap origin and destination"
          onClick={() => {
            const [nf, nt] = [to, from];
            const [nft, ntt] = [toText, fromText];
            setFrom(nf); setTo(nt); setFromText(nft); setToText(ntt);
            run(nf, nt, departHour, date);
          }}
        >⇄</button>
        <PlaceField
          id="to" label="To" value={toText}
          placeholder="Where you're going"
          onText={setToText}
          onPick={(p) => { setTo(p); setToText(p.name); run(from, p, departHour, date); }}
        />
        <div className="field field--date">
          <label htmlFor="when">On</label>
          <input
            id="when" type="date" value={date}
            min={isoToday()}
            // Bounded by the calendars actually ingested: past the horizon the
            // server stops filtering by day, so the answer would quietly go
            // back to "every train, any day" while still looking precise.
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
          <label htmlFor="depart">After</label>
          <select id="depart" value={departHour}
                  onChange={(e) => { const h = Number(e.target.value); setDepartHour(h); run(from, to, h, date); }}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
            ))}
          </select>
        </div>
      </form>

      <div className="workspace">
        <main className="answer">
          {state.status === 'loading' && !journeys.length && (
            <p className="notice">Reading the timetables…</p>
          )}

          {state.status === 'error' && (
            <p className={`notice notice--${state.kind ?? 'error'}`}>{state.message}</p>
          )}

          {state.status === 'done' && !journeys.length && (
            <div className="notice">
              {state.coverage ? (
                <p>
                  {state.coverage} We carry the published timetables of Germany,
                  France, Spain, Switzerland and the Netherlands, which reach
                  their neighbours wherever a train crosses the border.
                </p>
              ) : (
                <>
                  <p>
                    Nothing runs this way {dayLabel(date) === 'Today' || dayLabel(date) === 'Tomorrow'
                      ? dayLabel(date).toLowerCase()
                      : `on ${dayLabel(date)}`} after {String(departHour).padStart(2, '0')}:00.
                    {' '}Only about a quarter of the network runs on any given day.
                  </p>
                  <p className="notice-actions">
                    <button type="button" className="chip" onClick={() => {
                      const h = Math.max(0, departHour - 4);
                      setDepartHour(h); run(from, to, h, date);
                    }}>Leave earlier</button>
                    <button type="button" className="chip" onClick={() => {
                      const next = isoPlusDays(isoToYmd(date), 1);
                      setDate(next); run(from, to, departHour, next);
                    }}>Try the next day</button>
                  </p>
                </>
              )}
            </div>
          )}

          {journeys.length > 0 && (
            <>
              <div className="sortbar">
                {sorts.map((s) => (
                  <button
                    key={s.key} type="button" className="chip"
                    aria-pressed={sort === s.key}
                    onClick={() => setSort(s.key)}
                  >{s.label}</button>
                ))}
              </div>

              {/* Said once, above the list. A null repeated on every row reads
                  as a gap; stated once it reads as a position. */}
              <p className="no-fare">
                No fares. Open timetables carry schedules, not prices.
              </p>

              {cadence && (
                <p className="cadence">
                  <strong>{cadence.spine}</strong> runs this route {cadence.every}
                  {cadence.count < cadence.total
                    ? ` — ${cadence.count} of these ${cadence.total} are that train`
                    : ''}.
                </p>
              )}

              <div className="axis num" aria-hidden="true">
                {ticks.map((t, i) => (
                  <span
                    key={i}
                    className={`tick${t.midnight ? ' tick--midnight' : ''}`}
                    style={{ left: `${(t.at * 100).toFixed(3)}%` }}
                  >{hhmm(t.min)}</span>
                ))}
              </div>

              <div className="rows">
                {order.map((i) => (
                  <JourneyRow
                    key={i}
                    journey={journeys[i]}
                    ribbon={ribbons[i]}
                    badge={badges[i]}
                    active={i === selected}
                    onSelect={() => setSelected(i)}
                    onHover={(on) => setHovered(on ? i : -1)}
                  />
                ))}
              </div>

              <Detail journey={active} />
            </>
          )}
        </main>

        <aside className="globe-pane">
          <Globe
            journeys={journeys}
            activeIndex={hovered >= 0 ? hovered : selected}
            reduced={reduced}
          />
        </aside>
      </div>

      <footer>
        <p>
          {/* Feeds from one publisher share an attribution string; printing it
              once per feed would repeat it. EU Delegated Regulation 2017/1926
              Art. 8(3) requires the source AND the last-update time. */}
          {[...new Set((state.sources ?? []).map((s) => s.attribution))].join(' · ')}
          {state.generatedAt && ` · Timetable data retrieved ${state.generatedAt.slice(0, 10)}`}
        </p>
        <p>Schedules are not tickets. Confirm times and buy with the operator.</p>
      </footer>
    </div>
  );
}
