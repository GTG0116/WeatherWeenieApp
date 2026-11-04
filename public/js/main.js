import { Globe } from './globe/globe.js';
import { WindParticles } from './globe/particles.js';
import { LabelLayer, contourLabelCandidates } from './globe/labels.js';
import { DataSource, sampleField, sampleNearest } from './data.js';
import { Accumulator } from './accum.js';
import { PRODUCTS, PTYPE_CATEGORY, PTYPE_NAMES, accumulationOf, isobarContour, productAvailable, productById } from './products.js';
import { PRECIP_TYPES } from './colormaps.js';
import { unitFor } from './units.js';
import { MODELS, hasProfiles, membersOf, supports } from './models.js';
import { MapTools } from './tools.js';
import { SoundingPanel } from './sounding.js';
import { CrossSectionPanel } from './xsect.js';
import { RadarView } from './radar/view.js';
import { PTYPE_UNKNOWN, radarProductById } from './radar/products.js';
import { STALE_MS, ago } from './radar/source.js';
import { Radar3D } from './radar/volume.js';

const $ = (sel) => document.querySelector(sel);
const STORE_KEY = 'model-globe-state-v1';

// ------------------------------------------------------------------ state
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
  } catch {
    return {};
  }
})();

const PRODUCT_GROUPS = ['upper', 'surface', 'severe', 'precip', 'winter'];

const savedMember = (model) => {
  const m = saved.members?.[model];
  return membersOf(model).some((x) => x.id === m) ? m : 'mean';
};

const state = {
  mode: saved.mode === 'radar' ? 'radar' : 'model', // weather models, or NEXRAD/TDWR radar
  radar: {
    site: saved.radar?.site ?? null,
    product: radarProductById[saved.radar?.product] ? saved.radar.product : 'ref',
    tilt: saved.radar?.tilt ?? 0,
    res: saved.radar?.res === 'legacy' ? 'legacy' : 'super', // dual-pol resolution
    vol: { ...saved.radar?.vol }, // 3D view look: style, height stretch, thresholds
  },
  model: MODELS[saved.model] ? saved.model : 'ifs',
  member: null, // ensemble member id ('mean', '0' control, '1'..), null for deterministic models
  members: { ...saved.members }, // last member picked per ensemble model
  productId: productById[saved.productId] ? saved.productId : 'wind',
  options: Object.fromEntries(PRODUCTS.filter((p) => p.options).map((p) => [p.id, saved.options?.[p.id] ?? p.defaultOption])),
  units: saved.units === 'metric' ? 'metric' : 'imperial',
  overlays: {
    particles: saved.overlays?.particles ?? true,
    contours: saved.overlays?.contours ?? true,
    isobars: saved.overlays?.isobars ?? null, // null = product default
    borders: saved.overlays?.borders ?? true,
    counties: saved.overlays?.counties ?? true,
  },
  // City values per product, where changed from the product's default (on for the
  // products that set `cityValues`, off for the rest). An old global "off" carries over.
  cityValues:
    saved.cityValues ??
    (saved.overlays?.cityValues === false ? Object.fromEntries(PRODUCTS.filter((p) => p.cityValues).map((p) => [p.id, false])) : {}),
  runs: [],
  run: null,
  stepIndex: 0,
  playing: false,
};
state.member = membersOf(state.model).length ? savedMember(state.model) : null;

function persist() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        mode: state.mode,
        radar: state.radar,
        model: state.model,
        members: state.members,
        productId: state.productId,
        options: state.options,
        units: state.units,
        overlays: state.overlays,
        cityValues: state.cityValues,
      }),
    );
  } catch {
    // storage unavailable: settings just won't persist
  }
}

const product = () => productById[state.productId];
const option = () => state.options[state.productId];
const steps = () => state.run?.steps ?? [];
const radarMode = () => state.mode === 'radar';
// Timeline positions: forecast steps, or radar frames in radar mode.
const frameCount = () => (radarMode() ? radar.frames.length : steps().length);
const step = () => steps()[state.stepIndex] ?? 0;
const runTime = (run) => Date.UTC(+run.date.slice(0, 4), +run.date.slice(4, 6) - 1, +run.date.slice(6, 8), run.hour);
const hasIsobars = (p, model = state.model) => !!p.isobars && supports(model, 'msl', undefined, state.member);
const isobarsOn = (p) => hasIsobars(p) && (state.overlays.isobars ?? !!p.isobarsDefault);
const cityValuesOn = (p) => state.cityValues[p.id] ?? !!p.cityValues;
const available = (p, model = state.model) => productAvailable(p, model, undefined, state.member);
const accumulation = (p = product()) => accumulationOf(p, state.model);
const modelName = (model = state.model) => MODELS[model].name;
// The run as the data layer sees it: ensemble members are cached under "run~member".
const runKey = () => (state.member ? `${state.run.id}~${state.member}` : state.run.id);
const dataRun = () => ({ ...state.run, id: runKey() });
const memberName = () =>
  !state.member ? '' : state.member === 'mean' ? ' mean' : state.member === '0' ? ' control' : ` member ${state.member}`;

// ------------------------------------------------------------------ setup
const globe = new Globe($('#globe'));
const labels = new LabelLayer($('#labels'), globe);
const particles = new WindParticles(globe);
const data = new DataSource();
const accum = new Accumulator(data);
let current = null; // what's on the globe now
const radar = new RadarView({
  globe,
  state: state.radar,
  setStatus: (...a) => setStatus(...a),
  onChange: () => {
    persist();
    buildOverlays();
    render();
  },
  // New scans arrived: follow them if the loop was on the latest frame.
  onFrames: (follow) => {
    if (!radarMode()) return;
    state.stepIndex = follow ? radar.frames.length - 1 : Math.min(state.stepIndex, radar.frames.length - 1);
    buildTimeline();
    if (follow && !state.playing) render();
  },
  onProgress: () => {
    if (radarMode() && !state.playing) markCached();
  },
});
const radar3d = new Radar3D({
  globe,
  source: radar.source,
  state: state.radar.vol,
  units: () => state.units,
  setStatus: (...a) => setStatus(...a),
  onChange: persist,
  onToggle: (on) => {
    radar.groundOpacity = on ? 0.55 : 1;
    document.body.classList.toggle('radar-3d', on);
    if (radarMode()) render();
  },
});

// ------------------------------------------------------------------ HRRR for radar
// Radar precipitation type comes from the latest HRRR run's forecast hour 1;
// right-click soundings over radar from its analysis (F000).
const HRRR_RECHECK_MS = 10 * 60e3;
const hrrr = { runs: null, checked: 0, ptype: null, soundingRun: null };

async function refreshHrrrRuns() {
  hrrr.checked = Date.now();
  hrrr.runs = (await data.runs('hrrr')).runs;
}

async function latestHrrrRun(step) {
  // Listing the bucket takes a few seconds: after the first time, newer runs are
  // picked up in the background instead of holding up the frame on screen.
  if (!hrrr.runs) await refreshHrrrRuns();
  else if (Date.now() - hrrr.checked > HRRR_RECHECK_MS) refreshHrrrRuns().catch(() => {});
  const run = hrrr.runs.find((r) => r.steps.includes(step));
  if (!run) throw new Error(`no HRRR run has F${String(step).padStart(3, '0')} yet`);
  return run;
}

