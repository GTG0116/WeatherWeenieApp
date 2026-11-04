// Radar data: the site list and its live status, the recent frames of a
// product at a site (from the public bucket listings), and decoded sweeps,
// cached and decoded in a small worker pool.
import { fetchRetry } from '../sources.js';
import { sourceOf } from './products.js';

const L3_BUCKET = 'https://unidata-nexrad-level3.s3.amazonaws.com';
const L2_BUCKET = 'https://unidata-nexrad-level2.s3.amazonaws.com';
const STATUS_URL = 'https://api.weather.gov/radar/stations?stationType=WSR-88D,TDWR';
const HOUR = 3600e3;
const LOOP_HOURS = 2; // how far back a loop reaches
const MAX_FRAMES = { 3: 24, 2: 10 }; // Level II frames are ~2 MB downloads each
export const STALE_MS = 30 * 60e3; // no data for this long: the radar counts as down
const PAIR_TOLERANCE_MS = 12 * 60e3;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (t, sep = '_') => {
  const d = new Date(t);
  return [d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), pad(d.getUTCHours()), pad(d.getUTCMinutes())].join(sep);
};
const dayPath = (t) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
};

async function listKeys(bucket, prefix, startAfter = '') {
  const keys = [];
  let token = '';
  do {
    const q = `list-type=2&prefix=${encodeURIComponent(prefix)}` +
      (startAfter ? `&start-after=${encodeURIComponent(startAfter)}` : '') +
      (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
    const res = await fetchRetry(`${bucket}/?${q}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} listing ${bucket.split('//')[1].split('.')[0]}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    token = xml.match(/<NextContinuationToken>([^<]+)</)?.[1] ?? '';
  } while (token);
  return keys;
}

// ------------------------------------------------------------------ sites
/** Bundled site list (tools/build-radars.mjs). */
export async function loadSites() {
  const rows = await fetch('data/radars.json').then((r) => r.json());
  return rows.map(([id, name, type, lat, lon, elev, region]) => ({ id, name, type, lat, lon, elev, region }));
}

/**
 * Live status of every radar from the NWS API: down when its last data is
 * older than STALE_MS, or the RDA isn't operating or reports itself inoperable.
 * @returns {Promise<Map<string, {down: boolean, reason: string, last: number|null}>>}
 */
export async function fetchStatus() {
  const res = await fetchRetry(STATUS_URL, { headers: { Accept: 'application/geo+json' } }, 2);
  if (!res.ok) throw new Error(`NWS radar status: HTTP ${res.status}`);
  const { features } = await res.json();
  const now = Date.now();
  const out = new Map();
  for (const { properties: p } of features) {
    const last = Date.parse(p.latency?.levelTwoLastReceivedTime ?? '') || null;
    const rda = p.rda?.properties ?? {};
    let reason = '';
    if (!last) reason = 'No data reported';
    else if (now - last > STALE_MS) reason = `No data since ${new Date(last).toISOString().slice(11, 16)}Z (${ago(now - last)})`;
    else if (rda.status && rda.status !== 'Operate') reason = `RDA status: ${rda.status}`;
    else if (/inoperable/i.test(rda.operabilityStatus ?? '')) reason = rda.operabilityStatus;
    out.set(p.id, { down: !!reason, reason, last, operability: rda.operabilityStatus ?? '', vcp: rda.volumeCoveragePattern ?? '' });
  }
  return out;
}

export function ago(ms) {
  const m = Math.round(ms / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// ------------------------------------------------------------------ frames
/** Level III key → time: "TLX_N0B_2026_11_04_00_15_37". */
function l3Time(key) {
  const m = key.match(/_(\d{4})_(\d\d)_(\d\d)_(\d\d)_(\d\d)_(\d\d)$/);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}
/** Level II key → time: ".../KTLX20261104_000726_V06". */
function l2Time(key) {
  const m = key.match(/(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)_V\d\d$/);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/**
 * Recent frames of a product at a site and tilt, oldest first:
 * [{time, url, level, pairUrl?, moment?, tilt?}]. When nothing arrived within
 * the loop window, the last few frames of the past day are returned instead
 * (so a down radar still shows its last scan).
 */
export async function listFrames(site, product, tilt = 0, res = 'super', now = Date.now()) {
  const src = sourceOf(product, site.type, tilt, res);
  if (!src) return [];
  // Level II tilts above the lowest need most of the ~6 MB volume: a shorter loop.
  const max = src.level === 2 && src.tilt > 0 ? 6 : MAX_FRAMES[src.level];
  let frames;
  if (src.level === 3) {
    const list = async (code, hours) => {
      const prefix = `${site.id.slice(1)}_${code}_`;
      return (await listKeys(L3_BUCKET, prefix, prefix + stamp(now - hours * HOUR)))
        .map((key) => ({ time: l3Time(key), url: `${L3_BUCKET}/${key}`, level: 3 }));
    };
    let hours = LOOP_HOURS;
    frames = await list(src.code, hours);
    if (!frames.length) frames = await list(src.code, (hours = 24));
    if (src.pair) {
      // Pair each scan with the storm-motion product nearest in time (same or
      // neighbouring volume); scans with none nearby are left out.
      const pairs = await list(src.pair, hours + 0.25);
      frames = frames.flatMap((f) => {
        const best = pairs.reduce((a, b) => (Math.abs(b.time - f.time) < Math.abs(a.time - f.time) ? b : a), pairs[0]);
        return best && Math.abs(best.time - f.time) < PAIR_TOLERANCE_MS ? [{ ...f, pairUrl: best.url }] : [];
      });
    }
  } else {
    frames = (await listVolumes(site, now)).map((v) => ({ ...v, level: 2, moment: src.moment, extra: src.extra, derive: src.derive, tilt: src.tilt }));
  }
  frames = frames.filter((f) => Number.isFinite(f.time)).sort((a, b) => a.time - b.time);
  return frames.slice(-max);
}

/**
 * Level II volumes of a site within the loop window (or the past day's if
 * none came in since), oldest first: [{time, url}].
 */
export async function listVolumes(site, now = Date.now()) {
  const list = async (t) =>
    (await listKeys(L2_BUCKET, `${dayPath(t)}/${site.id}/`))
      .filter((key) => /_V\d\d$/.test(key))
      .map((key) => ({ time: l2Time(key), url: `${L2_BUCKET}/${key}` }));
  let vols = await list(now);
  const startOfDay = Math.floor(now / (24 * HOUR)) * 24 * HOUR;
  if (now - startOfDay < LOOP_HOURS * HOUR || !vols.length) vols = [...(await list(now - 24 * HOUR)), ...vols];
  const recent = vols.filter((v) => v.time >= now - LOOP_HOURS * HOUR);
  return (recent.length ? recent : vols.slice(-6)).filter((v) => Number.isFinite(v.time)).sort((a, b) => a.time - b.time);
}

// ------------------------------------------------------------------ decoding
const CACHE_BYTES = 640 * 2 ** 20;
const VOLUME_CACHE = 12;
const volumeKey = (url, moment, box) => `${url}#${moment}#${[box.x0, box.x1, box.y0, box.y1].map((v) => v.toFixed(1))}`;
// One Level II volume serves several moments, tilts and derived fields; SRV
// is the same velocity scan with a storm motion taken off.
const cacheKey = (frame) =>
  frame.moment
    ? `${frame.url}#${frame.moment}#${frame.tilt}#${frame.derive ?? ''}`
    : frame.pairUrl ? `${frame.url}+${frame.pairUrl}` : frame.url;

export class RadarSource {
  constructor(n = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) >> 1))) {
    this.workers = Array.from({ length: n }, () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
    this.busy = this.workers.map(() => 0);
    this.pending = new Map();
    this.seq = 0;
    this.cache = new Map(); // cacheKey → Promise<sweep>, in use order
    this.sizes = new Map();
    this.bytes = 0;
    this.workers.forEach((w) => {
      w.onmessage = ({ data }) => {
        const p = this.pending.get(data.id);
        if (!p) return;
        this.pending.delete(data.id);
        this.busy[p.worker]--;
        if (data.error) p.reject(new Error(data.error));
        else p.resolve(data.frame);
      };
    });
  }

  /** @param {number} [w] worker to use (default: the least busy) */
  #run(job, w) {
    if (w === undefined) {
      w = 0;
      for (let i = 1; i < this.workers.length; i++) if (this.busy[i] < this.busy[w]) w = i;
    }
    const id = ++this.seq;
    this.busy[w]++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: w });
      this.workers[w].postMessage({ id, job });
    });
  }

  has(frame) {
    return this.sizes.has(cacheKey(frame));
  }

  /** Decoded sweep for a frame from listFrames. */
  get(frame) {
    const key = cacheKey(frame);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const job = { level: frame.level, url: frame.url, pairUrl: frame.pairUrl, moment: frame.moment, extra: frame.extra, derive: frame.derive, tilt: frame.tilt };
    const p = this.#run(job).then((sweep) => {
      const size = sweep.values?.byteLength ?? 0;
      this.sizes.set(key, size);
      this.bytes += size;
      this.#evict();
      return sweep;
    });
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, p);
    return p;
  }

  /**
   * Every tilt of a Level II moment resampled onto a 3D grid over a box of
   * km east / north of the radar (see worker.js), values scaled over [vmin, vmax].
   * A volume always goes to the same worker, which keeps the last one it decoded,
   * so drawing a new box over the same scan needn't download it again.
   */
  volume(url, moment, vmin, vmax, box) {
    const key = volumeKey(url, moment, box);
    this.volumes ??= new Map();
    const hit = this.volumes.get(key);
    if (hit) {
      this.volumes.delete(key);
      this.volumes.set(key, hit);
      return hit;
    }
    let hash = 0;
    for (let i = 0; i < url.length; i++) hash = (hash * 31 + url.charCodeAt(i)) | 0;
    const p = this.#run({ volume: true, url, moment, vmin, vmax, box }, Math.abs(hash) % this.workers.length);
    p.catch(() => this.volumes.delete(key));
    this.volumes.set(key, p);
    while (this.volumes.size > VOLUME_CACHE) this.volumes.delete(this.volumes.keys().next().value);
    return p;
  }

  hasVolume(url, moment, box) {
    return !!this.volumes?.has(volumeKey(url, moment, box));
  }

  #evict() {
    for (const key of this.cache.keys()) {
      if (this.bytes <= CACHE_BYTES) break;
      if (!this.sizes.has(key)) continue; // still loading
      this.bytes -= this.sizes.get(key);
      this.sizes.delete(key);
      this.cache.delete(key);
    }
  }
}
