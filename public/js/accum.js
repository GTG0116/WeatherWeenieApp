// Accumulated winter precipitation, built by walking forecast intervals from
// F000. Results are checkpointed per step, so stepping forward (or playing)
// only costs one new interval.
import { kucheraRatio } from './derived.js';
import { MODELS, supports } from './models.js';

const PREFETCH = 4; // intervals fetched ahead of the one being summed
const CHECKPOINTS = 24; // always kept per kind/run...
const CHECKPOINT_BYTES = 768 * 2 ** 20; // ...and more, up to this much, so whole runs can loop

// Precip type codes (table 4.201)
const isFreezing = (c) => c === 3 || c === 12;
const isSleet = (c) => c === 8;
const snowShare = (c) => (c === 5 || c === 6 ? 1 : c === 7 ? 0.5 : 0);

/**
 * How an interval's precipitation (mm) splits between the precip types
 * diagnosed at its two ends: returns [weight at start, weight at end].
 */
function endWeights(ca, cb) {
  const wa = ca === 0 ? 0 : cb === 0 ? 1 : 0.5;
  return [wa, 1 - (ca === 0 && cb === 0 ? 1 : wa)];
}

/** Snow water (m) in an interval: published snowfall, or precipitation × snow share by type. */
function intervalSnow(a, b, k) {
  if (a.sf) return b.sf[k] - a.sf[k];
  const dtp = b.tp[k] - a.tp[k];
  if (!(dtp > 0)) return 0;
  const ca = Math.round(a.ptype[k]);
  const cb = Math.round(b.ptype[k]);
  const [wa, wb] = endWeights(ca, cb);
  return dtp * (wa * snowShare(ca) + wb * snowShare(cb));
}

const KUCHERA_LEVELS = [925, 850, 700];
const snowInputs = (model) =>
  supports(model, 'sf') ? { sf: { param: 'sf' } } : { tp: { param: 'tp' }, ptype: { param: 'ptype' } };

export const KINDS = {
  /** Snowfall with Kuchera ratios: Σ Δsnow water × ratio(max column temperature). Output cm. */
  kuchera: {
    // 6-hourly intervals (3-hourly for the short-range models) keep the field count manageable
    chain: (steps, step, model) => {
      const every = MODELS[model].regional ? 3 : 6;
      return [...steps.filter((s) => s % every === 0 && s < step), step];
    },
    needs: (model) => ({
      ...snowInputs(model),
      sp: { param: 'sp' },
      t2: { param: '2t' },
      ...Object.fromEntries(KUCHERA_LEVELS.map((l) => [`t${l}`, { param: 't', level: l }])),
    }),
    // Per-step value carried between intervals: the Kuchera ratio field.
    point: (f) => {
      const n = f.t2.values.length;
      const ratio = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        let tmax = f.t2.values[k];
        for (const l of KUCHERA_LEVELS) {
          if (l * 100 <= f.sp.values[k]) tmax = Math.max(tmax, f[`t${l}`].values[k]);
        }
        ratio[k] = kucheraRatio(tmax);
      }
      return { sf: f.sf?.values, tp: f.tp?.values, ptype: f.ptype?.values, ratio };
    },
    init: (n) => ({ snow: new Float32Array(n) }),
    add: (acc, a, b) => {
      const snow = acc.snow.slice();
      for (let k = 0; k < snow.length; k++) {
        const dsf = intervalSnow(a, b, k);
        if (dsf > 0) snow[k] += dsf * 0.5 * (a.ratio[k] + b.ratio[k]) * 100; // m water -> cm snow
      }
      return { snow };
    },
  },

  /** Freezing rain, sleet and snow (all liquid equivalent, mm) split by precip type. */
  ptype: {
    chain: (steps, step) => [...steps.filter((s) => s < step), step],
    needs: () => ({ tp: { param: 'tp' }, ptype: { param: 'ptype' } }),
    point: (f) => ({ tp: f.tp.values, ptype: f.ptype.values }),
    init: (n) => ({ zr: new Float32Array(n), ip: new Float32Array(n), sn: new Float32Array(n) }),
    add: (acc, a, b) => {
      const zr = acc.zr.slice();
      const ip = acc.ip.slice();
      const sn = acc.sn.slice();
      for (let k = 0; k < zr.length; k++) {
        const dtp = (b.tp[k] - a.tp[k]) * 1000;
        if (!(dtp > 0)) continue;
        const ca = Math.round(a.ptype[k]);
        const cb = Math.round(b.ptype[k]);
        const [wa, wb] = endWeights(ca, cb);
        zr[k] += dtp * ((isFreezing(ca) ? wa : 0) + (isFreezing(cb) ? wb : 0));
        ip[k] += dtp * ((isSleet(ca) ? wa : 0) + (isSleet(cb) ? wb : 0));
        sn[k] += dtp * (wa * snowShare(ca) + wb * snowShare(cb));
      }
      return { zr, ip, sn };
    },
  },
};

