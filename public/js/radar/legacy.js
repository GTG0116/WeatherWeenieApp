// Legacy-resolution view of a super-res sweep: 1° radials (and 1 km gates for
// reflectivity, like the old Level III base reflectivity), for products whose
// legacy Level III files are no longer published (N0Q, N0U, ...). Reflectivity-
// like moments keep the strongest value in each coarse bin; folded moments
// (velocity, spectrum width) and classes take the sample at the bin's centre,
// since averaging across an aliasing boundary or between classes is meaningless.

const AZ_BINS = 3600;
const cache = new WeakMap();

/**
 * @param {object} sweep decoded sweep (values nRadials × nGates, azLut per 0.1°)
 * @param {{gateKm?: number, nearest?: boolean}} opts target gate spacing; nearest = centre sample
 * @returns {object} a sweep in the same format (the input itself if it's already that coarse)
 */
export function legacySweep(sweep, { gateKm = 0.25, nearest = false } = {}) {
  if (sweep.empty || !sweep.azLut) return sweep;
  let meanWidth = 0;
  for (let r = 0; r < sweep.nRadials; r++) meanWidth += sweep.widths[r];
  meanWidth /= Math.max(1, sweep.nRadials);
  const gateStep = Math.max(1, Math.round(gateKm / sweep.gateKm));
  if (meanWidth >= 0.95 && gateStep === 1) return sweep;
  const key = `${gateKm}/${nearest}`;
  let byKey = cache.get(sweep);
  if (byKey?.[key]) return byKey[key];

  const nG = Math.ceil(sweep.nGates / gateStep);
  const nR = 360;
  const out = new Float32Array(nR * nG).fill(NaN);
  const src = sweep.values;
  const inG = sweep.nGates;
  const lut = sweep.azLut;
  const rows = new Int32Array(10);
  for (let k = 0; k < nR; k++) {
    if (nearest) {
      const r = lut[k * 10 + 5];
      if (r < 0) continue;
      for (let g = 0; g < nG; g++) {
        const gi = Math.min(inG - 1, g * gateStep + (gateStep >> 1));
        out[k * nG + g] = src[r * inG + gi];
      }
      continue;
    }
    // The input radials under this degree.
    let n = 0;
    for (let i = 0; i < 10; i++) {
      const r = lut[k * 10 + i];
      if (r < 0) continue;
      let seen = false;
      for (let j = 0; j < n; j++) if (rows[j] === r) seen = true;
      if (!seen) rows[n++] = r;
    }
    if (!n) continue;
    for (let g = 0; g < nG; g++) {
      let best = -Infinity;
      let folded = false;
      const g0 = g * gateStep;
      const g1 = Math.min(inG, g0 + gateStep);
      for (let j = 0; j < n; j++) {
        const base = rows[j] * inG;
        for (let gi = g0; gi < g1; gi++) {
          const v = src[base + gi];
          if (v === Infinity) folded = true;
          else if (v > best) best = v;
        }
      }
      out[k * nG + g] = best > -Infinity ? best : folded ? Infinity : NaN;
    }
  }
  const azimuths = new Float32Array(nR);
  const widths = new Float32Array(nR).fill(1);
  const azLut = new Float32Array(AZ_BINS);
  for (let k = 0; k < nR; k++) azimuths[k] = k;
  for (let i = 0; i < AZ_BINS; i++) azLut[i] = Math.floor(i / 10);
  const res = {
    ...sweep,
    nRadials: nR,
    nGates: nG,
    gateKm: sweep.gateKm * gateStep,
    azimuths,
    widths,
    values: out,
    azLut,
    legacy: true,
  };
  byKey ??= {};
  byKey[key] = res;
  cache.set(sweep, byKey);
  return res;
}
