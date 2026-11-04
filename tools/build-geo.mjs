// Converts Natural Earth GeoJSON into the compact files the viewer loads.
// Usage: node tools/build-geo.mjs <dir-with-natural-earth-geojson>
// Source data: https://github.com/nvkelso/natural-earth-vector (public domain)
//
// Towns are built by tools/build-places.mjs and zoomed-in state lines by
// tools/build-states.mjs.
//
// Line files (*.bin) are: uint32 lineCount, uint32 pointCount[lineCount],
// then float32 lon,lat pairs for every point. 50m files draw the zoomed-out
// globe; 10m files (Natural Earth's highest resolution) load when zooming in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/build-geo.mjs <natural-earth-geojson-dir>');
  process.exit(1);
}
const out = path.join(root, 'public', 'data', 'geo');
fs.mkdirSync(out, { recursive: true });

const read = (name) => JSON.parse(fs.readFileSync(path.join(src, name + '.geojson'), 'utf8'));

function linesOf(geom) {
  if (!geom) return [];
  switch (geom.type) {
    case 'LineString': return [geom.coordinates];
    case 'MultiLineString': return geom.coordinates;
    case 'Polygon': return geom.coordinates;
    case 'MultiPolygon': return geom.coordinates.flat();
    default: return [];
  }
}

function writeLines(file, features, filter = () => true) {
  const lines = [];
  for (const f of features) {
    if (!filter(f.properties || {})) continue;
    for (const line of linesOf(f.geometry)) if (line.length >= 2) lines.push(line);
  }
  const points = lines.reduce((n, l) => n + l.length, 0);
  const buf = Buffer.alloc(4 + lines.length * 4 + points * 8);
  buf.writeUInt32LE(lines.length, 0);
  lines.forEach((l, i) => buf.writeUInt32LE(l.length, 4 + i * 4));
  let o = 4 + lines.length * 4;
  for (const line of lines) {
    for (const [lon, lat] of line) {
      buf.writeFloatLE(lon, o);
      buf.writeFloatLE(lat, o + 4);
      o += 8;
    }
  }
  fs.writeFileSync(path.join(out, file), buf);
  console.log(file.padEnd(18), String(lines.length).padStart(6), 'lines', String(points).padStart(8), 'points');
}

for (const res of ['50m', '10m']) {
  writeLines(`coastline-${res}.bin`, read(`ne_${res}_coastline`).features);
  writeLines(`borders-${res}.bin`, read(`ne_${res}_admin_0_boundary_lines_land`).features);
  if (res === '50m') writeLines(`states-${res}.bin`, read(`ne_${res}_admin_1_states_provinces_lines`).features);
  writeLines(`lakes-${res}.bin`, read(`ne_${res}_lakes`).features, (p) => (p.scalerank ?? 9) <= (res === '10m' ? 8 : 3));
}
