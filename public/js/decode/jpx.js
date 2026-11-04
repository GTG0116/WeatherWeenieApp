// JPEG 2000 (ITU-T T.800) codestream decoder for GRIB2 template 5.40.
// Covers what GRIB producers emit: one component, reversible 5/3 wavelet, no
// quantization, default code-block style and precincts, any progression order,
// any number of layers and tiles. Anything else is rejected with a clear error.
// Returns the decoded integer samples (DC level shift applied) in raster order.

// MQ arithmetic decoder probability table (Annex C, table C.2): Qe, NMPS, NLPS, SWITCH
const QE = [
  [0x5601, 1, 1, 1], [0x3401, 2, 6, 0], [0x1801, 3, 9, 0], [0x0ac1, 4, 12, 0], [0x0521, 5, 29, 0], [0x0221, 38, 33, 0],
  [0x5601, 7, 6, 1], [0x5401, 8, 14, 0], [0x4801, 9, 14, 0], [0x3801, 10, 14, 0], [0x3001, 11, 17, 0], [0x2401, 12, 18, 0],
  [0x1c01, 13, 20, 0], [0x1601, 29, 21, 0], [0x5601, 15, 14, 1], [0x5401, 16, 14, 0], [0x5101, 17, 15, 0], [0x4801, 18, 16, 0],
  [0x3801, 19, 17, 0], [0x3401, 20, 18, 0], [0x3001, 21, 19, 0], [0x2801, 22, 19, 0], [0x2401, 23, 20, 0], [0x2201, 24, 21, 0],
  [0x1c01, 25, 22, 0], [0x1801, 26, 23, 0], [0x1601, 27, 24, 0], [0x1401, 28, 25, 0], [0x1201, 29, 26, 0], [0x1101, 30, 27, 0],
  [0x0ac1, 31, 28, 0], [0x09c1, 32, 29, 0], [0x08a1, 33, 30, 0], [0x0521, 34, 31, 0], [0x0441, 35, 32, 0], [0x02a1, 36, 33, 0],
  [0x0221, 37, 34, 0], [0x0141, 38, 35, 0], [0x0111, 39, 36, 0], [0x0085, 40, 37, 0], [0x0049, 41, 38, 0], [0x0025, 42, 39, 0],
  [0x0015, 43, 40, 0], [0x0009, 44, 41, 0], [0x0005, 45, 42, 0], [0x0001, 45, 43, 0], [0x5601, 46, 46, 0],
];

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

// ---------------------------------------------------------------- MQ decoder
class MQDecoder {
  constructor(data) {
    // Two 0xFF bytes mark the end, as the decoder expects past the last segment.
    this.d = new Uint8Array(data.length + 2);
    this.d.set(data);
    this.d[data.length] = 0xff;
    this.d[data.length + 1] = 0xff;
    this.end = data.length;
    this.bp = 0;
    this.c = (this.d[0] << 16) >>> 0;
    this.byteIn();
    this.c = (this.c << 7) >>> 0;
    this.ct -= 7;
    this.a = 0x8000;
    this.state = new Uint8Array(19);
    this.mps = new Uint8Array(19);
    this.state[0] = 4; // all-zero neighbourhood
    this.state[17] = 3; // run-length
    this.state[18] = 46; // uniform
  }

  byteIn() {
    const d = this.d;
    if (d[this.bp] === 0xff) {
      if (this.bp >= this.end || d[this.bp + 1] > 0x8f) {
        this.c = (this.c + 0xff00) >>> 0;
        this.ct = 8;
      } else {
        this.bp++;
        this.c = (this.c + (d[this.bp] << 9)) >>> 0;
        this.ct = 7;
      }
    } else {
      this.bp++;
      this.c = (this.c + ((this.bp < this.end + 2 ? d[this.bp] : 0xff) << 8)) >>> 0;
      this.ct = 8;
    }
  }