/**
 * Surface precipitation type from the latest HRRR F001, as precip-type LUT rows
 * (1 rain, 2 snow, 3 sleet/mix, 4 freezing rain). Where the HRRR has no
 * precipitation of its own, the 2 m wet-bulb temperature decides rain or snow.
 */
async function hrrrPtype() {
  const run = await latestHrrrRun(1);
  if (hrrr.ptype?.run.id === run.id) return hrrr.ptype;
  const inp = await data.inputs('hrrr', run.id, 1, { ptype: { param: 'ptype' }, t2: { param: '2t' }, d2: { param: '2d' } });
  const pt = inp.ptype.values;
  const t2 = inp.t2.values;
  const d2 = inp.d2.values;
  const types = new Float32Array(pt.length);
  for (let i = 0; i < pt.length; i++) {
    let row = PTYPE_CATEGORY[Math.round(pt[i])] ?? 0;
    if (!row) {
      const t = t2[i] - 273.15;
      const tw = t - (t - Math.min(t, d2[i] - 273.15)) / 3; // one-third rule wet-bulb
      row = !Number.isFinite(t) ? PTYPE_UNKNOWN : tw <= 0.5 ? 2 : 1;
    }
    types[i] = row;
  }
  hrrr.ptype = { run, types, meta: inp.ptype.meta, outside: PTYPE_UNKNOWN };
  return hrrr.ptype;
}

const hrrrRunLabel = (r) => `HRRR ${String(r.hour).padStart(2, '0')}Z F01`;

