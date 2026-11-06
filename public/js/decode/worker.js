// Decoding worker: fetches raw GRIB2 bytes (HTTP range requests straight from
// the public buckets) or Open-Meteo .om variables, decodes them here, off the
// main thread, and regrids projected grids onto lat/lon.
import { decodeGrib2, splitGrib2 } from './grib2.js';
import { regrid, rowsNeeded } from './regrid.js';
import { extractWindow } from './window.js';
import { fetchRetry } from '../sources.js';
import { dcape, dewpointFromRh } from '../thermo.js';

/** Bytes [from, to] of a file (or all of it without a range), trying mirrors in order. */
async function fetchBytes(urls, range, signal) {
  const init = range ? { headers: { Range: `bytes=${range[0]}-${range[1] ?? ''}` }, signal } : { signal };
  const res = await fetchRetry(urls, init);
  const name = urls[0].split('/').pop();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`);
  if (range && res.status !== 206) throw new Error(`${new URL(res.url || urls[0]).host} ignored the range request`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * For a window (job.extract), how many grid points of a field to unpack: grids
 * are stored row by row, so decoding can stop after the last row the window uses.
 */
function pointsFor(box, regridOpts) {
  if (!box) return null;
  return (meta) => {
    if (meta.projection) return rowsNeeded(meta.projection, regridOpts, box) * meta.ni;
    const { ni, nj, lat0, dlat } = meta;
    const j = Math.ceil(Math.max((box.south - lat0) / dlat, (box.north - lat0) / dlat)) + 1; // as extractWindow
    return (Math.min(nj - 1, Math.max(0, j)) + 1) * ni;
  };
}

function decodeOne(buf, need = null) {
  const [field] = decodeGrib2(buf, null, need);
  if (!field) throw new Error('No GRIB2 message in response');
  return field;
}

/** One ensemble member from a file of all members (only that member is unpacked). */
function pickMember(buf, member, need = null) {
  const [f] = decodeGrib2(buf, (meta) => meta.member === member, need);
  if (!f) throw new Error(`Member ${member} isn't in the file`);
  return f;
}

/**
 * A field, from bytes the main thread already has (job.bytes) or fetched. With
 * job.keep, freshly fetched bytes are sent back so the main thread can keep them
 * for the next window of the same field (soundings elsewhere, cross sections).
 */
async function gribJob(job) {
  const raw = await Promise.all([
    job.bytes ?? fetchBytes([job.url, ...(job.alt ?? [])], job.range, job.signal),
    job.pair && (job.pair.bytes ?? fetchBytes([job.pair.url], job.pair.range, job.signal)),
  ]);
  const t0 = performance.now();
  const need = pointsFor(job.extract, job.regrid);
  let fields = job.member != null ? [pickMember(raw[0], job.member, need)] : raw.filter(Boolean).map((b) => decodeOne(b, need));
  let windowed = false;
  if (fields[0].meta.projection) {
    if (!job.regrid) throw new Error('Projected grid without regrid settings');
    // regrid() rotates a [u, v] pair; keep the requested field first in the reply.
    const ordered = fields.length === 2 && !job.isU ? [fields[1], fields[0]] : fields;
    // Soundings and cross sections only regrid their window.
    const out = regrid(ordered, job.regrid, job.extract ?? null);
    fields = fields.length === 2 && !job.isU ? [out[1], out[0]] : out;
    windowed = !!job.extract;
  }
  // Soundings and cross sections only need a region of each field.
  if (job.extract && !windowed) fields = fields.map((f) => extractWindow(f, job.extract));
  const fetched = [!job.bytes && raw[0], job.pair && !job.pair.bytes && raw[1]];
  return {
    fields,
    raw: job.keep ? fetched.map((b) => b || null) : null,
    bytes: fetched.reduce((n, b) => n + (b ? b.byteLength : 0), 0),
    decodeMs: performance.now() - t0,
  };
}

/** The messages of a file of all ensemble members, as separate buffers to decode in parallel. */
async function splitJob(job) {
  const buf = await fetchBytes([job.url], job.range, job.signal);
  const parts = splitGrib2(buf).map((m) => m.slice());
  return { fields: [], parts, bytes: buf.byteLength, decodeMs: 0 };
}

const CATS = 13; // precip type codes 0..12

/**
 * Sum (or per-category counts, for precip type) of several ensemble members,
 * fetched together and decoded here, so only one array goes back per batch.
 */
async function sumJob(job) {
  const mode = job.reduce === 'mode';
  let acc = null;
  let meta = null;
  let count = 0;
  let bytes = 0;
  let ms = 0;
  await Promise.all(
    job.parts.map(async (part) => {
      const buf = part.bytes ?? (await fetchBytes([part.url, ...(part.alt ?? [])], part.range, job.signal));
      if (!part.bytes) bytes += buf.byteLength;
      const t0 = performance.now();
      let f = decodeOne(buf, pointsFor(part.extract));
      if (part.extract) f = extractWindow(f, part.extract);
      const v = f.values;
      if (!acc) {
        meta = f.meta;
        acc = mode ? new Uint8Array(v.length * CATS) : new Float64Array(v.length);
      }
      if (mode) {
        for (let i = 0; i < v.length; i++) {
          const c = Math.round(v[i]);
          if (c > 0 && c < CATS) acc[i * CATS + c]++;
        }
      } else {
        for (let i = 0; i < v.length; i++) acc[i] += v[i];
      }
      count++;
      ms += performance.now() - t0;
    }),
  );
  return { fields: [{ values: acc, meta, count }], bytes, decodeMs: ms };
}

