// MapLibre GL map engine: an alternative to the WebGL globe's own base map.
// MapLibre draws a vector (or satellite) base map in globe or Web Mercator
// projection; the globe's shader still draws the weather data, offscreen in
// Web Mercator over the area in view (Globe.renderFlat), and that canvas goes
// to MapLibre as a canvas source under the map's labels. The globe's camera
// helpers (project, pick, flyTo...) answer for this map while it's attached,
// so city labels, radar markers, the sounding/cross-section tools and the
// alert layer work the same on either engine.

const MAPLIBRE_VERSION = '5.6.0';
const D2R = Math.PI / 180;
const VIEW_K = 2 * Math.tan(16 * D2R) * 6371; // globe camera: km of ground per unit altitude (32° fov)
const MAX_SIDE = 4096;
const MAX_PIXELS = 9e6;
const MERC_MAX = 85.0511;

const CARTO = (name) => `https://basemaps.cartocdn.com/gl/${name}-gl-style/style.json`;
const ESRI = (svc) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;

export const MAP_STYLES = [
  { id: 'dark', name: 'Dark', url: CARTO('dark-matter') },
  { id: 'light', name: 'Light', url: CARTO('positron') },
  { id: 'voyager', name: 'Voyager', url: CARTO('voyager') },
  { id: 'liberty', name: 'Liberty (OpenFreeMap)', url: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'bright', name: 'Bright (OpenFreeMap)', url: 'https://tiles.openfreemap.org/styles/bright' },
  { id: 'satellite', name: 'Satellite (Esri)', style: satelliteStyle },
  { id: 'plain', name: 'Plain (no tiles)', style: plainStyle },
  { id: 'custom', name: 'Custom style URL…' },
];

// Layer groups that can be switched off, matched on layer id / source layer.
// Place labels aren't among them: the map's own are always hidden, so the
// app's town labels (the same on both engines, with city values) are the only ones.
export const LAYER_GROUPS = [
  ['roads', 'Roads & rail'],
  ['boundaries', 'Boundaries'],
  ['water', 'Water'],
  ['landcover', 'Land cover & parks'],
  ['buildings', 'Buildings'],
  ['poi', 'Points of interest'],
];

export const COLOR_KEYS = [
  ['background', 'Land'],
  ['water', 'Water'],
  ['boundaries', 'Boundaries'],
  ['roads', 'Roads'],
];

export const DEFAULT_MAP_SETTINGS = {
  engine: 'globe', // 'globe' (built-in WebGL globe) | 'maplibre'
  style: 'dark',
  customUrl: '',
  projection: 'globe', // 'globe' | 'mercator'
  layers: { labels: true, roads: true, boundaries: true, water: true, landcover: true, buildings: false, poi: false },
  colors: { background: null, water: null, boundaries: null, roads: null },
  dataOpacity: 1,
  dataPlacement: 'below-labels', // 'below-labels' | 'below-roads' | 'top'
  hillshade: false,
  hillshadeStrength: 0.35,
  rotate: false, // allow rotating and tilting the map
};

export function mapSettings(saved) {
  const d = DEFAULT_MAP_SETTINGS;
  const s = { ...d, ...saved };
  s.layers = { ...d.layers, ...saved?.layers };
  s.colors = { ...d.colors, ...saved?.colors };
  delete s.colors.labels;
  return s;
}

function satelliteStyle() {
  return {
    version: 8,
    sources: {
      sat: { type: 'raster', tiles: [ESRI('World_Imagery')], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
      ref: { type: 'raster', tiles: [ESRI('Reference/World_Boundaries_and_Places')], tileSize: 256, maxzoom: 19 },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0b1018' } },
      { id: 'satellite', type: 'raster', source: 'sat' },
      { id: 'labels-boundaries-ref', type: 'raster', source: 'ref' },
    ],
  };
}

function plainStyle() {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#18202b' } }],
  };
}

