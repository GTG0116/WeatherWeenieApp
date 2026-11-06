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
   * @param {{scale?: 'linear'|'log', domain?: [number, number], knots?: number[]}} opts
   *   knots: values placed evenly along the scale (up to 16), linear in between,
   *   like a legend labelled 1, 2, 4, 6, 12, 18... at equal spacing
   */
  constructor(stops, { scale = 'linear', domain, knots } = {}) {
    this.rows = Array.isArray(stops[0][0]) ? stops : [stops];
    this.scale = knots ? 'knots' : scale;
    this.knots = knots ?? null;
    const first = this.rows[0];
    this.domain = knots ? [knots[0], knots[knots.length - 1]] : domain ?? [first[0][0], first[first.length - 1][0]];
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
    if (this.knots) {
      const k = this.knots;
      const n = k.length - 1;
      let i = 0;
      while (i < n - 1 && v > k[i + 1]) i++;
      return (i + (v - k[i]) / (k[i + 1] - k[i] || 1)) / n;
    }
    if (this.scale === 'log') {
      const lv = Math.log(Math.max(v, 1e-9));
      return (lv - Math.log(a)) / (Math.log(b) - Math.log(a));
    }
    return (v - a) / (b - a);
  }

  valueAt(t) {
    const [a, b] = this.domain;
    if (this.knots) {
      const k = this.knots;
      const n = k.length - 1;
      const i = Math.max(0, Math.min(n - 1, Math.floor(t * n)));
      return k[i] + (t * n - i) * (k[i + 1] - k[i]);
    }
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

// Dew point, stops in °F (stored in °C): brown when dry, a cream break at 40,
// greens to 60, then blues, indigo and mauve for very humid air.
const F = (f) => ((f - 32) * 5) / 9;
export const DEWPOINT_C = [
  [F(-40), '#c39073'], [F(0), '#514733'], [F(40), '#f8eadf'],
  [F(40), '#d2f4d2'], [F(60), '#0a780a'],
  [F(60), '#63a5bf'], [F(70), '#132a5b'],
  [F(70), '#68689a'], [F(80), '#2c2864'],
  [F(80), '#a57282'], [F(90), '#7b5266'],
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

// Upper-air wind, stops in knots (stored in m/s), 0-150 kt: light blue at the
// edge of a jet, then indigo, orchid, plum, crimson, gold and tan.
const KT = 0.514444;
export const WIND_UPPER_MS = [
  [0, '#1a212a', 0], [16.5 * KT, '#26303b', 0.5], [20 * KT, '#4a6680', 0.9], [25.5 * KT, '#80c6f8', 1],
  [40 * KT, '#6478d2'], [60 * KT, '#d982d0'], [82.5 * KT, '#7a066d'], [105 * KT, '#d73447'],
  [127.5 * KT, '#e8d579'], [150 * KT, '#bb8b5b'],
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

// Snowfall, stops in inches (stored in cm), on evenly spaced knots
// (SNOW_KNOTS_CM): grey under 1", blues to 6", yellow-orange-red to 24",
// maroon to 36", then purple to lavender.
const IN = 2.54; // cm per inch
export const SNOW_KNOTS_CM = [0, 1, 2, 4, 6, 12, 18, 24, 36, 48, 60].map((x) => x * IN);
export const SNOW_CM = [
  [0.05 * IN, '#cfcfcf', 0], [0.3 * IN, '#b5b5b5', 0.85], [0.6 * IN, '#9a9a9a', 1], [1 * IN, '#6a6a6a'],
  [1 * IN, '#bfd0e1'], [2 * IN, '#9db0d2'], [4 * IN, '#4f68b2'], [6 * IN, '#0b2795'],
  [6 * IN, '#ffff96'], [12 * IN, '#ff9605'],
  [12 * IN, '#fd8200'], [18 * IN, '#e02a03'],
  [18 * IN, '#d81202'], [24 * IN, '#9a0000'],
  [24 * IN, '#980000'], [27 * IN, '#8a0000'], [30 * IN, '#690201'], [36 * IN, '#2b002f'],
  [38 * IN, '#360b3e'], [44.4 * IN, '#592f71'], [48 * IN, '#663c85'],
  [48 * IN, '#7d55a6'], [50.9 * IN, '#9278c5'], [55.2 * IN, '#ccc3fa'], [60 * IN, '#d2cafb'],
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

// Precipitation totals (QPF), stops in inches (stored in mm), on evenly spaced
// knots (QPF_KNOTS_MM): grey under 0.1", greens, blues to 1", yellow-orange to 2",
// reds to 4", magenta-lilac-periwinkle to 10", cyan to teal and brown at 20".
const INCH = 25.4;
export const QPF_KNOTS_MM = [0, 0.1, 0.5, 1, 2, 4, 6, 8, 10, 15, 20].map((x) => x * INCH);
export const QPF_MM = [
  [0.01 * INCH, '#c6c6c6', 0], [0.03 * INCH, '#b1b1b1', 0.75], [0.1 * INCH, '#6a6a6a', 1],
  [0.1 * INCH, '#9dc09d'], [0.5 * INCH, '#4b7d47'],
  [0.5 * INCH, '#0b4caa'], [1 * INCH, '#8ab2d4'],
  [1 * INCH, '#f8e62c'], [2 * INCH, '#ff861e'],
  [2 * INCH, '#ff5019'], [4 * INCH, '#8e0527'],
  [4 * INCH, '#ae0767'], [6 * INCH, '#c6b4da'], [8 * INCH, '#aac8e6'], [10 * INCH, '#91a7e5'],
  [10 * INCH, '#4fa0ff'], [12.5 * INCH, '#09ddea'], [15 * INCH, '#2ccccf'],
  [15 * INCH, '#3db9ba'], [17.5 * INCH, '#608c8c'], [20 * INCH, '#3e2e1b'],
];

// Surface visibility, m: the lower, the stronger (1/4, 1, 2, 3, 5 and 7 mi stops)
export const VIS_M = [
  [0, '#5a0a5e', 1], [402, '#b0158f', 1], [805, '#d81b4a'], [1609, '#ee6a22'], [3219, '#f2c12e'],
  [4828, '#8fd14f', 0.85], [8047, '#4fb3a6', 0.55], [11265, '#8fc3dc', 0.25], [16000, '#d8e8f2', 0],
];

// Ensemble probability, %
export const PROB_PCT = [
  [0, '#9fd4ee', 0], [5, '#9fd4ee', 0], [10, '#7cc3ea', 0.8], [20, '#3f9be0', 0.92], [30, '#2b6fc4', 1],
  [40, '#2fae4a'], [50, '#a8d84a'], [60, '#f1d84a'], [70, '#f39a30'], [80, '#e2472b'], [90, '#b81d48'],
  [100, '#8e1a8c'],
];

// Simulated composite reflectivity, dBZ
export const REFLECTIVITY_DBZ = [
  [5, '#5fb3d9', 0], [10, '#4aa3d6', 0.6], [15, '#1e6fd0', 0.85], [20, '#16c437', 0.95], [25, '#0f9e2c', 1],
  [30, '#0a7a20'], [35, '#f5e43a'], [40, '#f2b02c'], [45, '#ee6a22'], [50, '#e0201b'], [55, '#b5121b'],
  [60, '#c2189c'], [65, '#8a2ccc'], [70, '#e6d2f5'], [75, '#ffffff'],
];
