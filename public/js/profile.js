// Vertical profiles for soundings and cross sections. Every level's fields are
// read as windows (DataSource.fieldIn) around the area of interest, so nearby
// soundings, box soundings and cross sections reuse what's already loaded.
import { MODELS, modelFor } from './models.js';
import { PRIORITY, sampleField, splitRun } from './data.js';
import { buildProfile } from './thermo.js';

const LEVEL_PARAMS = ['t', 'gh', 'u', 'v', 'r'];
const SURFACE_PARAMS = ['sp', '2t', '2d', '10u', '10v'];
const TILE = 5; // windows snap to 5° tiles so they're shared between requests

/** A window box covering [south, north] × [west, east], snapped outward to tiles. */
export function windowBox(south, north, west, east) {
  const s = Math.max(-90, Math.floor(south / TILE) * TILE - 0.5);
  const n = Math.min(90, Math.max(Math.ceil(north / TILE) * TILE, s + TILE) + 0.5);
  const w = Math.floor(west / TILE) * TILE - 0.5;
  const e = Math.max(Math.ceil(east / TILE) * TILE, w + TILE) + 0.5;
  return { south: s, north: n, west: w, east: e };
}

/**
 * Load every level of a model's profile around a box.
 * @returns {Promise<{levels: number[], field: (param: string, level?: number) => object|null}>}
 */
export async function loadProfileGrid(data, model, run, step, box, onProgress = () => {}, priority = PRIORITY.interactive) {
  const levels = modelFor(model, splitRun(run)[1]).profile;
  const specs = [
    ...SURFACE_PARAMS.map((param) => ({ param })),
    ...levels.flatMap((level) => LEVEL_PARAMS.map((param) => ({ param, level }))),
  ];
  let done = 0;
  const results = await Promise.allSettled(
    specs.map((s) =>
      data.fieldIn(model, run, step, s, box, priority).finally(() => onProgress(++done, specs.length)),
    ),
  );
  const fields = new Map();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') fields.set(`${specs[i].param}/${specs[i].level ?? 'sfc'}`, r.value);
  });
  const missing = SURFACE_PARAMS.filter((p) => !fields.has(`${p}/sfc`));
  if (missing.length) {
    const err = results.find((r) => r.status === 'rejected')?.reason;
    throw new Error(`Couldn't load ${missing.join(', ')}${err ? `: ${err.message}` : ''}`);
  }
  return { levels, field: (param, level) => fields.get(`${param}/${level ?? 'sfc'}`) ?? null };
}

/**
 * Load the same box for another forecast hour in the background, so stepping
 * through hours with a panel open doesn't wait. Skipped for locally averaged
 * ensemble means, where a whole profile is hundreds of downloads.
 */
export function prefetchProfileGrid(data, model, run, step, box) {
  if (step == null || (MODELS[model].members?.mean === 'computed' && splitRun(run)[1] === 'mean')) return;
  loadProfileGrid(data, model, run, step, box, undefined, PRIORITY.background).catch(() => {});
}

const sample = (f, lat, lon) => (f ? sampleField(f.values, f.meta, lat, lon) : NaN);

/** Profile at a point (bilinear). */
export function pointProfile(grid, lat, lon) {
  const lv = { p: grid.levels, t: [], gh: [], u: [], v: [], rh: [] };
  for (const l of grid.levels) {
    lv.t.push(sample(grid.field('t', l), lat, lon));
    lv.gh.push(sample(grid.field('gh', l), lat, lon));
    lv.u.push(sample(grid.field('u', l), lat, lon));
    lv.v.push(sample(grid.field('v', l), lat, lon));
    lv.rh.push(sample(grid.field('r', l), lat, lon));
  }
  const s = (p) => sample(grid.field(p), lat, lon);
  const sfc = { sp: s('sp'), t2: s('2t'), d2: s('2d'), u10: s('10u'), v10: s('10v') };
  if (![sfc.sp, sfc.t2, sfc.d2].every(Number.isFinite)) return null;
  return buildProfile(lv, sfc);
}

