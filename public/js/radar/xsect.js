// Radar cross section: a vertical slice along a line drawn near a NEXRAD,
// through every tilt of the Level II volume that goes with the frame on screen
// (sampled in worker.js), in the product's colours, with each tilt's beam
// centre, heights and distance along the line. It follows the loop: a new frame
// slices the volume that frame came from.
import { fitCanvas } from '../draw.js';
import { unitFor } from '../units.js';
import { fmtLatLon } from '../sounding.js';
import { radarProductById } from './products.js';
import { listVolumes } from './source.js';
import { VOLUME_MOMENTS, momentFor } from './volume.js';

const R_KM = 6371;
const KE_R = (4 / 3) * R_KM; // effective earth radius for beam refraction
const MAX_RANGE_KM = 460; // Level II reflectivity reaches this far
const VOLUME_LIST_MS = 90e3;
const MIN_TOP_KM = 8; // the plot reaches at least this high...
const FOLDED = [120, 51, 158]; // range-folded velocity, as on the map

const toXYZ = (lat, lon) => {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
};

/** Azimuthal equidistant about the radar: lat/lon → km east / north of it. */
export function kmFromSite(site, ll) {
  const c = toXYZ(site.lat, site.lon);
  const east = [-Math.sin((site.lon * Math.PI) / 180), Math.cos((site.lon * Math.PI) / 180), 0];
  const north = [c[1] * east[2] - c[2] * east[1], c[2] * east[0] - c[0] * east[2], c[0] * east[1] - c[1] * east[0]];
  const p = toXYZ(ll.lat, ll.lon);
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ex = dot(p, east);
  const ny = dot(p, north);
  const d = Math.hypot(ex, ny);
  const s = Math.atan2(d, dot(p, c)) * R_KM;
  return d ? { x: (s * ex) / d, y: (s * ny) / d } : { x: 0, y: 0 };
}

export class RadarSectionPanel {
  /**
   * @param {object} o
   * @param {import('./source.js').RadarSource} o.source
   * @param {() => string} o.units 'imperial' | 'metric'
   * @param {() => void} o.onClose
   */
  constructor({ source, units, onClose }) {
    this.source = source;
    this.units = units;
    this.onClose = onClose;
    this.seq = 0;
    this.lists = new Map(); // site → {at, vols}
    this.shown = null; // {grid, product, site, a, b, vol}
    this.last = null; // the frame on screen: {site, product, time}
    this.hoverX = null;
    const el = (this.el = document.createElement('section'));
    el.className = 'analysis-panel xsect-panel radar-xsect-panel';
    el.hidden = true;
    el.innerHTML = `
      <header class="ap-head">
        <div class="ap-titles"><div class="ap-title"></div><div class="ap-sub"></div></div>
        <button class="icon-btn small ap-swap" title="Swap the ends" aria-label="Swap the ends of the cross section">
          <svg viewBox="0 0 20 20"><path d="M4 7h11l-3-3M16 13H5l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="icon-btn small ap-close" title="Close (Esc)" aria-label="Close cross section">
          <svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </header>
      <div class="xs-wrap"><canvas class="xs"></canvas></div>
      <div class="ap-status"></div>`;
    document.body.appendChild(el);
    this.canvas = el.querySelector('canvas');
    this.buf = document.createElement('canvas');
    el.querySelector('.ap-close').addEventListener('click', () => this.close());
    el.querySelector('.ap-swap').addEventListener('click', () => {
      if (!this.a) return;
      [this.a, this.b] = [this.b, this.a];
      this.onSwap?.(this.a, this.b);
      this.refresh();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      this.hoverX = e.clientX - this.canvas.getBoundingClientRect().left;
      this.hoverY = e.clientY - this.canvas.getBoundingClientRect().top;
      this.#drawReadout();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.#drawReadout();
    });
    new ResizeObserver(() => this.#draw()).observe(el);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  /** Slice from a to b ({lat, lon}). */
  open(a, b) {
    this.a = a;
    this.b = b;
    this.el.hidden = false;
    this.shown = null;
    this.refresh();
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.seq++;
    this.onClose?.();
  }

  setUnits() {
    this.#draw();
  }

  #status(text, kind = '') {
    const s = this.el.querySelector('.ap-status');
    s.textContent = text;
    s.className = `ap-status ${kind}`;
  }

  /** The frame on screen changed (or the product, or the radar). */
  update(site, product, time) {
    this.last = { site, product, time };
    this.refresh();
  }

  async #volumes(site) {
    const hit = this.lists.get(site.id);
    if (hit && Date.now() - hit.at < VOLUME_LIST_MS) return hit.vols;
    const vols = await listVolumes(site);
    this.lists.set(site.id, { at: Date.now(), vols });
    return vols;
  }

