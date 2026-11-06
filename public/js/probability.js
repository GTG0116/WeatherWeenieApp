// Ensemble probabilities: the share of an ensemble's members in which a field
// passes a threshold, computed here member by member (see DataSource.#probability).
//
// A probability is asked for like any other field, as the param
// "prob:<kind>:<op><threshold>", e.g. "prob:qpf24:>=25.4" (24-hour precipitation
// of at least 25.4 mm) or "prob:ptype:=2" (snow). Thresholds are in the units the
// kind's value() returns. This module doesn't import the model catalogue (which
// imports it): input choices that depend on the model get a `has(param, level)`.
// Each kind lists the thresholds offered (products.js labels them): for the hour on
// screen they're all counted in one pass, so switching between them is instant.
import { PTYPE_CATEGORY } from './ptype.js';

const map = (src, fn) => {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = fn(src[i], i);
  return out;
};

/** Precipitation (mm) since `hours` earlier, or since F000 without `hours`. */
const precip = (hours, thresholds) => ({
  thresholds,
  inputs: () => (hours ? { tp: { param: 'tp' }, prev: { param: 'tp', stepOffset: -hours } } : { tp: { param: 'tp' } }),
  value: ({ tp, prev }) => map(tp.values, (x, i) => Math.max(0, x - (prev ? prev.values[i] : 0)) * 1000),
});

export const PROB_KINDS = {
  // mm: 0.01, 0.1, 0.25, 0.5, 1, 2, 4 in
  qpf6: precip(6, ['>=0.254', '>=2.54', '>=6.35', '>=12.7', '>=25.4']),
  qpf24: precip(24, ['>=0.254', '>=2.54', '>=6.35', '>=12.7', '>=25.4', '>=50.8']),
  qpftot: precip(0, ['>=2.54', '>=6.35', '>=12.7', '>=25.4', '>=50.8', '>=101.6']),
  /** Snowfall since F000 at 10:1 (cm): published snowfall, or (GEFS) its buckets × the snow flag. */
  snow: {
    thresholds: ['>=2.54', '>=5.08', '>=10.16', '>=15.24', '>=30.48', '>=45.72'], // 1, 2, 4, 6, 12, 18 in
    inputs: (has) => (has('sf') ? { sf: { param: 'sf' } } : has('sfb') ? { sf: { param: 'sfb' } } : null),
    value: ({ sf }) => map(sf.values, (x) => Math.max(0, x) * 1000), // m water -> cm snow at 10:1
  },
  /** 2 m temperature, °C */
  t2m: {
    thresholds: ['<=-17.78', '<=0', '>=26.67', '>=32.22', '>=37.78'], // 0, 32, 80, 90, 100 °F
    inputs: () => ({ t: { param: '2t' } }),
    value: ({ t }) => map(t.values, (x) => x - 273.15),
  },
  /** 850 hPa temperature, °C */
  t850: {
    thresholds: ['<=-10', '<=0', '>=10', '>=20'],
    inputs: () => ({ t: { param: 't', level: 850 } }),
    value: ({ t }) => map(t.values, (x) => x - 273.15),
  },
  /** 10 m wind speed, m/s */
  wind10: {
    thresholds: ['>=8.94', '>=13.41', '>=17.88', '>=22.35'], // 20, 30, 40, 50 mph
    inputs: () => ({ u: { param: '10u' }, v: { param: '10v' } }),
    value: ({ u, v }) => map(u.values, (x, i) => Math.hypot(x, v.values[i])),
  },
  /** 10 m wind gusts, m/s */
  gust: {
    thresholds: ['>=13.41', '>=17.88', '>=22.35', '>=26.82', '>=33.53'], // 30, 40, 50, 60, 75 mph
    inputs: () => ({ g: { param: '10fg' } }),
    value: ({ g }) => g.values,
  },
  /** CAPE, J/kg: the parcel each model publishes (most-unstable first) */
  cape: {
    thresholds: ['>=250', '>=500', '>=1000', '>=2000', '>=3000'],
    inputs: (has) => {
      const p = ['mucape', 'sbcape', 'mlcape'].find((x) => has(x));
      return p ? { c: { param: p } } : null;
    },
    value: ({ c }) => c.values,
  },
  /**
   * Precipitation type where it's precipitating (≥ 0.1 mm/h), as the display
   * category (1 rain, 2 snow, 3 mix / sleet, 4 freezing rain; 0 dry).
   */
  ptype: {
    thresholds: ['=1', '=2', '=3', '=4'],
    inputs: () => ({ ptype: { param: 'ptype' }, rate: { param: 'tprate' } }),
    value: ({ ptype, rate }) =>
      map(ptype.values, (x, i) => (rate.values[i] * 3600 >= 0.1 ? PTYPE_CATEGORY[Math.round(x)] || 1 : 0)),
  },
  /** Visibility, m */
  vis: {
    thresholds: ['<402', '<1609', '<4828', '<8047'], // 1/4, 1, 3, 5 mi
    inputs: () => ({ v: { param: 'vis' } }),
    value: ({ v }) => v.values,
  },
  /** Composite reflectivity, dBZ */
  refc: {
    thresholds: ['>=20', '>=30', '>=40', '>=50'],
    inputs: () => ({ r: { param: 'refc' } }),
    value: ({ r }) => r.values,
  },
};

const PARAM = /^prob:([a-z0-9]+):(<=|>=|<|>|=)(-?\d+(?:\.\d+)?)$/;

/** The probability a param asks for, or null for an ordinary param. */
export function parseProb(param) {
  const m = PARAM.exec(param);
  if (!m || !PROB_KINDS[m[1]]) return null;
  return { id: m[1], kind: PROB_KINDS[m[1]], op: m[2], threshold: Number(m[3]) };
}

/** "prob:<kind>:<option>", where an option is "<op><threshold>" (see products.js). */
export const probParam = (kind, option) => `prob:${kind}:${option}`;

/** A test of one member's value against the threshold. */
export function passes(op, t) {
  switch (op) {
    case '>=': return (v) => v >= t;
    case '<=': return (v) => v <= t;
    case '>': return (v) => v > t;
    case '<': return (v) => v < t;
    default: return (v) => Math.round(v) === t;
  }
}
