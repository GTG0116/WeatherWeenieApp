// NWS watches, warnings and advisories (api.weather.gov active alerts) drawn
// over the map, on the WebGL globe (outlines + translucent fills) or as
// MapLibre layers. Alerts without their own polygon (zone/county based) get
// their zone outlines from the API too, simplified and cached in IndexedDB.
// Clicking the map lists every alert at that spot in a popup (with arrows to
// step through them); the alert's name opens the full text.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { toXYZ } from './globe/globe.js';

const API = 'https://api.weather.gov/alerts/active?status=actual';
const REFRESH_MS = 60e3;
const ZONE_TTL_MS = 30 * 864e5;
const ZONE_PARALLEL = 6;
const SIMPLIFY_DEG = 0.004;
const MAX_STEP_DEG = 0.5; // long outline edges are split so they follow the globe

// Default colours: the NWS hazard map's, most dangerous first (that order is
// also the drawing order: warnings on top of watches on top of advisories).
const EVENT_STYLES = [
  ['Tsunami Warning', '#FD6347'],
  ['Tornado Warning', '#FF0000'],
  ['Extreme Wind Warning', '#FF8C00'],
  ['Severe Thunderstorm Warning', '#FFA500'],
  ['Flash Flood Warning', '#8B0000'],
  ['Flash Flood Statement', '#8B0000'],
  ['Severe Weather Statement', '#00FFFF'],
  ['Shelter In Place Warning', '#FA8072'],
  ['Evacuation Immediate', '#7FFF00'],
  ['Civil Danger Warning', '#FFB6C1'],
  ['Nuclear Power Plant Warning', '#4B0082'],
  ['Radiological Hazard Warning', '#4B0082'],
  ['Hazardous Materials Warning', '#4B0082'],
  ['Fire Warning', '#A0522D'],
  ['Civil Emergency Message', '#FFB6C1'],
  ['Law Enforcement Warning', '#C0C0C0'],
  ['Storm Surge Warning', '#B524F7'],
  ['Hurricane Force Wind Warning', '#CD5C5C'],
  ['Hurricane Warning', '#DC143C'],
  ['Typhoon Warning', '#DC143C'],
  ['Special Marine Warning', '#FFA500'],
  ['Blizzard Warning', '#FF4500'],
  ['Snow Squall Warning', '#C71585'],
  ['Ice Storm Warning', '#8B008B'],
  ['Heavy Freezing Spray Warning', '#00BFFF'],
  ['Winter Storm Warning', '#FF69B4'],
  ['Lake Effect Snow Warning', '#008B8B'],
  ['Dust Storm Warning', '#FFE4C4'],
  ['Blowing Dust Warning', '#FFE4C4'],
  ['High Wind Warning', '#DAA520'],
  ['Tropical Storm Warning', '#B22222'],
  ['Storm Warning', '#9400D3'],
  ['Tornado Watch', '#FFFF00'],
  ['Severe Thunderstorm Watch', '#DB7093'],
  ['Avalanche Warning', '#1E90FF'],
  ['Earthquake Warning', '#8B4513'],
  ['Volcano Warning', '#2F4F4F'],
  ['Ashfall Warning', '#A9A9A9'],
  ['Flood Warning', '#00FF00'],
  ['Coastal Flood Warning', '#228B22'],
  ['Lakeshore Flood Warning', '#228B22'],
  ['High Surf Warning', '#228B22'],
  ['Excessive Heat Warning', '#C71585'],
  ['Extreme Heat Warning', '#C71585'],
  ['Hazardous Seas Warning', '#D8BFD8'],
  ['Gale Warning', '#DDA0DD'],
  ['Extreme Cold Warning', '#0000FF'],
  ['Wind Chill Warning', '#B0C4DE'],
  ['Freeze Warning', '#483D8B'],
  ['Hard Freeze Warning', '#9400D3'],
  ['Red Flag Warning', '#FF1493'],
  ['Hurricane Watch', '#FF00FF'],
  ['Typhoon Watch', '#FF00FF'],
  ['Storm Surge Watch', '#DB7FF7'],
  ['Tropical Storm Watch', '#F08080'],
  ['Flash Flood Watch', '#2E8B57'],
  ['Flood Watch', '#2E8B57'],
  ['Winter Storm Watch', '#4682B4'],
  ['High Wind Watch', '#B8860B'],
  ['Extreme Cold Watch', '#5F9EA0'],
  ['Excessive Heat Watch', '#800000'],
  ['Extreme Heat Watch', '#800000'],
  ['Fire Weather Watch', '#FFDEAD'],
  ['Freeze Watch', '#00FFFF'],
  ['Hard Freeze Watch', '#4169E1'],
  ['Gale Watch', '#FFC0CB'],
  ['Storm Watch', '#FFE4B5'],
  ['Hazardous Seas Watch', '#483D8B'],
  ['Heavy Freezing Spray Watch', '#BC8F8F'],
  ['Coastal Flood Watch', '#66CDAA'],
  ['Lakeshore Flood Watch', '#66CDAA'],
  ['Avalanche Watch', '#F4A460'],
  ['Special Weather Statement', '#FFE4B5'],
  ['Winter Weather Advisory', '#7B68EE'],
  ['Lake Effect Snow Advisory', '#48D1CC'],
  ['Wind Chill Advisory', '#AFEEEE'],
  ['Cold Weather Advisory', '#AFEEEE'],
  ['Heat Advisory', '#FF7F50'],
  ['Flood Advisory', '#00FF7F'],
  ['Coastal Flood Advisory', '#7CFC00'],
  ['Lakeshore Flood Advisory', '#7CFC00'],
  ['High Surf Advisory', '#BA55D3'],
  ['Dense Fog Advisory', '#708090'],
  ['Dense Smoke Advisory', '#F0E68C'],
  ['Freezing Fog Advisory', '#008080'],
  ['Freezing Spray Advisory', '#00BFFF'],
  ['Wind Advisory', '#D2B48C'],
  ['Lake Wind Advisory', '#D2B48C'],
  ['Brisk Wind Advisory', '#D8BFD8'],
  ['Small Craft Advisory', '#D8BFD8'],
  ['Small Craft Advisory For Hazardous Seas', '#D8BFD8'],
  ['Small Craft Advisory For Rough Bar', '#D8BFD8'],
  ['Small Craft Advisory For Winds', '#D8BFD8'],
  ['Blowing Dust Advisory', '#BDB76B'],
  ['Dust Advisory', '#BDB76B'],
  ['Ashfall Advisory', '#696969'],
  ['Frost Advisory', '#6495ED'],
  ['Air Quality Alert', '#808080'],
  ['Air Stagnation Advisory', '#808080'],
  ['Low Water Advisory', '#A52A2A'],
  ['Avalanche Advisory', '#CD853F'],
  ['Tsunami Watch', '#FF00FF'],
  ['Tsunami Advisory', '#D2691E'],
  ['Beach Hazards Statement', '#40E0D0'],
  ['Rip Current Statement', '#40E0D0'],
  ['Coastal Flood Statement', '#6B8E23'],
  ['Lakeshore Flood Statement', '#6B8E23'],
  ['Flood Statement', '#00FF00'],
  ['Marine Weather Statement', '#FFDAB9'],
  ['Hydrologic Outlook', '#90EE90'],
  ['Hazardous Weather Outlook', '#EEE8AA'],
  ['Short Term Forecast', '#98FB98'],
  ['Child Abduction Emergency', '#FFFFFF'],
  ['Local Area Emergency', '#C0C0C0'],
  ['911 Telephone Outage', '#C0C0C0'],
];
const RANK = new Map(EVENT_STYLES.map(([e], i) => [e, i]));
const COLOR = new Map(EVENT_STYLES);
const rankOf = (event) => RANK.get(event) ?? EVENT_STYLES.length;
export const defaultColor = (event) =>
  COLOR.get(event) ?? (/warning/i.test(event) ? '#E0457B' : /watch/i.test(event) ? '#F2C14E' : /advisory/i.test(event) ? '#9AA6B8' : '#BFC7D5');