function groupOf(layer) {
  const id = `${layer.id} ${layer['source-layer'] ?? ''}`.toLowerCase();
  if (layer.type === 'background') return null;
  if (id.includes('labels-boundaries-ref')) return 'labels';
  if (/\bpoi|poi_|_poi|poi-/.test(id)) return 'poi';
  if (layer.type === 'symbol') return /road|highway|street|transport|shield|motorway|path|rail/.test(id) ? 'roads' : 'labels';
  if (/building/.test(id)) return 'buildings';
  if (/boundary|admin|border/.test(id)) return 'boundaries';
  if (/water|ocean|river|lake|sea\b|stream|canal/.test(id)) return 'water';
  if (/road|highway|street|tunnel|bridge|rail|path|transport|aeroway|motorway|bus|ferry|transit|track/.test(id)) return 'roads';
  if (/landuse|landcover|park|wood|grass|forest|sand|glacier|ice|wetland|farm|scrub|cemetery|pitch|golf|hospital|school|residential|industrial/.test(id)) return 'landcover';
  return 'other';
}

let libPromise = null;
function loadLibrary() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  libPromise ??= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js`;
    js.onload = () => resolve(window.maplibregl);
    js.onerror = () => {
      libPromise = null;
      reject(new Error("couldn't load MapLibre GL from unpkg.com"));
    };
    document.head.appendChild(js);
  });
  return libPromise;
}

/** Line file (tools/build-geo.mjs) to a MultiLineString feature. */
function linesToGeoJSON(buf) {
  const n = new Uint32Array(buf, 0, 1)[0];
  const counts = new Uint32Array(buf, 4, n);
  const coords = new Float32Array(buf, 4 + n * 4);
  const lines = [];
  let o = 0;
  for (let l = 0; l < n; l++) {
    let line = [];
    for (let i = 0; i < counts[l]; i++) {
      const lon = coords[(o + i) * 2];
      const lat = coords[(o + i) * 2 + 1];
      // Split at the dateline instead of drawing a line across the map.
      if (line.length && Math.abs(lon - line[line.length - 1][0]) > 180) {
        if (line.length > 1) lines.push(line);
        line = [];
      }
      line.push([Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
    }
    if (line.length > 1) lines.push(line);
    o += counts[l];
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
}

// App line layers drawn over the data, bottom to top. width: [zoom, px] stops;
// casing: a contrasting halo under the line so it reads over any data colour;
// boost: opacity multiplier on the globe's line theme; plainOnly: only drawn on
// styles without their own coastlines.
const APP_LINES = [
  { name: 'lakes', file: 'lakes-10m', minzoom: 0, width: [0, 0.6, 6, 1.1, 10, 1.6], boost: 1.2, plainOnly: true },
  { name: 'coast', file: 'coastline-10m', minzoom: 0, width: [0, 0.8, 6, 1.4, 10, 2], boost: 1.2, plainOnly: true },
  { name: 'counties', file: 'counties-500k', minzoom: 5, width: [5, 0.45, 8, 0.9, 11, 1.4], boost: 1.6 },
  { name: 'states', file: 'states-hi', minzoom: 2, width: [2, 0.45, 4, 0.65, 6, 1.1, 8, 1.7, 12, 2.4], casing: 1.2, boost: 1.4 },
  { name: 'borders', file: 'borders-10m', minzoom: 0, width: [0, 1, 3, 1.7, 6, 2.5, 9, 3.2, 12, 4], casing: 2.4, boost: 2 },
];
const BOUNDARY_LINES = new Set(['counties', 'states', 'borders']);

/** [zoom, px] stops to a zoom-interpolated line width, plus `extra` px. */
const widthExpr = (stops, extra = 0) => ['interpolate', ['exponential', 1.4], ['zoom'], ...stops.map((v, i) => (i % 2 ? v + extra : v))];

const hexColor = (c) => (typeof c === 'number' ? `#${c.toString(16).padStart(6, '0')}` : c);

/** Black or white, whichever stands out against a line colour. */
function haloFor(color) {
  const n = parseInt(String(hexColor(color)).replace('#', '').slice(0, 6), 16);
  if (!Number.isFinite(n)) return '#000000';
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 50 ? '#000000' : '#ffffff'; // only near-black lines get a light halo
}

