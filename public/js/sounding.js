// Sounding panel: a point sounding, or the mean profile over a box, drawn here
// on canvases: a skew-T log-p diagram (with the chosen parcel, its CAPE and CIN
// shaded, LCL/LFC/EL marks and a readout under the pointer), wind barbs, a
// hodograph with storm motions, and a table of the usual severe-weather
// parameters. The profile comes from profile.js, the calculations from thermo.js.
import { MODELS, hasProfiles } from './models.js';
import { boxProfile, loadProfileGrid, pointProfile, prefetchProfileGrid, windowBox } from './profile.js';
import { dirSpeed, fitCanvas, windBarb } from './draw.js';
import {
  dewFromVap, extendedIndices, hazardType, interpLog, moistAdiabat, rhFromDewpoint, soundingIndices, thetaE, wetBulb, windAt,
} from './thermo.js';

const PARCELS = ['SB', 'ML', 'MU'];
const PARCEL_NAMES = { SB: 'Surface-based', ML: 'Mixed-layer (100 hPa)', MU: 'Most-unstable' };
const PARCEL_KEY = 'model-globe-sounding-parcel';
const KAPPA = 287.04 / 1005.7;
const KT = 1.943844; // kt per m/s

// Skew-T: log-p from the ground to P_TOP; isotherms lean 45° (SKEW px right per px up).
const P_TOP = 100;
const T_LEFT = -40; // °C at the bottom-left corner...
const T_RIGHT = 50; // ...and bottom-right
const SKEW = 1;
const ISOBARS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100];
const HEIGHT_MARKS = [1000, 3000, 6000, 9000, 12000];
const MIXING_RATIOS = [1, 2, 4, 7, 10, 16, 24]; // g/kg

// Hodograph layers (m AGL) and colours, as SPC draws them.
const HODO_LAYERS = [
  [0, 1000, '#d65cff'],
  [1000, 3000, '#ff5a5a'],
  [3000, 6000, '#ff9f43'],
  [6000, 9000, '#f1c84a'],
  [9000, 12000, '#fff1a8'],
];
const HAZARDS = ['PDS Tornado', 'Tornado', 'Marginal Tornado', 'Severe', 'Marginal Severe', 'Flash Flood', 'Blizzard', 'Excessive Heat', 'None'];

const COLORS = {
  bg: '#05080d',
  frame: 'rgba(255,255,255,0.32)',
  grid: 'rgba(255,255,255,0.10)',
  zero: 'rgba(92,200,255,0.55)',
  dry: 'rgba(255,160,80,0.17)',
  moist: 'rgba(110,210,150,0.17)',
  mix: 'rgba(120,220,140,0.30)',
  label: 'rgba(210,218,230,0.85)',
  t: '#ff5a5a',
  td: '#3ddc84',
  tw: '#4fc3f7',
  parcel: 'rgba(255,255,255,0.9)',
  cape: 'rgba(255,90,90,0.26)',
  cin: 'rgba(80,140,255,0.24)',
};

export const fmtLatLon = (lat, lon) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

const savedParcel = () => {
  try {
    const p = localStorage.getItem(PARCEL_KEY);
    return PARCELS.includes(p) ? p : 'ML';
  } catch {
    return 'ML';
  }
};

// ------------------------------------------------------------------ formatting
const fmt = {
  temp: (k, units) => (units === 'imperial' ? `${Math.round(((k - 273.15) * 9) / 5 + 32)}°F` : `${(k - 273.15).toFixed(1)}°C`),
  height: (m, units) => {
    if (m == null || !Number.isFinite(m)) return '—';
    return units === 'imperial' ? `${Math.round((m * 3.28084) / 10) * 10} ft` : `${Math.round(m / 10) * 10} m`;
  },
  heightShort: (m, units) => (units === 'imperial' ? `${((m * 3.28084) / 1000).toFixed(1)} kft` : `${(m / 1000).toFixed(1)} km`),
  int: (v) => (Number.isFinite(v) ? String(Math.round(v)) : '—'),
  kt: (ms) => (Number.isFinite(ms) ? `${Math.round(ms * KT)} kt` : '—'),
  wind: ([u, v]) => {
    if (!Number.isFinite(u) || !Number.isFinite(v)) return '—';
    const [d, s] = dirSpeed(u, v);
    return `${String(d).padStart(3, '0')}° / ${s} kt`;
  },
  lapse: (v) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)} °C/km`),
  pwat: (mm, units) => (units === 'imperial' ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`),
  index: (v) => (Number.isFinite(v) ? v.toFixed(1) : '—'),
};

/** Class name for a value against "notable" and "high" thresholds (for colouring the table). */
const level = (v, notable, high) => (!Number.isFinite(v) ? '' : v >= high ? 'hi' : v >= notable ? 'mid' : '');

