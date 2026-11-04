// Cut a lat/lon box out of a decoded field, so soundings and cross sections
// can keep (and cache) a small region of every level instead of whole grids.

/**
 * @param {{values: Float32Array, meta: object}} field regular lat/lon grid (as decoded/regridded)
 * @param {{south: number, north: number, west: number, east: number}} box degrees; east may exceed 180
 * @param {number} max largest window side in points (coarser stride beyond that)
 * @returns {{values: Float32Array, meta: object}} the window, described as a regional grid
 */
export function extractWindow({ values, meta }, box, max = 400) {
  const { ni, nj, lat0, lon0, dlat, dlon } = meta;
  // Rows
  const ja = (box.south - lat0) / dlat;
  const jb = (box.north - lat0) / dlat;
  const j0 = Math.max(0, Math.floor(Math.min(ja, jb)) - 1);
  const j1 = Math.min(nj - 1, Math.ceil(Math.max(ja, jb)) + 1);
  // Columns: global grids wrap around, regional ones are clipped.
  const width = Math.max(0, box.east - box.west);
  let i0;
  let count;
  if (meta.regional) {
    const xa = (((box.west - lon0) % 360) + 360) % 360 / dlon;
    i0 = Math.max(0, Math.floor(xa) - 1);
    count = Math.min(ni - i0, Math.ceil(width / dlon) + 3);
    if (xa > ni + 1) count = 0;
  } else {
    i0 = Math.floor(((((box.west - lon0) / dlon) % ni) + ni) % ni) - 1;
    count = Math.min(ni, Math.ceil(width / dlon) + 3);
  }
  const rows = Math.max(0, j1 - j0 + 1);
  const stride = Math.max(1, Math.ceil(Math.max(count, rows) / max));
  const nx = Math.max(1, Math.ceil(count / stride));
  const ny = Math.max(1, Math.ceil(rows / stride));
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const j = Math.min(nj - 1, j0 + y * stride);
    for (let x = 0; x < nx; x++) {
      const i = meta.regional ? Math.min(ni - 1, i0 + x * stride) : (((i0 + x * stride) % ni) + ni) % ni;
      out[y * nx + x] = count ? values[j * ni + i] : NaN;
    }
  }
  let w = lon0 + i0 * dlon;
  w = ((((w + 180) % 360) + 360) % 360) - 180;
  return {
    values: out,
    meta: { ...meta, projection: undefined, ni: nx, nj: ny, lat0: lat0 + j0 * dlat, lon0: w, dlat: dlat * stride, dlon: dlon * stride, regional: true },
  };
}
