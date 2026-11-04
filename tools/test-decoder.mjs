// Compares the JavaScript GRIB2/CCSDS decoder against reference arrays
// produced by ecCodes (saved as .npy files next to each .grib2 file).
// Usage: node tools/test-decoder.mjs <dir-with-name.grib2-and-name_ref.npy>
import fs from 'node:fs';
import path from 'node:path';
import { decodeGrib2 } from '../public/js/decode/grib2.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/test-decoder.mjs <dir>');
  process.exit(1);
}

function readNpy(file) {
  const buf = fs.readFileSync(file);
  const hlen = buf.readUInt16LE(8);
  const header = buf.toString('latin1', 10, 10 + hlen);
  if (!header.includes("'<f8'")) throw new Error('expected float64 npy');
  const data = buf.subarray(10 + hlen);
  return new Float64Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
}

let failed = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.grib2'))) {
  const name = path.basename(f, '.grib2');
  const refFile = path.join(dir, `${name}_ref.npy`);
  if (!fs.existsSync(refFile)) continue;
  const t0 = performance.now();
  const [field] = decodeGrib2(fs.readFileSync(path.join(dir, f)));
  const ms = performance.now() - t0;
  const ref = readNpy(refFile);
  let maxErr = 0;
  let maxRel = 0;
  for (let i = 0; i < ref.length; i++) {
    const e = Math.abs(field.values[i] - ref[i]);
    maxErr = Math.max(maxErr, e);
    maxRel = Math.max(maxRel, e / (Math.abs(ref[i]) + 1e-12));
  }
  const ok = field.values.length === ref.length && (maxErr < 1e-3 * (Math.abs(ref[0]) + 1e-6) || maxRel < 1e-5);
  if (!ok) failed++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name.padEnd(8)} n=${field.values.length} maxAbsErr=${maxErr.toExponential(2)} ` +
      `${ms.toFixed(0)}ms grid=${field.meta.ni}x${field.meta.nj} lat0=${field.meta.lat0} lon0=${field.meta.lon0}`,
  );
}
process.exit(failed ? 1 : 0);
