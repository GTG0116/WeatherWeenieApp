// NEXRAD / TDWR Level III product decoder (NWS ICD 2620001). Handles the
// radial products the app shows: digital radial arrays (packet 16), 16-level
// run-length radials (packet AF1F), and the 16-level raster grids (BA07/BA0F)
// that TDWR VIL still uses, which are resampled onto radials here. Data levels
// are turned into physical values with each product's own threshold encoding.
import { bunzip2 } from '../decode/bzip2.js';

export const RF = Infinity; // range folded: drawn in its own colour
const KT = 0.514444; // m/s per knot
const KFT = 0.3048; // km per kft

// Gate spacing (km) per product code; Level III doesn't carry it in the file.
const GATE_KM = {
  56: 1, 57: 4, 99: 0.25, 134: 1, 135: 1, 153: 0.25, 154: 0.25, 159: 0.25, 161: 0.25, 163: 0.25, 165: 0.25,
  170: 0.25, 172: 0.25, 173: 0.25, 177: 0.25, 180: 0.15, 182: 0.15, 186: 0.3,
};

/** NEXRAD 16-bit float: sign, 5-bit exponent, 10-bit fraction. */
function half(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  return e ? s * 2 ** (e - 16) * (1 + f / 1024) : s * 2 * (f / 1024);
}

/**
 * Data level → value table for a product, from halfwords 31–46 of the
 * product description block (`hw(n)` reads halfword n, 1-based).
 */
function levelTable(code, hw, uhw, f32) {
  const lut = new Float32Array(256).fill(NaN);
  const linear = (min, inc, rf) => {
    for (let c = 2; c < 256; c++) lut[c] = min + (c - 2) * inc;
    if (rf) lut[1] = RF;
  };
  switch (code) {
    case 153: // super-res reflectivity, dBZ
    case 180:
    case 186: // TDWR reflectivity
      linear(hw(31) / 10, hw(32) / 10, false);
      break;
    case 154: // super-res velocity, m/s
    case 99: // velocity at the higher tilts
    case 182: // TDWR velocity
      linear(hw(31) / 10, hw(32) / 10, true);
      break;
    case 159: // ZDR (dB), CC, KDP (°/km): scale/offset floats
    case 161:
    case 163: {
      const scale = f32(31);
      const offset = f32(33);
      const max = uhw(36) || 255;
      for (let c = 2; c <= max; c++) lut[c] = (c - offset) / scale;
      break;
    }
    case 165: // hydrometeor classes 10..140; 150 = range folded
    case 177:
      for (let c = 10; c <= 140; c += 10) lut[c] = c;
      lut[150] = RF;
      break;
    case 170: // 1 h / storm total / 3 h accumulation: 0.01 in → mm
    case 172:
    case 173: {
      const scale = f32(31);
      const offset = f32(33);
      for (let c = 1; c < 256; c++) lut[c] = ((c - offset) / scale) * 0.254;
      break;
    }
    case 134: {
      // digital VIL, kg/m²: linear below a code, logarithmic above
      const linScale = half(uhw(31));
      const linOff = half(uhw(32));
      const logStart = hw(33);
      const logScale = half(uhw(34));
      const logOff = half(uhw(35));
      for (let c = 2; c < 255; c++) lut[c] = c < logStart ? Math.max(0, (c - linOff) / linScale) : Math.exp((c - logOff) / logScale);
      break;
    }
    case 135: {
      // enhanced echo tops: kft, with a "topped" flag bit → km
      const mask = hw(31) || 0x7f;
      const scale = hw(32) || 1;
      const offset = hw(33);
      for (let c = 2; c < 256; c++) lut[c] = Math.max(0, ((c & mask) / scale - offset) * KFT);
      break;
    }
    default: {
      // 16-level products: each threshold halfword is a coded value
      const unit = code === 56 ? KT : 1; // storm-relative velocity is in knots
      for (let k = 0; k < 16; k++) {
        const t = uhw(31 + k);
        if (t & 0x8000) {
          lut[k] = (t & 0xff) === 3 ? RF : NaN; // TH / ND / RF codes
          continue;
        }
        let v = t & 0xff;
        if (t & 0x0100) v = -v;
        lut[k] = v * unit;
      }
    }
  }
  return lut;
}

