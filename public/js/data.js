// Field loading: a pool of decode workers plus an LRU cache of decoded fields.
// Run arguments are "run keys": a run id, plus "~member" for an ensemble member
// ("2026110200~mean", "2026110200~7"), so every member gets its own cache entries.
import { MODELS, modelFor } from './models.js';
import { extractWindow } from './decode/window.js';

// Decoded fields kept in memory: enough for whole-run loops where the device allows.
const GB = 2 ** 30;
const MAX_BYTES = Math.round(Math.min(2.5, Math.max(1, (navigator.deviceMemory ?? 6) / 4)) * GB);
const MIN_ENTRIES = 12; // never evict below this many, whatever their size
// Raw GRIB bytes of the fields soundings and cross sections read, so a window
// somewhere else in the same field only needs decoding again, not downloading.
const MAX_RAW_BYTES = Math.min(512 * 2 ** 20, MAX_BYTES / 4);
const MEAN_BATCH = 5; // ensemble members fetched and summed per worker job
// Queue priority: interactive (sounding/cross-section) loads first, then the
// forecast hour on screen, then background preloading.
export const PRIORITY = { background: 0, interactive: 1 };

const boxKey = (b) => `${b.south},${b.north},${b.west},${b.east}`;
/** Error message of work dropped because the view changed (see DataSource.retain). */
export const CANCELLED = 'cancelled: no longer on screen';
const hashOf = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** Split a run key into [run id, member or null]. */
export const splitRun = (run) => {
  const i = run.indexOf('~');
  return i < 0 ? [run, null] : [run.slice(0, i), run.slice(i + 1)];
};

// Cached fields are stored as 16-bit integers over the field's own range, which
// halves memory (≈1/65 000 of the range, e.g. 2 cm for 500 hPa heights). 65535 is NaN.
const NAN16 = 65535;

function pack(field) {
  const v = field.values;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (!(hi >= lo)) lo = hi = 0;
  const k = hi > lo ? 65534 / (hi - lo) : 0;
  const q = new Uint16Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = v[i] === v[i] ? Math.round((v[i] - lo) * k) : NAN16;
  return { q, lo, step: k ? 1 / k : 0, meta: field.meta, derived: field.derived };
}

function unpack({ q, lo, step, meta, derived }) {
  const values = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) values[i] = q[i] === NAN16 ? NaN : lo + q[i] * step;
  return { values, meta, derived };
}

export class DataSource {
  constructor() {
    // Decoding is the slow part of soundings once bytes are cached: use the cores there are.
    const n = Math.max(2, Math.min(10, (navigator.hardwareConcurrency || 4) - 2));
    this.workers = Array.from({ length: n }, () => new Worker(new URL('./decode/worker.js', import.meta.url), { type: 'module' }));
    this.busy = new Array(n).fill(0); // downloads in flight per worker
    this.pending = new Map();
    this.queue = []; // jobs waiting for a worker slot
    this.maxInflight = n * 4; // each worker overlaps a few downloads with decoding
    this.focusStep = null; // jobs for this step jump the queue
    this.nextId = 1;
    this.cache = new Map(); // key -> { p: Promise<field> | null, packed, bytes }
    this.bytes = 0;
    this.maxBytes = MAX_BYTES;
    this.resolved = new Set(); // keys whose promise has settled successfully
    this.runSteps = new Map(); // "model/run" -> steps
    this.windows = new Map(); // "key@box" -> Promise<field window> (soundings, cross sections)
    this.raw = new Map(); // "url#range" -> Uint8Array of GRIB bytes (see MAX_RAW_BYTES)
    this.rawBytes = 0;
    this.means = new MeanStore();
    this.stats = { bytes: 0, decodeMs: 0, fields: 0 };
    this.viewSig = null; // what retain() last kept (see there)
    this.rawPrefix = null;
    this.workers.forEach((w, i) => {
      w.onmessage = ({ data }) => {
        const p = this.pending.get(data.id);
        this.pending.delete(data.id);
        this.busy[i] -= p?.weight ?? 1;
        this.#pump();
        if (!p) return;
        if (p.cancelled) p.reject(new Error(CANCELLED));
        else if (data.error) p.reject(new Error(data.error));
        else {
          this.stats.bytes += data.bytes;
          this.stats.decodeMs += data.decodeMs;
          this.stats.fields++;
          if (data.raw) {
            this.#keepRaw(p.job, data.raw[0]);
            if (p.job.pair) this.#keepRaw(p.job.pair, data.raw[1]);
          }
          p.resolve(data.parts ?? data.fields);
        }
      };
    });
  }