// ------------------------------------------------------------------ soundings & cross sections
// What the analysis panels show: the model, member, run and forecast hour on screen.
const analysisContext = () => {
  if (radarMode()) {
    // Right-click soundings over radar: the latest HRRR analysis.
    const r = hrrr.soundingRun;
    return {
      model: 'hrrr',
      member: null,
      run: r.id,
      step: 0,
      nextStep: null,
      modelName: 'HRRR analysis',
      title: `${String(r.hour).padStart(2, '0')}Z ${r.date.slice(4, 6)}/${r.date.slice(6, 8)} run · F000`,
      units: state.units,
    };
  }
  const r = state.run;
  return {
    model: state.model,
    member: state.member,
    run: runKey(),
    step: step(),
    nextStep: steps()[state.stepIndex + 1] ?? null, // prefetched while a panel is open
    modelName: `${modelName()}${memberName()}`,
    title: `Valid ${$('#valid-utc').textContent} · ${$('#fhour').textContent} · ${String(r.hour).padStart(2, '0')}Z ${r.date.slice(4, 6)}/${r.date.slice(6, 8)} run`,
    units: state.units,
  };
};
const TOOL_HINTS = {
  point: 'Click the map for a sounding (or right-click any time) · Esc to cancel',
  box: 'Click two opposite corners of the box (or right-drag any time) · Esc to cancel',
  line: 'Click the start, then the end of the cross section · Esc to cancel',
};
const tools = new MapTools(globe, $('#stage'), {
  onPoint: (ll) => sounding.open({ kind: 'point', lat: ll.lat, lon: ll.lon }),
  onBox: (box) => sounding.open({ kind: 'box', box }),
  onLine: (a, b) => xsect.open(a, b),
  onModeChange: (mode) => {
    document.querySelectorAll('#map-tools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === mode));
    $('#tool-hint').hidden = !mode;
    $('#tool-hint').textContent = TOOL_HINTS[mode] ?? '';
  },
});
const sounding = new SoundingPanel({ data, context: analysisContext, onClose: () => tools.clearShape('sounding') });
const xsect = new CrossSectionPanel({ data, context: analysisContext, onClose: () => tools.clearShape('xsect') });

let panelTimer = null;
/** Follow the map: reload open panels for the new hour, model or member (not while playing). */
function refreshPanels() {
  clearTimeout(panelTimer);
  if (state.playing || !state.run) return;
  panelTimer = setTimeout(() => {
    if (sounding.isOpen) sounding.refresh();
    if (xsect.isOpen) xsect.refresh();
  }, 200);
}
// handy for console debugging (actions are filled in below)
window.modelGlobe = { globe, state, data, tools, sounding, xsect, actions: {} };

const LINE_THEMES = {
  light: { coast: [0xe9eef5, 0.85], lakes: [0xe9eef5, 0.6], borders: [0xe9eef5, 0.6], states: [0xe9eef5, 0.42], counties: [0xe9eef5, 0.2] },
  dark: { coast: [0x06090e, 0.85], lakes: [0x06090e, 0.6], borders: [0x06090e, 0.65], states: [0x06090e, 0.5], counties: [0x06090e, 0.26] },
};
const CONTOUR_COLORS = { dark: [0.03, 0.04, 0.06], light: [0.94, 0.96, 0.99] };

// [layer, zoomed-out file, zoomed-in file, width]. Zoomed in, US state lines
// are the Census 1:500k ones (tools/build-states.mjs), matching the counties.
const LINE_LAYERS = [
  ['states', 'states-50m', 'states-hi', 0.8],
  ['borders', 'borders-50m', 'borders-10m', 1.1],
  ['lakes', 'lakes-50m', 'lakes-10m', 0.9],
  ['coast', 'coastline-50m', 'coastline-10m', 1.25],
];

async function loadLines(lod) {
  const bufs = await Promise.all(
    LINE_LAYERS.map(([, lo, hi]) => fetch(`data/geo/${lod === 'hi' ? hi : lo}.bin`).then((r) => r.arrayBuffer())),
  );
  LINE_LAYERS.forEach(([name, , , width], i) => globe.setLines(name, bufs[i], { lod, width }));
  applyLineTheme();
}

async function loadCounties() {
  const buf = await fetch('data/geo/counties-500k.bin').then((r) => r.arrayBuffer());
  // Drawn beneath state lines, and only once zoomed in to a regional view.
  globe.setLines('counties', buf, { lod: 'hi', width: 0.7, maxAltitude: 0.42, order: 1.9 });
  applyLineTheme();
}

async function loadGeo() {
  // Natural Earth 50m for the whole globe; 10m (its highest resolution) plus
  // Census 1:500k US states and counties once zoomed in.
  globe.onNeedHiRes(() => {
    loadCounties().catch((err) => console.error('counties', err));
    loadLines('hi').catch((err) => console.error('hi-res lines', err));
  });
  await Promise.all([loadLines('lo'), labels.loadPlaces()]);
}

function applyLineTheme() {
  const theme = LINE_THEMES[current?.product.lineTheme ?? 'light'];
  for (const [name, [color, opacity]] of Object.entries(theme)) {
    const visible = name === 'counties' ? state.overlays.counties : name === 'coast' || name === 'lakes' || state.overlays.borders;
    globe.setLineStyle(name, { color, opacity, visible });
  }
}

// ------------------------------------------------------------------ status
let statusTimer = null;
function setStatus(text, kind = 'busy') {
  const el = $('#status');
  clearTimeout(statusTimer);
  el.className = kind;
  $('#status-text').textContent = text;
  if (kind === 'done') statusTimer = setTimeout(() => (el.className = 'idle'), 2200);
}

// ------------------------------------------------------------------ UI build
function swatchCss(p) {
  const opt = p.options ? p.defaultOption : undefined;
  const cm = p.colormap(opt);
  const row = p.precipLegend ? 1 : 0;
  const stops = [];
  for (let i = 0; i <= 10; i++) {
    const c = cm.color(cm.valueAt(i / 10), row);
    stops.push(`rgba(${c[0]},${c[1]},${c[2]},${Math.max(0.25, c[3] / 255).toFixed(2)})`);
  }
  return `linear-gradient(90deg, ${stops.join(',')})`;
}

function buildModels() {
  const el = $('#models');
  el.innerHTML = '';
  for (const [group, label] of [['global', 'Global'], ['ensemble', 'Ensembles'], ['regional', 'North America']]) {
    const head = document.createElement('div');
    head.className = 'model-group';
    head.textContent = label;
    el.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'model-grid';
    for (const [id, m] of Object.entries(MODELS).filter(([, m]) => m.group === group)) {
      const b = document.createElement('button');
      b.dataset.model = id;
      b.title = m.name;
      b.innerHTML = `${m.label} <span class="seg-sub">${m.sub}</span>`;
      b.addEventListener('click', () => setModel(id));
      grid.appendChild(b);
    }
    el.appendChild(grid);
  }
}

function buildMembers() {
  const list = membersOf(state.model);
  const sel = $('#member-select');
  $('#member-field').hidden = !list.length;
  sel.innerHTML = list.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  if (state.member) sel.value = state.member;
}

function buildProducts() {
  for (const group of PRODUCT_GROUPS) {
    const list = $(`#products-${group}`);
    for (const p of PRODUCTS.filter((x) => x.group === group)) {
      const b = document.createElement('button');
      b.className = 'product';
      b.dataset.id = p.id;
      b.innerHTML = `<span class="name">${p.name}</span><span class="swatch" style="background:${swatchCss(p)}"></span>`;
      b.addEventListener('click', () => available(p) && selectProduct(p.id));
      list.appendChild(b);
    }
  }
}

function buildOptions() {
  const p = product();
  const el = $('#options');
  const block = $('#level-block');
  el.innerHTML = '';
  const opts = p.options ?? PRODUCTS.find((x) => x.group === 'upper').options;
  const isLevels = typeof opts[0].value === 'number';
  block.querySelector('.block-title').firstChild.textContent = p.optionsTitle ?? (isLevels ? 'Level ' : 'Layer ');
  block.querySelector('.hint').textContent = isLevels ? 'hPa' : '';
  el.className = 'pills' + (isLevels ? '' : ' wide');
  // Show the level/layer picker right under the active product group.
  block.hidden = !p.options;
  $(`#products-${p.group}`).closest('.block').after(block);
  for (const o of opts) {
    const b = document.createElement('button');
    const ok = !p.options || productAvailable(p, state.model, o.value, state.member);
    b.className = 'pill' + (p.options && o.value === option() ? ' active' : '') + (ok ? '' : ' unavailable');
    b.textContent = o.label;
    b.disabled = !ok;
    if (!ok) b.title = `Not published by ${modelName()}`;
    b.addEventListener('click', () => {
      state.options[p.id] = o.value;
      persist();
      buildOptions();
      render();
    });
    el.appendChild(b);
  }
}

function buildOverlays() {
  const p = radarMode() ? radar.product : product();
  const el = $('#overlays');
  el.innerHTML = '';
  const add = (key, label, sub, enabled, on, onToggle) => {
    const row = document.createElement('div');
    row.className = `toggle${on && enabled ? ' on' : ''}${enabled ? '' : ' disabled'}`;
    row.innerHTML = `<span>${label}${sub ? `<span class="sub">${sub}</span>` : ''}</span><span class="switch"></span>`;
    if (enabled) row.addEventListener('click', onToggle);
    row.dataset.key = key;
    el.appendChild(row);
  };
  const flip = (key) => () => {
    state.overlays[key] = !state.overlays[key];
    persist();
    buildOverlays();
    if (key === 'borders' || key === 'counties') applyLineTheme();
    else if (key === 'particles') particles.setEnabled(state.overlays.particles && !!current?.vectors);
    else render();
  };
  if (!radarMode()) add('particles', 'Wind particles', p.particles ? null : 'Wind products only', !!p.particles, state.overlays.particles, flip('particles'));
  if (radarMode()) {
    // no contours or isobars over radar
  } else if (p.group === 'upper') {
    add('contours', 'Height contours', 'Geopotential, dam', true, state.overlays.contours, flip('contours'));
  } else {
    add('isobars', 'Isobars', 'Mean sea-level pressure, hPa', hasIsobars(p), isobarsOn(p), () => {
      state.overlays.isobars = !isobarsOn(p);
      persist();
      buildOverlays();
      render();
    });
  }
  add('cityValues', 'City values', p.cityValues ? 'Shown above town names' : 'Off by default for this product', true, cityValuesOn(p), () => {
    const on = !cityValuesOn(p);
    if (on === !!p.cityValues) delete state.cityValues[p.id];
    else state.cityValues[p.id] = on;
    persist();
    buildOverlays();
    updateCityValues();
  });
  add('borders', 'Borders & states', null, true, state.overlays.borders, flip('borders'));
  add('counties', 'US counties', 'Shown when zoomed in', true, state.overlays.counties, flip('counties'));
}

function syncProductButtons() {
  document.querySelectorAll('.product[data-id]').forEach((b) => {
    const p = productById[b.dataset.id];
    const ok = available(p);
    b.classList.toggle('active', b.dataset.id === state.productId);
    b.classList.toggle('unavailable', !ok);
    b.title = ok ? '' : `Not available from ${modelName()}`;
  });
  document.querySelectorAll('#models button').forEach((b) => b.classList.toggle('active', b.dataset.model === state.model));
  document.querySelectorAll('#mode-switch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  $('.brand-sub').textContent = radarMode() ? 'NEXRAD & TDWR radar' : 'Global NWP viewer';
  $('#credit').textContent = radarMode() ? 'NOAA NEXRAD & TDWR Level II/III (Unidata on AWS), NWS radar status' : MODELS[state.model].credit;
  const profiles = hasProfiles(state.model, state.member) && !radarMode();
  tools.enabled = profiles;
  document.querySelectorAll('#map-tools .tool').forEach((b) => {
    b.disabled = !profiles;
    b.title = profiles ? b.title.replace(/ — not available.*$/, '') : `${b.title.replace(/ — not available.*$/, '')} — not available for ${modelName()}`;
  });
  if (!profiles && tools.mode) tools.setMode(null);
}

/** Keep the product's option valid for the current model (e.g. 10 hPa isn't in every model). */
function fixOption() {
  const p = product();
  if (!p.options || productAvailable(p, state.model, option(), state.member)) return;
  const ok = p.options.filter((o) => productAvailable(p, state.model, o.value, state.member));
  if (!ok.length) return;
  const levels = typeof ok[0].value === 'number';
  state.options[p.id] = levels
    ? ok.reduce((a, b) => (Math.abs(b.value - option()) < Math.abs(a.value - option()) ? b : a)).value
    : ok.find((o) => o.value === p.defaultOption)?.value ?? ok[0].value;
}

async function setModel(model) {
  const fromRadar = radarMode();
  if (fromRadar) leaveRadar();
  if (model === state.model && !fromRadar) return;
  if (model === state.model && state.run) {
    syncProductButtons();
    buildOptions();
    buildOverlays();
    setRun(state.run, 0);
    render();
    return;
  }
  const prevStep = state.run ? step() : 0;
  const wasRegional = !!MODELS[state.model].regional;
  state.model = model;
  state.member = membersOf(model).length ? savedMember(model) : null;
  if (!available(product())) state.productId = 't2m';
  fixOption();
  persist();
  syncProductButtons();
  buildMembers();
  buildOptions();
  buildOverlays();
  // Regional models only cover North America: bring it into view.
  if (MODELS[model].regional && !wasRegional) globe.flyTo(38, -96, Math.min(globe.targetDistance, globe.homeDistance));
  try {
    setStatus(`Finding the latest ${modelName(model)} run…`);
    await loadRuns(false, prevStep);
    render();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

// ------------------------------------------------------------------ radar mode
async function enterRadar() {
  if (radarMode() && radar.active) return;
  state.mode = 'radar';
  persist();
  setPlaying(false);
  if (tools.mode) tools.setMode(null);
  sounding.close();
  xsect.close();
  particles.clear();
  particles.setEnabled(false);
  labels.setContourLabels([]);
  current = null;
  globe.clearLayer();
  $('#legend').innerHTML = '';
  syncProductButtons();
  buildOverlays();
  setStatus('Loading radar sites…');
  try {
    await radar.activate();
  } catch (err) {
    setStatus(`Couldn't load the radar list: ${err.message}`, 'error');
    return;
  }
  const site = radar.site;
  if (site && globe.altitude > 1.5) globe.flyTo(site.lat, site.lon, 1.3);
  state.stepIndex = 0;
  buildTimeline();
  await render();
}

function leaveRadar() {
  state.mode = 'model';
  radar3d.toggle(false);
  radar.deactivate();
  setPlaying(false);
  current = null;
  globe.clearLayer();
  persist();
}

function selectProduct(id) {
  if (id === state.productId) return;
  state.productId = id;
  fixOption();
  persist();
  syncProductButtons();
  buildOptions();
  buildOverlays();
  render();
}

function buildUnits() {
  document.querySelectorAll('#units button').forEach((b) => {
    b.classList.toggle('active', b.dataset.units === state.units);
    b.onclick = () => {
      state.units = b.dataset.units;
      persist();
      buildUnits();
      if (current) {
        drawLegend();
        updateCityValues();
        refreshTooltip();
        if (current.contour) labels.setContourLabels(contourLabels(current.contour, current.meta));
      }
      sounding.setUnits(state.units);
      xsect.setUnits(state.units);
      radar3d.sync();
    };
  });
}

// ------------------------------------------------------------------ runs + timeline
function fmtRun(r) {
  const d = new Date(runTime(r));
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const last = r.steps[r.steps.length - 1];
  return `${String(r.hour).padStart(2, '0')}Z ${day} · F${last}${r.complete ? '' : ' (in progress)'}`;
}

async function loadRuns(keepSelection = false, prevStep = step()) {
  const model = state.model;
  const { runs } = await data.runs(model);
  if (model !== state.model) return; // switched models meanwhile
  if (!runs.length) throw new Error(`No ${modelName(model)} runs available from the open-data bucket right now`);
  const prevId = state.run?.id;
  state.runs = runs;
  const sel = $('#run-select');
  sel.innerHTML = runs.map((r) => `<option value="${r.id}">${fmtRun(r)}</option>`).join('');
  // Default to the newest run that's far enough along to be useful.
  const run =
    (keepSelection && runs.find((r) => r.id === prevId)) ||
    runs.find((r) => r.steps.length >= Math.min(24, r.expected.length)) ||
    runs[0];
  sel.value = run.id;
  setRun(run, prevStep);
}

function setRun(run, preferStep = 0) {
  state.run = run;
  let idx = run.steps.indexOf(preferStep);
  if (idx < 0) idx = Math.max(0, run.steps.findIndex((s) => s >= preferStep));
  state.stepIndex = idx;
  buildTimeline();
}

function buildTimeline() {
  if (radarMode()) return buildRadarTimeline();
  const s = steps();
  const input = $('#step');
  input.max = Math.max(0, s.length - 1);
  input.value = state.stepIndex;
  const t0 = runTime(state.run);
  const n = Math.max(1, s.length - 1);
  // Day labels at 00 UTC boundaries
  const days = $('#days');
  const ticks = $('#ticks');
  days.innerHTML = '';
  ticks.innerHTML = '';
  let lastLabelPct = -100;
  const minGapPct = (58 / Math.max(120, days.clientWidth)) * 100;
  s.forEach((st, i) => {
    const t = new Date(t0 + st * 3600e3);
    const pct = (i / n) * 100;
    const tick = document.createElement('i');
    tick.style.left = `${pct}%`;
    tick.dataset.step = st;
    if (t.getUTCHours() === 0) {
      tick.className = 'day';
      if (pct - lastLabelPct > minGapPct && pct < 100 - minGapPct / 2) {
        const span = document.createElement('span');
        span.style.left = `${pct}%`;
        span.textContent = `${t.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${t.getUTCDate()}`;
        days.appendChild(span);
        lastLabelPct = pct;
      }
    }
    ticks.appendChild(tick);
  });
  syncTimeline();
}

function syncTimeline() {
  if (radarMode()) return syncRadarTimeline();
  const input = $('#step');
  input.value = state.stepIndex;
  const n = Math.max(1, steps().length - 1);
  input.style.setProperty('--fill', `${(state.stepIndex / n) * 100}%`);
  const t = new Date(runTime(state.run) + step() * 3600e3);
  $('#valid-utc').textContent =
    t.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }) +
    ' ' + String(t.getUTCHours()).padStart(2, '0') + 'Z';
  $('#valid-local').textContent = t.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  $('#fhour').textContent = 'F' + String(step()).padStart(3, '0');
}

/** Whether a step of the current view is ready without fetching anything. */
function isCached(s, p = product(), spec = inputSpec()) {
  const kind = accumulation(p);
  return kind ? accum.has(kind, state.model, dataRun(), s) : data.has(state.model, runKey(), s, spec);
}

function markCached() {
  if (radarMode()) {
    let n = 0;
    document.querySelectorAll('#ticks i').forEach((tick) => {
      const f = radar.frames[Number(tick.dataset.frame)];
      const cached = !!f && radar.source.has(f);
      tick.classList.toggle('cached', cached);
      n += cached;
    });
    return n;
  }
  if (!state.run) return 0;
  const p = product();
  const spec = inputSpec();
  let n = 0;
  document.querySelectorAll('#ticks i').forEach((tick) => {
    const cached = isCached(Number(tick.dataset.step), p, spec);
    tick.classList.toggle('cached', cached);
    n += cached;
  });
  return n;
}

// Radar loop: one tick per scan, labelled at each local hour.
function buildRadarTimeline() {
  const frames = radar.frames;
  const input = $('#step');
  input.max = Math.max(0, frames.length - 1);
  state.stepIndex = Math.max(0, Math.min(state.stepIndex, frames.length - 1));
  const days = $('#days');
  const ticks = $('#ticks');
  days.innerHTML = '';
  ticks.innerHTML = '';
  const n = Math.max(1, frames.length - 1);
  const minGapPct = (52 / Math.max(120, days.clientWidth)) * 100;
  let lastLabelPct = -100;
  frames.forEach((f, i) => {
    const pct = (i / n) * 100;
    const tick = document.createElement('i');
    tick.style.left = `${pct}%`;
    tick.dataset.frame = i;
    const hour = new Date(f.time).getHours();
    if (i > 0 && hour !== new Date(frames[i - 1].time).getHours()) {
      tick.className = 'day';
      if (pct - lastLabelPct > minGapPct && pct < 100 - minGapPct / 2) {
        const span = document.createElement('span');
        span.style.left = `${pct}%`;
        span.textContent = new Date(f.time).toLocaleTimeString('en-US', { hour: 'numeric' });
        days.appendChild(span);
        lastLabelPct = pct;
      }
    }
    ticks.appendChild(tick);
  });
  syncRadarTimeline();
  markCached();
}

function syncRadarTimeline() {
  const input = $('#step');
  const frames = radar.frames;
  input.value = state.stepIndex;
  input.style.setProperty('--fill', `${(state.stepIndex / Math.max(1, frames.length - 1)) * 100}%`);
  const f = frames[state.stepIndex];
  if (!f) {
    $('#valid-utc').textContent = '—';
    $('#valid-local').textContent = '';
    $('#fhour').textContent = radar.site?.id ?? '';
    return;
  }
  const t = new Date(f.time);
  $('#valid-utc').textContent =
    t.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }) +
    ' ' + t.toISOString().slice(11, 16) + 'Z';
  $('#valid-local').textContent = t.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  $('#fhour').textContent = state.stepIndex === frames.length - 1 ? `Latest · ${ago(Date.now() - f.time)}` : ago(Date.now() - f.time);
}

