// 3D radar: the user drags a box around the storms near a NEXRAD, every tilt of
// its Level II volume is resampled onto a grid over just that box (worker.js;
// the smaller the box, the finer the grid) and ray-marched on the GPU, either as
// a lit isosurface at a threshold (like GR2Analyst's volume explorer) or as a
// translucent cloud that gets denser and more opaque the stronger the echo. The
// map tilts to look across the ground at the box, and heights can be stretched.
import * as THREE from 'three';
import { LUT_SIZE } from '../colormaps.js';
import { unitFor } from '../units.js';
import { radarProductById } from './products.js';
import { listVolumes } from './source.js';
import { AlphaEditor } from './alpha-editor.js';

const R_KM = 6371;
const VOLUME_LIST_MS = 90e3; // re-list a site's volumes this often
const EXAG_DEFAULT = 3;
const MAX_RANGE_KM = 300; // how far out a box can reach
const MIN_BOX_KM = 8; // a smaller drag counts as a click
const CLICK_BOX_KM = 100; // a click puts a box this size around the spot
const PICK_ALTITUDE = 0.2; // camera altitude for drawing a box (the range ring fits)
const MOVING_STEP_SCALE = 2.5; // coarser ray steps while the camera moves
const SVG = 'http://www.w3.org/2000/svg';

/**
 * What each Level II moment looks like in 3D: the range its values are packed
 * over (worker.js), the product whose colours it takes, and how the surface is
 * drawn: 'above' (value ≥ threshold), 'below' (≤) or 'abs' (|value| ≥).
 * Thresholds are in canonical units.
 */
export const VOLUME_MOMENTS = {
  REF: { name: 'Reflectivity', product: 'ref', vmin: -20, vmax: 80, test: 'above', threshold: 35, min: 5, max: 70, step: 1, shell: 5 },
  VEL: { name: 'Velocity', product: 'vel', vmin: -80, vmax: 80, test: 'abs', threshold: 25, min: 5, max: 60, step: 0.5, shell: 5 },
  'SW ': { name: 'Spectrum width', product: 'sw', vmin: 0, vmax: 32, test: 'above', threshold: 8, min: 1, max: 20, step: 0.5, shell: 2 },
  ZDR: { name: 'Differential reflectivity', product: 'zdr', vmin: -8, vmax: 8, test: 'above', threshold: 3, min: -2, max: 7, step: 0.1, shell: 0.75 },
  RHO: { name: 'Correlation coefficient', product: 'cc', vmin: 0.2, vmax: 1.05, test: 'below', threshold: 0.8, min: 0.3, max: 0.97, step: 0.01, shell: 0.04 },
};

// Volume alpha: opacity by value, ALPHA_N samples over each moment's [vmin, vmax].
export const ALPHA_N = 64;
/** The default curve: faint where values are weak, opaque where they're strong. */
export function defaultAlpha(moment) {
  const m = VOLUME_MOMENTS[moment];
  return Array.from({ length: ALPHA_N }, (_, i) => {
    const v = m.vmin + ((m.vmax - m.vmin) * i) / (ALPHA_N - 1);
    const strength = m.test === 'abs' ? Math.abs(v) / m.vmax : m.test === 'below' ? (m.vmax - v) / (m.vmax - m.vmin) : (v - m.vmin) / (m.vmax - m.vmin);
    return Math.round((0.12 + 0.88 * Math.min(1, Math.max(0, strength))) * 1000) / 1000;
  });
}
// Products without a Level II moment of their own are shown as reflectivity.
const PRODUCT_MOMENT = { ref: 'REF', ptype: 'REF', vel: 'VEL', srv: 'VEL', sw: 'SW ', zdr: 'ZDR', cc: 'RHO' };
export const momentFor = (product) => PRODUCT_MOMENT[product.id] ?? 'REF';
const TESTS = { above: 0, below: 1, abs: 2 };

const vertexShader = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

