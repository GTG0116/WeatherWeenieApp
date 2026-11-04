// Radar product catalogue: where each product comes from (Level III product
// codes per radar type and tilt, or a Level II moment) and how it's drawn.
// Values are in canonical units (dBZ, m/s, dB, °/km, mm, km, kg/m²); see units.js.
import { Colormap, QPF_MM } from '../colormaps.js';

// Hydrometeor classes (Level III codes 10..140 in steps of 10).
export const HC_CLASSES = [
  [10, 'BI', 'Biological', '#9c9c9c'],
  [20, 'GC', 'Ground clutter / AP', '#6b6b6b'],
  [30, 'IC', 'Ice crystals', '#f2a6f2'],
  [40, 'DS', 'Dry snow', '#5fb6ff'],
  [50, 'WS', 'Wet snow', '#2a5ce6'],
  [60, 'RA', 'Light / moderate rain', '#78f078'],
  [70, 'HR', 'Heavy rain', '#16a32e'],
  [80, 'BD', 'Big drops', '#f2e33a'],
  [90, 'GR', 'Graupel', '#e8a64a'],
  [100, 'HA', 'Hail, possibly with rain', '#f0281e'],
  [110, 'LH', 'Large hail', '#a0102a'],
  [120, 'GH', 'Giant hail', '#ff52d4'],
  [130, '—', 'Unused', '#000000'],
  [140, 'UK', 'Unknown', '#7a3cd6'],
];
const hcByCode = Object.fromEntries(HC_CLASSES.map((c) => [c[0], c]));

// Precipitation type: reflectivity coloured by the latest HRRR's forecast-hour-1
// surface precipitation type (LUT row; see main.js). Outside the HRRR domain
// the type is unknown.
export const PTYPE_ROWS = [
  { row: 1, name: 'Rain' },
  { row: 2, name: 'Snow' },
  { row: 3, name: 'Sleet' },
  { row: 4, name: 'Frz rain' },
  { row: 5, name: 'Unknown' },
];
export const PTYPE_UNKNOWN = 5;
const PTYPE_NAMES = ['', 'Rain', 'Snow', 'Sleet / mix', 'Freezing rain', 'Unknown (outside the HRRR)'];

