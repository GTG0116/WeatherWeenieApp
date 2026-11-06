// Product catalogue: which ECMWF fields each product needs and how they turn
// into a displayable field (canonical units), plus styling.
import {
  ANOMALY_C, CAPE, CIN, CLOUD, Colormap, DCAPE, DEWPOINT_C, FZRA_MM, HEIGHT_GRADIENT, LAPSE, LCL_M, LIGHTNING, PRECIP_ROWS,
  PROB_PCT, QPF_KNOTS_MM, QPF_MM, REFLECTIVITY_DBZ, SLEET_CM, SNOW_CM, SNOW_KNOTS_CM, SRH, STP, TEMP_C, TEMP_GRADIENT, VIS_M, VORT_E5, WIND_SFC_MS,
  WIND_SHEAR_MS, WIND_UPPER_MS, spread,
} from './colormaps.js';
import { climatologyField } from './climatology.js';
import { KINDS } from './accum.js';
import { MODELS, ensembleMembers, supports } from './models.js';
import { lclHeight, stp } from './thermo.js';
import { PTYPE_CATEGORY, PTYPE_NAMES } from './ptype.js';
import { PROB_KINDS, probParam } from './probability.js';

const PARCELS = { sb: 'Surface-based', ml: 'Mixed-layer', mu: 'Most-unstable' };
const PARCEL_OPTIONS = [
  { value: 'sb', label: 'SB' },
  { value: 'ml', label: 'ML' },
  { value: 'mu', label: 'MU' },
];

export const UPPER_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50, 10];
const levelOptions = UPPER_LEVELS.map((l) => ({ value: l, label: String(l) }));

// Approximate standard-atmosphere heights (m), used to pick colour ranges.
const STD_HEIGHT = {
  1000: 110, 925: 760, 850: 1460, 700: 3010, 600: 4200, 500: 5570, 400: 7180,
  300: 9160, 250: 10360, 200: 11790, 150: 13610, 100: 16180, 50: 20580, 10: 31060,
};
const TEMP_RANGE = {
  1000: [-40, 45], 925: [-40, 40], 850: [-40, 35], 700: [-45, 20], 600: [-50, 10], 500: [-55, 0],
  400: [-60, -10], 300: [-70, -25], 250: [-70, -30], 200: [-75, -35], 150: [-80, -40],
  100: [-90, -45], 50: [-85, -40], 10: [-90, -10],
};

const heightInterval = (lvl) => (lvl >= 700 ? 3 : lvl >= 400 ? 6 : lvl >= 100 ? 12 : 24);
// Typical extreme height anomaly (dam) per level, for the colour range.
const HEIGHT_ANOM_RANGE = {
  1000: 15, 925: 15, 850: 15, 700: 20, 600: 25, 500: 30, 400: 35, 300: 40, 250: 40, 200: 40,
  150: 40, 100: 40, 50: 50, 10: 80,
};
const SHEAR_LAYERS = {
  sfc500: { label: '10 m–500 hPa (≈0–6 km)', levels: [null, 500] },
  sfc700: { label: '10 m–700 hPa (≈0–3 km)', levels: [null, 700] },
  '850-200': { label: '850–200 hPa (deep layer)', levels: [850, 200] },
};
const windAt = (level, comp) => (level ? { param: comp, level } : { param: `10${comp}` });

const map = (src, fn) => {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = fn(src[i], i);
  return out;
};
const speed = (u, v) => map(u, (x, i) => Math.sqrt(x * x + v[i] * v[i]));
const toDam = (gh) => map(gh, (x) => x / 10);
const kToC = (t) => map(t, (x) => x - 273.15);

const heightContour = (inp, lvl) => ({ values: toDam(inp.gh.values), interval: heightInterval(lvl), unit: 'dam' });
export const isobarContour = (inp) => (inp.msl ? { values: map(inp.msl.values, (x) => x / 100), interval: 4, unit: 'hPa' } : null);

const cmCache = new Map();
const cm = (key, make) => {
  if (!cmCache.has(key)) cmCache.set(key, make());
  return cmCache.get(key);
};

const fmtInt = (v) => String(Math.round(v));
const fmtPrecip = (v, units) => (units === 'imperial' ? v.toFixed(2) : v.toFixed(1));
const note = (model, key) => (MODELS[model].notes?.[key] ? `, ${MODELS[model].notes[key]}` : '');
const fhour = (h) => 'F' + String(h).padStart(3, '0');

const QPF_HOURS = [1, 3, 6, 12, 24, 48, 72];