/**
 * Decode a Level III file (with or without its WMO/AWIPS header).
 * @param {Uint8Array} bytes
 * @returns {{code, lat, lon, heightM, elevation, time: number, vcp, firstGateKm, gateKm,
 *   nGates, nRadials, azimuths: Float32Array, widths: Float32Array, values: Float32Array,
 *   empty: boolean, span?: number}}
 *   values is nRadials × nGates (NaN = no data, Infinity = range folded).
 */
export function decodeLevel3(bytes) {
  // Skip the text header ("SDUS54 KOUN 040015\r\r\nN0BTLX\r\r\n"): the
  // message header starts with a small product code, never ASCII letters.
  let o = 0;
  for (let k = 0; k < 2 && bytes[0] >= 0x30; k++) {
    const nl = bytes.indexOf(0x0a, o);
    if (nl < 0 || nl > 64) break;
    o = nl + 1;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset + o, bytes.byteLength - o);
  const hw = (n) => dv.getInt16((n - 1) * 2);
  const uhw = (n) => dv.getUint16((n - 1) * 2);
  const f32 = (n) => dv.getFloat32((n - 1) * 2);
  if (hw(10) !== -1) throw new Error('Not a Level III product');

  const code = hw(16);
  const out = {
    code,
    lat: dv.getInt32(20) / 1000,
    lon: dv.getInt32(24) / 1000,
    heightM: hw(15) * 0.3048,
    vcp: hw(18),
    elevation: [56, 99, 153, 154, 159, 161, 163, 165, 180, 182, 186].includes(code) ? hw(30) / 10 : null,
    time: ((uhw(21) - 1) * 86400 + dv.getUint32(42)) * 1000,
    span: code === 173 ? hw(28) : code === 170 ? 60 : null, // accumulation period, minutes
    // Storm-relative velocity: the average storm motion it was made with (kt, from °).
    stormMotion: code === 56 ? { speedKt: hw(51) / 10, dirDeg: hw(52) / 10 } : null,
    firstGateKm: 0,
    gateKm: GATE_KM[code] ?? 1,
    empty: true,
  };
  const lut = levelTable(code, hw, uhw, f32);

  const symOff = dv.getInt32(108) * 2;
  if (!symOff) return out; // no symbology block: nothing detected
  let sym = new Uint8Array(bytes.buffer, bytes.byteOffset + o + symOff, bytes.byteLength - o - symOff);
  // Compressed products: bzip2 from the symbology block on (halfword 51 = 1).
  if (hw(51) === 1 && sym[0] === 0x42 && sym[1] === 0x5a) sym = bunzip2(sym, dv.getUint32(102));
  const s = new DataView(sym.buffer, sym.byteOffset, sym.byteLength);
  if (s.getInt16(0) !== -1 || s.getInt16(2) !== 1) throw new Error('Bad symbology block');

  const nLayers = s.getInt16(8);
  let p = 10;
  for (let layer = 0; layer < nLayers && p + 6 <= sym.length; layer++) {
    const layerEnd = p + 6 + s.getInt32(p + 2);
    p += 6;
    while (p + 4 <= layerEnd) {
      const pk = s.getUint16(p);
      if (pk === 16) return { ...out, ...digitalRadials(s, sym, p, lut) };
      if (pk === 0xaf1f) return { ...out, ...rleRadials(s, sym, p, lut) };
      if (pk === 0xba07 || pk === 0xba0f) return { ...out, ...raster(s, sym, p, lut, out.gateKm), gateKm: 1 };
      // text, symbols, generic packets: length-prefixed; skip them
      p += 4 + s.getUint16(p + 2);
    }
    p = layerEnd;
  }
  return out;
}

