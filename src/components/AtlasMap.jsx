import { useEffect, useMemo, useRef, useState } from "react";
import { feature } from "topojson-client";
import { geoEquirectangular, geoPath } from "d3-geo";
import geography from "world-atlas/countries-50m.json";
import Icon from "./Icon.jsx";

const width = 1100,
  height = 1050;
const project = (lon, lat) => [(lon + 17) * 18, (72 - lat) * 24];
const countryNames = [
  ["UNITED KINGDOM", -3, 55],
  ["FRANCE", 2, 47],
  ["SPAIN", -4, 40],
  ["GERMANY", 10, 51],
  ["ITALY", 12, 42],
  ["AUSTRIA", 14, 47],
  ["POLAND", 20, 53],
  ["ROMANIA", 25, 46],
  ["GREECE", 23, 38],
  ["TÜRKİYE", 33, 39],
  ["UKRAINE", 31, 50],
  ["SWEDEN", 16, 63],
  ["NORWAY", 8, 65],
  ["FINLAND", 27, 65],
  ["CZECHIA", 15, 50],
];

export default function AtlasMap({ from, to, cities, onPick, mode = "plane" }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width:760px)").matches,
  );
  useEffect(() => {
    const q = window.matchMedia("(max-width:760px)");
    const update = () => setCompact(q.matches);
    q.addEventListener("change", update);
    return () => q.removeEventListener("change", update);
  }, []);
  const paths = useMemo(() => {
    // Spherical clipping splits polygons at the antimeridian. Connecting raw
    // longitude rings would paint Arctic land as a stripe across the ocean.
    const path = geoPath(
      geoEquirectangular()
        .scale((18 * 180) / Math.PI)
        .translate([17 * 18, 72 * 18]),
    ).digits(1);
    return feature(geography, geography.objects.countries).features.map(
      (country, index) => ({ id: `${country.id}-${index}`, d: path(country) }),
    );
  }, []);
  const a = project(from.lon, from.lat),
    b = project(to.lon, to.lat);
  const frame = useMemo(() => {
    const points = [project(from.lon, from.lat), project(to.lon, to.lat)];
    if (
      points.every(
        ([x, y]) => x >= 20 && x <= width - 20 && y >= 120 && y <= height - 100,
      )
    )
      return compact
        ? { x: 210, y: -35, w: 690, h: 1120 }
        : { x: 0, y: 0, w: width, h: height };
    const w = Math.max(width, Math.abs(points[0][0] - points[1][0]) + 500),
      h = Math.max(
        height,
        Math.abs(points[0][1] - points[1][1]) + 450,
        (w * height) / width,
      );
    return {
      x: (points[0][0] + points[1][0] - w) / 2,
      y: (points[0][1] + points[1][1] - h) / 2,
      w,
      h,
    };
  }, [from.lat, from.lon, to.lat, to.lon, compact]);
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [from.lat, from.lon, to.lat, to.lon]);
  const mx = (a[0] + b[0]) / 2,
    my = (a[1] + b[1]) / 2 - Math.min(140, Math.abs(a[0] - b[0]) * 0.3 + 50);
  const line = `M${a.join(",")}Q${mx},${my} ${b.join(",")}`;
  const nodes = [
    ...cities.filter((c) => c.name !== from.name && c.name !== to.name),
    from,
    to,
  ];
  return (
    <div className="atlas-map">
      <svg
        className={`map-svg ${dragging ? "is-dragging" : ""}`}
        viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
        role="group"
        aria-label={`Map from ${from.name} to ${to.name}. Dashed line shows your search corridor, not a confirmed service.`}
        onPointerDown={(e) => {
          if (e.target.closest("[data-city]")) return;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            ...{ px: pan.x, py: pan.y },
            scale: frame.w / e.currentTarget.clientWidth,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const d = drag.current;
          setPan({
            x: d.px + (e.clientX - d.x) * d.scale,
            y: d.py + (e.clientY - d.y) * d.scale,
          });
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        <defs>
          <pattern
            id="sea-grid"
            width="72"
            height="72"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M72 0H0V72"
              fill="none"
              stroke="#24343b"
              strokeWidth=".7"
            />
          </pattern>
          <linearGradient id="route-gradient">
            <stop stopColor="#77ead5" />
            <stop offset="1" stopColor="#cdfda1" />
          </linearGradient>
          <filter id="route-glow">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        <rect
          x={frame.x}
          y={frame.y}
          width={frame.w}
          height={frame.h}
          fill="#111e25"
        />
        <rect
          x={frame.x}
          y={frame.y}
          width={frame.w}
          height={frame.h}
          fill="url(#sea-grid)"
        />
        <g
          transform={`translate(${pan.x} ${pan.y}) translate(${frame.x + frame.w / 2} ${frame.y + frame.h / 2}) scale(${zoom}) translate(${-frame.x - frame.w / 2} ${-frame.y - frame.h / 2})`}
        >
          {paths.map((p) => (
            <path
              key={p.id}
              d={p.d}
              transform="scale(1 1.3333333333333)"
              className="country-shape"
              fillRule="evenodd"
            />
          ))}
          {countryNames.map(([name, lon, lat]) => (
            <text
              key={name}
              x={project(lon, lat)[0]}
              y={project(lon, lat)[1]}
              className="country-label"
            >
              {name}
            </text>
          ))}
          <text
            x="65"
            y="770"
            className="water-label"
            transform="rotate(-65 65 770)"
          >
            ATLANTIC OCEAN
          </text>
          <text x="460" y="890" className="water-label">
            MEDITERRANEAN SEA
          </text>
          <path
            d={line}
            fill="none"
            stroke="#7ee5c8"
            strokeWidth="9"
            opacity=".2"
            filter="url(#route-glow)"
          />
          <path
            d={line}
            className="search-route"
            fill="none"
            stroke="url(#route-gradient)"
            strokeWidth="2.5"
            strokeDasharray="7 7"
          />
          {nodes.map((city, i) => {
            const p = project(city.lon, city.lat),
              active = city.name === from.name || city.name === to.name;
            return (
              <g
                key={`${city.name}-${i}`}
                transform={`translate(${p.join(" ")})`}
                data-city="true"
                className={`map-city ${active ? "selected-city" : ""}`}
                role="button"
                tabIndex="0"
                aria-label={`Explore ${city.name}`}
                onClick={() => onPick(city)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPick(city);
                  }
                }}
              >
                <circle r="18" fill="transparent" />
                {active && <circle r="15" className="city-halo" />}
                <circle r={active ? 5 : 3.5} className="city-dot" />
                <text x="12" y="5" className="city-label">
                  {city.name}
                </text>
                {active && (
                  <text x="12" y="22" className="city-caption">
                    {city.name === from.name
                      ? "YOUR START"
                      : "YOUR DESTINATION"}
                  </text>
                )}
              </g>
            );
          })}
          <g
            transform={`translate(${mx - 17} ${(a[1] + 2 * my + b[1]) / 4 - 17})`}
          >
            <rect width="34" height="34" rx="17" fill="#82e6cb" />
            <g transform="translate(8 8)" color="#143931">
              <Icon name={mode} size={18} />
            </g>
          </g>
        </g>
      </svg>
      <div className="map-eyebrow">
        <span className="live-dot" /> A LITTLE PERSPECTIVE
      </div>
      <div className="map-title">
        More ways there.
        <br />
        <span>More left to spend.</span>
      </div>
      <div className="map-tools" aria-label="Map controls">
        <button
          onClick={() => setZoom((z) => Math.min(2.5, z + 0.25))}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          onClick={() => setZoom((z) => Math.max(0.6, z - 0.25))}
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          aria-label="Reset map"
        >
          <Icon name="compass" />
        </button>
      </div>
      <div className="map-key">
        <span className="dashed-key" /> Search corridor · availability
        unconfirmed
      </div>
      <span className="map-attribution">Natural Earth · OurAirports</span>
    </div>
  );
}
