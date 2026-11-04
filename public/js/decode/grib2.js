// Minimal GRIB2 decoder for ECMWF and NCEP open data.
// Supports: grid templates 3.0 (regular lat/lon), 3.30 (Lambert conformal) and
// 3.32769 (NCEP rotated lat/lon), product templates 4.0/4.1/4.8/4.11, data
// representation 5.0 (simple), 5.2/5.3 (complex packing, spatial differencing),
// 5.40 (JPEG 2000) and 5.42 (CCSDS/AEC), bitmaps. Projected grids are regridded
// in regrid.js.
import { aecDecode } from './aec.js';
import { jpxDecode } from './jpx.js';

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
// GRIB2 signed integers use sign-magnitude, not two's complement.
const s16 = (b, i) => {
  const v = u16(b, i);
  return v & 0x8000 ? -(v & 0x7fff) : v;
};
const s32 = (b, i) => {
  const v = u32(b, i);
  return v & 0x80000000 ? -(v & 0x7fffffff) : v;
};
const f32 = (b, i) => new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0, false);

/**
 * Decode every message in a GRIB2 buffer.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {(meta: object) => boolean} [keep] decode only the fields this accepts (e.g. one
 *   ensemble member of a file of all members); the others are skipped without unpacking
 * @param {(meta: object) => number} [need] how many grid points (in scan order) are
 *   needed; unpacking stops there and the rest of the field is NaN (windows)
 * @returns {Array<{meta: object, values: Float32Array}>}
 */
export function decodeGrib2(buffer, keep = null, need = null) {
  const out = [];
  for (const m of splitGrib2(buffer)) {
    if (m[7] !== 2) throw new Error('Only GRIB edition 2 is supported');
    out.push(...decodeMessage(m, keep, need));
  }
  return out;
}

/** The separate messages of a GRIB2 buffer, as views on it. */
export function splitGrib2(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const out = [];
  let pos = 0;
  while (pos + 16 <= b.length) {
    if (b[pos] !== 0x47 || b[pos + 1] !== 0x52 || b[pos + 2] !== 0x49 || b[pos + 3] !== 0x42) {
      pos++;
      continue;
    }
    const total = u32(b, pos + 8) * 2 ** 32 + u32(b, pos + 12);
    out.push(b.subarray(pos, pos + total));
    pos += total;
  }
  return out;
}

function decodeMessage(m, keep, need) {
  const fields = [];
  const st = { discipline: m[6] };
  let p = 16;
  while (p < m.length - 4) {
    const len = u32(m, p);
    const num = m[p + 4];
    const s = m.subarray(p, p + len);
    switch (num) {
      case 1: parseIdentification(s, st); break;
      case 3: parseGrid(s, st); break;
      case 4: parseProduct(s, st); break;
      case 5: parseRepresentation(s, st); break;
      case 6: parseBitmap(s, st); break;
      case 7: {
        const meta = metaOf(st);
        if (!keep || keep(meta)) fields.push({ meta, values: unpack(s.subarray(5), st, need ? need(meta) : Infinity) });
        break;
      }
      default: break;
    }
    p += len;
  }
  return fields;
}

function parseIdentification(s, st) {
  st.centre = u16(s, 5);
  st.refTime = new Date(Date.UTC(u16(s, 12), s[14] - 1, s[15], s[16], s[17], s[18]));
}

function earthRadius(s) {
  const shape = s[14];
  if (shape === 0) return 6367470;
  if (shape === 1) return u32(s, 16) * 10 ** -s[15];
  return 6371229;
}

function parseGrid(s, st) {
  const tpl = u16(s, 12);
  const npoints = u32(s, 6);
  const ni = u32(s, 30);
  const nj = u32(s, 34);
  if (tpl === 0) {
    const basic = u32(s, 38);
    const sub = u32(s, 42);
    const unit = basic === 0 || basic === 0xffffffff || sub === 0xffffffff ? 1e-6 : basic / sub;
    st.grid = {
      type: 'latlon',
      npoints,
      ni,
      nj,
      la1: s32(s, 46) * unit,
      lo1: s32(s, 50) * unit,
      la2: s32(s, 55) * unit,
      lo2: s32(s, 59) * unit,
      di: u32(s, 63) * unit,
      dj: u32(s, 67) * unit,
      scan: s[71],
    };
  } else if (tpl === 30) {
    st.grid = {
      type: 'lambert',
      npoints,
      ni,
      nj,
      radius: earthRadius(s),
      la1: s32(s, 38) * 1e-6,
      lo1: s32(s, 42) * 1e-6,
      gridRelative: !!(s[46] & 0x08),
      lov: s32(s, 51) * 1e-6,
      dx: u32(s, 55) * 1e-3,
      dy: u32(s, 59) * 1e-3,
      scan: s[64],
      latin1: s32(s, 65) * 1e-6,
      latin2: s32(s, 69) * 1e-6,
    };
  } else if (tpl === 32769) {
    // NCEP local: rotated lat/lon (Arakawa non-E staggered). La1/Lo1 and La2/Lo2
    // are the geographic corners; the rotated grid is centred on (lat0, lon0).
    st.grid = {
      type: 'rotll',
      npoints,
      ni,
      nj,
      la1: s32(s, 46) * 1e-6,
      lo1: s32(s, 50) * 1e-6,
      gridRelative: !!(s[54] & 0x08),
      lat0: s32(s, 55) * 1e-6,
      lon0: s32(s, 59) * 1e-6,
      scan: s[71],
      la2: s32(s, 72) * 1e-6,
      lo2: s32(s, 76) * 1e-6,
    };
  } else {
    throw new Error(`Unsupported grid template 3.${tpl}`);
  }
}

