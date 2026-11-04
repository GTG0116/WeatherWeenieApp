// bzip2 decompressor. NEXRAD uses bzip2 twice: Level III digital products
// compress their symbology block with it, and Level II volume files are a
// series of bzip2-compressed records. Follows the reference implementation
// (bzip2 1.0.x decompress.c): Huffman → MTF/RUNA-RUNB → inverse BWT → RLE1.
// Block CRCs aren't checked; randomised blocks (obsolete since 0.9.5) aren't supported.

const MAGIC_BLOCK = [0x314159, 0x265359];
const MAGIC_END = [0x177245, 0x385090];
const MAX_CODE_LEN = 20;

/**
 * Decompress one or more concatenated bzip2 streams.
 * @param {Uint8Array} src
 * @param {number} [sizeHint] expected output size, if known
 * @returns {Uint8Array}
 */
export function bunzip2(src, sizeHint = 0) {
  let p = 0;
  let buf = 0;
  let cnt = 0;
  const bits = (n) => {
    while (cnt < n) {
      if (p >= src.length) throw new Error('bzip2: unexpected end of data');
      buf = ((buf << 8) | src[p++]) >>> 0;
      cnt += 8;
    }
    cnt -= n;
    return (buf >>> cnt) & ((1 << n) - 1);
  };

  let out = new Uint8Array(sizeHint || Math.max(4096, src.length * 6));
  let o = 0;
  const grow = (need) => {
    if (o + need <= out.length) return;
    let size = out.length * 2;
    while (size < o + need) size *= 2;
    const next = new Uint8Array(size);
    next.set(out.subarray(0, o));
    out = next;
  };

  let tt = null;
  while (p + 4 <= src.length && src[p] === 0x42 && src[p + 1] === 0x5a && src[p + 2] === 0x68) {
    p += 3;
    cnt = 0;
    const level = src[p++] - 0x30;
    if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
    const blockMax = level * 100000;
    if (!tt || tt.length < blockMax) tt = new Uint32Array(blockMax);

    for (;;) {
      const m1 = bits(24);
      const m2 = bits(24);
      bits(16);
      bits(16); // block / stream CRC
      if (m1 === MAGIC_END[0] && m2 === MAGIC_END[1]) break;
      if (m1 !== MAGIC_BLOCK[0] || m2 !== MAGIC_BLOCK[1]) throw new Error('bzip2: bad block header');
      if (bits(1)) throw new Error('bzip2: randomised blocks are not supported');
      const origPtr = bits(24);

      // Which byte values occur in the block.
      const seqToUnseq = new Uint8Array(256);
      let nInUse = 0;
      const used = bits(16);
      for (let i = 0; i < 16; i++) {
        if (!(used & (0x8000 >> i))) continue;
        const b = bits(16);
        for (let j = 0; j < 16; j++) if (b & (0x8000 >> j)) seqToUnseq[nInUse++] = i * 16 + j;
      }
      if (!nInUse) throw new Error('bzip2: empty symbol map');
      const alphaSize = nInUse + 2;

      // Huffman table selectors, MTF-coded.
      const nGroups = bits(3);
      const nSelectors = bits(15);
      if (nGroups < 2 || nGroups > 6 || !nSelectors) throw new Error('bzip2: bad Huffman group header');
      const mtfGroups = Uint8Array.of(0, 1, 2, 3, 4, 5);
      const selectors = new Uint8Array(nSelectors);
      for (let i = 0; i < nSelectors; i++) {
        let j = 0;
        while (bits(1)) if (++j >= nGroups) throw new Error('bzip2: bad selector');
        const v = mtfGroups[j];
        for (; j > 0; j--) mtfGroups[j] = mtfGroups[j - 1];
        mtfGroups[0] = v;
        selectors[i] = v;
      }

      // Code lengths (delta coded) → canonical decode tables.
      const groups = [];
      for (let g = 0; g < nGroups; g++) {
        const len = new Uint8Array(alphaSize);
        let c = bits(5);
        for (let s = 0; s < alphaSize; s++) {
          for (;;) {
            if (c < 1 || c > MAX_CODE_LEN) throw new Error('bzip2: bad code length');
            if (!bits(1)) break;
            c += bits(1) ? -1 : 1;
          }
          len[s] = c;
        }
        let minLen = MAX_CODE_LEN;
        let maxLen = 0;
        for (let s = 0; s < alphaSize; s++) {
          if (len[s] < minLen) minLen = len[s];
          if (len[s] > maxLen) maxLen = len[s];
        }
        const perm = new Uint16Array(alphaSize);
        const limit = new Int32Array(MAX_CODE_LEN + 2);
        const firstCode = new Int32Array(MAX_CODE_LEN + 2);
        const firstIdx = new Int32Array(MAX_CODE_LEN + 2);
        let idx = 0;
        let code = 0;
        for (let l = minLen; l <= maxLen; l++) {
          firstCode[l] = code;
          firstIdx[l] = idx;
          for (let s = 0; s < alphaSize; s++) if (len[s] === l) perm[idx++] = s;
          code += idx - firstIdx[l];
          limit[l] = code - 1;
          code <<= 1;
        }
        groups.push({ minLen, maxLen, perm, limit, firstCode, firstIdx });
      }

      // Symbols → MTF → block bytes, with RUNA/RUNB run lengths.
      const mtf = new Uint8Array(256);
      for (let i = 0; i < 256; i++) mtf[i] = i;
      const counts = new Int32Array(256);
      const EOB = nInUse + 1;
      let n = 0;
      let sel = 0;
      let left = 0;
      let grp = null;
      let run = 0;
      let runBit = 1;
      for (;;) {
        if (left === 0) {
          if (sel >= nSelectors) throw new Error('bzip2: ran out of selectors');
          grp = groups[selectors[sel++]];
          left = 50;
        }
        left--;
        let l = grp.minLen;
        let v = bits(l);
        while (v > grp.limit[l]) {
          if (++l > grp.maxLen) throw new Error('bzip2: bad Huffman code');
          v = (v << 1) | bits(1);
        }
        const sym = grp.perm[grp.firstIdx[l] + v - grp.firstCode[l]];
        if (sym <= 1) {
          run += runBit << sym;
          runBit <<= 1;
          if (run > blockMax) throw new Error('bzip2: run too long');
          continue;
        }
        if (run) {
          const b = seqToUnseq[mtf[0]];
          if (n + run > blockMax) throw new Error('bzip2: block overflow');
          counts[b] += run;
          tt.fill(b, n, n + run);
          n += run;
          run = 0;
          runBit = 1;
        }
        if (sym === EOB) break;
        const k = sym - 1;
        const m = mtf[k];
        mtf.copyWithin(1, 0, k);
        mtf[0] = m;
        const b = seqToUnseq[m];
        if (n >= blockMax) throw new Error('bzip2: block overflow');
        counts[b]++;
        tt[n++] = b;
      }
      if (origPtr >= n) throw new Error('bzip2: bad origin pointer');

      // Inverse BWT: link each position to its successor.
      const cf = new Int32Array(256);
      for (let i = 0, sum = 0; i < 256; i++) {
        cf[i] = sum;
        sum += counts[i];
      }
      for (let i = 0; i < n; i++) tt[cf[tt[i] & 0xff]++] |= i << 8;

      // Walk the links, undoing the initial run-length step (4 equal bytes + count).
      grow(n + (n >> 2) + 256);
      let pos = tt[origPtr] >>> 8;
      let last = -1;
      let rep = 0;
      for (let i = 0; i < n; i++) {
        const e = tt[pos];
        const b = e & 0xff;
        pos = e >>> 8;
        if (rep === 4) {
          grow(b + n - i);
          out.fill(last, o, o + b);
          o += b;
          rep = 0;
          last = -1;
          continue;
        }
        if (b === last) rep++;
        else {
          last = b;
          rep = 1;
        }
        if (o >= out.length) grow(n - i + 256);
        out[o++] = b;
      }
    }
    // Streams end on a byte boundary; another may follow.
    cnt = 0;
  }
  return out.subarray(0, o);
}
