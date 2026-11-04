// Colormaps are lists of [value, color, alpha?] stops in a product's canonical units.
// They're baked into a small RGBA lookup texture sampled by the globe shader.

export const LUT_SIZE = 512;

export function parseColor(c) {
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Evenly distribute a list of colors across [lo, hi]. */
export function spread(colors, lo, hi, alpha = 1) {
  return colors.map((c, i) => [lo + ((hi - lo) * i) / (colors.length - 1), c, alpha]);
}

export class Colormap {
  /**
   * @param {Array<Array<[number,string,number?]>>|Array<[number,string,number?]>} stops
   *   one stop list, or several rows (used for precip type)
   * @param {{scale?: 'linear'|'log', domain?: [number, number]}} opts
   */
  constructor(stops, { scale = 'linear', domain } = {}) {
    this.rows = Array.isArray(stops[0][0]) ? stops : [stops];
    this.scale = scale;
    const first = this.rows[0];
    this.domain = domain ?? [first[0][0], first[first.length - 1][0]];
    this.rgba = new Uint8Array(LUT_SIZE * this.rows.length * 4);
    this.rows.forEach((row, r) => {
      for (let i = 0; i < LUT_SIZE; i++) {
        const v = this.valueAt((i + 0.5) / LUT_SIZE);
        this.rgba.set(evalStops(row, v), (r * LUT_SIZE + i) * 4);
      }
    });
  }

  /** Normalized position in the LUT [0,1] for a value. */
  position(v) {
    const [a, b] = this.domain;
    if (this.scale === 'log') {
      const lv = Math.log(Math.max(v, 1e-9));
      return (lv - Math.log(a)) / (Math.log(b) - Math.log(a));
    }
    return (v - a) / (b - a);
  }

  valueAt(t) {
    const [a, b] = this.domain;
    if (this.scale === 'log') return Math.exp(Math.log(a) + t * (Math.log(b) - Math.log(a)));
    return a + t * (b - a);
  }

  /** RGBA (0-255) for a value, optionally from a specific row. */
  color(v, row = 0) {
    const t = Math.min(1, Math.max(0, this.position(v)));
    const i = Math.min(LUT_SIZE - 1, Math.floor(t * LUT_SIZE));
    const o = (row * LUT_SIZE + i) * 4;
    return this.rgba.subarray(o, o + 4);
  }
}

function evalStops(stops, v) {
  if (v <= stops[0][0]) return rgbaOf(stops[0]);
  const last = stops[stops.length - 1];
  if (v >= last[0]) return rgbaOf(last);
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const t = (v - a[0]) / (b[0] - a[0] || 1);
      const ca = rgbaOf(a);
      const cb = rgbaOf(b);
      return ca.map((x, k) => Math.round(x + (cb[k] - x) * t));
    }
  }
  return rgbaOf(last);
}

function rgbaOf(stop) {
  const [r, g, b] = parseColor(stop[1]);
  return [r, g, b, Math.round((stop[2] ?? 1) * 255)];
}

// ---------------------------------------------------------------------------
// Palettes

export const TEMP_C = [
  [-60, '#f3e9ff'], [-50, '#dcc2f5'], [-40, '#b98ae6'], [-32, '#9156cf'], [-25, '#6a3db5'],
  [-18, '#3f45b0'], [-12, '#2f6cc9'], [-6, '#3a9ad9'], [-1, '#69c6e6'], [0, '#8bd6d6'],
  [4, '#59bf93'], [9, '#69c35a'], [14, '#a8d548'], [19, '#ecd93f'], [24, '#f5ad34'],
  [29, '#ef7a2c'], [34, '#dc4a2b'], [39, '#b52737'], [44, '#8a1640'], [50, '#5a0b33'],
];

export const TEMP_GRADIENT = [
  '#3a1c71', '#4d3bb0', '#3466c7', '#2f95d4', '#43bfc5', '#5fcf8c', '#a4d84f',
  '#ecd93f', '#f5ad34', '#ec732c', '#d6402c', '#a51d3c',
];