function setStep(i) {
  const max = frameCount() - 1;
  state.stepIndex = Math.max(0, Math.min(max, i));
  syncTimeline();
  render();
}

// ------------------------------------------------------------------ rendering
function inputSpec(p = product(), opt = option()) {
  if (accumulation(p)) return {};
  const spec = { ...p.inputs(opt) };
  if (p.group === 'surface' && isobarsOn(p)) spec.msl = { param: 'msl' };
  return spec;
}

let renderSeq = 0;
let renderDone = Promise.resolve();

function render() {
  const seq = ++renderSeq;
  renderDone = radarMode() ? doRadarRender(seq) : doRender(seq);
  if (!radarMode()) refreshPanels();
  return renderDone;
}

async function doRadarRender(seq) {
  const site = radar.site;
  const p = radar.product;
  if (!site) return;
  const head = `${site.id} ${site.name}`;
  $('#title').textContent = `${head} · ${p.name}`;
  radar3d.setSite(site);
  radar3d.setProduct(p);
  const blank = (msg) => {
    current = null;
    globe.clearLayer();
    $('#legend').innerHTML = '';
    refreshTooltip();
    setStatus(msg, 'error');
  };
  if (!radar.available(p)) return blank(`${p.name} isn't published by ${site.type === 'TDWR' ? 'TDWR' : 'NEXRAD'} radars`);
  try {
    if (await radar.refreshFrames()) {
      if (seq !== renderSeq) return;
      state.stepIndex = Math.max(0, radar.frames.length - 1);
      buildTimeline();
    }
  } catch (err) {
    if (seq === renderSeq) blank(`Couldn't list ${site.id} scans: ${err.message}`);
    return;
  }
  if (seq !== renderSeq) return;
  if (!radar.frames.length) {
    buildTimeline();
    return blank(`No ${p.name.toLowerCase()} from ${site.id} in the past day${radar.isDown(site.id) ? ' (radar down)' : ''}`);
  }
  state.stepIndex = Math.max(0, Math.min(state.stepIndex, radar.frames.length - 1));
  syncTimeline();
  const frame = radar.frames[state.stepIndex];
  const t0 = performance.now();
  if (!radar.source.has(frame)) setStatus(`Fetching & decoding ${site.id} ${p.short} · ${new Date(frame.time).toISOString().slice(11, 16)}Z…`);
  let typeGrid = null;
  let typeError = null;
  if (p.hrrrTypes) {
    if (!hrrr.ptype) setStatus('Loading the latest HRRR precipitation type…');
    try {
      typeGrid = await hrrrPtype();
    } catch (err) {
      typeError = err.message;
    }
    if (seq !== renderSeq) return;
  }
  let sweep;
  try {
    sweep = await radar.show(state.stepIndex, typeGrid);
  } catch (err) {
    if (seq === renderSeq) setStatus(`Couldn't load the ${site.id} scan: ${err.message}`, 'error');
    return;
  }
  if (!sweep || seq !== renderSeq) return;
  current = { product: p, option: null, radar: true, sample: (lat, lon) => radar.probe(lat, lon)?.value ?? NaN };
  particles.clear();
  particles.setEnabled(false);
  labels.setContourLabels([]);
  const tilt = sweep.elevation != null ? ` · ${sweep.elevation.toFixed(1)}°` : '';
  const span = p.precip && sweep.span ? ` · ${sweep.span / 60} h` : '';
  const typed = typeGrid ? ` · ${hrrrRunLabel(typeGrid.run)}` : '';
  $('#title').textContent = `${head} · ${p.name}${tilt}${span}${typed}`;
  updateCityValues();
  applyLineTheme();
  drawLegend();
  refreshTooltip();
  const age = Date.now() - frame.time;
  const ms = performance.now() - t0;
  if (typeError) setStatus(`Couldn't load the HRRR precipitation type: ${typeError}`, 'error');
  else if (state.stepIndex === radar.frames.length - 1 && age > STALE_MS) setStatus(`${site.id}'s latest scan is from ${ago(age)}`, 'error');
  else if (sweep.empty) setStatus(p.precip ? 'No precipitation in this period' : 'Nothing detected in this scan', 'done');
  else setStatus(ms > 60 ? `Decoded ${site.id} ${p.short} locally · ${Math.round(ms)} ms` : 'Ready', 'done');
  markCached();
  radar3d.update(site, p, frame.time);
  if (!state.playing && radar.frames.some((f) => !radar.source.has(f))) {
    radar.preload().then((done) => {
      if (done && seq === renderSeq && !state.playing) {
        const n = markCached();
        setStatus(`${n} of ${radar.frames.length} scans loaded`, 'done');
      }
    });
  }
}

