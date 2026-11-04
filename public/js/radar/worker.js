// Radar decoding worker: fetches a Level III product or the needed part of a
// Level II volume straight from the public buckets and decodes it off the main
// thread, deriving super-res storm-relative velocity and KDP where asked.
// Replies with one sweep as transferable typed arrays.
import { decodeLevel3 } from './level3.js';
import { readLevel2Sweep, readLevel2Volume } from './level2.js';
import { fetchRetry } from '../sources.js';

const AZ_BINS = 3600; // 0.1° azimuth lookup

/** Radial index for each 0.1° of azimuth (-1 = no radial), filling small gaps. */
function azimuthLookup(frame) {
  const lut = new Float32Array(AZ_BINS).fill(-1);
  for (let r = 0; r < frame.nRadials; r++) {
    const i0 = Math.round(frame.azimuths[r] * 10);
    const n = Math.max(1, Math.round(frame.widths[r] * 10));
    for (let k = 0; k < n; k++) lut[(((i0 + k) % AZ_BINS) + AZ_BINS) % AZ_BINS] = r;
  }
  // Radials don't tile the circle exactly: let neighbours cover gaps up to 1°.
  for (let pass = 0; pass < 10; pass++) {
    let filled = false;
    for (let i = 0; i < AZ_BINS; i++) {
      if (lut[i] >= 0) continue;
      const prev = lut[(i + AZ_BINS - 1) % AZ_BINS];
      if (prev >= 0) {
        lut[i] = prev;
        filled = true;
      }
    }
    if (!filled) break;
  }
  return lut;
}

const KT = 0.514444; // m/s per knot
const D2R = Math.PI / 180;

/**
 * Super-res storm-relative velocity: subtract the radar's average storm motion
 * (from its legacy SRM product of the same volume) along each beam.
 */
function applyStormMotion(frame, motion) {
  frame.stormMotion = motion?.speedKt ? motion : null;
  if (!frame.stormMotion) return;
  const speed = motion.speedKt * KT;
  const toward = (motion.dirDeg + 180) * D2R; // direction storms move towards
  for (let r = 0; r < frame.nRadials; r++) {
    const az = (frame.azimuths[r] + frame.widths[r] / 2) * D2R;
    const along = speed * Math.cos(toward - az);
    const row = r * frame.nGates;
    for (let g = 0; g < frame.nGates; g++) {
      const v = frame.values[row + g];
      if (Number.isFinite(v)) frame.values[row + g] = v - along;
    }
  }
}

// KDP as the NEXRAD dual-pol preprocessor does it: a least-squares fit of ΦDP
// over 25 gates (≈6 km), or 9 gates in heavy rain (≥ 40 dBZ), using only
// good gates (ρhv ≥ 0.9), and only where there's real precipitation (≥ 20 dBZ).
// ΦDP gets a 5-gate median first (phase spikes), and the result a 3-radial
// average across azimuth, which takes out most of the radial streaking.
const KDP_HALF_LIGHT = 12;
const KDP_HALF_HEAVY = 4;
const KDP_HEAVY_DBZ = 40;
const KDP_MIN_DBZ = 20;
const KDP_MIN_RHO = 0.9;
const KDP_MIN_FILL = 0.6; // share of the window that must be good gates

/** 5-gate running median along each radial (NaN gates are skipped). */
function medianAlongRadials(src, nRadials, nGates) {
  const out = new Float32Array(src.length).fill(NaN);
  const win = [];
  for (let r = 0; r < nRadials; r++) {
    const row = r * nGates;
    for (let g = 0; g < nGates; g++) {
      if (!Number.isFinite(src[row + g])) continue;
      win.length = 0;
      for (let k = Math.max(0, g - 2); k <= Math.min(nGates - 1, g + 2); k++) if (Number.isFinite(src[row + k])) win.push(src[row + k]);
      win.sort((a, b) => a - b);
      out[row + g] = win[win.length >> 1];
    }
  }
  return out;
}

