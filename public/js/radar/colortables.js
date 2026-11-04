// Custom radar colour tables. Reads the GR2Analyst / RadarScope palette format
// (".pal": Color / Color4 / SolidColor / SolidColor4 lines, Units, Scale,
// Offset, RF) and plain "value r g b [a]" lists (spaces or commas), turns them
// into a Colormap in the product's canonical units, and keeps uploads in
// localStorage so they survive a reload.
import { Colormap } from '../colormaps.js';
import { radarProductById, setCustomColormap } from './products.js';

const STORE_KEY = 'model-globe-radar-tables-v1';

// Palette units → factor to the canonical unit of the product.
const UNIT_FACTORS = {
  KTS: 0.514444, KT: 0.514444, KNOTS: 0.514444, MPH: 0.44704, 'KM/H': 1 / 3.6, KPH: 1 / 3.6,
  MS: 1, 'M/S': 1, MPS: 1,
  IN: 25.4, INCH: 25.4, INCHES: 25.4, MM: 1, CM: 10,
  KFT: 0.3048, FT: 0.0003048, KM: 1, M: 0.001,
};

const hex = (r, g, b) => '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');

/**
 * Parse a colour table.
 * @returns {{colormap: Colormap, entries: number}}
 */
export function parseColorTable(text) {
  let scale = null;
  let offset = 0;
  let unitFactor = null;
  let rf = null;
  const entries = []; // {v, c1: [r,g,b,a], c2?: [r,g,b,a], solid}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, '').replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1].toLowerCase();
      const nums = kv[2].split(/[\s,]+/).filter(Boolean).map(Number);
      if (key === 'scale') scale = nums[0] || null;
      else if (key === 'offset') offset = nums[0] || 0;
      else if (key === 'units') unitFactor = UNIT_FACTORS[kv[2].trim().toUpperCase()] ?? null;
      else if (key === 'rf') rf = nums.slice(0, 3);
      else if (/^(solid)?color4?$/.test(key)) {
        const alpha = key.endsWith('4');
        const n = alpha ? 4 : 3;
        if (nums.length < 1 + n || nums.some((x) => !Number.isFinite(x))) continue;
        const col = (i) => [nums[i], nums[i + 1], nums[i + 2], alpha ? nums[i + 3] : 255];
        entries.push({ v: nums[0], c1: col(1), c2: nums.length >= 1 + 2 * n ? col(1 + n) : null, solid: key.startsWith('solid') });
      }
      continue;
    }
    // Plain "value r g b [a]"
    const nums = line.split(/[\s,]+/).filter(Boolean).map(Number);
    if (nums.length >= 4 && nums.every(Number.isFinite)) {
      entries.push({ v: nums[0], c1: [nums[1], nums[2], nums[3], nums[4] ?? 255], c2: null, solid: false });
    }
  }
  if (entries.length < 2) throw new Error('No colour entries found (expected "Color: value r g b" lines)');

  // Palette values → canonical units: GR's Scale/Offset take precedence over Units.
  const toCanonical = scale ? (x) => (x - offset) / scale : unitFactor ? (x) => x * unitFactor : (x) => x;
  entries.forEach((e) => (e.v = toCanonical(e.v)));
  entries.sort((a, b) => a.v - b.v);

  const span = entries[entries.length - 1].v - entries[0].v;
  const eps = span * 1e-4 || 1e-4;
  const stops = [[entries[0].v - eps, hex(...entries[0].c1), 0]]; // below the table: transparent
  entries.forEach((e, i) => {
    const next = entries[i + 1];
    stops.push([e.v, hex(...e.c1), e.c1[3] / 255]);
    if (!next) return;
    const end = e.solid ? e.c1 : e.c2 ?? next.c1;
    // A hard edge at the next value unless the gradient runs straight into it.
    if (e.solid || e.c2) stops.push([next.v - eps, hex(...end), end[3] / 255]);
  });
  const colormap = new Colormap(stops, { domain: [stops[0][0], entries[entries.length - 1].v] });
  if (rf) colormap.rfColor = rf.map((x) => x / 255);
  return { colormap, entries: entries.length };
}

// ------------------------------------------------------------------ storage
function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // storage full or unavailable: the table still applies this session
  }
}

/** Re-apply the tables saved in earlier sessions. */
export function restoreColorTables() {
  const store = readStore();
  for (const [id, { text }] of Object.entries(store)) {
    const p = radarProductById[id];
    if (!p) continue;
    try {
      setCustomColormap(id, parseColorTable(text).colormap);
    } catch {
      delete store[id];
    }
  }
  writeStore(store);
}

/** Apply and remember a table for a product; throws if it can't be read. */
export function saveColorTable(id, name, text) {
  const { colormap, entries } = parseColorTable(text);
  setCustomColormap(id, colormap);
  const store = readStore();
  store[id] = { name, text };
  writeStore(store);
  return entries;
}

export function resetColorTable(id) {
  setCustomColormap(id, null);
  const store = readStore();
  delete store[id];
  writeStore(store);
}

export const colorTableName = (id) => readStore()[id]?.name ?? null;