const kindOf = (event) => (/warning|emergency/i.test(event) ? 'warning' : /watch/i.test(event) ? 'watch' : /advisory/i.test(event) ? 'advisory' : 'statement');

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', VI: 'U.S. Virgin Islands', GU: 'Guam', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};

export const DEFAULT_ALERT_SETTINGS = {
  enabled: true,
  onModels: false, // also over model maps (always shown over radar)
  fill: 0.2,
  width: 2,
  casing: true,
  newTypesOn: true, // types not seen before start switched on
  types: {}, // event -> {on, color, fill, width}
};

export function alertSettings(saved) {
  return { ...DEFAULT_ALERT_SETTINGS, ...saved, types: { ...saved?.types } };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Readable text on a background colour. */
function inkOn(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? '#14213d' : '#ffffff';
}

// ------------------------------------------------------------------ tags
/**
 * Impact-based tags of an alert: threat levels, how it was detected, the
 * biggest hail and gusts, and PDS / EDS / emergency wording in the text.
 * @returns {{text: string, kind: string}[]}
 */
export function alertTags(props) {
  const P = props.parameters ?? {};
  const first = (k) => P[k]?.[0]?.toString().trim();
  const tags = [];
  const seen = new Set();
  const add = (text, kind) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    tags.push({ text, kind });
  };
  const text = [props.headline, props.description, props.instruction, first('NWSheadline')].join(' ').toUpperCase();
  if (/TORNADO EMERGENCY/.test(text)) add('TORNADO EMERGENCY', 'emergency');
  if (/FLASH FLOOD EMERGENCY/.test(text)) add('FLASH FLOOD EMERGENCY', 'emergency');
  if (/EXTREME WIND WARNING|HURRICANE EMERGENCY/.test(text) && /EMERGENCY/.test(text) && props.event !== 'Tornado Warning') {
    if (/HURRICANE EMERGENCY/.test(text)) add('HURRICANE EMERGENCY', 'emergency');
  }
  if (/PARTICULARLY DANGEROUS SITUATION/.test(text)) add('PDS', 'pds');
  if (/EXTREMELY DANGEROUS SITUATION/.test(text)) add('EDS', 'pds');
  for (const k of ['tornadoDamageThreat', 'thunderstormDamageThreat', 'flashFloodDamageThreat']) {
    const v = first(k)?.toUpperCase();
    if (v && v !== 'BASE') add(v, v === 'CATASTROPHIC' ? 'catastrophic' : v === 'DESTRUCTIVE' ? 'destructive' : 'considerable');
  }
  const tor = first('tornadoDetection')?.toUpperCase();
  if (tor) add(props.event === 'Tornado Warning' && tor !== 'OBSERVED' ? tor : `TORNADO ${tor}`, tor === 'OBSERVED' ? 'observed' : 'detect');
  for (const k of ['windThreat', 'hailThreat', 'flashFloodDetection', 'snowSquallDetection']) {
    const v = first(k)?.toUpperCase();
    if (v) add(v, /OBSERVED/.test(v) ? 'observed' : 'detect');
  }
  const ws = first('waterspoutDetection')?.toUpperCase();
  if (ws) add(`WATERSPOUT ${ws}`, /OBSERVED/.test(ws) ? 'observed' : 'detect');
  const sq = first('snowSquallImpact')?.toUpperCase();
  if (sq) add(`${sq} IMPACT`, sq === 'SIGNIFICANT' ? 'destructive' : 'considerable');
  const gust = first('maxWindGust');
  if (gust) {
    const n = gust.match(/[\d.]+/)?.[0];
    const u = /KT|KNOT/i.test(gust) ? 'KT' : 'MPH';
    if (n && +n > 0) add(`${Math.round(+n)} ${u} WINDS`, 'wind');
  }
  const hail = first('maxHailSize');
  if (hail) {
    const n = parseFloat(hail.match(/[\d.]+/)?.[0]);
    if (n > 0) add(`${+n.toFixed(2)} IN HAIL`, 'hail');
  }
  return tags;
}