/**
 * Why a precipitation total since F000 (or over the past `hours`) can't be shown at
 * a step, or null. Interval totals need the step `hours` earlier to be published
 * too, and a model with `totalAt` (NBM) only has totals at some steps.
 */
function totalsCheck(hours, step, run, model) {
  const at = MODELS[model]?.totalAt;
  if (at && !at(step, run.hour)) return `${MODELS[model].name} has no total ending at ${fhour(step)}: past 48 h its amounts are 6-hourly`;
  if (!hours) return null;
  if (step < hours) return `${hours}-hour totals start at ${fhour(hours)}`;
  if (step === hours) return null; // totals are zero at F000
  if (at && !at(step - hours, run.hour)) return `No ${hours}-hour total at ${fhour(step)}: past 48 h ${MODELS[model].name} totals are 6-hourly`;
  if (run.steps.includes(step - hours)) return null;
  if (run.expected.includes(step - hours)) return `${fhour(step - hours)} isn't published yet, so no ${hours}-hour total`;
  const gap = step - Math.max(...run.expected.filter((s) => s < step));
  return `No ${hours}-hour total at ${fhour(step)}: steps are ${gap}-hourly here`;
}
const totalsOnly = (opt, step, run, model) => totalsCheck(0, step, run, model);

export { PTYPE_CATEGORY, PTYPE_NAMES };