const REF = [
  [-10, '#3c3c50', 0], [0, '#4a5470', 0.0], [5, '#56809c', 0.45], [10, '#5ea6c4', 0.7], [15, '#3d84d6', 0.85],
  [20, '#16c437', 0.95], [25, '#0f9e2c', 1], [30, '#0a7a20'], [35, '#f5e43a'], [40, '#f2b02c'], [45, '#ee6a22'],
  [50, '#e0201b'], [55, '#b5121b'], [60, '#8c0c14'], [65, '#f06ef0'], [70, '#a24fe0'], [75, '#ffffff'], [80, '#c8c8c8'],
];
// Precip type: reflectivity in a palette per type (rows match PTYPE_ROWS).
const PT_RAIN = [
  [5, '#56809c', 0.4], [10, '#5ea6c4', 0.7], [15, '#3d84d6', 0.85], [20, '#16c437', 0.95], [25, '#0f9e2c', 1],
  [30, '#0a7a20'], [35, '#f5e43a'], [40, '#f2b02c'], [45, '#ee6a22'], [50, '#e0201b'], [55, '#b5121b'],
  [60, '#8c0c14'], [65, '#f06ef0'], [75, '#ffffff'],
];
const PT_SNOW = [
  [5, '#b4dcff', 0.4], [10, '#8cc4f8', 0.7], [15, '#5c9cec', 0.9], [20, '#3470d8', 1], [25, '#2448b8'],
  [30, '#3a2c9e'], [35, '#6a2cb4'], [45, '#c050d0'], [75, '#ffd8ff'],
];
const PT_SLEET = [
  [5, '#ffdcb0', 0.4], [10, '#ffc078', 0.7], [20, '#ff9a3c', 0.95], [30, '#f2701c', 1], [40, '#c84a10'],
  [50, '#8c2a08'], [75, '#ffe6c8'],
];
const PT_FZRA = [
  [5, '#f6c8e0', 0.4], [10, '#f2a2cc', 0.7], [20, '#e266ac', 0.95], [30, '#c4348e', 1], [40, '#941c74'],
  [50, '#6a0e58'], [75, '#ffd8f0'],
];
const PT_UNKNOWN = [[5, '#465060', 0.3], [15, '#58616e', 0.55], [30, '#737b87', 0.75], [45, '#9aa1aa', 0.85], [60, '#c4c9cf', 0.9], [75, '#eeeeee']];
// Radial velocity, m/s: inbound (negative) green, outbound red.
const VEL = [
  [-60, '#f0fff0'], [-45, '#8cff8c'], [-35, '#2ee65a'], [-25, '#0eb43c'], [-15, '#0a8030'], [-6, '#1f5a35'],
  [-1, '#3d4a42'], [0, '#4a4a4a'], [1, '#4a3d3d'], [6, '#6a1c1c'], [15, '#a01414'], [25, '#dc1e1e'],
  [35, '#ff5a3c'], [45, '#ff9e6e'], [60, '#ffeccc'],
];
const CC = [
  [0.2, '#16163a'], [0.45, '#262690'], [0.6, '#2f62d4'], [0.7, '#36acd8'], [0.8, '#36c886'], [0.85, '#8fdc48'],
  [0.9, '#f2e33a'], [0.93, '#f5a530'], [0.95, '#ec6a2a'], [0.97, '#d6302a'], [0.99, '#9a1458'], [1.02, '#f0b4f0'],
  [1.05, '#ffffff'],
];
const ZDR = [
  [-4, '#303030'], [-2, '#5c5c78'], [-0.5, '#9c9cc4'], [0, '#c8c8c8'], [0.5, '#56b8e6'], [1, '#2fcca6'],
  [1.5, '#3cc03c'], [2, '#aee040'], [2.5, '#f2e33a'], [3, '#f5a530'], [4, '#e5321f'], [5, '#bc1450'],
  [6, '#f070f0'], [8, '#ffffff'],
];
// Specific differential phase, °/km: near zero is noise, so it fades out there.
const KDP = [
  [-2, '#7a4ab0'], [-0.5, '#50506a', 0.6], [0, '#5a6a7e', 0.15], [0.25, '#5c6c80', 0.3], [0.5, '#3a90c0', 0.8],
  [1, '#36c886', 1], [2, '#aee040'], [3, '#f2e33a'], [4, '#f5a530'], [5, '#e5321f'], [7, '#bc1450'],
  [10, '#f6f6f6'],
];
const SW = [
  [0, '#1e2638', 0], [1, '#2c3a58', 0.55], [2, '#3a5a86', 0.85], [4, '#3a90c0', 1], [6, '#3cc080'],
  [8, '#aee040'], [10, '#f2e33a'], [12, '#f5a530'], [15, '#e5321f'], [20, '#f6f6f6'],
];
const EET_KM = [
  [0, '#1e3050', 0], [1, '#284878', 0.6], [3, '#2f78c0', 0.85], [5, '#36acd8', 1], [7, '#36c886'],
  [9, '#aee040'], [11, '#f2e33a'], [13, '#f5a530'], [15, '#e5321f'], [17, '#bc1450'], [19, '#f070f0'],
  [21.3, '#ffffff'],
];
const VIL = [
  [0, '#1e3050', 0], [0.5, '#284878', 0], [1, '#2f62a8', 0.6], [5, '#36acd8', 0.9], [10, '#36c886', 1],
  [20, '#aee040'], [30, '#f2e33a'], [40, '#f5a530'], [50, '#e5321f'], [60, '#bc1450'], [70, '#f070f0'],
  [80, '#ffffff'],
];

const HC_STOPS = HC_CLASSES.flatMap(([c, , , color]) => [[c - 5, color], [c + 4.99, color]]);

const cache = new Map();
const cmap = (key, stops, opts) => () => {
  if (!cache.has(key)) cache.set(key, new Colormap(stops, opts));
  return cache.get(key);
};

const fmt = (digits) => (v) => v.toFixed(digits);
const signed = (v) => (v > 0 ? '+' : '') + Math.round(v);
const fmtPrecip = (v, units) => (units === 'imperial' ? v.toFixed(2) : v.toFixed(1));

// Level III tilts, lowest first: N0 (0.5°), NA, N1, NB, N2, N3 (≈3.1–3.4°).
const TILT_PREFIXES = ['N0', 'NA', 'N1', 'NB', 'N2', 'N3'];
const tilts = (letter) => TILT_PREFIXES.map((t) => t + letter);
// Super-res velocity at the three lowest tilts, then the 1° product (no super-res up there).
const VEL_TILTS = [...tilts('G').slice(0, 3), 'NBU', 'N2U', 'N3U'];
// Nominal angles, until a scan tells us the radar's own.
export const NOMINAL_TILTS = { 'WSR-88D': [0.5, 0.9, 1.3, 1.8, 2.4, 3.1], TDWR: [0.3, 1, 3.7] };

export const RADAR_GROUPS = [
  ['reflectivity', 'Reflectivity'],
  ['velocity', 'Velocity'],
  ['dualpol', 'Dual-pol'],
  ['precip', 'Precipitation totals'],
  ['derived', 'Derived'],
];