// ------------------------------------------------------------------ geometry
function simplifyRing(ring) {
  if (ring.length < 8) return ring;
  const out = [ring[0]];
  let last = ring[0];
  for (let i = 1; i < ring.length - 1; i++) {
    const p = ring[i];
    if (Math.abs(p[0] - last[0]) > SIMPLIFY_DEG || Math.abs(p[1] - last[1]) > SIMPLIFY_DEG) {
      out.push([Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4]);
      last = p;
    }
  }
  out.push(ring[ring.length - 1]);
  return out.length >= 4 ? out : ring;
}

/** Polygon/MultiPolygon/GeometryCollection -> list of polygons (rings). */
function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  if (geom.type === 'GeometryCollection') return geom.geometries.flatMap(polygonsOf);
  return [];
}

function simplifyGeometry(geom) {
  const polys = polygonsOf(geom).map((p) => p.map(simplifyRing));
  return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
}

function bboxOf(polys) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys) {
    for (const [x, y] of poly[0]) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygons(polys, x, y) {
  for (const poly of polys) {
    if (!inRing(poly[0], x, y)) continue;
    let hole = false;
    for (let h = 1; h < poly.length && !hole; h++) hole = inRing(poly[h], x, y);
    if (!hole) return true;
  }
  return false;
}

// ------------------------------------------------------------------ zone cache (IndexedDB)
const idb = (() => {
  let dbp = null;
  const open = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('gtg-alert-zones', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('zones');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('zones', mode);
      const r = fn(t.objectStore('zones'));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)).catch(() => null),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => {}),
  };
})();

