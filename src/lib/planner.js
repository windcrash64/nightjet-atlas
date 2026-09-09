import cityData from '../data/cities.json' with { type: 'json' };
import airportData from '../data/airports.json' with { type: 'json' };

// These are place names and airport coordinates, never evidence of a service.
const NAME_GROUPS = [
  ['Istanbul', 'İstanbul', 'ıstanbul', 'Constantinople'],
  ['Vienna', 'Wien'], ['Munich', 'München', 'Muenchen'],
  ['Cologne', 'Köln', 'Koeln'], ['Nuremberg', 'Nürnberg', 'Nuernberg'],
  ['Hanover', 'Hannover'], ['Prague', 'Praha'], ['Warsaw', 'Warszawa'],
  ['Florence', 'Firenze'], ['Venice', 'Venezia'], ['Milan', 'Milano'],
  ['Rome', 'Roma'], ['Naples', 'Napoli'], ['Turin', 'Torino'],
  ['Geneva', 'Genève'], ['Zurich', 'Zürich', 'Zuerich'],
  ['Lucerne', 'Luzern'], ['Seville', 'Sevilla'], ['Saragossa', 'Zaragoza'],
  ['Lisbon', 'Lisboa'], ['Copenhagen', 'København', 'Koebenhavn', 'Kobenhavn'],
  ['Gothenburg', 'Göteborg', 'Goeteborg'], ['Brussels', 'Bruxelles', 'Brussel'],
  ['Antwerp', 'Antwerpen'], ['The Hague', 'Den Haag'],
  ['Bucharest', 'Bucureşti', 'București'], ['Belgrade', 'Beograd'],
  ['Athens', 'Athína', 'Athina'], ['Mexico City', 'Ciudad de México'],
  ['Tokyo', 'Tōkyō'], ['Osaka', 'Ōsaka'], ['Montreal', 'Montréal'],
  ['Krakow', 'Kraków'], ['Wroclaw', 'Wrocław'], ['Poznan', 'Poznań'],
  ['Malaga', 'Málaga'], ['Cordoba', 'Córdoba'], ['Dusseldorf', 'Düsseldorf', 'Duesseldorf'],
  ['Sao Paulo', 'São Paulo'], ['Kyiv', 'Kiev'],
];

function normalize(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/ı/g, 'i').replace(/ø/g, 'o').replace(/ł/g, 'l')
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const aliases = new Map(NAME_GROUPS.flatMap(group => group.map(name => [normalize(name), group])));
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
function countryName(code) {
  try { return regionNames.of(code) || code; } catch { return code || ''; }
}

function validCoordinate(value, max) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max;
}

/** Great-circle distance in kilometres; this is not a road or transfer distance. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  if (!validCoordinate(lat1, 90) || !validCoordinate(lat2, 90)
    || !validCoordinate(lon1, 180) || !validCoordinate(lon2, 180)) return null;
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

const airports = airportData.map(airport => ({
  ...airport,
  id: `airport:${airport.iata}`,
  kind: 'airport',
  countryName: countryName(airport.country),
}));
const airportByCode = new Map(airports.map(airport => [airport.iata, airport]));

/** All airport types are considered; distance alone does not imply a viable flight. */
export function nearestAirports(place, count = 3) {
  if (!place || !validCoordinate(place.lat, 90) || !validCoordinate(place.lon, 180)) return [];
  if (!Number.isFinite(count) || count <= 0) return [];
  return airports.map(airport => ({
    ...airport,
    distanceKm: haversineKm(place.lat, place.lon, airport.lat, airport.lon),
  })).filter(airport => airport.distanceKm !== null)
    .sort((a, b) => a.distanceKm - b.distanceKm || a.iata.localeCompare(b.iata))
    .slice(0, Math.floor(count));
}

// Explicit defaults make a city handoff reproducible. They do not select the
// cheapest airport. The UI should expose nearby alternatives before searching.
const PRIMARY_AIRPORTS = new Map(Object.entries({
  Istanbul: 'IST', Vienna: 'VIE', London: 'LHR', Paris: 'CDG',
  Milan: 'MXP', Rome: 'FCO', Tokyo: 'HND', Osaka: 'KIX',
  'New York': 'JFK', Berlin: 'BER', Munich: 'MUC', Frankfurt: 'FRA',
  Brussels: 'BRU', Stockholm: 'ARN', Oslo: 'OSL', Moscow: 'SVO',
  Beijing: 'PEK', Shanghai: 'PVG', Seoul: 'ICN', Toronto: 'YYZ',
}));