export const HEIGHT_GRADIENT = [
  '#4a1486', '#3f37a6', '#2f66c2', '#2f95c9', '#3bbfb0', '#79d27d', '#c4e05e',
  '#f5d64a', '#f7a53a', '#ec6a32', '#d23b2f', '#a51d3c',
];

export const DEWPOINT_C = [
  [-40, '#2e2219'], [-25, '#5a3f2a'], [-15, '#7d5b3a'], [-8, '#9d7a50'], [-2, '#bea374'],
  [3, '#c9c48a'], [7, '#9cc874'], [10, '#5fb35a'], [13, '#2f9e4b'], [16, '#1d8c6e'],
  [18, '#1c7fa3'], [20, '#2a5fc0'], [22, '#4b3fc6'], [24, '#7b33c2'], [26, '#b02fa8'], [28, '#e04f8a'],
];

export const ANOMALY_C = [
  [-20, '#2b0a57'], [-15, '#3b2a9c'], [-10, '#2f5fc4'], [-6, '#4f97dc'], [-3, '#93c6ec'],
  [-1, '#d6e7f3'], [0, '#f2f2f2'], [1, '#f7e0cc'], [3, '#f6b78a'], [6, '#ee7c4f'],
  [10, '#d23d2f'], [15, '#9b1730'], [20, '#5c0a2a'],
];

export const WIND_SFC_MS = [
  [0, '#132744', 0.85], [2, '#1d4e89', 0.9], [4, '#2a7fbf'], [6, '#2fae9f'], [8, '#4cc36a'],
  [10, '#a5d63f'], [12, '#f0d43a'], [15, '#f5a42f'], [18, '#ee6a2c'], [22, '#d63a35'],
  [26, '#b21f5a'], [30, '#8d1c8f'], [35, '#6a2bc4'], [40, '#a77ae8'], [50, '#f2e2ff'],
];

export const WIND_UPPER_MS = [
  [0, '#0d1b2a', 0], [8, '#1b3a5c', 0.2], [13, '#24548a', 0.55], [18, '#2f73b8', 0.85],
  [23, '#3b98d4', 1], [28, '#42c0c4'], [33, '#56d38a'], [38, '#a3dd52'], [43, '#ecd93f'],
  [49, '#f6ab33'], [56, '#ef712d'], [64, '#da3d32'], [72, '#b51f58'], [80, '#8a238f'],
  [90, '#b46ee0'], [100, '#f2d9ff'],
];

export const VORT_E5 = [
  [-30, '#1f3b73', 0.8], [-15, '#2c5aa0', 0.6], [-6, '#4a78b8', 0.3], [-3, '#4a78b8', 0],
  [3, '#f2d23b', 0], [5, '#f4d13c', 0.75], [9, '#f6a530', 0.9], [13, '#ef6b2c', 1],
  [18, '#d9392f'], [25, '#b0174f'], [33, '#7f1f8f'], [42, '#b47ae6'], [55, '#f3dcff'],
];

export const CAPE = [
  [0, '#1d4e35', 0], [100, '#1d4e35', 0], [200, '#2a7148', 0.6], [500, '#3fa35a', 0.85],
  [1000, '#a8d04a', 0.95], [1500, '#f1df4a', 1], [2000, '#f6b23a'], [2500, '#f07a30'],
  [3000, '#e2402f'], [4000, '#b81d4f'], [5000, '#8e2a9e'], [6500, '#e0b0f7'],
];

// Convective inhibition, J/kg (negative)
export const CIN = [
  [-400, '#2a0d47', 0.95], [-250, '#4b2a8a', 0.9], [-150, '#3c5ab4', 0.85], [-100, '#3f8fd0', 0.8],
  [-50, '#7cc4e6', 0.7], [-25, '#bfe6f2', 0.45], [-10, '#e4f4f8', 0], [0, '#ffffff', 0],
];