  async runs(model) {
    const runs = await MODELS[model].source.runs();
    for (const r of runs) this.runSteps.set(`${model}/${r.id}`, r.steps);
    return { runs };
  }

  /** Whether the cache is close to its memory budget (so preloading should stop). */
  full() {
    return this.bytes > this.maxBytes * 0.9;
  }

  #decode(job, step) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, step, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    const inflight = () => this.busy.reduce((a, b) => a + b, 0);
    while (this.queue.length && inflight() < this.maxInflight) {
      // Highest priority first; within a priority, the hour on screen first.
      let k = 0;
      let best = -1;
      for (let i = 0; i < this.queue.length && best < 3; i++) {
        const q = this.queue[i];
        const score = (q.job.priority ?? 0) * 2 + (q.step === this.focusStep ? 1 : 0);
        if (score > best) {
          best = score;
          k = i;
        }
      }
      // Background loading only gets half the downloads, and none while the hour
      // on screen or a sounding is loading: they share one connection per host.
      if (best === 0 && (inflight() >= this.maxInflight / 2 || [...this.pending.values()].some((p) => p.fg))) break;
      const [q] = this.queue.splice(k, 1);
      q.fg = best > 0;
      // A batch of ensemble members is several downloads (none if its bytes are here).
      q.weight = q.job.parts ? Math.max(1, q.job.parts.filter((x) => !x.bytes).length) : 1;
      // Every variable of an Open-Meteo file goes to the worker that already has
      // that file open (its header, variable list and index blocks are cached there).
      const i = q.job.kind === 'om' ? hashOf(q.job.url) % this.workers.length : this.busy.indexOf(Math.min(...this.busy));
      this.busy[i] += q.weight;
      const id = this.nextId++;
      q.worker = i;
      this.pending.set(id, q);
      this.workers[i].postMessage({ id, job: q.job });
    }
  }

  // ------------------------------------------------------------- the view on screen
  /** Every param/level a set of input specs reads, with recipes expanded into what they're made from. */
  #closure(model, member, specs, out = new Set()) {
    const m = modelFor(model, member);
    for (const { param, level } of specs) {
      const k = `${param}/${level ?? 'sfc'}`;
      if (out.has(k)) continue;
      out.add(k);
      const recipe = m.derived[param];
      if (recipe?.sum) out.add(`${recipe.sum}/sfc`);
      else if (recipe) {
        // Some recipes read other fields depending on the hour (precip buckets): ask at a few.
        for (const step of [1, 7, 25]) this.#closure(model, member, Object.values(recipe.needs(level, { step, prevStep: step - 1, level })), out);
      }
    }
    return out;
  }

  /**
   * Keep only what the view on screen reads: one model's run (one member) and
   * the fields of one product, with what they're computed from, at every hour.
   * Everything else is dropped from memory, and background work for it, queued
   * or downloading, is cancelled so the view's own frames get the connection.
   * Windows for soundings and cross sections of the same run are kept.
   * @param {{model: string, run: string, specs: {param: string, level?: number}[]}|null} view
   */
  retain(view) {
    const sig = view ? `${view.model}/${view.run}|${view.specs.map((s) => `${s.param}/${s.level ?? 'sfc'}`).sort().join(',')}` : '';
    if (sig === this.viewSig) return;
    this.viewSig = sig;
    const prefix = view ? `${view.model}/${view.run}/` : null;
    const keep = view ? this.#closure(view.model, splitRun(view.run)[1], view.specs) : new Set();
    // Keys are "model/run/step/param/level".
    const kept = (key) => !!prefix && key.startsWith(prefix) && keep.has(key.slice(key.indexOf('/', prefix.length) + 1));
    for (const [key, e] of this.cache) {
      if (kept(key)) continue;
      this.cache.delete(key);
      if (this.resolved.delete(key)) this.bytes -= e.bytes;
    }
    for (const k of this.windows.keys()) if (!prefix || !k.startsWith(prefix)) this.windows.delete(k);
    if (prefix !== this.rawPrefix) {
      this.raw.clear();
      this.rawBytes = 0;
      this.rawPrefix = prefix;
    }
    // Soundings of this run keep loading; anything for another view stops.
    const stale = (job) =>
      !!job.key && (job.priority === PRIORITY.interactive ? !prefix || !job.key.startsWith(prefix) : !kept(job.key));
    this.queue = this.queue.filter((q) => {
      if (!stale(q.job)) return true;
      q.reject(new Error(CANCELLED));
      return false;
    });
    for (const [id, p] of this.pending) {
      if (p.cancelled || !stale(p.job)) continue;
      p.cancelled = true;
      this.workers[p.worker].postMessage({ cancel: id });
    }
  }

  // ------------------------------------------------------------- raw GRIB bytes
  #rawKey(part) {
    return `${part.url}#${part.range ? part.range.join('-') : ''}`;
  }

  #keepRaw(part, bytes) {
    if (!bytes) return;
    const k = this.#rawKey(part);
    if (this.raw.has(k)) return;
    this.raw.set(k, bytes);
    this.rawBytes += bytes.byteLength;
    for (const [key, b] of this.raw) {
      if (this.rawBytes <= MAX_RAW_BYTES) break;
      this.raw.delete(key);
      this.rawBytes -= b.byteLength;
    }
  }

  /** Attach bytes already downloaded, or ask the worker to send them back. */
  #useRaw(part) {
    const k = this.#rawKey(part);
    const hit = this.raw.get(k);
    if (hit) {
      this.raw.delete(k); // refresh LRU position
      this.raw.set(k, hit);
      part.bytes = hit;
    } else part.keep = true;
  }

  /**
   * Ensemble mean (or most common category) over members. Members are fetched
   * and summed in batches inside the workers, so each batch sends back one array.
   */
  async #reduce(job, step) {
    const mode = job.reduce === 'mode';
    const CATS = 13; // precip type codes 0..12 (as in the worker)
    const batches = [];
    for (let i = 0; i < job.parts.length; i += MEAN_BATCH) batches.push(job.parts.slice(i, i + MEAN_BATCH));
    let acc = null;
    let meta = null;
    let count = 0;
    await Promise.all(
      batches.map(async (parts) => {
        const [f] = await this.#decode({ kind: 'sum', reduce: job.reduce, parts, priority: job.priority, key: job.key }, step);
        if (!acc) {
          acc = f.values;
          meta = f.meta;
        } else {
          const v = f.values;
          for (let i = 0; i < v.length; i++) acc[i] += v[i];
        }
        count += f.count;
      }),
    );
    const n = mode ? acc.length / CATS : acc.length;
    const values = new Float32Array(n);
    if (mode) {
      // Most common precipitating type wherever any member precipitates.
      for (let i = 0; i < n; i++) {
        let best = 0;
        for (let c = 1, top = 0; c < CATS; c++) {
          if (acc[i * CATS + c] > top) {
            top = acc[i * CATS + c];
            best = c;
          }
        }
        values[i] = best;
      }
    } else {
      for (let i = 0; i < n; i++) values[i] = acc[i] / count;
    }
    return [{ values, meta }];
  }

  #trim() {
    for (const [key, e] of this.cache) {
      if (this.bytes <= this.maxBytes || this.cache.size <= MIN_ENTRIES) break;
      this.cache.delete(key);
      this.resolved.delete(key);
      this.bytes -= e.bytes;
    }
  }

  #track(key, entry, p) {
    p.then(
      (f) => {
        if (this.cache.get(key) !== entry) return;
        if (f?.values) {
          entry.packed = pack(f);
          entry.p = null;
          entry.bytes = entry.packed.q.byteLength;
        }
        this.bytes += entry.bytes;
        this.resolved.add(key);
        this.#trim();
      },
      () => {
        if (this.cache.get(key) === entry) this.cache.delete(key);
      },
    );
  }

  #value(entry) {
    return entry.packed ? Promise.resolve(unpack(entry.packed)) : entry.p;
  }

  #remember(key, make) {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return this.#value(hit);
    }
    const entry = { p: make(), packed: null, bytes: 0 };
    this.cache.set(key, entry);
    this.#track(key, entry, entry.p);
    return entry.p;
  }

  #put(key, field) {
    if (this.cache.has(key)) return;
    const entry = { p: Promise.resolve(field), packed: null, bytes: 0 };
    this.cache.set(key, entry);
    this.#track(key, entry, entry.p);
  }

  #ctx(model, run, step) {
    const steps = this.runSteps.get(`${model}/${splitRun(run)[0]}`) ?? [];
    const before = steps.filter((s) => s < step);
    return { step, prevStep: before.length ? before[before.length - 1] : Math.max(0, step - 1) };
  }

  /**
   * Decode one published field, uncached. Grid-relative winds also return their partner.
   * With a box, only that window of the field comes back (see fieldIn).
   */
  async #raw(model, run, step, param, level, box = null, priority = box ? PRIORITY.interactive : PRIORITY.background) {
    const [runId, member] = splitRun(run);
    const src = modelFor(model, member).source;
    const job = await src.job(runId, step, param, level, member);
    job.priority = priority;
    job.key = `${model}/${run}/${step}/${param}/${level ?? 'sfc'}`; // what retain() checks
    if (box) {
      job.extract = box;
      job.parts?.forEach((p) => (p.extract = box));
      if (job.kind === 'grib') {
        this.#useRaw(job);
        if (job.pair) this.#useRaw(job.pair);
      }
    }
    let fields;
    if (job.kind === 'mean') fields = await this.#reduce(job, step);
    else if (job.member === 'mean') {
      // One file holds every member (GEPS): split it and decode the members in parallel.
      const parts = await this.#decode({ kind: 'split', url: job.url, range: job.range, priority: job.priority, key: job.key }, step);
      fields = await this.#reduce({ reduce: 'mean', priority: job.priority, key: job.key, parts: parts.map((bytes) => ({ bytes, extract: job.extract })) }, step);
    } else fields = await this.#decode(job, step);
    fields.forEach((f, i) => {
      const p = i === 0 ? param : job.pair.param;
      src.post(p)?.(f.values, f.meta);
      normalizeUnits(f, p);
    });
    if (job.pair && fields[1]) {
      const pairKey = `${model}/${run}/${step}/${job.pair.param}/${level ?? 'sfc'}`;
      if (box) this.#putWindow(`${pairKey}@${boxKey(box)}`, Promise.resolve(fields[1]));
      else this.#put(pairKey, fields[1]);
    }
    return fields[0];
  }

  #putWindow(k, p) {
    if (this.windows.has(k)) return this.windows.get(k);
    this.windows.set(k, p);
    p.catch(() => this.windows.delete(k));
    // A window is small (≤ 400×400), but soundings read ~100 of them per time.
    while (this.windows.size > 1200) this.windows.delete(this.windows.keys().next().value);
    return p;
  }

  /**
   * A window of a field around a box: from the full field when it's already
   * decoded, otherwise decoded in a worker that returns just the window. Derived
   * params are computed on windows of their inputs.
   */
  fieldIn(model, run, step, { param, level }, box, priority = PRIORITY.interactive) {
    const key = `${model}/${run}/${step}/${param}/${level ?? 'sfc'}`;
    const k = `${key}@${boxKey(box)}`;
    const hit = this.windows.get(k);
    if (hit) {
      this.windows.delete(k);
      this.windows.set(k, hit);
      return hit;
    }
    const m = modelFor(model, splitRun(run)[1]);
    const recipe = m.derived[param];
    const make = async () => {
      if (this.resolved.has(key)) return extractWindow(await this.#value(this.cache.get(key)), box);
      if (recipe && !recipe.sum && !recipe.worker) {
        const ctx = { ...this.#ctx(model, run, step), level };
        const spec = recipe.needs(level, ctx);
        const names = Object.keys(spec);
        const fields = await Promise.all(names.map((n) => this.fieldIn(model, run, step, spec[n], box, priority)));
        const inp = Object.fromEntries(names.map((n, i) => [n, fields[i]]));
        return { values: recipe.make(inp, ctx), meta: fields[0].meta };
      }
      if (!m.source.has(param, level)) throw new Error(`${param}${level ? ` at ${level} hPa` : ''} isn't published for ${m.name}`);
      // A locally averaged mean needs every member's whole field anyway: keep the
      // whole mean (cached, and stored across visits), so any other window is free.
      if (this.#computedMean(model, run)) return extractWindow(await this.#storedMean(key, model, run, step, param, level, priority), box);
      return this.#raw(model, run, step, param, level, box, priority);
    };
    return this.#putWindow(k, make());
  }

  /** Drop cached inputs that were only needed to compute a heavy derived field. */
  #forget(model, run, step, spec) {
    for (const { param, level } of Object.values(spec)) {
      const key = `${model}/${run}/${step}/${param}/${level ?? 'sfc'}`;
      const e = this.cache.get(key);
      if (!e || !this.resolved.has(key)) continue;
      this.cache.delete(key);
      this.resolved.delete(key);
      this.bytes -= e.bytes;
    }
  }

  /**
   * A decoded field. Variables the model doesn't publish are computed locally
   * from others (see models.js).
   * @param {string} model a key of MODELS
   * @param {string} run run key (see splitRun)
   * @param {{param: string, level?: number, stepOffset?: number}} spec
   */
  field(model, run, step, { param, level, stepOffset = 0 }) {
    step += stepOffset;
    if (step < 0) return Promise.resolve(null);
    const key = `${model}/${run}/${step}/${param}/${level ?? 'sfc'}`;
    const m = modelFor(model, splitRun(run)[1]);
    const recipe = m.derived[param];
    if (step === 0 && (recipe ? recipe.zeroAtStart : m.source.zeroAtStart(param))) {
      // Accumulations start at zero; F000 files don't carry them (REFS has no F000 at all).
      return this.#remember(key, async () => {
        const first = this.runSteps.get(`${model}/${splitRun(run)[0]}`)?.[0] ?? 0;
        const ref = await this.field(model, run, first, { param: '2t' });
        return { values: new Float32Array(ref.values.length), meta: ref.meta };
      });
    }
    if (recipe?.sum) return this.#remember(key, () => this.#runningSum(model, run, step, param, recipe));
    if (recipe) {
      return this.#remember(key, async () => {
        const ctx = { ...this.#ctx(model, run, step), level };
        const spec = recipe.needs(level, ctx);
        const inp = await this.inputs(model, run, step, spec);
        const base = Object.values(inp).find(Boolean);
        if (!recipe.worker) return { values: recipe.make(inp, ctx), meta: base.meta, derived: true };
        // Per-point profile calculations run in a worker; their many inputs aren't kept.
        const inputs = Object.fromEntries(Object.entries(inp).map(([n, f]) => [n, f.values]));
        const [out] = await this.#decode({ kind: 'compute', fn: recipe.worker, levels: recipe.levels, inputs, meta: base.meta, key }, step);
        this.#forget(model, run, step, spec);
        return { values: out.values, meta: base.meta, derived: true };
      });
    }
    if (!m.source.has(param, level)) {
      return Promise.reject(new Error(`${param}${level ? ` at ${level} hPa` : ''} isn't published for ${m.name}`));
    }
    if (this.#computedMean(model, run)) return this.#storedMean(key, model, run, step, param, level);
    return this.#remember(key, () => this.#raw(model, run, step, param, level));
  }

  /** A locally averaged ensemble mean: averaging 20–51 members is slow, so it's kept across visits. */
  #storedMean(key, model, run, step, param, level, priority = PRIORITY.background) {
    return this.#remember(key, async () => {
      const stored = await this.means.get(key);
      if (stored) return unpack(stored);
      const f = await this.#raw(model, run, step, param, level, null, priority);
      this.means.put(key, pack(f));
      return f;
    });
  }

  #computedMean(model, run) {
    return MODELS[model].members?.mean === 'computed' && splitRun(run)[1] === 'mean';
  }

  /**
   * Total since F000 of a field published as per-interval amounts. Walks
   * forward from the newest cached total, fetching a few intervals ahead.
   */
  async #runningSum(model, run, step, param, { sum, scale }) {
    // F000 holds no interval (ICON's analysis file has no precipitation at all): totals start there at zero.
    const steps = (this.runSteps.get(`${model}/${splitRun(run)[0]}`) ?? [step]).filter((s) => s > 0 && s <= step);
    if (steps[steps.length - 1] !== step) steps.push(step);
    const keyOf = (s) => `${model}/${run}/${s}/${param}/sfc`;
    let i = steps.length - 2;
    while (i >= 0 && !this.resolved.has(keyOf(steps[i]))) i--;
    let acc = i >= 0 ? await this.#value(this.cache.get(keyOf(steps[i]))) : null;
    const incs = new Map();
    const fetchInc = (j) => {
      if (j < steps.length && !incs.has(j)) incs.set(j, this.#raw(model, run, steps[j], sum));
    };
    for (let j = i + 1; j < steps.length; j++) {
      for (let k = j; k <= j + 4; k++) fetchInc(k);
      const inc = await incs.get(j);
      incs.delete(j);
      const out = new Float32Array(inc.values.length);
      for (let q = 0; q < out.length; q++) {
        const x = inc.values[q];
        out[q] = (acc ? acc.values[q] : 0) + (x > 0 ? x * scale : 0);
      }
      acc = { values: out, meta: inc.meta };
      // Checkpoint every 6 h so later steps don't start from F000.
      if (j < steps.length - 1 && steps[j] % 6 === 0) this.#put(keyOf(steps[j]), acc);
    }
    return acc;
  }

  /** Load a named set of inputs: { name: {param, level} } -> { name: field } */
  async inputs(model, run, step, spec) {
    const names = Object.keys(spec);
    const fields = await Promise.all(names.map((n) => this.field(model, run, step, spec[n])));
    return Object.fromEntries(names.map((n, i) => [n, fields[i]]));
  }

  has(model, run, step, spec) {
    return Object.values(spec).every(({ param, level, stepOffset = 0 }) =>
      step + stepOffset < 0 || this.resolved.has(`${model}/${run}/${step + stepOffset}/${param}/${level ?? 'sfc'}`),
    );
  }
}