function radialHeader(s, p) {
  return { firstBin: s.getInt16(p + 2), nGates: s.getInt16(p + 4), nRadials: s.getInt16(p + 12) };
}

/** Packet 16: one byte per gate. */
function digitalRadials(s, bytes, p, lut) {
  const { firstBin, nGates, nRadials } = radialHeader(s, p);
  const values = new Float32Array(nRadials * nGates).fill(NaN);
  const azimuths = new Float32Array(nRadials);
  const widths = new Float32Array(nRadials);
  p += 14;
  for (let r = 0; r < nRadials; r++) {
    const n = s.getInt16(p);
    azimuths[r] = s.getInt16(p + 2) / 10;
    widths[r] = s.getInt16(p + 4) / 10;
    p += 6;
    const m = Math.min(n, nGates);
    const row = r * nGates;
    for (let g = 0; g < m; g++) values[row + g] = lut[bytes[p + g]];
    p += n;
  }
  return { firstGateKm: firstBin, nGates, nRadials, azimuths, widths, values, empty: false };
}

/** Packet AF1F: run-length nibbles (run, level). */
function rleRadials(s, bytes, p, lut) {
  const { firstBin, nGates, nRadials } = radialHeader(s, p);
  const values = new Float32Array(nRadials * nGates).fill(NaN);
  const azimuths = new Float32Array(nRadials);
  const widths = new Float32Array(nRadials);
  p += 14;
  for (let r = 0; r < nRadials; r++) {
    const n = s.getInt16(p) * 2;
    azimuths[r] = s.getInt16(p + 2) / 10;
    widths[r] = s.getInt16(p + 4) / 10;
    p += 6;
    const row = r * nGates;
    let g = 0;
    for (let i = 0; i < n && g < nGates; i++) {
      const b = bytes[p + i];
      const v = lut[b & 15];
      for (let k = b >> 4; k > 0 && g < nGates; k--) values[row + g++] = v;
    }
    p += n;
  }
  return { firstGateKm: firstBin, nGates, nRadials, azimuths, widths, values, empty: false };
}

/**
 * Raster packets (BA07/BA0F): a square grid of run-length rows centred on the
 * radar, row 0 north. Resampled to 1° × 1 km radials so one draw path serves all.
 */
function raster(s, bytes, p, lut, cellKm) {
  const nRows = s.getInt16(p + 18);
  p += 22;
  const rows = [];
  let nCols = 0;
  for (let r = 0; r < nRows; r++) {
    const n = s.getInt16(p);
    p += 2;
    const row = [];
    for (let i = 0; i < n; i++) {
      const b = bytes[p + i];
      for (let k = b >> 4; k > 0; k--) row.push(lut[b & 15]);
    }
    p += n;
    rows.push(row);
    nCols = Math.max(nCols, row.length);
  }
  const halfKm = (nCols * cellKm) / 2;
  const nGates = Math.floor(halfKm);
  const nRadials = 360;
  const values = new Float32Array(nRadials * nGates).fill(NaN);
  const azimuths = new Float32Array(nRadials);
  const widths = new Float32Array(nRadials).fill(1);
  for (let a = 0; a < nRadials; a++) {
    azimuths[a] = a;
    const az = ((a + 0.5) * Math.PI) / 180;
    const sx = Math.sin(az);
    const cy = Math.cos(az);
    for (let g = 0; g < nGates; g++) {
      const rk = g + 0.5;
      const col = Math.floor((rk * sx + halfKm) / cellKm);
      const row = Math.floor((halfKm - rk * cy) / cellKm);
      const v = rows[row]?.[col];
      if (v !== undefined) values[a * nGates + g] = v;
    }
  }
  return { firstGateKm: 0, nGates, nRadials, azimuths, widths, values, empty: false };
}
