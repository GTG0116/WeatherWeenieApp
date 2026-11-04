// Cross-section panel: a vertical slice along a great-circle line, with a
// colour fill, θe contours, the 0 °C line, wind barbs and terrain.
import { MODELS, hasProfiles } from './models.js';
import { extent, greatCircle, loadProfileGrid, prefetchProfileGrid, sectionData, windowBox } from './profile.js';
import { Colormap, TEMP_GRADIENT, WIND_UPPER_MS, spread } from './colormaps.js';
import { dewpointFromRh, theta, thetaE } from './thermo.js';
import { fitCanvas, windBarb } from './draw.js';
import { fmtLatLon } from './sounding.js';

const SAMPLES = 120;
const PTOP = 150;

const RH_COLORS = [
  [0, '#b8551f'], [15, '#d8803a'], [30, '#e4ad6c'], [45, '#9ea4ad'], [60, '#e6ebe6'], [70, '#a8e08c'],
  [80, '#3fc46a'], [90, '#2bb9a8'], [100, '#2f6fe0'],
];
const THETA_COLORS = ['#3b2a7a', '#2f5fb8', '#2fa0c8', '#45c48a', '#b8d84a', '#f1c84a', '#f08a34', '#d8402f', '#a3195b'];

const VARIABLES = {
  rh: { label: 'Relative humidity', unit: '%', cm: () => new Colormap(RH_COLORS), ticks: [0, 20, 40, 60, 80, 100] },
  wind: {
    label: 'Wind speed',
    unit: 'kt',
    cm: () => new Colormap(WIND_UPPER_MS.map(([v, c]) => [v, c, 1])),
    ticks: [20, 40, 60, 80, 100, 120, 140],
    inv: (v) => v / 1.943844, // ticks in kt, colormap in m/s
  },
  temp: { label: 'Temperature', unit: '°C', cm: () => new Colormap(spread(TEMP_GRADIENT, -70, 35)), ticks: [-60, -40, -20, 0, 20] },
  thetae: { label: 'Equivalent potential temperature', unit: 'K', cm: () => new Colormap(spread(THETA_COLORS, 290, 370)), ticks: [300, 320, 340, 360] },
  theta: { label: 'Potential temperature', unit: 'K', cm: () => new Colormap(spread(THETA_COLORS, 280, 400)), ticks: [290, 310, 330, 350, 370, 390] },
};

export class CrossSectionPanel {
  /**
   * @param {object} o
   * @param {import('./data.js').DataSource} o.data
   * @param {() => {model: string, run: string, step: number, modelName: string, title: string, units: string}} o.context
   * @param {() => void} o.onClose
   */
  constructor({ data, context, onClose }) {
    this.data = data;
    this.context = context;
    this.onClose = onClose;
    this.variable = 'rh';
    this.token = 0;
    this.last = null;
    this.cms = {};
    const el = (this.el = document.createElement('section'));
    el.className = 'analysis-panel xsect-panel';
    el.hidden = true;
    el.innerHTML = `
      <header class="ap-head">
        <div class="ap-titles"><div class="ap-title"></div><div class="ap-sub"></div></div>
        <select class="xs-var" aria-label="Cross-section field">${Object.entries(VARIABLES)
          .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
          .join('')}</select>
        <button class="icon-btn small ap-close" title="Close (Esc)" aria-label="Close cross section">
          <svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </header>
      <div class="xs-wrap"><canvas class="xs"></canvas></div>
      <div class="ap-status"></div>`;
    document.body.appendChild(el);
    el.querySelector('.ap-close').addEventListener('click', () => this.close());
    el.querySelector('.xs-var').addEventListener('change', (e) => {
      this.variable = e.target.value;
      this.#draw();
    });
    new ResizeObserver(() => this.#draw()).observe(el);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(a, b) {
    this.a = a;
    this.b = b;
    this.el.hidden = false;
    this.last = null;
    this.refresh();
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.token++;
    this.onClose?.();
  }

  #status(text, kind = '') {
    const s = this.el.querySelector('.ap-status');
    s.textContent = text;
    s.className = `ap-status ${kind}`;
  }