/** Specific differential phase (°/km): half the range derivative of ΦDP. */
function kdpFromPhi(rawPhi, rho, ref, nRadials, nGates, gateKm) {
  const phi = medianAlongRadials(rawPhi, nRadials, nGates);
  const fit = new Float32Array(phi.length).fill(NaN);
  const n = new Float64Array(nGates + 1);
  const sx = new Float64Array(nGates + 1);
  const sy = new Float64Array(nGates + 1);
  const sxx = new Float64Array(nGates + 1);
  const sxy = new Float64Array(nGates + 1);
  for (let r = 0; r < nRadials; r++) {
    const row = r * nGates;
    for (let g = 0; g < nGates; g++) {
      const y = phi[row + g];
      const ok = Number.isFinite(y) && rho[row + g] >= KDP_MIN_RHO;
      n[g + 1] = n[g] + (ok ? 1 : 0);
      sx[g + 1] = sx[g] + (ok ? g : 0);
      sy[g + 1] = sy[g] + (ok ? y : 0);
      sxx[g + 1] = sxx[g] + (ok ? g * g : 0);
      sxy[g + 1] = sxy[g] + (ok ? g * y : 0);
    }
    for (let g = 0; g < nGates; g++) {
      const z = ref[row + g];
      if (!(z >= KDP_MIN_DBZ) || !(rho[row + g] >= KDP_MIN_RHO)) continue;
      const W = z >= KDP_HEAVY_DBZ ? KDP_HALF_HEAVY : KDP_HALF_LIGHT;
      const a = Math.max(0, g - W);
      const b = Math.min(nGates, g + W + 1);
      const k = n[b] - n[a];
      if (k < Math.max(4, KDP_MIN_FILL * (2 * W + 1))) continue;
      const Sx = sx[b] - sx[a];
      const Sy = sy[b] - sy[a];
      const den = k * (sxx[b] - sxx[a]) - Sx * Sx;
      if (!den) continue;
      const slope = (k * (sxy[b] - sxy[a]) - Sx * Sy) / den; // ° per gate
      fit[row + g] = slope / gateKm / 2;
    }
  }
  // Average with the neighbouring radials where they have a value too.
  const out = new Float32Array(phi.length).fill(NaN);
  for (let r = 0; r < nRadials; r++) {
    const row = r * nGates;
    const prev = ((r + nRadials - 1) % nRadials) * nGates;
    const next = ((r + 1) % nRadials) * nGates;
    for (let g = 0; g < nGates; g++) {
      const v = fit[row + g];
      if (!Number.isFinite(v)) continue;
      let sum = v;
      let cnt = 1;
      for (const w of [fit[prev + g], fit[next + g]]) {
        if (!Number.isFinite(w)) continue;
        sum += w;
        cnt++;
      }
      out[row + g] = Math.max(-2, Math.min(10, sum / cnt));
    }
  }
  return out;
}

// 3D volumes: every tilt resampled onto a box the user drew near the radar,
// x/y east/north (azimuthal equidistant about the site, km), z height above sea
// level. The smaller the box, the finer the grid. Each voxel is two bytes: the
// value scaled over [vmin, vmax] and whether there is data, so the GPU's
// trilinear filter can average only the gates that exist.
const KE_R = (4 / 3) * 6371; // effective earth radius for beam refraction, km
const BEAM_HALF_DEG = 0.5; // gates count this far above / below their tilt
const MAX_COLUMNS = 360 * 360; // grid columns in a box, whatever its size
const MIN_DX_KM = 0.25; // a gate's length: no point going finer
const NZ = 56;
const TOP_KM = 18;

/** Decoded tilts of the last volume this worker read, so a new box needn't fetch it again. */
let lastVolume = null;

