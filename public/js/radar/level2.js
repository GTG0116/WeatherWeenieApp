// NEXRAD Level II (Archive II, message 31) reader for a single sweep. The
// volume file is a 24-byte header followed by bzip2-compressed LDM records;
// the lowest sweeps sit in the first few records, so the file is fetched in
// ranges, only as far as the sweep that carries the wanted moment.
// Other moments of the same radials can be read alongside (e.g. ρhv with ΦDP).
import { bunzip2 } from '../decode/bzip2.js';
import { RF } from './level3.js';

const FIRST_CHUNK = 2_400_000;
const NEXT_CHUNK = 1_200_000;
const FRAME = 2432; // fixed-size frame of messages other than 31
const MS_DAY = 86400000;

/**
 * One sweep containing `moment` ('REF', 'VEL', 'SW ', 'ZDR', 'PHI', 'RHO'):
 * the lowest (tilt 0), or the tilt-th distinct elevation angle above it.
 * Repeated low cuts (SAILS / MESO-SAILS) don't count as tilts of their own.
 * @param {(from: number, to: number) => Promise<Uint8Array>} getRange fetches bytes [from, to)
 * @param {string[]} [extra] more moments to read from the same radials, returned in `extra`
 */
export async function readLevel2Sweep(getRange, moment, tilt = 0, extra = []) {
  let bytes = await getRange(0, FIRST_CHUNK);
  let complete = bytes.length < FIRST_CHUNK; // short read: that was the whole file
  const ensure = async (end) => {
    while (bytes.length < end && !complete) {
      const want = Math.max(end, bytes.length + NEXT_CHUNK) - bytes.length;
      const more = await getRange(bytes.length, bytes.length + want);
      const next = new Uint8Array(bytes.length + more.length);
      next.set(bytes);
      next.set(more, bytes.length);
      bytes = next;
      if (more.length < want) complete = true;
    }
    return bytes.length >= end;
  };
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'AR2V') throw new Error('Not a Level II volume');

  const sweep = { target: null, radials: [], site: null, done: false, tilt, angles: [], skip: new Set(), extra };
  let p = 24;
  while (!sweep.done) {
    if (!(await ensure(p + 4))) break;
    const size = Math.abs(new DataView(bytes.buffer, bytes.byteOffset + p, 4).getInt32(0));
    if (!size || !(await ensure(p + 4 + size))) break;
    const raw = bunzip2(bytes.subarray(p + 4, p + 4 + size));
    scanRecord(raw, moment, sweep);
    p += 4 + size;
  }
  if (!sweep.radials.length) throw new Error(`No ${moment.trim()} sweep ${tilt ? `at tilt ${tilt + 1} ` : ''}in this volume`);
  const out = assemble(sweep, moment, (r) => r);
  if (extra.length) {
    out.extra = {};
    for (const name of extra) out.extra[name] = assemble(sweep, name, (r) => r.extra[name], out.nGates).values;
  }
  return out;
}

/**
 * Every tilt of `moment` in a whole volume, lowest first, for 3D views. As with
 * readLevel2Sweep, repeated cuts at the same angle (SAILS, the Doppler half of a
 * split cut) are left out: the first scan at each angle is kept.
 * @param {Uint8Array} bytes the whole Archive II file
 */
export function readLevel2Volume(bytes, moment) {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'AR2V') throw new Error('Not a Level II volume');
  const cuts = new Map(); // elevation number → { radials, site }
  const vol = { site: null };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = 24; p + 4 <= bytes.length; ) {
    const size = Math.abs(dv.getInt32(p));
    if (!size || p + 4 + size > bytes.length) break;
    scanVolumeRecord(bunzip2(bytes.subarray(p + 4, p + 4 + size)), moment, cuts, vol);
    p += 4 + size;
  }
  const tilts = [];
  for (const elev of [...cuts.keys()].sort((a, b) => a - b)) {
    const rs = cuts.get(elev);
    if (rs.length < 100) continue; // a cut cut short by the end of the file
    const out = assemble({ radials: rs, site: vol.site }, moment, (r) => r);
    if (tilts.some((t) => Math.abs(t.elevation - out.elevation) < 0.25)) continue;
    tilts.push(out);
  }
  if (!tilts.length) throw new Error(`No ${moment.trim()} in this volume`);
  return { ...(vol.site ?? {}), time: tilts[0].time, tilts: tilts.sort((a, b) => a.elevation - b.elevation) };
}

function scanVolumeRecord(raw, moment, cuts, vol) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let q = 0;
  while (q + 28 <= raw.length) {
    if (raw[q + 15] !== 31) {
      q += FRAME;
      continue;
    }
    const m = q + 28;
    q += 12 + dv.getUint16(q + 12) * 2;
    let block = null;
    for (let k = 0, n = dv.getUint16(m + 30); k < n; k++) {
      const ptr = m + dv.getUint32(m + 32 + 4 * k);
      const name = String.fromCharCode(raw[ptr], raw[ptr + 1], raw[ptr + 2], raw[ptr + 3]);
      if (name === 'RVOL' && !vol.site) {
        vol.site = { lat: dv.getFloat32(ptr + 8), lon: dv.getFloat32(ptr + 12), heightM: dv.getInt16(ptr + 16), vcp: dv.getUint16(ptr + 40) };
      } else if (name === 'D' + moment) block = ptr;
    }
    if (block === null) continue;
    const elev = raw[m + 22];
    if (!cuts.has(elev)) cuts.set(elev, []);
    cuts.get(elev).push({
      az: dv.getFloat32(m + 12),
      width: raw[m + 20] === 1 ? 0.5 : 1,
      elevation: dv.getFloat32(m + 24),
      time: (dv.getUint16(m + 8) - 1) * MS_DAY + dv.getUint32(m + 4),
      ...readMoment(raw, dv, block),
    });
  }
}