const inLon = (lon, w, e) => {
  const x = ((((lon - w) % 360) + 360) % 360);
  return x <= e - w;
};

/** Mean profile over the grid points inside a box. */
export function boxProfile(grid, box) {
  const mean = (f) => {
    if (!f) return NaN;
    const { ni, nj, lat0, lon0, dlat, dlon } = f.meta;
    let sum = 0;
    let n = 0;
    for (let j = 0; j < nj; j++) {
      const lat = lat0 + j * dlat;
      if (lat < box.south || lat > box.north) continue;
      for (let i = 0; i < ni; i++) {
        if (!inLon(lon0 + i * dlon, box.west, box.east)) continue;
        const v = f.values[j * ni + i];
        if (Number.isFinite(v)) {
          sum += v;
          n++;
        }
      }
    }
    return n ? sum / n : NaN;
  };
  const lv = { p: grid.levels, t: [], gh: [], u: [], v: [], rh: [] };
  for (const l of grid.levels) {
    lv.t.push(mean(grid.field('t', l)));
    lv.gh.push(mean(grid.field('gh', l)));
    lv.u.push(mean(grid.field('u', l)));
    lv.v.push(mean(grid.field('v', l)));
    lv.rh.push(mean(grid.field('r', l)));
  }
  const sfc = { sp: mean(grid.field('sp')), t2: mean(grid.field('2t')), d2: mean(grid.field('2d')), u10: mean(grid.field('10u')), v10: mean(grid.field('10v')) };
  if (![sfc.sp, sfc.t2, sfc.d2].every(Number.isFinite)) return null;
  return buildProfile(lv, sfc);
}

// ---------------------------------------------------------------- great circles
const D2R = Math.PI / 180;
const toVec = (lat, lon) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)];

/** n points along the great circle from a to b ({lat, lon}), with distance from a in km. */
export function greatCircle(a, b, n) {
  const A = toVec(a.lat, a.lon);
  const B = toVec(b.lat, b.lon);
  const ang = Math.acos(Math.min(1, Math.max(-1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));
  const pts = [];
  for (let k = 0; k < n; k++) {
    const f = n === 1 ? 0 : k / (n - 1);
    let x;
    let y;
    let z;
    if (ang < 1e-9) [x, y, z] = A;
    else {
      const s0 = Math.sin((1 - f) * ang) / Math.sin(ang);
      const s1 = Math.sin(f * ang) / Math.sin(ang);
      x = s0 * A[0] + s1 * B[0];
      y = s0 * A[1] + s1 * B[1];
      z = s0 * A[2] + s1 * B[2];
    }
    pts.push({ lat: Math.atan2(z, Math.hypot(x, y)) / D2R, lon: Math.atan2(y, x) / D2R, km: f * ang * 6371 });
  }
  return pts;
}

/** The lat/lon extent of a set of points (longitudes unwrapped from the first). */
export function extent(points) {
  let s = 90;
  let n = -90;
  let w = Infinity;
  let e = -Infinity;
  const ref = points[0].lon;
  for (const p of points) {
    let lon = p.lon;
    while (lon - ref > 180) lon -= 360;
    while (lon - ref < -180) lon += 360;
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
    w = Math.min(w, lon);
    e = Math.max(e, lon);
  }
  return { south: s, north: n, west: w, east: e };
}

/**
 * Values along a cross section: per level arrays of t (K), gh (m), u, v (m/s),
 * rh (%), plus surface pressure (hPa) per point.
 */
export function sectionData(grid, points) {
  const per = (param) =>
    grid.levels.map((l) => {
      const f = grid.field(param, l);
      return points.map((p) => sample(f, p.lat, p.lon));
    });
  const sp = grid.field('sp');
  return {
    levels: grid.levels,
    points,
    t: per('t'),
    gh: per('gh'),
    u: per('u'),
    v: per('v'),
    rh: per('r'),
    ps: points.map((p) => sample(sp, p.lat, p.lon) / 100),
  };
}