  async refresh() {
    if (this.el.hidden || !this.a) return;
    const token = ++this.token;
    const ctx = this.context();
    this.el.querySelector('.ap-title').textContent = `${ctx.modelName} cross section · ${fmtLatLon(this.a.lat, this.a.lon)} → ${fmtLatLon(this.b.lat, this.b.lon)}`;
    this.el.querySelector('.ap-sub').textContent = ctx.title;
    if (!hasProfiles(ctx.model, ctx.member)) {
      this.last = null;
      this.#draw();
      this.#status(`${MODELS[ctx.model].name} doesn't publish the levels a cross section needs`, 'error');
      return;
    }
    const points = greatCircle(this.a, this.b, SAMPLES);
    const ext = extent(points);
    const box = windowBox(ext.south, ext.north, ext.west, ext.east);
    this.#status('Loading levels…', 'busy');
    try {
      const grid = await loadProfileGrid(this.data, ctx.model, ctx.run, ctx.step, box, (done, total) => {
        if (token === this.token && done < total) this.#status(`Loading levels · ${done}/${total} fields`, 'busy');
      });
      if (token !== this.token) return;
      this.last = { ...sectionData(grid, points), units: ctx.units };
      this.#status(this.last.ps.every((p) => !Number.isFinite(p)) ? `No ${MODELS[ctx.model].name} data along this line` : '', 'error');
      this.#draw();
      prefetchProfileGrid(this.data, ctx.model, ctx.run, ctx.nextStep, box);
    } catch (err) {
      if (token === this.token) this.#status(`Couldn't load the cross section: ${err.message}`, 'error');
    }
  }

  setUnits(units) {
    if (this.last) this.last.units = units;
    this.#draw();
  }

  #cm(k) {
    return (this.cms[k] ??= VARIABLES[k].cm());
  }

  #draw() {
    if (this.el.hidden) return;
    drawSection(this.el.querySelector('.xs'), this.last, this.variable, this.#cm(this.variable));
  }
}

/** Value of the selected variable on the level × sample grid (NaN below ground). */
function fieldOf(s, variable) {
  return s.levels.map((p, l) =>
    s.points.map((_, i) => {
      if (!(p < s.ps[i])) return NaN;
      const t = s.t[l][i];
      switch (variable) {
        case 'rh':
          return s.rh[l][i];
        case 'wind':
          return Math.hypot(s.u[l][i], s.v[l][i]);
        case 'temp':
          return t - 273.15;
        case 'theta':
          return theta(t, p);
        default:
          return thetaE(t, dewpointFromRh(t, s.rh[l][i]), p);
      }
    }),
  );
}