// Moist adiabats (pseudo-adiabats through these wet-bulb potential temperatures,
// °C at 1000 hPa), traced once: [{p, t}] in hPa and K, ground to P_TOP.
let moistCurves = null;
function moistAdiabats() {
  if (moistCurves) return moistCurves;
  moistCurves = [];
  for (let tw = -16; tw <= 40; tw += 4) {
    const pts = [];
    let t = tw + 273.15;
    for (let p = 1000; p <= 1050; p += 10) pts.unshift({ p, t: moistAdiabat(tw + 273.15, 1000, p) });
    pts.pop(); // 1000 hPa again below
    for (let p = 1000; p >= P_TOP; p -= 20) {
      if (p < 1000) t = moistAdiabat(t, p + 20, p);
      pts.push({ p, t });
    }
    moistCurves.push(pts);
  }
  return moistCurves;
}

export class SoundingPanel {
  /**
   * @param {object} o
   * @param {import('./data.js').DataSource} o.data
   * @param {() => {model: string, member: string|null, run: string, step: number, nextStep: number|null, modelName: string, title: string, units: string}} o.context
   * @param {() => void} o.onClose
   */
  constructor({ data, context, onClose }) {
    this.data = data;
    this.context = context;
    this.onClose = onClose;
    this.parcel = savedParcel();
    this.token = 0;
    this.prof = null; // profile on screen (thermo.buildProfile)
    this.ix = null; // its soundingIndices
    this.units = 'imperial'; // the app's setting, taken on each refresh (and setUnits)
    this.hoverY = null;
    const el = (this.el = document.createElement('section'));
    el.className = 'analysis-panel sounding-panel';
    el.hidden = true;
    el.innerHTML = `
      <header class="ap-head">
        <div class="ap-titles"><div class="ap-title"></div><div class="ap-sub"></div></div>
        <div class="segmented small ap-parcel" title="Parcel drawn on the skew-T">${PARCELS.map((k) => `<button data-parcel="${k}" title="${PARCEL_NAMES[k]}">${k}</button>`).join('')}</div>
        <button class="icon-btn small ap-save" title="Save as an image" aria-label="Save the sounding as an image">
          <svg viewBox="0 0 20 20"><path d="M10 3.5v9M6 9l4 4 4-4M4 15.5h12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="icon-btn small ap-close" title="Close (Esc)" aria-label="Close sounding">
          <svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </header>
      <div class="ap-body snd-body">
        <div class="snd-top">
          <div class="snd-skewt"><canvas class="snd-skewt-canvas" aria-label="Skew-T log-p diagram"></canvas></div>
          <div class="snd-hodo"><canvas class="snd-hodo-canvas" aria-label="Hodograph"></canvas></div>
        </div>
        <div class="snd-bottom">
          <div class="snd-block snd-thermo"></div>
          <div class="snd-block snd-kin"></div>
          <div class="snd-block snd-comp"></div>
          <div class="snd-block snd-srw"><div class="snd-block-title">Storm-relative wind</div><div class="snd-srw-box"><canvas class="snd-srw-canvas" aria-label="Storm-relative wind by height"></canvas></div></div>
          <div class="snd-block snd-haz"></div>
        </div>
      </div>
      <div class="ap-status"></div>`;
    document.body.appendChild(el);
    this.skewCanvas = el.querySelector('.snd-skewt-canvas');
    this.hodoCanvas = el.querySelector('.snd-hodo-canvas');
    this.srwCanvas = el.querySelector('.snd-srw-canvas');
    this.table = el.querySelector('.snd-bottom');
    this.skewBuf = document.createElement('canvas'); // the chart without the pointer readout
    el.querySelector('.ap-close').addEventListener('click', () => this.close());
    el.querySelector('.ap-save').addEventListener('click', () => this.#save());
    el.querySelectorAll('[data-parcel]').forEach((b) => b.addEventListener('click', () => this.#setParcel(b.dataset.parcel)));
    this.table.addEventListener('click', (e) => {
      const row = e.target.closest('[data-parcel]');
      if (row) this.#setParcel(row.dataset.parcel);
    });
    this.skewCanvas.addEventListener('pointermove', (e) => {
      const r = this.skewCanvas.getBoundingClientRect();
      this.hoverY = e.clientY - r.top;
      this.#drawReadout();
    });
    this.skewCanvas.addEventListener('pointerleave', () => {
      this.hoverY = null;
      this.#drawReadout();
    });
    new ResizeObserver(() => this.#draw()).observe(el);
    this.#syncParcel();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  /** @param {{kind: 'point', lat: number, lon: number} | {kind: 'box', box: object}} target */
  open(target) {
    this.target = target;
    this.el.hidden = false;
    this.refresh();
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.token++;
    this.onClose?.();
  }

  /** Follow the app's unit setting. */
  setUnits(units) {
    this.units = units;
    this.#draw();
  }

  #status(text, kind = '') {
    const s = this.el.querySelector('.ap-status');
    s.textContent = text;
    s.className = `ap-status ${kind}`;
  }

  #setParcel(k) {
    if (!PARCELS.includes(k)) return;
    this.parcel = k;
    try {
      localStorage.setItem(PARCEL_KEY, k);
    } catch {
      // storage blocked: the choice just won't stick
    }
    this.#syncParcel();
    this.#draw();
  }

  #syncParcel() {
    this.el.querySelectorAll('.ap-parcel [data-parcel]').forEach((b) => b.classList.toggle('active', b.dataset.parcel === this.parcel));
  }

  async refresh() {
    if (this.el.hidden || !this.target) return;
    const token = ++this.token;
    const ctx = this.context();
    this.units = ctx.units;
    const t = this.target;
    const where = t.kind === 'point' ? fmtLatLon(t.lat, t.lon) : `Box ${fmtLatLon(t.box.north, t.box.west)} – ${fmtLatLon(t.box.south, t.box.east)}`;
    this.el.querySelector('.ap-title').textContent = `${ctx.modelName} sounding · ${where}`;
    this.el.querySelector('.ap-sub').textContent = ctx.title;
    this.caption = `${ctx.modelName} · ${where} · ${ctx.title}`;
    if (!hasProfiles(ctx.model, ctx.member)) {
      this.#show(null);
      this.#status(`${MODELS[ctx.model].name}${ctx.member === 'mean' ? ' (mean)' : ''} doesn't publish the levels a sounding needs`, 'error');
      return;
    }
    const box = t.kind === 'point' ? windowBox(t.lat, t.lat, t.lon, t.lon) : windowBox(t.box.south, t.box.north, t.box.west, t.box.east);
    this.#status('Loading levels…', 'busy');
    try {
      const grid = await loadProfileGrid(this.data, ctx.model, ctx.run, ctx.step, box, (done, total) => {
        if (token === this.token && done < total) this.#status(`Loading levels · ${done}/${total} fields`, 'busy');
      });
      if (token !== this.token) return;
      const prof = t.kind === 'point' ? pointProfile(grid, t.lat, t.lon) : boxProfile(grid, t.box);
      if (!prof || prof.p.length < 4) {
        this.#show(null);
        this.#status(`No ${MODELS[ctx.model].name} data here`, 'error');
        return;
      }
      this.#show(prof);
      this.#status('');
      prefetchProfileGrid(this.data, ctx.model, ctx.run, ctx.nextStep, box);
    } catch (err) {
      if (token === this.token) this.#status(`Couldn't load the sounding: ${err.message}`, 'error');
    }
  }

  /** Show a profile (from thermo.buildProfile), or clear the panel. */
  #show(prof) {
    this.prof = prof;
    this.ix = prof ? soundingIndices(prof) : null;
    this.ex = prof ? extendedIndices(prof, this.ix) : null;
    this.hazard = prof ? hazardType(prof, this.ix, this.ex) : null;
    if (prof) this.tw = Array.from(prof.t, (t, i) => wetBulb(t, prof.td[i], prof.p[i]));
    this.#draw();
  }

  #draw() {
    if (this.el.hidden) return;
    this.#drawSkewT();
    this.#drawHodograph();
    this.#drawTables();
    this.#drawSrw();
  }

