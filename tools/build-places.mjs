// Builds the town labels from GeoNames' cities500 dump (every populated place
// with 500+ people, ~230k worldwide).
// Source: https://download.geonames.org/export/dump/ (cities500.zip,
// admin1CodesASCII.txt, countryInfo.txt), CC BY 4.0.
// Usage: node tools/build-places.mjs <dir-with-geonames-files>
//
// Output in public/data/geo/places/:
//   major.json      places with 15k+ people, capitals and admin-1 seats (loaded at start)
//   t/<lat>_<lon>.json  everything else, in 5° tiles loaded as the map zooms in there
//   tiles.json      which tiles exist
// Places are [name, lat, lon, rank, population, country code, region]; tiles and
// major.json are sorted most important first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/build-places.mjs <geonames-dir>');
  process.exit(1);
}
const out = path.join(root, 'public', 'data', 'geo', 'places');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 't'), { recursive: true });

const TILE = 5;
const MAJOR_POP = 15000;
// Neighbourhoods, and historical, abandoned or destroyed places.
const SKIP = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']);

const lines = (file) => fs.readFileSync(path.join(src, file), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
const countries = {};
for (const l of lines('countryInfo.txt')) {
  const f = l.split('\t');
  countries[f[0]] = f[4];
}
const regions = new Map();
for (const l of lines('admin1CodesASCII.txt')) {
  const f = l.split('\t');
  regions.set(f[0], f[1]);
}

// Lower rank = more important (shown from further out), as Natural Earth's scalerank.
const POP_RANKS = [5e6, 2e6, 1e6, 5e5, 2.5e5, 1e5, 5e4, 2e4, 1e4, 5e3, 2e3, 1e3];
function rankOf(pop, code) {
  let r = POP_RANKS.findIndex((p) => pop >= p);
  if (r < 0) r = POP_RANKS.length;
  r += 1;
  if (code === 'PPLC') r -= 2;
  else if (code === 'PPLA') r -= 1;
  return Math.max(0, r);
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const places = [];
for (const l of lines('places/cities500.txt')) {
  const f = l.split('\t');
  const code = f[7];
  if (f[6] !== 'P' || SKIP.has(code)) continue;
  const lat = Number(f[4]);
  const lon = Number(f[5]);
  const pop = Number(f[14]) || 0;
  if (!f[1] || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  places.push({ p: [f[1], r3(lat), r3(lon), rankOf(pop, code), pop, f[8], regions.get(`${f[8]}.${f[10]}`) ?? ''], code });
}
const order = (a, b) => a.p[3] - b.p[3] || b.p[4] - a.p[4];
places.sort(order);

const major = places.filter((x) => x.p[4] >= MAJOR_POP || x.code === 'PPLC' || x.code === 'PPLA');
const minor = places.filter((x) => !(x.p[4] >= MAJOR_POP || x.code === 'PPLC' || x.code === 'PPLA'));
const used = new Set(places.map((x) => x.p[5]));
const countryNames = Object.fromEntries(Object.entries(countries).filter(([cc]) => used.has(cc)));
fs.writeFileSync(path.join(out, 'major.json'), JSON.stringify({ countries: countryNames, places: major.map((x) => x.p) }));

const tiles = new Map();
for (const x of minor) {
  const key = `${Math.floor(x.p[1] / TILE) * TILE}_${Math.floor(x.p[2] / TILE) * TILE}`;
  if (!tiles.has(key)) tiles.set(key, []);
  tiles.get(key).push(x.p);
}
for (const [key, list] of tiles) fs.writeFileSync(path.join(out, 't', `${key}.json`), JSON.stringify(list));
fs.writeFileSync(path.join(out, 'tiles.json'), JSON.stringify({ size: TILE, tiles: [...tiles.keys()].sort() }));
console.log(`major.json ${major.length} places; ${tiles.size} tiles with ${minor.length} more`);