  decode(cx) {
    const s = this.state[cx];
    const qe = QE[s][0];
    let bit;
    this.a -= qe;
    if (this.c >>> 16 < qe) {
      // LPS exchange
      if (this.a < qe) {
        bit = this.mps[cx];
        this.state[cx] = QE[s][1];
      } else {
        bit = 1 - this.mps[cx];
        if (QE[s][3]) this.mps[cx] = bit;
        this.state[cx] = QE[s][2];
      }
      this.a = qe;
    } else {
      this.c = (this.c - qe * 65536) >>> 0;
      if (this.a & 0x8000) return this.mps[cx];
      // MPS exchange
      if (this.a < qe) {
        bit = 1 - this.mps[cx];
        if (QE[s][3]) this.mps[cx] = bit;
        this.state[cx] = QE[s][2];
      } else {
        bit = this.mps[cx];
        this.state[cx] = QE[s][1];
      }
    }
    do {
      if (this.ct === 0) this.byteIn();
      this.a <<= 1;
      this.c = (this.c << 1) >>> 0;
      this.ct--;
    } while (!(this.a & 0x8000));
    return bit;
  }
}

// ---------------------------------------------------------------- packet headers
class HeaderReader {
  constructor(data, pos) {
    this.d = data;
    this.pos = pos;
    this.buf = 0;
    this.left = 0;
    this.prevFF = false;
  }

  bit() {
    if (this.left === 0) {
      const byte = this.d[this.pos++];
      // After 0xFF the next byte carries a stuffed zero in its top bit.
      this.left = this.prevFF ? 7 : 8;
      this.buf = this.prevFF ? byte & 0x7f : byte;
      this.prevFF = byte === 0xff;
    }
    this.left--;
    return (this.buf >> this.left) & 1;
  }

  bits(n) {
    let v = 0;
    while (n-- > 0) v = (v << 1) | this.bit();
    return v;
  }

  align() {
    this.left = 0;
    if (this.prevFF) {
      this.pos++;
      this.prevFF = false;
    }
  }
}

