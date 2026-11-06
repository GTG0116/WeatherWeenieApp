// HTML label overlay: town names (optionally with a model value above each
// name) and contour value labels, decluttered in screen space every frame.
// Towns come from tools/build-places.mjs: the bigger places load at start and
// small ones in 5° tiles once the map is zoomed in on their area.
import { toLatLon, toXYZ } from './globe.js';

const MAX_CITY_LABELS = 700; // a safety net for the DOM; collisions normally limit it first
const MAX_CONTOUR_LABELS = 28;
const CELL = 48;
// A town that was on screen keeps its place against towns up to this many
// ranks more important, so a small pan can't knock out a town in plain view.
const STICKY_RANKS = 1.5;
const TILE_ALTITUDE = 0.3; // load small-town tiles below this camera altitude
const MAX_TILES = 400;

// Zoomed out, stick to bigger places so the globe isn't a wall of text; zoomed
// in, show down to villages (rank 13 is a few hundred people).
const RANK_BY_ALTITUDE = [[2, 2], [1.2, 4], [0.7, 6], [0.4, 7], [0.22, 9], [0.12, 10], [0.07, 11], [0.04, 12]];
const maxRankAt = (alt) => RANK_BY_ALTITUDE.find(([a]) => alt > a)?.[1] ?? 13;

export class LabelLayer {
  constructor(container, globe) {
    this.container = container;
    this.globe = globe;
    this.cities = []; // always loaded, most important first
    this.tiles = new Map(); // small towns: tile key -> places (most important first) | null while loading
    this.tileIndex = null;
    this.countries = {};
    this.shown = new Set(); // towns placed in the last update
    this.contours = [];
    this.valueFn = null;
    this.pool = [];
    this.dirty = true;
    globe.on('frame', (moved) => {
      if (moved || this.dirty) this.update();
    });
  }