/** Static city suggestions. Their historic service scores are not live coverage. */
export const places = cityData.cities.map(city => {
  const group = aliases.get(normalize(city.name)) || [city.name];
  const name = group[0];
  const nearby = nearestAirports(city, 12).filter(a => a.country === city.country && a.distanceKm <= 120);
  const primary = airportByCode.get(PRIMARY_AIRPORTS.get(name))
    || nearby.find(a => a.type === 'large_airport') || nearby[0];
  return {
    ...city,
    id: `city:${city.country}:${normalize(name).replace(/ /g, '-')}`,
    kind: 'city', name, localName: city.name,
    countryName: countryName(city.country),
    iata: primary?.iata ?? null,
    airports: [...new Set([primary?.iata, ...nearby.slice(0, 3).map(a => a.iata)].filter(Boolean))],
    aliases: [...new Set([...group, city.name])],
  };
});

const searchable = [...places, ...airports].map(place => ({
  place,
  names: [...(place.aliases || [place.name]), place.city].filter(Boolean).map(normalize),
  text: normalize([place.name, place.localName, place.city, place.country, place.countryName,
    place.country === 'TR' ? 'Turkey Turkiye Türkiye' : '',
    ...(place.aliases || [])].filter(Boolean).join(' ')),
}));

/** Cities lead name matches; an exact IATA code returns the airport first. */
export function searchPlaces(query, limit = 8) {
  const q = normalize(query);
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 8;
  if (!q || !size) return [];
  return searchable.map(entry => {
    const { place, names, text } = entry;
    let score = Infinity;
    if (place.kind === 'airport' && normalize(place.iata) === q) score = 0;
    else if (names.includes(q)) score = place.kind === 'city' ? 1 : 3;
    else if (names.some(name => name.startsWith(q))) score = place.kind === 'city' ? 2 : 4;
    else if (place.kind === 'city' && place.airports.some(code => normalize(code) === q)) score = 5;
    else if (q.split(' ').every(word => text.includes(word))) score = place.kind === 'city' ? 6 : 7;
    return { place, score };
  }).filter(entry => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.place.name.localeCompare(b.place.name, 'en'))
    .slice(0, size).map(entry => entry.place);
}