const VEL_TICKS = (u) => (u === 'imperial' ? [-100, -60, -30, 0, 30, 60, 100] : [-50, -30, -15, 0, 15, 30, 50]);
const PRECIP_TICKS = (u) => (u === 'imperial' ? [0.05, 0.1, 0.25, 0.5, 1, 2, 4] : [1, 2.5, 5, 10, 25, 50, 100]);
const HC_TICKS = () => HC_CLASSES.filter((c) => c[1] !== '—').map((c) => c[0]);
const hcFormat = (v) => hcByCode[Math.round(v / 10) * 10]?.[2] ?? '—';
const hcLabel = (v) => hcByCode[v]?.[1] ?? '';

/**
 * src: per radar type, { l3: [code per tilt] } or { l2: moment, tilts: n }.
 * `pair` is a product fetched alongside (the storm motion for SRV); `legacy`
 * the Level III codes of the legacy-resolution (1°) version of a dual-pol
 * product. Products a radar type doesn't publish are greyed out.
 */
export const RADAR_PRODUCTS = [
  {
    id: 'ref', group: 'reflectivity', name: 'Reflectivity', short: 'REF',
    src: { 'WSR-88D': { l3: tilts('B') }, TDWR: { l3: ['TZ0', 'TZ1', 'TZ2'] } },
    unit: 'dbz', colormap: cmap('ref', REF), format: (v) => v.toFixed(1),
    legendTicks: () => [0, 10, 20, 30, 40, 50, 60, 70],
  },
  {
    id: 'ptype', group: 'reflectivity', name: 'Precipitation type', short: 'PTYPE',
    src: { 'WSR-88D': { l3: tilts('B') }, TDWR: { l3: ['TZ0', 'TZ1', 'TZ2'] } }, hrrrTypes: true,
    unit: 'dbz', colormap: cmap('ptype', [PT_RAIN, PT_RAIN, PT_SNOW, PT_SLEET, PT_FZRA, PT_UNKNOWN], { domain: [5, 75] }),
    format: (v) => v.toFixed(1), typeRows: PTYPE_ROWS, typeName: (row) => PTYPE_NAMES[row] ?? '', fixedColors: true,
    legendTicks: () => [10, 20, 30, 40, 50, 60, 70],
  },
  {
    id: 'vel', group: 'velocity', name: 'Velocity', short: 'VEL', folds: true,
    src: { 'WSR-88D': { l3: VEL_TILTS }, TDWR: { l3: ['TV0', 'TV1', 'TV2'] } },
    unit: 'radialVel', colormap: cmap('vel', VEL), format: signed, legendTicks: VEL_TICKS,
  },
  {
    // Super-res velocity minus the storm motion of the radar's legacy SRM (N0S) of the same volume.
    id: 'srv', group: 'velocity', name: 'Storm relative velocity', short: 'SRV', folds: true,
    src: { 'WSR-88D': { l3: VEL_TILTS, pair: 'N0S' } },
    unit: 'radialVel', colormap: cmap('vel', VEL), format: signed, legendTicks: VEL_TICKS,
  },
  {
    id: 'sw', group: 'velocity', name: 'Spectrum width', short: 'SW', folds: true,
    src: { 'WSR-88D': { l2: 'SW ', tilts: 6 } },
    unit: 'radialVel', colormap: cmap('sw', SW), format: (v) => String(Math.round(v)),
    legendTicks: (u) => (u === 'imperial' ? [5, 10, 15, 20, 30] : [2, 4, 6, 8, 10, 15]),
  },
  {
    id: 'cc', group: 'dualpol', name: 'Correlation coefficient', short: 'CC',
    src: { 'WSR-88D': { l2: 'RHO', tilts: 6, legacy: tilts('C') } },
    unit: 'ratio', colormap: cmap('cc', CC), format: fmt(2),
    legendTicks: () => [0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 1],
  },
  {
    id: 'zdr', group: 'dualpol', name: 'Differential reflectivity', short: 'ZDR',
    src: { 'WSR-88D': { l2: 'ZDR', tilts: 6, legacy: tilts('X') } },
    unit: 'db', colormap: cmap('zdr', ZDR), format: fmt(1),
    legendTicks: () => [-3, -1, 0, 1, 2, 3, 4, 6],
  },
  {
    id: 'kdp', group: 'dualpol', name: 'Specific differential phase', short: 'KDP',
    // Super-res KDP is computed here from Level II PhiDP (with rho-hv and reflectivity).
    src: { 'WSR-88D': { l2: 'PHI', extra: ['RHO', 'REF'], derive: 'kdp', tilts: 6, legacy: tilts('K') } },
    unit: 'kdp', colormap: cmap('kdp', KDP), format: fmt(1),
    legendTicks: () => [-1, 0, 1, 2, 3, 4, 5, 7],
  },
  {
    id: 'hc', group: 'dualpol', name: 'Hydrometeor classification', short: 'HC', classes: true,
    src: { 'WSR-88D': { l3: tilts('H') } },
    unit: 'hc', colormap: cmap('hc', HC_STOPS, { domain: [5, 145] }), format: hcFormat,
    legendTicks: HC_TICKS, legendLabel: hcLabel,
  },
  {
    id: 'hhc', group: 'dualpol', name: 'Hybrid hydrometeor classification', short: 'HHC', classes: true,
    src: { 'WSR-88D': { l3: ['HHC'] } },
    unit: 'hc', colormap: cmap('hc', HC_STOPS, { domain: [5, 145] }), format: hcFormat,
    legendTicks: HC_TICKS, legendLabel: hcLabel,
  },
  {
    id: 'p1h', group: 'precip', name: '1-hour precipitation', short: '1H', precip: true,
    src: { 'WSR-88D': { l3: ['DAA'] } },
    unit: 'ice', colormap: cmap('qpf', QPF_MM, { scale: 'log' }), format: fmtPrecip, legendTicks: PRECIP_TICKS,
  },
  {
    id: 'p3h', group: 'precip', name: '3-hour precipitation', short: '3H', precip: true,
    src: { 'WSR-88D': { l3: ['DU3'] } },
    unit: 'ice', colormap: cmap('qpf', QPF_MM, { scale: 'log' }), format: fmtPrecip, legendTicks: PRECIP_TICKS,
  },
  {
    id: 'pst', group: 'precip', name: 'Storm total precipitation', short: 'STP', precip: true,
    src: { 'WSR-88D': { l3: ['DTA'] } },
    unit: 'ice', colormap: cmap('qpf', QPF_MM, { scale: 'log' }), format: fmtPrecip, legendTicks: PRECIP_TICKS,
  },
  {
    id: 'eet', group: 'derived', name: 'Enhanced echo tops', short: 'EET',
    src: { 'WSR-88D': { l3: ['EET'] } },
    unit: 'echoTop', colormap: cmap('eet', EET_KM), format: (v) => String(Math.round(v)),
    legendTicks: (u) => (u === 'imperial' ? [10, 20, 30, 40, 50, 60] : [3, 6, 9, 12, 15, 18]),
  },
  {
    id: 'vil', group: 'derived', name: 'Vertically integrated liquid', short: 'VIL',
    src: { 'WSR-88D': { l3: ['DVL'] }, TDWR: { l3: ['NVL'] } },
    unit: 'vil', colormap: cmap('vil', VIL), format: (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v))),
    legendTicks: () => [5, 10, 20, 30, 40, 50, 60, 70],
  },
];
export const radarProductById = Object.fromEntries(RADAR_PRODUCTS.map((p) => [p.id, p]));