function parseProduct(s, st) {
  const tpl = u16(s, 7);
  st.productTemplate = tpl;
  st.category = s[9];
  st.number = s[10];
  // Ensemble templates carry the perturbation number (0 = control).
  st.member = tpl === 1 || tpl === 11 ? s[35] : null;
  if (tpl === 0 || tpl === 8 || tpl === 1 || tpl === 11) {
    const unit = s[17];
    const ft = s32(s, 18);
    st.forecastHours = unit === 1 ? ft : unit === 0 ? ft / 60 : unit === 2 ? ft * 24 : ft;
    st.surfaceType = s[22];
    const scale = s[23] > 127 ? -(s[23] & 0x7f) : s[23];
    const val = s32(s, 24);
    st.surfaceValue = val * 10 ** -scale;
  }
}

function parseRepresentation(s, st) {
  const tpl = u16(s, 9);
  const rep = {
    template: tpl,
    count: u32(s, 5),
    R: f32(s, 11),
    E: s16(s, 15),
    D: s16(s, 17),
    nbits: s[19],
  };
  if (tpl === 42) {
    rep.flags = s[21];
    rep.blockSize = s[22];
    rep.rsi = u16(s, 23);
  } else if (tpl === 2 || tpl === 3) {
    rep.missingMode = s[22];
    rep.groups = u32(s, 31);
    rep.widthRef = s[35];
    rep.widthBits = s[36];
    rep.lengthRef = u32(s, 37);
    rep.lengthInc = s[41];
    rep.lastLength = u32(s, 42);
    rep.lengthBits = s[46];
    if (tpl === 3) {
      rep.order = s[47];
      rep.descBytes = s[48];
    }
  } else if (tpl !== 0 && tpl !== 40) {
    throw new Error(`Unsupported data representation template 5.${tpl}`);
  }
  st.rep = rep;
}

function parseBitmap(s, st) {
  const indicator = s[5];
  if (indicator === 0) st.bitmap = s.subarray(6);
  else if (indicator === 255) st.bitmap = null;
  // 254 = reuse previous bitmap: keep st.bitmap as-is
}

function unpack(data, st, limit = Infinity) {
  const { rep, grid } = st;
  const npts = grid.npoints;
  const bscale = 2 ** rep.E;
  const dscale = 10 ** -rep.D;
  const ref = rep.R;
  const bm = st.bitmap;

  // Only the first `limit` grid points are wanted: work out how many packed
  // values that is (bitmapped points have none).
  const end = Math.min(npts, Math.max(0, Math.ceil(limit)));
  let count = rep.count;
  if (end < npts) {
    if (!bm) count = Math.min(count, end);
    else {
      let c = 0;
      for (let i = 0; i < end; i++) if (bm[i >> 3] & (0x80 >> (i & 7))) c++;
      count = Math.min(count, c);
    }
  }

  // Packed integers (NaN where the packing itself marks a value missing).
  let packed;
  if (rep.nbits === 0) packed = null;
  else if (rep.template === 42) {
    // AEC decodes in reference-sample intervals: stop at an interval boundary.
    const chunk = rep.rsi * rep.blockSize;
    packed = aecDecode(data, Math.min(rep.count, Math.ceil(count / chunk) * chunk), rep.nbits, rep.blockSize, rep.rsi, rep.flags);
  } else if (rep.template === 2 || rep.template === 3) packed = unpackComplex(data, rep, count);
  else if (rep.template === 40) {
    packed = jpxDecode(data).values;
    if (packed.length !== rep.count) throw new Error(`JPEG 2000 image has ${packed.length} values, expected ${rep.count}`);
  }
  else packed = unpackSimple(data, count, rep.nbits);

  const values = new Float32Array(npts);
  if (end < npts) values.fill(NaN, end);
  let k = 0;
  for (let i = 0; i < end; i++) {
    if (bm && !(bm[i >> 3] & (0x80 >> (i & 7)))) {
      values[i] = NaN;
      continue;
    }
    const x = packed ? packed[k++] : 0;
    values[i] = (ref + x * bscale) * dscale;
  }
  return values;
}

function unpackSimple(data, count, nbits) {
  const out = new Uint32Array(count);
  const br = new BitReader(data);
  for (let i = 0; i < count; i++) out[i] = br.read(nbits);
  return out;
}

