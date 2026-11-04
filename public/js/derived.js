// Fields computed locally from other fields: used where a model's open data
// doesn't publish a variable (AIFS has no vorticity, precip rate or precip type).

const EARTH_RADIUS = 6371220;
const D2R = Math.PI / 180;

/** Relative vorticity (s⁻¹) from u/v on a regular lat/lon grid (centred differences). */
export function vorticity(u, v, meta) {
  const { ni, nj, lat0, dlat, dlon } = meta;
  const dl = Math.abs(dlon) * D2R;
  const dp = Math.abs(dlat) * D2R;
  const out = new Float32Array(ni * nj);
  const cos = new Float64Array(nj);
  for (let j = 0; j < nj; j++) cos[j] = Math.cos((lat0 + j * dlat) * D2R);
  const north = dlat < 0 ? -1 : 1; // row offset toward the north
  for (let j = 1; j < nj - 1; j++) {
    const c = cos[j];
    if (c < 1e-3) continue;
    const jn = j + north;
    const js = j - north;
    for (let i = 0; i < ni; i++) {
      const ie = i + 1 === ni ? 0 : i + 1;
      const iw = i === 0 ? ni - 1 : i - 1;
      if (meta.regional && (i === 0 || i === ni - 1)) {
        out[j * ni + i] = NaN;
        continue;
      }
      const dvdl = (v[j * ni + ie] - v[j * ni + iw]) / (2 * dl);
      const ducdp = (u[jn * ni + i] * cos[jn] - u[js * ni + i] * cos[js]) / (2 * dp);
      out[j * ni + i] = (dvdl - ducdp) / (EARTH_RADIUS * c);
    }
  }
  return out;
}

/**
 * Precipitation type (WMO code table 4.201 subset: 1 rain, 3 freezing rain,
 * 5 snow, 7 rain/snow mix, 8 ice pellets) from the temperature profile.
 * A simple warm-nose scheme: levels below ground (p > surface pressure) are ignored.
 * @param {Float32Array} t2 2 m temperature (K)
 * @param {{level:number, values:Float32Array}[]} levels temperatures aloft (K), low to high
 * @param {Float32Array} sp surface pressure (Pa)
 */
export function classifyPrecipType(t2, levels, sp) {
  const n = t2.length;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const ts = t2[k] - 273.15;
    let warm = -99; // warmest temperature aloft (°C)
    let coldAloft = ts; // coldest temperature in the layer under the warm nose
    let seenWarm = false;
    for (const { level, values } of levels) {
      if (level * 100 > sp[k]) continue;
      const t = values[k] - 273.15;
      if (t > warm) warm = t;
      if (t > 0.5) seenWarm = true;
      else if (!seenWarm) coldAloft = Math.min(coldAloft, t);
    }
    if (warm <= 0.5) out[k] = ts <= 1.5 ? 5 : ts <= 3 ? 7 : 1;
    else if (ts > 0.5) out[k] = 1;
    else if (warm >= 3 && coldAloft > -6) out[k] = 3;
    else out[k] = 8;
  }
  return out;
}

/** Kuchera snow-to-liquid ratio from the column's maximum temperature (K). */
export function kucheraRatio(tmax) {
  const r = tmax > 271.16 ? 12 + 2 * (271.16 - tmax) : 12 + (271.16 - tmax);
  return Math.min(40, Math.max(0, r));
}

/** Relative vorticity (s⁻¹) from absolute vorticity: ζ = η − f. */
export function relativeVorticity(absv, meta) {
  const { ni, nj, lat0, dlat } = meta;
  const out = new Float32Array(absv.length);
  for (let j = 0; j < nj; j++) {
    const f = 2 * 7.2921e-5 * Math.sin((lat0 + j * dlat) * D2R);
    for (let i = 0, k = j * ni; i < ni; i++, k++) out[k] = absv[k] - f;
  }
  return out;
}

/** Dew point (K) from temperature (K) and relative humidity (%), Magnus formula. */
export function dewpointFromRh(t, rh) {
  const out = new Float32Array(t.length);
  for (let k = 0; k < t.length; k++) {
    const tc = t[k] - 273.15;
    const g = Math.log(Math.max(1, rh[k]) / 100) + (17.62 * tc) / (243.12 + tc);
    out[k] = (243.12 * g) / (17.62 - g) + 273.15;
  }
  return out;
}

/**
 * Precip type (code table 4.201 subset, as classifyPrecipType) from NCEP's
 * categorical yes/no fields. Freezing rain wins over sleet, sleet over snow.
 */
export function ptypeFromCategorical({ rain, snow, fzra, ip }) {
  const n = rain.values.length;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (fzra.values[k] >= 0.5) out[k] = 3;
    else if (ip.values[k] >= 0.5) out[k] = 8;
    else if (snow.values[k] >= 0.5) out[k] = rain.values[k] >= 0.5 ? 7 : 5;
    else if (rain.values[k] >= 0.5) out[k] = 1;
  }
  return out;
}

/** Precip type from a WMO weather code (as published for ICON). */
export function ptypeFromWmo(code) {
  const out = new Float32Array(code.length);
  for (let k = 0; k < code.length; k++) {
    const c = Math.round(code[k]);
    if (c === 56 || c === 57 || c === 66 || c === 67) out[k] = 3;
    else if ((c >= 71 && c <= 77) || c === 85 || c === 86) out[k] = 5;
    else if ((c >= 51 && c <= 65) || (c >= 80 && c <= 82) || c >= 95) out[k] = 1;
  }
  return out;
}
