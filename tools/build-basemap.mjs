// Bakes the globe's static base map so the viewer doesn't download it per run:
//   land.bin.gz    8192x4096 uint8 land coverage (anti-aliased), rasterized from
//                  Natural Earth 10m land minus 10m lakes. Cell-centred, row 0 = 90°N,
//                  column 0 = 180°W.
//   relief.bin.gz  1440x721 uint8 pairs [hillshade, elevation] from ECMWF IFS
//                  orography (surface geopotential), grid matching the model.
// Usage: node tools/build-basemap.mjs <natural-earth-geojson-dir> <ifs-orography.grib2>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeGrib2 } from '../public/js/decode/grib2.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [neDir, oroFile] = process.argv.slice(2);
if (!neDir || !oroFile) {
  console.error('usage: node tools/build-basemap.mjs <natural-earth-geojson-dir> <ifs-orography.grib2>');
  process.exit(1);
}
const out = path.join(root, 'public', 'data', 'base');
fs.mkdirSync(out, { recursive: true });

// ------------------------------------------------------------------ land mask
const W = 8192;
const H = 4096;
const SUB = 4; // sub-scanlines per pixel row (vertical anti-aliasing)

function rings(name) {
  const geo = JSON.parse(fs.readFileSync(path.join(neDir, name + '.geojson'), 'utf8'));
  const out = [];
  for (const f of geo.features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) out.push(...poly);
  }
  return out;
}

/** Even-odd coverage raster of a set of rings, values 0..1. */
function rasterize(ringList) {
  const rowsSub = H * SUB;
  const crossings = Array.from({ length: rowsSub }, () => []);
  for (const ring of ringList) {
    for (let i = 0; i < ring.length - 1; i++) {
      const x0 = ((ring[i][0] + 180) / 360) * W;
      const y0 = ((90 - ring[i][1]) / 180) * rowsSub;
      const x1 = ((ring[i + 1][0] + 180) / 360) * W;
      const y1 = ((90 - ring[i + 1][1]) / 180) * rowsSub;
      if (y0 === y1) continue;
      const ya = Math.min(y0, y1);
      const yb = Math.max(y0, y1);
      // sub-scanline k samples at y = k + 0.5
      for (let k = Math.max(0, Math.ceil(ya - 0.5)); k <= Math.min(rowsSub - 1, Math.floor(yb - 0.5)); k++) {
        const y = k + 0.5;
        if (y === yb) continue; // half-open edges avoid double-counting vertices
        crossings[k].push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
  }
  const cov = new Float32Array(W * H);
  const w = 1 / SUB;
  for (let k = 0; k < rowsSub; k++) {
    const xs = crossings[k].sort((a, b) => a - b);
    const row = Math.floor(k / SUB) * W;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, xs[i]);
      const xb = Math.min(W, xs[i + 1]);
      if (xb <= xa) continue;
      const ia = Math.floor(xa);
      const ib = Math.min(W - 1, Math.floor(xb));
      if (ia === ib) {
        cov[row + ia] += (xb - xa) * w;
        continue;
      }
      cov[row + ia] += (ia + 1 - xa) * w;
      for (let x = ia + 1; x < ib; x++) cov[row + x] += w;
      if (ib < W) cov[row + ib] += (xb - ib) * w;
    }
    crossings[k] = null;
  }
  return cov;
}

let t = Date.now();
const land = rasterize(rings('ne_10m_land'));
const lakes = rasterize(rings('ne_10m_lakes'));
const mask = new Uint8Array(W * H);
for (let i = 0; i < mask.length; i++) {
  mask[i] = Math.round(Math.min(1, Math.max(0, land[i] * (1 - Math.min(1, lakes[i])))) * 255);
}
fs.writeFileSync(path.join(out, 'land.bin.gz'), zlib.gzipSync(mask, { level: 9 }));
console.log(`land.bin.gz ${W}x${H} in ${Date.now() - t} ms`);

// ------------------------------------------------------------------ relief
t = Date.now();
const [oro] = decodeGrib2(fs.readFileSync(oroFile));
const { ni, nj, lat0, dlat } = oro.meta;
const z = oro.values;
const g = 9.80665;
const m = 111195 * Math.abs(dlat);
const exaggeration = 14;
const L = [-0.55, 0.55, 0.63]; // light from the north-west
const ll = Math.hypot(...L);
const relief = new Uint8Array(ni * nj * 2);
for (let j = 0; j < nj; j++) {
  const lat = lat0 + j * dlat;
  const dx = Math.max(2000, m * Math.cos((lat * Math.PI) / 180));
  const jn = Math.max(0, j - 1);
  const js = Math.min(nj - 1, j + 1);
  for (let i = 0; i < ni; i++) {
    const k = j * ni + i;
    const ie = (i + 1) % ni;
    const iw = (i - 1 + ni) % ni;
    const dzdx = ((z[j * ni + ie] - z[j * ni + iw]) / g / (2 * dx)) * exaggeration;
    const dzdy = ((z[jn * ni + i] - z[js * ni + i]) / g / ((js - jn) * m)) * exaggeration;
    const nl = Math.hypot(dzdx, dzdy, 1);
    const shade = (-dzdx * L[0] - dzdy * L[1] + L[2]) / nl / ll;
    const hill = Math.min(1, Math.max(0, 0.5 + (shade - L[2] / ll) * 1.4));
    relief[k * 2] = Math.round(hill * 255);
    relief[k * 2 + 1] = Math.round(Math.min(1, Math.max(0, z[k] / g / 4500)) * 255);
  }
}
fs.writeFileSync(path.join(out, 'relief.bin.gz'), zlib.gzipSync(relief, { level: 9 }));
fs.writeFileSync(
  path.join(out, 'base.json'),
  JSON.stringify(
    {
      land: { width: W, height: H, source: 'Natural Earth 10m land minus 10m lakes' },
      relief: { ...oro.meta, refTime: undefined, source: 'ECMWF IFS orography' },
    },
    null,
    2,
  ),
);
console.log(`relief.bin.gz ${ni}x${nj} in ${Date.now() - t} ms`);