// Lapse rate, °C/km
export const LAPSE = [
  [4, '#2b4c7e', 0], [5.5, '#3b78b8', 0.35], [6, '#5aa0c8', 0.6], [6.5, '#8fcf8a', 0.85], [7, '#f1e04c', 0.95],
  [7.5, '#f6a531', 1], [8, '#ec6b2b'], [8.5, '#d93a32'], [9, '#b0174f'], [9.8, '#7f1f8f'],
];

// Lifted condensation level, m above ground (low is favourable for tornadoes)
export const LCL_M = [
  [0, '#1f8a46', 0.85], [500, '#7fd34e', 0.85], [1000, '#f1e04c', 0.85], [1500, '#f6a531', 0.85],
  [2000, '#e8502e', 0.85], [2500, '#a8275f', 0.85], [3500, '#4f1e5c', 0.85],
];

// Composite indices (STP)
export const STP = [
  [0, '#0d1b2a', 0], [0.4, '#24548a', 0], [0.6, '#2f73b8', 0.55], [1, '#3fa35a', 0.85], [2, '#f1df4a', 0.95],
  [3, '#f6a531', 1], [4, '#e8502e'], [6, '#c21f3d'], [8, '#9c1a8c'], [10, '#e0b0f7'],
];

// Downdraft CAPE, J/kg
export const DCAPE = [
  [0, '#0d1b2a', 0], [300, '#2f5a8a', 0], [500, '#3f7fb8', 0.6], [700, '#4fb0a8', 0.85], [900, '#8fcf4a', 0.95],
  [1100, '#f1df4a', 1], [1300, '#f6a531'], [1500, '#e8502e'], [1800, '#c21f3d'], [2200, '#9c1a8c'],
];

// Storm-relative helicity, m²/s²
export const SRH = [
  [0, '#0d1b2a', 0], [50, '#2f5a8a', 0], [100, '#3f7fb8', 0.6], [150, '#4fb0a8', 0.85], [200, '#8fcf4a', 0.95],
  [300, '#f1df4a', 1], [400, '#f6a531'], [500, '#e8502e'], [700, '#c21f3d'], [1000, '#9c1a8c'],
];

// Lightning flash density, flashes km⁻² (5 min)⁻¹ (log scale)
export const LIGHTNING = [
  [0.01, '#cfe8ff', 0], [0.03, '#9fd3ff', 0.65], [0.1, '#4aa3d6', 0.9], [0.25, '#3fa35a', 1], [0.5, '#f1df4a'],
  [1, '#f6a531'], [2, '#e8502e'], [4, '#c21f3d'], [8, '#9c1a8c'], [16, '#f3dcff'],
];

export const WIND_SHEAR_MS = [
  [0, '#0d1b2a', 0], [7, '#1b3a5c', 0], [10, '#24548a', 0.45], [13, '#2f73b8', 0.8],
  [15.5, '#3b98d4', 0.95], [18, '#42c0c4', 1], [20.5, '#56d38a'], [23, '#a3dd52'], [25.7, '#ecd93f'],
  [28.3, '#f6ab33'], [31, '#ef712d'], [36, '#da3d32'], [41, '#b51f58'], [51, '#8a238f'], [62, '#e0b0f7'],
];

const IN = 2.54; // cm per inch
export const SNOW_CM = [
  [0.1 * IN, '#cfe3fa', 0], [0.4 * IN, '#cfe3fa', 0.55], [1 * IN, '#9cc3f0', 0.9], [2 * IN, '#6b9fe4', 1],
  [3 * IN, '#4277d6'], [4 * IN, '#2c52bd'], [6 * IN, '#5b3fc2'], [8 * IN, '#8b3fc6'], [12 * IN, '#c04ab9'],
  [18 * IN, '#e2709e'], [24 * IN, '#f19a7d'], [36 * IN, '#f6ca86'], [48 * IN, '#ffffff'],
];

// Freezing rain, liquid equivalent in mm
export const FZRA_MM = [
  [0.2, '#f6c1dc', 0], [0.5, '#f6c1dc', 0.7], [1.27, '#ef8fc0', 0.95], [2.54, '#e05ea6', 1],
  [6.35, '#c2368f'], [12.7, '#93207a'], [19.05, '#6a1468'], [25.4, '#4a0d55'], [40, '#26052f'],
];