// Ray-marched in the radar's frame: x east, y north, z up from the site on
// the ground, in globe radii, heights stretched by uExag. Each sample point is
// turned back into ground distance east / north (along the curved surface)
// and true height to look the volume up.
const fragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler3D uVol;
  uniform sampler2D uLut;
  uniform mat4 uInvFrame;   // world → radar frame
  uniform vec3 uBoxMin;
  uniform vec3 uBoxMax;
  uniform vec2 uGridMin;    // the box's south-west corner, globe radii east / north of the radar
  uniform vec2 uGridSize;   // its width and height, globe radii
  uniform float uTop;       // grid top, globe radii (true height above sea level)
  uniform float uStepScale; // > 1 while the camera moves
  uniform float uExag;
  uniform vec2 uPack;       // value range the bytes cover
  uniform vec2 uDomain;     // colormap domain
  uniform float uThreshold; // in field units (see sampleAt)
  uniform float uSpan;      // field units from the threshold to a "strong" value
  uniform int uTest;        // 0 above, 1 below, 2 |value|
  uniform int uStyle;       // 0 isosurface, 1 volumetric
  uniform float uMinStep;
  uniform sampler2D uAlpha; // volume alpha: opacity by value over uPack
  uniform float uShell;     // nested isosurfaces every this much past the threshold (field units)
  varying vec3 vWorld;

  const float NONE = -1e9;

  // (field, value) at a point of the radar frame; field is the value made so
  // "more" is always "inside" the surface, NONE where there's no data.
  vec2 sampleAt(vec3 p) {
    vec3 q = vec3(p.xy, 1.0 + p.z);
    float h = (length(q) - 1.0) / uExag;
    float d = length(p.xy);
    vec2 ground = d > 1e-12 ? p.xy * (atan(d, q.z) / d) : vec2(0.0);
    vec3 uvw = vec3((ground - uGridMin) / uGridSize, h / uTop);
    if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return vec2(NONE, 0.0);
    vec2 t = texture(uVol, uvw).rg;
    if (t.g < 0.5) return vec2(NONE, 0.0);
    float v = mix(uPack.x, uPack.y, t.r / t.g * (255.0 / 254.0));
    return vec2(uTest == 0 ? v : uTest == 1 ? -v : abs(v), v);
  }

  // The field kept near one level, so gaps in the data don't skew its gradient.
  float fieldAt(vec3 p, float level, float span) {
    return clamp(sampleAt(p).x, level - span, level + span);
  }

  float alphaOf(float v) {
    float t = clamp((v - uPack.x) / (uPack.y - uPack.x), 0.0, 1.0);
    float n = float(${ALPHA_N});
    return texture(uAlpha, vec2((t * (n - 1.0) + 0.5) / n, 0.5)).r;
  }

  vec4 lut(float v) {
    float t = clamp((v - uDomain.x) / (uDomain.y - uDomain.x), 0.0, 1.0);
    float n = float(${LUT_SIZE});
    return texture(uLut, vec2((t * (n - 1.0) + 0.5) / n, 0.5));
  }

  void main() {
    vec3 ro = (uInvFrame * vec4(cameraPosition, 1.0)).xyz;
    vec3 rd = normalize((uInvFrame * vec4(vWorld, 1.0)).xyz - ro);
    vec3 inv = 1.0 / rd;
    vec3 ta = (uBoxMin - ro) * inv;
    vec3 tb = (uBoxMax - ro) * inv;
    vec3 tlo = min(ta, tb);
    vec3 thi = max(ta, tb);
    float tn = max(max(tlo.x, tlo.y), max(tlo.z, 0.0));
    float tf = min(min(thi.x, thi.y), thi.z);
    // Stop at the ground: the globe, a unit sphere centred below the radar.
    vec3 oc = ro + vec3(0.0, 0.0, 1.0);
    float b = dot(oc, rd);
    float disc = b * b - (dot(oc, oc) - 1.0);
    if (disc > 0.0) {
      float tg = -b - sqrt(disc);
      if (tg > 0.0) tf = min(tf, tg);
    }
    if (tf <= tn) discard;

    float stepLen = max((tf - tn) / 360.0, uMinStep) * uStepScale;
    float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    float t = tn + stepLen * jitter;
    vec3 sun = normalize(vec3(-0.35, -0.45, 0.82));

    vec4 acc = vec4(0.0);
    if (uStyle == 0) {
      // Isosurfaces at the threshold and every uShell past it, nested like
      // onion skins, each lit and as opaque as the volume alpha says at its
      // value, composited front to back: strong cores show through faint shells.
      float prev = -1.0; // shell index at the last sample (-1: outside)
      float e = uMinStep * 0.7;
      for (int i = 0; i < 400; i++) {
        if (t > tf || acc.a > 0.97) break;
        float f = sampleAt(ro + rd * t).x;
        float k = f >= uThreshold ? floor((f - uThreshold) / uShell) : -1.0;
        // Each shell crossed on the way in since the last sample (a few at most).
        for (int j = 0; j < 4; j++) {
          if (k <= prev || acc.a > 0.97) break;
          prev += 1.0;
          float level = uThreshold + prev * uShell;
          float lo = max(tn, t - stepLen);
          float hi = t;
          for (int r = 0; r < 6; r++) {
            float m = 0.5 * (lo + hi);
            if (sampleAt(ro + rd * m).x >= level) hi = m; else lo = m;
          }
          vec3 p = ro + rd * hi;
          vec2 s = sampleAt(p);
          float a = alphaOf(s.y);
          if (a < 0.004) continue;
          float span = 3.0 * uShell;
          vec3 grad = vec3(
            fieldAt(p + vec3(e, 0, 0), level, span) - fieldAt(p - vec3(e, 0, 0), level, span),
            fieldAt(p + vec3(0, e, 0), level, span) - fieldAt(p - vec3(0, e, 0), level, span),
            fieldAt(p + vec3(0, 0, e), level, span) - fieldAt(p - vec3(0, 0, e), level, span));
          vec3 n = length(grad) > 0.0 ? -normalize(grad) : -rd;
          if (dot(n, rd) > 0.0) n = -n;
          float diffuse = 0.62 * max(dot(n, sun), 0.0) + 0.38 * max(dot(n, -rd), 0.0);
          float spec = pow(max(dot(reflect(-sun, n), -rd), 0.0), 28.0) * 0.28;
          vec3 c = lut(s.y).rgb * (0.28 + 0.85 * diffuse) + spec;
          acc.rgb += (1.0 - acc.a) * a * c;
          acc.a += (1.0 - acc.a) * a;
        }
        prev = min(prev, k);
        t += stepLen;
      }
      if (acc.a < 0.004) discard;
      gl_FragColor = vec4(acc.rgb / acc.a, acc.a);
      return;
    }

    // Volumetric: emission and absorption, front to back, the volume alpha
    // scaling how dense each value is.
    float stepKm = stepLen * ${R_KM.toFixed(1)};
    for (int i = 0; i < 400; i++) {
      if (t > tf || acc.a > 0.97) break;
      vec2 s = sampleAt(ro + rd * t);
      if (s.x >= uThreshold) {
        float w = clamp((s.x - uThreshold) / uSpan, 0.0, 1.0);
        float density = mix(0.012, 0.55, w * w) * 2.0 * alphaOf(s.y);
        float a = 1.0 - exp(-density * stepKm);
        vec3 c = lut(s.y).rgb * (0.6 + 0.55 * w);
        acc.rgb += (1.0 - acc.a) * a * c;
        acc.a += (1.0 - acc.a) * a;
      }
      t += stepLen;
    }
    if (acc.a < 0.004) discard;
    gl_FragColor = vec4(acc.rgb / acc.a, acc.a);
  }