  async refresh() {
    if (this.el.hidden || !this.a || !this.last) return;
    const seq = ++this.seq;
    const { site, product, time } = this.last;
    const moment = momentFor(product);
    const m = VOLUME_MOMENTS[moment];
    const shownAs = moment === 'REF' && product.id !== 'ref' && product.id !== 'ptype' ? ` (${product.short} has no Level II moment: reflectivity)` : product.id === 'srv' ? ' (base velocity)' : '';
    this.el.querySelector('.ap-title').textContent = `${site.id} cross section · ${fmtLatLon(this.a.lat, this.a.lon)} → ${fmtLatLon(this.b.lat, this.b.lon)}`;
    this.el.querySelector('.ap-sub').textContent = `${m.name}${shownAs}`;
    if (site.type !== 'WSR-88D') {
      this.shown = null;
      this.#draw();
      return this.#status('TDWRs publish no Level II volumes: pick a NEXRAD for cross sections', 'error');
    }
    const a = kmFromSite(site, this.a);
    const b = kmFromSite(site, this.b);
    if (Math.min(Math.hypot(a.x, a.y), Math.hypot(b.x, b.y)) > MAX_RANGE_KM && segmentDistance(a, b) > MAX_RANGE_KM) {
      this.shown = null;
      this.#draw();
      return this.#status(`This line is beyond ${site.id}'s range`, 'error');
    }
    let vols;
    try {
      vols = await this.#volumes(site);
    } catch (err) {
      if (seq === this.seq) this.#status(`Couldn't list ${site.id}'s Level II volumes: ${err.message}`, 'error');
      return;
    }
    if (seq !== this.seq) return;
    if (!vols.length) return this.#status(`No Level II volumes from ${site.id} in the past day`, 'error');
    // The volume the frame came from: the last to start by then.
    let vol = vols[0];
    for (const v of vols) if (v.time <= time + 90e3) vol = v;
    const hhmm = new Date(vol.time).toISOString().slice(11, 16);
    this.#status(`Slicing ${site.id}'s ${hhmm}Z volume…`, 'busy');
    let grid;
    try {
      grid = await this.source.section(vol.url, moment, a, b);
    } catch (err) {
      if (seq === this.seq) this.#status(`Couldn't load the ${site.id} volume: ${err.message}`, 'error');
      return;
    }
    if (seq !== this.seq) return;
    this.shown = { grid, product: radarProductById[m.product], site, a, b, vol, moment };
    this.el.querySelector('.ap-sub').textContent = `${m.name}${shownAs} · ${hhmm}Z volume · ${grid.angles.length} tilts, ${grid.angles[0].toFixed(1)}–${grid.angles[grid.angles.length - 1].toFixed(1)}°`;
    this.#status('');
    this.#draw();
  }