/** Walk the messages of one decompressed record, collecting radials of the target sweep. */
function scanRecord(raw, moment, sweep) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let q = 0;
  while (q + 28 <= raw.length && !sweep.done) {
    const type = raw[q + 15];
    if (type !== 31) {
      q += FRAME;
      continue;
    }
    const msgBytes = dv.getUint16(q + 12) * 2;
    const m = q + 28; // message 31 header, after the 12-byte CTM and 16-byte message header
    q += 12 + msgBytes;
    const elev = raw[m + 22];
    if (sweep.skip.has(elev)) continue;
    if (sweep.target !== null && elev !== sweep.target) {
      if (sweep.radials.length) sweep.done = true;
      continue;
    }
    const nBlocks = dv.getUint16(m + 30);
    let block = null;
    const blocks = {};
    for (let k = 0; k < nBlocks; k++) {
      const ptr = m + dv.getUint32(m + 32 + 4 * k);
      const name = String.fromCharCode(raw[ptr], raw[ptr + 1], raw[ptr + 2], raw[ptr + 3]);
      if (name === 'RVOL' && !sweep.site) {
        sweep.site = { lat: dv.getFloat32(ptr + 8), lon: dv.getFloat32(ptr + 12), heightM: dv.getInt16(ptr + 16), vcp: dv.getUint16(ptr + 40) };
      } else if (name === 'D' + moment) block = ptr;
      else if (name[0] === 'D') blocks[name.slice(1)] = ptr;
    }
    if (block === null) continue;
    if (sweep.target === null) {
      // A new elevation carrying the moment: is it the tilt we want?
      const angle = dv.getFloat32(m + 24);
      const repeat = sweep.angles.some((a) => Math.abs(a - angle) < 0.25);
      if (!repeat) sweep.angles.push(angle);
      if (repeat || sweep.angles.length - 1 !== sweep.tilt) {
        sweep.skip.add(elev);
        continue;
      }
      sweep.target = elev;
    }
    const extras = {};
    for (const name of sweep.extra) if (blocks[name] !== undefined) extras[name] = readMoment(raw, dv, blocks[name]);
    sweep.radials.push({
      az: dv.getFloat32(m + 12),
      width: raw[m + 20] === 1 ? 0.5 : 1,
      elevation: dv.getFloat32(m + 24),
      time: (dv.getUint16(m + 8) - 1) * MS_DAY + dv.getUint32(m + 4),
      ...readMoment(raw, dv, block),
      extra: extras,
    });
    const status = raw[m + 21];
    if (status === 2 || status === 4) sweep.done = true; // end of elevation / volume
  }
}

/** One moment's data block: gate geometry, scaling and raw codes. */
function readMoment(raw, dv, block) {
  const nGates = dv.getUint16(block + 8);
  const word = raw[block + 19];
  const codes = word === 16 ? new Uint16Array(nGates) : new Uint8Array(nGates);
  if (word === 16) for (let g = 0; g < nGates; g++) codes[g] = dv.getUint16(block + 28 + 2 * g);
  else codes.set(raw.subarray(block + 28, block + 28 + nGates));
  return {
    firstGateKm: dv.getInt16(block + 10) / 1000,
    gateKm: dv.getInt16(block + 12) / 1000,
    scale: dv.getFloat32(block + 20),
    offset: dv.getFloat32(block + 24),
    codes,
  };
}

/** Radials → one values array; `pick` selects the moment block of a radial. */
function assemble(sweep, moment, pick, gates) {
  const rs = sweep.radials;
  const nGates = gates ?? Math.max(...rs.map((r) => r.codes.length));
  const nRadials = rs.length;
  const values = new Float32Array(nRadials * nGates).fill(NaN);
  const azimuths = new Float32Array(nRadials);
  const widths = new Float32Array(nRadials);
  const folds = moment === 'VEL' || moment === 'SW ';
  rs.forEach((r, i) => {
    azimuths[i] = (r.az - r.width / 2 + 360) % 360; // message 31 azimuths are radial centres
    widths[i] = r.width;
    const b = pick(r);
    if (!b) return;
    const row = i * nGates;
    for (let g = 0; g < Math.min(b.codes.length, nGates); g++) {
      const c = b.codes[g];
      if (c > 1) values[row + g] = (c - b.offset) / b.scale;
      else if (c === 1 && folds) values[row + g] = RF;
    }
  });
  const elevs = rs.map((r) => r.elevation).sort((a, b) => a - b);
  return {
    ...(sweep.site ?? {}),
    elevation: Math.round(elevs[elevs.length >> 1] * 10) / 10,
    time: rs[0].time,
    firstGateKm: rs[0].firstGateKm,
    gateKm: rs[0].gateKm,
    nGates,
    nRadials,
    azimuths,
    widths,
    values,
    empty: false,
  };
}