async function decodeVolume(url, moment) {
  const key = `${url}#${moment}`;
  if (lastVolume?.key === key) return lastVolume.vol;
  lastVolume = null; // let the old one go before reading the next
  const res = await fetchRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('/').pop()}`);
  const vol = readLevel2Volume(new Uint8Array(await res.arrayBuffer()), moment);
  vol.tilts.forEach((t) => (t.lut = azimuthLookup(t)));
  lastVolume = { key, vol };
  return vol;
}

/** @param {{x0: number, x1: number, y0: number, y1: number}} box km east / north of the radar */
function resampleVolume(vol, vmin, vmax, box) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const cell = Math.max(MIN_DX_KM, Math.sqrt((w * h) / MAX_COLUMNS));
  const nx = Math.max(2, Math.round(w / cell));
  const ny = Math.max(2, Math.round(h / cell));
  const dx = w / nx;
  const dy = h / ny;
  const dz = TOP_KM / NZ;
  const tilts = vol.tilts;
  const angles = tilts.map((t) => t.elevation);
  const nt = tilts.length;
  const siteKm = (vol.heightM ?? 0) / 1000;
  const out = new Uint8Array(nx * ny * NZ * 2);
  const rows = new Int32Array(nt);
  const scale = 254 / (vmax - vmin);
  let topLevel = 0;
  const sample = (t, r) => {
    const s = tilts[t];
    const row = rows[t];
    if (row < 0) return NaN;
    const g = Math.floor((r - s.firstGateKm) / s.gateKm + 0.5);
    if (g < 0 || g >= s.nGates) return NaN;
    const v = s.values[row * s.nGates + g];
    return v === Infinity ? NaN : v; // range folded
  };
  for (let j = 0; j < ny; j++) {
    const y = box.y0 + (j + 0.5) * dy;
    for (let i = 0; i < nx; i++) {
      const x = box.x0 + (i + 0.5) * dx;
      const s = Math.hypot(x, y);
      const azBin = Math.min(AZ_BINS - 1, Math.floor((((Math.atan2(x, y) / D2R) + 360) % 360) * 10));
      for (let t = 0; t < nt; t++) rows[t] = tilts[t].lut[azBin];
      const phi = s / KE_R;
      const sin = Math.sin(phi);
      const cos = Math.cos(phi);
      for (let k = 0; k < NZ; k++) {
        const hk = (k + 0.5) * dz - siteKm; // above the antenna
        if (hk < 0) continue;
        const px = (KE_R + hk) * sin;
        const py = (KE_R + hk) * cos - KE_R;
        const r = Math.hypot(px, py);
        const el = Math.atan2(py, px) / D2R;
        if (el < angles[0] - BEAM_HALF_DEG || el > angles[nt - 1] + BEAM_HALF_DEG) continue;
        let b = 0;
        while (b < nt && angles[b] < el) b++;
        const a = b - 1;
        const va = a >= 0 ? sample(a, r) : NaN;
        const vb = b < nt ? sample(b, r) : NaN;
        let v;
        if (va === va && vb === vb) v = va + ((vb - va) * (el - angles[a])) / (angles[b] - angles[a]);
        else if (va === va && el - angles[a] <= BEAM_HALF_DEG) v = va;
        else if (vb === vb && angles[b] - el <= BEAM_HALF_DEG) v = vb;
        else continue;
        const o = ((k * ny + j) * nx + i) * 2;
        out[o] = Math.max(0, Math.min(254, Math.round((v - vmin) * scale)));
        out[o + 1] = 255;
        if (k > topLevel) topLevel = k;
      }
    }
  }
  // Blur over ~0.8 km whatever the cell size: radials are that far apart 100 km out.
  smoothLevels(out, nx, ny, NZ, Math.max(1, Math.min(3, Math.round(0.8 / cell))));
  return {
    ...box, nx, ny, nz: NZ, dx, dy, data: out, topKm: Math.min(TOP_KM, (topLevel + 1.5) * dz), gridTopKm: TOP_KM,
    vmin, vmax, nTilts: nt, angles,
  };
}

/**
 * [1 2 1] blurs across each level, value and coverage alike (so the value the
 * GPU reads, value / coverage, stays an average of real gates only). Takes the
 * gate-to-gate speckle off the surfaces.
 */
function smoothLevels(data, nx, ny, nz, passes) {
  const m = nx * ny;
  const v = new Float32Array(m);
  const c = new Float32Array(m);
  const tv = new Float32Array(m);
  const tc = new Float32Array(m);
  for (let k = 0; k < nz; k++) {
    const base = k * m * 2;
    for (let p = 0; p < m; p++) {
      v[p] = data[base + 2 * p];
      c[p] = data[base + 2 * p + 1];
    }
    for (let pass = 0; pass < 2 * passes; pass++) {
      const along = pass % 2; // 0: east-west, 1: north-south
      const [sv, sc, dv, dc] = along ? [tv, tc, v, c] : [v, c, tv, tc];
      const step = along ? nx : 1;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const p = j * nx + i;
          const at = along ? j : i;
          const a = at > 0 ? p - step : p;
          const b = at < (along ? ny : nx) - 1 ? p + step : p;
          dv[p] = (sv[a] + 2 * sv[p] + sv[b]) / 4;
          dc[p] = (sc[a] + 2 * sc[p] + sc[b]) / 4;
        }
      }
    }
    for (let p = 0; p < m; p++) {
      data[base + 2 * p] = Math.round(v[p]);
      data[base + 2 * p + 1] = Math.round(c[p]);
    }
  }
}

async function fetchLevel3(url) {
  const res = await fetchRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('/').pop()}`);
  return decodeLevel3(new Uint8Array(await res.arrayBuffer()));
}

async function level2Range(url, from, to) {
  const res = await fetchRetry(url, { headers: { Range: `bytes=${from}-${to - 1}` } });
  if (res.status === 416) return new Uint8Array(0);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('/').pop()}`);
  return new Uint8Array(await res.arrayBuffer());
}

self.onmessage = async ({ data: { id, job } }) => {
  try {
    let frame;
    if (job.volume) {
      const vol = await decodeVolume(job.url, job.moment);
      const grid = resampleVolume(vol, job.vmin, job.vmax, job.box);
      const out = { lat: vol.lat, lon: vol.lon, heightM: vol.heightM, vcp: vol.vcp, time: vol.time, ...grid };
      self.postMessage({ id, frame: out }, [out.data.buffer]);
      return;
    }
    if (job.level === 3) {
      const [main, pair] = await Promise.all([fetchLevel3(job.url), job.pairUrl && fetchLevel3(job.pairUrl)]);
      frame = main;
      if (pair && !frame.empty) applyStormMotion(frame, pair.stormMotion);
    } else {
      frame = await readLevel2Sweep((a, b) => level2Range(job.url, a, b), job.moment, job.tilt, job.extra ?? []);
      if (job.derive === 'kdp') {
        const { RHO, REF } = frame.extra;
        frame.values = kdpFromPhi(frame.values, RHO, REF, frame.nRadials, frame.nGates, frame.gateKm);
      }
      delete frame.extra;
    }
    const transfer = [];
    if (!frame.empty) {
      frame.azLut = azimuthLookup(frame);
      transfer.push(frame.values.buffer, frame.azimuths.buffer, frame.widths.buffer, frame.azLut.buffer);
    }
    self.postMessage({ id, frame }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