async function doRender(seq) {
  if (!state.run) return;
  const p = product();
  const opt = option();
  const run = dataRun();
  const model = state.model;
  const st = step();
  const spec = inputSpec(p, opt);
  data.focusStep = st;
  $('#title').textContent = `${modelName(model)}${memberName()} · ${p.title(opt, model)}`;
  const kind = accumulation(p);
  const n = Object.keys(spec).length;
  const t0 = performance.now();
  const validTime = new Date(runTime(run) + st * 3600e3);
  let inp = {};
  let res;
  let meta;

  const problem = p.check?.(opt, st, state.run);
  if (problem) {
    current = null;
    globe.clearLayer();
    particles.clear();
    particles.setEnabled(false);
    labels.setContourLabels([]);
    labels.setValueFn(null);
    $('#legend').innerHTML = '';
    setStatus(problem, 'error');
    return;
  }
  if (!available(p, model)) {
    setStatus(`${p.name} isn't available from ${modelName(model)}`, 'error');
    return;
  }

  if (kind) {
    // Winter totals: summed interval by interval from F000 (see accum.js).
    if (!accum.has(kind, model, run, st)) setStatus(`Accumulating ${p.name.toLowerCase()} to F${st}…`);
    try {
      const a = await accum.get(kind, model, run, st, {
        onProgress: (done, total) => {
          if (seq === renderSeq) setStatus(`Accumulating ${p.name.toLowerCase()} to F${st} · ${done}/${total} intervals…`);
        },
        cancelled: () => seq !== renderSeq,
      });
      if (!a || seq !== renderSeq) return;
      res = { field: p.select(a.acc) };
      meta = a.meta;
    } catch (err) {
      if (seq === renderSeq) setStatus(`Couldn't accumulate to F${st}: ${err.message}`, 'error');
      return;
    }
  } else {
    if (!data.has(model, run.id, st, spec)) setStatus(`Fetching & decoding ${n} field${n > 1 ? 's' : ''}…`);
    try {
      inp = await data.inputs(model, run.id, st, spec);
    } catch (err) {
      if (seq === renderSeq) setStatus(`Couldn't load F${st}: ${err.message}`, 'error');
      return;
    }
    if (seq !== renderSeq) return;
    try {
      res = await p.compute(inp, { option: opt, validTime });
    } catch (err) {
      setStatus(`Couldn't compute product: ${err.message}`, 'error');
      return;
    }
    if (seq !== renderSeq) return;
    meta = Object.values(inp)[0].meta;
  }
  let contour = res.contour ?? null;
  if (p.group === 'upper' && !state.overlays.contours && p.id !== 'height') contour = null;
  if (p.group === 'surface') contour = isobarsOn(p) ? isobarContour(inp) : null;
  const theme = p.contourTheme ?? 'dark';

  current = { product: p, option: opt, field: res.field, types: res.types, meta, contour, vectors: res.vectors, step: st, run: state.run };

  globe.setLayer({
    values: res.field,
    meta,
    colormap: p.colormap(opt),
    types: res.types,
    contour: contour && { ...contour, color: CONTOUR_COLORS[theme], alpha: theme === 'dark' ? 0.78 : 0.7 },
    iso: res.iso != null ? { value: res.iso, color: [1, 1, 1] } : null,
  });

  if (res.vectors) {
    particles.setField(res.vectors.u, res.vectors.v, meta, p.particleSpeed ?? 1);
    particles.setEnabled(state.overlays.particles);
  } else {
    particles.clear();
    particles.setEnabled(false);
  }

  labels.setContourLabels(contour ? contourLabels(contour, meta) : []);
  updateCityValues();
  applyLineTheme();
  drawLegend();
  refreshTooltip();

  const ms = performance.now() - t0;
  const what = kind ? 'Accumulated locally' : `Decoded ${n} field${n > 1 ? 's' : ''} locally`;
  setStatus(ms > 60 ? `${what} · ${Math.round(ms)} ms` : 'Ready', 'done');
  markCached();
  preload(seq);
}