function drawSection(canvas, s, variable, cm) {
  const { ctx, w: W, h: H } = fitCanvas(canvas);
  const L = 48;
  const R = 52;
  const T = 26;
  const B = 30;
  const w = W - L - R;
  const h = H - T - B;
  if (!s || w < 50 || h < 50) return;
  const N = s.points.length;
  const finitePs = s.ps.filter(Number.isFinite);
  if (!finitePs.length) return;
  const pBot = Math.min(1050, Math.ceil((Math.max(...finitePs) + 10) / 25) * 25);
  const lnTop = Math.log(PTOP);
  const lnBot = Math.log(pBot);
  const yOf = (p) => T + (h * (Math.log(p) - lnTop)) / (lnBot - lnTop);
  const xOf = (i) => L + (i / (N - 1)) * w;
  const levels = s.levels; // descending pressure
  const vals = fieldOf(s, variable);
  const V = VARIABLES[variable];

  // Fill, pixel by pixel: linear along the line, linear in ln p between levels.
  const img = ctx.createImageData(Math.round(w), Math.round(h));
  const lnL = levels.map((p) => Math.log(p));
  for (let py = 0; py < img.height; py++) {
    const lnp = lnTop + ((py + 0.5) / img.height) * (lnBot - lnTop);
    let l1 = levels.findIndex((p) => Math.log(p) <= lnp);
    if (l1 <= 0) l1 = l1 === 0 ? 1 : levels.length - 1;
    const l0 = l1 - 1;
    const fy = Math.min(1, Math.max(0, (lnL[l0] - lnp) / (lnL[l0] - lnL[l1])));
    const p = Math.exp(lnp);
    for (let px = 0; px < img.width; px++) {
      const f = ((px + 0.5) / img.width) * (N - 1);
      const i0 = Math.floor(f);
      const i1 = Math.min(N - 1, i0 + 1);
      const fx = f - i0;
      const ps = s.ps[i0] * (1 - fx) + s.ps[i1] * fx;
      const o = (py * img.width + px) * 4;
      if (!(p < ps)) {
        img.data.set([74, 58, 44, 255], o); // terrain
        continue;
      }
      const a = vals[l0][i0] * (1 - fx) + vals[l0][i1] * fx;
      const b = vals[l1][i0] * (1 - fx) + vals[l1][i1] * fx;
      let v = Number.isFinite(b) ? (Number.isFinite(a) ? a * (1 - fy) + b * fy : b) : a;
      if (!Number.isFinite(v)) {
        img.data.set([24, 30, 40, 255], o);
        continue;
      }
      const c = cm.color(v);
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  // putImageData ignores the canvas transform, so go through drawImage.
  const tmp = document.createElement('canvas');
  tmp.width = img.width;
  tmp.height = img.height;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, L, T, w, h);

  // Contours on the level × sample grid
  const thE = variable === 'thetae' ? null : fieldOf(s, 'thetae');
  const contour = (grid, interval, color, width, dash, labelFmt) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    const labels = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of grid) for (const v of row) if (Number.isFinite(v)) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    for (let c = Math.ceil(lo / interval) * interval; c <= hi; c += interval) {
      // Label each line where it passes closest to 30% and 70% of the way along.
      const best = [null, null];
      const targets = [L + w * 0.3, L + w * 0.7];
      ctx.beginPath();
      for (let l = 0; l < levels.length - 1; l++) {
        if (levels[l + 1] < PTOP * 0.9) break;
        for (let i = 0; i < N - 1; i++) {
          const q = [grid[l][i], grid[l][i + 1], grid[l + 1][i + 1], grid[l + 1][i]];
          if (!q.every(Number.isFinite)) continue;
          const pts = [];
          const corners = [[i, levels[l]], [i + 1, levels[l]], [i + 1, levels[l + 1]], [i, levels[l + 1]]];
          for (let e = 0; e < 4; e++) {
            const a = q[e];
            const b = q[(e + 1) % 4];
            if ((a < c) === (b < c)) continue;
            const f = (c - a) / (b - a);
            const [ia, pa] = corners[e];
            const [ib, pb] = corners[(e + 1) % 4];
            pts.push([xOf(ia + f * (ib - ia)), yOf(Math.exp(Math.log(pa) + f * (Math.log(pb) - Math.log(pa))))]);
          }
          if (pts.length >= 2) {
            ctx.moveTo(...pts[0]);
            ctx.lineTo(...pts[1]);
            if (pts.length === 4) {
              ctx.moveTo(...pts[2]);
              ctx.lineTo(...pts[3]);
            }
            targets.forEach((tx, k) => {
              const d = Math.abs(pts[0][0] - tx);
              if (!best[k] || d < best[k].d) best[k] = { d, x: pts[0][0], y: pts[0][1] };
            });
          }
        }
      }
      ctx.stroke();
      if (labelFmt) for (const b of best) if (b && b.d < w * 0.15) labels.push([b.x, b.y, labelFmt(c)]);
    }
    ctx.setLineDash([]);
    if (labelFmt) {
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const placed = [];
      for (const [x, y, t] of labels) {
        if (placed.some(([px, py]) => Math.abs(x - px) < 28 && Math.abs(y - py) < 13)) continue;
        ctx.fillStyle = 'rgba(8,12,18,0.7)';
        ctx.fillRect(x - 12, y - 6, 24, 12);
        ctx.fillStyle = color === '#1f9e4a' ? '#4be07f' : color;
        ctx.fillText(t, x, y);
        placed.push([x, y]);
      }
    }
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(L, T, w, h);
  ctx.clip();
  if (thE) contour(thE, 4, '#1f9e4a', 1.4, [], (v) => String(Math.round(v)));
  else contour(fieldOf(s, 'temp'), 10, 'rgba(255,255,255,0.75)', 1, [4, 3], (v) => `${v}°`);
  const tc = fieldOf(s, 'temp');
  // 0 °C line
  ctx.strokeStyle = '#5cc8ff';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  for (let l = 0; l < levels.length - 1; l++) {
    for (let i = 0; i < N - 1; i++) {
      const q = [tc[l][i], tc[l][i + 1], tc[l + 1][i + 1], tc[l + 1][i]];
      if (!q.every(Number.isFinite)) continue;
      const corners = [[i, levels[l]], [i + 1, levels[l]], [i + 1, levels[l + 1]], [i, levels[l + 1]]];
      const pts = [];
      for (let e = 0; e < 4; e++) {
        const a = q[e];
        const b = q[(e + 1) % 4];
        if ((a < 0) === (b < 0)) continue;
        const f = -a / (b - a);
        const [ia, pa] = corners[e];
        const [ib, pb] = corners[(e + 1) % 4];
        pts.push([xOf(ia + f * (ib - ia)), yOf(Math.exp(Math.log(pa) + f * (Math.log(pb) - Math.log(pa))))]);
      }
      if (pts.length >= 2) {
        ctx.moveTo(...pts[0]);
        ctx.lineTo(...pts[1]);
      }
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Wind barbs: dark on a light halo so they read on any fill
  const every = Math.max(1, Math.round((N - 1) / Math.max(4, Math.floor(w / 46))));
  let lastY = -100;
  for (let l = 0; l < levels.length; l++) {
    const yy = yOf(levels[l]);
    if (levels[l] < PTOP || Math.abs(yy - lastY) < 20) continue;
    lastY = yy;
    for (let i = Math.floor(every / 2); i < N; i += every) {
      if (!(levels[l] < s.ps[i])) continue;
      for (const [color, width] of [['rgba(255,255,255,0.55)', 3], ['#0b0f14', 1.2]]) {
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = width;
        windBarb(ctx, xOf(i), yy, s.u[l][i], s.v[l][i], 18);
      }
    }
  }
  ctx.restore();

  // Axes
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(L, T, w, h);
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(210,218,230,0.85)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const p of [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150]) {
    if (p > pBot || p < PTOP) continue;
    ctx.fillText(String(p), L - 5, yOf(p));
  }
  ctx.save();
  ctx.translate(11, T + h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('hPa', 0, 0);
  ctx.restore();
  // Heights (mean along the line) on the right
  ctx.textAlign = 'left';
  const imp = s.units === 'imperial';
  for (let l = 0; l < levels.length; l++) {
    if (![850, 700, 500, 300, 200].includes(levels[l])) continue;
    const z = s.gh[l].filter(Number.isFinite);
    if (!z.length) continue;
    const mean = z.reduce((a, b) => a + b, 0) / z.length;
    ctx.fillText(imp ? `${Math.round((mean * 3.28084) / 1000)}k ft` : `${(mean / 1000).toFixed(1)} km`, L + w + 6, yOf(levels[l]));
  }
  // Distance along the line
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const total = s.points[N - 1].km;
  const unitKm = imp ? 1.609344 : 1;
  const step = niceStep(total / unitKm / 6);
  for (let d = 0; d <= total / unitKm + 1e-6; d += step) {
    const x = L + ((d * unitKm) / total) * w;
    ctx.fillText(`${Math.round(d)}${d === 0 ? (imp ? ' mi' : ' km') : ''}`, x, T + h + 5);
  }
  ctx.textAlign = 'left';
  ctx.fillText('A', L - 12, T + h + 5);
  ctx.textAlign = 'right';
  ctx.fillText('B', L + w + 14, T + h + 5);

  // Colour bar (top right)
  const cbW = Math.min(280, w * 0.45);
  const cbX = L + w - cbW;
  const cbY = 6;
  const inv = V.inv ?? ((v) => v);
  for (let k = 0; k < cbW; k++) {
    const c = cm.color(cm.valueAt(k / cbW));
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(cbX + k, cbY, 1, 8);
  }
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(210,218,230,0.85)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText(`${V.label} (${V.unit})`, cbX - 8, cbY + 4);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of V.ticks) {
    const pos = cm.position(inv(t));
    if (pos < 0 || pos > 1) continue;
    ctx.fillText(String(t), cbX + pos * cbW, cbY + 9);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#3ad06a';
  ctx.fillText(variable === 'thetae' ? 'Isotherms 10 °C' : 'θe lines · 4 K', L, cbY + 4);
}

function niceStep(x) {
  const mag = 10 ** Math.floor(Math.log10(Math.max(1e-6, x)));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= x) ?? 10 * mag;
}
