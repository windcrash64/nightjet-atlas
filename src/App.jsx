import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import AtlasMap from "./components/AtlasMap.jsx";
import Icon from "./components/Icon.jsx";
import {
  places,
  searchPlaces,
  nearestAirports,
  providerLinks,
  formatDuration,
  budgetTotal,
  rankJourneys,
} from "./lib/planner.js";
import { ribbonFor, timeAxis } from "./lib/ribbon.js";

const Globe = lazy(() => import("./components/Globe.jsx"));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const findCity = (name) => places.find((p) => p.name === name) || places[0];
const money = (value) =>
  new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(value);
const cityNames = [
  "London",
  "Paris",
  "Berlin",
  "Munich",
  "Prague",
  "Vienna",
  "Rome",
  "Barcelona",
  "Amsterdam",
  "Istanbul",
  "Budapest",
  "Warsaw",
  "Copenhagen",
  "Lisbon",
  "Zurich",
];
const readSaved = () => {
  try {
    const a = JSON.parse(localStorage.getItem("travel-freely.saved") || "[]");
    return Array.isArray(a)
      ? a.filter((s) => s?.from?.name && s?.to?.name && s?.date).slice(0, 30)
      : [];
  } catch {
    return [];
  }
};

function PlaceInput({ label, value, onChange }) {
  const [text, setText] = useState(value.name),
    [open, setOpen] = useState(false),
    [highlight, setHighlight] = useState(0);
  const results = useMemo(() => searchPlaces(text, 6), [text]);
  const ref = useRef(null);
  useEffect(() => setText(value.name), [value]);
  const pick = (place) => {
    onChange(place);
    setText(place.name);
    setOpen(false);
    ref.current?.focus();
  };
  return (
    <div className="place-input">
      <label htmlFor={`place-${label}`}>{label}</label>
      <div className="place-value">
        <span
          className={`place-dot ${label === "To" ? "destination-dot" : ""}`}
        />
        <input
          ref={ref}
          id={`place-${label}`}
          role="combobox"
          aria-expanded={open}
          aria-controls={`list-${label}`}
          aria-autocomplete="list"
          aria-activedescendant={
            open && results[highlight] ? `${label}-${highlight}` : undefined
          }
          value={text}
          autoComplete="off"
          spellCheck="false"
          onFocus={(e) => {
            e.target.select();
            setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
            setText(value.name);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setHighlight((h) => Math.min(results.length - 1, h + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            }
            if (e.key === "Enter" && open) {
              e.preventDefault();
              if (results[highlight]) pick(results[highlight]);
            }
            if (e.key === "Escape") {
              setOpen(false);
              setText(value.name);
            }
          }}
        />
        <span className="airport-code">{value.iata || value.country}</span>
      </div>
      {open && (
        <ul id={`list-${label}`} role="listbox" className="place-options">
          {results.length ? (
            results.map((p, i) => (
              <li
                key={`${p.kind}-${p.name}-${p.iata}`}
                id={`${label}-${i}`}
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
              >
                <Icon name={p.kind === "airport" ? "plane" : "pin"} />
                <span>
                  {p.name}
                  <small>
                    {p.countryName || p.country}
                    {p.kind === "airport" ? " · Airport" : ""}
                  </small>
                </span>
                <b>{p.iata}</b>
              </li>
            ))
          ) : (
            <li className="no-place">Try a city name or an airport code.</li>
          )}
        </ul>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <header>
        <h2 id="modal-title">{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}

function JourneyCard({ journey, active, onSelect, ribbon }) {
  const flight = journey.mode === "plane",
    price = journey.price;
  return (
    <button
      className={`journey-card ${active ? "active" : ""}`}
      onClick={onSelect}
    >
      <div className="journey-top">
        <span className={`mode-square ${flight ? "flight" : "rail"}`}>
          <Icon
            name={flight ? "plane" : journey.mode === "bus" ? "bus" : "train"}
          />
        </span>
        <span>
          <strong>
            {{ plane: "Flight", train: "Train", bus: "Bus", metro: "Metro" }[
              journey.mode
            ] || "Transit"}{" "}
            ·{" "}
            {journey.legs?.find((l) => l.service)?.service ||
              journey.source?.name ||
              journey.provider}
          </strong>
          <small>
            {journey.changes == null
              ? "Changes unconfirmed"
              : journey.changes === 0
                ? "Direct"
                : `${journey.changes} changes`}{" "}
            · {flight ? "Provider fare" : "Published timetable"}
          </small>
        </span>
        <Icon name="chevron" size={16} />
      </div>
      <div className="journey-bottom">
        <strong>{formatDuration(journey.durationMinutes)}</strong>
        <span>
          {price?.amount != null
            ? new Intl.NumberFormat("en-IE", {
                style: "currency",
                currency: price.currency,
              }).format(price.amount)
            : "Fare unavailable"}
        </span>
      </div>
      <div className="journey-times">
        <span>
          {journey.departure?.slice(11, 16)} → {journey.arrival?.slice(11, 16)}
          {journey.arrival?.slice(0, 10) !== journey.departure?.slice(0, 10)
            ? " (+1 day)"
            : ""}
        </span>
        <span>{flight ? "Airport to airport" : "Station to station"}</span>
      </div>
      {ribbon?.bands?.length > 0 && (
        <div
          className="sky-ribbon"
          title="Computed daylight along this rail journey, on a shared time scale"
          aria-label="Computed daylight along this rail journey"
        >
          <div
            style={{
              left: `${ribbon.left * 100}%`,
              width: `${ribbon.width * 100}%`,
            }}
          >
            {ribbon.bands.map((b, i) => (
              <span
                key={i}
                className={`band--${b.band}`}
                style={{
                  left: `${b.start * 100}%`,
                  width: `${(b.end - b.start) * 100}%`,
                }}
              />
            ))}
          </div>
        </div>
      )}
      <div className="journey-line">
        <span>{journey.legs?.[0]?.from?.name || journey.from?.name}</span>
        <span>→</span>
        <span>{journey.legs?.at(-1)?.to?.name || journey.to?.name}</span>
      </div>
    </button>
  );
}

function legTime(leg) {
  const clock = (min) =>
    min == null
      ? "?"
      : `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}${min >= 1440 ? ` (+${Math.floor(min / 1440)} day)` : ""}`;
  return `${leg.departure ? leg.departure.replace("T", " · ").slice(0, 18) : clock(leg.departMin)} → ${leg.arrival ? leg.arrival.replace("T", " · ").slice(0, 18) : clock(leg.arriveMin)}`;
}

export default function App() {
  const [from, setFrom] = useState(() => findCity("Berlin")),
    [to, setTo] = useState(() => findCity("Munich"));
  const [date, setDate] = useState(tomorrow),
    [adults, setAdults] = useState(1),
    [budget, setBudget] = useState(150);
  const [mode, setMode] = useState("all"),
    [sort, setSort] = useState("fastest"),
    [tab, setTab] = useState("explore"),
    [view, setView] = useState("map");
  const [saved, setSaved] = useState(readSaved),
    [modal, setModal] = useState(null),
    [toast, setToast] = useState("");
  const [state, setState] = useState({
      status: "idle",
      journeys: [],
      providers: [],
    }),
    [selected, setSelected] = useState(null);
  const [costs, setCosts] = useState({
    fare: "",
    baggage: "",
    originTransfer: "",
    destinationTransfer: "",
  });
  const [bag, setBag] = useState("backpack");
  const [showAll, setShowAll] = useState(false);
  const [mobileMap, setMobileMap] = useState(false);
  const abort = useRef(null);
  const inputKey = JSON.stringify({ from, to, date, adults });
  const [searchedKey, setSearchedKey] = useState("");
  const stale = searchedKey && searchedKey !== inputKey;
  const originAirports = useMemo(() => nearestAirports(from, 3), [from]),
    destinationAirports = useMemo(() => nearestAirports(to, 3), [to]);
  const links = useMemo(
    () => providerLinks(from, to, date, { adults }),
    [from, to, date, adults],
  );
  const mapCities = useMemo(
    () => places.filter((p) => cityNames.includes(p.name)),
    [],
  );
  const journeys = useMemo(
    () =>
      rankJourneys(
        state.journeys.filter((j) => mode === "all" || j.mode === mode),
        sort,
      ),
    [state.journeys, mode, sort],
  );
  const active = !stale
    ? state.journeys.find((j) => j.id === selected)
    : undefined;
  const railProvider = state.providers.find((p) => p.id === "rail");
  const sourceRows = railProvider?.sources || [];
  const ribbons = useMemo(() => {
    const minutes = (iso, day) =>
      (Date.parse(`${iso}Z`) - Date.parse(`${day}T00:00:00Z`)) / 60000;
    const rail = state.journeys
      .filter((j) => j.mode === "train" && j.timeBasis === "agency_local")
      .map((j) => ({
        ...j,
        departMin: minutes(j.departure, j.date),
        arriveMin: minutes(j.arrival, j.date),
        legs: j.legs.map((l) => ({
          ...l,
          departMin: minutes(l.departure, j.date),
          arriveMin: minutes(l.arrival, j.date),
        })),
      }));
    const axis = timeAxis(rail);
    return Object.fromEntries(
      rail.map((j) => [
        j.id,
        ribbonFor(j, axis, Number(j.date.replaceAll("-", ""))),
      ]),
    );
  }, [state.journeys]);
  const total = budgetTotal(
    Object.fromEntries(
      Object.entries(costs).map(([k, v]) => [k, v === "" ? null : Number(v)]),
    ),
  );
  const knownCosts = Object.values(costs)
    .filter((v) => v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0)
    .reduce((a, v) => a + Number(v), 0);
  const isSaved = saved.some(
    (s) =>
      s.from.name === from.name && s.to.name === to.name && s.date === date,
  );
  const notify = (text) => setToast(text);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 3500);
      return () => clearTimeout(t);
    }
  }, [toast]);

  async function run() {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setSelected(null);
    setShowAll(false);
    setSearchedKey(inputKey);
    if (from.lat === to.lat && from.lon === to.lon) {
      setState({
        status: "error",
        message: "Choose two different places.",
        journeys: [],
        providers: [],
      });
      return;
    }
    if (!date || date < today()) {
      setState({
        status: "error",
        message: "Choose today or a future date.",
        journeys: [],
        providers: [],
      });
      return;
    }
    setState({ status: "loading", journeys: [], providers: [] });
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: {
            name: from.name,
            lat: from.lat,
            lon: from.lon,
            ...(from.iata ? { iata: from.iata } : {}),
          },
          to: {
            name: to.name,
            lat: to.lat,
            lon: to.lon,
            ...(to.iata ? { iata: to.iata } : {}),
          },
          date,
          adults,
          cabin: "economy",
          modes: ["plane", "train", "bus", "metro"],
        }),
        signal: ctl.signal,
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(
          data.message || "Search is unavailable. Try again shortly.",
        );
      if (ctl.signal.aborted) return;
      setState({
        ...data,
        status: "done",
        journeys: data.journeys || [],
        providers: data.providers || [],
      });
    } catch (e) {
      if (e.name !== "AbortError")
        setState({
          status: "error",
          message:
            e.message === "Failed to fetch"
              ? "The search service could not be reached. You can still check fares with the providers below."
              : e.message,
          journeys: [],
          providers: [],
        });
    }
  }
  useEffect(() => {
    run();
    return () => abort.current?.abort();
  }, []);
  function saveTrip() {
    if (isSaved) {
      setTab("saved");
      return;
    }
    const next = [
      { id: Date.now(), from, to, date, adults, budget, bag, costs },
      ...saved,
    ].slice(0, 30);
    try {
      localStorage.setItem("travel-freely.saved", JSON.stringify(next));
      setSaved(next);
      notify("Trip saved on this device.");
    } catch {
      notify("Your browser could not save this trip.");
    }
  }
  function removeSaved(id) {
    const next = saved.filter((s) => s.id !== id);
    try {
      localStorage.setItem("travel-freely.saved", JSON.stringify(next));
      setSaved(next);
    } catch {
      notify("Your browser could not update saved trips.");
    }
  }
  const modeOptions = [
    ["all", "compass", "All ways"],
    ["plane", "plane", "Flights"],
    ["train", "train", "Trains"],
    ["bus", "bus", "Buses"],
  ];
  const dateLabel = date
    ? new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      })
    : "Choose date";

  return (
    <div className={`app-shell ${mobileMap ? "mobile-map-active" : ""}`}>
      <header className="topbar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            setTab("explore");
          }}
          aria-label="Travel Freely home"
        >
          <span className="brand-symbol">
            <Icon name="plane" size={22} />
          </span>
          travel<span>freely</span>
          <span className="beta">BETA</span>
        </a>
        <nav aria-label="Main navigation">
          <button
            className={tab === "explore" ? "current" : ""}
            onClick={() => setTab("explore")}
          >
            <Icon name="compass" size={17} />
            Explore
          </button>
          <button
            className={tab === "saved" ? "current" : ""}
            onClick={() => setTab("saved")}
          >
            <Icon name="heart" size={17} />
            Saved trips
            {saved.length > 0 && (
              <span className="nav-count">{saved.length}</span>
            )}
          </button>
        </nav>
        <div className="topbar-right">
          <button className="about-button" onClick={() => setModal("about")}>
            Made for travelers <Icon name="external" size={13} />
          </button>
          <span className="currency">EUR €</span>
          <button
            className="profile"
            aria-label="About Travel Freely"
            onClick={() => setModal("about")}
          >
            tf
          </button>
        </div>
      </header>
      <div className="workspace">
        <main className="planner-pane">
          {tab === "saved" ? (
            <section className="saved-view">
              <span className="eyebrow">YOUR NEXT CHAPTERS</span>
              <h1>
                Little plans.
                <br />
                Big possibilities.
              </h1>
              <p>Saved on this device. No account needed.</p>
              {saved.length === 0 ? (
                <div className="empty-saved">
                  <Icon name="heart" size={34} />
                  <h2>A trip worth keeping?</h2>
                  <p>Save a search and come back to it here.</p>
                  <button
                    className="primary-button"
                    onClick={() => setTab("explore")}
                  >
                    Explore a trip <Icon name="arrow" />
                  </button>
                </div>
              ) : (
                saved.map((s) => (
                  <article className="saved-card" key={s.id}>
                    <div>
                      <strong>
                        {s.from.name} → {s.to.name}
                      </strong>
                      <p>
                        {s.date} · {money(s.budget)} budget
                      </p>
                    </div>
                    <button
                      className="icon-button"
                      aria-label={`Open saved trip to ${s.to.name}`}
                      onClick={() => {
                        abort.current?.abort();
                        setFrom(s.from);
                        setTo(s.to);
                        setDate(s.date < today() ? tomorrow() : s.date);
                        setAdults(s.adults || 1);
                        setBudget(s.budget);
                        setBag(s.bag || "backpack");
                        setCosts(
                          s.costs || {
                            fare: "",
                            baggage: "",
                            originTransfer: "",
                            destinationTransfer: "",
                          },
                        );
                        setTab("explore");
                        setState({
                          status: "idle",
                          journeys: [],
                          providers: [],
                        });
                        setSearchedKey("");
                      }}
                    >
                      <Icon name="arrow" />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Remove saved trip to ${s.to.name}`}
                      onClick={() => removeSaved(s.id)}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </article>
                ))
              )}
            </section>
          ) : (
            <>
              <div className="intro">
                <div className="eyebrow">
                  <span /> LESS ON GETTING THERE. MORE ON BEING THERE.
                </div>
                <h1>Where are we going?</h1>
                <p>Find your way. Keep your freedom.</p>
              </div>
              <form
                className="search-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  run();
                }}
              >
                <div className="places-box">
                  <PlaceInput label="From" value={from} onChange={setFrom} />
                  <button
                    className="swap-button"
                    type="button"
                    aria-label="Swap origin and destination"
                    onClick={() => {
                      setFrom(to);
                      setTo(from);
                    }}
                  >
                    <Icon name="swap" size={17} />
                  </button>
                  <PlaceInput label="To" value={to} onChange={setTo} />
                </div>
                <div className="date-passengers">
                  <label>
                    <span>
                      Departure <small>ONE WAY</small>
                    </span>
                    <div>
                      <Icon name="calendar" size={17} />
                      <input
                        aria-label="Departure date"
                        type="date"
                        value={date}
                        min={today()}
                        required
                        onChange={(e) => setDate(e.target.value)}
                      />
                    </div>
                  </label>
                  <label>
                    <span>Travelers</span>
                    <select
                      aria-label="Number of travelers"
                      value={adults}
                      onChange={(e) => setAdults(Number(e.target.value))}
                    >
                      {Array.from({ length: 8 }, (_, i) => (
                        <option key={i} value={i + 1}>
                          {i + 1} {i === 0 ? "adult" : "adults"}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  className="primary-button search-button"
                  type="submit"
                  disabled={state.status === "loading"}
                >
                  {state.status === "loading" ? (
                    <>
                      <span className="spinner" />
                      Finding your way…
                    </>
                  ) : (
                    <>
                      Find my way <Icon name="arrow" size={20} />
                    </>
                  )}
                </button>
              </form>
              <div className="preferences">
                <button onClick={() => setModal("budget")}>
                  <Icon name="wallet" size={16} />
                  {money(budget)} total budget
                  <Icon name="chevron" size={13} />
                </button>
                <button onClick={() => setModal("budget")}>
                  <Icon name="bag" size={16} />
                  {bag === "backpack"
                    ? "Just a backpack"
                    : bag === "cabin"
                      ? "Cabin bag"
                      : "Checked bag"}
                  <Icon name="chevron" size={13} />
                </button>
              </div>
              <div className="mode-tabs" role="group" aria-label="Travel mode">
                {modeOptions.map(([key, icon, label]) => (
                  <button
                    key={key}
                    aria-pressed={mode === key}
                    className={mode === key ? "selected" : ""}
                    onClick={() => setMode(key)}
                  >
                    <Icon name={icon} size={16} />
                    {label}
                  </button>
                ))}
              </div>
              <section
                className="results"
                aria-busy={state.status === "loading"}
              >
                <div className="results-title">
                  <div>
                    <h2>
                      {from.name} <span>→</span> {to.name}
                    </h2>
                    <p>
                      {dateLabel} · {adults}{" "}
                      {adults === 1 ? "traveler" : "travelers"} · economy
                    </p>
                  </div>
                  <button
                    className={`icon-button save-button ${isSaved ? "saved" : ""}`}
                    aria-label={isSaved ? "View saved trip" : "Save this trip"}
                    onClick={saveTrip}
                  >
                    <Icon name="heart" />
                  </button>
                </div>
                {(mode === "all" || mode === "plane") &&
                  !state.journeys.some((j) => j.mode === "plane") &&
                  links.find((l) => l.mode === "plane") && (
                    <a
                      className="flight-handoff"
                      href={links.find((l) => l.mode === "plane").url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="mode-square flight">
                        <Icon name="plane" />
                      </span>
                      <span>
                        <strong>Explore flight prices</strong>
                        <small>
                          Check this trip on Skyscanner · live fares aren’t
                          connected here yet
                        </small>
                      </span>
                      <Icon name="external" size={17} />
                    </a>
                  )}
                {stale && (
                  <div className="search-notice">
                    <Icon name="info" size={17} />
                    Your trip changed. Select “Find my way” to update results.
                  </div>
                )}
                <div aria-live="polite">
                  {state.status === "error" && (
                    <p className="search-notice error">{state.message}</p>
                  )}
                  {state.status === "loading" && (
                    <p className="search-notice">
                      Checking available timetables and fare connections…
                    </p>
                  )}
                </div>
                {!stale && journeys.length > 0 && (
                  <>
                    <div className="sort-row">
                      <span>
                        {journeys.length}{" "}
                        {mode === "plane" ? "flight" : "journey"}{" "}
                        {journeys.length === 1 ? "option" : "options"}
                      </span>
                      <select
                        aria-label="Sort journeys"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="fastest">Fastest first</option>
                        <option value="cheapest">Lowest known fare</option>
                      </select>
                    </div>
                    {sort === "cheapest" && (
                      <p className="micro-note">
                        Only known EUR fares are ranked by price. Transfers and
                        bags may cost extra.
                      </p>
                    )}
                    {journeys.slice(0, showAll ? 8 : 3).map((j) => (
                      <JourneyCard
                        key={j.id}
                        journey={j}
                        ribbon={ribbons[j.id]}
                        active={selected === j.id}
                        onSelect={() => {
                          setSelected(j.id);
                          setModal("journey");
                        }}
                      />
                    ))}
                    {journeys.length > 3 && (
                      <button
                        className="show-more"
                        onClick={() => setShowAll(!showAll)}
                      >
                        {showAll
                          ? "Show fewer options"
                          : `Show all ${Math.min(8, journeys.length)} options`}{" "}
                        <Icon name="chevron" size={14} />
                      </button>
                    )}
                    {journeys.some((j) => j.mode === "train") && (
                      <p className="micro-note rail-scope">
                        Rail times are station to station. City transfers aren’t
                        included. The colored strip shows computed daylight on a
                        shared time scale.
                      </p>
                    )}
                  </>
                )}
                {!stale && state.status === "done" && journeys.length === 0 && (
                  <p className="micro-note empty-result">
                    {mode === "all"
                      ? "No timetable or live-fare options were returned."
                      : `No ${mode === "plane" ? "flight" : mode === "train" ? "train" : "bus"} results for this search.`}{" "}
                    Explore the providers below.
                  </p>
                )}
                <div className="provider-heading">
                  <span>CHECK WITH THE SOURCE</span>
                  <span>NO MARKUP</span>
                </div>
                {links
                  .filter((l) => mode === "all" || l.mode === mode)
                  .filter(
                    (l) =>
                      l.mode !== "plane" ||
                      state.journeys.some((j) => j.mode === "plane"),
                  )
                  .filter(
                    (l, i, a) => a.findIndex((x) => x.mode === l.mode) === i,
                  )
                  .map((link) => (
                    <a
                      key={link.id}
                      className={`provider-card provider-${link.mode}`}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <div className="provider-icon">
                        <Icon
                          name={
                            link.mode === "plane"
                              ? "plane"
                              : link.mode === "train"
                                ? "train"
                                : "bus"
                          }
                          size={22}
                        />
                      </div>
                      <div className="provider-copy">
                        <strong>
                          {link.mode === "plane"
                            ? "Start with flights"
                            : link.mode === "train"
                              ? "Take the scenic route"
                              : "Compare coach connections"}
                        </strong>
                        <span>
                          {link.name} ·{" "}
                          {link.prefilled
                            ? "Your route is ready"
                            : "Check route and date"}
                        </span>
                      </div>
                      <Icon name="external" size={16} />
                    </a>
                  ))}
                <div className="honesty-note">
                  <Icon name="info" size={16} />
                  <p>
                    Fares are checked with the provider. We’ll only call
                    something “cheapest” when we can compare real prices.
                  </p>
                </div>
              </section>
              <section className="last-mile">
                <div>
                  <span className="eyebrow">
                    THE LAST FEW KILOMETERS MATTER
                  </span>
                  <h2>Airport ≠ city center.</h2>
                  <p>
                    Compare nearby airports and plan the bus or metro before you
                    book.
                  </p>
                </div>
                <button
                  aria-label="Compare airports and city transfers"
                  onClick={() => setModal("airports")}
                >
                  <Icon name="arrow" />
                </button>
              </section>
              <div className="pane-footer">
                <span>
                  <Icon name="check" size={13} /> No sponsored ranking
                </span>
                <button onClick={() => setModal("sources")}>
                  Data & coverage
                </button>
              </div>
              <div className="attribution">
                {sourceRows.map((s) => (
                  <p key={s.id}>
                    {s.attribution || s.name}
                    {(s.retrievedAt || s.updatedAt) &&
                      ` · Retrieved ${(s.retrievedAt || s.updatedAt).slice(0, 10)}`}
                  </p>
                ))}
              </div>
            </>
          )}
        </main>
        <aside className="map-pane" aria-label="Interactive journey map">
          <div className="map-view-switch">
            <button
              className={view === "map" ? "active" : ""}
              onClick={() => setView("map")}
            >
              <Icon name="pin" size={14} />
              Map
            </button>
            <button
              className={view === "globe" ? "active" : ""}
              onClick={() => setView("globe")}
            >
              <Icon name="globe" size={15} />
              Globe
            </button>
          </div>
          {view === "map" ? (
            <AtlasMap
              from={from}
              to={to}
              cities={mapCities}
              mode={mode === "all" ? "plane" : mode}
              onPick={(p) => {
                if (p.name !== from.name) {
                  setTo(p);
                  setTab("explore");
                  notify(`${p.name} selected. Find your way to check options.`);
                }
              }}
            />
          ) : (
            <div className="globe-view">
              <Suspense
                fallback={
                  <div className="globe-loading">Opening the world…</div>
                }
              >
                <Globe
                  journeys={
                    active
                      ? [active]
                      : [{ legs: [{ mode: "plane", from, to }] }]
                  }
                  activeIndex={0}
                  reduced={
                    window.matchMedia("(prefers-reduced-motion: reduce)")
                      .matches
                  }
                />
              </Suspense>
              <div className="globe-caption">
                {from.name} → {to.name}
                <small>
                  {active
                    ? "Selected timetable · lines connect published stops"
                    : "Search corridor · availability unconfirmed"}
                </small>
              </div>
            </div>
          )}
          <div className="map-bottom-card">
            <span className="discovery-icon">
              <Icon name="compass" size={24} />
            </span>
            <div>
              <strong>A place in mind? A whole world around it.</strong>
              <p>Pick a city on the map to make it your next stop.</p>
            </div>
            <span className="map-card-mark">↗</span>
          </div>
        </aside>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={17} />
          {toast}
        </div>
      )}
      <button
        className="mobile-surface-toggle"
        onClick={() => setMobileMap((v) => !v)}
      >
        <Icon name={mobileMap ? "train" : "globe"} size={17} />
        {mobileMap ? "Trip planner" : "Explore the map"}
      </button>
      {modal === "about" && (
        <Modal title="Travel freely. Really." onClose={() => setModal(null)}>
          <div className="modal-body">
            <span className="large-icon">
              <Icon name="plane" size={36} />
            </span>
            <p>
              A small, independent travel planner for people with more curiosity
              than cash.
            </p>
            <p>
              Compare flights and trains, check the journey into town, and leave
              room in your budget for the actual trip.
            </p>
            <ul className="promise-list">
              <li>
                <Icon name="check" />
                No sponsored ranking or booking markup.
              </li>
              <li>
                <Icon name="check" />
                Unknown prices stay unknown.
              </li>
              <li>
                <Icon name="check" />
                Your saved plans stay on your device.
              </li>
            </ul>
            <p className="micro-note">
              Built on Nightjet Atlas. This beta sends your search to configured
              travel providers and stores saved trips locally. No accounts,
              advertising trackers, or payments.
            </p>
            <a
              className="text-link"
              href="https://github.com/windcrash64/nightjet-atlas"
              target="_blank"
              rel="noreferrer"
            >
              Explore the open-source project <Icon name="external" size={15} />
            </a>
          </div>
        </Modal>
      )}
      {modal === "budget" && (
        <Modal
          title="Give the whole trip a budget."
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <p>
              A cheap ticket is only part of the story. Add the costs you find
              to see what’s really left.
            </p>
            <label className="budget-limit">
              Total travel budget{" "}
              <span>
                EUR · for all {adults} {adults === 1 ? "traveler" : "travelers"}
              </span>
              <input
                type="number"
                min="0"
                max="100000"
                value={budget}
                onChange={(e) => setBudget(Math.max(0, Number(e.target.value)))}
              />
            </label>
            <label className="bag-select">
              What are you bringing?
              <select value={bag} onChange={(e) => setBag(e.target.value)}>
                <option value="backpack">
                  Just a backpack / personal item
                </option>
                <option value="cabin">A cabin bag</option>
                <option value="checked">Checked luggage</option>
              </select>
            </label>
            <p className="micro-note">
              Baggage rules vary. This preference doesn’t imply a bag is
              included in a fare.
            </p>
            <div className="cost-fields">
              {[
                ["fare", "Tickets"],
                ["baggage", "Bags"],
                ["originTransfer", "Getting to the station / airport"],
                ["destinationTransfer", "Getting into town"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <span>
                    €
                    <input
                      aria-label={`${label} cost in EUR`}
                      type="number"
                      min="0"
                      step=".01"
                      placeholder="Unknown"
                      value={costs[key]}
                      onChange={(e) =>
                        setCosts((c) => ({ ...c, [key]: e.target.value }))
                      }
                    />
                  </span>
                </label>
              ))}
            </div>
            <div className="budget-result">
              <span>
                {total == null ? "Known costs so far" : "Your entered total"}
              </span>
              <strong>{money(total ?? knownCosts)}</strong>
              <div className="budget-track">
                <i
                  style={{
                    width: `${Math.min(100, budget > 0 ? (knownCosts / budget) * 100 : 100)}%`,
                  }}
                />
              </div>
              <p>
                {total == null
                  ? "Fill every cost (including zero) for a complete total."
                  : total <= budget
                    ? `${money(budget - total)} left in your budget.`
                    : `${money(total - budget)} over your budget.`}
              </p>
            </div>
            <p className="micro-note">
              These are your planning figures, not a live quote. Saved trips
              retain the figures from when you saved them.
            </p>
            <button className="primary-button" onClick={() => setModal(null)}>
              Keep exploring <Icon name="arrow" />
            </button>
          </div>
        </Modal>
      )}
      {modal === "airports" && (
        <Modal
          title="The airport is only part of it."
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <p>
              Airport distances are straight-line distances from your selected
              city. They aren’t transfer times or proof of a flight connection.
            </p>
            {[
              [from, originAirports, "Leaving"],
              [to, destinationAirports, "Arriving"],
            ].map(([city, airports, label]) => (
              <section className="airport-section" key={label}>
                <h3>
                  {label} · {city.name}
                </h3>
                {airports.map((a) => (
                  <div className="airport-row" key={a.iata}>
                    <span className="iata-pill">{a.iata}</span>
                    <div>
                      <strong>{a.name}</strong>
                      <small>
                        {Math.round(a.distanceKm)} km from selected location
                      </small>
                    </div>
                    <a
                      aria-label={`Find transit between ${a.name} and ${city.name}`}
                      href={`https://www.google.com/maps/dir/?api=1&origin=${label === "Leaving" ? `${city.lat},${city.lon}` : `${a.lat},${a.lon}`}&destination=${label === "Leaving" ? `${a.lat},${a.lon}` : `${city.lat},${city.lon}`}&travelmode=transit`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="external" size={17} />
                    </a>
                  </div>
                ))}
              </section>
            ))}
            <div className="search-notice">
              <Icon name="bus" size={18} />
              <span>
                Check the local metro or bus, first and last departures, and
                separate ticket costs. Transfer routing opens in Google Maps.
              </span>
            </div>
          </div>
        </Modal>
      )}
      {modal === "sources" && (
        <Modal
          title="Know what you’re looking at."
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <p>
              Availability depends on the route, date, and data connection. A
              map line is a search corridor, not a scheduled flight.
            </p>
            {state.providers.map((p) => (
              <div className="source-row" key={p.id}>
                <strong>
                  {p.id === "skyscanner"
                    ? "Flights · Skyscanner"
                    : p.id === "rail"
                      ? "Rail timetables"
                      : p.id}
                </strong>
                <span
                  className={`source-status ${p.status === "ok" ? "ready" : ""}`}
                >
                  {p.status.replaceAll("_", " ")}
                </span>
                <p>{p.message}</p>
              </div>
            ))}
            <p>
              Flights need approved live-price access. Bus and metro options
              currently open the provider’s planner; they aren’t included in an
              end-to-end timetable.
            </p>
            <p>
              Map: Natural Earth. Airports: OurAirports, public domain. Rail
              sources and retrieval dates are shown with timetable results.
            </p>
            {sourceRows.map((s) => (
              <div className="source-row" key={s.id}>
                <strong>{s.publisher || s.name}</strong>
                <p>{s.attribution}</p>
                <p>
                  Retrieved{" "}
                  {(
                    s.retrievedAt ||
                    s.updatedAt ||
                    railProvider.generatedAt
                  )?.slice(0, 10)}{" "}
                  · {s.license || s.licence}
                </p>
                {s.url && (
                  <a
                    className="text-link"
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Source data <Icon name="external" size={14} />
                  </a>
                )}
                {s.licenceUrl && (
                  <a
                    className="text-link"
                    href={s.licenceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    License <Icon name="external" size={14} />
                  </a>
                )}
              </div>
            ))}
            <p className="micro-note">
              Reconfirm schedules, fare conditions, luggage and any student
              eligibility before booking. Separate tickets may leave you
              responsible for a missed connection.
            </p>
          </div>
        </Modal>
      )}
      {modal === "journey" && active && (
        <Modal
          title={`${from.name} to ${to.name}`}
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <div className="detail-summary">
              <strong>{formatDuration(active.durationMinutes)}</strong>
              <span>
                {active.changes == null
                  ? "Changes unconfirmed"
                  : active.changes === 0
                    ? "Direct journey"
                    : `${active.changes} changes`}
              </span>
            </div>
            <p className="micro-note">
              {active.timeBasis === "airport_local"
                ? "Times are local to each airport. The displayed duration excludes airport transfers, check-in and security."
                : "Times follow the timetable’s local clock (Central Europe for the bundled rail feed). City transfers are excluded."}
            </p>
            <ol className="itinerary">
              {active.legs?.map((leg, i) => (
                <li key={i}>
                  <span className="timeline-dot" />
                  <div>
                    <strong>
                      {leg.service ||
                        leg.operator ||
                        (leg.mode === "walk" ? "Walk / transfer" : "Train")}
                    </strong>
                    <p>
                      {leg.from?.name} → {leg.to?.name}
                    </p>
                    <small>{legTime(leg)}</small>
                  </div>
                </li>
              ))}
            </ol>
            {active.notes?.map((note, i) => (
              <p key={i} className="micro-note">
                {note}
              </p>
            ))}
            {active.transferType &&
              active.transferType !== "TRANSFER_TYPE_MANAGED" && (
                <p className="search-notice">
                  Check connection protection with the seller. This option may
                  involve a self-transfer or separate tickets.
                </p>
              )}
            <p className="search-notice">
              {active.price
                ? `Provider fare: ${new Intl.NumberFormat("en-IE", { style: "currency", currency: active.price.currency }).format(active.price.amount)}. Confirm baggage and transfers before booking.`
                : "This timetable has no ticket price. Check fares with the operator."}
            </p>
            {active.bookingUrl && (
              <a
                className="primary-button"
                href={active.bookingUrl}
                target="_blank"
                rel="noreferrer"
              >
                Check with the provider <Icon name="external" size={17} />
              </a>
            )}
            {!active.bookingUrl && active.bookingLinks?.length > 0 && (
              <div>
                <p className="search-notice">
                  This option needs separate bookings. Confirm every ticket and
                  leave enough time for each connection before paying.
                </p>
                {active.bookingLinks.map((link, i) => (
                  <a
                    key={i}
                    className="primary-button"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Booking {i + 1} · {link.agent || "Provider"}{" "}
                    <Icon name="external" size={16} />
                  </a>
                ))}
              </div>
            )}
            {!active.bookingUrl && !active.bookingLinks?.length && (
              <a
                className="primary-button"
                href={
                  links.find((l) => l.mode === active.mode)?.url ||
                  "https://int.bahn.de/en"
                }
                target="_blank"
                rel="noreferrer"
              >
                Check fares with the operator <Icon name="external" size={16} />
              </a>
            )}
            {active.sources?.map((s) => (
              <p className="micro-note" key={s.id}>
                {s.attribution || s.name} · Retrieved{" "}
                {(
                  s.retrievedAt ||
                  s.updatedAt ||
                  active.source.generatedAt
                )?.slice(0, 10)}
              </p>
            ))}
            <p className="micro-note">
              {active.source?.name}
              {active.source?.fetchedAt
                ? ` · Retrieved ${active.source.fetchedAt.slice(0, 10)}`
                : ""}
            </p>
            {active.source?.url && (
              <a
                className="text-link"
                href={active.source.url}
                target="_blank"
                rel="noreferrer"
              >
                Timetable source <Icon name="external" size={14} />
              </a>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
