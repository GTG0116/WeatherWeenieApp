// CCSDS 121.0-B Adaptive Entropy Coding (AEC / "Rice") decoder.
// Equivalent to libaec's decoder for the options used by GRIB2 template 5.42.
// Decodes straight to integer samples (no intermediate byte packing).

export const AEC_DATA_SIGNED = 1;
export const AEC_DATA_3BYTE = 2;
export const AEC_DATA_MSB = 4;
export const AEC_DATA_PREPROCESS = 8;
export const AEC_RESTRICTED = 16;
export const AEC_PAD_RSI = 32;

const ROS = 5; // "remainder of segment" code in zero-block runs

/**
 * @param {Uint8Array} input   encoded bitstream
 * @param {number} count       number of samples to produce
 * @param {number} bps         bits per sample (1..32)
 * @param {number} blockSize   samples per block (8, 16, 32 or 64)
 * @param {number} rsi         blocks per reference sample interval
 * @param {number} flags       AEC_* flags
 * @returns {Float64Array|Int32Array|Uint32Array} decoded samples
 */
export function aecDecode(input, count, bps, blockSize, rsi, flags) {
  // Pad so 4-byte look-ahead reads never fall off the end.
  const b = new Uint8Array(input.length + 8);
  b.set(input);
  let p = 0; // bit position
  const totalBits = input.length * 8;

  const read = (n) => {
    if (n === 0) return 0;
    if (n > 24) {
      const hi = read(n - 16);
      return hi * 65536 + read(16);
    }
    const i = p >>> 3;
    const w = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) << (p & 7);
    p += n;
    return w >>> (32 - n);
  };

  const readFS = () => {
    let zeros = 0;
    for (;;) {
      const i = p >>> 3;
      const s = p & 7;
      const w = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) << s;
      if (w !== 0) {
        const z = Math.clz32(w);
        p += z + 1;
        return zeros + z;
      }
      zeros += 32 - s;
      p += 32 - s;
      if (p > totalBits + 64) throw new Error('AEC: ran past end of stream');
    }
  };

  const signed = (flags & AEC_DATA_SIGNED) !== 0;
  const preprocess = (flags & AEC_DATA_PREPROCESS) !== 0;
  const padRsi = (flags & AEC_PAD_RSI) !== 0;

  let idLen;
  if (bps > 16) idLen = 5;
  else if (bps > 8) idLen = 4;
  else if ((flags & AEC_RESTRICTED) && bps <= 4) idLen = bps <= 2 ? 1 : 2;
  else idLen = 3;
  const idMax = (1 << idLen) - 1;

  // Mapped residuals and raw samples are stored here first, then postprocessed.
  const out = bps > 31 || signed ? new Float64Array(count) : new Uint32Array(count);
  const rsiSamples = rsi * blockSize;
  let o = 0;

  const xmax = signed ? 2 ** (bps - 1) - 1 : 2 ** bps - 1;
  const xmin = signed ? -(2 ** (bps - 1)) : 0;
  const signExtend = (v) => (signed && v >= 2 ** (bps - 1) ? v - 2 ** bps : v);

  // seTable: for m, the pair-sum s with s(s+1)/2 <= m < (s+1)(s+2)/2
  const seSum = new Int32Array(92);
  const seBase = new Int32Array(92);
  {
    let k = 0;
    for (let s = 0; k < 92; s++) {
      for (let j = 0; j <= s && k < 92; j++, k++) {
        seSum[k] = s;
        seBase[k] = (s * (s + 1)) / 2;
      }
    }
  }

  while (o < count) {
    const rsiStart = o;
    const rsiEnd = Math.min(count, rsiStart + rsiSamples);
    let blockInRsi = 0;
    // `last` is the predictor state across the RSI
    let last = 0;

    while (o < rsiEnd) {
      const ref = preprocess && blockInRsi === 0 ? 1 : 0;
      const blockStart = o;
      const blockEnd = Math.min(rsiEnd, blockStart + blockSize);
      const id = read(idLen);

      // Collect residuals for this block (or run of zero blocks) into `out`,
      // marking where raw reference samples sit.
      let blocksConsumed = 1;
      let refValue = 0;

      if (id === 0) {
        const lowSel = read(1);
        if (ref) refValue = signExtend(read(bps));
        if (lowSel === 0) {
          // Zero block run
          let zeroBlocks = readFS() + 1;
          if (zeroBlocks === ROS) {
            zeroBlocks = Math.min(rsi - blockInRsi, 64 - (blockInRsi % 64));
          } else if (zeroBlocks > ROS) {
            zeroBlocks--;
          }
          blocksConsumed = zeroBlocks;
          const end = Math.min(rsiEnd, blockStart + zeroBlocks * blockSize);
          let i = blockStart;
          if (ref) out[i++] = 0;
          for (; i < end; i++) out[i] = 0;
          o = end;
        } else {
          // Second extension
          let i = ref;
          let k = blockStart + ref;
          const end = blockStart + blockSize;
          if (ref) out[blockStart] = 0;
          while (i < blockSize) {
            const m = readFS();
            if (m >= 92) throw new Error('AEC: bad second-extension code');
            const d1 = m - seBase[m];
            if ((i & 1) === 0) {
              if (k < blockEnd) out[k] = seSum[m] - d1;
              k++;
              i++;
            }
            if (k < blockEnd) out[k] = d1;
            k++;
            i++;
          }
          o = Math.min(end, blockEnd);
        }
      } else if (id === idMax) {
        // Uncompressed block: raw samples (the reference sample is the first one)
        for (let i = 0; i < blockSize; i++) {
          const v = read(bps);
          if (blockStart + i < blockEnd) out[blockStart + i] = i === 0 && ref ? 0 : v;
          if (i === 0 && ref) refValue = signExtend(v);
        }
        o = blockEnd;
      } else {
        // Split-sample option with k low bits
        const kBits = id - 1;
        if (ref) refValue = signExtend(read(bps));
        const n = blockSize - ref;
        const base = blockStart + ref;
        if (ref) out[blockStart] = 0;
        // Fundamental sequences first...
        for (let i = 0; i < n; i++) {
          const fs = readFS();
          if (base + i < blockEnd) out[base + i] = fs * 2 ** kBits;
        }
        // ...then the k-bit remainders.
        if (kBits > 0) {
          for (let i = 0; i < n; i++) {
            const lo = read(kBits);
            if (base + i < blockEnd) out[base + i] += lo;
          }
        }
        o = blockEnd;
      }

      // Postprocess this block/run in place.
      if (preprocess) {
        let i = blockStart;
        if (ref) {
          out[i++] = refValue;
          last = refValue;
        }
        for (; i < o; i++) {
          const d = out[i];
          const theta = Math.min(last - xmin, xmax - last);
          let x;
          if (d <= 2 * theta) {
            x = d % 2 === 0 ? last + d / 2 : last - (d + 1) / 2;
          } else if (theta === last - xmin) {
            x = last + (d - theta);
          } else {
            x = last - (d - theta);
          }
          out[i] = x;
          last = x;
        }
      } else if (signed) {
        for (let i = blockStart; i < o; i++) out[i] = signExtend(out[i]);
      }

      blockInRsi += blocksConsumed;
    }

    if (padRsi) p = (p + 7) & ~7;
  }
  return out;
}