class BitReader {
  constructor(data) {
    this.d = data;
    this.pos = 0;
  }

  read(n) {
    const d = this.d;
    let pos = this.pos;
    if (n <= 25) {
      // Fast path: one 32-bit window holds any n <= 25 bits at any bit offset.
      if (n === 0) return 0;
      const i = pos >> 3;
      const w = ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) << (pos & 7);
      this.pos = pos + n;
      return w >>> (32 - n);
    }
    let v = 0;
    while (n > 0) {
      const avail = 8 - (pos & 7);
      const take = n < avail ? n : avail;
      v = v * (1 << take) + ((d[pos >> 3] >> (avail - take)) & ((1 << take) - 1));
      pos += take;
      n -= take;
    }
    this.pos = pos;
    return v;
  }

  /** Sign-magnitude integer of n whole bytes. */
  signed(nbytes) {
    const v = this.read(nbytes * 8);
    const sign = 2 ** (nbytes * 8 - 1);
    return v >= sign ? -(v - sign) : v;
  }

  align() {
    this.pos = (this.pos + 7) & ~7;
  }
}

/** Complex packing (5.2), optionally with spatial differencing (5.3); the first n values. */
function unpackComplex(data, rep, n = rep.count) {
  const br = new BitReader(data);
  const ng = rep.groups;
  let ival1 = 0;
  let ival2 = 0;
  let minsd = 0;
  if (rep.template === 3) {
    ival1 = br.signed(rep.descBytes);
    if (rep.order === 2) ival2 = br.signed(rep.descBytes);
    minsd = br.signed(rep.descBytes);
  }

  const refs = new Float64Array(ng);
  for (let g = 0; g < ng; g++) refs[g] = br.read(rep.nbits);
  br.align();
  const widths = new Uint8Array(ng);
  for (let g = 0; g < ng; g++) widths[g] = rep.widthRef + br.read(rep.widthBits);
  br.align();
  const lengths = new Uint32Array(ng);
  for (let g = 0; g < ng; g++) lengths[g] = rep.lengthRef + br.read(rep.lengthBits) * rep.lengthInc;
  lengths[ng - 1] = rep.lastLength;
  br.align();

  const mode = rep.missingMode;
  const out = new Float64Array(n);
  const missing = mode ? new Uint8Array(n) : null;
  const refMiss1 = 2 ** rep.nbits - 1;
  const refMiss2 = 2 ** rep.nbits - 2;
  let k = 0;
  for (let g = 0; g < ng && k < n; g++) {
    const w = widths[g];
    const len = Math.min(lengths[g], n - k);
    const r = refs[g];
    if (w === 0) {
      const miss = mode === 1 ? r === refMiss1 : mode === 2 ? r === refMiss1 || r === refMiss2 : false;
      for (let i = 0; i < len; i++, k++) {
        out[k] = r;
        if (miss) missing[k] = 1;
      }
    } else {
      const m1 = 2 ** w - 1;
      const m2 = 2 ** w - 2;
      for (let i = 0; i < len; i++, k++) {
        const x = br.read(w);
        if (mode && (x === m1 || (mode === 2 && x === m2))) missing[k] = 1;
        else out[k] = r + x;
      }
    }
  }

  if (rep.template === 3) {
    // Undo spatial differencing over the non-missing values, in order.
    const order = rep.order;
    let seen = 0;
    let f1 = 0; // previous value
    let f2 = 0; // value before that
    for (let i = 0; i < n; i++) {
      if (missing && missing[i]) continue;
      let f;
      if (seen === 0) f = ival1;
      else if (seen === 1 && order === 2) f = ival2;
      else if (order === 1) f = out[i] + minsd + f1;
      else f = out[i] + minsd + 2 * f1 - f2;
      out[i] = f;
      f2 = f1;
      f1 = f;
      seen++;
    }
  }
  if (missing) for (let i = 0; i < n; i++) if (missing[i]) out[i] = NaN;
  return out;
}

function metaOf(st) {
  const g = st.grid;
  const base = {
    discipline: st.discipline,
    category: st.category,
    number: st.number,
    member: st.member,
    refTime: st.refTime,
    forecastHours: st.forecastHours,
    surfaceType: st.surfaceType,
    surfaceValue: st.surfaceValue,
    ni: g.ni,
    nj: g.nj,
  };
  if (g.scan & 0x20) throw new Error('Column-major GRIB scanning is not supported');
  if (g.type !== 'latlon') return { ...base, projection: g };
  // Describe the grid as rows from la1 stepping by dlat, columns from lo1 stepping by dlon.
  const dlat = g.scan & 0x40 ? g.dj : -g.dj;
  const dlon = g.scan & 0x80 ? -g.di : g.di;
  return { ...base, lat0: g.la1, lon0: g.lo1 > 180 ? g.lo1 - 360 : g.lo1, dlat, dlon };
}