// Uploaded colour tables replace a product's colormap (and its fixed legend ticks).
const custom = new Map();
for (const p of RADAR_PRODUCTS) {
  const base = p.colormap;
  const ticks = p.legendTicks;
  p.colormap = () => custom.get(p.id) ?? base();
  p.legendTicks = (...a) => (custom.has(p.id) ? undefined : ticks?.(...a));
}
/** Use a custom colormap for a product (null restores the default). */
export function setCustomColormap(id, colormap) {
  if (colormap) custom.set(id, colormap);
  else custom.delete(id);
}
export const hasCustomColormap = (id) => custom.has(id);

/** Whether a product has a legacy-resolution version at a radar type. */
export const hasLegacy = (product, type) => !!product.src[type]?.legacy;

function srcFor(product, type, res) {
  const s = product.src[type];
  return s && res === 'legacy' && s.legacy ? { l3: s.legacy } : s;
}

/** Number of tilts a product has for a radar type (0 = not published). */
export function tiltCount(product, type, res = 'super') {
  const s = srcFor(product, type, res);
  return !s ? 0 : s.l3 ? s.l3.length : s.tilts ?? 1;
}

/**
 * Where a product comes from for a radar type, tilt and resolution:
 * { level: 3, code, pair? } / { level: 2, moment, extra?, derive?, tilt } / null.
 */
export function sourceOf(product, type, tilt = 0, res = 'super') {
  const s = srcFor(product, type, res);
  if (!s) return null;
  const t = Math.max(0, Math.min(tilt, tiltCount(product, type, res) - 1));
  if (s.l3) return { level: 3, code: s.l3[t], pair: s.pair, tilt: t };
  return { level: 2, moment: s.l2, extra: s.extra, derive: s.derive, tilt: t };
}
