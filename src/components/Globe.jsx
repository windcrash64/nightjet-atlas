import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import { feature } from 'topojson-client';
import countries110m from 'world-atlas/countries-110m.json';
import * as THREE from 'three';

/**
 * The world, with the journey drawn on it.
 *
 * Country geometry comes from Natural Earth via world-atlas (public domain),
 * rendered as vector outlines rather than raster map tiles. That is a deliberate
 * choice: OSM's tile CDN returns its "Access blocked" page as HTTP 200 image/png
 * and is withdrawable from commercial services without notice, and every keyed
 * provider costs money. Drawing the coastline ourselves has no rate limit, no
 * attribution risk, and no bill.
 */

const RADIUS = 2.4;

const MODE_COLOUR = {
  night_rail: '#f0c674',
  rail: '#8fc7e8',
  coach: '#c3a380',
  ferry: '#7fd4c1',
  metro: '#9db4d0',
  tram: '#9db4d0',
  walk: '#5c6b82',
};

function toVector(lat, lon, radius = RADIUS) {
  const phi = (lat * Math.PI) / 180;
  const theta = (lon * Math.PI) / 180;
  return new THREE.Vector3(
    radius * Math.cos(phi) * Math.sin(theta),
    radius * Math.sin(phi),
    radius * Math.cos(phi) * Math.cos(theta),
  );
}

/** A great-circle arc, lifted off the surface so it reads as a journey. */
function arcPoints(from, to, steps = 64) {
  const a = toVector(from.lat, from.lon, 1).normalize();
  const b = toVector(to.lat, to.lon, 1).normalize();
  const angle = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
  const lift = Math.min(0.32, 0.03 + angle * 0.34);
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const sin = Math.sin(angle);
    const p = sin < 1e-6
      ? a.clone().lerp(b, t).normalize()
      : a.clone().multiplyScalar(Math.sin((1 - t) * angle) / sin)
         .add(b.clone().multiplyScalar(Math.sin(t * angle) / sin))
         .normalize();
    out.push(p.multiplyScalar(RADIUS + Math.sin(Math.PI * t) * lift));
  }
  return out;
}

/** Country outlines as line loops on the sphere. */
function useCountryLines() {
  return useMemo(() => {
    const land = feature(countries110m, countries110m.objects.countries);
    const lines = [];
    for (const f of land.features) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        for (const ring of poly) {
          if (ring.length < 3) continue;
          // Thin dense rings; 110m data is already coarse but coastlines vary.
          const step = ring.length > 220 ? 3 : ring.length > 90 ? 2 : 1;
          const pts = [];
          for (let i = 0; i < ring.length; i += step) {
            pts.push(toVector(ring[i][1], ring[i][0], RADIUS + 0.004));
          }
          if (pts.length > 2) lines.push(pts);
        }
      }
    }
    return lines;
  }, []);
}

function Journey({ journey, active, reduced }) {
  const rides = journey.legs.filter((l) => l.mode !== 'walk' && l.from.lat != null && l.to.lat != null);
  return (
    <group>
      {rides.map((leg, i) => {
        const pts = arcPoints(leg.from, leg.to);
        const colour = MODE_COLOUR[leg.mode] ?? MODE_COLOUR.rail;
        return (
          <group key={i}>
            {active && (
              <Line points={pts} color={colour} lineWidth={5} transparent opacity={0.16} />
            )}
            <Line
              points={pts}
              color={colour}
              lineWidth={active ? (leg.mode === 'night_rail' ? 2.6 : 1.8) : 0.7}
              transparent
              opacity={active ? 0.95 : 0.16}
            />
          </group>
        );
      })}
      {active && rides.map((leg, i) => (
        <Stop key={`s${i}`} lat={leg.from.lat} lon={leg.from.lon} first={i === 0} />
      ))}
      {active && rides.length > 0 && (
        <Stop
          lat={rides[rides.length - 1].to.lat}
          lon={rides[rides.length - 1].to.lon}
          first
        />
      )}
    </group>
  );
}

function Stop({ lat, lon, first }) {
  const p = useMemo(() => toVector(lat, lon, RADIUS + 0.012), [lat, lon]);
  return (
    <mesh position={p}>
      <sphereGeometry args={[first ? 0.013 : 0.008, 12, 12]} />
      <meshBasicMaterial color={first ? '#e6ecf4' : '#93a3b8'} toneMapped={false} />
    </mesh>
  );
}