function contourLabels(contour, meta) {
  return contourLabelCandidates(contour.values, meta, contour.interval, (v) => String(Math.round(v)));
}

/**
 * Load every forecast hour of the run for the current view, starting just
 * after the one on screen, so the whole run can loop without waiting. Stops
 * when the view changes (a newer render takes over) or memory runs short.
 */
async function preload(seq) {
  const run = dataRun();
  const model = state.model;
  const p = product();
  const kind = accumulation(p);
  const all = steps();
  const live = () => seq === renderSeq;
  const report = (done) => {
    if (!live() || state.playing) return;
    const n = markCached();
    if (n >= all.length) setStatus(`All ${all.length} frames loaded`, 'done');
    else if (done) setStatus(`${n} of ${all.length} frames loaded${data.full() ? ' · memory limit reached' : ''}`, 'done');
    else setStatus(`Loading frames · ${n}/${all.length}`);
  };
  if (kind) {
    // Totals build on each other: extend them forward one interval at a time.
    for (const s of all) {
      if (!live()) return;
      if (accum.has(kind, model, run, s)) continue;
      try {
        await accum.get(kind, model, run, s, { cancelled: () => !live() });
      } catch {
        break;
      }
      report(false);
    }
    report(true);
    return;
  }
  const spec = inputSpec();
  const i0 = state.stepIndex;
  const todo = [...all.slice(i0 + 1), ...all.slice(0, i0)].filter((s) => !p.check?.(option(), s, state.run) && !data.has(model, run.id, s, spec));
  if (!todo.length) return report(true);
  // A few frames at once; locally averaged ensemble means are many downloads each.
  const parallel = MODELS[model].members?.mean === 'computed' && state.member === 'mean' ? 2 : 4;
  let next = 0;
  const lane = async () => {
    while (next < todo.length && live() && !data.full()) {
      const s = todo[next++];
      try {
        await data.inputs(model, run.id, s, spec);
      } catch {
        // a missing or failed frame shouldn't stop the rest
      }
      report(false);
    }
  };
  await Promise.all(Array.from({ length: parallel }, lane));
  if (live()) report(true);
}

// ------------------------------------------------------------------ city values
function valueColor(p, opt, v, row = 0) {
  const c = p.colormap(opt).color(v, row);
  const a = c[3] / 255;
  // Composite over the dark base so translucent colours stay readable.
  const r = Math.round(c[0] * a + 14 * (1 - a));
  const g = Math.round(c[1] * a + 20 * (1 - a));
  const b = Math.round(c[2] * a + 30 * (1 - a));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { bg: `rgb(${r},${g},${b})`, fg: lum > 150 ? '#0b0f14' : '#ffffff' };
}

function updateCityValues() {
  const cur = current;
  if (!cur || !cityValuesOn(cur.product)) {
    labels.setValueFn(null);
    return;
  }
  const p = cur.product;
  const u = unitFor(p.unit, state.units);
  labels.setValueFn((lat, lon) => {
    const v = cur.sample ? cur.sample(lat, lon) : sampleField(cur.field, cur.meta, lat, lon);
    if (!Number.isFinite(v) || (p.cityMin !== undefined && v < p.cityMin) || (p.cityMax !== undefined && v > p.cityMax)) return null;
    const row = cur.types ? sampleNearest(cur.types, cur.meta, lat, lon) : 0;
    return { text: p.format(u.f(v), state.units), ...valueColor(p, cur.option, v, row) };
  });
}