export class Accumulator {
  constructor(data) {
    this.data = data;
    this.cache = new Map(); // "kind/model/run" -> Map(step -> {acc, meta})
  }

  /** Keep only the totals of the view on screen ("kind/model/run"), or none. */
  retain(key) {
    for (const k of this.cache.keys()) if (k !== key) this.cache.delete(k);
  }

  /** Whether a step is ready without fetching anything. */
  has(kind, model, run, step) {
    return !!this.cache.get(`${kind}/${model}/${run.id}`)?.has(step);
  }

  /**
   * @param {keyof KINDS} kind
   * @param {{id: string, steps: number[]}} run
   * @param {(done: number, total: number) => void} onProgress
   * @param {() => boolean} cancelled
   */
  async get(kind, model, run, step, { onProgress = () => {}, cancelled = () => false } = {}) {
    const K = KINDS[kind];
    const key = `${kind}/${model}/${run.id}`;
    if (!this.cache.has(key)) {
      // Keep checkpoints for this and one other kind/model/run only: they're large.
      while (this.cache.size > 1) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, new Map());
    }
    const store = this.cache.get(key);
    if (store.has(step)) return store.get(step);

    // Runs without an F000 file (REFS) start from zero totals at their first step.
    const first = run.steps[0] ?? 0;
    // Only steps with a total since F000 (NBM's 3-hourly steps between its 6 h amounts have none).
    const at = MODELS[model].totalAt;
    const hour = Number(run.id.slice(8, 10));
    const chain = [first, ...K.chain(at ? run.steps.filter((s) => at(s, hour)) : run.steps, step, model).filter((s) => s > first)];
    let start = 0;
    for (let i = chain.length - 1; i > 0; i--) {
      if (store.has(chain[i])) {
        start = i;
        break;
      }
    }

    const load = (s) =>
      this.data.inputs(model, run.id, s, K.needs(model)).then((f) => ({ point: K.point(f), meta: Object.values(f)[0].meta }));
    const pending = new Map();
    const fetchAt = (i) => {
      if (i < chain.length && !pending.has(i)) pending.set(i, load(chain[i]));
      return pending.get(i);
    };

    let prev = await fetchAt(start);
    let acc = start === 0 ? { acc: K.init(prev.meta.ni * prev.meta.nj), meta: prev.meta } : store.get(chain[start]);
    let from = start + 1;
    if (start === 0 && first > 0) {
      // A virtual F000: the first step's conditions with nothing accumulated yet.
      const zero = (a) => a && new Float32Array(a.length);
      prev = { ...prev, point: { ...prev.point, tp: zero(prev.point.tp), sf: zero(prev.point.sf) } };
      from = 0;
    } else if (start === 0) {
      store.set(0, acc);
    }
    for (let i = from; i < chain.length; i++) {
      for (let j = i; j <= i + PREFETCH; j++) fetchAt(j);
      onProgress(i - from, chain.length - from);
      const cur = await fetchAt(i);
      if (i > 0) pending.delete(i - 1);
      if (cancelled()) return null;
      acc = { acc: K.add(acc.acc, prev.point, cur.point), meta: cur.meta };
      store.set(chain[i], acc);
      this.#trim(store);
      prev = cur;
    }
    return acc;
  }

  #trim(store) {
    const bytes = (e) => Object.values(e.acc).reduce((n, a) => n + a.byteLength, 0);
    let total = 0;
    for (const e of store.values()) total += bytes(e);
    for (const [s, e] of store) {
      if (store.size <= CHECKPOINTS || total <= CHECKPOINT_BYTES) break;
      total -= bytes(e);
      store.delete(s);
    }
  }
}
