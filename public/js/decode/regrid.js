// Regridding of projected model grids (Lambert conformal, rotated lat/lon) onto
// a regular lat/lon grid, so every product, shader and sampler only ever deals
// with lat/lon fields. Grid-relative winds are rotated to earth-relative here.
// The index mapping for a grid is computed once per worker and reused.
import { extractWindow } from './window.js';

const D2R = Math.PI / 180;

function lambert(g) {
  const R = g.radius;
  const p1 = g.latin1 * D2R;
  const p2 = g.latin2 * D2R;
  const t = (lat) => Math.tan(Math.PI / 4 + (lat * D2R) / 2);
  const n =
    Math.abs(g.latin1 - g.latin2) < 1e-6
      ? Math.sin(p1)
      : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t(g.latin2) / t(g.latin1));
  const F = (Math.cos(p1) * t(g.latin1) ** n) / n;
  const fwd = (lat, lon) => {
    const dl = ((((lon - g.lov) % 360) + 540) % 360) - 180;
    const th = n * dl * D2R;
    const r = (R * F) / t(lat) ** n;
    return [r * Math.sin(th), -r * Math.cos(th)];
  };
  const [x1, y1] = fwd(g.la1, g.lo1);
  const sx = g.scan & 0x80 ? -1 : 1;
  const sy = g.scan & 0x40 ? 1 : -1;
  const sn = Math.sign(n);
  return {
    toGrid(lat, lon) {
      const [x, y] = fwd(lat, lon);
      return [(sx * (x - x1)) / g.dx, (sy * (y - y1)) / g.dy];
    },
    toGeo(i, j) {
      const x = x1 + sx * i * g.dx;
      const y = y1 + sy * j * g.dy;
      const r = sn * Math.hypot(x, y);
      const th = Math.atan2(sn * x, -sn * y);
      return [(2 * Math.atan(((R * F) / r) ** (1 / n)) - Math.PI / 2) / D2R, g.lov + th / n / D2R];
    },
    // Projected coordinates are conformal, so this gives the local grid angle.
    projected: fwd,
  };
}

function rotll(g) {
  const p0 = g.lat0 * D2R;
  const cp = Math.cos(p0);
  const sp = Math.sin(p0);
  const rot = (lat, lon) => {
    const la = lat * D2R;
    const lo = (lon - g.lon0) * D2R;
    const x = Math.cos(la) * Math.cos(lo);
    const y = Math.cos(la) * Math.sin(lo);
    const z = Math.sin(la);
    return [Math.asin(Math.max(-1, Math.min(1, -x * sp + z * cp))) / D2R, Math.atan2(y, x * cp + z * sp) / D2R];
  };
  const unrot = (rlat, rlon) => {
    const la = rlat * D2R;
    const lo = rlon * D2R;
    const xr = Math.cos(la) * Math.cos(lo);
    const y = Math.cos(la) * Math.sin(lo);
    const zr = Math.sin(la);
    const x = xr * cp - zr * sp;
    const z = xr * sp + zr * cp;
    return [Math.asin(Math.max(-1, Math.min(1, z))) / D2R, Math.atan2(y, x) / D2R + g.lon0];
  };
  const [rlat1, rlon1] = rot(g.la1, g.lo1);
  const [rlat2, rlon2] = rot(g.la2, g.lo2);
  const di = (rlon2 - rlon1) / (g.ni - 1);
  const dj = (rlat2 - rlat1) / (g.nj - 1);
  return {
    toGrid(lat, lon) {
      const [rlat, rlon] = rot(lat, lon);
      return [(rlon - rlon1) / di, (rlat - rlat1) / dj];
    },
    toGeo: (i, j) => unrot(rlat1 + j * dj, rlon1 + i * di),
    projected(lat, lon) {
      const [rlat, rlon] = rot(lat, lon);
      return [rlon * Math.cos(rlat * D2R), rlat];
    },
  };
}

const projectionOf = (g) => (g.type === 'lambert' ? lambert(g) : g.type === 'rotll' ? rotll(g) : null);

/** Bounding box of a projected grid, from points along its edges. */
function bounds(proj, g) {
  const pts = [];
  const N = 64;
  for (let k = 0; k <= N; k++) {
    const i = ((g.ni - 1) * k) / N;
    const j = ((g.nj - 1) * k) / N;
    pts.push(proj.toGeo(i, 0), proj.toGeo(i, g.nj - 1), proj.toGeo(0, j), proj.toGeo(g.ni - 1, j));
  }
  const [cLat, cLon] = proj.toGeo((g.ni - 1) / 2, (g.nj - 1) / 2);
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lat, lon] of pts) {
    const rel = ((((lon - cLon) % 360) + 540) % 360) - 180;
    s = Math.min(s, lat);
    n = Math.max(n, lat);
    w = Math.min(w, rel);
    e = Math.max(e, rel);
  }
  return { south: s, north: n, west: w + cLon, east: e + cLon };
}

const grids = new Map(); // output lat/lon grid per projected grid and settings