// ------------------------------------------------------------------ the layer
export class AlertLayer {
  /**
   * @param {object} o
   * @param {import('./globe/globe.js').Globe} o.globe
   * @param {object} o.settings see DEFAULT_ALERT_SETTINGS (persisted by the app)
   * @param {Function} o.onSettings called after a settings change
   * @param {Function} o.timeMode () => 'local' | 'utc'
   * @param {Function} [o.setStatus]
   */
  constructor({ globe, settings, onSettings, timeMode, setStatus }) {
    this.globe = globe;
    this.settings = settings;
    this.onSettings = onSettings;
    this.timeMode = timeMode;
    this.setStatus = setStatus ?? (() => {});
    this.alerts = []; // {id, props, polys, bbox, event, rank, tags}
    this.zoneGeom = new Map(); // zone url -> MultiPolygon | null | Promise
    this.visible = false;
    this.group = new THREE.Group();
    this.group.renderOrder = 2.2;
    this.materials = [];
    this.popup = null; // {list, i, lat, lon}
    this.engine = null;
    this.#buildDom();
    globe.on('frame', () => this.#placePopup());
    new ResizeObserver(() => this.#resizeMaterials()).observe(globe.container);
  }

  // ------------------------------------------------------------- state
  setVisible(on) {
    on = on && this.settings.enabled;
    if (on === this.visible) return;
    this.visible = on;
    clearInterval(this.timer);
    if (on) {
      this.refresh();
      this.timer = setInterval(() => this.refresh(), REFRESH_MS);
    } else {
      this.closePopup();
    }
    this.#draw();
  }

  /** The MapLibre engine, or null for the WebGL globe. */
  setEngine(engine) {
    this.engine = engine;
    if (engine) engine.onLayers((map) => this.#addMapLayers(map));
    this.#draw();
  }

  typeStyle(event) {
    const t = this.settings.types[event] ?? {};
    return {
      on: t.on ?? this.settings.newTypesOn,
      color: t.color ?? defaultColor(event),
      fill: t.fill ?? this.settings.fill,
      width: t.width ?? this.settings.width,
    };
  }

  setType(event, patch) {
    this.settings.types[event] = { ...this.settings.types[event], ...patch };
    this.changed();
  }

  /** Settings changed: redraw, save, and fetch zones for newly shown types. */
  changed() {
    this.onSettings?.();
    this.#draw();
    this.#loadZones();
    this.renderPanel();
  }

  // ------------------------------------------------------------- data
  async refresh() {
    if (this.loading) return;
    this.loading = true;
    try {
      const res = await fetch(API, { headers: { Accept: 'application/geo+json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const now = Date.now();
      const list = [];
      for (const f of json.features ?? []) {
        const p = f.properties;
        const end = Date.parse(p.ends ?? p.expires);
        if (Number.isFinite(end) && end < now) continue;
        if (p.messageType === 'Cancel') continue;
        const old = this.alerts.find((a) => a.id === p.id);
        const own = f.geometry ? simplifyGeometry(f.geometry) : null;
        const a = old ?? { id: p.id, props: p, event: p.event, rank: rankOf(p.event), tags: alertTags(p), own };
        a.props = p;
        if (own) {
          a.polys = own.coordinates;
          a.bbox = bboxOf(a.polys);
        }
        list.push(a);
      }
      list.sort((a, b) => a.rank - b.rank);
      this.alerts = list;
      this.updated = now;
      this.error = null;
      this.#draw();
      this.#loadZones();
    } catch (err) {
      this.error = err.message;
    } finally {
      this.loading = false;
      this.renderPanel();
    }
  }

  /** Zone outlines for the shown alerts that came without a polygon. */
  async #loadZones() {
    if (!this.visible) return;
    const want = new Set();
    for (const a of this.alerts) {
      if (a.own || !this.typeStyle(a.event).on) continue;
      for (const z of a.props.affectedZones ?? []) if (!this.zoneGeom.has(z)) want.add(z);
    }
    if (!want.size) return;
    const todo = [...want];
    for (const z of todo) this.zoneGeom.set(z, undefined);
    let done = 0;
    let lastDraw = performance.now();
    const lane = async () => {
      while (todo.length) {
        const url = todo.shift();
        let geom = null;
        const hit = await idb.get(url);
        if (hit && Date.now() - hit.at < ZONE_TTL_MS) geom = hit.geom;
        else {
          try {
            const r = await fetch(url, { headers: { Accept: 'application/geo+json' } });
            if (r.ok) {
              geom = simplifyGeometry((await r.json()).geometry);
              idb.set(url, { at: Date.now(), geom });
            }
          } catch {
            // left out this time; tried again on the next refresh
            this.zoneGeom.delete(url);
            continue;
          }
        }
        this.zoneGeom.set(url, geom);
        done++;
        if (performance.now() - lastDraw > 800) {
          lastDraw = performance.now();
          this.#assignZones();
          this.#draw();
          this.renderPanel(`Loading alert areas · ${done}/${want.size}`);
        }
      }
    };
    await Promise.all(Array.from({ length: ZONE_PARALLEL }, lane));
    this.#assignZones();
    this.#draw();
    this.renderPanel();
  }

  #assignZones() {
    for (const a of this.alerts) {
      if (a.own) continue;
      const polys = [];
      for (const z of a.props.affectedZones ?? []) {
        const g = this.zoneGeom.get(z);
        if (g) polys.push(...g.coordinates);
      }
      if (polys.length !== a.polys?.length) {
        a.polys = polys;
        a.bbox = polys.length ? bboxOf(polys) : null;
      }
    }
  }

  shown() {
    return this.alerts.filter((a) => a.polys?.length && this.typeStyle(a.event).on);
  }

  /** Alerts covering a point, most dangerous first. */
  hitTest(lat, lon) {
    if (!this.visible) return [];
    const hits = this.shown().filter((a) => {
      const [w, s, e, n] = a.bbox;
      return lat >= s && lat <= n && lon >= w && lon <= e && inPolygons(a.polys, lon, lat);
    });
    // One entry per VTEC event (an event's segments and updates can overlap), the latest issuance.
    const byEvent = new Map();
    for (const a of hits) {
      const v = a.props.parameters?.VTEC?.[0]?.split('.');
      const key = v && v.length > 5 ? `${v[2]}.${v[3]}.${v[4]}.${v[5]}` : a.id;
      const prev = byEvent.get(key);
      if (!prev || Date.parse(a.props.sent) > Date.parse(prev.props.sent)) byEvent.set(key, a);
    }
    return [...byEvent.values()].sort((a, b) => a.rank - b.rank);
  }

  // ------------------------------------------------------------- drawing
  #draw() {
    if (this.engine) {
      this.#clearGlobe();
      this.#updateMap();
    } else {
      this.#drawGlobe();
    }
  }

  #clearGlobe() {
    for (const obj of [...this.group.children]) {
      obj.geometry?.dispose();
      this.group.remove(obj);
    }
    for (const m of this.materials) m.dispose();
    this.materials = [];
    if (this.group.parent) this.globe.remove(this.group);
  }

  #resizeMaterials() {
    const pr = this.globe.renderer.getPixelRatio();
    for (const m of this.materials) m.resolution?.set(this.globe.width * pr, this.globe.height * pr);
    this.globe.requestRender();
  }

  #drawGlobe() {
    this.#clearGlobe();
    if (!this.visible) return;
    const shown = this.shown();
    if (!shown.length) return;
    const pr = this.globe.renderer.getPixelRatio();
    const res = new THREE.Vector2(this.globe.width * pr, this.globe.height * pr);
    const byType = new Map();
    for (const a of shown) {
      if (!byType.has(a.event)) byType.set(a.event, []);
      byType.get(a.event).push(a);
    }
    // Least important first so warnings end up on top.
    const types = [...byType.keys()].sort((a, b) => rankOf(b) - rankOf(a));
    const casing = [];
    types.forEach((event, ti) => {
      const st = this.typeStyle(event);
      const segs = [];
      const fill = [];
      for (const a of byType.get(event)) {
        for (const poly of a.polys) {
          for (const ring of poly) pushRing(segs, ring, 1.0009);
          if (st.fill > 0) pushFill(fill, poly, 1.0005);
        }
      }
      if (fill.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(fill, 3));
        const m = new THREE.MeshBasicMaterial({ color: st.color, transparent: true, opacity: st.fill, depthWrite: false, side: THREE.DoubleSide });
        this.materials.push(m);
        const mesh = new THREE.Mesh(g, m);
        mesh.renderOrder = 1.5 + ti * 0.001;
        this.group.add(mesh);
      }
      if (!segs.length || st.width <= 0) return;
      if (this.settings.casing) casing.push(segs);
      const g = new LineSegmentsGeometry();
      g.setPositions(segs);
      const m = new LineMaterial({ color: st.color, linewidth: st.width, transparent: true, depthWrite: false });
      m.resolution.copy(res);
      this.materials.push(m);
      const obj = new LineSegments2(g, m);
      obj.renderOrder = 2.6 + ti * 0.001;
      this.group.add(obj);
    });
    if (casing.length) {
      const all = new Float32Array(casing.reduce((n, a) => n + a.length, 0));
      let o = 0;
      for (const a of casing) {
        all.set(a, o);
        o += a.length;
      }
      const g = new LineSegmentsGeometry();
      g.setPositions(all);
      const m = new LineMaterial({ color: 0x05070a, linewidth: this.settings.width + 2.2, transparent: true, opacity: 0.75, depthWrite: false });
      m.resolution.copy(res);
      this.materials.push(m);
      const obj = new LineSegments2(g, m);
      obj.renderOrder = 2.55;
      this.group.add(obj);
    }
    this.globe.add(this.group);
  }

  #geojson() {
    const features = [];
    if (this.visible) {
      for (const a of this.shown()) {
        const st = this.typeStyle(a.event);
        features.push({
          type: 'Feature',
          properties: { id: a.id, color: st.color, fill: st.fill, width: st.width, rank: 1000 - a.rank },
          geometry: { type: 'MultiPolygon', coordinates: a.polys },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  #addMapLayers(map) {
    if (!map.getSource('app-alerts')) map.addSource('app-alerts', { type: 'geojson', data: this.#geojson(), tolerance: 0.3 });
    const before = this.engine.overlayBeforeId();
    map.addLayer(
      { id: 'app-alerts-fill', type: 'fill', source: 'app-alerts', layout: { 'fill-sort-key': ['get', 'rank'] }, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fill'] } },
      before,
    );
    map.addLayer(
      {
        id: 'app-alerts-casing',
        type: 'line',
        source: 'app-alerts',
        layout: { 'line-join': 'round', 'line-sort-key': ['get', 'rank'], visibility: this.settings.casing ? 'visible' : 'none' },
        paint: { 'line-color': '#05070a', 'line-opacity': 0.75, 'line-width': ['+', ['get', 'width'], 2.2] },
      },
      before,
    );
    map.addLayer(
      {
        id: 'app-alerts-line',
        type: 'line',
        source: 'app-alerts',
        layout: { 'line-join': 'round', 'line-sort-key': ['get', 'rank'] },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] },
      },
      before,
    );
  }

  #updateMap() {
    const map = this.engine?.map;
    if (!map?.getSource('app-alerts')) return;
    map.getSource('app-alerts').setData(this.#geojson());
    if (map.getLayer('app-alerts-casing')) map.setLayoutProperty('app-alerts-casing', 'visibility', this.settings.casing ? 'visible' : 'none');
  }

  // ------------------------------------------------------------- popup
  #buildDom() {
    const pop = document.createElement('div');
    pop.id = 'alert-popup';
    pop.hidden = true;
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.body.appendChild(pop);
    this.popEl = pop;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'alert-leader';
    svg.innerHTML =
      '<defs><marker id="alert-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="#fff" stroke="#111" stroke-width="1"/></marker></defs>' +
      '<line stroke="#111" stroke-width="5" stroke-linecap="round"/><line stroke="#fff" stroke-width="2.5" stroke-linecap="round" marker-end="url(#alert-arrow)"/>';
    svg.style.display = 'none';
    document.body.appendChild(svg);
    this.leader = svg;

    const modal = document.createElement('div');
    modal.id = 'alert-text';
    modal.hidden = true;
    modal.addEventListener('pointerdown', (e) => {
      if (e.target === modal) this.closeText();
    });
    document.body.appendChild(modal);
    this.modal = modal;
  }

  get isOpen() {
    return !!this.popup || !this.modal.hidden;
  }

  /** Show the alerts at a clicked point. */
  openPopup(list, lat, lon) {
    this.popup = { list, i: 0, lat, lon };
    this.#renderPopup();
  }

  closePopup() {
    this.popup = null;
    this.popEl.hidden = true;
    this.leader.style.display = 'none';
  }

  /** Esc: the full text first, then the popup. */
  closeTop() {
    if (!this.modal.hidden) this.closeText();
    else this.closePopup();
  }

  #fmtTime(iso) {
    const t = new Date(iso);
    if (!Number.isFinite(t.getTime())) return '—';
    const utc = this.timeMode() === 'utc';
    const tz = utc ? { timeZone: 'UTC' } : {};
    const time = utc
      ? `${t.toISOString().slice(11, 16)} UTC`
      : t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    const date = t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...tz }).replace(',', '');
    return `${time} · ${date}`;
  }

  #states(p) {
    const codes = new Set((p.geocode?.UGC ?? []).map((u) => u.slice(0, 2)));
    return [...codes].map((c) => STATES[c]).filter(Boolean);
  }

  #tagsHtml(tags) {
    return tags.length ? `<div class="alert-tags">${tags.map((t) => `<span class="alert-tag t-${t.kind}">${esc(t.text)}</span>`).join('')}</div>` : '';
  }

  #renderPopup() {
    const pp = this.popup;
    if (!pp) return;
    const a = pp.list[pp.i];
    const p = a.props;
    const st = this.typeStyle(a.event);
    const states = this.#states(p);
    const n = pp.list.length;
    const nav =
      n > 1
        ? `<div class="ap-nav">
            <button class="ap-prev" aria-label="Previous alert">‹</button>
            <div class="ap-list">${pp.list
              .map((x, i) => `<button class="ap-chip${i === pp.i ? ' on' : ''}" data-i="${i}" style="--c:${this.typeStyle(x.event).color}" title="${esc(x.event)}">${esc(x.event)}</button>`)
              .join('')}</div>
            <span class="ap-count">${pp.i + 1} / ${n}</span>
            <button class="ap-next" aria-label="Next alert">›</button>
          </div>`
        : '';
    this.popEl.style.setProperty('--alert', st.color);
    this.popEl.style.setProperty('--alert-ink', inkOn(st.color));
    this.popEl.innerHTML = `
      <div class="ap-head">
        <svg class="ap-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 1.6 20.5h20.8z" fill="currentColor"/><path d="M12 9v5.2" stroke="var(--alert)" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.35" fill="var(--alert)"/></svg>
        <button class="ap-title" title="Full alert text">${esc(a.event)}</button>
        <button class="ap-close" aria-label="Close">×</button>
      </div>
      <div class="ap-body">
        ${this.#tagsHtml(a.tags)}
        <div class="ap-row"><b>Until:</b> ${this.#fmtTime(p.ends ?? p.expires)}</div>
        <div class="ap-row"><b>Issued by:</b> ${esc(p.senderName ?? 'NWS')}</div>
        ${states.length ? `<div class="ap-row"><b>${states.length > 1 ? 'States' : 'State'}:</b> ${esc(states.join(', '))}</div>` : ''}
        <div class="ap-row ap-area"><b>Area:</b> ${esc(p.areaDesc)}</div>
      </div>
      ${nav}`;
    this.popEl.hidden = false;
    this.popEl.querySelector('.ap-close').onclick = () => this.closePopup();
    this.#bindDrag(this.popEl.querySelector('.ap-head'));
    this.popEl.querySelector('.ap-title').onclick = () => {
      if (performance.now() - (this.dragEnded ?? 0) > 250) this.openText(pp.list, pp.i);
    };
    const go = (d) => {
      pp.i = (pp.i + d + n) % n;
      this.#renderPopup();
    };
    this.popEl.querySelector('.ap-prev')?.addEventListener('click', () => go(-1));
    this.popEl.querySelector('.ap-next')?.addEventListener('click', () => go(1));
    this.popEl.querySelectorAll('.ap-chip').forEach((b) =>
      b.addEventListener('click', () => {
        pp.i = Number(b.dataset.i);
        this.#renderPopup();
      }),
    );
    this.#placePopup(true);
  }

  /** Place the popup again (the map frame moved or changed size). */
  reposition() {
    this.#placePopup();
  }

  /** Drag the popup by its header; it then keeps that spot relative to the point. */
  #bindDrag(head) {
    head.addEventListener('pointerdown', (e) => {
      // Anywhere but the close button; on the title, only a real drag (not a click) moves it.
      if (e.button !== 0 || e.target.closest('.ap-close')) return;
      const pp = this.popup;
      const xy = pp && this.globe.project(pp.lat, pp.lon);
      if (!xy) return;
      const rect = this.globe.container.getBoundingClientRect();
      const m = this.popEl.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
      const start = { x: e.clientX, y: e.clientY, left: m ? +m[1] : 0, top: m ? +m[2] : 0 };
      let dragging = false;
      const move = (ev) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
          dragging = true;
          this.popEl.classList.add('dragging');
          try {
            head.setPointerCapture(e.pointerId);
          } catch {
            // synthetic pointer: fine without capture
          }
        }
        const p = this.globe.project(pp.lat, pp.lon) ?? xy;
        pp.offset = { dx: start.left + ev.clientX - start.x - (rect.left + p[0]), dy: start.top + ev.clientY - start.y - (rect.top + p[1]) };
        this.#placePopup(true);
      };
      const up = () => {
        if (dragging) this.dragEnded = performance.now(); // the click that follows isn't a title click
        this.popEl.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  #placePopup(force = false) {
    const pp = this.popup;
    if (!pp || (this.popEl.hidden && !force)) return;
    const xy = this.globe.project(pp.lat, pp.lon);
    const box = this.globe.container.getBoundingClientRect();
    if (!xy || xy[0] < -40 || xy[1] < -40 || xy[0] > box.width + 40 || xy[1] > box.height + 40) {
      this.popEl.style.visibility = 'hidden';
      this.leader.style.display = 'none';
      return;
    }
    this.popEl.style.visibility = '';
    const rect = this.globe.container.getBoundingClientRect();
    const px = rect.left + xy[0];
    const py = rect.top + xy[1];
    const w = this.popEl.offsetWidth;
    const h = this.popEl.offsetHeight;
    // Kept within the map (which may be a smaller frame: see frame.js).
    const sb = this.globe.container.getBoundingClientRect();
    const vw = sb.right;
    const vh = sb.bottom;
    // Up and to the left of the point by default (as in a TV graphic), flipping to stay on screen.
    // Keep clear of the sidebar when it's open beside the map.
    const panel = document.getElementById('panel');
    const pr = panel && vw > 760 && !document.body.classList.contains('panel-hidden') && getComputedStyle(panel).display !== 'none' ? panel.getBoundingClientRect() : null;
    const minLeft = Math.max(sb.left + 10, pr && pr.right > sb.left ? pr.right + 10 : 0);
    let left = px - w - 70;
    let top = py - h - 50;
    if (pp.offset) {
      // Dragged: stays where it was put, relative to the point.
      left = px + pp.offset.dx;
      top = py + pp.offset.dy;
    } else {
      if (left < minLeft) left = px + 70;
      if (top < 10) top = py + 50;
    }
    left = Math.max(pp.offset ? sb.left + 10 : minLeft, Math.min(vw - w - 10, left));
    top = Math.max(sb.top + 10, Math.min(vh - h - 10, top));
    this.popEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    // Leader line from the popup's nearest edge to the point.
    const ax = Math.max(left + 24, Math.min(left + w - 24, px));
    const ay = py < top ? top : py > top + h ? top + h : null;
    let x1, y1;
    if (ay != null) {
      x1 = ax;
      y1 = ay;
    } else {
      x1 = px < left ? left : left + w;
      y1 = Math.max(top + 20, Math.min(top + h - 20, py));
    }
    const inside = px >= left && px <= left + w && py >= top && py <= top + h;
    if (inside || Math.hypot(px - x1, py - y1) < 18) {
      this.leader.style.display = 'none';
      return;
    }
    this.leader.style.display = '';
    for (const line of this.leader.querySelectorAll('line')) {
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', px);
      line.setAttribute('y2', py);
    }
  }

  // ------------------------------------------------------------- full text
  openText(list, i) {
    this.textState = { list, i };
    this.#renderText();
  }

  closeText() {
    this.modal.hidden = true;
    this.textState = null;
  }

  #renderText() {
    const ts = this.textState;
    const a = ts.list[ts.i];
    const p = a.props;
    const st = this.typeStyle(a.event);
    const n = ts.list.length;
    const head = p.parameters?.NWSheadline?.[0];
    const para = (s) =>
      esc(s ?? '')
        .split(/\n\s*\n/)
        .map((b) => `<p>${b.replace(/\n/g, ' ').replace(/^\* ?([A-Z ]+)\.\.\./, '<b>$1</b> ')}</p>`)
        .join('');
    this.modal.innerHTML = `
      <div class="at-card" style="--alert:${st.color};--alert-ink:${inkOn(st.color)}" role="dialog" aria-label="${esc(a.event)}">
        <div class="at-head">
          ${n > 1 ? '<button class="at-prev" aria-label="Previous alert">‹</button>' : ''}
          <div class="at-title">${esc(a.event)}${n > 1 ? `<span>${ts.i + 1} of ${n}</span>` : ''}</div>
          ${n > 1 ? '<button class="at-next" aria-label="Next alert">›</button>' : ''}
          <button class="at-close" aria-label="Close">×</button>
        </div>
        <div class="at-body">
          ${this.#tagsHtml(a.tags)}
          ${head ? `<div class="at-headline">${esc(head)}</div>` : ''}
          <dl class="at-meta">
            <dt>Issued</dt><dd>${this.#fmtTime(p.sent)}</dd>
            <dt>Effective</dt><dd>${this.#fmtTime(p.onset ?? p.effective)}</dd>
            <dt>Until</dt><dd>${this.#fmtTime(p.ends ?? p.expires)}</dd>
            <dt>Issued by</dt><dd>${esc(p.senderName)}</dd>
            <dt>Severity</dt><dd>${esc([p.severity, p.certainty, p.urgency].filter((x) => x && x !== 'Unknown').join(' · ') || '—')}</dd>
            <dt>Area</dt><dd>${esc(p.areaDesc)}</dd>
          </dl>
          ${p.headline ? `<p class="at-sub">${esc(p.headline)}</p>` : ''}
          <div class="at-text">${para(p.description)}</div>
          ${p.instruction ? `<h4>Precautionary / preparedness actions</h4><div class="at-text">${para(p.instruction)}</div>` : ''}
          ${p.parameters?.VTEC?.[0] ? `<div class="at-vtec">${esc(p.parameters.VTEC.join('  '))}</div>` : ''}
        </div>
      </div>`;
    this.modal.hidden = false;
    this.modal.querySelector('.at-close').onclick = () => this.closeText();
    const go = (d) => {
      ts.i = (ts.i + d + n) % n;
      if (this.popup && this.popup.list === ts.list) {
        this.popup.i = ts.i;
        this.#renderPopup();
      }
      this.#renderText();
    };
    this.modal.querySelector('.at-prev')?.addEventListener('click', () => go(-1));
    this.modal.querySelector('.at-next')?.addEventListener('click', () => go(1));
  }

  /** Arrow keys while the full text is open. */
  step(d) {
    if (this.modal.hidden || !this.textState) return false;
    const n = this.textState.list.length;
    this.textState.i = (this.textState.i + d + n) % n;
    this.#renderText();
    return true;
  }

  // ------------------------------------------------------------- panel
  /** The sidebar block: switches, look, and a row per active alert type. */
  bindPanel(el) {
    this.panelEl = el;
    this.renderPanel();
  }

  renderPanel(progress) {
    const el = this.panelEl;
    if (!el) return;
    const s = this.settings;
    const counts = new Map();
    for (const a of this.alerts) counts.set(a.event, (counts.get(a.event) ?? 0) + 1);
    const types = [...counts.keys()].sort((a, b) => rankOf(a) - rankOf(b));
    const ago = this.updated ? Math.max(0, Math.round((Date.now() - this.updated) / 60e3)) : null;
    const status = this.error
      ? `Couldn't load alerts: ${esc(this.error)}`
      : progress ?? (this.updated ? `${this.alerts.length} active · updated ${ago ? `${ago} min ago` : 'just now'}` : s.enabled ? 'Loading…' : 'Off');
    const open = this.openType;
    el.innerHTML = `
      <div class="toggle${s.enabled ? ' on' : ''}" data-act="enabled"><span>NWS alerts<span class="sub">${status}</span></span><span class="switch"></span></div>
      <div class="toggle${s.onModels ? ' on' : ''}" data-act="onModels"><span>On model maps too<span class="sub">Always shown over radar</span></span><span class="switch"></span></div>
      <label class="slider-row"><span>Fill</span><output>${Math.round(s.fill * 100)}%</output><input type="range" min="0" max="0.8" step="0.02" value="${s.fill}" data-act="fill" /></label>
      <label class="slider-row"><span>Outline</span><output>${s.width.toFixed(1)} px</output><input type="range" min="0" max="6" step="0.5" value="${s.width}" data-act="width" /></label>
      <div class="toggle${s.casing ? ' on' : ''}" data-act="casing"><span>Dark edge under outlines</span><span class="switch"></span></div>
      <div class="alert-bulk">
        <button class="mini-btn" data-act="all">All on</button>
        <button class="mini-btn" data-act="none">All off</button>
        <button class="mini-btn" data-act="warnings">Warnings</button>
        <button class="mini-btn" data-act="severe">Severe wx</button>
        <button class="mini-btn" data-act="reset" title="Default colours, fill and outline for every type">Reset look</button>
      </div>
      <div class="alert-types">${
        types.length
          ? types
              .map((ev) => {
                const st = this.typeStyle(ev);
                const custom = this.settings.types[ev];
                return `<div class="alert-type${st.on ? ' on' : ''}${open === ev ? ' open' : ''}" data-ev="${esc(ev)}">
                  <button class="at-check" data-act="type" aria-pressed="${st.on}" title="${st.on ? 'Hide' : 'Show'}"></button>
                  <input type="color" value="${st.color.toLowerCase()}" data-act="color" title="Colour" />
                  <span class="at-name">${esc(ev)}</span><span class="at-n">${counts.get(ev)}</span>
                  <button class="at-edit" data-act="edit" title="Fill and outline for this type">${open === ev ? '▾' : '▸'}</button>
                  ${
                    open === ev
                      ? `<div class="at-opts">
                          <label class="slider-row"><span>Fill</span><output>${Math.round(st.fill * 100)}%</output><input type="range" min="0" max="0.8" step="0.02" value="${st.fill}" data-act="tfill" /></label>
                          <label class="slider-row"><span>Outline</span><output>${st.width.toFixed(1)} px</output><input type="range" min="0" max="8" step="0.5" value="${st.width}" data-act="twidth" /></label>
                          ${custom && (custom.color || custom.fill != null || custom.width != null) ? '<button class="mini-btn" data-act="treset">Default look</button>' : ''}
                        </div>`
                      : ''
                  }
                </div>`;
              })
              .join('')
          : `<div class="hint-row">${this.updated ? 'No active alerts' : ''}</div>`
      }</div>`;
    el.querySelectorAll('[data-act]').forEach((n) => {
      const act = n.dataset.act;
      const ev = n.closest('.alert-type')?.dataset.ev;
      if (n.tagName === 'INPUT' && n.type === 'range') {
        n.addEventListener('input', () => {
          const v = Number(n.value);
          const out = n.previousElementSibling;
          out.textContent = act.endsWith('fill') ? `${Math.round(v * 100)}%` : `${v.toFixed(1)} px`;
          if (act === 'fill' || act === 'width') this.settings[act] = v;
          else this.settings.types[ev] = { ...this.settings.types[ev], [act === 'tfill' ? 'fill' : 'width']: v };
          this.onSettings?.();
          this.#draw();
        });
        n.addEventListener('change', () => this.renderPanel());
        return;
      }
      if (n.type === 'color') {
        n.addEventListener('input', () => {
          this.settings.types[ev] = { ...this.settings.types[ev], color: n.value };
          this.onSettings?.();
          this.#draw();
        });
        return;
      }
      n.addEventListener('click', () => this.#panelAction(act, ev, types));
    });
  }

  #panelAction(act, ev, types) {
    const s = this.settings;
    const setAll = (fn) => {
      for (const t of types) s.types[t] = { ...s.types[t], on: fn(t) };
    };
    switch (act) {
      case 'enabled':
        s.enabled = !s.enabled;
        this.onSettings?.();
        this.onToggle?.();
        this.renderPanel();
        return;
      case 'onModels':
        s.onModels = !s.onModels;
        this.onSettings?.();
        this.onToggle?.();
        this.renderPanel();
        return;
      case 'casing':
        s.casing = !s.casing;
        break;
      case 'all':
        s.newTypesOn = true;
        setAll(() => true);
        break;
      case 'none':
        s.newTypesOn = false;
        setAll(() => false);
        break;
      case 'warnings':
        setAll((t) => kindOf(t) === 'warning');
        break;
      case 'severe':
        setAll((t) => /tornado|severe thunderstorm|flash flood|extreme wind|special marine|snow squall|severe weather statement/i.test(t));
        break;
      case 'reset':
        for (const t of Object.keys(s.types)) s.types[t] = s.types[t].on === undefined ? undefined : { on: s.types[t].on };
        for (const t of Object.keys(s.types)) if (!s.types[t]) delete s.types[t];
        s.fill = DEFAULT_ALERT_SETTINGS.fill;
        s.width = DEFAULT_ALERT_SETTINGS.width;
        break;
      case 'type':
        this.setType(ev, { on: !this.typeStyle(ev).on });
        return;
      case 'edit':
        this.openType = this.openType === ev ? null : ev;
        this.renderPanel();
        return;
      case 'treset':
        s.types[ev] = { on: this.typeStyle(ev).on };
        break;
      default:
        return;
    }
    this.changed();
  }
}