class TagTree {
  constructor(w, h) {
    this.levels = [];
    for (;;) {
      this.levels.push({ w, low: new Int32Array(w * h), known: new Uint8Array(w * h) });
      if (w === 1 && h === 1) break;
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
  }

  /** Whether the leaf's value is below `threshold`, reading bits as needed (Infinity: read it fully). */
  below(x, y, threshold, rd) {
    let low = 0;
    for (let k = this.levels.length - 1; k >= 0; k--) {
      const L = this.levels[k];
      const i = (y >> k) * L.w + (x >> k);
      if (L.low[i] < low) L.low[i] = low;
      while (!L.known[i] && L.low[i] < threshold) {
        if (rd.bit()) L.known[i] = 1;
        else L.low[i]++;
      }
      low = L.low[i];
      if (!L.known[i]) return false;
    }
    return true;
  }

  value(x, y) {
    return this.levels[0].low[y * this.levels[0].w + x];
  }
}

// ---------------------------------------------------------------- tier-1 (EBCOT)
const LL = 0;
const HL = 1;
const LH = 2;
const HH = 3;

// Zero-coding context (0..8) from neighbour counts, per orientation (table D.1)
function zcTable(orient) {
  const t = new Uint8Array(3 * 3 * 5);
  for (let h = 0; h <= 2; h++) {
    for (let v = 0; v <= 2; v++) {
      for (let d = 0; d <= 4; d++) {
        let c;
        if (orient === HH) {
          const hv = h + v;
          if (d >= 3) c = 8;
          else if (d === 2) c = hv >= 1 ? 7 : 6;
          else if (d === 1) c = hv >= 2 ? 5 : hv === 1 ? 4 : 3;
          else c = hv >= 2 ? 2 : hv === 1 ? 1 : 0;
        } else {
          const [a, b] = orient === HL ? [v, h] : [h, v];
          if (a === 2) c = 8;
          else if (a === 1) c = b >= 1 ? 7 : d >= 1 ? 6 : 5;
          else if (b === 2) c = 4;
          else if (b === 1) c = 3;
          else c = d >= 2 ? 2 : d === 1 ? 1 : 0;
        }
        t[(h * 3 + v) * 5 + d] = c;
      }
    }
  }
  return t;
}
const ZC = [zcTable(LL), zcTable(HL), zcTable(LH), zcTable(HH)];

/**
 * Decode one code-block's coding passes into signed integer coefficients.
 * @returns {Int32Array} w*h coefficients
 */
function decodeBlock(data, w, h, orient, mb, zeroPlanes, passes) {
  const out = new Int32Array(w * h);
  if (!passes || !data.length) return out;
  const W = w + 2;
  const sig = new Uint8Array(W * (h + 2));
  const neg = new Uint8Array(W * (h + 2));
  const coded = new Uint8Array(w * h); // visited in this bit-plane's significance pass
  const refined = new Uint8Array(w * h);
  const zc = ZC[orient];
  const mq = new MQDecoder(data);

  const ctxOf = (p) => {
    const hh = sig[p - 1] + sig[p + 1];
    const vv = sig[p - W] + sig[p + W];
    const dd = sig[p - W - 1] + sig[p - W + 1] + sig[p + W - 1] + sig[p + W + 1];
    return zc[(hh * 3 + vv) * 5 + dd];
  };
  const contrib = (p) => (sig[p] ? (neg[p] ? -1 : 1) : 0);
  const decodeSign = (p) => {
    const H = Math.max(-1, Math.min(1, contrib(p - 1) + contrib(p + 1)));
    const V = Math.max(-1, Math.min(1, contrib(p - W) + contrib(p + W)));
    let cx;
    let xor = 0;
    if (H === 0) {
      cx = V === 0 ? 9 : 10;
      xor = V < 0 ? 1 : 0;
    } else {
      cx = 12 + H * V; // H·V = 1 → 13, 0 → 12, -1 → 11
      xor = H < 0 ? 1 : 0;
    }
    return mq.decode(cx) ^ xor;
  };
  const setSig = (x, y, p, bp) => {
    sig[p] = 1;
    neg[p] = decodeSign(p);
    out[y * w + x] = 1 << bp;
  };

  let bp = mb - 1 - zeroPlanes;
  let pass = 2; // the first pass is a cleanup pass
  for (let n = 0; n < passes && bp >= 0; n++) {
    if (pass === 0) {
      // significance propagation
      for (let y0 = 0; y0 < h; y0 += 4) {
        for (let x = 0; x < w; x++) {
          for (let y = y0; y < y0 + 4 && y < h; y++) {
            const p = (y + 1) * W + x + 1;
            if (sig[p]) continue;
            const cx = ctxOf(p);
            if (!cx) continue;
            coded[y * w + x] = 1;
            if (mq.decode(cx)) setSig(x, y, p, bp);
          }
        }
      }
    } else if (pass === 1) {
      // magnitude refinement
      for (let y0 = 0; y0 < h; y0 += 4) {
        for (let x = 0; x < w; x++) {
          for (let y = y0; y < y0 + 4 && y < h; y++) {
            const p = (y + 1) * W + x + 1;
            const i = y * w + x;
            if (!sig[p] || coded[i]) continue;
            let cx = 16;
            if (!refined[i]) {
              const any = sig[p - 1] | sig[p + 1] | sig[p - W] | sig[p + W] | sig[p - W - 1] | sig[p - W + 1] | sig[p + W - 1] | sig[p + W + 1];
              cx = any ? 15 : 14;
              refined[i] = 1;
            }
            if (mq.decode(cx)) out[i] |= 1 << bp;
          }
        }
      }
    } else {
      // cleanup
      for (let y0 = 0; y0 < h; y0 += 4) {
        for (let x = 0; x < w; x++) {
          let y = y0;
          if (y0 + 4 <= h) {
            // Run-length mode when the whole column is insignificant with no significant neighbours.
            let run = true;
            for (let k = 0; k < 4 && run; k++) {
              const p = (y0 + k + 1) * W + x + 1;
              if (sig[p] || coded[(y0 + k) * w + x] || ctxOf(p)) run = false;
            }
            if (run) {
              if (!mq.decode(17)) continue;
              const r = (mq.decode(18) << 1) | mq.decode(18);
              y = y0 + r;
              setSig(x, y, (y + 1) * W + x + 1, bp);
              y++;
            }
          }
          for (; y < y0 + 4 && y < h; y++) {
            const p = (y + 1) * W + x + 1;
            const i = y * w + x;
            if (sig[p] || coded[i]) continue;
            if (mq.decode(ctxOf(p))) setSig(x, y, p, bp);
          }
        }
      }
      coded.fill(0);
      bp--;
    }
    pass = (pass + 1) % 3;
  }
  // Midpoint reconstruction when the last bit-planes were truncated.
  const half = bp >= 0 ? 1 << bp : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = out[i];
      if (!v) continue;
      v |= half;
      out[i] = neg[(y + 1) * W + x + 1] ? -v : v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 5/3 inverse wavelet
/** 1-D reversible synthesis in place on line[0..n), samples starting at even index. */
function idwt53(line, n, tmp) {
  if (n === 1) return;
  // Deinterleaved input: low-pass first (ceil(n/2)), then high-pass.
  const nl = (n + 1) >> 1;
  for (let i = 0; i < n; i++) tmp[i] = i & 1 ? line[nl + (i >> 1)] : line[i >> 1];
  const at = (i) => tmp[i < 0 ? -i : i >= n ? 2 * (n - 1) - i : i];
  for (let i = 0; i < n; i += 2) tmp[i] -= Math.floor((at(i - 1) + at(i + 1) + 2) / 4);
  for (let i = 1; i < n; i += 2) tmp[i] += Math.floor((at(i - 1) + at(i + 1)) / 2);
  for (let i = 0; i < n; i++) line[i] = tmp[i];
}

// ---------------------------------------------------------------- codestream
function parseHeader(b) {
  if (u16(b, 0) !== 0xff4f) throw new Error('JPEG 2000: missing SOC marker');
  const hdr = {};
  let p = 2;
  for (;;) {
    const m = u16(b, p);
    if (m === 0xff90) break;
    const len = u16(b, p + 2);
    const s = p + 4;
    if (m === 0xff51) {
      hdr.width = u32(b, s + 2) - u32(b, s + 10);
      hdr.height = u32(b, s + 6) - u32(b, s + 14);
      if (u32(b, s + 10) || u32(b, s + 14)) throw new Error('JPEG 2000: image offsets are not supported');
      hdr.tileW = u32(b, s + 18);
      hdr.tileH = u32(b, s + 22);
      if (u32(b, s + 26) || u32(b, s + 30)) throw new Error('JPEG 2000: tile offsets are not supported');
      const comps = u16(b, s + 34);
      if (comps !== 1) throw new Error(`JPEG 2000: ${comps} components are not supported`);
      hdr.precision = (b[s + 36] & 0x7f) + 1;
      hdr.signed = !!(b[s + 36] & 0x80);
      if (b[s + 37] !== 1 || b[s + 38] !== 1) throw new Error('JPEG 2000: subsampling is not supported');
    } else if (m === 0xff52) {
      if (b[s] & 0x07) throw new Error('JPEG 2000: precincts and SOP/EPH markers are not supported');
      hdr.progression = b[s + 1];
      hdr.layers = u16(b, s + 2);
      hdr.levels = b[s + 5];
      hdr.cbw = b[s + 6] + 2;
      hdr.cbh = b[s + 7] + 2;
      if (b[s + 8]) throw new Error(`JPEG 2000: code-block style ${b[s + 8]} is not supported`);
      if (b[s + 9] !== 1) throw new Error('JPEG 2000: only the reversible 5/3 wavelet is supported');
    } else if (m === 0xff5c) {
      if ((b[s] & 0x1f) !== 0) throw new Error('JPEG 2000: quantized (lossy) streams are not supported');
      hdr.guard = b[s] >> 5;
      hdr.exponents = Array.from(b.subarray(s + 1, p + 2 + len), (x) => x >> 3);
    } else if (m === 0xff53 || m === 0xff5d || m === 0xff5f) {
      throw new Error(`JPEG 2000: marker ${m.toString(16)} is not supported`);
    }
    p += 2 + len;
  }
  hdr.dataStart = p;
  return hdr;
}

/** Concatenate every tile-part's data per tile. */
function tileData(b, start) {
  const tiles = new Map();
  let p = start;
  while (p + 12 <= b.length && u16(b, p) === 0xff90) {
    const tile = u16(b, p + 4);
    let psot = u32(b, p + 6);
    if (psot === 0) psot = b.length - 2 - p;
    let q = p + 2 + u16(b, p + 2);
    while (u16(b, q) !== 0xff93) {
      const m = u16(b, q);
      if (m === 0xff52 || m === 0xff5c || m === 0xff53 || m === 0xff5d || m === 0xff5f) {
        throw new Error('JPEG 2000: tile-specific coding parameters are not supported');
      }
      q += 2 + u16(b, q + 2);
    }
    q += 2;
    if (!tiles.has(tile)) tiles.set(tile, []);
    tiles.get(tile).push(b.subarray(q, p + psot));
    p += psot;
  }
  for (const [k, parts] of tiles) {
    const len = parts.reduce((n, x) => n + x.length, 0);
    const all = new Uint8Array(len);
    let o = 0;
    for (const x of parts) {
      all.set(x, o);
      o += x.length;
    }
    tiles.set(k, all);
  }
  return tiles;
}

function decodeTile(data, hdr, x0, y0, x1, y1) {
  const NL = hdr.levels;
  // Resolution geometry and subbands (B.5, B.6)
  const res = [];
  for (let r = 0; r <= NL; r++) {
    const s = 2 ** (NL - r);
    const rx0 = Math.ceil(x0 / s);
    const ry0 = Math.ceil(y0 / s);
    const rx1 = Math.ceil(x1 / s);
    const ry1 = Math.ceil(y1 / s);
    const bands = [];
    const orients = r === 0 ? [LL] : [HL, LH, HH];
    orients.forEach((orient, k) => {
      const nb = r === 0 ? NL : NL - r + 1;
      const ox = orient === HL || orient === HH ? 1 : 0;
      const oy = orient === LH || orient === HH ? 1 : 0;
      const d = 2 ** nb;
      const bx0 = Math.ceil((x0 - ox * 2 ** (nb - 1)) / d);
      const by0 = Math.ceil((y0 - oy * 2 ** (nb - 1)) / d);
      const bx1 = Math.ceil((x1 - ox * 2 ** (nb - 1)) / d);
      const by1 = Math.ceil((y1 - oy * 2 ** (nb - 1)) / d);
      const eps = hdr.exponents[r === 0 ? 0 : 1 + 3 * (r - 1) + k];
      // Default precincts (2^15) leave the code-block size unchanged.
      const cw = 2 ** hdr.cbw;
      const ch = 2 ** hdr.cbh;
      const ncx = bx1 > bx0 ? Math.ceil(bx1 / cw) - Math.floor(bx0 / cw) : 0;
      const ncy = by1 > by0 ? Math.ceil(by1 / ch) - Math.floor(by0 / ch) : 0;
      const blocks = [];
      for (let j = 0; j < ncy; j++) {
        for (let i = 0; i < ncx; i++) {
          const cx0 = Math.max(bx0, (Math.floor(bx0 / cw) + i) * cw);
          const cy0 = Math.max(by0, (Math.floor(by0 / ch) + j) * ch);
          const cx1 = Math.min(bx1, (Math.floor(bx0 / cw) + i + 1) * cw);
          const cy1 = Math.min(by1, (Math.floor(by0 / ch) + j + 1) * ch);
          blocks.push({ i, j, x0: cx0 - bx0, y0: cy0 - by0, w: cx1 - cx0, h: cy1 - cy0, lblock: 3, included: false, zero: 0, passes: 0, chunks: [] });
        }
      }
      bands.push({
        orient, x0: bx0, y0: by0, w: bx1 - bx0, h: by1 - by0, mb: hdr.guard + eps - 1, ncx, ncy, blocks,
        incl: ncx && ncy ? new TagTree(ncx, ncy) : null,
        zbp: ncx && ncy ? new TagTree(ncx, ncy) : null,
      });
    });
    res.push({ x0: rx0, y0: ry0, w: rx1 - rx0, h: ry1 - ry0, bands });
  }

  // Tier-2: one precinct per resolution, so the progression orders reduce to
  // layer-major (LRCP) or resolution-major (everything else).
  const order = [];
  if (hdr.progression === 0) {
    for (let l = 0; l < hdr.layers; l++) for (let r = 0; r <= NL; r++) order.push([l, r]);
  } else {
    for (let r = 0; r <= NL; r++) for (let l = 0; l < hdr.layers; l++) order.push([l, r]);
  }
  const rd = new HeaderReader(data, 0);
  for (const [layer, r] of order) {
    if (rd.pos >= data.length) break;
    const bands = res[r].bands;
    const got = [];
    if (rd.bit()) {
      for (const band of bands) {
        for (const cb of band.blocks) {
          let inc;
          if (!cb.included) {
            inc = band.incl.below(cb.i, cb.j, layer + 1, rd);
            if (inc) {
              band.zbp.below(cb.i, cb.j, Infinity, rd);
              cb.zero = band.zbp.value(cb.i, cb.j);
              cb.included = true;
            }
          } else {
            inc = rd.bit();
          }
          if (!inc) continue;
          let n = 1;
          if (rd.bit()) {
            n = 2;
            if (rd.bit()) {
              n = 3 + rd.bits(2);
              if (n === 6) {
                n += rd.bits(5);
                if (n === 37) n += rd.bits(7);
              }
            }
          }
          while (rd.bit()) cb.lblock++;
          const len = rd.bits(cb.lblock + Math.floor(Math.log2(n)));
          cb.passes += n;
          got.push([cb, len]);
        }
      }
    }
    rd.align();
    for (const [cb, len] of got) {
      cb.chunks.push(data.subarray(rd.pos, rd.pos + len));
      rd.pos += len;
    }
  }

  // Tier-1 into subband coefficient arrays, then the inverse wavelet.
  let img = null;
  for (let r = 0; r <= NL; r++) {
    const R = res[r];
    const coeffs = R.bands.map((band) => {
      const c = new Int32Array(band.w * band.h);
      for (const cb of band.blocks) {
        if (!cb.passes) continue;
        const len = cb.chunks.reduce((n, x) => n + x.length, 0);
        const buf = new Uint8Array(len);
        let o = 0;
        for (const x of cb.chunks) {
          buf.set(x, o);
          o += x.length;
        }
        const v = decodeBlock(buf, cb.w, cb.h, band.orient, band.mb, cb.zero, cb.passes);
        for (let y = 0; y < cb.h; y++) c.set(v.subarray(y * cb.w, (y + 1) * cb.w), (cb.y0 + y) * band.w + cb.x0);
      }
      return c;
    });
    if (r === 0) {
      img = Float64Array.from(coeffs[0]);
      continue;
    }
    if (R.x0 & 1 || R.y0 & 1) throw new Error('JPEG 2000: odd resolution origins are not supported');
    const { w, h } = R;
    const prev = res[r - 1];
    const [hl, lh, hh] = coeffs;
    const [bHL, bLH] = R.bands;
    const out = new Float64Array(w * h);
    // Rows: low-pass columns then high-pass columns; rows themselves stay split (low rows first).
    const nlx = prev.w;
    const nly = prev.h;
    for (let y = 0; y < h; y++) {
      const low = y < nly;
      const yy = low ? y : y - nly;
      for (let x = 0; x < nlx; x++) out[y * w + x] = low ? img[yy * nlx + x] : lh[yy * bLH.w + x];
      for (let x = nlx; x < w; x++) out[y * w + x] = low ? hl[yy * bHL.w + x - nlx] : hh[yy * bHL.w + x - nlx];
    }
    const line = new Float64Array(Math.max(w, h));
    const tmp = new Float64Array(Math.max(w, h));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) line[x] = out[y * w + x];
      idwt53(line, w, tmp);
      for (let x = 0; x < w; x++) out[y * w + x] = line[x];
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) line[y] = out[y * w + x];
      idwt53(line, h, tmp);
      for (let y = 0; y < h; y++) out[y * w + x] = line[y];
    }
    img = out;
  }
  return img;
}

