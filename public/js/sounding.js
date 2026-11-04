// Sounding panel: a point sounding, or the mean profile over a box, drawn by
// SharpJS (vendor/sharpjs): skew-T, hodograph and SHARPpy-style parameter tables.
// The profile comes from profile.js; SharpJS is only loaded the first time a
// sounding opens.
import { MODELS, hasProfiles } from './models.js';
import { boxProfile, loadProfileGrid, pointProfile, prefetchProfileGrid, windowBox } from './profile.js';

const PARCELS = ['SB', 'ML', 'MU'];
// The app's unit setting → SharpJS's (its 'default' is kt and °C, as SHARPpy draws).
const SJS_UNITS = { imperial: 'default', metric: 'metric' };

let sharpjs = null;
const loadSharpJS = () => (sharpjs ??= import('../vendor/sharpjs/src/index.js').catch((err) => {
  sharpjs = null;
  throw err;
}));

export const fmtLatLon = (lat, lon) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

export class SoundingPanel {
  /**
   * @param {object} o
   * @param {import('./data.js').DataSource} o.data
   * @param {() => {model: string, member: string|null, run: string, step: number, title: string, units: string}} o.context
   * @param {() => void} o.onClose
   */
  constructor({ data, context, onClose }) {
    this.data = data;
    this.context = context;
    this.onClose = onClose;
    this.parcel = 'ML';
    this.token = 0;
    this.chart = null;
    const el = (this.el = document.createElement('section'));
    el.className = 'analysis-panel sounding-panel';
    el.hidden = true;
    el.innerHTML = `
      <header class="ap-head">
        <div class="ap-titles"><div class="ap-title"></div><div class="ap-sub"></div></div>
        <div class="segmented small ap-parcel" title="Parcel drawn on the skew-T">${PARCELS.map((k) => `<button data-parcel="${k}">${k}</button>`).join('')}</div>
        <button class="icon-btn small ap-close" title="Close (Esc)" aria-label="Close sounding">
          <svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </header>
      <div class="ap-body sjs-body"><div class="sjs-host"></div></div>
      <div class="ap-status"></div>`;
    document.body.appendChild(el);
    el.querySelector('.ap-close').addEventListener('click', () => this.close());
    el.querySelectorAll('[data-parcel]').forEach((b) =>
      b.addEventListener('click', () => {
        this.parcel = b.dataset.parcel;
        this.#syncParcel();
        this.chart?.engine.LoadNewParcel(this.parcel);
      }),
    );
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

  #status(text, kind = '') {
    const s = this.el.querySelector('.ap-status');
    s.textContent = text;
    s.className = `ap-status ${kind}`;
  }

  #syncParcel() {
    this.el.querySelectorAll('[data-parcel]').forEach((b) => b.classList.toggle('active', b.dataset.parcel === this.parcel));
  }

  async refresh() {
    if (this.el.hidden || !this.target) return;
    const token = ++this.token;
    const ctx = this.context();
    const t = this.target;
    const where = t.kind === 'point' ? fmtLatLon(t.lat, t.lon) : `Box ${fmtLatLon(t.box.north, t.box.west)} – ${fmtLatLon(t.box.south, t.box.east)}`;
    this.el.querySelector('.ap-title').textContent = `${ctx.modelName} sounding · ${where}`;
    this.el.querySelector('.ap-sub').textContent = ctx.title;
    if (!hasProfiles(ctx.model, ctx.member)) {
      this.#show(null);
      this.#status(`${MODELS[ctx.model].name}${ctx.member === 'mean' ? ' (mean)' : ''} doesn't publish the levels a sounding needs`, 'error');
      return;
    }
    const box = t.kind === 'point' ? windowBox(t.lat, t.lat, t.lon, t.lon) : windowBox(t.box.south, t.box.north, t.box.west, t.box.east);
    this.#status('Loading levels…', 'busy');
    try {
      const [grid] = await Promise.all([
        loadProfileGrid(this.data, ctx.model, ctx.run, ctx.step, box, (done, total) => {
          if (token === this.token && done < total) this.#status(`Loading levels · ${done}/${total} fields`, 'busy');
        }),
        this.#ensureChart(),
      ]);
      if (token !== this.token) return;
      const prof = t.kind === 'point' ? pointProfile(grid, t.lat, t.lon) : boxProfile(grid, t.box);
      if (!prof || prof.p.length < 4) {
        this.#show(null);
        this.#status(`No ${MODELS[ctx.model].name} data here`, 'error');
        return;
      }
      const center = t.kind === 'point' ? t : { lat: (t.box.north + t.box.south) / 2, lon: (t.box.west + t.box.east) / 2 };
      // No `location`: SharpJS would fetch OpenStreetMap tiles for a map inset with it.
      this.#show(prof, {
        title: `${ctx.modelName} · ${where} · ${ctx.title}`,
        // Same place at another hour keeps SharpJS's parcel and storm-motion choices.
        key: `${ctx.model}|${t.kind}|${center.lat.toFixed(3)}|${center.lon.toFixed(3)}`,
        units: ctx.units,
      });
      this.#status('');
      prefetchProfileGrid(this.data, ctx.model, ctx.run, ctx.nextStep, box);
    } catch (err) {
      if (token === this.token) this.#status(`Couldn't load the sounding: ${err.message}`, 'error');
    }
  }

  async #ensureChart() {
    if (this.chart) return this.chart;
    const { SharpJS } = await loadSharpJS();
    this.chart ??= SharpJS(this.el.querySelector('.sjs-host'), {
      controls: false,
      fileDrop: false,
      persist: 'local',
      storageKey: 'model-globe-sharpjs',
      brandLabel: 'Model Globe',
      filePrefix: 'model-globe',
      emptyTitle: 'No sounding',
      emptyMessage: 'Click the map for a sounding.',
      settings: { units: SJS_UNITS[this.context().units] ?? 'default', defaultParcel: this.parcel },
      onChange: (s) => {
        if (PARCELS.includes(s?.parcel) && s.parcel !== this.parcel) {
          this.parcel = s.parcel;
          this.#syncParcel();
        }
      },
    });
    return this.chart;
  }

  /** Draw a profile (from thermo.buildProfile), or clear the chart. */
  #show(prof, o = {}) {
    if (!this.chart) return;
    if (!prof) {
      this.chart.update({ sounding: null });
      return;
    }
    this.chart.update({
      sounding: {
        pressure: Array.from(prof.p),
        height: Array.from(prof.z),
        temperature: Array.from(prof.t),
        dewpoint: Array.from(prof.td),
        u: Array.from(prof.u),
        v: Array.from(prof.v),
        units: { temperature: 'K', windSpeed: 'm/s' },
        title: o.title,
        isModel: true,
      },
      soundingKey: o.key,
      settings: { units: SJS_UNITS[o.units] ?? 'default' },
    });
    this.chart.engine.LoadNewParcel(this.parcel);
  }

  /** Follow the app's unit setting. */
  setUnits(units) {
    this.chart?.setSettings({ units: SJS_UNITS[units] ?? 'default' });
  }
}