export const PRODUCTS = [
  // ---------------------------------------------------------------- upper air
  {
    id: 'wind',
    group: 'upper',
    name: 'Wind',
    title: (lvl) => `${lvl} hPa wind speed & heights`,
    options: levelOptions,
    defaultOption: 250,
    unit: 'windUpper',
    inputs: (lvl) => ({ u: { param: 'u', level: lvl }, v: { param: 'v', level: lvl }, gh: { param: 'gh', level: lvl } }),
    compute: (inp, { option }) => ({
      field: speed(inp.u.values, inp.v.values),
      vectors: { u: inp.u.values, v: inp.v.values },
      contour: heightContour(inp, option),
    }),
    colormap: () => cm('wind-upper', () => new Colormap(WIND_UPPER_MS)),
    particles: true,
    particleSpeed: 0.3, // jet-level winds are 3-4x surface speeds; keep the motion readable
    contourTheme: 'dark',
    lineTheme: 'light',
    format: fmtInt,
    legendStep: { imperial: 20, metric: 20 },
  },
  {
    id: 'vort',
    group: 'upper',
    name: 'Vorticity',
    title: (lvl) => `${lvl} hPa relative vorticity & heights`,
    options: levelOptions,
    defaultOption: 500,
    unit: 'vort',
    inputs: (lvl) => ({ vo: { param: 'vo', level: lvl }, gh: { param: 'gh', level: lvl } }),
    compute: (inp, { option }) => ({
      field: map(inp.vo.values, (x) => x * 1e5),
      contour: heightContour(inp, option),
    }),
    colormap: () => cm('vort', () => new Colormap(VORT_E5)),
    contourTheme: 'light',
    lineTheme: 'light',
    format: fmtInt,
    legendTicks: () => [-30, -15, -5, 0, 5, 10, 15, 20, 30, 40, 50],
  },
  {
    id: 'height',
    group: 'upper',
    name: 'Height',
    title: (lvl) => `${lvl} hPa geopotential height`,
    options: levelOptions,
    defaultOption: 500,
    unit: 'height',
    inputs: (lvl) => ({ gh: { param: 'gh', level: lvl } }),
    compute: (inp, { option }) => {
      const contour = heightContour(inp, option);
      return { field: contour.values, contour };
    },
    colormap: (lvl) =>
      cm(`height-${lvl}`, () => {
        const std = STD_HEIGHT[lvl] / 10;
        const half = Math.round((0.07 * STD_HEIGHT[lvl] + 300) / 10);
        return new Colormap(spread(HEIGHT_GRADIENT, std - half, std + half, 0.95));
      }),
    contourTheme: 'dark',
    lineTheme: 'dark',
    format: fmtInt,
  },
  {
    id: 'temp',
    group: 'upper',
    name: 'Temperature',
    title: (lvl) => `${lvl} hPa temperature & heights`,
    options: levelOptions,
    defaultOption: 850,
    unit: 'temp',
    inputs: (lvl) => ({ t: { param: 't', level: lvl }, gh: { param: 'gh', level: lvl } }),
    compute: (inp, { option }) => ({
      field: kToC(inp.t.values),
      contour: heightContour(inp, option),
      iso: TEMP_RANGE[option][0] < 0 && TEMP_RANGE[option][1] > 0 ? 0 : null,
    }),
    colormap: (lvl) =>
      cm(`temp-${lvl}`, () => {
        const [lo, hi] = TEMP_RANGE[lvl];
        return lvl >= 850 ? new Colormap(TEMP_C, { domain: [lo, hi] }) : new Colormap(spread(TEMP_GRADIENT, lo, hi, 0.95));
      }),
    contourTheme: 'dark',
    lineTheme: 'dark',
    format: fmtInt,
  },
  {
    id: 'tanom',
    group: 'upper',
    name: 'Temperature anomaly',
    title: (lvl) => `${lvl} hPa temperature anomaly (vs 1991–2020) & heights`,
    options: levelOptions,
    defaultOption: 850,
    unit: 'tempDelta',
    inputs: (lvl) => ({ t: { param: 't', level: lvl }, gh: { param: 'gh', level: lvl } }),
    compute: async (inp, { option, validTime }) => {
      const clim = await climatologyField('air', inp.t.meta, option, validTime);
      return {
        field: map(inp.t.values, (x, i) => x - 273.15 - clim[i]),
        contour: heightContour(inp, option),
      };
    },
    colormap: () => cm('tanom', () => new Colormap(ANOMALY_C)),
    contourTheme: 'dark',
    lineTheme: 'dark',
    format: (v) => (v > 0 ? '+' : '') + Math.round(v),
    legendTicks: (units) => (units === 'imperial' ? [-30, -20, -10, -5, 0, 5, 10, 20, 30] : [-20, -15, -10, -5, 0, 5, 10, 15, 20]),
  },

  {
    id: 'hanom',
    group: 'upper',
    name: 'Height anomaly',
    title: (lvl) => `${lvl} hPa height anomaly (vs 1991–2020) & heights`,
    options: levelOptions,
    defaultOption: 500,
    unit: 'height',
    inputs: (lvl) => ({ gh: { param: 'gh', level: lvl } }),
    compute: async (inp, { option, validTime }) => {
      const clim = await climatologyField('hgt', inp.gh.meta, option, validTime);
      return {
        field: map(inp.gh.values, (x, i) => (x - clim[i]) / 10),
        contour: heightContour(inp, option),
      };
    },
    colormap: (lvl) =>
      cm(`hanom-${lvl}`, () => new Colormap(ANOMALY_C.map(([v, c, a]) => [(v * HEIGHT_ANOM_RANGE[lvl]) / 20, c, a]))),
    contourTheme: 'dark',
    lineTheme: 'dark',
    format: (v) => (v > 0 ? '+' : '') + Math.round(v),
  },
  {
    id: 'shear',
    group: 'upper',
    name: 'Wind shear',
    title: (opt) => `${SHEAR_LAYERS[opt].label} bulk wind shear`,
    options: [
      { value: 'sfc500', label: 'Sfc–500' },
      { value: 'sfc700', label: 'Sfc–700' },
      { value: '850-200', label: '850–200' },
    ],
    defaultOption: 'sfc500',
    unit: 'windUpper',
    inputs: (opt) => {
      const [lo, hi] = SHEAR_LAYERS[opt].levels;
      return { ul: windAt(lo, 'u'), vl: windAt(lo, 'v'), uh: windAt(hi, 'u'), vh: windAt(hi, 'v') };
    },
    compute: (inp) => ({
      field: map(inp.uh.values, (x, i) => {
        const du = x - inp.ul.values[i];
        const dv = inp.vh.values[i] - inp.vl.values[i];
        return Math.sqrt(du * du + dv * dv);
      }),
    }),
    colormap: () => cm('shear', () => new Colormap(WIND_SHEAR_MS)),
    contourTheme: 'light',
    lineTheme: 'light',
    format: fmtInt,
  },

  // ---------------------------------------------------------------- surface
  {
    id: 't2m',
    group: 'surface',
    name: 'Temperature',
    title: () => '2 m temperature',
    unit: 'temp',
    inputs: () => ({ t: { param: '2t' } }),
    compute: (inp) => ({ field: kToC(inp.t.values), iso: 0 }),
    colormap: () => cm('t2m', () => new Colormap(TEMP_C, { domain: [-45, 50] })),
    contourTheme: 'dark',
    lineTheme: 'dark',
    cityValues: true,
    isobars: true,
    format: (v) => `${Math.round(v)}°`,
  },
  {
    id: 'td2m',
    group: 'surface',
    name: 'Dew point',
    title: () => '2 m dew point',
    unit: 'temp',
    inputs: () => ({ td: { param: '2d' } }),
    compute: (inp) => ({ field: kToC(inp.td.values) }),
    colormap: () => cm('td2m', () => new Colormap(DEWPOINT_C)),
    contourTheme: 'dark',
    lineTheme: 'dark',
    cityValues: true,
    isobars: true,
    format: (v) => `${Math.round(v)}°`,
  },
  {
    id: 'wind10',
    group: 'surface',
    name: 'Wind speed',
    title: () => '10 m wind speed',
    unit: 'windSfc',
    inputs: () => ({ u: { param: '10u' }, v: { param: '10v' } }),
    compute: (inp) => ({ field: speed(inp.u.values, inp.v.values), vectors: { u: inp.u.values, v: inp.v.values } }),
    colormap: () => cm('wind10', () => new Colormap(WIND_SFC_MS)),
    particles: true,
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    isobars: true,
    format: fmtInt,
  },
  {
    id: 'gust',
    group: 'surface',
    name: 'Wind gusts',
    title: (opt, model) => (model === 'ifs' || model === 'ens' ? '10 m wind gusts (max, previous 3 h)' : '10 m wind gusts'),
    unit: 'windSfc',
    inputs: () => ({ g: { param: '10fg' } }),
    compute: (inp) => ({ field: inp.g.values }),
    colormap: () => cm('wind10', () => new Colormap(WIND_SFC_MS)),
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    isobars: true,
    format: fmtInt,
  },
  {
    id: 'precip',
    group: 'surface',
    name: 'Precip rate & type',
    title: (opt, model) => {
      const n = MODELS[model].notes ?? {};
      return `Precipitation rate${n.tprate ? ` (${n.tprate})` : ''} & type${n.ptype ? ` (${n.ptype})` : ''}`;
    },
    unit: 'rate',
    inputs: () => ({ rate: { param: 'tprate' }, ptype: { param: 'ptype' } }),
    compute: (inp) => {
      const field = map(inp.rate.values, (x) => x * 3600);
      const types = map(inp.ptype.values, (x, i) => {
        const c = PTYPE_CATEGORY[Math.round(x)] ?? 1;
        return c === 0 && field[i] > 0.05 ? 1 : c;
      });
      return { field, types };
    },
    colormap: () => cm('precip', () => new Colormap(PRECIP_ROWS, { scale: 'log', domain: [0.05, 75] })),
    precipLegend: true,
    contourTheme: 'light',
    lineTheme: 'light',
    cityMin: 0.05, // mm/h; dry towns get no value
    isobars: true,
    isobarsDefault: true,
    format: fmtPrecip,
    legendTicks: (units) => (units === 'imperial' ? [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2] : [0.1, 0.5, 1, 2.5, 5, 10, 25, 50]),
  },
  {
    id: 'cloud',
    group: 'surface',
    name: 'Cloud cover',
    title: (opt) => `${{ tcc: 'Total', lcc: 'Low', mcc: 'Mid-level', hcc: 'High' }[opt]} cloud cover`,
    options: [
      { value: 'tcc', label: 'Total' },
      { value: 'lcc', label: 'Low' },
      { value: 'mcc', label: 'Mid' },
      { value: 'hcc', label: 'High' },
    ],
    defaultOption: 'tcc',
    unit: 'percent',
    inputs: (opt) => ({ c: { param: opt } }),
    compute: (inp) => ({ field: map(inp.c.values, (x) => x * 100) }),
    colormap: () => cm('cloud', () => new Colormap(CLOUD)),
    contourTheme: 'light',
    lineTheme: 'light',
    isobars: true,
    format: fmtInt,
    legendTicks: () => [10, 25, 50, 75, 100],
  },

  {
    id: 'refc',
    group: 'surface',
    name: 'Reflectivity',
    title: (opt, model) => `Simulated composite reflectivity${note(model, 'refc')}`,
    unit: 'dbz',
    inputs: () => ({ r: { param: 'refc' } }),
    compute: (inp) => ({ field: inp.r.values }),
    colormap: () => cm('refc', () => new Colormap(REFLECTIVITY_DBZ)),
    contourTheme: 'light',
    lineTheme: 'light',
    cityMin: 5,
    isobars: true,
    format: fmtInt,
    legendTicks: () => [10, 20, 30, 40, 50, 60, 70],
  },
  {
    id: 'vis',
    group: 'surface',
    name: 'Visibility',
    title: () => 'Surface visibility',
    unit: 'vis',
    inputs: () => ({ v: { param: 'vis' } }),
    compute: (inp) => ({ field: inp.v.values }),
    colormap: () => cm('vis', () => new Colormap(VIS_M)),
    contourTheme: 'light',
    lineTheme: 'light',
    cityMax: 8047, // m (5 mi); good visibility gets no value
    isobars: true,
    format: (v) => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : String(Math.round(v))),
    legendTicks: (units) => (units === 'imperial' ? [0.25, 0.5, 1, 2, 3, 5, 7] : [0.4, 1, 2, 3, 5, 8, 11]),
  },

  // ---------------------------------------------------------------- severe weather
  {
    id: 'cape',
    group: 'severe',
    name: 'CAPE',
    title: (opt, model) => (model === 'icon' ? 'CAPE' : `${PARCELS[opt]} CAPE`),
    options: PARCEL_OPTIONS,
    defaultOption: 'mu',
    optionsTitle: 'Parcel ',
    unit: 'cape',
    inputs: (opt) => ({ cape: { param: `${opt}cape` } }),
    compute: (inp) => ({ field: inp.cape.values }),
    colormap: () => cm('cape', () => new Colormap(CAPE)),
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    cityMin: 100,
    isobars: true,
    format: (v) => String(Math.round(v / 10) * 10),
    legendTicks: () => [500, 1000, 2000, 3000, 4000, 5000, 6000],
  },
  {
    id: 'cin',
    group: 'severe',
    name: 'CIN',
    title: (opt) => `${PARCELS[opt]} convective inhibition`,
    options: PARCEL_OPTIONS,
    defaultOption: 'ml',
    optionsTitle: 'Parcel ',
    unit: 'cape',
    inputs: (opt) => ({ cin: { param: `${opt}cin` } }),
    compute: (inp) => ({ field: map(inp.cin.values, (x) => Math.min(0, x)) }),
    colormap: () => cm('cin', () => new Colormap(CIN)),
    contourTheme: 'light',
    lineTheme: 'light',
    cityMax: -10, // J/kg; hide negligible inhibition
    isobars: true,
    format: fmtInt,
    legendTicks: () => [-300, -200, -100, -50, -25],
  },
  {
    id: 'lapse',
    group: 'severe',
    name: 'Lapse rate',
    title: (opt) => `${opt.replace('-', '–')} hPa lapse rate`,
    options: [
      { value: '700-500', label: '700–500' },
      { value: '850-500', label: '850–500' },
    ],
    defaultOption: '700-500',
    optionsTitle: 'Layer ',
    unit: 'lapse',
    inputs: (opt) => {
      const [lo, hi] = opt.split('-').map(Number);
      return { tl: { param: 't', level: lo }, th: { param: 't', level: hi }, zl: { param: 'gh', level: lo }, zh: { param: 'gh', level: hi } };
    },
    compute: (inp) => ({
      field: map(inp.tl.values, (x, i) => ((x - inp.th.values[i]) / (inp.zh.values[i] - inp.zl.values[i])) * 1000),
    }),
    colormap: () => cm('lapse', () => new Colormap(LAPSE)),
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    format: (v) => v.toFixed(1),
    legendTicks: () => [5, 6, 7, 8, 9],
  },
  {
    id: 'lcl',
    group: 'severe',
    name: 'LCL height',
    title: () => 'Surface-based LCL height (from 2 m temperature & dew point)',
    unit: 'heightAgl',
    inputs: () => ({ t: { param: '2t' }, td: { param: '2d' } }),
    compute: (inp) => ({ field: map(inp.t.values, (x, i) => lclHeight(x, inp.td.values[i])) }),
    colormap: () => cm('lcl', () => new Colormap(LCL_M)),
    contourTheme: 'light',
    lineTheme: 'dark',
    cityValues: true,
    isobars: true,
    format: (v) => String(Math.round(v / 50) * 50),
    legendTicks: (units) => (units === 'imperial' ? [1000, 2000, 3000, 4000, 6000, 8000, 10000] : [250, 500, 1000, 1500, 2000, 2500, 3000]),
  },
  {
    id: 'stp',
    group: 'severe',
    name: 'Sig. tornado (STP)',
    title: () => 'Significant tornado parameter (fixed layer: SBCAPE, SB LCL, 0–1 km SRH, 0–6 km shear)',
    unit: 'index',
    inputs: () => ({
      cape: { param: 'sbcape' },
      t: { param: '2t' },
      td: { param: '2d' },
      srh: { param: 'srh1' },
      us: { param: 'ush6' },
      vs: { param: 'vsh6' },
    }),
    compute: (inp) => ({
      field: map(inp.cape.values, (c, i) =>
        stp(c, lclHeight(inp.t.values[i], inp.td.values[i]), inp.srh.values[i], Math.hypot(inp.us.values[i], inp.vs.values[i])),
      ),
    }),
    colormap: () => cm('stp', () => new Colormap(STP)),
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    cityMin: 0.5,
    isobars: true,
    format: (v) => v.toFixed(1),
    legendTicks: () => [1, 2, 3, 4, 6, 8, 10],
  },
  {
    id: 'srh',
    group: 'severe',
    name: 'Helicity (SRH)',
    title: (opt) => `${opt === 'srh1' ? '0–1' : '0–3'} km storm-relative helicity`,
    options: [
      { value: 'srh1', label: '0–1 km' },
      { value: 'srh3', label: '0–3 km' },
    ],
    defaultOption: 'srh3',
    optionsTitle: 'Layer ',
    unit: 'srh',
    inputs: (opt) => ({ s: { param: opt } }),
    compute: (inp) => ({ field: inp.s.values }),
    colormap: () => cm('srh', () => new Colormap(SRH)),
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    cityMin: 50,
    isobars: true,
    format: (v) => String(Math.round(v / 10) * 10),
    legendTicks: () => [100, 200, 300, 400, 500, 700],
  },
  {
    id: 'dcape',
    group: 'severe',
    name: 'DCAPE',
    title: () => 'Downdraft CAPE (computed from pressure levels)',
    unit: 'cape',
    inputs: () => ({ d: { param: 'dcape' } }),
    compute: (inp) => ({ field: inp.d.values }),
    colormap: () => cm('dcape', () => new Colormap(DCAPE)),
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    cityMin: 300,
    isobars: true,
    format: (v) => String(Math.round(v / 10) * 10),
    legendTicks: () => [500, 800, 1100, 1400, 1800],
  },
  {
    id: 'ltng',
    group: 'severe',
    name: 'Lightning',
    title: (opt, model) => `Lightning flash density${note(model, 'ltng')}`,
    unit: 'flash',
    inputs: () => ({ l: { param: 'ltng' } }),
    compute: (inp) => ({ field: inp.l.values }),
    colormap: () => cm('ltng', () => new Colormap(LIGHTNING, { scale: 'log', domain: [0.01, 16] })),
    contourTheme: 'light',
    lineTheme: 'light',
    cityMin: 0.01,
    isobars: true,
    format: (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)),
    legendTicks: () => [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8],
  },

  // ---------------------------------------------------------------- precipitation (QPF)
  {
    id: 'qpf',
    group: 'precip',
    name: 'Total precipitation',
    title: (opt) => (opt === 'total' ? 'Total precipitation since F000 (QPF)' : `${opt}-hour precipitation (QPF)`),
    options: [{ value: 'total', label: 'Run total' }, ...QPF_HOURS.map((h) => ({ value: h, label: `${h} h` }))],
    defaultOption: 'total',
    optionsTitle: 'Period ',
    unit: 'ice',
    inputs: (opt) => (opt === 'total' ? { tp: { param: 'tp' } } : { tp: { param: 'tp' }, prev: { param: 'tp', stepOffset: -opt } }),
    check: (opt, step, run, model) => totalsCheck(opt === 'total' ? 0 : opt, step, run, model),
    compute: (inp) => {
      const prev = inp.prev?.values;
      return { field: map(inp.tp.values, (x, i) => Math.max(0, x - (prev ? prev[i] : 0)) * 1000) }; // m -> mm
    },
    colormap: () => cm('qpf', () => new Colormap(QPF_MM, { knots: QPF_KNOTS_MM })),
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    cityMin: 0.25, // mm; hide trace amounts
    isobars: true,
    format: fmtPrecip,
    legendTicks: (units) => (units === 'imperial' ? [0.1, 0.5, 1, 2, 4, 6, 8, 10, 15] : [2.5, 10, 25, 50, 100, 150, 200, 250, 380]),
  },

  // ---------------------------------------------------------------- winter (accumulated since F000)
  {
    id: 'snow10',
    group: 'winter',
    name: 'Snowfall (10:1)',
    title: (opt, model) =>
      MODELS[model].notes?.sf
        ? `Total snowfall (${MODELS[model].notes.sf})`
        : `Total snowfall, 10:1 ratio${supports(model, 'sf') ? '' : ', snow share from precip type'}`,
    unit: 'snow',
    check: totalsOnly,
    inputs: () => ({ sf: { param: 'sf' } }),
    compute: (inp) => ({ field: map(inp.sf.values, (x) => Math.max(0, x) * 1000) }), // m water -> cm snow
    // Models without a snowfall field: precipitation where the type is snow.
    accumulation: (model) => (supports(model, 'sf') ? null : 'ptype'),
    select: (acc) => acc.sn, // mm water -> cm snow at 10:1
    ...snowStyle(),
  },
  {
    id: 'snowku',
    group: 'winter',
    name: 'Snowfall (Kuchera)',
    title: () => 'Total snowfall, Kuchera ratio',
    unit: 'snow',
    check: totalsOnly,
    accumulation: 'kuchera',
    select: (acc) => acc.snow,
    ...snowStyle(),
  },
  {
    id: 'fzra',
    group: 'winter',
    name: 'Freezing rain',
    title: (opt, model) => `Total freezing rain (liquid equivalent)${note(model, 'ptype')}`,
    unit: 'ice',
    check: totalsOnly,
    accumulation: 'ptype',
    select: (acc) => acc.zr,
    cityMin: 0.25, // mm; hide trace amounts
    colormap: () => cm('fzra', () => new Colormap(FZRA_MM, { scale: 'log', domain: [0.2, 40] })),
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    format: fmtPrecip,
    legendTicks: (units) => (units === 'imperial' ? [0.01, 0.05, 0.1, 0.25, 0.5, 1] : [0.5, 1, 2.5, 5, 10, 20]),
  },
  {
    id: 'sleet',
    group: 'winter',
    name: 'Sleet',
    title: (opt, model) => `Total sleet (3:1 depth)${note(model, 'ptype')}`,
    unit: 'snow',
    check: totalsOnly,
    accumulation: 'ptype',
    select: (acc) => map(acc.ip, (x) => (x * 3) / 10), // mm liquid -> cm sleet at 3:1
    cityMin: 0.12, // cm
    colormap: () => cm('sleet', () => new Colormap(SLEET_CM, { scale: 'log', domain: [0.05, 10] })),
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    format: (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)),
    legendTicks: (units) => (units === 'imperial' ? [0.05, 0.1, 0.25, 0.5, 1, 2] : [0.1, 0.25, 0.5, 1, 2.5, 5]),
  },
];