function resolvePlace(place) {
  if (typeof place !== 'string') return place;
  const q = normalize(place);
  return airportByCode.get(place.toUpperCase())
    || places.find(item => item.aliases.some(alias => normalize(alias) === q))
    || { name: place };
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

const RAIL_OPERATORS = [
  { id: 'obb', name: 'ÖBB', countries: ['AT'], url: 'https://www.oebb.at/en/' },
  { id: 'db', name: 'Deutsche Bahn', countries: ['DE'], url: 'https://int.bahn.de/en' },
  { id: 'sbb', name: 'SBB', countries: ['CH'], url: 'https://www.sbb.ch/en' },
  { id: 'sncf', name: 'SNCF Connect', countries: ['FR'], url: 'https://www.sncf-connect.com/en-en/' },
  { id: 'renfe', name: 'Renfe', countries: ['ES'], url: 'https://www.renfe.com/es/en' },
  { id: 'ns', name: 'NS International', countries: ['NL'], url: 'https://www.nsinternational.com/en' },
  { id: 'trenitalia', name: 'Trenitalia', countries: ['IT'], url: 'https://www.trenitalia.com/en.html' },
  { id: 'eurostar', name: 'Eurostar', countries: ['GB', 'BE'], url: 'https://www.eurostar.com/' },
  { id: 'cd', name: 'České dráhy', countries: ['CZ'], url: 'https://www.cd.cz/en/' },
  { id: 'pkp', name: 'PKP Intercity', countries: ['PL'], url: 'https://www.intercity.pl/en/' },
  { id: 'tcdd', name: 'TCDD Taşımacılık', countries: ['TR'], url: 'https://www.tcddtasimacilik.gov.tr/' },
];

/** Search handoffs only: none of these links is a fare quote or availability claim. */
export function providerLinks(from, to, date, options = {}) {
  const origin = resolvePlace(from);
  const destination = resolvePlace(to);
  const links = [];
  const hasDate = validDate(date);
  const adultInput = options?.adults === undefined ? 1 : options.adults;
  const adults = Number(adultInput);
  const hasAdults = (typeof adultInput === 'number' || typeof adultInput === 'string')
    && Number.isInteger(adults) && adults >= 1 && adults <= 8;
  const originCode = String(origin?.iata || '').toUpperCase();
  const destinationCode = String(destination?.iata || '').toUpperCase();
  const hasPair = /^[A-Z]{3}$/.test(originCode) && /^[A-Z]{3}$/.test(destinationCode)
    && originCode !== destinationCode;
  if (hasPair && hasDate && hasAdults) {
    const shortDate = date.slice(2).replace(/-/g, '');
    const url = new URL(`https://www.skyscanner.net/transport/flights/${originCode.toLowerCase()}/${destinationCode.toLowerCase()}/${shortDate}/`);
    url.searchParams.set('adultsv2', String(adults));
    url.searchParams.set('cabinclass', 'economy');
    url.searchParams.set('rtn', '0');
    url.searchParams.set('currency', 'EUR');
    links.push({ id: 'skyscanner', name: 'Skyscanner', label: 'Search Skyscanner', mode: 'plane',
      url: url.href, prefilled: true,
      note: `${originCode} → ${destinationCode} · ${date} · ${adults} adult${adults === 1 ? '' : 's'}, one way. Verify details and the final fare on Skyscanner.` });
  } else {
    links.push({ id: 'skyscanner', name: 'Skyscanner', label: 'Open Skyscanner', mode: 'plane',
      url: 'https://www.skyscanner.net/', prefilled: false,
      note: 'Enter airports, travel date and passengers on Skyscanner.' });
  }
  const google = new URL('https://www.google.com/travel/flights');
  if (origin?.name && destination?.name) {
    google.searchParams.set('q', `One way flights from ${originCode || origin.name} to ${destinationCode || destination.name}${hasDate ? ` on ${date}` : ''}${hasAdults ? ` for ${adults} adult${adults === 1 ? '' : 's'}` : ''}`);
  }
  links.push({ id: 'google-flights', name: 'Google Flights', label: 'Search Google Flights', mode: 'plane',
    url: google.href, prefilled: false,
    note: 'Search details are passed as text. Confirm airports, date and passengers on Google Flights.' });

  const countries = new Set([origin?.country, destination?.country]);
  const operators = RAIL_OPERATORS.filter(operator => operator.countries.some(country => countries.has(country)));
  for (const operator of operators.length ? operators : RAIL_OPERATORS.filter(operator => operator.id === 'db')) {
    links.push({ id: operator.id, name: operator.name, label: `Open ${operator.name}`, mode: 'train',
      url: operator.url, prefilled: false,
      note: 'Official operator site. Enter your route and date to check service and fares.' });
  }
  links.push({ id: 'flixbus', name: 'FlixBus', label: 'Open FlixBus', mode: 'bus',
    url: 'https://global.flixbus.com/', prefilled: false,
    note: 'Enter your route and date on FlixBus to check whether service is available.' });
  // Maps URLs support route coordinates and transit mode, but do not carry
  // our selected departure date/time or guarantee a metro-only itinerary.
  const transit = new URL('https://www.google.com/maps/dir/');
  transit.searchParams.set('api', '1');
  transit.searchParams.set('travelmode', 'transit');
  const hasCoordinates = [origin, destination].every(place => place
    && validCoordinate(place.lat, 90) && validCoordinate(place.lon, 180));
  if (hasCoordinates) {
    transit.searchParams.set('origin', `${origin.lat},${origin.lon}`);
    transit.searchParams.set('destination', `${destination.lat},${destination.lon}`);
  }
  links.push({ id: 'google-transit', name: 'Google Maps', label: 'Open Google Maps transit', mode: 'metro',
    url: transit.href, prefilled: false,
    note: `${hasCoordinates ? 'Route coordinates are included.' : 'Enter your route in Google Maps.'} Choose the date and time in Google Maps. Transit may include buses, trains or metro; check availability and fares there.` });
  return links;
}

export function formatDuration(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return '—';
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ''}` : `${remainder}m`;
}

function moneyValue(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** All four EUR amounts must be known; callers explicitly enter zero for included costs. */
export function budgetTotal({ fare, baggage, originTransfer, destinationTransfer } = {}) {
  const amounts = [fare, baggage, originTransfer, destinationTransfer].map(moneyValue);
  if (amounts.some(amount => amount === null)) return null;
  const total = amounts.reduce((sum, amount) => sum + Math.round(amount * 100), 0);
  return Number.isSafeInteger(total) ? total / 100 : null;
}

function journeyDuration(journey) {
  const duration = journey.durationMinutes ?? journey.durationMin;
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : Infinity;
}

function euroPrice(journey) {
  const price = journey.price;
  const object = price && typeof price === 'object';
  const amount = object ? price.amount : price;
  const currency = object ? price.currency : journey.currency;
  if (object && (price.kind === 'unknown' || price.includesAllLegs === false)) return Infinity;
  return currency === 'EUR' && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
    ? amount : Infinity;
}

/** Unknown durations/fares stay last, and the caller's array is never mutated. */
export function rankJourneys(journeys, sort = 'fastest') {
  if (!Array.isArray(journeys)) return [];
  if (sort !== 'fastest' && sort !== 'cheapest') return [...journeys];
  const metric = sort === 'cheapest' ? euroPrice : journeyDuration;
  return journeys.map((journey, index) => ({ journey, index, value: metric(journey) }))
    .sort((a, b) => a.value === b.value ? a.index - b.index : a.value - b.value)
    .map(entry => entry.journey);
}