// ------------------------------------------------------------------ legend
function niceTicks(lo, hi, target = 8) {
  const span = hi - lo;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= target) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function drawLegend() {
  const cur = current;
  const el = $('#legend');
  if (!cur) return;
  const p = cur.product;
  const cm = p.colormap(cur.option);
  const u = unitFor(p.unit, state.units);
  const rows = p.typeRows ?? (p.precipLegend ? PRECIP_TYPES : [{ row: 0, name: null }]);
  el.innerHTML = `<div class="legend-head"><span class="legend-name">${p.name}</span><span class="legend-unit">${u.label}</span></div>`;
  for (const r of rows) {
    const wrap = document.createElement('div');
    wrap.className = 'legend-row' + (r.name ? ' typed' : '');
    if (r.name) wrap.innerHTML = `<span class="type-name">${r.name}</span>`;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(512, 1);
    for (let i = 0; i < 512; i++) {
      const c = cm.color(cm.valueAt((i + 0.5) / 512), r.row);
      const a = Math.max(c[3] / 255, 0.08);
      img.data[i * 4] = Math.round(c[0] * a + 14 * (1 - a));
      img.data[i * 4 + 1] = Math.round(c[1] * a + 20 * (1 - a));
      img.data[i * 4 + 2] = Math.round(c[2] * a + 30 * (1 - a));
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    wrap.appendChild(canvas);
    el.appendChild(wrap);
  }
  const ticksEl = document.createElement('div');
  ticksEl.className = 'legend-ticks';
  const [d0, d1] = cm.domain;
  const lo = Math.min(u.f(d0), u.f(d1));
  const hi = Math.max(u.f(d0), u.f(d1));
  const ticks = p.legendTicks?.(state.units, cur.option) ?? niceTicks(lo, hi, 8);
  for (const t of ticks) {
    const pos = cm.position(u.inv(t));
    if (pos < 0.02 || pos > 0.98) continue;
    const s = document.createElement('span');
    s.style.left = `${pos * 100}%`;
    s.textContent = p.legendLabel ? p.legendLabel(t) : Number.isInteger(t) ? t : t.toString().replace(/^0\./, '.');
    ticksEl.appendChild(s);
  }
  if (p.legendLabel) ticksEl.classList.add('classes');
  if (rows.length > 1) el.lastElementChild.after(ticksEl);
  else el.appendChild(ticksEl);
}

// ------------------------------------------------------------------ tooltip
let lastPointer = null;
function fmtLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

function refreshTooltip() {
  const tip = $('#tooltip');
  if (!lastPointer || !current) {
    tip.style.display = 'none';
    return;
  }
  const ll = globe.pick(lastPointer.x, lastPointer.y);
  if (!ll) {
    tip.style.display = 'none';
    return;
  }
  const cur = current;
  if (cur.radar) return radarTooltip(tip, ll);
  const p = cur.product;
  const u = unitFor(p.unit, state.units);
  const v = sampleField(cur.field, cur.meta, ll.lat, ll.lon);
  if (!Number.isFinite(v)) {
    tip.innerHTML = `<div class="tx">Outside the ${modelName()} domain</div><div class="tl">${fmtLatLon(ll.lat, ll.lon)}</div>`;
    tip.style.display = 'block';
    const x = Math.min(window.innerWidth - tip.offsetWidth - 8, lastPointer.x + 16);
    const y = Math.min(window.innerHeight - tip.offsetHeight - 8, lastPointer.y + 16);
    tip.style.transform = `translate(${x}px, ${y}px)`;
    return;
  }
  let row = 0;
  let extra = '';
  if (cur.types) {
    row = sampleNearest(cur.types, cur.meta, ll.lat, ll.lon);
    extra = v >= 0.05 ? PTYPE_NAMES[row] ?? '' : 'No precipitation';
  }
  if (cur.contour) {
    const c = sampleField(cur.contour.values, cur.meta, ll.lat, ll.lon);
    extra += `${extra ? ' · ' : ''}${Math.round(c)} ${cur.contour.unit}`;
  }
  const { bg } = valueColor(p, cur.option, v, row);
  tip.innerHTML =
    `<div class="tv"><i style="background:${bg}"></i>${p.format(u.f(v), state.units).replace(/°$/, '')}<span class="tu">${u.label}</span></div>` +
    (extra ? `<div class="tx">${extra}</div>` : '') +
    `<div class="tl">${fmtLatLon(ll.lat, ll.lon)}</div>`;
  tip.style.display = 'block';
  const x = Math.min(window.innerWidth - tip.offsetWidth - 8, lastPointer.x + 16);
  const y = Math.min(window.innerHeight - tip.offsetHeight - 8, lastPointer.y + 16);
  tip.style.transform = `translate(${x}px, ${y}px)`;
}

function radarTooltip(tip, ll) {
  const p = current.product;
  const site = radar.site;
  const pr = radar.probe(ll.lat, ll.lon);
  if (!pr || !site) {
    tip.style.display = 'none';
    return;
  }
  const u = unitFor(p.unit, state.units);
  const dist = state.units === 'imperial' ? `${Math.round(pr.km * 0.621371)} mi` : `${Math.round(pr.km)} km`;
  let where = `${site.id} · ${dist} at ${Math.round(pr.az)}°`;
  let head;
  if (!pr.inRange) head = `<div class="tx">Beyond ${site.id}'s range</div>`;
  else if (pr.value === Infinity) head = `<div class="tv"><i style="background:rgb(120,51,158)"></i>Range folded</div>`;
  else if (!Number.isFinite(pr.value)) head = `<div class="tx">${p.precip ? 'No precipitation' : 'No echo'}</div>`;
  else {
    const { bg } = valueColor(p, null, pr.value, pr.type ?? 0);
    if (p.typeName) where = `${p.typeName(pr.type)} · ${where}`;
    head = p.classes
      ? `<div class="tv"><i style="background:${bg}"></i>${p.format(pr.value)}</div>`
      : `<div class="tv"><i style="background:${bg}"></i>${p.format(u.f(pr.value), state.units)}<span class="tu">${u.label}</span></div>`;
  }
  tip.innerHTML = head + `<div class="tx">${where}</div><div class="tl">${fmtLatLon(ll.lat, ll.lon)}</div>`;
  tip.style.display = 'block';
  const x = Math.min(window.innerWidth - tip.offsetWidth - 8, lastPointer.x + 16);
  const y = Math.min(window.innerHeight - tip.offsetHeight - 8, lastPointer.y + 16);
  tip.style.transform = `translate(${x}px, ${y}px)`;
}

// ------------------------------------------------------------------ radar right-click menu
// Product keys in radar mode.
const RADAR_KEYS = { r: 'ref', v: 'vel', c: 'cc', d: 'zdr', k: 'kdp', s: 'srv' };

function openRadarMenu(x, y, ll) {
  const menu = $('#radar-menu');
  const near = radar.nearestNexrad(ll.lat, ll.lon);
  const dist = (km) => (state.units === 'imperial' ? `${Math.round(km * 0.621371)} mi` : `${Math.round(km)} km`);
  menu.innerHTML =
    `<div class="rm-head">${fmtLatLon(ll.lat, ll.lon)}</div>` +
    (near
      ? `<button data-act="site" role="menuitem">Switch to ${near.site.id}<span class="sub">Nearest NEXRAD · ${near.site.name}, ${dist(near.km)} away${near.site.id === state.radar.site ? ' · already on it' : ''}</span></button>`
      : '') +
    `<button data-act="sounding" role="menuitem">HRRR sounding here<span class="sub">Latest HRRR analysis (F000)</span></button>`;
  menu.hidden = false;
  menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.querySelector('[data-act=site]')?.addEventListener('click', () => {
    closeRadarMenu();
    radar.selectSite(near.site.id, false);
  });
  menu.querySelector('[data-act=sounding]').addEventListener('click', async () => {
    closeRadarMenu();
    try {
      setStatus('Finding the latest HRRR analysis…');
      hrrr.soundingRun = await latestHrrrRun(0);
      setStatus('Ready', 'done');
    } catch (err) {
      setStatus(`Couldn't find an HRRR run: ${err.message}`, 'error');
      return;
    }
    sounding.open({ kind: 'point', lat: ll.lat, lon: ll.lon });
  });
}

function closeRadarMenu() {
  $('#radar-menu').hidden = true;
}

// ------------------------------------------------------------------ playback
async function playLoop() {
  while (state.playing) {
    const started = performance.now();
    const next = state.stepIndex + 1 >= frameCount() ? 0 : state.stepIndex + 1;
    setStep(next);
    await renderDone;
    // Radar loops run faster and pause on the latest scan.
    const dwell = !radarMode() ? 550 : next === frameCount() - 1 ? 1500 : 320;
    const wait = dwell - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

function setPlaying(on) {
  state.playing = on;
  $('#play').classList.toggle('playing', on);
  if (on) playLoop();
  else refreshPanels();
}

// ------------------------------------------------------------------ events
function bindEvents() {
  $('#run-select').addEventListener('change', (e) => {
    const run = state.runs.find((r) => r.id === e.target.value);
    setRun(run, step());
    render();
  });
  $('#member-select').addEventListener('change', (e) => {
    state.member = e.target.value;
    state.members[state.model] = state.member;
    // A member can publish other fields than the mean (REFS members have levels, helicity, ...).
    if (!available(product())) state.productId = 't2m';
    fixOption();
    persist();
    syncProductButtons();
    buildOptions();
    buildOverlays();
    render();
  });
  $('#step').addEventListener('input', (e) => setStep(Number(e.target.value)));
  $('#step-back').addEventListener('click', () => setStep(state.stepIndex - 1));
  $('#step-fwd').addEventListener('click', () => setStep(state.stepIndex + 1));
  $('#play').addEventListener('click', () => setPlaying(!state.playing));
  $('#zoom-in').addEventListener('click', () => globe.zoomBy(0.6));
  $('#zoom-out').addEventListener('click', () => globe.zoomBy(1 / 0.6));
  $('#home').addEventListener('click', () => {
    radar3d.toggle(false);
    globe.flyTo(37, -92, globe.homeDistance);
  });
  document.querySelectorAll('#map-tools .tool').forEach((b) => b.addEventListener('click', () => tools.toggle(b.dataset.tool)));
  const syncOffset = () =>
    globe.setCenterOffset(window.innerWidth > 760 && !document.body.classList.contains('panel-hidden') ? 145 : 0);
  $('#panel-toggle').addEventListener('click', () => {
    document.body.classList.add('panel-hidden');
    syncOffset();
  });
  $('#panel-open').addEventListener('click', () => {
    document.body.classList.remove('panel-hidden');
    syncOffset();
  });
  window.addEventListener('resize', () => {
    syncOffset();
    if (state.run || radarMode()) buildTimeline();
  });
  syncOffset();

  const canvas = globe.renderer.domElement;
  let dragging = false;
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    downAt = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => (dragging = false));
  canvas.addEventListener('pointermove', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!dragging) refreshTooltip();
    else $('#tooltip').style.display = 'none';
  });
  canvas.addEventListener('pointerleave', () => {
    lastPointer = null;
    refreshTooltip();
  });
  canvas.addEventListener('dblclick', (e) => {
    // Two quick clicks while picking a box or line aren't a zoom request.
    if (tools.mode || performance.now() - tools.lastPick < 600) return;
    const ll = globe.pick(e.clientX, e.clientY);
    if (ll) globe.flyTo(ll.lat, ll.lon, 1 + globe.altitude * 0.45);
  });

  // Radar: right-click for the nearest NEXRAD or an HRRR sounding at that spot.
  canvas.addEventListener('contextmenu', (e) => {
    if (!radarMode()) return;
    // In the 3D view a right-drag pans: only a click opens the menu.
    if (globe.tilted && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return e.preventDefault();
    const ll = globe.pick(e.clientX, e.clientY);
    if (ll) openRadarMenu(e.clientX, e.clientY, ll);
  });
  window.addEventListener('pointerdown', (e) => {
    if (!$('#radar-menu').hidden && !$('#radar-menu').contains(e.target)) closeRadarMenu();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches?.('input, select, textarea')) {
      if (e.target.id !== 'step') return;
    }
    const p = product();
    const toolKeys = { s: 'point', b: 'box', x: 'line' };
    const key = e.key.toLowerCase();
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'Escape' && !$('#radar-menu').hidden) closeRadarMenu();
    else if (e.key === 'Escape') {
      if (tools.mode) tools.setMode(null);
      else if (xsect.isOpen) xsect.close();
      else sounding.close();
    } else if (radarMode() && key === '3' && plain) {
      radar3d.toggle();
    } else if (radarMode() && RADAR_KEYS[key] && plain) {
      const rp = radarProductById[RADAR_KEYS[key]];
      if (radar.available(rp)) radar.selectProduct(rp.id);
      else setStatus(`${rp.name} isn't published by ${radar.site?.type === 'TDWR' ? 'TDWR' : 'this'} radar`, 'error');
    } else if (toolKeys[e.key.toLowerCase()] && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (hasProfiles(state.model, state.member) && !radarMode()) tools.toggle(toolKeys[e.key.toLowerCase()]);
    } else if (e.key === 'ArrowRight') setStep(state.stepIndex + 1);
    else if (e.key === 'ArrowLeft') setStep(state.stepIndex - 1);
    else if (e.key === ' ') setPlaying(!state.playing);
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && radarMode()) radar.selectTilt(radar.tilt + (e.key === 'ArrowUp' ? 1 : -1));
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && p.options) {
      const opts = p.options.map((o) => o.value);
      const i = opts.indexOf(option()) + (e.key === 'ArrowUp' ? 1 : -1);
      if (i >= 0 && i < opts.length) {
        state.options[p.id] = opts[i];
        persist();
        buildOptions();
        render();
      }
    } else return;
    e.preventDefault();
  });

  // Pick up new forecast steps as the current run is published.
  setInterval(() => !radarMode() && loadRuns(true).catch(() => {}), 5 * 60 * 1000);
  $('#radar-search').addEventListener('input', (e) => radar.setFilter(e.target.value));
  // Sidebar focus: weather models or radar, one at a time.
  document.querySelectorAll('#mode-switch button').forEach((b) =>
    b.addEventListener('click', () => (b.dataset.mode === 'radar' ? enterRadar() : setModel(state.model))),
  );
  radar.onColors = () => {
    radar3d.recolor();
    if (!current?.radar) return;
    drawLegend();
    updateCityValues();
    refreshTooltip();
  };
}

// ------------------------------------------------------------------ boot
Object.assign(window.modelGlobe.actions, { setModel, selectProduct, setStep, render, enterRadar });
window.modelGlobe.radar = radar;

async function boot() {
  buildModels();
  buildMembers();
  buildProducts();
  syncProductButtons();
  buildOptions();
  buildOverlays();
  buildUnits();
  bindEvents();
  loadGeo().catch((err) => console.error('geo', err));
  globe.loadBase().catch((err) => console.error('base map', err));
  fixOption();
  if (radarMode()) {
    state.mode = 'model'; // enterRadar switches it on
    return enterRadar();
  }
  try {
    setStatus(`Finding the latest ${modelName()} run…`);
    await loadRuns();
    await render();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

boot();