/**
 * Decode a raw JPEG 2000 codestream.
 * @param {Uint8Array} b codestream (GRIB2 section 7 data)
 * @returns {{values: Float64Array, width: number, height: number}}
 */
export function jpxDecode(b) {
  const hdr = parseHeader(b);
  const { width, height } = hdr;
  const values = new Float64Array(width * height);
  const tilesX = Math.ceil(width / hdr.tileW);
  for (const [t, data] of tileData(b, hdr.dataStart)) {
    const tx0 = (t % tilesX) * hdr.tileW;
    const ty0 = Math.floor(t / tilesX) * hdr.tileH;
    const tx1 = Math.min(width, tx0 + hdr.tileW);
    const ty1 = Math.min(height, ty0 + hdr.tileH);
    if ((tx0 | ty0) & ((1 << hdr.levels) - 1)) throw new Error('JPEG 2000: unaligned tiles are not supported');
    const img = decodeTile(data, hdr, tx0, ty0, tx1, ty1);
    const tw = tx1 - tx0;
    for (let y = ty0; y < ty1; y++) for (let x = tx0; x < tx1; x++) values[y * width + x] = img[(y - ty0) * tw + x - tx0];
  }
  const shift = hdr.signed ? 0 : 2 ** (hdr.precision - 1);
  for (let i = 0; i < values.length; i++) values[i] += shift;
  return { values, width, height };
}
