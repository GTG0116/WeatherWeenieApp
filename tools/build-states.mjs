// Builds the zoomed-in state/province lines: US state lines from the Census
// Bureau's 1:500k cartographic boundaries (the same source as the counties, so
// the two line up), and Natural Earth 10m admin-1 lines everywhere else.
// Sources:
//   https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_500k.zip
//   https://github.com/nvkelso/natural-earth-vector (geojson/ne_10m_admin_1_states_provinces_lines.geojson)
// Usage: node tools/build-states.mjs <cb_..._state_500k.shp> <ne_10m_admin_1_states_provinces_lines.geojson>
// Output (same line format as tools/build-geo.mjs): public/data/geo/states-hi.bin
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [shpFile, neFile] = process.argv.slice(2);
if (!shpFile || !neFile) {
  console.error('usage: node tools/build-states.mjs <cb_..._state_500k.shp> <ne_10m_admin_1_states_provinces_lines.geojson>');
  process.exit(1);
}

// ---- minimal ESRI shapefile reader (polygon records only)
const buf = fs.readFileSync(shpFile);
const rings = [];
let off = 100;
while (off + 8 <= buf.length) {
  const contentBytes = buf.readInt32BE(off + 4) * 2;
  const rec = off + 8;
  if (buf.readInt32LE(rec) === 5) {
    const numParts = buf.readInt32LE(rec + 36);
    const numPoints = buf.readInt32LE(rec + 40);
    const partsAt = rec + 44;
    const pointsAt = partsAt + numParts * 4;
    for (let p = 0; p < numParts; p++) {
      const start = buf.readInt32LE(partsAt + p * 4);
      const end = p + 1 < numParts ? buf.readInt32LE(partsAt + (p + 1) * 4) : numPoints;
      const ring = [];
      for (let i = start; i < end; i++) ring.push([buf.readDoubleLE(pointsAt + i * 16), buf.readDoubleLE(pointsAt + i * 16 + 8)]);
      rings.push(ring);
    }
  }
  off = rec + contentBytes;
}

// ---- state lines are the edges two states share (coasts and the Canada and
// Mexico borders belong to one state only and are drawn by other layers)
const key = ([x, y]) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
const edgeKey = (a, b) => {
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? ka + '|' + kb : kb + '|' + ka;
};
const uses = new Map();
for (const ring of rings) {
  for (let i = 0; i + 1 < ring.length; i++) {
    const k = edgeKey(ring[i], ring[i + 1]);
    uses.set(k, (uses.get(k) ?? 0) + 1);
  }
}
const lines = [];
const done = new Set();
for (const ring of rings) {
  let cur = null;
  for (let i = 0; i + 1 < ring.length; i++) {
    const k = edgeKey(ring[i], ring[i + 1]);
    if (uses.get(k) < 2 || done.has(k)) {
      cur = null;
      continue;
    }
    done.add(k);
    if (!cur) {
      cur = [ring[i]];
      lines.push(cur);
    }
    cur.push(ring[i + 1]);
  }
}
const usLines = lines.length;

// ---- Natural Earth admin-1 lines outside the US
const ne = JSON.parse(fs.readFileSync(neFile, 'utf8'));
for (const f of ne.features) {
  if (f.properties.ADM0_A3 === 'USA' || !f.geometry) continue;
  const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
  for (const l of parts) if (l.length >= 2) lines.push(l);
}

const points = lines.reduce((n, l) => n + l.length, 0);
const out = Buffer.alloc(4 + lines.length * 4 + points * 8);
out.writeUInt32LE(lines.length, 0);
lines.forEach((l, i) => out.writeUInt32LE(l.length, 4 + i * 4));
let o = 4 + lines.length * 4;
for (const line of lines) {
  for (const [lon, lat] of line) {
    out.writeFloatLE(lon, o);
    out.writeFloatLE(lat, o + 4);
    o += 8;
  }
}
fs.writeFileSync(path.join(root, 'public', 'data', 'geo', 'states-hi.bin'), out);
console.log(`states-hi.bin: ${usLines} US lines (1:500k) + ${lines.length - usLines} Natural Earth lines, ${points} points`);