  #town([name, lat, lon, rank, pop, cc, region]) {
    return { name, lat, lon, rank, pop, country: this.countries[cc] ?? cc, region, xyz: toXYZ(lat, lon), w: name.length * 6.4 + 10 };
  }

  /** Load the town list (see tools/build-places.mjs). */
  async loadPlaces(dir = 'data/geo/places') {
    const [major, index] = await Promise.all([
      fetch(`${dir}/major.json`).then((r) => r.json()),
      fetch(`${dir}/tiles.json`).then((r) => r.json()),
    ]);
    this.countries = major.countries;
    this.cities = major.places.map((p) => this.#town(p));
    this.tileDir = `${dir}/t`;
    this.tileSize = index.size;
    this.tileIndex = new Set(index.tiles);
    this.dirty = true;
    this.globe.dirty = true;
  }

  /** Fetch the small-town tiles under the view (sampled on a grid of screen points). */
  #loadTiles() {
    clearTimeout(this.tileTimer);
    if (!this.tileIndex || this.globe.altitude > TILE_ALTITUDE) return;
    const now = performance.now();
    if (now - (this.tileCheck ?? 0) < 200) {
      // Moving: check again once things settle.
      this.tileTimer = setTimeout(() => this.#loadTiles(), 220);
      return;
    }
    this.tileCheck = now;
    const size = this.tileSize;
    const want = new Set();
    for (let y = 0; y <= 8; y++) {
      for (let x = 0; x <= 10; x++) {
        const ll = this.globe.pickNdc(x / 5 - 1, y / 4 - 1);
        if (!ll) continue;
        const la = Math.floor(ll.lat / size) * size;
        const lo = Math.floor(ll.lon / size) * size;
        // The tile under each sample plus its neighbours, so towns at the edges are ready.
        for (const dla of [-size, 0, size]) {
          for (const dlo of [-size, 0, size]) {
            const lon = ((lo + dlo + 540) % 360) - 180;
            const key = `${la + dla}_${lon}`;
            if (this.tileIndex.has(key)) want.add(key);
          }
        }
      }
    }
    for (const key of want) {
      if (this.tiles.has(key)) {
        // refresh LRU position
        const v = this.tiles.get(key);
        this.tiles.delete(key);
        this.tiles.set(key, v);
        continue;
      }
      this.tiles.set(key, null);
      fetch(`${this.tileDir}/${key}.json`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((list) => {
          if (!this.tiles.has(key)) return;
          this.tiles.set(key, list.map((p) => this.#town(p)));
          this.dirty = true;
          this.globe.dirty = true;
        })
        .catch(() => this.tiles.delete(key));
    }
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value);
  }

  /** fn(lat, lon) -> {text, bg, fg} | null */
  setValueFn(fn) {
    this.valueFn = fn;
    this.dirty = true;
    this.globe.dirty = true;
  }

  /** @param {{lat:number, lon:number, text:string, tier:number}[]} list */
  setContourLabels(list) {
    this.contours = list.map((c) => ({ ...c, xyz: toXYZ(c.lat, c.lon), w: c.text.length * 6.6 + 6 }));
    this.dirty = true;
    this.globe.dirty = true;
  }

  #el(i) {
    while (this.pool.length <= i) {
      const el = document.createElement('div');
      el.className = 'lbl';
      el.innerHTML = '<span class="v"></span><span class="n"></span>';
      this.container.appendChild(el);
      this.pool.push({ el, v: el.firstChild, n: el.lastChild, key: '', vText: '', vBg: '', kind: '' });
    }
    return this.pool[i];
  }

  update() {
    this.dirty = false;
    const g = this.globe;
    const cam = g.camera;
    cam.updateMatrixWorld();
    const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
    const cx = cam.position.x;
    const cy = cam.position.y;
    const cz = cam.position.z;
    const camLen = Math.hypot(cx, cy, cz);
    const minDot = 1 / camLen + 0.012;
    const W = g.width;
    const H = g.height;
    const grid = new Map();
    let n = 0;

    const ext = g.ext;
    const project = ext
      ? (xyz) => {
          const ll = toLatLon(...xyz);
          const s = ext.project(ll.lat, ll.lon);
          if (!s || s[0] < -20 || s[1] < -20 || s[0] > W + 20 || s[1] > H + 20) return null;
          return s;
        }
      : (xyz) => {
      const [x, y, z] = xyz;
      if ((x * cx + y * cy + z * cz) / camLen < minDot) return null;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * W;
      const sy = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5 * H;
      if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) return null;
      return [sx, sy];
    };

    const fits = (x0, y0, x1, y1) => {
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
        for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
          const boxes = grid.get(gx * 4096 + gy);
          if (!boxes) continue;
          for (const b of boxes) if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) return false;
        }
      }
      return true;
    };
    const occupy = (box) => {
      for (let gx = Math.floor(box[0] / CELL); gx <= Math.floor(box[2] / CELL); gx++) {
        for (let gy = Math.floor(box[1] / CELL); gy <= Math.floor(box[3] / CELL); gy++) {
          const k = gx * 4096 + gy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(box);
        }
      }
    };

    let contourCount = 0;
    const placeContour = (c) => {
      if (contourCount >= MAX_CONTOUR_LABELS) return;
      const s = project(c.xyz);
      if (!s) return;
      // Generous padding keeps contour labels sparse.
      const pad = 34;
      const box = [s[0] - c.w / 2 - pad, s[1] - 8 - pad / 2, s[0] + c.w / 2 + pad, s[1] + 8 + pad / 2];
      if (!fits(...box)) return;
      occupy([s[0] - c.w / 2 - 3, s[1] - 9, s[0] + c.w / 2 + 3, s[1] + 9]);
      contourCount++;
      const item = this.#el(n++);
      if (item.kind !== 'c') {
        item.kind = 'c';
        item.el.className = 'lbl contour';
        item.v.textContent = '';
        item.v.style.display = 'none';
        item.vText = '';
      }
      if (item.key !== c.text) {
        item.key = c.text;
        item.n.textContent = c.text;
      }
      item.el.style.transform = `translate(${s[0].toFixed(1)}px, ${s[1].toFixed(1)}px) translate(-50%, -50%)`;
    };

    const alt = g.altitude;
    const maxRank = maxRankAt(alt);
    const withValues = !!this.valueFn;
    if (alt <= TILE_ALTITUDE) this.#loadTiles();

    // Candidate towns on screen. Lists are sorted by rank, so each stops early.
    const cands = [];
    const consider = (list) => {
      for (const c of list) {
        if (c.rank > maxRank) break;
        const s = project(c.xyz);
        if (s) cands.push({ c, s, key: c.rank - (this.shown.has(c) ? STICKY_RANKS : 0) });
      }
    };
    consider(this.cities);
    if (maxRank > 8) for (const list of this.tiles.values()) if (list) consider(list);
    cands.sort((a, b) => a.key - b.key || b.c.pop - a.c.pop);

    // Towns are placed first, with boxes that don't depend on the data, so the
    // set of visible towns depends only on the camera and stays put while
    // stepping through forecast hours. Contour labels fill in the gaps.
    const valueW = 5 * 7.6 + 12; // room for the widest expected value, e.g. "-12°"
    const shown = new Set();
    for (const { c, s } of cands) {
      if (n >= MAX_CITY_LABELS) break;
      const w = Math.max(c.w, withValues ? valueW : 0);
      const h = withValues ? 38 : 20;
      const box = [s[0] - w / 2 - 3, s[1] - h - 2, s[0] + w / 2 + 3, s[1] + 4];
      if (!fits(...box)) continue;
      occupy(box);
      shown.add(c);
      const val = withValues ? this.valueFn(c.lat, c.lon) : null;
      const item = this.#el(n++);
      if (item.kind !== 'city') {
        item.kind = 'city';
        item.el.className = 'lbl city';
      }
      if (item.key !== c) {
        item.key = c;
        item.n.textContent = c.name;
        item.el.title = [c.name, c.region, c.country].filter(Boolean).join(', ');
      }
      if (val) {
        if (item.vText !== val.text) {
          item.vText = val.text;
          item.v.textContent = val.text;
        }
        if (item.vBg !== val.bg) {
          item.vBg = val.bg;
          item.v.style.background = val.bg;
          item.v.style.color = val.fg;
        }
        item.v.style.display = '';
      } else if (item.vText !== '' || item.v.style.display !== 'none') {
        item.vText = '';
        item.v.style.display = 'none';
      }
      item.el.style.transform = `translate(${s[0].toFixed(1)}px, ${s[1].toFixed(1)}px) translate(-50%, -100%)`;
    }
    this.shown = shown;

    for (const c of this.contours) placeContour(c);

    for (let i = n; i < this.pool.length; i++) {
      if (this.pool[i].kind !== 'hidden') {
        this.pool[i].kind = 'hidden';
        this.pool[i].el.className = 'lbl hidden';
        this.pool[i].key = '';
      }
    }
  }
}