  #geom(W, H) {
    const L = 52;
    const R = 40;
    const T = 28;
    const B = 30;
    return { L, R, T, B, w: Math.max(10, W - L - R), h: Math.max(10, H - T - B), W, H };
  }

  #draw() {
    if (this.el.hidden) return;
    const { ctx, w: W, h: H } = fitCanvas(this.canvas);
    const g = (this.geom = this.#geom(W, H));
    const { L, T, w, h } = g;
    ctx.fillStyle = '#05080d';
    ctx.fillRect(0, 0, W, H);
    const s = this.shown;
    if (!s) {
      this.#buffer();
      return;
    }
    const { grid, product } = s;
    const imp = this.units() === 'imperial';
    // Plot top: the highest data plus a little, at least MIN_TOP_KM.
    let topRow = 0;
    for (let k = grid.nz - 1; k >= 0 && !topRow; k--) {
      for (let i = 0; i < grid.nx; i++) {
        if (grid.values[k * grid.nx + i] === grid.values[k * grid.nx + i]) {
          topRow = k;
          break;
        }
      }
    }
    const dz = grid.topKm / grid.nz;
    const topKm = Math.min(grid.topKm, Math.max(MIN_TOP_KM, Math.ceil((topRow + 1) * dz + 1)));
    g.topKm = topKm;
    g.dz = dz;
    const cm = product.colormap();

    // Fill
    const img = ctx.createImageData(Math.round(w), Math.round(h));
    const groundKm = grid.siteKm;
    for (let py = 0; py < img.height; py++) {
      const z = topKm * (1 - (py + 0.5) / img.height);
      const k = Math.min(grid.nz - 1, Math.floor(z / dz));
      for (let px = 0; px < img.width; px++) {
        const i = Math.min(grid.nx - 1, Math.floor(((px + 0.5) / img.width) * grid.nx));
        const v = grid.values[k * grid.nx + i];
        const o = (py * img.width + px) * 4;
        let c;
        if (z < groundKm) c = [58, 46, 34, 255];
        else if (v === Infinity) c = [...FOLDED, 255];
        else if (v !== v) c = [12, 17, 25, 255];
        else {
          const q = cm.color(v);
          const al = q[3] / 255;
          c = [q[0] * al + 12 * (1 - al), q[1] * al + 17 * (1 - al), q[2] * al + 25 * (1 - al), 255];
        }
        img.data[o] = c[0];
        img.data[o + 1] = c[1];
        img.data[o + 2] = c[2];
        img.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = img.width;
    tmp.height = img.height;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, L, T, w, h);

    const yOf = (km) => T + h * (1 - km / topKm);
    const xOf = (f) => L + f * w;
    // Beam centre of each tilt along the line
    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T, w, h);
    ctx.clip();
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.font = '9px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';
    const N = 120;
    const seen = [];
    for (const el of grid.angles) {
      if (seen.some((x) => Math.abs(x - el) < 0.15)) continue; // split cuts repeat a tilt
      seen.push(el);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      let last = null;
      for (let n = 0; n <= N; n++) {
        const f = n / N;
        const sKm = Math.hypot(s.a.x + (s.b.x - s.a.x) * f, s.a.y + (s.b.y - s.a.y) * f);
        const z = beamHeight(sKm, el) + grid.siteKm;
        const pt = [xOf(f), yOf(z)];
        if (n) ctx.lineTo(...pt);
        else ctx.moveTo(...pt);
        last = pt;
      }
      ctx.stroke();
      if (last && last[1] > T + 10 && last[1] < T + h) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillText(`${el.toFixed(1)}°`, L + w - 3, last[1] - 2);
      }
    }
    ctx.setLineDash([]);
    ctx.restore();

    // Axes
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.strokeRect(L, T, w, h);
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(210,218,230,0.85)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const unitH = imp ? 0.3048 : 1; // km per kft or per km
    const stepH = niceStep(topKm / unitH / 6);
    for (let v = 0; v <= topKm / unitH + 1e-6; v += stepH) ctx.fillText(String(Math.round(v)), L - 6, yOf(v * unitH));
    ctx.save();
    ctx.translate(12, T + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(imp ? 'kft' : 'km', 0, 0);
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const total = grid.lengthKm;
    const unitD = imp ? 1.609344 : 1;
    const stepD = niceStep(total / unitD / 7);
    for (let d = 0; d <= total / unitD + 1e-6; d += stepD) ctx.fillText(`${Math.round(d)}${d === 0 ? (imp ? ' mi' : ' km') : ''}`, xOf((d * unitD) / total), T + h + 6);
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('A', L - 6, T + h + 6);
    ctx.textAlign = 'left';
    ctx.fillText('B', L + w + 6, T + h + 6);

    // Colour bar (top)
    const u = unitFor(product.unit, this.units());
    const cbW = Math.min(300, w * 0.5);
    const cbX = L + w - cbW;
    const cbY = 6;
    for (let k = 0; k < cbW; k++) {
      const c = cm.color(cm.valueAt(k / cbW));
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(cbX + k, cbY, 1, 8);
    }
    ctx.font = '9.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(210,218,230,0.85)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${product.name} (${u.label})`, cbX - 8, cbY + 4);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of product.legendTicks?.(this.units()) ?? []) {
      const pos = cm.position(u.inv(t));
      if (pos >= 0 && pos <= 1) ctx.fillText(String(t), cbX + pos * cbW, cbY + 9);
    }
    if (product.folds) {
      ctx.fillStyle = `rgb(${FOLDED.join(',')})`;
      ctx.fillRect(L, cbY, 10, 8);
      ctx.fillStyle = 'rgba(210,218,230,0.85)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('range folded', L + 14, cbY + 4);
    }
    this.#buffer();
  }

  #buffer() {
    this.buf.width = this.canvas.width;
    this.buf.height = this.canvas.height;
    this.buf.getContext('2d').drawImage(this.canvas, 0, 0);
    this.#drawReadout();
  }

  /** Value, height and position under the pointer. */
  #drawReadout() {
    const g = this.geom;
    const c = this.canvas;
    if (!g || !c.width) return;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.buf, 0, 0);
    const dpr = c.width / g.W;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = this.shown;
    if (!s || this.hoverX == null || !g.topKm) return;
    const fx = (this.hoverX - g.L) / g.w;
    const fy = (this.hoverY - g.T) / g.h;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
    const { grid, product } = s;
    const z = g.topKm * (1 - fy);
    const i = Math.min(grid.nx - 1, Math.floor(fx * grid.nx));
    const k = Math.min(grid.nz - 1, Math.floor(z / g.dz));
    const v = grid.values[k * grid.nx + i];
    const imp = this.units() === 'imperial';
    const u = unitFor(product.unit, this.units());
    const val = v === Infinity ? 'Range folded' : v !== v ? 'No echo' : `${product.format(u.f(v), this.units())} ${u.label}`;
    const x = s.a.x + (s.b.x - s.a.x) * fx;
    const y = s.a.y + (s.b.y - s.a.y) * fx;
    const range = Math.hypot(x, y);
    const along = grid.lengthKm * fx;
    const dist = (km) => (imp ? `${Math.round(km * 0.621371)} mi` : `${Math.round(km)} km`);
    const lines = [val, `${imp ? `${(z / 0.3048).toFixed(1)} kft` : `${z.toFixed(1)} km`} ASL · ${dist(along)} from A`, `${dist(range)} from ${s.site.id}`];
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(this.hoverX, g.T);
    ctx.lineTo(this.hoverX, g.T + g.h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '11px system-ui, sans-serif';
    const bw = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 16;
    const bh = lines.length * 15 + 8;
    const bx = this.hoverX + bw + 14 > g.L + g.w ? this.hoverX - bw - 10 : this.hoverX + 10;
    const by = Math.min(Math.max(g.T + 4, this.hoverY - bh / 2), g.T + g.h - bh - 4);
    ctx.fillStyle = 'rgba(8,12,18,0.9)';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e7ecf3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((t, n) => ctx.fillText(t, bx + 8, by + 5 + n * 15));
  }
}

/** Height of a tilt's beam centre above the antenna (km) at a ground range (km), 4/3 earth. */
function beamHeight(sKm, elDeg) {
  const el = (elDeg * Math.PI) / 180;
  const phi = sKm / KE_R;
  // Ground range s at elevation el: the beam reaches height h where tan geometry closes.
  return (KE_R * Math.cos(el)) / Math.cos(el + phi) - KE_R;
}

/** Closest distance from the radar (origin) to the segment a–b, km. */
function segmentDistance(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a.x + dx * t, a.y + dy * t);
}

function niceStep(x) {
  const mag = 10 ** Math.floor(Math.log10(Math.max(1e-6, x)));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= x) ?? 10 * mag;
}