// Sleet depth in cm
export const SLEET_CM = [
  [0.05, '#f3d9a4', 0], [0.13, '#f3d9a4', 0.75], [0.25, '#f0b76a', 0.95], [0.64, '#e98a3c', 1],
  [1.27, '#d35f2a'], [2.54, '#a83d2a'], [5.08, '#7a2a4a'], [10, '#4f1e5c'],
];

export const CLOUD = [
  [0, '#ffffff', 0], [10, '#dfe6ee', 0], [30, '#d5dde6', 0.3], [60, '#e6ebf1', 0.6],
  [85, '#f4f7fa', 0.82], [100, '#ffffff', 0.94],
];

// Precip rate rows indexed by precip category: 0 none(=rain), 1 rain, 2 snow, 3 mix, 4 freezing
const RAIN = [
  [0.05, '#1b6b3a', 0], [0.1, '#1f8a46', 0.75], [0.4, '#2fbf4a', 0.9], [1, '#7fd34e', 1],
  [2.5, '#f1e04c'], [5, '#f6a531'], [10, '#e8502e'], [20, '#c21f3d'], [40, '#9c1a8c'], [75, '#f5b6f0'],
];
const SNOW = [
  [0.05, '#1e3f7a', 0], [0.1, '#2c5cb0', 0.75], [0.4, '#3f7fe0', 0.9], [1, '#6aa2ff', 1],
  [2.5, '#9fc4ff'], [5, '#cfe1ff'], [10, '#ffffff'], [75, '#ffffff'],
];
const MIX = [
  [0.05, '#6b2f8f', 0], [0.1, '#7d3aa6', 0.75], [0.4, '#9a4fc8', 0.9], [1, '#b46ee0', 1],
  [2.5, '#cf93f0'], [5, '#e6bdf9'], [75, '#f6e3ff'],
];
const FREEZING = [
  [0.05, '#8a1f4f', 0], [0.1, '#a8275f', 0.75], [0.4, '#cf3f7a', 0.9], [1, '#e86a9a', 1],
  [2.5, '#f59bbd'], [5, '#fcc6dc'], [75, '#ffe6f0'],
];
export const PRECIP_ROWS = [RAIN, RAIN, SNOW, MIX, FREEZING];
export const PRECIP_TYPES = [
  { row: 1, name: 'Rain' },
  { row: 2, name: 'Snow' },
  { row: 3, name: 'Mix' },
  { row: 4, name: 'Freezing' },
];

// Precipitation totals (QPF), liquid equivalent in mm, stops at the usual inch thresholds
const INCH = 25.4;
export const QPF_MM = [
  [0.01 * INCH, '#b9e3b0', 0], [0.03 * INCH, '#9ed69a', 0.7], [0.1 * INCH, '#5cb85c', 0.9],
  [0.25 * INCH, '#2e8b3e', 1], [0.5 * INCH, '#1f5fae'], [0.75 * INCH, '#3f8fd8'], [1 * INCH, '#f2e14c'],
  [1.5 * INCH, '#f5a630'], [2 * INCH, '#e8572b'], [3 * INCH, '#c21f3d'], [4 * INCH, '#9c1a8c'],
  [6 * INCH, '#d38be8'], [10 * INCH, '#f5ddff'],
];

// Simulated composite reflectivity, dBZ
export const REFLECTIVITY_DBZ = [
  [5, '#5fb3d9', 0], [10, '#4aa3d6', 0.6], [15, '#1e6fd0', 0.85], [20, '#16c437', 0.95], [25, '#0f9e2c', 1],
  [30, '#0a7a20'], [35, '#f5e43a'], [40, '#f2b02c'], [45, '#ee6a22'], [50, '#e0201b'], [55, '#b5121b'],
  [60, '#c2189c'], [65, '#8a2ccc'], [70, '#e6d2f5'], [75, '#ffffff'],
];
