// Radar mode: the site buttons (one pill per NEXRAD / TDWR radar, red when the
// radar is down), the product sections, tilt picker and colour tables, site
// markers on the globe, and the loop of recent frames for the selected site,
// product and tilt.
import { NOMINAL_TILTS, RADAR_GROUPS, RADAR_PRODUCTS, hasCustomColormap, hasLegacy, radarProductById, sourceOf, tiltCount } from './products.js';
import { sampleNearest } from '../data.js';
import { RadarSource, STALE_MS, ago, fetchStatus, listFrames, loadSites } from './source.js';
import { colorTableName, resetColorTable, restoreColorTables, saveColorTable } from './colortables.js';

const D2R = Math.PI / 180;
const TYPE_LABEL = { 'WSR-88D': 'NEXRAD', TDWR: 'TDWR' };
const REFRESH_FRAMES_MS = 2 * 60e3;
const REFRESH_STATUS_MS = 5 * 60e3;
const MARKER_LABEL_ALT = 0.9; // camera altitude below which markers show their ID
// TDWRs (short-range airport radars, often next to a NEXRAD) only show up close:
// about a metro area across the screen. The selected one always shows.
const TDWR_MARKER_ALT = 0.15;

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class RadarView {
  /**
   * @param {object} o
   * @param {import('../globe/globe.js').Globe} o.globe
   * @param {{site: string|null, product: string, tilt: number, res: 'super'|'legacy'}} o.state persisted selection (mutated)
   * @param {(text: string, kind?: string) => void} o.setStatus
   * @param {() => void} o.onChange selection changed: persist and render
   * @param {() => void} o.onFrames the frame list changed: rebuild the timeline
   * @param {() => void} o.onProgress a background frame finished loading
   */
  constructor({ globe, state, setStatus, onChange, onFrames, onProgress }) {
    this.globe = globe;
    this.state = state;
    this.setStatus = setStatus;
    this.onChange = onChange;
    this.onFrames = onFrames;
    this.onProgress = onProgress;
    this.source = new RadarSource();
    this.sites = [];
    this.siteById = {};
    this.status = new Map(); // id → {down, reason, ...}
    this.statusError = null;
    this.frames = [];
    this.framesKey = '';
    this.sweep = null;
    this.active = false;
    this.filter = '';
    this.timers = [];
    this.angles = {}; // "site:tilt" → elevation angle seen in a scan
    this.groundOpacity = 1; // the sweep is dimmed under a 3D volume
    this.markersEl = document.getElementById('radar-markers');
    globe.on('change', () => this.#placeMarkers());
    restoreColorTables();
    const file = document.getElementById('radar-ctable-file');
    file.addEventListener('change', () => {
      if (file.files[0]) this.#uploadColorTable(file.files[0]);
      file.value = '';
    });
    document.getElementById('radar-ctable-upload').addEventListener('click', () => file.click());
    document.getElementById('radar-ctable-reset').addEventListener('click', () => {
      resetColorTable(this.product.id);
      this.#afterColorTable();
    });
  }

  get product() {
    return radarProductById[this.state.product] ?? RADAR_PRODUCTS[0];
  }

  get site() {
    return this.siteById[this.state.site] ?? null;
  }

  /** Dual-pol resolution: super-res (Level II, 0.5° at the low tilts) or legacy (Level III, 1°). */
  get res() {
    return this.state.res === 'legacy' ? 'legacy' : 'super';
  }

  /** Selected tilt index, limited to what the product has at this radar. */
  get tilt() {
    const n = this.site ? tiltCount(this.product, this.site.type, this.res) : 1;
    return Math.max(0, Math.min(this.state.tilt ?? 0, n - 1));
  }

  /** Whether the selected radar publishes a product. */
  available(p, site = this.site) {
    return !!site && !!sourceOf(p, site.type);
  }

  isDown(id) {
    return !!this.status.get(id)?.down;
  }

  // ------------------------------------------------------------------ lifecycle
  async activate() {
    this.active = true;
    document.body.classList.add('radar-mode');
    if (!this.sites.length) {
      this.sites = await loadSites();
      this.siteById = Object.fromEntries(this.sites.map((s) => [s.id, s]));
      this.#buildMarkers();
    }
    if (!this.site) this.state.site = this.#nearestSite().id;
    this.buildSites();
    this.buildProducts();
    this.#placeMarkers();
    this.refreshStatus(); // "is it down?" for every radar, as the view loads
    this.timers.push(
      setInterval(() => this.refreshStatus(), REFRESH_STATUS_MS),
      setInterval(() => this.refreshFrames(true), REFRESH_FRAMES_MS),
    );
  }

  deactivate() {
    this.active = false;
    document.body.classList.remove('radar-mode');
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.loadSeq = (this.loadSeq ?? 0) + 1; // stop background loading
  }

  #nearestSite() {
    const c = this.globe.camera.position;
    return this.nearestNexrad(Math.asin(c.y / c.length()) / D2R, Math.atan2(-c.z, c.x) / D2R)?.site ?? this.siteById.KTLX;
  }

  /** Closest working NEXRAD to a point (any NEXRAD if none is up): {site, km}. */
  nearestNexrad(lat, lon) {
    let best = null;
    for (const up of [true, false]) {
      for (const s of this.sites) {
        if (s.type !== 'WSR-88D' || (up && this.isDown(s.id))) continue;
        const km = distanceKm(lat, lon, s.lat, s.lon);
        if (!best || km < best.km) best = { site: s, km };
      }
      if (best) return best;
    }
    return null;
  }

  async refreshStatus() {
    try {
      this.status = await fetchStatus();
      this.statusError = null;
    } catch (err) {
      this.statusError = err.message;
    }
    // The selected radar's own data age counts too (the API can lag behind).
    this.#markStale();
    if (!this.active) return;
    this.#syncSitePills();
    this.#syncMarkers();
    this.#siteInfo();
  }

  #markStale() {
    const site = this.site;
    const last = this.frames[this.frames.length - 1];
    if (!site || !last) return;
    const age = Date.now() - last.time;
    if (age > STALE_MS && !this.isDown(site.id)) {
      this.status.set(site.id, { ...this.status.get(site.id), down: true, reason: `No new scans since ${new Date(last.time).toISOString().slice(11, 16)}Z (${ago(age)})` });
    }
  }

  // ------------------------------------------------------------------ panel
  buildSites() {
    const el = document.getElementById('radar-sites');
    const q = this.filter.trim().toLowerCase();
    const match = (s) => !q || s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.region.toLowerCase().includes(q);
    el.innerHTML = '';
    for (const type of ['WSR-88D', 'TDWR']) {
      const list = this.sites.filter((s) => s.type === type && match(s));
      if (!list.length) continue;
      const head = document.createElement('div');
      head.className = 'site-group';
      head.textContent = `${TYPE_LABEL[type]} · ${list.length}`;
      el.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'site-pills';
      for (const s of list) {
        const b = document.createElement('button');
        b.className = `site-pill${type === 'TDWR' ? ' tdwr' : ''}`;
        b.dataset.site = s.id;
        b.textContent = s.id;
        b.addEventListener('click', () => this.selectSite(s.id, true));
        grid.appendChild(b);
      }
      el.appendChild(grid);
    }
    if (!el.children.length) el.innerHTML = '<div class="site-empty">No radar matches</div>';
    this.#syncSitePills();
  }

  #syncSitePills() {
    const counts = { down: 0, total: this.sites.length };
    for (const s of this.sites) counts.down += this.isDown(s.id);
    document.querySelectorAll('.site-pill').forEach((b) => {
      const s = this.siteById[b.dataset.site];
      const st = this.status.get(s.id);
      b.classList.toggle('active', s.id === this.state.site);
      b.classList.toggle('down', !!st?.down);
      b.title = `${s.id} · ${s.name}, ${s.region} · ${TYPE_LABEL[s.type]}` + (st ? (st.down ? `\nDown: ${st.reason}` : '\nOnline') : '');
    });
    const hint = document.getElementById('radar-count');
    hint.textContent = this.statusError ? 'status unavailable' : this.status.size ? `${counts.down} down` : 'checking…';
    hint.classList.toggle('bad', !!counts.down && !this.statusError);
  }

  /** One sidebar section per product group (reflectivity, velocity, dual-pol, ...). */
  buildProducts() {
    const el = document.getElementById('radar-sections');
    el.after(document.getElementById('radar-tilt-block')); // it sits inside a section: keep it
    el.innerHTML = '';
    for (const [group, title] of RADAR_GROUPS) {
      const section = document.createElement('section');
      section.className = 'block';
      section.dataset.radarGroup = group;
      section.innerHTML = `<div class="block-title">${title}</div><div class="product-list"></div>`;
      const list = section.lastElementChild;
      for (const p of RADAR_PRODUCTS.filter((x) => x.group === group)) {
        const b = document.createElement('button');
        b.className = 'product';
        b.dataset.radarProduct = p.id;
        b.innerHTML = `<span class="name">${p.name}</span><span class="swatch"></span>`;
        b.addEventListener('click', () => this.available(p) && this.selectProduct(p.id));
        list.appendChild(b);
      }
      if (group === 'dualpol') {
        const row = document.createElement('div');
        row.className = 'res-row';
        row.innerHTML = `<span>Resolution</span><div class="segmented" id="radar-res">
          <button data-res="super" title="Level II at 0.5° × 250 m on the low tilts (CC, ZDR; KDP computed from ΦDP)">Super-res</button>
          <button data-res="legacy" title="Level III at 1° × 250 m">Legacy</button></div>`;
        row.querySelectorAll('[data-res]').forEach((b) => b.addEventListener('click', () => this.selectRes(b.dataset.res)));
        section.appendChild(row);
      }
      el.appendChild(section);
    }
    this.#syncProducts();
  }

  selectRes(res) {
    if (res === this.res) return;
    this.state.res = res;
    this.state.tilt = this.tilt;
    this.#syncProducts();
    if (this.product.group === 'dualpol' && this.site && hasLegacy(this.product, this.site.type)) this.onChange();
  }

  #syncRes() {
    const p = this.product;
    const site = this.site;
    const has = !!site && hasLegacy(p, site.type);
    const legacyOnly = p.group === 'dualpol' && !has;
    document.querySelectorAll('#radar-res [data-res]').forEach((b) => {
      b.classList.toggle('active', legacyOnly ? b.dataset.res === 'legacy' : b.dataset.res === this.res);
      b.disabled = p.group === 'dualpol' && !has;
    });
    const row = document.querySelector('.res-row');
    if (row) row.title = legacyOnly ? `${p.name} is only made at legacy resolution` : p.group === 'dualpol' ? '' : 'Applies to CC, ZDR and KDP';
  }

  #syncProducts() {
    const site = this.site;
    document.querySelectorAll('[data-radar-product]').forEach((b) => {
      const p = radarProductById[b.dataset.radarProduct];
      const ok = this.available(p);
      b.classList.toggle('active', p.id === this.product.id);
      b.classList.toggle('unavailable', !ok);
      b.title = ok ? sourceTitle(p, site, this.tilt, this.res) : `Not published by ${site ? TYPE_LABEL[site.type] : 'this'} radars`;
      b.querySelector('.swatch').style.background = swatch(p);
    });
    this.#syncTilts();
    this.#syncRes();
    this.#syncColorTable();
  }

  // ------------------------------------------------------------------ tilts
  #syncTilts() {
    const block = document.getElementById('radar-tilt-block');
    const el = document.getElementById('radar-tilts');
    const site = this.site;
    const p = this.product;
    const n = site ? tiltCount(p, site.type, this.res) : 0;
    block.hidden = n < 2;
    // Show the picker right under the section of the selected product.
    document.querySelector(`[data-radar-group="${p.group}"]`)?.after(block);
    if (n < 2) return;
    el.innerHTML = '';
    const nominal = NOMINAL_TILTS[site.type] ?? [];
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      const angle = this.angles[`${site.id}:${i}`] ?? nominal[i];
      b.className = 'pill' + (i === this.tilt ? ' active' : '');
      b.textContent = angle != null ? `${angle.toFixed(1)}°` : `T${i + 1}`;
      b.title = `Tilt ${i + 1}` + (this.angles[`${site.id}:${i}`] == null ? ' (nominal angle)' : '') + ' · ↑/↓ to step';
      b.addEventListener('click', () => this.selectTilt(i));
      el.appendChild(b);
    }
  }

  selectTilt(i) {
    const n = this.site ? tiltCount(this.product, this.site.type, this.res) : 1;
    if (i < 0 || i >= n || i === this.tilt) return;
    this.state.tilt = i;
    this.#syncProducts();
    this.onChange();
  }

  // ------------------------------------------------------------------ colour tables
  #syncColorTable() {
    const p = this.product;
    const custom = hasCustomColormap(p.id);
    document.getElementById('radar-ctable-product').textContent = p.short;
    document.getElementById('radar-ctable-name').textContent = custom ? colorTableName(p.id) ?? 'Custom' : 'Default';
    document.getElementById('radar-ctable-name').classList.toggle('custom', custom);
    document.getElementById('radar-ctable-reset').disabled = !custom;
    const upload = document.getElementById('radar-ctable-upload');
    upload.disabled = !!p.fixedColors;
    upload.title = p.fixedColors ? 'Precipitation type uses one palette per type' : 'GR2Analyst / RadarScope .pal, or "value r g b" lines';
  }

  async #uploadColorTable(file) {
    const p = this.product;
    try {
      const text = await file.text();
      const n = saveColorTable(p.id, file.name, text);
      this.setStatus(`${file.name}: ${n} colours applied to ${p.name.toLowerCase()}`, 'done');
    } catch (err) {
      this.setStatus(`Couldn't read ${file.name}: ${err.message}`, 'error');
      return;
    }
    this.#afterColorTable();
  }

  #afterColorTable() {
    this.#syncProducts();
    if (this.sweep && !this.sweep.empty && this.shownProduct === this.product) this.globe.setRadarLayer(this.sweep, this.product.colormap(), this.typeGrid, this.groundOpacity);
    this.onColors?.();
  }

  #siteInfo() {
    const el = document.getElementById('radar-site-info');
    const s = this.site;
    if (!s) return (el.innerHTML = '');
    const st = this.status.get(s.id);
    const state = !st ? '<span class="dot"></span>Status unknown' : st.down ? `<span class="dot down"></span>Down · ${escapeHtml(st.reason)}` : '<span class="dot up"></span>Online' + (st.vcp ? ` · VCP ${escapeHtml(String(st.vcp))}` : '');
    el.innerHTML = `<div class="site-title"><b>${s.id}</b> ${escapeHtml(s.name)}, ${escapeHtml(s.region)}</div><div class="site-state">${TYPE_LABEL[s.type]} · ${state}</div>`;
  }

  setFilter(text) {
    this.filter = text;
    this.buildSites();
  }

  // ------------------------------------------------------------------ markers
  #buildMarkers() {
    const el = this.markersEl;
    el.innerHTML = '';
    this.markers = this.sites.map((s) => {
      const m = document.createElement('button');
      m.className = `radar-marker ${s.type === 'TDWR' ? 'tdwr' : ''}`;
      m.innerHTML = `<i></i><span>${s.id}</span>`;
      m.title = `${s.id} · ${s.name}, ${s.region}`;
      m.addEventListener('click', () => this.selectSite(s.id, false));
      el.appendChild(m);
      return { site: s, el: m };
    });
  }

  #syncMarkers() {
    for (const { site, el } of this.markers ?? []) {
      el.classList.toggle('down', this.isDown(site.id));
      el.classList.toggle('active', site.id === this.state.site);
    }
  }

  #placeMarkers() {
    if (!this.active || !this.markers) return;
    const alt = this.globe.altitude;
    this.markersEl.classList.toggle('labelled', alt < MARKER_LABEL_ALT);
    const tdwr = alt < TDWR_MARKER_ALT;
    for (const { site, el } of this.markers) {
      const hidden = site.type === 'TDWR' && !tdwr && site.id !== this.state.site;
      const xy = hidden ? null : this.globe.project(site.lat, site.lon);
      if (!xy) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform = `translate(${xy[0].toFixed(1)}px, ${xy[1].toFixed(1)}px)`;
    }
  }

  // ------------------------------------------------------------------ selection
  selectSite(id, fly) {
    const s = this.siteById[id];
    if (!s) return;
    const changed = id !== this.state.site;
    this.state.site = id;
    if (!this.available(this.product)) this.state.product = 'ref';
    this.state.tilt = this.tilt;
    if (fly || this.globe.altitude > 1.5) this.globe.flyTo(s.lat, s.lon, s.type === 'TDWR' ? 1.1 : 1.3);
    this.#syncSitePills();
    this.#syncMarkers();
    this.#placeMarkers();
    this.#syncProducts();
    this.#siteInfo();
    if (changed) this.onChange();
  }

  selectProduct(id) {
    if (id === this.state.product) return;
    this.state.product = id;
    this.state.tilt = this.tilt;
    this.#syncProducts();
    this.onChange();
  }

  // ------------------------------------------------------------------ frames
  /**
   * Make sure the frame list matches the selection; returns true when it changed.
   * With `poll`, re-lists the current selection to pick up new scans.
   */
  async refreshFrames(poll = false) {
    const site = this.site;
    const p = this.product;
    if (!site || !this.available(p)) {
      this.frames = [];
      this.framesKey = '';
      return true;
    }
    const keyOf = () => `${this.site?.id}/${this.product.id}/${this.tilt}/${this.product.group === 'dualpol' ? this.res : ''}`;
    const key = keyOf();
    if (!poll && key === this.framesKey) return false;
    if (poll && key !== this.framesKey) return false;
    const frames = await listFrames(site, p, this.tilt, this.res);
    if (key !== keyOf()) return false; // selection moved on
    const before = this.frames.map((f) => f.url).join();
    const wasLatest = this.index >= this.frames.length - 1;
    this.frames = frames;
    this.framesKey = key;
    this.#markStale();
    this.#syncSitePills();
    this.#syncMarkers();
    this.#siteInfo();
    if (poll && before !== frames.map((f) => f.url).join()) {
      this.onFrames(wasLatest);
      return true;
    }
    return !poll;
  }

  /**
   * Draw frame i (fetching it if needed). Resolves to the drawn sweep, or null
   * if a newer request took over.
   * @param {object} [typeGrid] precipitation type grid to colour the sweep by
   */
  async show(i, typeGrid = null) {
    const seq = (this.showSeq = (this.showSeq ?? 0) + 1);
    const frame = this.frames[i];
    this.index = i;
    if (!frame) return null;
    const p = this.product;
    const sweep = await this.source.get(frame);
    if (seq !== this.showSeq) return null;
    this.sweep = sweep;
    this.shownProduct = p;
    this.typeGrid = typeGrid;
    // Learn the radar's real tilt angles for the picker.
    const angleKey = `${this.site.id}:${this.tilt}`;
    if (sweep.elevation != null && tiltCount(p, this.site.type, this.res) > 1 && this.angles[angleKey] !== sweep.elevation) {
      this.angles[angleKey] = sweep.elevation;
      this.#syncTilts();
    }
    if (sweep.empty) this.globe.clearLayer();
    else this.globe.setRadarLayer(sweep, p.colormap(), typeGrid, this.groundOpacity);
    return sweep;
  }

  /** Load every frame of the loop in the background, newest first. */
  async preload() {
    const seq = (this.loadSeq = (this.loadSeq ?? 0) + 1);
    const todo = this.frames.filter((f) => !this.source.has(f)).reverse();
    let next = 0;
    const lane = async () => {
      while (next < todo.length && seq === this.loadSeq) {
        const f = todo[next++];
        try {
          await this.source.get(f);
        } catch {
          // a missing frame shouldn't stop the rest
        }
        if (seq === this.loadSeq) this.onProgress();
      }
    };
    await Promise.all([lane(), lane(), lane()]);
    return seq === this.loadSeq;
  }

  /** Value under a point of the sweep on screen, with range and bearing from the radar. */
  probe(lat, lon) {
    const s = this.sweep;
    const site = this.site;
    if (!s || !site) return null;
    const lat0 = s.lat ?? site.lat;
    const lon0 = s.lon ?? site.lon;
    const km = distanceKm(lat0, lon0, lat, lon);
    const az = bearing(lat0, lon0, lat, lon);
    if (s.empty) return { km, az, value: NaN, inRange: km < 230 };
    const g = Math.floor((km - s.firstGateKm) / s.gateKm);
    const inRange = g >= 0 && g < s.nGates;
    const row = s.azLut[Math.min(3599, Math.floor(az * 10))];
    const value = inRange && row >= 0 ? s.values[row * s.nGates + g] : NaN;
    const tg = this.typeGrid;
    const type = tg ? sampleNearest(tg.types, tg.meta, lat, lon) : undefined;
    return { km, az, value, inRange, type: tg ? (Number.isFinite(type) ? type : tg.outside) : undefined };
  }
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / D2R) + 360) % 360;
}

function sourceTitle(p, site, tilt, res) {
  const src = site && sourceOf(p, site.type, tilt, res);
  if (!src) return '';
  if (src.level === 2) return `Level II ${src.derive === 'kdp' ? 'KDP from ΦDP' : src.moment.trim()}, tilt ${src.tilt + 1}`;
  if (p.hrrrTypes) return `Level III ${src.code}, typed by the latest HRRR (F01)`;
  return `Level III ${src.code}${src.pair ? `, minus the storm motion of ${src.pair}` : ''}`;
}

function swatch(p) {
  const cm = p.colormap();
  const stops = [];
  const row = p.typeRows ? 1 : 0;
  for (let i = 0; i <= 10; i++) {
    const c = cm.color(cm.valueAt(i / 10), row);
    stops.push(`rgba(${c[0]},${c[1]},${c[2]},${Math.max(0.25, c[3] / 255).toFixed(2)})`);
  }
  return `linear-gradient(90deg, ${stops.join(',')})`;
}