export class MapLibreEngine {
  /**
   * @param {import('../globe/globe.js').Globe} globe
   * @param {HTMLElement} container element the map fills (inside the globe's container)
   * @param {object} settings see DEFAULT_MAP_SETTINGS (kept up to date by the app)
   * @param {{onLayers?: Function, onError?: Function}} hooks onLayers runs after
   *   each style load so other modules can (re)add their own sources and layers
   */
  constructor(globe, container, settings, hooks = {}) {
    this.globe = globe;
    this.container = container;
    this.settings = settings;
    this.hooks = hooks;
    this.canvas = document.createElement('canvas');
    // Never square: MapLibre binds square power-of-two textures with a mipmap
    // filter (and keeps it after a resize), which draws nothing without mipmaps.
    this.canvas.width = 2;
    this.canvas.height = 1;
    this.ctx = this.canvas.getContext('2d');
    this.rendered = null; // bounds/zoom of the data canvas
    this.lineData = {};
    this.lineStyles = {};
    this.layerHooks = [];
  }

  async init() {
    const lib = await loadLibrary();
    this.lib = lib;
    const c = this.globe.centerLatLon();
    const zoom = this.#zoomFor(this.globe.altitude, c.lat);
    this.map = new lib.Map({
      container: this.container,
      style: this.#styleSpec(),
      center: [c.lon, c.lat],
      zoom,
      attributionControl: { compact: true },
      doubleClickZoom: false, // the app zooms on double-click itself
      dragRotate: !!this.settings.rotate,
      pitchWithRotate: !!this.settings.rotate,
      touchPitch: !!this.settings.rotate,
      maxPitch: 70,
      renderWorldCopies: true,
      fadeDuration: 150,
      canvasContextAttributes: { antialias: true }, // smoother border and alert lines
    });
    if (!this.settings.rotate) this.map.touchZoomRotate.disableRotation();
    this.map.on('style.load', () => this.#onStyle());
    this.map.on('move', () => this.#moved());
    this.map.on('moveend', () => this.#moved(true));
    this.map.on('error', (e) => {
      const msg = e?.error?.message ?? '';
      // Missing tiles or sprites are routine; a style that won't load isn't.
      if (/style/i.test(msg) && this.hooks.onError) this.hooks.onError(msg);
    });
    await new Promise((resolve) => (this.map.loaded() ? resolve() : this.map.once('load', resolve)));
    this.ready = true;
    this.globe.attachMap(this);
    if (this.centerOffset) this.setCenterOffset(this.centerOffset);
    return this;
  }

  destroy() {
    this.ready = false;
    this.map?.remove();
    this.map = null;
    this.globe.detachMap();
  }

  // ------------------------------------------------------------- styles
  #styleSpec() {
    const s = MAP_STYLES.find((x) => x.id === this.settings.style) ?? MAP_STYLES[0];
    if (s.id === 'custom') return this.settings.customUrl || MAP_STYLES[0].url;
    return s.style ? s.style() : s.url;
  }

  /** Reload the base style (after a style, or a colour back to the style's own). */
  reloadStyle() {
    if (!this.map) return;
    this.rendered = null;
    this.map.setStyle(this.#styleSpec(), { diff: false });
  }

  #onStyle() {
    this.styleGen = (this.styleGen ?? 0) + 1;
    const proj = this.settings.projection === 'mercator' ? 'mercator' : 'globe';
    try {
      this.map.setProjection({ type: proj });
    } catch {
      // older style spec: stays in Mercator
    }
    this.#setSky();
    this.#addHillshade();
    this.#addData();
    this.#addLines();
    for (const fn of this.layerHooks) fn(this.map);
    this.applyTweaks();
    this.dataChanged();
  }

  /** Where the data layer goes: under the labels (or roads), or on top. */
  beforeId(kind = this.settings.dataPlacement) {
    const layers = this.map.getStyle().layers;
    if (kind === 'top') return undefined;
    const isOurs = (l) => l.id.startsWith('app-') || l.id === 'wx-data';
    if (kind === 'below-roads') {
      const road = layers.find((l) => !isOurs(l) && groupOf(l) === 'roads');
      if (road) return road.id;
    }
    return layers.find((l) => !isOurs(l) && (l.type === 'symbol' || l.id === 'labels-boundaries-ref'))?.id;
  }

  /** The layer just above the data where overlays (lines, alerts) go. */
  overlayBeforeId() {
    return this.beforeId(this.settings.dataPlacement === 'top' ? 'top' : 'below-labels');
  }

  /** A soft atmosphere around the globe, fading out as you zoom in. */
  #setSky() {
    try {
      this.map.setSky({
        'sky-color': '#0b1018',
        'horizon-color': '#2a4466',
        'fog-color': '#0b1018',
        'sky-horizon-blend': 0.5,
        'horizon-fog-blend': 0.6,
        'fog-ground-blend': 1,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 4, 0.7, 7, 0],
      });
    } catch {
      // no sky support
    }
  }