/**
 * Locally averaged ensemble means, kept in IndexedDB (packed, as in the memory
 * cache) so a revisit, a reload or the next session doesn't average them again.
 * Runs never change once published. The oldest entries go beyond MAX_STORED.
 */
const MAX_STORED = 300; // about 2 MB each at 0.25°
class MeanStore {
  constructor() {
    this.db = null;
    this.puts = 0;
  }

  #open() {
    this.db ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open('model-globe-means', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('fields').createIndex('t', 't');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null); // storage blocked: means are just recomputed
      }
    });
    return this.db;
  }

  async get(key) {
    const db = await this.#open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction('fields').objectStore('fields').get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async put(key, packed) {
    const db = await this.#open();
    if (!db) return;
    try {
      db.transaction('fields', 'readwrite').objectStore('fields').put({ ...packed, t: Date.now() }, key);
      if (++this.puts % 20 === 1) this.#prune(db);
    } catch {
      // over quota or storage blocked: skip
    }
  }

  #prune(db) {
    const store = db.transaction('fields', 'readwrite').objectStore('fields');
    const req = store.count();
    req.onsuccess = () => {
      let extra = req.result - MAX_STORED;
      if (extra <= 0) return;
      store.index('t').openKeyCursor().onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur || extra-- <= 0) return;
        store.delete(cur.primaryKey);
        cur.continue();
      };
    };
  }
}