  // ---------------------------------------------------------------- skew-T
  #geom(W, H) {
    const L = 40;
    const R = 66; // wind barbs and parcel level marks
    const T = 8;
    const B = 22;
    const w = Math.max(10, W - L - R);
    const h = Math.max(10, H - T - B);
    const pBot = Math.min(1050, Math.max(1000, this.prof ? Math.ceil((this.prof.p[0] + 5) / 10) * 10 : 1050));
    const lnTop = Math.log(P_TOP);
    const lnBot = Math.log(pBot);
    const kx = w / (T_RIGHT - T_LEFT);
    const y = (p) => T + (h * (Math.log(p) - lnTop)) / (lnBot - lnTop);
    const x = (tK, p) => L + (tK - 273.15 - T_LEFT) * kx + (T + h - y(p)) * SKEW;
    const pAt = (yy) => Math.exp(lnTop + ((yy - T) / h) * (lnBot - lnTop));
    return { L, R, T, B, w, h, W, H, pBot, x, y, pAt, kx };
  }

  #drawSkewT() {
    const { ctx, w: W, h: H } = fitCanvas(this.skewCanvas);
    const g = (this.geom = this.#geom(W, H));
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    const { L, T, w, h, x, y, pBot } = g;
    const line = (pts, color, width = 1, dash = []) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.stroke();
      ctx.setLineDash([]);
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T, w, h);
    ctx.clip();
    // Dry adiabats every 10 K
    for (let th = 240; th <= 470; th += 10) {
      const pts = [];
      for (let p = pBot; p >= P_TOP; p -= 10) pts.push([x(th * (p / 1000) ** KAPPA, p), y(p)]);
      line(pts, COLORS.dry);
    }
    // Moist adiabats
    for (const curve of moistAdiabats()) line(curve.filter((q) => q.p <= pBot).map((q) => [x(q.t, q.p), y(q.p)]), COLORS.moist, 1, [5, 4]);
    // Mixing ratio lines to 600 hPa
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const r of MIXING_RATIOS) {
      const mr = r / 1000; // kg/kg
      const tAt = (p) => dewFromVap((mr * p) / (0.622 + mr));
      line([[x(tAt(pBot), pBot), y(pBot)], [x(tAt(600), 600), y(600)]], COLORS.mix, 1, [2, 3]);
      ctx.fillStyle = COLORS.mix;
      ctx.fillText(String(r), x(tAt(600), 600), y(600) - 2);
    }
    // Isotherms every 10 °C (0 °C brighter), isobars
    for (let tc = -160; tc <= T_RIGHT; tc += 10) {
      const k = tc + 273.15;
      line([[x(k, pBot), y(pBot)], [x(k, P_TOP), y(P_TOP)]], tc === 0 ? COLORS.zero : COLORS.grid, tc === 0 ? 1.3 : 1);
    }
    for (const p of ISOBARS) if (p <= pBot) line([[L, y(p)], [L + w, y(p)]], COLORS.grid);

    const prof = this.prof;
    const ix = this.ix;
    if (prof) {
      const parcel = ix.parcels[this.parcel.toLowerCase()];
      // CAPE (red) and CIN (blue) between the parcel and the environment
      const tr = parcel.trace;
      for (let i = 1; i < tr.p.length; i++) {
        const p0 = tr.p[i - 1];
        const p1 = tr.p[i];
        const e0 = interpLog(p0, prof.p, prof.t);
        const e1 = interpLog(p1, prof.p, prof.t);
        const warm = tr.t[i - 1] + tr.t[i] > e0 + e1;
        const pm = (p0 + p1) / 2;
        let color = null;
        if (warm && parcel.lfcP != null && pm <= parcel.lfcP && (parcel.elP == null || pm >= parcel.elP)) color = COLORS.cape;
        else if (!warm && parcel.cape > 0 && parcel.lfcP != null && pm >= parcel.lfcP) color = COLORS.cin;
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x(e0, p0), y(p0));
        ctx.lineTo(x(tr.t[i - 1], p0), y(p0));
        ctx.lineTo(x(tr.t[i], p1), y(p1));
        ctx.lineTo(x(e1, p1), y(p1));
        ctx.closePath();
        ctx.fill();
      }
      const curve = (arr) => Array.from(prof.p, (p, i) => [x(arr[i], p), y(p)]);
      line(curve(this.tw), COLORS.tw, 1);
      line(tr.p.map((p, i) => [x(tr.t[i], p), y(p)]), COLORS.parcel, 1.4, [6, 4]);
      for (const [arr, color] of [[prof.td, COLORS.td], [prof.t, COLORS.t]]) {
        line(curve(arr), 'rgba(0,0,0,0.6)', 4.5);
        line(curve(arr), color, 2.4);
      }
    } else {
      ctx.fillStyle = COLORS.label;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Click the map for a sounding', L + w / 2, T + h / 2);
    }
    ctx.restore();

    // Frame and axis labels
    ctx.strokeStyle = COLORS.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(L, T, w, h);
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const p of ISOBARS) if (p <= pBot) ctx.fillText(String(p), L - 5, y(p));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let tc = T_LEFT; tc <= T_RIGHT; tc += 10) {
      const v = this.units === 'imperial' ? Math.round((tc * 9) / 5 + 32) : tc;
      ctx.fillText(`${v}°`, x(tc + 273.15, pBot), T + h + 5);
    }
    if (!prof) {
      this.#bufferChart();
      return;
    }

    // Heights above ground (left, inside the frame)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '600 10px system-ui, sans-serif';
    const top = prof.h[prof.h.length - 1];
    for (const hm of HEIGHT_MARKS) {
      if (hm > top) continue;
      const yy = y(ix.pressureAt(hm));
      if (yy < T + 6) continue;
      ctx.strokeStyle = 'rgba(255,215,90,0.8)';
      ctx.beginPath();
      ctx.moveTo(L, yy);
      ctx.lineTo(L + 7, yy);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,215,90,0.9)';
      ctx.fillText(this.units === 'imperial' ? `${Math.round((hm * 3.28084) / 1000)}k ft` : `${hm / 1000} km`, L + 10, yy);
    }
    ctx.fillText('SFC', L + 10, y(prof.p[0]) - 7);
    // Effective inflow layer: a bracket at the left
    const eil = this.ex?.eil;
    if (eil) {
      const y0 = y(eil.pBot);
      const y1 = Math.min(y0 - 4, y(eil.pTop));
      const ex0 = L + 54;
      ctx.strokeStyle = 'rgba(92,200,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ex0 + 6, y0);
      ctx.lineTo(ex0, y0);
      ctx.lineTo(ex0, y1);
      ctx.lineTo(ex0 + 6, y1);
      ctx.stroke();
      ctx.fillStyle = 'rgba(92,200,255,0.95)';
      ctx.fillText(`EIL ${fmt.int(this.ex.esrh)} m²/s²`, ex0 + 9, (y0 + y1) / 2);
    }
    // Surface temperature and dew point under their curves
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    const ys = y(prof.p[0]) - 3;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.t;
    ctx.fillText(fmt.temp(prof.t[0], this.units).replace(/\.\d/, ''), x(prof.t[0], prof.p[0]) + 5, ys);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.td;
    ctx.fillText(fmt.temp(prof.td[0], this.units).replace(/\.\d/, ''), x(prof.td[0], prof.p[0]) - 5, ys);
    ctx.textBaseline = 'middle';
    ctx.font = '600 10px system-ui, sans-serif';

    // Parcel levels (right edge of the plot)
    const parcel = ix.parcels[this.parcel.toLowerCase()];
    const marks = [
      ['LCL', parcel.lclP, parcel.lclH, '#3ddc84'],
      ['LFC', parcel.lfcP, parcel.lfcH, '#f1c84a'],
      ['EL', parcel.elP, parcel.elH, '#c792ea'],
    ];
    ctx.textAlign = 'right';
    for (const [name, p, hm, color] of marks) {
      if (p == null || !(p >= P_TOP) || p > pBot) continue;
      const yy = y(p);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(L + w - 30, yy);
      ctx.lineTo(L + w, yy);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(name, L + w - 33, yy - 1);
      ctx.font = '9.5px system-ui, sans-serif';
      ctx.fillText(fmt.heightShort(hm, this.units), L + w - 33, yy + 10);
      ctx.font = '600 10px system-ui, sans-serif';
    }

    // Wind barbs in the strip to the right
    const bx = L + w + 30;
    let lastY = Infinity;
    for (let i = 0; i < prof.p.length; i++) {
      const p = prof.p[i];
      if (p < P_TOP) break;
      const yy = y(p);
      if (lastY - yy < 15) continue;
      lastY = yy;
      ctx.strokeStyle = '#d7dee8';
      ctx.fillStyle = '#d7dee8';
      ctx.lineWidth = 1.2;
      windBarb(ctx, bx, yy, prof.u[i], prof.v[i], 20);
    }
    this.#bufferChart();
  }

  /** Keep the drawn chart, so the pointer readout can be redrawn over it cheaply. */
  #bufferChart() {
    const c = this.skewCanvas;
    this.skewBuf.width = c.width;
    this.skewBuf.height = c.height;
    this.skewBuf.getContext('2d').drawImage(c, 0, 0);
    this.#drawReadout();
  }

  #drawReadout() {
    const g = this.geom;
    const prof = this.prof;
    const c = this.skewCanvas;
    if (!g || !c.width) return;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.skewBuf, 0, 0);
    const dpr = c.width / g.W;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!prof || this.hoverY == null || this.hoverY < g.T || this.hoverY > g.T + g.h) return;
    const p = Math.min(prof.p[0], g.pAt(this.hoverY));
    if (p < P_TOP) return;
    const yy = g.y(p);
    const at = (arr) => interpLog(p, prof.p, arr);
    const t = at(prof.t);
    const td = at(prof.td);
    const hm = at(prof.h);
    const [u, v] = windAt(prof, hm);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(g.L, yy);
    ctx.lineTo(g.L + g.w, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [k, color] of [[t, COLORS.t], [td, COLORS.td]]) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(g.x(k, p), yy, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const lines = [
      `${Math.round(p)} hPa · ${hm < 1 ? 'surface' : `${fmt.height(hm, this.units)} AGL`}`,
      `T ${fmt.temp(t, this.units)}   Td ${fmt.temp(td, this.units)}   RH ${Math.round(rhFromDewpoint(t, td))}%`,
      `Wind ${fmt.wind([u, v])}   θe ${Math.round(thetaE(t, td, p))} K`,
    ];
    ctx.font = '11px system-ui, sans-serif';
    const bw = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 16;
    const bh = lines.length * 15 + 8;
    const left = g.x(t, p) > g.L + g.w / 2;
    const bx = left ? g.L + 8 : g.L + g.w - bw - 8;
    const by = Math.min(Math.max(g.T + 4, yy - bh - 8), g.T + g.h - bh - 4);
    ctx.fillStyle = 'rgba(8,12,18,0.9)';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e7ecf3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((s, i) => ctx.fillText(s, bx + 8, by + 5 + i * 15));
  }

  // ---------------------------------------------------------------- hodograph
  #drawHodograph() {
    const { ctx, w: W, h: H } = fitCanvas(this.hodoCanvas);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    const prof = this.prof;
    const ix = this.ix;
    const half = Math.min(W, H) / 2 - 14;
    // Fit the 0–12 km winds, the storm motions and the origin (kt), centred on
    // them rather than on calm, so a strong one-sided profile fills the plot.
    const pts = [];
    let [u0, u1, v0, v1] = [-20, 20, -20, 20];
    if (prof) {
      const top = Math.min(12000, prof.h[prof.h.length - 1]);
      for (let hm = 0; hm <= top; hm += 250) pts.push([hm, ...windAt(prof, hm)]);
      for (const [u, v] of [...pts.map((q) => q.slice(1)), ix.storm.rm, ix.storm.lm, [0, 0]]) {
        u0 = Math.min(u0, u * KT);
        u1 = Math.max(u1, u * KT);
        v0 = Math.min(v0, v * KT);
        v1 = Math.max(v1, v * KT);
      }
    }
    const mu = (u0 + u1) / 2;
    const mv = (v0 + v1) / 2;
    const range = Math.min(160, Math.max(u1 - u0, v1 - v0) / 2 + 8);
    const k = half / range; // px per kt
    const cx = W / 2 - mu * k; // where calm is
    const cy = H / 2 + mv * k;
    const X = (u) => cx + u * KT * k;
    const Y = (v) => cy - v * KT * k;
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = 'rgba(210,218,230,0.55)';
    ctx.lineWidth = 1;
    ctx.font = '9.5px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const far = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) / k;
    for (let r = 10; r <= far; r += 10) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
      ctx.stroke();
      if (r % 20 === 0) ctx.fillText(String(r), cx + r * k * 0.707 + 2, cy - r * k * 0.707);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(W, cy);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, H);
    ctx.stroke();
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('kt', 6, 5);
    if (!prof) return;
    const { rm, lm, mean } = ix.storm;
    // Storm-relative helicity: the area swept from the right mover, over the
    // effective inflow layer (or 0–3 km without one)
    const eil = this.ex.eil;
    const [s0, s1] = eil ? [eil.hBot, Math.max(eil.hTop, eil.hBot + 250)] : [0, 3000];
    ctx.fillStyle = 'rgba(92,200,255,0.16)';
    ctx.strokeStyle = 'rgba(92,200,255,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(rm[0]), Y(rm[1]));
    for (let hm = s0; hm <= s1 + 1; hm += 100) {
      const [u, v] = windAt(prof, Math.min(hm, s1));
      ctx.lineTo(X(u), Y(v));
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // The trace, coloured by layer
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [lo, hi, color] of HODO_LAYERS) {
      const seg = pts.filter(([hm]) => hm >= lo && hm <= hi);
      if (seg.length < 2) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      seg.forEach(([, u, v], i) => (i ? ctx.lineTo(X(u), Y(v)) : ctx.moveTo(X(u), Y(v))));
      ctx.stroke();
    }
    // A numbered dot every km
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [hm, u, v] of pts) {
      if (hm === 0 || hm % 1000) continue;
      ctx.fillStyle = '#0b0f14';
      ctx.strokeStyle = '#e7ecf3';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(X(u), Y(v), 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e7ecf3';
      ctx.fillText(String(hm / 1000), X(u), Y(v) + 0.5);
    }
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    // Storm motions
    const mark = ([u, v], color, label, square = false) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      if (square) ctx.rect(X(u) - 4, Y(v) - 4, 8, 8);
      else ctx.arc(X(u), Y(v), 4.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(label, X(u) + 7, Y(v) + 1);
    };
    mark(rm, '#ff8a8a', 'RM');
    mark(lm, '#8ab4ff', 'LM');
    mark(mean, '#d2a06a', 'MW', true);
    // Storm motions, written out (top left), and the layer colours (bottom left)
    const card = (u, v) => {
      const [d, s] = dirSpeed(u, v);
      const toward = (d + 180) % 360;
      return `${['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(toward / 22.5) % 16]} @ ${s} kt`;
    };
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const lines = [['Right mover', card(...rm), '#ff8a8a'], ['Left mover', card(...lm), '#8ab4ff'], ['0–6 km mean', card(...mean), '#d2a06a']];
    lines.forEach(([k, v, color], i) => {
      ctx.fillStyle = color;
      ctx.fillText(k, 10, 22 + i * 15);
      ctx.fillStyle = '#e7ecf3';
      ctx.fillText(v, 92, 22 + i * 15);
    });
    ctx.font = '9.5px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    HODO_LAYERS.forEach(([lo, hi, color], i) => {
      const yy = H - 12 - (HODO_LAYERS.length - 1 - i) * 13;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(10, yy);
      ctx.lineTo(24, yy);
      ctx.stroke();
      ctx.fillStyle = 'rgba(210,218,230,0.8)';
      ctx.fillText(`${lo / 1000}–${hi / 1000} km`, 29, yy);
    });
    ctx.fillStyle = 'rgba(92,200,255,0.8)';
    ctx.textAlign = 'right';
    ctx.fillText(eil ? 'Shaded: effective-layer SRH' : 'Shaded: 0–3 km SRH', W - 8, H - 12);
  }

  // ---------------------------------------------------------------- storm-relative wind
  /** Storm-relative wind speed (right mover) against height, 0–9 km. */
  #drawSrw() {
    const { ctx, w: W, h: H } = fitCanvas(this.srwCanvas);
    const prof = this.prof;
    if (!prof || W < 40 || H < 40) return;
    const L = 26;
    const R = 8;
    const T = 6;
    const B = 16;
    const w = W - L - R;
    const h = H - T - B;
    const top = Math.min(9000, prof.h[prof.h.length - 1]);
    const [cu, cv] = this.ix.storm.rm;
    const pts = [];
    for (let hm = 0; hm <= top; hm += 250) {
      const [u, v] = windAt(prof, hm);
      pts.push([hm, Math.hypot(u - cu, v - cv) * KT]);
    }
    const max = Math.max(40, Math.ceil(Math.max(...pts.map((p) => p[1])) / 10) * 10);
    const X = (kt) => L + (kt / max) * w;
    const Y = (hm) => T + h * (1 - hm / 9000);
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = 'rgba(210,218,230,0.7)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let km = 0; km <= 9; km += 3) {
      ctx.beginPath();
      ctx.moveTo(L, Y(km * 1000));
      ctx.lineTo(L + w, Y(km * 1000));
      ctx.stroke();
      ctx.fillText(`${km}`, L - 4, Y(km * 1000));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let kt = 0; kt <= max; kt += max > 60 ? 20 : 10) {
      ctx.beginPath();
      ctx.moveTo(X(kt), T);
      ctx.lineTo(X(kt), T + h);
      ctx.stroke();
      ctx.fillText(String(kt), X(kt), T + h + 3);
    }
    // 4–6 km: where SR anvil-level winds matter for supercell type
    ctx.fillStyle = 'rgba(241,200,74,0.08)';
    ctx.fillRect(L, Y(6000), w, Y(4000) - Y(6000));
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (const [lo, hi, color] of HODO_LAYERS) {
      const seg = pts.filter(([hm]) => hm >= lo && hm <= hi);
      if (seg.length < 2) continue;
      ctx.strokeStyle = color;
      ctx.beginPath();
      seg.forEach(([hm, s], i) => (i ? ctx.lineTo(X(s), Y(hm)) : ctx.moveTo(X(s), Y(hm))));
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(210,218,230,0.6)';
    ctx.textAlign = 'left';
    ctx.fillText('km', 2, T);
  }

  // ---------------------------------------------------------------- parameters
  /** The bottom strip: parcels and thermodynamics, kinematics, composites, hazard. */
  #drawTables() {
    const ix = this.ix;
    const ex = this.ex;
    const prof = this.prof;
    const u = this.units;
    const blocks = this.table;
    const set = (sel, html) => (blocks.querySelector(sel).innerHTML = html);
    if (!ix) {
      for (const sel of ['.snd-thermo', '.snd-kin', '.snd-comp', '.snd-haz']) set(sel, '');
      return;
    }
    // Parcels, then lapse rates and moisture
    const rows = PARCELS.map((k) => {
      const key = k.toLowerCase();
      const pc = ix.parcels[key];
      return `<tr data-parcel="${k}" class="${k === this.parcel ? 'sel' : ''}" title="${PARCEL_NAMES[k]} parcel: click to draw it">
        <th>${k}</th>
        <td class="${level(pc.cape, 1000, 2500)}">${fmt.int(pc.cape)}</td>
        <td class="${level(ex.cape3[key], 75, 150)}">${fmt.int(ex.cape3[key])}</td>
        <td>${fmt.int(ex.cape6[key])}</td>
        <td class="${pc.cin < -100 ? 'cold' : ''}">${fmt.int(pc.cin)}</td>
        <td>${fmt.height(pc.lclH, u)}</td>
        <td>${fmt.height(pc.lfcH, u)}</td>
        <td>${fmt.height(pc.elH, u)}</td>
      </tr>`;
    }).join('');
    const kv = (items) => `<dl class="snd-kv">${items.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls ?? ''}">${v}</dd>`).join('')}</dl>`;
    const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : '—');
    set('.snd-thermo', `
      <table class="snd-grid snd-parcels">
        <thead><tr><th></th><th>CAPE</th><th>3CAPE</th><th>6CAPE</th><th>CIN</th><th>LCL</th><th>LFC</th><th>EL</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="snd-cols">
        ${kv([
          ['0–3 km LR', fmt.lapse(ix.lr03), level(ix.lr03, 7.5, 8.5)],
          ['3–6 km LR', fmt.lapse(ix.lr36), level(ix.lr36, 7, 8)],
          ['2–6 km LR', fmt.lapse(ex.lr26), level(ex.lr26, 7, 8)],
          ['850–500 LR', fmt.lapse(ix.lr85), level(ix.lr85, 7, 8)],
          ['700–500 LR', fmt.lapse(ix.lr75), level(ix.lr75, 7, 8)],
        ])}
        ${kv([
          ['PWAT', fmt.pwat(ix.pwat, u), level(ix.pwat, 38, 50)],
          ['Mean W', `${ex.meanW.toFixed(1)} g/kg`],
          ['Low RH', pct(ex.lowRh)],
          ['Mid RH', pct(ex.midRh)],
          ['Sfc T/Td', `${fmt.temp(prof.t[0], u)} / ${fmt.temp(prof.td[0], u)}`],
        ])}
        ${kv([
          ['DCAPE', `${fmt.int(ix.dcape)} J/kg`, level(ix.dcape, 800, 1200)],
          ['Frz level', ix.fzl == null ? '—' : fmt.height(ix.fzl, u)],
          ['WB zero', ix.wbz == null ? '—' : fmt.height(ix.wbz, u)],
          ['Sfc wind', fmt.wind([prof.u[0], prof.v[0]])],
          ['EIL', ex.eil ? `${fmt.height(ex.eil.hBot, u)}–${fmt.height(ex.eil.hTop, u)}` : 'none'],
        ])}
      </div>`);

    // Kinematics by layer
    const kin = ex.layers.map((l) => `<tr class="${l.name === 'Effective' ? 'eff' : ''}">
        <th>${l.name}</th>
        <td class="${level(l.shear * KT, l.name.startsWith('0–6') || l.name === 'Effective' ? 35 : 20, l.name.startsWith('0–6') || l.name === 'Effective' ? 50 : 30)}">${Math.round(l.shear * KT)}</td>
        <td class="${level(l.srh, 100, 250)}">${fmt.int(l.srh)}</td>
        <td>${Math.round(l.srw * KT)}</td>
      </tr>`).join('');
    set('.snd-kin', `
      <table class="snd-grid">
        <thead><tr><th></th><th title="Bulk wind difference">BWD kt</th><th title="Storm-relative helicity, right mover">SRH m²/s²</th><th title="Mean storm-relative wind">SRW kt</th></tr></thead>
        <tbody>${kin}</tbody>
      </table>
      <div class="snd-note">Right mover ${fmt.wind(ix.storm.rm)} · left ${fmt.wind(ix.storm.lm)}</div>`);

    // Composites
    set('.snd-comp', `
      <div class="snd-block-title gen">General</div>
      ${kv([
        ['SCP', fmt.index(ix.scp), level(ix.scp, 2, 8)],
        ['BRN', fmt.index(ex.brn)],
        ['Sig. severe', fmt.int(ex.sigSvr), level(ex.sigSvr, 20000, 40000)],
      ])}
      <div class="snd-block-title tor">Tornado</div>
      ${kv([
        ['STP (cin)', fmt.index(ex.stpCin), level(ex.stpCin, 1, 3)],
        ['STP (fixed)', fmt.index(ix.stp), level(ix.stp, 1, 3)],
        ['EHI 0–1 km', fmt.index(ex.ehi1), level(ex.ehi1, 1, 2)],
        ['EHI 0–3 km', fmt.index(ex.ehi3), level(ex.ehi3, 1, 2)],
        ['Eff. SRH', fmt.int(ex.esrh), level(ex.esrh, 100, 250)],
        ['Eff. shear', `${Math.round(ex.ebwd * KT)} kt`, level(ex.ebwd * KT, 35, 50)],
      ])}`);

    // Hazard guide
    set('.snd-haz', `
      <div class="snd-block-title" title="A rough guide from the composites, after SHARPpy's possible-hazard box">Possible hazard</div>
      <ul class="snd-hazards">${HAZARDS.map((h) => `<li class="${h === this.hazard ? 'on' : ''}">${h}</li>`).join('')}</ul>`);
  }

  /** Download the skew-T, hodograph and caption as one PNG. */
  #save() {
    if (!this.prof) return;
    const a = this.skewCanvas;
    const b = this.hodoCanvas;
    const pad = 12;
    const head = 26 * (a.width / (this.geom?.W || a.width));
    const out = document.createElement('canvas');
    out.width = a.width + b.width + pad * 3;
    out.height = Math.max(a.height, b.height) + head + pad * 2;
    const ctx = out.getContext('2d');
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = '#e7ecf3';
    ctx.font = `${Math.round(head * 0.55)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(this.caption ?? '', pad, pad + head / 2);
    ctx.drawImage(this.skewBuf, pad, pad + head);
    ctx.drawImage(b, a.width + pad * 2, pad + head);
    out.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `sounding-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    });
  }
}