// ---------------------------------------------------------------- gridded calculations
const COMPUTE = {
  /** Downdraft CAPE per grid point from pressure-level temperature and humidity. */
  dcape({ levels, inputs }) {
    const { sp, t2, d2 } = inputs;
    const order = [...levels].sort((a, b) => b - a);
    const n = sp.length;
    const out = new Float32Array(n);
    const p = new Float64Array(order.length + 1);
    const t = new Float64Array(order.length + 1);
    const td = new Float64Array(order.length + 1);
    for (let k = 0; k < n; k++) {
      const ps = sp[k] / 100;
      if (!(ps > 0) || !(t2[k] > 0)) {
        out[k] = NaN;
        continue;
      }
      p[0] = ps;
      t[0] = t2[k];
      td[0] = Math.min(d2[k], t2[k]);
      let m = 1;
      for (const l of order) {
        if (l >= ps - 1) continue;
        const tl = inputs[`t${l}`][k];
        p[m] = l;
        t[m] = tl;
        td[m] = Math.min(tl, dewpointFromRh(tl, inputs[`r${l}`][k]));
        m++;
      }
      out[k] = m < 3 ? 0 : dcape(m, p, t, td, 10);
    }
    return out;
  },
};

function computeJob(job) {
  const t0 = performance.now();
  const values = COMPUTE[job.fn](job);
  return { fields: [{ values, meta: job.meta }], bytes: 0, decodeMs: performance.now() - t0 };
}

// Open-Meteo's reader (WebAssembly) is loaded only when an ICON field is needed.
let om = null;
const MAX_READERS = 12;
// Reads at least this big skip the 64 KB block cache and go out as one range request.
const DIRECT_BYTES = 128 * 1024;

/**
 * The file's small reads (header, variable list, chunk indexes) go through
 * 64 KB cached blocks, shared by every variable read from it; a variable's data
 * is fetched in one or two big range requests instead of dozens of blocks.
 * (A whole ICON field took ~35 block requests; this takes 1–2, about twice as fast.)
 */
class HybridBackend {
  constructor(http, cached) {
    this.http = http;
    this.cached = cached;
  }

  count(signal) {
    return this.cached.count(signal);
  }

  getBytes(offset, size, signal) {
    return size >= DIRECT_BYTES ? this.http.getBytes(offset, size, signal) : this.cached.getBytes(offset, size, signal);
  }

  close() {}
}

async function omJob({ url, variable, signal }) {
  om ??= import('../../vendor/openmeteo/file-reader.js').then((mod) => ({
    mod,
    // Index and metadata blocks only (data skips it): 16 MB per worker.
    cache: new mod.LruBlockCache(64 * 1024, 256),
    readers: new Map(),
  }));
  const { mod, cache, readers } = await om;
  if (!readers.has(url)) {
    const p = (async () => {
      const http = new mod.OmHttpBackend({ url, retries: 3 });
      await http.fetchMetadata();
      const cached = mod.BlockCacheBackend.withBigIntKeys(http, cache, http.cacheKeyBigInt);
      return mod.OmFileReader.create(new HybridBackend(http, cached));
    })();
    p.catch(() => readers.delete(url));
    readers.set(url, p);
    while (readers.size > MAX_READERS) {
      const [old, oldP] = readers.entries().next().value;
      readers.delete(old);
      oldP.then((r) => r.dispose?.()).catch(() => {});
    }
  }
  const reader = await readers.get(url);
  const child = await reader.getChildByName(variable);
  if (!child) throw new Error(`${variable} isn't in ${url.split('/').pop()}`);
  const dims = child.getDimensions();
  const t0 = performance.now();
  // Big merged reads (see HybridBackend), decoded as each arrives.
  const data = await child.read({
    type: mod.OmDataType.FloatArray,
    ranges: dims.map((d) => ({ start: 0, end: d })),
    prefetch: false,
    ioSizeMax: BigInt(16 * 2 ** 20),
    ioSizeMerge: BigInt(256 * 1024),
    signal,
  });
  const values = new Float32Array(data);
  // Open-Meteo's global grids are [lat, lon], south to north from 90°S and
  // west to east from 180°W, with square cells.
  const [nj, ni] = dims;
  const d = 180 / (nj - 1);
  const meta = { ni, nj, lat0: -90, lon0: -180, dlat: d, dlon: d };
  return { fields: [{ values, meta }], bytes: values.byteLength, decodeMs: performance.now() - t0 };
}

const JOBS = { om: omJob, compute: computeJob, split: splitJob, sum: sumJob, grib: gribJob };

// Downloads of jobs still running, so the main thread can cancel them (the view changed).
const controllers = new Map();

self.onmessage = async ({ data: { id, job, cancel } }) => {
  if (cancel) {
    controllers.get(cancel)?.abort();
    return;
  }
  const ctl = new AbortController();
  controllers.set(id, ctl);
  try {
    const res = await (JOBS[job.kind] ?? gribJob)({ ...job, signal: ctl.signal });
    const transfer = [...res.fields.map((f) => f.values.buffer), ...(res.parts ?? []).map((b) => b.buffer), ...(res.raw ?? []).filter(Boolean).map((b) => b.buffer)];
    self.postMessage({ id, ...res }, transfer);
  } catch (err) {
    self.postMessage({ id, error: ctl.signal.aborted ? 'cancelled' : err.message || String(err) });
  } finally {
    controllers.delete(id);
  }
};