/**
 * Candidate positions for contour labels: where each contour crosses a set of
 * meridians. Coarser meridian sets get lower tiers (placed first).
 */
export function contourLabelCandidates(values, meta, interval, format) {
  const out = [];
  const { ni, nj, lat0, lon0, dlat, dlon } = meta;
  const tiers = [30, 15, 7.5, 3.75, 1.875];
  const seen = new Set();
  tiers.forEach((spacing, tier) => {
    for (let lon = -180 + spacing / 2; lon < 180; lon += spacing) {
      const key = lon.toFixed(3);
      if (seen.has(key)) continue;
      seen.add(key);
      let i;
      if (meta.regional) {
        i = Math.round((((lon - lon0) % 360) + 360) % 360 / dlon);
        if (i > ni - 1) continue;
      } else {
        i = Math.round((lon - lon0) / dlon) % ni;
        if (i < 0) i += ni;
      }
      // Rows between 78°S and 78°N, whichever way the grid runs.
      const ja = Math.round((78 - lat0) / dlat);
      const jb = Math.round((-78 - lat0) / dlat);
      const jStart = Math.max(0, Math.min(ja, jb));
      const jEnd = Math.min(nj - 1, Math.max(ja, jb));
      let prev = values[jStart * ni + i];
      for (let j = jStart + 3; j <= jEnd; j += 3) {
        const v = values[j * ni + i];
        if (!Number.isFinite(v) || !Number.isFinite(prev)) {
          prev = v;
          continue;
        }
        const a = Math.floor(prev / interval);
        const b = Math.floor(v / interval);
        if (a !== b) {
          const level = Math.max(a, b) * interval;
          const t = (level - prev) / (v - prev || 1);
          const lat = lat0 + (j - 3 + 3 * t) * dlat;
          out.push({ lat, lon: lon0 + i * dlon, text: format(level), tier });
        }
        prev = v;
      }
    }
  });
  return out;
}