  #addHillshade() {
    if (!this.settings.hillshade) return;
    if (!this.map.getSource('app-dem')) {
      this.map.addSource('app-dem', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 13,
        attribution: 'Terrain: Mapzen / AWS Open Data',
      });
    }
    // Just above the land and water fills.
    const layers = this.map.getStyle().layers;
    const before = layers.find((l) => ['roads', 'boundaries', 'labels', 'buildings', 'poi'].includes(groupOf(l)))?.id;
    this.map.addLayer(
      {
        id: 'app-hillshade',
        type: 'hillshade',
        source: 'app-dem',
        paint: {
          'hillshade-exaggeration': this.settings.hillshadeStrength,
          'hillshade-shadow-color': '#000000',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#000000',
        },
      },
      before,
    );
  }

  setHillshade() {
    if (!this.map) return;
    if (this.map.getLayer('app-hillshade')) this.map.removeLayer('app-hillshade');
    this.#addHillshade();
  }

  #addData() {
    const coords = this.#coords(this.rendered?.b ?? { west: -180, east: 180, south: -MERC_MAX, north: MERC_MAX });
    if (!this.map.getSource('wx-data')) this.map.addSource('wx-data', { type: 'canvas', canvas: this.canvas, coordinates: coords, animate: false });
    this.map.addLayer(
      {
        id: 'wx-data',
        type: 'raster',
        source: 'wx-data',
        paint: { 'raster-opacity': this.settings.dataOpacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
      },
      this.beforeId(),
    );
  }

  /** Move the data layer after a placement change. */
  placeData() {
    if (!this.map?.getLayer('wx-data')) return;
    this.map.moveLayer('wx-data', this.beforeId());
    const before = this.overlayBeforeId();
    for (const l of this.map.getStyle().layers) if (l.id.startsWith('app-') && l.id !== 'app-hillshade') this.map.moveLayer(l.id, before);
  }

  /** Base styles with no water layers of their own get the app's coastlines. */
  #isPlain() {
    return !this.map.getStyle().layers.some((l) => groupOf(l) === 'water');
  }

  async #addLines() {
    const map = this.map;
    const gen = this.styleGen;
    const plain = this.#isPlain();
    for (const def of APP_LINES) {
      const { name, file, minzoom } = def;
      if (def.plainOnly && !plain) continue;
      const id = `app-line-${name}`;
      this.lineData[name] ??= fetch(`data/geo/${file}.bin`)
        .then((r) => r.arrayBuffer())
        .then(linesToGeoJSON);
      const data = await this.lineData[name];
      // The style may have changed while the file loaded; that load adds its own.
      if (this.map !== map || this.styleGen !== gen || map.getLayer(id)) continue;
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data, tolerance: 0.3 });
      const layout = { 'line-join': 'round', 'line-cap': 'round' };
      if (def.casing) {
        map.addLayer(
          {
            id: `${id}-case`,
            type: 'line',
            source: id,
            minzoom,
            layout,
            paint: { 'line-color': '#000000', 'line-width': widthExpr(def.width, def.casing), 'line-opacity': 0.4, 'line-blur': 0.6 },
          },
          this.overlayBeforeId(),
        );
      }
      map.addLayer(
        { id, type: 'line', source: id, minzoom, layout, paint: { 'line-color': '#ffffff', 'line-width': widthExpr(def.width), 'line-opacity': 0.8 } },
        this.overlayBeforeId(),
      );
      this.#styleLine(name);
    }
    this.applyTweaks(); // base map boundaries give way to these
  }

  /** Line colours follow the globe's line theme (Globe.setLineStyle). */
  lineStyle(name, style) {
    this.lineStyles[name] = { ...this.lineStyles[name], ...style };
    this.#styleLine(name);
    if (name === 'borders' && style.visible !== undefined) this.applyTweaks();
  }

  /** The app's country/state lines are showing (so the base map's own are hidden). */
  #appBorders() {
    return this.settings.layers.boundaries !== false && this.lineStyles.borders?.visible !== false && !!this.map?.getLayer('app-line-borders');
  }

  #styleLine(name) {
    const map = this.map;
    const id = `app-line-${name}`;
    const st = this.lineStyles[name];
    const def = APP_LINES.find((d) => d.name === name);
    if (!st || !def || !map?.getLayer(id)) return;
    const boundary = BOUNDARY_LINES.has(name);
    // Boundary lines are part of the map's Boundaries group: its switch and colour apply.
    const color = (boundary && this.settings.colors.boundaries) || (st.color !== undefined ? hexColor(st.color) : null);
    const visible = st.visible !== false && (!boundary || this.settings.layers.boundaries !== false);
    const caseId = `${id}-case`;
    const hasCase = !!map.getLayer(caseId);
    if (color) {
      map.setPaintProperty(id, 'line-color', color);
      if (hasCase) map.setPaintProperty(caseId, 'line-color', haloFor(color));
    }
    if (st.opacity !== undefined) {
      const op = Math.min(1, st.opacity * def.boost);
      map.setPaintProperty(id, 'line-opacity', op);
      if (hasCase) map.setPaintProperty(caseId, 'line-opacity', (color && haloFor(color) === '#ffffff' ? 0.3 : 0.5) * op);
    }
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    if (hasCase) map.setLayoutProperty(caseId, 'visibility', visible ? 'visible' : 'none');
  }

  /** Layer group visibility, colour overrides, label size, data opacity. */
  applyTweaks() {
    const map = this.map;
    // Not isStyleLoaded(): that stays false while tiles load, right when the style arrives.
    if (!map?.style?._loaded) return;
    const s = this.settings;
    const appBorders = this.#appBorders();
    for (const layer of map.getStyle().layers) {
      if (layer.id.startsWith('app-') || layer.id === 'wx-data') continue;
      const g = groupOf(layer);
      if (layer.type === 'background') {
        if (s.colors.background) map.setPaintProperty(layer.id, 'background-color', s.colors.background);
        continue;
      }
      if (g === 'labels') map.setLayoutProperty(layer.id, 'visibility', 'none');
      else if (g === 'boundaries' && appBorders && !/county|municipal|district/.test(layer.id)) {
        // The app's crisper country and state lines replace the tiles' own
        // (generalised, often dashed) ones rather than doubling them up.
        map.setLayoutProperty(layer.id, 'visibility', 'none');
      } else if (g && s.layers[g] !== undefined) map.setLayoutProperty(layer.id, 'visibility', s.layers[g] ? 'visible' : 'none');
      const color = s.colors[g];
      if (color) {
        if (layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-color', color);
        else if (layer.type === 'line') map.setPaintProperty(layer.id, 'line-color', color);
        else if (layer.type === 'symbol') map.setPaintProperty(layer.id, 'text-color', color);
      }
    }
    // Plain style land colour, and land fills, follow the land colour too.
    if (s.colors.background) {
      for (const layer of map.getStyle().layers) {
        if (layer.type === 'fill' && /^(land|earth)/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', s.colors.background);
      }
    }
    for (const def of APP_LINES) this.#styleLine(def.name);
    if (map.getLayer('wx-data')) map.setPaintProperty('wx-data', 'raster-opacity', s.dataOpacity);
    if (map.getLayer('app-hillshade')) map.setPaintProperty('app-hillshade', 'hillshade-exaggeration', s.hillshadeStrength);
  }

  setProjection() {
    if (!this.map) return;
    this.map.setProjection({ type: this.settings.projection === 'mercator' ? 'mercator' : 'globe' });
    this.rendered = null;
    this.dataChanged();
  }

  setRotate() {
    if (!this.map) return;
    const on = !!this.settings.rotate;
    if (on) {
      this.map.dragRotate.enable();
      this.map.touchZoomRotate.enableRotation();
      this.map.touchPitch.enable();
    } else {
      this.map.dragRotate.disable();
      this.map.touchZoomRotate.disableRotation();
      this.map.touchPitch.disable();
      this.map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
    }
  }

  /** Run fn(map) now (if the style is loaded) and after every later style load. */
  onLayers(fn) {
    this.layerHooks.push(fn);
    if (this.map?.isStyleLoaded()) fn(this.map);
  }

  // ------------------------------------------------------------- data canvas
  #coords(b) {
    return [
      [b.west, b.north],
      [b.east, b.north],
      [b.east, b.south],
      [b.west, b.south],
    ];
  }

  /** The area to draw data for: the view plus a margin, or the whole world zoomed out. */
  #wantedBounds() {
    const map = this.map;
    const z = map.getZoom();
    const globe = this.settings.projection !== 'mercator';
    const world = { west: -180, east: 180, south: -MERC_MAX, north: MERC_MAX, world: true };
    if (z < (globe ? 3.4 : 2.2)) return world;
    const b = map.getBounds();
    let west = b.getWest();
    let east = b.getEast();
    let south = Math.max(-MERC_MAX, b.getSouth());
    let north = Math.min(MERC_MAX, b.getNorth());
    if (east - west > 240 || map.getPitch() > 45) return world;
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
    const lat = (y) => Math.atan(Math.sinh(y)) / D2R;
    const padX = (east - west) * 0.4;
    const ys = merc(south);
    const yn = merc(north);
    const padY = (yn - ys) * 0.4;
    west -= padX;
    east += padX;
    south = Math.max(-MERC_MAX, lat(ys - padY));
    north = Math.min(MERC_MAX, lat(yn + padY));
    if (east - west >= 360) return world;
    return { west, east, south, north };
  }

  #inside(view, b) {
    return b.world || (view.west >= b.west && view.east <= b.east && view.south >= b.south && view.north <= b.north);
  }

  /** The globe's data changed (or the view needs more of it): redraw the canvas. */
  dataChanged() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.#renderData();
    });
  }

  #renderData() {
    const map = this.map;
    if (!map || !map.getSource('wx-data')) return;
    const b = this.#wantedBounds();
    const z = map.getZoom();
    const dpr = Math.max(Math.min(window.devicePixelRatio || 1, 2), this.exportScale || 0);
    const world = 512 * 2 ** z * dpr;
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
    let w = ((b.east - b.west) / 360) * world;
    let h = ((merc(b.north) - merc(b.south)) / (2 * Math.PI)) * world;
    const scale = Math.min(1, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_PIXELS / (w * h)));
    w = Math.max(2, Math.round(w * scale));
    h = Math.max(2, Math.round(h * scale));
    if (w === h) w += 1; // see the constructor
    const gl = this.globe.renderFlat(b, w, h);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    } else this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(gl, 0, 0);
    const src = map.getSource('wx-data');
    const prev = this.rendered?.b;
    if (!prev || prev.west !== b.west || prev.east !== b.east || prev.south !== b.south || prev.north !== b.north) src.setCoordinates(this.#coords(b));
    this.rendered = { b, z };
    // Upload the new pixels on the next frame only (an animated source re-uploads every frame).
    src.play();
    map.once('render', () => src.pause());
    map.triggerRepaint();
  }

  #moved(end = false) {
    this.globe.viewDirty = true;
    if (!this.rendered || !this.map) return;
    const now = performance.now();
    if (!end && now - (this.lastCheck ?? 0) < 250) return;
    this.lastCheck = now;
    const b = this.map.getBounds();
    const view = { west: b.getWest(), east: b.getEast(), south: Math.max(-MERC_MAX, b.getSouth()), north: Math.min(MERC_MAX, b.getNorth()) };
    const want = this.#wantedBounds();
    const zoomed = Math.abs(this.map.getZoom() - this.rendered.z) > (end ? 0.45 : 1);
    if (zoomed || !this.#inside(view, this.rendered.b) || !!want.world !== !!this.rendered.b.world) this.dataChanged();
  }

  // ------------------------------------------------------------- image & video export
  beginCapture(pixelRatio) {
    this.savedRatio = this.map.getPixelRatio();
    this.exportScale = pixelRatio;
    this.map.setPixelRatio(pixelRatio);
    this.rendered = null;
    this.dataChanged();
  }

  /** The map drawn this instant, once its tiles and the data canvas are in. */
  async snapshot() {
    const map = this.map;
    // The data canvas redraws on the next animation frame; then wait for tiles.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (this.frame) await new Promise((r) => requestAnimationFrame(r));
    if (!map.loaded() || !map.areTilesLoaded()) {
      await new Promise((r) => {
        const t = setTimeout(r, 5000);
        map.once('idle', () => {
          clearTimeout(t);
          r();
        });
        map.triggerRepaint();
      });
    }
    map.redraw(); // synchronous: the canvas holds this frame for the rest of the task
    return map.getCanvas();
  }

  endCapture() {
    this.exportScale = 0;
    if (this.savedRatio) this.map.setPixelRatio(this.savedRatio);
    this.rendered = null;
    this.dataChanged();
  }

  // ------------------------------------------------------------- camera (Globe API)
  #height() {
    return this.container.clientHeight || window.innerHeight;
  }

  #zoomFor(alt, lat) {
    const km = Math.max(0.002, alt) * VIEW_K;
    const z = Math.log2((this.#height() * 40075.016 * Math.cos(Math.max(-80, Math.min(80, lat)) * D2R)) / (512 * km));
    return Math.max(0, Math.min(20, z));
  }

  altitude() {
    const c = this.map.getCenter();
    const km = (this.#height() * 40075.016 * Math.cos(c.lat * D2R)) / (512 * 2 ** this.map.getZoom());
    return km / VIEW_K;
  }

  center() {
    const c = this.map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  flyTo(lat, lon, alt) {
    const zoom = alt == null ? this.map.getZoom() : this.#zoomFor(alt, lat);
    this.map.flyTo({ center: [lon, lat], zoom, duration: 1100, essential: true });
  }

  zoomBy(factor) {
    this.map.easeTo({ zoom: this.map.getZoom() - Math.log2(factor), duration: 300 });
  }

  setCenterOffset(px) {
    this.centerOffset = px;
    if (this.map) this.map.setPadding({ left: px * 2, top: 0, right: 0, bottom: 0 });
  }

  project(lat, lon) {
    const map = this.map;
    if (this.settings.projection !== 'mercator' && map.getZoom() < 7) {
      // Far side of the globe.
      const c = map.getCenter();
      const cosd = Math.sin(lat * D2R) * Math.sin(c.lat * D2R) + Math.cos(lat * D2R) * Math.cos(c.lat * D2R) * Math.cos((lon - c.lng) * D2R);
      if (cosd < 0.12) return null;
    } else {
      // Nearest world copy to the view.
      const c = map.getCenter().lng;
      lon += Math.round((c - lon) / 360) * 360;
    }
    const p = map.project([lon, lat]);
    return [p.x, p.y];
  }

  pick(clientX, clientY) {
    const map = this.map;
    const rect = this.container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const pt = new this.lib.Point(x, y);
    if (map.transform?.isPointOnMapSurface && !map.transform.isPointOnMapSurface(pt)) return null;
    const ll = map.unproject(pt);
    if (!Number.isFinite(ll.lat)) return null;
    return { lat: ll.lat, lon: ((((ll.lng + 180) % 360) + 360) % 360) - 180 };
  }

  ndcToClient(x, y) {
    const rect = this.container.getBoundingClientRect();
    return [rect.left + ((x + 1) / 2) * rect.width, rect.top + ((1 - y) / 2) * rect.height];
  }
}