/** The output lat/lon grid for a projected grid (no per-point work yet). */
function gridFor(g, { res, clip }) {
  const key = JSON.stringify([g, res, clip]);
  if (grids.has(key)) return grids.get(key);
  const proj = projectionOf(g);
  if (!proj) throw new Error(`Can't regrid ${g.type} grids`);
  const box = clip ?? bounds(proj, g);
  const lon0 = ((((box.west + 180) % 360) + 360) % 360) - 180;
  const ni = Math.round((box.east - box.west) / res) + 1;
  const nj = Math.round((box.north - box.south) / res) + 1;
  const grid = { key, g, proj, meta: { ni, nj, lat0: box.south, lon0, dlat: res, dlon: res, regional: true }, plan: null, windows: new Map() };
  if (grids.size > 4) grids.delete(grids.keys().next().value);
  grids.set(key, grid);
  return grid;
}

/**
 * Per output point (all of them, or the flat indices in ks): the fractional
 * native index (NaN outside) and the grid→earth wind rotation.
 */
function mapPoints({ g, proj, meta }, ks = null) {
  const n = ks ? ks.length : meta.ni * meta.nj;
  const ix = new Float32Array(n);
  const iy = new Float32Array(n);
  const cos = g.gridRelative ? new Float32Array(n) : null;
  const sin = g.gridRelative ? new Float32Array(n) : null;
  for (let q = 0; q < n; q++) {
    const k = ks ? ks[q] : q;
    const j = Math.floor(k / meta.ni);
    const lat = meta.lat0 + j * meta.dlat;
    const lon = meta.lon0 + (k - j * meta.ni) * meta.dlon;
    const [x, y] = proj.toGrid(lat, lon);
    const inside = x >= 0 && y >= 0 && x <= g.ni - 1 && y <= g.nj - 1;
    ix[q] = inside ? x : NaN;
    iy[q] = inside ? y : NaN;
    if (cos && inside) {
      // Angle of local east in projected coordinates.
      const [ax, ay] = proj.projected(lat, lon);
      const [bx, by] = proj.projected(lat, lon + 0.01);
      const a = Math.atan2(by - ay, bx - ax);
      cos[q] = Math.cos(a);
      sin[q] = Math.sin(a);
    }
  }
  return { ix, iy, cos, sin };
}

/** The mapping for every output point (computed once per worker and grid). */
function planFor(g, opts) {
  const grid = gridFor(g, opts);
  grid.plan ??= { ...mapPoints(grid), meta: grid.meta };
  return grid.plan;
}

/**
 * The mapping for the points of a window only, laid out exactly as
 * extractWindow() would cut it from the full regridded field.
 */
function windowPlan(g, opts, box) {
  const grid = gridFor(g, opts);
  const key = `${box.south},${box.north},${box.west},${box.east}`;
  if (!grid.windows.has(key)) {
    // Cut a field of output-point indices to find which points the window has.
    if (!grid.index) {
      grid.index = new Float32Array(grid.meta.ni * grid.meta.nj); // exact below 2^24 points
      for (let k = 0; k < grid.index.length; k++) grid.index[k] = k;
    }
    const cut = extractWindow({ values: grid.index, meta: grid.meta }, box);
    grid.windows.set(key, { ...mapPoints(grid, cut.values), meta: cut.meta });
    if (grid.windows.size > 64) grid.windows.delete(grid.windows.keys().next().value);
  }
  return grid.windows.get(key);
}

/** How many native rows (from the first) a window of a projected grid samples. */
export function rowsNeeded(g, opts, box) {
  const plan = windowPlan(g, opts, box);
  if (plan.rows == null) {
    let max = -1;
    for (const y of plan.iy) if (y > max) max = y;
    plan.rows = max < 0 ? 0 : Math.min(g.nj, Math.floor(max) + 2);
  }
  return plan.rows;
}

function sample(values, plan, ni, nj) {
  const { ix, iy } = plan;
  const out = new Float32Array(ix.length);
  for (let k = 0; k < out.length; k++) {
    const x = ix[k];
    if (x !== x) {
      out[k] = NaN;
      continue;
    }
    const y = iy[k];
    const x0 = Math.min(ni - 2, x | 0);
    const y0 = Math.min(nj - 2, y | 0);
    const fx = x - x0;
    const fy = y - y0;
    const r0 = y0 * ni + x0;
    const r1 = r0 + ni;
    out[k] =
      (values[r0] * (1 - fx) + values[r0 + 1] * fx) * (1 - fy) + (values[r1] * (1 - fx) + values[r1 + 1] * fx) * fy;
  }
  return out;
}

/**
 * Regrid one field, or a grid-relative u/v pair (rotated to earth-relative).
 * @param {{values: Float32Array, meta: object}[]} fields 1 field, or [u, v]
 * @param {{res: number, clip?: {south:number,north:number,west:number,east:number}}} opts
 * @param {object} [box] only regrid this window (as extractWindow cuts it)
 */
export function regrid(fields, opts, box = null) {
  const g = fields[0].meta.projection;
  const plan = box ? windowPlan(g, opts, box) : planFor(g, opts);
  const out = fields.map((f) => sample(f.values, plan, g.ni, g.nj));
  if (out.length === 2 && plan.cos) {
    const [u, v] = out;
    const { cos, sin } = plan;
    for (let k = 0; k < u.length; k++) {
      const ug = u[k];
      const vg = v[k];
      u[k] = ug * cos[k] + vg * sin[k];
      v[k] = -ug * sin[k] + vg * cos[k];
    }
  }
  return out.map((values, i) => {
    const { projection, ...meta } = fields[i].meta;
    return { values, meta: { ...meta, ...plan.meta } };
  });
}