// ------------------------------------------------------------------ globe geometry helpers
function pushRing(out, ring, r) {
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon0, lat0] = ring[i];
    const [lon1, lat1] = ring[i + 1];
    if (Math.abs(lon1 - lon0) > 180) continue;
    const m = Math.max(1, Math.ceil(Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0)) / MAX_STEP_DEG));
    for (let k = 0; k < m; k++) {
      const t0 = k / m;
      const t1 = (k + 1) / m;
      out.push(...toXYZ(lat0 + (lat1 - lat0) * t0, lon0 + (lon1 - lon0) * t0, r), ...toXYZ(lat0 + (lat1 - lat0) * t1, lon0 + (lon1 - lon0) * t1, r));
    }
  }
}

function pushFill(out, poly, r) {
  const toV = (ring) => {
    const pts = ring.map(([x, y]) => new THREE.Vector2(x, y));
    if (pts.length > 1 && pts[0].equals(pts[pts.length - 1])) pts.pop();
    return pts;
  };
  const contour = toV(poly[0]);
  if (contour.length < 3) return;
  const holes = poly.slice(1).map(toV).filter((h) => h.length >= 3);
  let tris;
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return;
  }
  const all = [contour, ...holes].flat().map((p) => [p.x, p.y]);
  // Big triangles are split so they bend with the globe instead of cutting under it.
  const tri = (a, b, c, depth) => {
    const d = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
    if (depth < 6 && Math.max(d(a, b), d(b, c), d(c, a)) > 1.5) {
      const m = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const ab = m(a, b);
      const bc = m(b, c);
      const ca = m(c, a);
      tri(a, ab, ca, depth + 1);
      tri(ab, b, bc, depth + 1);
      tri(ca, bc, c, depth + 1);
      tri(ab, bc, ca, depth + 1);
      return;
    }
    out.push(...toXYZ(a[1], a[0], r), ...toXYZ(b[1], b[0], r), ...toXYZ(c[1], c[0], r));
  };
  for (const [i, j, k] of tris) tri(all[i], all[j], all[k], 0);
}