`;

/** The ray-marched volume: a box over the radar, drawn after the globe and map lines. */
class VolumeLayer {
  constructor(globe) {
    this.globe = globe;
    this.frame = new THREE.Object3D();
    this.frame.matrixAutoUpdate = false;
    this.uniforms = {
      uVol: { value: null },
      uLut: { value: null },
      uInvFrame: { value: new THREE.Matrix4() },
      uBoxMin: { value: new THREE.Vector3() },
      uBoxMax: { value: new THREE.Vector3() },
      uGridMin: { value: new THREE.Vector2() },
      uGridSize: { value: new THREE.Vector2(1, 1) },
      uStepScale: { value: 1 },
      uTop: { value: 1 },
      uExag: { value: EXAG_DEFAULT },
      uPack: { value: new THREE.Vector2(0, 1) },
      uDomain: { value: new THREE.Vector2(0, 1) },
      uThreshold: { value: 0 },
      uSpan: { value: 1 },
      uTest: { value: 0 },
      uStyle: { value: 0 },
      uMinStep: { value: 0.6 / R_KM },
      uAlpha: { value: null },
      uShell: { value: 5 },
    };
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader,
        fragmentShader,
        side: THREE.BackSide, // still drawn with the camera inside the box
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.frame.add(this.mesh);
    // The box's footprint on the ground.
    this.outline = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.outline.renderOrder = 9;
    // Drawn at full resolution with the map (the volume goes in the low-res pass).
    this.outlineFrame = new THREE.Object3D();
    this.outlineFrame.matrixAutoUpdate = false;
    this.outlineFrame.add(this.outline);
    this.grid = null;
    this.added = false;
  }

  /** Coarser ray steps while the camera moves, full detail once it settles. */
  moving() {
    if (!this.added) return;
    this.uniforms.uStepScale.value = MOVING_STEP_SCALE;
    this.globe.setCoarse(true);
    clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.uniforms.uStepScale.value = 1;
      this.globe.setCoarse(false);
    }, 180);
  }

  /** Show a resampled volume (see worker.js) in a moment's colours. */
  set(grid, moment, colormap) {
    const u = this.uniforms;
    if (this.grid !== grid) {
      this.grid = grid;
      u.uVol.value?.dispose();
      const tex = new THREE.Data3DTexture(grid.data, grid.nx, grid.ny, grid.nz);
      tex.format = THREE.RGFormat;
      tex.type = THREE.UnsignedByteType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      u.uVol.value = tex;
      u.uGridMin.value.set(grid.x0 / R_KM, grid.y0 / R_KM);
      u.uGridSize.value.set((grid.x1 - grid.x0) / R_KM, (grid.y1 - grid.y0) / R_KM);
      u.uTop.value = grid.gridTopKm / R_KM;
      u.uMinStep.value = (0.6 * Math.min(grid.dx, grid.dy)) / R_KM;
      u.uPack.value.set(grid.vmin, grid.vmax);
      // The radar's own tangent frame.
      const site = new THREE.Vector3(...toXYZ(grid.lat, grid.lon));
      const east = new THREE.Vector3(site.z, 0, -site.x).normalize();
      const north = new THREE.Vector3().crossVectors(site, east).normalize();
      this.frame.matrix.makeBasis(east, north, site).setPosition(site);
      this.frame.matrixWorldNeedsUpdate = true;
      this.frame.updateMatrixWorld(true);
      u.uInvFrame.value.copy(this.frame.matrixWorld).invert();
      this.outlineFrame.matrix.copy(this.frame.matrix);
      this.outlineFrame.matrixWorldNeedsUpdate = true;
      this.outline.geometry.dispose();
      this.outline.geometry = new THREE.BufferGeometry().setFromPoints(footprint(grid));
    }
    if (this.colormap !== colormap) {
      this.colormap = colormap;
      u.uLut.value?.dispose();
      const lut = new THREE.DataTexture(colormap.rgba.slice(0, LUT_SIZE * 4), LUT_SIZE, 1, THREE.RGBAFormat);
      lut.minFilter = lut.magFilter = THREE.LinearFilter;
      lut.colorSpace = THREE.NoColorSpace;
      lut.needsUpdate = true;
      u.uLut.value = lut;
    }
    u.uDomain.value.set(...colormap.domain);
    const m = VOLUME_MOMENTS[moment];
    u.uTest.value = TESTS[m.test];
    u.uShell.value = m.shell;
    this.#fitBox();
    if (!this.added) {
      this.globe.add(this.frame, { lowRes: true });
      this.globe.add(this.outlineFrame);
      this.added = true;
    }
    this.globe.requestRender();
  }

  setLook({ style, exag, threshold, moment, alpha }) {
    const u = this.uniforms;
    const m = VOLUME_MOMENTS[moment];
    if (!u.uAlpha.value) {
      const tex = new THREE.DataTexture(new Uint8Array(ALPHA_N), ALPHA_N, 1, THREE.RedFormat, THREE.UnsignedByteType);
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.unpackAlignment = 1;
      u.uAlpha.value = tex;
    }
    const tex = u.uAlpha.value;
    alpha.forEach((a, i) => (tex.image.data[i] = Math.round(a * 255)));
    tex.needsUpdate = true;
    u.uShell.value = m.shell;
    u.uStyle.value = style === 'volume' ? 1 : 0;
    u.uExag.value = exag;
    u.uThreshold.value = m.test === 'below' ? -threshold : threshold;
    // How far past the threshold an echo counts as a core (fully dense in the volumetric style).
    u.uSpan.value = m.test === 'below' ? Math.max(0.05, threshold - m.vmin) : Math.max(1e-3, (m.vmax - threshold) * 0.6);
    this.#fitBox();
    this.globe.requestRender();
  }

  /** The box spans the data's height (stretched) and dips with the curving ground. */
  #fitBox() {
    const g = this.grid;
    if (!g) return;
    const u = this.uniforms;
    const far = Math.max(...[g.x0, g.x1].flatMap((x) => [g.y0, g.y1].map((y) => Math.hypot(x, y))));
    const drop = (far * far) / (2 * R_KM) / R_KM; // ground below the radar's tangent plane at the far corner
    const top = (g.topKm * u.uExag.value) / R_KM;
    u.uBoxMin.value.set(g.x0 / R_KM, g.y0 / R_KM, -drop - 1e-5);
    u.uBoxMax.value.set(g.x1 / R_KM, g.y1 / R_KM, top + 1e-5);
    this.mesh.position.set((g.x0 + g.x1) / 2 / R_KM, (g.y0 + g.y1) / 2 / R_KM, (top - drop) / 2);
    this.mesh.scale.set((g.x1 - g.x0) / R_KM, (g.y1 - g.y0) / R_KM, top + drop + 2e-5);
  }

  clear() {
    if (!this.added) return;
    this.globe.remove(this.frame);
    this.globe.remove(this.outlineFrame);
    this.added = false;
  }
}

/** The box's outline on the curved ground, in the radar frame, a little above it. */
function footprint(g) {
  const pts = [];
  const k = 32;
  const corners = [[g.x0, g.y0], [g.x1, g.y0], [g.x1, g.y1], [g.x0, g.y1], [g.x0, g.y0]];
  for (let c = 0; c < 4; c++) {
    const [ax, ay] = corners[c];
    const [bx, by] = corners[c + 1];
    for (let i = 0; i < (c === 3 ? k + 1 : k); i++) {
      const x = ax + ((bx - ax) * i) / k;
      const y = ay + ((by - ay) * i) / k;
      const s = Math.hypot(x, y) || 1e-9;
      const a = s / R_KM;
      const r = 1 + 0.08 / R_KM; // 80 m up
      pts.push(new THREE.Vector3((x / s) * Math.sin(a) * r, (y / s) * Math.sin(a) * r, Math.cos(a) * r - 1));
    }
  }
  return pts;
}

function toXYZ(lat, lon) {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
}

/**
 * The 3D view: drawing the box, its sidebar controls, which Level II volume goes
 * with the shown frame, fetching it and drawing it.
 */
export class Radar3D {
  /**
   * @param {object} o
   * @param {import('../globe/globe.js').Globe} o.globe
   * @param {import('./source.js').RadarSource} o.source
   * @param {{on?: boolean, style?: string, exag?: number, thresholds?: object, alpha?: object}} o.state persisted (mutated)
   * @param {() => string} o.units 'imperial' | 'metric'
   * @param {(text: string, kind?: string) => void} o.setStatus
   * @param {() => void} o.onChange settings changed: persist
   * @param {(on: boolean) => void} o.onToggle 3D switched on or off
   */
  constructor({ globe, source, state, units, setStatus, onChange, onToggle }) {
    this.globe = globe;
    this.source = source;
    this.state = state;
    this.units = units;
    this.setStatus = setStatus;
    this.onChange = onChange;
    this.onToggle = onToggle;
    this.layer = new VolumeLayer(globe);
    this.seq = 0;
    this.lists = new Map(); // site → {at, vols}
    this.moment = 'REF';
    state.style = state.style === 'volume' ? 'volume' : 'iso';
    state.exag = Number.isFinite(state.exag) ? state.exag : EXAG_DEFAULT;
    state.thresholds ??= {};
    state.alpha ??= {}; // volume alpha curve per moment, where changed from the default
    state.on = false; // the tilted view starts flat each visit

    this.el = {
      toggle: document.getElementById('radar-3d-toggle'),
      sub: document.getElementById('radar-3d-sub'),
      opts: document.getElementById('radar-3d-opts'),
      threshold: document.getElementById('radar-3d-threshold'),
      thresholdVal: document.getElementById('radar-3d-threshold-val'),
      thresholdName: document.getElementById('radar-3d-threshold-name'),
      exag: document.getElementById('radar-3d-exag'),
      exagVal: document.getElementById('radar-3d-exag-val'),
      info: document.getElementById('radar-3d-info'),
      boxLabel: document.getElementById('radar-3d-box-label'),
      boxBtn: document.getElementById('radar-3d-box'),
    };
    this.el.boxBtn.addEventListener('click', () => this.on && this.pickBox());
    this.box = null; // {site, x0, x1, y0, y1}: km east / north of the radar
    this.picking = null; // drawing a box: {a, b} corners in km once the drag starts
    this.#bindPicking();
    globe.controls.addEventListener('change', () => this.layer.moving());
    this.el.toggle.addEventListener('click', () => !this.el.toggle.classList.contains('disabled') && this.toggle());
    document.querySelectorAll('#radar-3d-style [data-style]').forEach((b) =>
      b.addEventListener('click', () => {
        state.style = b.dataset.style;
        this.#applyLook();
        this.onChange();
      }),
    );
    this.el.threshold.addEventListener('input', () => {
      const u = this.#unit();
      state.thresholds[this.moment] = u.inv(Number(this.el.threshold.value));
      this.#applyLook();
      this.#syncAlpha(); // its shading of what the threshold leaves out
    });
    this.el.threshold.addEventListener('change', () => this.onChange());
    this.el.exag.addEventListener('input', () => {
      state.exag = Number(this.el.exag.value);
      this.#applyLook();
    });
    this.el.exag.addEventListener('change', () => this.onChange());
    const resetAlpha = () => {
      delete state.alpha[this.moment];
      this.sync();
      this.#applyLook();
      this.onChange();
    };
    this.alphaEditor = new AlphaEditor({
      canvas: document.getElementById('radar-3d-alpha'),
      title: document.getElementById('radar-3d-alpha-title'),
      onInput: (alpha) => {
        state.alpha[this.moment] = alpha;
        this.#applyLook();
      },
      onCommit: () => this.onChange(),
      onReset: resetAlpha,
    });
    document.getElementById('radar-3d-alpha-reset').addEventListener('click', resetAlpha);
    this.sync();
  }

  get on() {
    return !!this.state.on;
  }

  get threshold() {
    return this.state.thresholds[this.moment] ?? VOLUME_MOMENTS[this.moment].threshold;
  }

  get alpha() {
    const a = this.state.alpha[this.moment];
    return Array.isArray(a) && a.length === ALPHA_N && a.every(Number.isFinite) ? a : defaultAlpha(this.moment);
  }

  #unit() {
    const p = radarProductById[VOLUME_MOMENTS[this.moment].product];
    return unitFor(p.unit, this.units());
  }

  /** Can the selected radar do 3D? Only NEXRADs publish Level II. A new radar needs a new box. */
  setSite(site) {
    const changed = site?.id !== this.site?.id;
    this.site = site;
    const ok = site?.type === 'WSR-88D';
    this.el.toggle.classList.toggle('disabled', !ok);
    this.el.sub.textContent = ok ? 'Draw a box around storms to see them in 3D · 3' : 'NEXRAD only: TDWRs have no Level II';
    if (!ok && this.on) this.toggle(false);
    else if (changed && this.on) this.pickBox();
  }

  setProduct(product) {
    this.moment = momentFor(product);
    this.sync();
  }

  toggle(on = !this.on) {
    if (on === this.on) return;
    if (on && this.site?.type !== 'WSR-88D') return;
    this.state.on = on;
    if (on && this.box?.site === this.site.id) this.#showBox();
    else if (on) this.pickBox();
    else {
      this.seq++;
      this.#endPicking();
      this.layer.clear();
      this.globe.setTilted(false);
      this.el.info.textContent = '';
    }
    this.sync();
    this.onChange();
    this.onToggle(on);
  }

  /** Bring the controls in line with the state and the shown moment. */
  sync() {
    const m = VOLUME_MOMENTS[this.moment];
    const u = this.#unit();
    this.el.toggle.classList.toggle('on', this.on);
    this.el.opts.hidden = !this.on;
    document.querySelectorAll('#radar-3d-style [data-style]').forEach((b) => b.classList.toggle('active', b.dataset.style === this.state.style));
    const conv = (v) => u.f(v);
    const lo = conv(m.min);
    const hi = conv(m.max);
    const step = m.step * Math.abs(conv(1) - conv(0) || 1);
    Object.assign(this.el.threshold, { min: Math.min(lo, hi), max: Math.max(lo, hi), step: Number(step.toPrecision(2)) });
    this.el.threshold.value = conv(this.threshold);
    this.el.thresholdName.textContent = `${m.name}${m.test === 'abs' ? ' ±' : m.test === 'below' ? ' ≤' : ' ≥'}`;
    this.#labels();
    this.el.exag.value = this.state.exag;
    fill(this.el.threshold);
    fill(this.el.exag);
    this.#syncAlpha();
  }

  #syncAlpha() {
    const m = VOLUME_MOMENTS[this.moment];
    this.alphaEditor.set({
      alpha: this.alpha, vmin: m.vmin, vmax: m.vmax, colormap: radarProductById[m.product].colormap(),
      unit: this.#unit(), threshold: this.threshold, test: m.test, digits: m.step < 0.05 ? 2 : m.step < 1 && m.vmax <= 10 ? 1 : 0,
    });
    document.getElementById('radar-3d-alpha-reset').disabled = !this.state.alpha[this.moment];
  }

  #labels() {
    const m = VOLUME_MOMENTS[this.moment];
    const u = this.#unit();
    const v = u.f(this.threshold);
    const digits = m.step < 0.05 ? 2 : m.step < 1 && Math.abs(v) < 10 ? 1 : 0;
    this.el.thresholdVal.textContent = `${v.toFixed(digits)} ${u.label}`;
    this.el.exagVal.textContent = `${this.state.exag}×`;
  }

  #applyLook() {
    this.layer.setLook({ style: this.state.style, exag: this.state.exag, threshold: this.threshold, moment: this.moment, alpha: this.alpha });
    document.getElementById('radar-3d-alpha-reset').disabled = !this.state.alpha[this.moment];
    document.querySelectorAll('#radar-3d-style [data-style]').forEach((b) => b.classList.toggle('active', b.dataset.style === this.state.style));
    this.#labels();
    fill(this.el.threshold);
    fill(this.el.exag);
  }

  /** Colours changed (an uploaded colour table): redraw with the new ones. */
  recolor() {
    this.#syncAlpha();
    if (this.layer.grid && this.shown) this.layer.set(this.layer.grid, this.shown.moment, radarProductById[VOLUME_MOMENTS[this.shown.moment].product].colormap());
  }

  async #volumes(site) {
    const hit = this.lists.get(site.id);
    if (hit && Date.now() - hit.at < VOLUME_LIST_MS) return hit.vols;
    const vols = await listVolumes(site);
    this.lists.set(site.id, { at: Date.now(), vols });
    return vols;
  }

  /** Draw the Level II volume that goes with a frame of the loop (scan time `time`). */
  async update(site, product, time) {
    this.last = { site, product, time };
    if (!this.on || !site) return;
    this.setProduct(product);
    const box = this.box;
    if (!box || box.site !== site.id || this.picking) return;
    const moment = this.moment;
    const m = VOLUME_MOMENTS[moment];
    const seq = ++this.seq;
    let vols;
    try {
      vols = await this.#volumes(site);
    } catch (err) {
      if (seq === this.seq) this.setStatus(`Couldn't list ${site.id}'s Level II volumes: ${err.message}`, 'error');
      return;
    }
    if (seq !== this.seq) return;
    if (!vols.length) {
      this.layer.clear();
      this.el.info.textContent = `No Level II volumes from ${site.id} in the past day`;
      return;
    }
    // The volume the frame came from: the last to start by then (scan times
    // of Level III products and Level II files can differ by a few seconds).
    let vol = vols[0];
    for (const v of vols) if (v.time <= time + 90e3) vol = v;
    const hhmm = new Date(vol.time).toISOString().slice(11, 16);
    const t0 = performance.now();
    const cached = this.source.hasVolume(vol.url, moment, box);
    if (!cached) this.setStatus(`Building ${site.id}'s ${hhmm}Z volume in 3D…`);
    let grid;
    try {
      grid = await this.source.volume(vol.url, moment, m.vmin, m.vmax, box);
    } catch (err) {
      if (seq === this.seq) this.setStatus(`Couldn't load the ${site.id} volume: ${err.message}`, 'error');
      return;
    }
    if (seq !== this.seq || !this.on || this.picking) return;
    this.shown = { url: vol.url, moment };
    this.layer.set(grid, moment, radarProductById[m.product].colormap());
    this.#applyLook();
    const angles = grid.angles;
    const shownAs = momentFor(product) === 'REF' && product.id !== 'ref' && product.id !== 'ptype' ? ` (${product.short} has no 3D: showing reflectivity)` : product.id === 'srv' ? ' (base velocity)' : '';
    this.el.info.textContent = `${site.id} ${hhmm}Z · ${m.name}${shownAs} · ${grid.nTilts} tilts, ${angles[0].toFixed(1)}–${angles[angles.length - 1].toFixed(1)}°`;
    this.el.boxLabel.textContent = `${Math.round(box.x1 - box.x0)} × ${Math.round(box.y1 - box.y0)} km box · ${(Math.min(grid.dx, grid.dy) * 1000).toFixed(0)} m detail`;
    if (!cached) this.setStatus(`3D volume: ${grid.nTilts} tilts decoded locally · ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'done');
  }

  // ------------------------------------------------------------------ the box
  /** Go back to the flat map over the radar and wait for a box to be dragged out. */
  pickBox() {
    const site = this.site;
    if (!site) return;
    this.seq++;
    this.layer.clear();
    this.picking = {};
    if (this.globe.tilted) this.globe.setTilted(false, site.lat, site.lon, { altitude: PICK_ALTITUDE });
    else if (this.globe.altitude > PICK_ALTITUDE * 2 || !this.globe.project(site.lat, site.lon)) this.globe.flyTo(site.lat, site.lon, 1 + PICK_ALTITUDE);
    this.globe.renderer.domElement.classList.add('picking');
    this.hint.hidden = false;
    this.el.boxLabel.textContent = 'Drawing a box…';
    this.el.info.textContent = '';
    this.#drawPick();
  }

  #endPicking() {
    if (!this.picking) return;
    this.picking = null;
    this.globe.renderer.domElement.classList.remove('picking');
    this.hint.hidden = true;
    this.overlay.replaceChildren();
  }

  /** Tilt the camera at the box and build its volume. */
  #showBox() {
    const b = this.box;
    const c = this.#toLatLon((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    const across = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
    this.globe.setTilted(true, c.lat, c.lon, { range: Math.min(0.2, Math.max(0.004, (across * 1.35) / R_KM)), pitch: 58 });
    if (this.last) this.update(this.last.site, this.last.product, this.last.time);
  }

  #finishBox(a, b) {
    const clamp = (v) => Math.max(-MAX_RANGE_KM, Math.min(MAX_RANGE_KM, v));
    let x0 = clamp(Math.min(a.x, b.x));
    let x1 = clamp(Math.max(a.x, b.x));
    let y0 = clamp(Math.min(a.y, b.y));
    let y1 = clamp(Math.max(a.y, b.y));
    if (x1 - x0 < MIN_BOX_KM && y1 - y0 < MIN_BOX_KM) {
      // A click: a box around the spot.
      const h = CLICK_BOX_KM / 2;
      [x0, x1, y0, y1] = [clamp(a.x - h), clamp(a.x + h), clamp(a.y - h), clamp(a.y + h)];
    }
    x1 = Math.max(x1, x0 + MIN_BOX_KM);
    y1 = Math.max(y1, y0 + MIN_BOX_KM);
    this.box = { site: this.site.id, x0, x1, y0, y1 };
    this.#endPicking();
    this.#showBox();
  }

  #cancelPick() {
    this.#endPicking();
    if (this.box?.site === this.site?.id) this.#showBox();
    else this.toggle(false);
  }

  #bindPicking() {
    const stage = this.globe.container.parentElement;
    this.overlay = document.createElementNS(SVG, 'svg');
    this.overlay.id = 'vol-overlay';
    stage.appendChild(this.overlay);
    this.hint = document.createElement('div');
    this.hint.id = 'vol-hint';
    this.hint.hidden = true;
    this.hint.innerHTML = '<b>Drag a box</b> around the storms to see in 3D (or click a spot) · Esc to cancel';
    stage.appendChild(this.hint);
    this.globe.on('frame', (moved) => moved && this.picking && this.#drawPick());

    const canvas = this.globe.renderer.domElement;
    let drag = null;
    // Capture phase on the container: the drag draws the box instead of turning the globe.
    this.globe.container.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.picking || e.button !== 0 || e.target !== canvas) return;
        e.stopPropagation();
        e.preventDefault();
        const ll = this.globe.pick(e.clientX, e.clientY);
        if (!ll) return;
        drag = { a: this.#toKm(ll) };
        this.picking.a = this.picking.b = drag.a;
      },
      true,
    );
    window.addEventListener('pointermove', (e) => {
      if (!drag || !this.picking) return;
      const ll = this.globe.pick(e.clientX, e.clientY);
      if (ll) this.picking.b = this.#toKm(ll);
      this.#drawPick();
    });
    window.addEventListener('pointerup', () => {
      if (!drag) return;
      const { a } = drag;
      drag = null;
      if (this.picking) this.#finishBox(a, this.picking.b ?? a);
    });
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !this.picking) return;
        e.stopPropagation();
        drag = null;
        this.#cancelPick();
      },
      true,
    );
  }

  /** The range ring, and the box being dragged with its size. */
  #drawPick() {
    const svg = this.overlay;
    svg.setAttribute('width', this.globe.width);
    svg.setAttribute('height', this.globe.height);
    svg.replaceChildren();
    if (!this.picking || !this.site) return;
    const ring = [];
    for (let i = 0; i <= 96; i++) {
      const az = (i / 96) * 2 * Math.PI;
      ring.push([MAX_RANGE_KM * Math.sin(az), MAX_RANGE_KM * Math.cos(az)]);
    }
    this.#path(ring, 'ring');
    const { a, b } = this.picking;
    if (!a || !b) return;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const k = 16;
    const pts = [];
    for (let i = 0; i < k; i++) pts.push([x0 + ((x1 - x0) * i) / k, y0]);
    for (let i = 0; i < k; i++) pts.push([x1, y0 + ((y1 - y0) * i) / k]);
    for (let i = 0; i < k; i++) pts.push([x1 - ((x1 - x0) * i) / k, y1]);
    for (let i = 0; i <= k; i++) pts.push([x0, y1 - ((y1 - y0) * i) / k]);
    this.#path(pts, 'halo', 'line');
    const corner = this.#toLatLon(x0, y1);
    const xy = this.globe.project(corner.lat, corner.lon);
    if (xy && x1 - x0 >= MIN_BOX_KM) {
      const t = document.createElementNS(SVG, 'text');
      t.setAttribute('x', xy[0]);
      t.setAttribute('y', xy[1] - 7);
      t.textContent = `${Math.round(x1 - x0)} × ${Math.round(y1 - y0)} km`;
      svg.appendChild(t);
    }
  }

  /** One SVG path per class, in order, through points given in km from the radar. */
  #path(kmPoints, ...classes) {
    let d = '';
    let pen = false;
    for (const [x, y] of kmPoints) {
      const ll = this.#toLatLon(x, y);
      const xy = this.globe.project(ll.lat, ll.lon);
      if (!xy) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${xy[0].toFixed(1)},${xy[1].toFixed(1)}`;
      pen = true;
    }
    if (!d) return;
    for (const cls of classes) {
      const el = document.createElementNS(SVG, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', cls);
      this.overlay.appendChild(el);
    }
  }

  // Azimuthal equidistant about the radar: lat/lon ↔ km east / north.
  #frame() {
    const c = toXYZ(this.site.lat, this.site.lon);
    const e = [c[2], 0, -c[0]];
    const len = Math.hypot(...e);
    const east = e.map((v) => v / len);
    const north = [c[1] * east[2] - c[2] * east[1], c[2] * east[0] - c[0] * east[2], c[0] * east[1] - c[1] * east[0]];
    return { c, east, north };
  }

  #toKm(ll) {
    const { c, east, north } = this.#frame();
    const p = toXYZ(ll.lat, ll.lon);
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const ex = dot(p, east);
    const ny = dot(p, north);
    const d = Math.hypot(ex, ny);
    const s = Math.atan2(d, dot(p, c)) * R_KM;
    return d ? { x: (s * ex) / d, y: (s * ny) / d } : { x: 0, y: 0 };
  }

  #toLatLon(x, y) {
    const { c, east, north } = this.#frame();
    const s = Math.hypot(x, y);
    const a = s / R_KM;
    const ux = s ? x / s : 0;
    const uy = s ? y / s : 0;
    const p = [0, 1, 2].map((i) => Math.cos(a) * c[i] + Math.sin(a) * (ux * east[i] + uy * north[i]));
    return { lat: (Math.asin(Math.max(-1, Math.min(1, p[1]))) * 180) / Math.PI, lon: (Math.atan2(-p[2], p[0]) * 180) / Math.PI };
  }
}

/** Range inputs paint their filled part from --fill. */
function fill(input) {
  const f = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, f))}%`);
}
