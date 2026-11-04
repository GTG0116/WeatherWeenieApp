// Builds US county boundary lines from the Census Bureau's 1:500k cartographic
// boundary shapefile. Shared edges between neighbouring counties are emitted
// once. Output uses the same line format as tools/build-geo.mjs.
// Source: https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip
// Usage: node tools/build-counties.mjs <path-to-cb_2023_us_county_500k.shp>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shpFile = process.argv[2];
if (!shpFile) {
  console.error('usage: node tools/build-counties.mjs <cb_..._county_500k.shp>');
  process.exit(1);
}

// ---- minimal ESRI shapefile reader (polygon records only)
const buf = fs.readFileSync(shpFile);
const rings = [];
let off = 100;
while (off + 8 <= buf.length) {
  const contentBytes = buf.readInt32BE(off + 4) * 2;
  const rec = off + 8;
  const type = buf.readInt32LE(rec);
  if (type === 5) {
    const numParts = buf.readInt32LE(rec + 36);
    const numPoints = buf.readInt32LE(rec + 40);
    const partsAt = rec + 44;
    const pointsAt = partsAt + numParts * 4;
    for (let p = 0; p < numParts; p++) {
      const start = buf.readInt32LE(partsAt + p * 4);
      const end = p + 1 < numParts ? buf.readInt32LE(partsAt + (p + 1) * 4) : numPoints;
      const ring = [];
      for (let i = start; i < end; i++) {
        ring.push([buf.readDoubleLE(pointsAt + i * 16), buf.readDoubleLE(pointsAt + i * 16 + 8)]);
      }
      rings.push(ring);
    }
  }
  off = rec + contentBytes;
}

// ---- drop duplicate shared edges, then re-chain into polylines
const key = ([x, y]) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
const edgeKey = (a, b) => {
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? ka + '|' + kb : kb + '|' + ka;
};
const seen = new Set();
const lines = [];
let points = 0;
for (const ring of rings) {
  let cur = null;
  for (let i = 0; i + 1 < ring.length; i++) {
    const k = edgeKey(ring[i], ring[i + 1]);
    if (seen.has(k)) {
      cur = null;
      continue;
    }
    seen.add(k);
    if (!cur) {
      cur = [ring[i]];
      lines.push(cur);
    }
    cur.push(ring[i + 1]);
  }
}
for (const l of lines) points += l.length;

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
const file = path.join(root, 'public', 'data', 'geo', 'counties-500k.bin');
fs.writeFileSync(file, out);
console.log(`counties-500k.bin: ${rings.length} rings -> ${lines.length} lines, ${points} points`);
