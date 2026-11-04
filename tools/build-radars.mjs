// Builds the radar site list (every NEXRAD WSR-88D and TDWR) from the NWS API.
// The app loads this file at start so the site buttons show straight away, then
// asks the same API for each radar's live status.
// Source: https://api.weather.gov/radar/stations (public domain).
// Usage: node tools/build-radars.mjs
//
// Output: public/data/radars.json, a list of
//   [id, name, type ('WSR-88D' | 'TDWR'), lat, lon, elevation m, region]
// sorted by id. The region (US state or country) comes from the nearest town in
// public/data/geo/places/major.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const res = await fetch('https://api.weather.gov/radar/stations?stationType=WSR-88D,TDWR', {
  headers: { 'User-Agent': 'model-globe build-radars', Accept: 'application/geo+json' },
});
if (!res.ok) throw new Error(`NWS API: HTTP ${res.status}`);
const { features } = await res.json();

const { countries, places } = JSON.parse(fs.readFileSync(path.join(root, 'public/data/geo/places/major.json'), 'utf8'));
const D2R = Math.PI / 180;
function regionNear(lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const p of places) {
    const dLat = p[1] - lat;
    const dLon = (p[2] - lon) * Math.cos(lat * D2R);
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best[5] === 'US' ? best[6] : countries[best[5]] ?? best[5];
}

const sites = features
  .map(({ geometry, properties: p }) => {
    const [lon, lat] = geometry.coordinates;
    return [p.id, p.name, p.stationType, +lat.toFixed(4), +lon.toFixed(4), Math.round(p.elevation?.value ?? 0), regionNear(lat, lon)];
  })
  .sort((a, b) => a[0].localeCompare(b[0]));

const file = path.join(root, 'public/data/radars.json');
fs.writeFileSync(file, '[\n' + sites.map((s) => JSON.stringify(s)).join(',\n') + '\n]\n');
console.log(`${sites.length} radars → ${path.relative(root, file)}`);
