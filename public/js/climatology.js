// 1991-2020 NCEP/NCAR monthly climatologies (pre-converted, see tools/),
// interpolated in time and space onto the model grid for anomaly products.
// Variables: 'air' (temperature, °C) and 'hgt' (geopotential height, m).

const loading = new Map();
const cache = new Map();

export function loadClimatology(name) {
  if (!loading.has(name)) {
    loading.set(
      name,
      Promise.all([
        fetch(`data/clim/${name}_ltm.json`).then((r) => r.json()),
        fetch(`data/clim/${name}_ltm.bin`).then((r) => r.arrayBuffer()),
      ]).then(([meta, buf]) => ({ meta, data: new Int16Array(buf) })),
    );
  }
  return loading.get(name);
}

/** Month weights for a valid time, treating each monthly mean as centred mid-month. */
function monthWeights(date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const frac = (date.getUTCDate() - 1 + date.getUTCHours() / 24) / days; // 0..1 within month
  let pos = m + frac - 0.5;
  if (pos < 0) pos += 12;
  const m0 = Math.floor(pos) % 12;
  const m1 = (m0 + 1) % 12;
  return [m0, m1, pos - Math.floor(pos)];
}

/**
 * Climatological value on the model grid for a level and valid time
 * (°C for 'air', m for 'hgt').
 * @param {'air'|'hgt'} name
 * @param {{ni:number,nj:number,lat0:number,lon0:number,dlat:number,dlon:number}} grid
 */
export async function climatologyField(name, grid, level, validTime) {
  const clim = await loadClimatology(name);
  const li = clim.meta.levels.indexOf(level);
  if (li < 0) throw new Error(`No climatology for ${level} hPa`);
  const [m0, m1, w] = monthWeights(validTime);
  const key = `${name}:${level}:${m0}:${m1}:${w.toFixed(2)}:${grid.ni}x${grid.nj}`;
  if (cache.has(key)) return cache.get(key);

  const { nlat, nlon, lat0, dlat, lon0, dlon } = clim.meta;
  const plane = nlat * nlon;
  const a = clim.data.subarray((m0 * clim.meta.levels.length + li) * plane, (m0 * clim.meta.levels.length + li + 1) * plane);
  const b = clim.data.subarray((m1 * clim.meta.levels.length + li) * plane, (m1 * clim.meta.levels.length + li + 1) * plane);
  // Time-blend once at coarse resolution.
  const coarse = new Float32Array(plane);
  const scale = clim.meta.scale ?? 100;
  for (let i = 0; i < plane; i++) coarse[i] = ((1 - w) * a[i] + w * b[i]) / scale;

  const xi = new Int32Array(grid.ni);
  const xf = new Float32Array(grid.ni);
  for (let i = 0; i < grid.ni; i++) {
    let lon = grid.lon0 + i * grid.dlon - lon0;
    lon = ((lon % 360) + 360) % 360;
    const x = lon / dlon;
    xi[i] = Math.floor(x);
    xf[i] = x - xi[i];
  }
  const out = new Float32Array(grid.ni * grid.nj);
  for (let j = 0; j < grid.nj; j++) {
    const lat = grid.lat0 + j * grid.dlat;
    const y = Math.min(nlat - 1, Math.max(0, (lat - lat0) / dlat));
    const y0 = Math.min(nlat - 2, Math.floor(y));
    const fy = y - y0;
    const r0 = y0 * nlon;
    const r1 = r0 + nlon;
    for (let i = 0; i < grid.ni; i++) {
      const x0 = xi[i];
      const x1 = (x0 + 1) % nlon;
      const fx = xf[i];
      const top = coarse[r0 + x0] * (1 - fx) + coarse[r0 + x1] * fx;
      const bot = coarse[r1 + x0] * (1 - fx) + coarse[r1 + x1] * fx;
      out[j * grid.ni + i] = top * (1 - fy) + bot * fy;
    }
  }
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}