// ---------------------------------------------------------------- ensemble probabilities
const OPS = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '=': '' };
const splitOption = (o) => {
  const [, op, v] = /^(<=|>=|<|>|=)(.*)$/.exec(o);
  return [op, Number(v)];
};
const trim = (x, digits) => String(Number(x.toFixed(digits)));
// Threshold labels per kind, in display units: [pill label, phrase for the title].
const PROB_LABELS = {
  precip: (mm, units) => (units === 'imperial' ? `${trim(mm / 25.4, 2)}"` : `${mm < 1 ? trim(mm, 2) : mm < 10 ? trim(mm, 1) : Math.round(mm)} mm`),
  snow: (cm, units) => (units === 'imperial' ? `${Math.round(cm / 2.54)}"` : `${cm < 10 ? trim(cm, 1) : Math.round(cm)} cm`),
  temp: (c, units) => (units === 'imperial' ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`),
  tempC: (c) => `${Math.round(c)}°C`,
  wind: (ms, units) => (units === 'imperial' ? `${Math.round(ms * 2.23694)} mph` : `${Math.round(ms * 3.6)} km/h`),
  cape: (v) => `${v} J/kg`,
  vis: (m, units) => (units === 'imperial' ? `${m < 1000 ? '¼' : Math.round(m / 1609.344)} mi` : `${trim(m / 1000, 1)} km`),
  dbz: (v) => `${v} dBZ`,
};
const PTYPE_OPTION_NAMES = { 1: 'Rain', 2: 'Snow', 3: 'Mix / sleet', 4: 'Freezing rain' };

/**
 * A probability product: the share of an ensemble's members passing each of a
 * kind's thresholds (see probability.js), shown for every ensemble whatever member is picked.
 * @param {(phrase: string) => string} what title text around the threshold, e.g. (t) => `${t} of precipitation in 24 h`
 */
function probProduct({ id, kind, name, label, what, defaultOption, showOp = false, check }) {
  const opLabel = (o, units) => {
    const [op, v] = splitOption(o);
    return kind === 'ptype' ? PTYPE_OPTION_NAMES[v] : `${showOp ? `${OPS[op]} ` : ''}${PROB_LABELS[label](v, units)}`;
  };
  const phrase = (o, units) => {
    const [op, v] = splitOption(o);
    return kind === 'ptype' ? PTYPE_OPTION_NAMES[v].toLowerCase() : `${OPS[op]} ${PROB_LABELS[label](v, units)}`;
  };
  return {
    id,
    group: 'prob',
    name,
    prob: true,
    title: (opt, model, units) => `Chance of ${what(phrase(opt, units))} (${ensembleMembers(model).length} members)`,
    options: PROB_KINDS[kind].thresholds.map((value) => ({ value, label: (units) => opLabel(value, units) })),
    defaultOption,
    optionsTitle: kind === 'ptype' ? 'Type ' : 'Threshold ',
    unit: 'percent',
    check,
    inputs: (opt) => ({ p: { param: probParam(kind, opt) } }),
    compute: (inp) => ({ field: inp.p.values }),
    colormap: () => cm('prob', () => new Colormap(PROB_PCT)),
    contourTheme: 'light',
    lineTheme: 'light',
    cityMin: 5,
    format: fmtInt,
    legendTicks: () => [10, 20, 30, 40, 50, 60, 70, 80, 90],
  };
}

PRODUCTS.push(
  probProduct({
    id: 'pqpf6', kind: 'qpf6', name: '6 h precip', label: 'precip', defaultOption: '>=2.54',
    what: (t) => `${t} of precipitation in 6 h`,
    check: (opt, step, run, model) => totalsCheck(6, step, run, model),
  }),
  probProduct({
    id: 'pqpf24', kind: 'qpf24', name: '24 h precip', label: 'precip', defaultOption: '>=12.7',
    what: (t) => `${t} of precipitation in 24 h`,
    check: (opt, step, run, model) => totalsCheck(24, step, run, model),
  }),
  probProduct({
    id: 'pqpftot', kind: 'qpftot', name: 'Total precip', label: 'precip', defaultOption: '>=25.4',
    what: (t) => `${t} of precipitation since F000`,
  }),
  probProduct({
    id: 'psnow', kind: 'snow', name: 'Snowfall (10:1)', label: 'snow', defaultOption: '>=15.24',
    what: (t) => `${t} of snow (10:1) since F000`,
  }),
  probProduct({
    id: 'pptype', kind: 'ptype', name: 'Precip type', defaultOption: '=2',
    what: (t) => `${t} (where precipitating)`,
  }),
  probProduct({
    id: 'pt2m', kind: 't2m', name: '2 m temperature', label: 'temp', showOp: true, defaultOption: '<=0',
    what: (t) => `2 m temperature ${t}`,
  }),
  probProduct({
    id: 'pt850', kind: 't850', name: '850 hPa temp', label: 'tempC', showOp: true, defaultOption: '<=0',
    what: (t) => `850 hPa temperature ${t}`,
  }),
  probProduct({
    id: 'pwind', kind: 'wind10', name: 'Wind speed', label: 'wind', defaultOption: '>=13.41',
    what: (t) => `10 m wind ${t}`,
  }),
  probProduct({
    id: 'pgust', kind: 'gust', name: 'Wind gusts', label: 'wind', defaultOption: '>=17.88',
    what: (t) => `10 m gusts ${t}`,
  }),
  probProduct({
    id: 'pcape', kind: 'cape', name: 'CAPE', label: 'cape', defaultOption: '>=1000',
    what: (t) => `CAPE ${t}`,
  }),
  probProduct({
    id: 'pvis', kind: 'vis', name: 'Visibility', label: 'vis', showOp: true, defaultOption: '<1609',
    what: (t) => `visibility ${t}`,
  }),
  probProduct({
    id: 'prefc', kind: 'refc', name: 'Reflectivity', label: 'dbz', defaultOption: '>=40',
    what: (t) => `composite reflectivity ${t}`,
  }),
);

function snowStyle() {
  return {
    colormap: () => cm('snow', () => new Colormap(SNOW_CM, { knots: SNOW_KNOTS_CM })),
    contourTheme: 'light',
    lineTheme: 'light',
    cityValues: true,
    cityMin: 0.25, // cm; hide trace amounts
    format: (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v))),
    legendTicks: (units) => (units === 'imperial' ? [1, 2, 4, 6, 12, 18, 24, 36, 48] : [2.5, 5, 10, 15, 30, 45, 60, 90, 120]),
  };
}

export const productById = Object.fromEntries(PRODUCTS.map((p) => [p.id, p]));

/** The accumulation kind a product uses for a model, or null for direct fields. */
export function accumulationOf(p, model) {
  return typeof p.accumulation === 'function' ? p.accumulation(model) : p.accumulation ?? null;
}

/** Whether a model (or one ensemble member) can show a product: for the given option, or for any of them. */
export function productAvailable(p, model, opt, member) {
  if (opt === undefined && p.options) return p.options.some((o) => productAvailable(p, model, o.value, member));
  const kind = accumulationOf(p, model);
  const spec = kind ? KINDS[kind].needs(model) : p.inputs(opt);
  return Object.values(spec).every((s) => supports(model, s.param, s.level, member));
}