// WMO-standard accumulations in kg m⁻² (mm), as AIFS publishes total
// precipitation (0/1/52) and snowfall water equivalent (0/1/53). IFS uses
// ECMWF's local codes in metres, which the products expect, so convert.
// The same codes are also the *rates* (kg m⁻² s⁻¹) of IFS/ENS `tprate`, which
// stay as they are: only the accumulated params are converted.
const KG_M2_ACCUMULATIONS = new Set(['0/1/52', '0/1/53']);
const ACCUMULATED = new Set(['tp', 'sf']);

function normalizeUnits(field, param) {
  const { discipline, category, number } = field.meta;
  if (ACCUMULATED.has(param) && KG_M2_ACCUMULATIONS.has(`${discipline}/${category}/${number}`)) {
    const v = field.values;
    for (let i = 0; i < v.length; i++) v[i] /= 1000;
  }
  return field;
}

/** Fractional grid position of lat/lon, or null outside a regional grid. */
function gridPos(meta, lat, lon) {
  const { ni, nj, lat0, lon0, dlat, dlon } = meta;
  let x = (((lon - lon0) / dlon) % ni + ni) % ni;
  let y = (lat - lat0) / dlat;
  if (meta.regional) {
    x = ((((lon - lon0) % 360) + 360) % 360) / dlon;
    if (x > ni - 1 || y < 0 || y > nj - 1) return null;
  } else {
    y = Math.min(nj - 1, Math.max(0, y));
  }
  return [x, y];
}

/** Bilinear sample of a decoded field at lat/lon (degrees); NaN outside the grid. */
export function sampleField(values, meta, lat, lon) {
  const pos = gridPos(meta, lat, lon);
  if (!pos) return NaN;
  const { ni, nj } = meta;
  const [x, y] = pos;
  const x0 = Math.min(Math.floor(x), ni - 1);
  const y0 = Math.min(nj - 2, Math.floor(y));
  const x1 = meta.regional ? Math.min(x0 + 1, ni - 1) : (x0 + 1) % ni;
  const fx = x - x0;
  const fy = y - y0;
  const r0 = y0 * ni;
  const r1 = r0 + ni;
  const top = values[r0 + x0] * (1 - fx) + values[r0 + x1] * fx;
  const bot = values[r1 + x0] * (1 - fx) + values[r1 + x1] * fx;
  return top * (1 - fy) + bot * fy;
}

/** Nearest-neighbour sample (for categorical fields). */
export function sampleNearest(values, meta, lat, lon) {
  const pos = gridPos(meta, lat, lon);
  if (!pos) return NaN;
  const x = Math.round(pos[0]) % meta.ni;
  const y = Math.round(pos[1]);
  return values[y * meta.ni + x];
}