function Scene({ journeys, activeIndex, reduced }) {
  const lines = useCountryLines();
  const group = useRef();
  const { camera } = useThree();

  // Aim the globe at the journey, and pull the camera in far enough that the
  // journey fills the frame. A Berlin–Munich hop drawn on a whole-Earth view is
  // a two-pixel scratch over the Sahara; the map has to answer "where is this".
  const target = useMemo(() => {
    const j = journeys[activeIndex] ?? journeys[0];
    const rides = j?.legs.filter((l) => l.from.lat != null && l.to.lat != null) ?? [];
    if (!rides.length) return { lat: 50, lon: 10, distance: 7 };
    const last = rides[rides.length - 1];
    const a = rides[0].from, b = last.to;

    // Frame the journey: sit far enough back that both ends are comfortably
    // inside the view, and never so close that the globe fills the frame.
    // The visible arc spans `sep` radians of a sphere of radius RADIUS, so its
    // chord is 2·R·sin(sep/2). With a 40° vertical FOV we need the chord to
    // occupy roughly half the frame height, plus clearance for the horizon.
    const va = toVector(a.lat, a.lon, 1).normalize();
    const vb = toVector(b.lat, b.lon, 1).normalize();
    const sep = Math.acos(THREE.MathUtils.clamp(va.dot(vb), -1, 1)); // radians
    const chord = 2 * RADIUS * Math.sin(sep / 2);
    const halfFov = THREE.MathUtils.degToRad(40) / 2;
    // Distance from the globe's centre: the surface is RADIUS away, and we want
    // the chord to fill ~55% of the frame.
    const needed = RADIUS + (chord / 0.55) / (2 * Math.tan(halfFov));
    const distance = THREE.MathUtils.clamp(needed, 4.2, 9);

    return {
      lat: (a.lat + b.lat) / 2,
      lon: (a.lon + b.lon) / 2,
      distance,
    };
  }, [journeys, activeIndex]);

  useFrame((_, dt) => {
    if (!group.current) return;
    // Rotate the target latitude fully to the camera's eye line. Damping this
    // (the old 0.55 factor) leaves a northern-European journey sitting in the
    // top third of the frame with the Sahara taking the rest.
    const wantY = THREE.MathUtils.degToRad(-target.lon);
    const wantX = THREE.MathUtils.degToRad(target.lat);
    const ease = reduced ? 1 : 1 - Math.exp(-dt * 2.6);
    let dy = wantY - group.current.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    group.current.rotation.y += dy * ease;
    group.current.rotation.x += (wantX - group.current.rotation.x) * ease;

    // Ease the camera to the framing distance, but never fight the user:
    // OrbitControls owns the radius once they touch it.
    const cur = camera.position.length();
    if (Math.abs(cur - target.distance) > 0.02) {
      const next = cur + (target.distance - cur) * (reduced ? 1 : ease);
      camera.position.setLength(next);
    }
  });

  return (
    <>
      <color attach="background" args={['#0a1120']} />
      <ambientLight intensity={1} />

      <group ref={group}>
        {/* The ocean sphere, slightly inside the coastlines. */}
        <mesh>
          <sphereGeometry args={[RADIUS, 64, 48]} />
          <meshBasicMaterial color="#0d1729" />
        </mesh>
        {/* A faint limb so the sphere reads as a globe, not a disc. */}
        <mesh scale={1.02}>
          <sphereGeometry args={[RADIUS, 48, 32]} />
          <meshBasicMaterial color="#2a3d5c" transparent opacity={0.13}
                             side={THREE.BackSide} blending={THREE.AdditiveBlending} />
        </mesh>

        {lines.map((pts, i) => (
          <Line key={i} points={pts} color="#43608c" lineWidth={1} transparent opacity={0.95} />
        ))}

        {journeys.map((j, i) => (
          <Journey key={i} journey={j} active={i === activeIndex} reduced={reduced} />
        ))}
      </group>

      <OrbitControls
        enablePan={false}
        enableDamping={!reduced}
        dampingFactor={0.06}
        minDistance={3.6}
        maxDistance={9}
        rotateSpeed={0.45}
      />
    </>
  );
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export default function Globe({ journeys = [], activeIndex = 0, reduced = false }) {
  const [ok, setOk] = useState(() => (typeof window === 'undefined' ? true : hasWebGL()));

  if (!ok) {
    return (
      <div className="globe globe--fallback">
        <p>The map needs WebGL, which this browser has turned off. Every journey below still works.</p>
      </div>
    );
  }

  return (
    <div className="globe">
      <Canvas
        dpr={[1, 1.6]}
        camera={{ position: [0, 0, 6.2], fov: 40 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault(); setOk(false);
          }, { once: true });
        }}
      >
        <Scene journeys={journeys} activeIndex={activeIndex} reduced={reduced} />
      </Canvas>
    </div>
  );
}
