// Generates src/data/airports.json from OurAirports (public domain / Unlicense).
// Source: https://ourairports.com/data/  — updated nightly.
// Run: node scripts/build-airports.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const SRC = 'https://davidmegginson.github.io/ourairports-data/airports.csv';

function parseCSVLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const res = await fetch(SRC);
if (!res.ok) throw new Error(`OurAirports fetch failed: ${res.status}`);
const text = await res.text();
const lines = text.split('\n');
const header = parseCSVLine(lines[0]).map((h) => h.replace(/^"|"$/g, ''));
const col = Object.fromEntries(header.map((h, i) => [h, i]));

const airports = [];
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue;
  const f = parseCSVLine(lines[i]);
  const iata = (f[col.iata_code] || '').trim();
  const type = (f[col.type] || '').trim();
  // Only real, commercially-served airports. `closed` rows and unserved
  // strips would otherwise show up as bookable destinations.
  if (iata.length !== 3) continue;
  if ((f[col.scheduled_service] || '').trim() !== 'yes') continue;
  if (type === 'closed') continue;
  airports.push({
    iata,
    icao: (f[col.icao_code] || '').trim() || null,
    name: (f[col.name] || '').trim(),
    city: (f[col.municipality] || '').trim() || null,
    country: (f[col.iso_country] || '').trim(),
    type,
    lat: Number(f[col.latitude_deg]),
    lon: Number(f[col.longitude_deg]),
  });
}

airports.sort((a, b) => a.iata.localeCompare(b.iata));
mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/airports.json', JSON.stringify(airports));

const countries = new Set(airports.map((a) => a.country));
console.log(`airports: ${airports.length}  countries: ${countries.size}`);
console.log(`bytes: ${JSON.stringify(airports).length}`);
