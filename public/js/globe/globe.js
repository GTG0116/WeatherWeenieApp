// Custom WebGL globe: a single sphere shader composites the base map (land/sea
// mask + hillshade derived from ECMWF orography), the data layer (colour LUT),
// contour/iso lines and a graticule. Vector map lines and particles sit on top.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LUT_SIZE } from '../colormaps.js';

const D2R = Math.PI / 180;
const HI_RES_ALTITUDE = 1.1; // camera altitude (globe radii) below which the detailed lines show
const TILE_DEG = 20;
const MAX_STEP_DEG = 1; // long segments are split so chords stay above the sphere
const TILT_LINE_RADIUS = 1.00005; // map lines sit ~0.3 km up in the tilted view (not 4 km)
const Y_UP = new THREE.Vector3(0, 1, 0);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** East and north unit vectors of the tangent plane at a unit vector p. */
function tangentFrame(p) {
  const east = new THREE.Vector3(p.z, 0, -p.x).normalize();
  return { east, north: new THREE.Vector3().crossVectors(p, east).normalize() };
}

export function toXYZ(lat, lon, r = 1) {
  const la = lat * D2R;
  const lo = lon * D2R;
  const c = Math.cos(la);
  return [r * c * Math.cos(lo), r * Math.sin(la), -r * c * Math.sin(lo)];
}

export function toLatLon(x, y, z) {
  const r = Math.hypot(x, y, z);
  return { lat: Math.asin(y / r) / D2R, lon: Math.atan2(-z, x) / D2R };
}

const vertexShader = /* glsl */ `
  varying vec3 vObj;
  varying vec3 vNormalV;
  void main() {
    vObj = position;
    vNormalV = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Flat pass (MapLibre engine): a full-screen quad covering a Web Mercator box,
// drawn offscreen and handed to MapLibre as a canvas source.
const flatVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vObj;
  varying vec3 vNormalV;
  void main() {
    vUv = uv;
    vObj = vec3(1.0, 0.0, 0.0);
    vNormalV = vec3(0.0, 0.0, 1.0);
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uLand;    // hi-res land coverage, cell-centred, row 0 = 90N, col 0 = 180W
  uniform sampler2D uRelief;  // [hillshade, elevation] on the model grid
  uniform highp sampler2D uData;
  uniform highp sampler2D uContour;
  uniform highp sampler2D uType;
  uniform sampler2D uLut;

  uniform vec4 uGrid;      // lat0, lon0, dlat, dlon of data fields
  uniform vec2 uSize;      // ni, nj
  uniform vec4 uBaseGrid;
  uniform vec2 uBaseSize;

  uniform bool uHasBase;
  uniform bool uRegional;  // data grid covers part of the globe (no east-west wrap)
  uniform bool uHasData;
  uniform bool uHasContour;
  uniform bool uHasType;
  uniform bool uHasIso;
  uniform int uScale;      // 0 linear, 1 log, 2 knots (evenly spaced along the LUT)
  uniform vec2 uDomain;
  uniform float uKnots[16];
  uniform int uKnotCount;
  uniform float uLutRows;
  uniform float uOpacity;
  uniform float uContourInterval;
  uniform vec3 uContourColor;
  uniform float uContourAlpha;
  uniform float uIsoValue;
  uniform vec3 uIsoColor;

  // Radar sweeps are drawn in their own polar geometry: uData holds one row
  // per radial and one column per gate, uRadarAz maps each 0.1° of azimuth to
  // its radial (-1 = none).
  uniform bool uRadar;
  uniform highp sampler2D uRadarAz;
  uniform vec3 uRadarSite;   // unit vector to the radar
  uniform vec3 uRadarEast;
  uniform vec3 uRadarNorth;
  uniform vec3 uRadarGates;  // first gate km, gate spacing km, gate count
  uniform vec3 uRfColor;     // range-folded gates
  uniform float uTypeOutside; // LUT row outside a radar's type grid

  varying vec3 vObj;
  varying vec3 vNormalV;
#ifdef FLAT
  varying vec2 vUv;
  uniform vec4 uFlatBounds; // west, east (deg), south, north (Mercator y, radians)
  vec3 flatObj() {
    float lon = radians(mix(uFlatBounds.x, uFlatBounds.y, vUv.x));
    float lat = atan(sinh(mix(uFlatBounds.z, uFlatBounds.w, vUv.y)));
    float c = cos(lat);
    return vec3(c * cos(lon), sin(lat), -c * sin(lon));
  }
#endif

  // Straight-alpha "over": with alpha = 1 this is mix(color, src, a).
  void over(inout vec3 color, inout float alpha, vec3 src, float a) {
    float outA = a + alpha * (1.0 - a);
    color = outA > 0.0 ? (src * a + color * alpha * (1.0 - a)) / outA : vec3(0.0);
    alpha = outA;
  }

  vec2 lonLat(vec3 p) {
    p = normalize(p);
    return vec2(degrees(atan(-p.z, p.x)), degrees(asin(clamp(p.y, -1.0, 1.0))));
  }

  vec2 gridXY(vec2 ll, vec4 g, vec2 size) {
    float x = mod((ll.x - g.y) / g.w, size.x);
    float y = clamp((ll.y - g.x) / g.z, 0.0, size.y - 1.0);
    return vec2(x, y);
  }

  // Data grid position; x < 0 when outside a regional grid.
  vec2 dataXY(vec2 ll) {
    if (!uRegional) return gridXY(ll, uGrid, uSize);
    vec2 xy = vec2(mod(ll.x - uGrid.y + 360.0, 360.0) / uGrid.w, (ll.y - uGrid.x) / uGrid.z);
    if (xy.x > uSize.x - 1.0 || xy.y < 0.0 || xy.y > uSize.y - 1.0) return vec2(-1.0);
    return xy;
  }

  const float MISSING = -1e30; // stands in for NaN in data textures

  float bilinear(highp sampler2D tex, vec2 xy) {
    vec2 f = floor(xy);
    vec2 t = xy - f;
    int x0 = int(f.x);
    int x1 = x0 + 1;
    if (x1 >= int(uSize.x)) x1 = uRegional ? x0 : 0;
    int y0 = int(f.y);
    int y1 = min(y0 + 1, int(uSize.y) - 1);
    float a = texelFetch(tex, ivec2(x0, y0), 0).r;
    float b = texelFetch(tex, ivec2(x1, y0), 0).r;
    float c = texelFetch(tex, ivec2(x0, y1), 0).r;
    float d = texelFetch(tex, ivec2(x1, y1), 0).r;
    if (min(min(a, b), min(c, d)) < -1e29) return MISSING;
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  }

  // Catmull-Rom weights for the four samples around fraction t.
  vec4 crWeights(float t) {
    float t2 = t * t;
    float t3 = t2 * t;
    return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
  }

  // Smoothed categorical lookup (precipitation type). Each category's 0/1 indicator is
  // Catmull-Rom interpolated over the 4x4 neighbourhood and the strongest one wins, so
  // boundaries follow smooth curves (a lone cell becomes a round blob, not a square).
  // Returns (best row, runner-up row, best - runner-up score); the score gap falls to
  // zero on a boundary, which the caller uses to anti-alias the edge.
  vec3 typeRows(vec2 xy) {
    vec2 f = floor(xy);
    vec2 t = xy - f;
    vec4 wx = crWeights(t.x);
    vec4 wy = crWeights(t.y);
    int ni = int(uSize.x);
    int nj = int(uSize.y);
    float rows[16];
    float w[16];
    for (int j = 0; j < 4; j++) {
      int y = clamp(int(f.y) - 1 + j, 0, nj - 1);
      for (int i = 0; i < 4; i++) {
        int x = int(f.x) - 1 + i;
        x = uRegional ? clamp(x, 0, ni - 1) : (x + ni) % ni;
        rows[j * 4 + i] = texelFetch(uType, ivec2(x, y), 0).r;
        w[j * 4 + i] = wx[i] * wy[j];
      }
    }
    float best = rows[5];
    float bestS = -1e9;
    float second = rows[5];
    float secondS = -1e9;
    for (int k = 0; k < 16; k++) {
      float r = rows[k];
      bool seen = false;
      for (int m = 0; m < k; m++) seen = seen || rows[m] == r;
      if (seen) continue;
      float s = 0.0;
      for (int m = 0; m < 16; m++) s += rows[m] == r ? w[m] : 0.0;
      if (s > bestS) {
        second = best;
        secondS = bestS;
        best = r;
        bestS = s;
      } else if (s > secondS) {
        second = r;
        secondS = s;
      }
    }
    if (secondS < -1e8) return vec3(best, best, 1.0);
    return vec3(best, second, bestS - secondS);
  }

  // Sweep value at a point: nearest gate along the great circle from the radar.
  float radarValue(vec3 p) {
    p = normalize(p);
    float c = dot(p, uRadarSite);
    float km = atan(length(cross(p, uRadarSite)), c) * 6371.0;
    float g = floor((km - uRadarGates.x) / uRadarGates.y);
    if (c <= 0.0 || g < 0.0 || g >= uRadarGates.z) return MISSING;
    float az = degrees(atan(dot(p, uRadarEast), dot(p, uRadarNorth)));
    if (az < 0.0) az += 360.0;
    float row = texelFetch(uRadarAz, ivec2(int(min(floor(az * 10.0), 3599.0)), 0), 0).r;
    if (row < 0.0) return MISSING;
    return texelFetch(uData, ivec2(int(g), int(row)), 0).r;
  }

  // Anti-aliased iso-lines of v at every multiple of interval.
  float contourMask(float v, float interval, float widthPx) {
    float f = v / interval;
    float w = fwidth(f);
    float d = abs(fract(f + 0.5) - 0.5) / max(w, 1e-6);
    float dense = 1.0 - smoothstep(0.18, 0.4, w);
    return (1.0 - smoothstep(widthPx * 0.5 - 0.5, widthPx * 0.5 + 0.5, d)) * dense;
  }

  float isoMask(float v, float iso, float widthPx) {
    float d = abs(v - iso) / max(fwidth(v), 1e-6);
    return 1.0 - smoothstep(widthPx * 0.5 - 0.5, widthPx * 0.5 + 0.5, d);
  }

  void main() {
#ifdef FLAT
    vec3 obj = flatObj();
    float diffuse = 0.7;
    vec3 color = vec3(0.0);
    float alpha = 0.0;
    vec2 ll = lonLat(obj);
#else
    vec3 obj = vObj;
    vec2 ll = lonLat(obj);
    vec3 n = normalize(vNormalV);
    float diffuse = clamp(dot(n, normalize(vec3(-0.35, 0.45, 0.82))), 0.0, 1.0);
    float limb = clamp(n.z, 0.0, 1.0);
    float alpha = 1.0;

    // ---- base map
    vec3 ocean = vec3(0.030, 0.058, 0.098);
    vec3 color = ocean;
    if (uHasBase) {
      vec2 bxy = gridXY(ll, uBaseGrid, uBaseSize);
      vec2 r = texture(uRelief, (bxy + 0.5) / uBaseSize).rg;
      // Mip-mapped lookup with derivatives fixed up across the dateline seam.
      vec2 luv = vec2((ll.x + 180.0) / 360.0, (90.0 - ll.y) / 180.0);
      vec2 dx = dFdx(luv);
      vec2 dy = dFdy(luv);
      if (abs(dx.x) > 0.5) dx.x -= sign(dx.x);
      if (abs(dy.x) > 0.5) dy.x -= sign(dy.x);
      float land = textureGrad(uLand, luv, dx, dy).r;
      vec3 landCol = vec3(0.165, 0.178, 0.192) * (0.45 + 1.1 * r.x) + vec3(0.06, 0.054, 0.048) * r.y;
      color = mix(ocean, landCol, land);
    }
    // graticule
    float g10 = max(contourMask(ll.x, 10.0, 0.9), contourMask(ll.y, 10.0, 0.9));
    color = mix(color, vec3(0.55, 0.65, 0.8), g10 * 0.07);
    color *= 0.6 + 0.55 * diffuse;
#endif

    // ---- data layer
    float value = MISSING;
    vec2 xy = vec2(-1.0);
    if (uHasData && uRadar) {
      value = radarValue(obj);
    } else if (uHasData) {
      xy = dataXY(ll);
      if (xy.x >= 0.0) value = bilinear(uData, xy);
    }
    if (value > 1e29) {
      over(color, alpha, uRfColor, 0.85 * uOpacity);
    } else if (value > -1e29) {
      float t;
      if (uScale == 1) {
        t = (log(max(value, 1e-6)) - log(uDomain.x)) / (log(uDomain.y) - log(uDomain.x));
      } else if (uScale == 2) {
        // Piecewise linear between knots that sit evenly along the LUT (see Colormap).
        t = 0.0;
        float segs = float(uKnotCount - 1);
        for (int i = 0; i < 15; i++) {
          if (i >= uKnotCount - 1) break;
          float a = uKnots[i];
          float b = uKnots[i + 1];
          if (value <= b || i == uKnotCount - 2) {
            t = (float(i) + (value - a) / max(b - a, 1e-9)) / segs;
            break;
          }
        }
      } else {
        t = (value - uDomain.x) / (uDomain.y - uDomain.x);
      }
      t = clamp(t, 0.0, 1.0);
      // Type rows: (best, runner-up, score gap); see typeRows.
      vec3 tr = vec3(0.0, 0.0, 1.0);
      if (uHasType && uRadar) {
        // Radar: the type comes from a lat/lon grid (uGrid / uSize) under the sweep.
        vec2 txy = dataXY(ll);
        tr = txy.x < 0.0 ? vec3(uTypeOutside, uTypeOutside, 1.0) : typeRows(txy);
      } else if (uHasType) {
        tr = typeRows(xy);
      }
      float lutSize = float(${LUT_SIZE});
      float lu = (t * (lutSize - 1.0) + 0.5) / lutSize;
      vec4 c = texture(uLut, vec2(lu, (tr.x + 0.5) / uLutRows));
      // Anti-alias the edge between types over about one screen pixel.
      float aa = max(fwidth(tr.z), 1e-6);
      if (tr.y != tr.x) {
        vec4 c2 = texture(uLut, vec2(lu, (tr.y + 0.5) / uLutRows));
        c = mix(c2, c, 0.5 + 0.5 * smoothstep(0.0, aa, tr.z));
      }
      vec3 lit = c.rgb * (0.86 + 0.2 * diffuse);
      over(color, alpha, lit, c.a * uOpacity);

      if (uHasIso) {
        over(color, alpha, uIsoColor, isoMask(value, uIsoValue, 1.6) * 0.95);
      }
    }

    // ---- contours
    if (uHasContour && xy.x >= 0.0) {
      float cv = bilinear(uContour, xy);
      if (cv > -1e29) over(color, alpha, uContourColor, contourMask(cv, uContourInterval, 1.25) * uContourAlpha);
    }

#ifdef FLAT
    gl_FragColor = vec4(color * alpha, alpha); // premultiplied, like the canvas
#else
    // subtle limb darkening for depth
    color *= mix(0.78, 1.0, smoothstep(0.0, 0.45, limb));
    gl_FragColor = vec4(color, 1.0);
#endif
  }
`;

const atmosphereVS = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vNormalV = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPosV = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;
const atmosphereFS = /* glsl */ `
  uniform float uStrength;
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vec3 viewDir = normalize(-vPosV);
    float rim = 1.0 - abs(dot(normalize(vNormalV), viewDir));
    // rim ≈ 0.6 at the globe's limb and 1.0 at the shell's edge (back faces only)
    float glow = pow(clamp((1.0 - rim) / 0.42, 0.0, 1.0), 2.4);
    gl_FragColor = vec4(vec3(0.35, 0.62, 1.0) * glow * uStrength, glow * uStrength);
  }
`;

function floatTexture(values, ni, nj) {
  const tex = new THREE.DataTexture(values, ni, nj, THREE.RedFormat, THREE.FloatType);
  tex.internalFormat = 'R32F';
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const EMPTY = floatTexture(new Float32Array(1), 1, 1);
const RF_COLOR = [0.47, 0.2, 0.62]; // range-folded radar gates

export class Globe {
  constructor(container) {
    this.container = container;
    this.listeners = { change: [], frame: [] };
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.002, 50);
    this.homeDistance = 3.4;
    const [x, y, z] = toXYZ(37, -92, this.homeDistance);
    this.camera.position.set(x, y, z);
    this.distance = this.homeDistance;
    this.targetDistance = this.homeDistance;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableZoom = false; // custom altitude-based zoom below
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minPolarAngle = 0.02;
    this.controls.maxPolarAngle = Math.PI - 0.02;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: -1 }; // see #bindPinch
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.uniforms = {
      uLand: { value: null },
      uRelief: { value: null },
      uData: { value: EMPTY },
      uContour: { value: EMPTY },
      uType: { value: EMPTY },
      uLut: { value: null },
      uGrid: { value: new THREE.Vector4(90, -180, -0.25, 0.25) },
      uSize: { value: new THREE.Vector2(1, 1) },
      uBaseGrid: { value: new THREE.Vector4(90, -180, -0.25, 0.25) },
      uBaseSize: { value: new THREE.Vector2(1, 1) },
      uHasBase: { value: false },
      uRegional: { value: false },
      uHasData: { value: false },
      uHasContour: { value: false },
      uHasType: { value: false },
      uHasIso: { value: false },
      uScale: { value: 0 },
      uDomain: { value: new THREE.Vector2(0, 1) },
      uKnots: { value: new Float32Array(16) },
      uKnotCount: { value: 2 },
      uLutRows: { value: 1 },
      uOpacity: { value: 1 },
      uContourInterval: { value: 6 },
      uContourColor: { value: new THREE.Color(0, 0, 0) },
      uContourAlpha: { value: 0.75 },
      uIsoValue: { value: 0 },
      uIsoColor: { value: new THREE.Color(1, 1, 1) },
      uRadar: { value: false },
      uRadarAz: { value: EMPTY },
      uRadarSite: { value: new THREE.Vector3(1, 0, 0) },
      uRadarEast: { value: new THREE.Vector3(0, 0, -1) },
      uRadarNorth: { value: new THREE.Vector3(0, 1, 0) },
      uRadarGates: { value: new THREE.Vector3(0, 1, 0) },
      uRfColor: { value: new THREE.Color(0.47, 0.2, 0.62) },
      uTypeOutside: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader });
    this.globe = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), this.material);
    this.scene.add(this.globe);

    this.atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.09, 128, 64),
      new THREE.ShaderMaterial({
        uniforms: { uStrength: { value: 1 } },
        vertexShader: atmosphereVS,
        fragmentShader: atmosphereFS,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.scene.add(this.atmosphere);

    this.lineLayers = {};
    this.textures = {};
    this.raycaster = new THREE.Raycaster();
    this.dirty = true;
    this.frameHooks = [];

    this.#bindZoom();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.#loop();
  }

  on(evt, fn) {
    this.listeners[evt].push(fn);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return; // hidden (e.g. a background tab): sizes would be NaN
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    // Shift the globe's centre so it isn't hidden behind side panels.
    if (this.centerOffset) this.camera.setViewOffset(w, h, -this.centerOffset, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    // Distance at which the whole globe fits the shorter screen axis, with margin.
    const halfFov = Math.min(this.camera.fov, this.camera.fov * this.camera.aspect) * (Math.PI / 360);
    this.homeDistance = Math.min(6, 1.32 / Math.sin(halfFov));
    if (!this.sized) {
      this.sized = true;
      this.distance = this.targetDistance = this.homeDistance;
      this.camera.position.setLength(this.distance);
    }
    const pr = this.renderer.getPixelRatio();
    for (const layer of Object.values(this.lineLayers)) layer.material.resolution.set(w * pr, h * pr);
    this.dirty = true;
  }

  setCenterOffset(px) {
    this.centerOffset = px;
    if (this.ext) return this.ext.setCenterOffset(px);
    this.resize();
  }

  // ------------------------------------------------------------- external map (MapLibre)
  /**
   * Hand the view over to another map engine (see map/maplibre.js): it owns
   * the camera and input, and this class draws the data layer offscreen in Web
   * Mercator for it (renderFlat). Camera helpers (project, pick, flyTo, ...)
   * then answer for that map, so the overlays built on them keep working.
   */
  attachMap(ext) {
    this.ext = ext;
    this.flight = this.tiltFlight = this.tiltAnim = null;
    this.renderer.domElement.style.display = 'none';
    this.dirty = true;
  }

  detachMap() {
    if (!this.ext) return;
    this.ext = null;
    this.renderer.domElement.style.display = '';
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.sized = true;
    this.resize();
    this.dirty = true;
  }

  /** The element map input arrives on, whichever engine draws the map. */
  get eventEl() {
    return this.container;
  }

  /**
   * Draw the data layer (no base map) over a Web Mercator box into the
   * renderer's canvas, w x h device pixels, transparent where there's no data.
   * @param {{west: number, east: number, south: number, north: number}} b degrees
   * @returns {HTMLCanvasElement} valid until the next render
   */
  renderFlat(b, w, h) {
    if (!this.flat) {
      const material = new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, uFlatBounds: { value: new THREE.Vector4() } },
        vertexShader: flatVertexShader,
        fragmentShader,
        defines: { FLAT: 1 },
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);
      this.flat = { scene, material, camera: new THREE.Camera() };
    }
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.06, Math.min(85.06, lat)) * D2R) / 2));
    this.flat.material.uniforms.uFlatBounds.value.set(b.west, b.east, merc(b.south), merc(b.north));
    const r = this.renderer;
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    r.setRenderTarget(null);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.flat.scene, this.flat.camera);
    return r.domElement;
  }

  /**
   * Shrink the (hidden) canvas once renderFlat's picture has been copied out:
   * its multisampled drawing buffer at map size is the biggest GPU allocation
   * while MapLibre is on, and low-end devices can't keep it next to MapLibre's.
   */
  releaseFlat() {
    if (this.ext) this.renderer.setSize(1, 1, false);
  }

  // ------------------------------------------------------------- image & video export
  /** Draw at a higher pixel ratio until endCapture (export at a set size). */
  beginCapture(pixelRatio) {
    if (this.ext) return this.ext.beginCapture(pixelRatio);
    this.renderer.setPixelRatio(pixelRatio);
    this.resize();
  }

  /**
   * The map as it is now, drawn this instant: the canvas holds it until the
   * next frame, so read it straight away.
   * @returns {Promise<HTMLCanvasElement>}
   */
  async snapshot() {
    if (this.ext) return this.ext.snapshot();
    this.#render();
    return this.renderer.domElement;
  }

  endCapture() {
    if (this.ext) return this.ext.endCapture();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.resize();
    this.dirty = true;
  }

  /** lat/lon at the middle of the view. */
  centerLatLon() {
    if (this.ext) return this.ext.center();
    const c = this.tiltState ? this.controls.target : this.camera.position;
    return toLatLon(c.x, c.y, c.z);
  }

  #bindZoom() {
    const el = this.renderer.domElement;
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.tiltState || this.tiltAnim) return; // OrbitControls dollies in the tilted view
        const alt = this.targetDistance - 1;
        const factor = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 150) * 0.0022);
        this.targetDistance = 1 + Math.min(5.5, Math.max(0.03, alt * factor));
      },
      { passive: false },
    );
    this.#bindPinch(el);
  }

  /**
   * Two-finger touch on the straight-down globe: pinch to zoom and drag to
   * pan, keeping the ground under the fingers where it is (OrbitControls'
   * own pinch dollies the camera, which this view doesn't use). The tilted
   * view leaves touch to OrbitControls, where pinch and two-finger pan work.
   */
  #bindPinch(el) {
    const touches = new Map(); // pointerId -> {x, y}
    let pinch = null; // {dist, mid, anchor}: anchor is the ground point held under the midpoint
    const measure = () => {
      const [a, b] = [...touches.values()];
      return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    const start = () => {
      pinch = touches.size === 2 && !this.tiltState && !this.tiltAnim ? measure() : null;
      if (!pinch) return;
      this.flight = null;
      this.distance = this.targetDistance = this.camera.position.length();
      this.camera.updateMatrixWorld();
      pinch.anchor = this.#pickVector(pinch.mid.x, pinch.mid.y);
      this.controls._sphericalDelta?.set(0, 0, 0); // no leftover one-finger spin
    };
    const end = (e) => {
      if (!touches.delete(e.pointerId)) return;
      start();
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      start();
    });
    el.addEventListener('pointermove', (e) => {
      const t = touches.get(e.pointerId);
      if (!t) return;
      t.x = e.clientX;
      t.y = e.clientY;
      if (!pinch) return;
      if (this.tiltState || this.tiltAnim) return void (pinch = null);
      const now = measure();
      const alt = Math.min(5.5, Math.max(0.03, (this.distance - 1) * (pinch.dist / now.dist)));
      this.distance = this.targetDistance = 1 + alt;
      this.camera.position.setLength(this.distance);
      this.camera.updateMatrixWorld();
      // Turn the globe so the spot first under the fingers' midpoint is under it again.
      // (Holding the same spot for the whole gesture keeps small errors from adding up.)
      // Re-aiming at the centre undoes part of each turn, so settle it in a few passes.
      const { anchor } = pinch;
      for (let i = 0; anchor && i < 4; i++) {
        const under = this.#pickVector(now.mid.x, now.mid.y);
        if (!under || under.angleTo(anchor) < 1e-7) break;
        this.camera.position.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(under, anchor));
        this.camera.lookAt(0, 0, 0);
        this.camera.updateMatrixWorld();
      }
      pinch = { ...now, anchor };
      this.dirty = true;
      this.#applyLod();
    });
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  zoomBy(factor) {
    if (this.ext) return this.ext.zoomBy(factor);
    if (this.tiltState) {
      const c = this.controls;
      const off = this.camera.position.clone().sub(c.target);
      off.setLength(Math.min(c.maxDistance, Math.max(c.minDistance, off.length() * factor)));
      this.camera.position.copy(c.target).add(off);
      this.dirty = true;
      return;
    }
    const alt = this.targetDistance - 1;
    this.targetDistance = 1 + Math.min(5.5, Math.max(0.03, alt * factor));
  }

  flyTo(lat, lon, distance) {
    if (this.ext) return this.ext.flyTo(lat, lon, distance === undefined ? null : distance - 1);
    distance ??= this.targetDistance;
    const to = new THREE.Vector3(...toXYZ(lat, lon));
    if (this.tiltState) {
      // Tilted: glide the orbit point over, closing in only when asked to zoom in.
      const range = this.camera.position.distanceTo(this.controls.target);
      this.tiltFlight = { from: this.controls.target.clone(), to, t: 0, range: distance - 1 < this.altitude ? range * 0.55 : range };
      return;
    }
    this.flight = { from: this.camera.position.clone().normalize(), to, t: 0 };
    this.targetDistance = distance;
  }

  // ------------------------------------------------------------- tilted (3D) view
  get tilted() {
    return !this.ext && !!this.tiltState;
  }

  /**
   * Tilt the camera to look across the surface at a point (3D radar), or back
   * to the straight-down globe view. While tilted, OrbitControls orbit that
   * point on the ground (drag), pan along the ground (right-drag) and dolly
   * (wheel); the point is kept on the surface and "up" kept local.
   * @param {{range?: number, pitch?: number, heading?: number, altitude?: number}} view
   *   tilted: camera distance (globe radii), degrees from straight down, and
   *   compass heading; leaving it: the altitude to end at over lat/lon (if given)
   */
  setTilted(on, lat, lon, { range = 0.075, pitch = 60, heading = 0, altitude } = {}) {
    if (on === this.tilted) return;
    const cam = this.camera;
    const from = { pos: cam.position.clone(), target: this.controls.target.clone(), up: cam.up.clone() };
    let to;
    if (on) {
      const t = new THREE.Vector3(...toXYZ(lat, lon));
      const { east, north } = tangentFrame(t);
      const p = pitch * D2R;
      const h = heading * D2R;
      const off = t.clone().multiplyScalar(Math.cos(p))
        .addScaledVector(north, -Math.sin(p) * Math.cos(h))
        .addScaledVector(east, -Math.sin(p) * Math.sin(h))
        .multiplyScalar(range);
      to = { pos: t.clone().add(off), target: t, up: t.clone() };
    } else {
      const t = lat != null ? new THREE.Vector3(...toXYZ(lat, lon)) : this.controls.target.clone().normalize();
      const alt = altitude ?? Math.min(5.5, Math.max(0.12, cam.position.distanceTo(this.controls.target) * 2));
      to = { pos: t.clone().multiplyScalar(1 + alt), target: new THREE.Vector3(), up: Y_UP.clone() };
    }
    this.tiltState = on ? {} : null;
    this.flight = this.tiltFlight = null;
    this.tiltAnim = { from, to, t: 0, on };
    this.controls.enabled = false;
    this.#applyLod();
  }

  #configureControls(tilted) {
    const c = this.controls;
    const cam = this.camera;
    c.enableZoom = c.enablePan = c.zoomToCursor = tilted;
    c.screenSpacePanning = !tilted;
    // Globe view: two fingers are handled by #bindPinch, so OrbitControls stays out of it.
    c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: tilted ? THREE.TOUCH.DOLLY_PAN : -1 };
    if (tilted) {
      Object.assign(c, { minDistance: 0.0025, maxDistance: 0.5, minPolarAngle: 0, maxPolarAngle: 1.48, rotateSpeed: 0.55, zoomSpeed: 2.2 });
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    } else {
      Object.assign(c, { minDistance: 0, maxDistance: Infinity, minPolarAngle: 0.02, maxPolarAngle: Math.PI - 0.02, zoomSpeed: 1 });
      c.target.set(0, 0, 0);
      cam.up.copy(Y_UP);
      this.distance = this.targetDistance = cam.position.length();
      cam.near = 0.002;
      cam.far = 50;
      cam.updateProjectionMatrix();
    }
    this.#syncControlsUp();
    c.enabled = true;
  }

  /** OrbitControls caches the rotation from camera.up to +Y when created. */
  #syncControlsUp() {
    this.controls._quat.setFromUnitVectors(this.camera.up, Y_UP);
    this.controls._quatInverse.copy(this.controls._quat).invert();
  }

  /** Keep the orbit point on the surface and "up" pointing away from the centre. */
  #anchorTilt() {
    const c = this.controls;
    const cam = this.camera;
    const len = c.target.length();
    const up = c.target.clone().divideScalar(len);
    const off = cam.position.clone().sub(c.target);
    let changed = false;
    if (Math.abs(len - 1) > 1e-10) {
      c.target.copy(up);
      changed = true;
    }
    if (cam.up.angleTo(up) > 1e-8) {
      off.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(cam.up, up));
      cam.up.copy(up);
      this.#syncControlsUp();
      changed = true;
    }
    if (changed) {
      cam.position.copy(c.target).add(off);
      cam.lookAt(c.target);
    }
    // Near plane: close to the ground, but not so close that map lines z-fight it.
    const near = Math.min(0.002, Math.max(2e-5, (cam.position.length() - 1) * 0.5));
    if (Math.abs(cam.near - near) > near * 0.2) {
      cam.near = near;
      cam.far = 6;
      cam.updateProjectionMatrix();
    }
    return changed;
  }

  /**
   * Add a 3D object (e.g. a radar volume) to the scene. With lowRes, it's drawn
   * offscreen at CSS-pixel resolution (less while the camera moves) and laid
   * over the map: for costly ray-marched layers that need no depth test.
   */
  add(obj, { lowRes = false } = {}) {
    (lowRes ? this.#lowRes().scene : this.scene).add(obj);
    this.dirty = true;
  }

  remove(obj) {
    obj.removeFromParent();
    this.dirty = true;
  }

  requestRender() {
    this.dirty = true;
  }

  /** Coarser low-res layers while true (the camera is moving). */
  setCoarse(on) {
    if (this.low && this.low.coarse !== on) {
      this.low.coarse = on;
      this.dirty = true;
    }
  }

  #lowRes() {
    if (this.low) return this.low;
    // The offscreen pass is blended with its colour already multiplied by alpha.
    const composite = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { uTex: { value: null } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'uniform sampler2D uTex; varying vec2 vUv; void main() { gl_FragColor = texture2D(uTex, vUv); }',
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    composite.frustumCulled = false;
    const compositeScene = new THREE.Scene();
    compositeScene.add(composite);
    this.low = { scene: new THREE.Scene(), target: null, coarse: false, composite, compositeScene, camera: new THREE.Camera() };
    return this.low;
  }

  #render() {
    const r = this.renderer;
    r.render(this.scene, this.camera);
    const low = this.low;
    if (!low?.scene.children.length) return;
    const pr = r.getPixelRatio();
    const scale = (low.coarse ? 0.55 : 1) / Math.max(1, pr);
    const w = Math.max(1, Math.round(this.width * pr * scale));
    const h = Math.max(1, Math.round(this.height * pr * scale));
    if (!low.target) {
      low.target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
      low.composite.material.uniforms.uTex.value = low.target.texture;
    } else if (low.target.width !== w || low.target.height !== h) low.target.setSize(w, h);
    r.setRenderTarget(low.target);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(low.scene, this.camera);
    r.setRenderTarget(null);
    const auto = r.autoClear;
    r.autoClear = false;
    r.render(low.compositeScene, low.camera);
    r.autoClear = auto;
  }

  #loop() {
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (this.ext) {
        // MapLibre owns the view: redraw the data for it when that changed,
        // and let the overlays follow its camera.
        const moved = this.dirty || this.viewDirty;
        if (this.dirty) this.ext.dataChanged();
        if (moved) {
          for (const fn of this.listeners.frame) fn(true);
          for (const fn of this.listeners.change) fn();
        }
        this.dirty = this.viewDirty = false;
        requestAnimationFrame(tick);
        return;
      }
      let moved = false;
      const cam = this.camera;
      if (this.tiltAnim) {
        // Into or out of the tilted view: the camera swings along a path that
        // stays above the ground while the look-at point and "up" blend over.
        const a = this.tiltAnim;
        a.t = Math.min(1, a.t + dt / 1.1);
        const e = ease(a.t);
        const r = a.from.pos.length() + (a.to.pos.length() - a.from.pos.length()) * e;
        cam.position.copy(a.from.pos).normalize().lerp(a.to.pos.clone().normalize(), e).setLength(r);
        this.controls.target.lerpVectors(a.from.target, a.to.target, e);
        cam.up.lerpVectors(a.from.up, a.to.up, e).normalize();
        cam.lookAt(this.controls.target);
        if (a.on) this.#anchorTilt(); // near plane
        if (a.t >= 1) {
          this.tiltAnim = null;
          this.#configureControls(a.on);
        }
        moved = true;
      } else if (this.tiltState) {
        if (this.tiltFlight) {
          const f = this.tiltFlight;
          f.t = Math.min(1, f.t + dt / 1.1);
          const off = cam.position.clone().sub(this.controls.target);
          off.setLength(off.length() + (f.range - off.length()) * Math.min(1, dt * 6));
          this.controls.target.copy(f.from).lerp(f.to, ease(f.t)).normalize();
          cam.position.copy(this.controls.target).add(off);
          if (f.t >= 1) this.tiltFlight = null;
          moved = true;
        }
        if (this.controls.update()) moved = true;
        if (this.#anchorTilt()) moved = true;
        this.distance = this.targetDistance = cam.position.length();
      } else {
        if (this.flight) {
          const f = this.flight;
          f.t = Math.min(1, f.t + dt / 1.1);
          const dir = f.from.clone().lerp(f.to, ease(f.t)).normalize();
          cam.position.copy(dir.multiplyScalar(this.distance));
          if (f.t >= 1) this.flight = null;
          moved = true;
        }
        if (Math.abs(this.distance - this.targetDistance) > 1e-5) {
          this.distance += (this.targetDistance - this.distance) * Math.min(1, dt * 9);
          cam.position.setLength(this.distance);
          moved = true;
        }
        const alt = this.distance - 1;
        // Rotate so a drag tracks the ground under the cursor: the visible arc
        // shrinks with altitude, so the rotation per pixel must too.
        this.controls.rotateSpeed = Math.min(0.32, Math.max(0.0015, alt * Math.tan(cam.fov * (Math.PI / 360)) / Math.PI));
        if (this.controls.update()) moved = true;
      }
      this.atmosphere.material.uniforms.uStrength.value = Math.min(1, Math.max(0, (cam.position.length() - 1.12) / 0.6));
      if (moved) this.#applyLod();
      if (moved) this.dirty = true;

      let animating = false;
      for (const hook of this.frameHooks) animating = hook(dt, this) || animating;

      if (this.dirty || animating) {
        this.#render();
        for (const fn of this.listeners.frame) fn(this.dirty);
        if (this.dirty) for (const fn of this.listeners.change) fn();
        this.dirty = false;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------- base map
  /** Load the pre-baked land mask and relief (see tools/build-basemap.mjs). */
  async loadBase(dir = 'data/base') {
    const gunzip = async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    };
    const [meta, land, relief] = await Promise.all([
      fetch(`${dir}/base.json`).then((r) => r.json()),
      gunzip(`${dir}/land.bin.gz`),
      gunzip(`${dir}/relief.bin.gz`),
    ]);

    const landTex = new THREE.DataTexture(land, meta.land.width, meta.land.height, THREE.RedFormat, THREE.UnsignedByteType);
    landTex.wrapS = THREE.RepeatWrapping;
    landTex.minFilter = THREE.LinearMipmapLinearFilter;
    landTex.magFilter = THREE.LinearFilter;
    landTex.generateMipmaps = true;
    landTex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    landTex.unpackAlignment = 1;
    landTex.needsUpdate = true;

    const r = meta.relief;
    const reliefTex = new THREE.DataTexture(relief, r.ni, r.nj, THREE.RGFormat, THREE.UnsignedByteType);
    reliefTex.wrapS = THREE.RepeatWrapping;
    reliefTex.minFilter = THREE.LinearFilter;
    reliefTex.magFilter = THREE.LinearFilter;
    reliefTex.generateMipmaps = false;
    reliefTex.unpackAlignment = 1;
    reliefTex.needsUpdate = true;

    this.uniforms.uLand.value = landTex;
    this.uniforms.uRelief.value = reliefTex;
    this.uniforms.uBaseGrid.value.set(r.lat0, r.lon0, r.dlat, r.dlon);
    this.uniforms.uBaseSize.value.set(r.ni, r.nj);
    this.uniforms.uHasBase.value = true;
    this.dirty = true;
  }

  // ------------------------------------------------------------- data layer
  #setFloatTex(slot, values, meta) {
    // NaN (outside a regional domain, bitmapped points) can't be relied on in
    // shaders: swap in a sentinel the shader tests for.
    let first = -1;
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== values[i]) {
        first = i;
        break;
      }
    }
    if (first >= 0) {
      values = values.slice();
      for (let i = first; i < values.length; i++) if (values[i] !== values[i]) values[i] = -1e30;
    }
    let tex = this.textures[slot];
    if (tex && tex.image.width === meta.ni && tex.image.height === meta.nj) {
      tex.image.data = values;
      tex.needsUpdate = true;
    } else {
      tex?.dispose();
      tex = floatTexture(values, meta.ni, meta.nj);
      this.textures[slot] = tex;
    }
    return tex;
  }

  /**
   * @param {object} layer
   * @param {Float32Array} layer.values
   * @param {object} layer.meta grid
   * @param {import('../colormaps.js').Colormap} layer.colormap
   * @param {Float32Array} [layer.types] per-point LUT row
   * @param {{values: Float32Array, interval: number, color: number[], alpha?: number}} [layer.contour]
   * @param {{value: number, color: number[]}} [layer.iso]
   */
  setLayer({ values, meta, colormap, types, contour, iso, opacity = 1 }) {
    const u = this.uniforms;
    u.uData.value = this.#setFloatTex('data', values, meta);
    u.uGrid.value.set(meta.lat0, meta.lon0, meta.dlat, meta.dlon);
    u.uSize.value.set(meta.ni, meta.nj);
    u.uRegional.value = !!meta.regional;
    u.uHasData.value = true;
    u.uRadar.value = false;
    this.#setColormap(colormap, opacity);

    u.uHasType.value = !!types;
    u.uType.value = types ? this.#setFloatTex('type', types, meta) : EMPTY;

    u.uHasContour.value = !!contour;
    if (contour) {
      u.uContour.value = this.#setFloatTex('contour', contour.values, meta);
      u.uContourInterval.value = contour.interval;
      u.uContourColor.value.setRGB(...contour.color);
      u.uContourAlpha.value = contour.alpha ?? 0.8;
    } else {
      u.uContour.value = EMPTY;
    }

    u.uHasIso.value = !!iso;
    if (iso) {
      u.uIsoValue.value = iso.value;
      u.uIsoColor.value.setRGB(...iso.color);
    }
    this.dirty = true;
  }

  /**
   * Draw one radar sweep in its native polar geometry (nearest gate, no regridding).
   * @param {object} sweep decoded sweep (radar/level3.js, radar/level2.js) with its azLut
   * @param {import('../colormaps.js').Colormap} colormap
   * @param {{types: Float32Array, meta: object, outside: number}} [typeGrid] LUT row per
   *   point of a lat/lon grid (precipitation type), `outside` beyond it
   */
  setRadarLayer(sweep, colormap, typeGrid = null, opacity = 1) {
    const u = this.uniforms;
    u.uData.value = this.#setFloatTex('data', sweep.values, { ni: sweep.nGates, nj: sweep.nRadials });
    u.uRadarAz.value = this.#setFloatTex('radarAz', sweep.azLut, { ni: sweep.azLut.length, nj: 1 });
    const la = sweep.lat * D2R;
    const lo = sweep.lon * D2R;
    u.uRadarSite.value.set(...toXYZ(sweep.lat, sweep.lon));
    u.uRadarEast.value.set(-Math.sin(lo), 0, -Math.cos(lo));
    u.uRadarNorth.value.set(-Math.sin(la) * Math.cos(lo), Math.cos(la), Math.sin(la) * Math.sin(lo));
    u.uRadarGates.value.set(sweep.firstGateKm, sweep.gateKm, sweep.nGates);
    u.uRadar.value = true;
    u.uHasData.value = true;
    u.uHasType.value = !!typeGrid;
    u.uType.value = typeGrid ? this.#setFloatTex('type', typeGrid.types, typeGrid.meta) : EMPTY;
    if (typeGrid) {
      const m = typeGrid.meta;
      u.uGrid.value.set(m.lat0, m.lon0, m.dlat, m.dlon);
      u.uSize.value.set(m.ni, m.nj);
      u.uRegional.value = !!m.regional;
      u.uTypeOutside.value = typeGrid.outside;
    }
    u.uRfColor.value.setRGB(...(colormap.rfColor ?? RF_COLOR));
    u.uHasContour.value = false;
    u.uContour.value = EMPTY;
    u.uHasIso.value = false;
    this.#setColormap(colormap, opacity);
    this.dirty = true;
  }

  #setColormap(colormap, opacity) {
    const u = this.uniforms;
    if (this.lutCm !== colormap) {
      this.lutCm = colormap;
      this.textures.lut?.dispose();
      const lut = new THREE.DataTexture(colormap.rgba, LUT_SIZE, colormap.rows.length, THREE.RGBAFormat);
      lut.minFilter = THREE.LinearFilter;
      lut.magFilter = THREE.LinearFilter;
      lut.wrapS = lut.wrapT = THREE.ClampToEdgeWrapping;
      lut.colorSpace = THREE.NoColorSpace;
      lut.needsUpdate = true;
      this.textures.lut = lut;
      u.uLut.value = lut;
    }
    u.uLutRows.value = colormap.rows.length;
    u.uScale.value = colormap.scale === 'log' ? 1 : colormap.scale === 'knots' ? 2 : 0;
    u.uDomain.value.set(...colormap.domain);
    if (colormap.knots) {
      u.uKnots.value.fill(0);
      u.uKnots.value.set(colormap.knots.slice(0, 16));
      u.uKnotCount.value = Math.min(16, colormap.knots.length);
    }
    u.uOpacity.value = opacity;
  }

  clearLayer() {
    this.uniforms.uHasData.value = false;
    this.uniforms.uHasContour.value = false;
    this.uniforms.uRadar.value = false;
    this.dirty = true;
  }

  // ------------------------------------------------------------- vector lines
  /**
   * Add one level of detail of a line layer.
   * @param {string} name layer name (coast, borders, ...)
   * @param {ArrayBuffer} buf line file (see tools/build-geo.mjs)
   * @param {{lod?: 'lo'|'hi', width?: number, radius?: number, maxAltitude?: number}} opts
   *   'lo' is drawn zoomed out; 'hi' replaces it below HI_RES_ALTITUDE and is
   *   split into tiles so off-screen parts are frustum-culled. maxAltitude hides
   *   the layer entirely above that camera altitude (e.g. counties).
   */
  setLines(name, buf, { lod = 'lo', width = 1, radius = 1.0006, maxAltitude = Infinity, order = 2 } = {}) {
    let layer = this.lineLayers[name];
    if (!layer) {
      const material = new LineMaterial({ color: 0xffffff, linewidth: width, transparent: true, depthWrite: false });
      const pr = this.renderer.getPixelRatio();
      material.resolution.set(this.width * pr, this.height * pr);
      layer = this.lineLayers[name] = { material, lo: null, hi: null, visible: true, maxAltitude, radius };
    }
    const group = new THREE.Group();
    for (const positions of segmentTiles(buf, radius, lod === 'hi' ? TILE_DEG : 0)) {
      const geom = new LineSegmentsGeometry();
      geom.setPositions(positions);
      const obj = new LineSegments2(geom, layer.material);
      obj.renderOrder = order;
      group.add(obj);
    }
    if (layer[lod]) {
      this.scene.remove(layer[lod]);
      layer[lod].children.forEach((c) => c.geometry.dispose());
    }
    layer[lod] = group;
    this.scene.add(group);
    this.#applyLod();
  }

  setLineStyle(name, { color, opacity, visible }) {
    this.ext?.lineStyle(name, { color, opacity, visible });
    const l = this.lineLayers[name];
    if (!l) return;
    if (color !== undefined) l.material.color.set(color);
    if (opacity !== undefined) l.material.opacity = opacity;
    if (visible !== undefined) l.visible = visible;
    this.#applyLod();
  }

  /** Called once when the camera first gets close enough to want the detailed lines. */
  onNeedHiRes(fn) {
    this.hiResRequest = fn;
  }

  #applyLod() {
    const alt = this.altitude;
    const close = alt < HI_RES_ALTITUDE;
    // An attached map (MapLibre) draws its own lines: don't load the detailed ones here too.
    if (!this.ext && alt < HI_RES_ALTITUDE * 1.4 && this.hiResRequest) {
      const fn = this.hiResRequest;
      this.hiResRequest = null;
      fn();
    }
    let changed = false;
    const show = (obj, v) => {
      if (obj && obj.visible !== v) {
        obj.visible = v;
        changed = true;
      }
    };
    for (const l of Object.values(this.lineLayers)) {
      const on = l.visible && alt < l.maxAltitude;
      const hi = close && !!l.hi;
      show(l.lo, on && !hi);
      show(l.hi, on && hi);
      // Drawn ~4 km up so they clear the sphere's facets from above, but that
      // shows as parallax when looking across the ground: lower them there.
      const scale = this.tiltState ? TILT_LINE_RADIUS / l.radius : 1;
      for (const g of [l.lo, l.hi]) {
        if (g && g.scale.x !== scale) {
          g.scale.setScalar(scale);
          changed = true;
        }
      }
    }
    if (changed) this.dirty = true;
  }

  // ------------------------------------------------------------- geometry helpers
  /** Screen position (CSS px within the globe) of a lat/lon, or null on the far side. */
  project(lat, lon) {
    if (this.ext) return this.ext.project(lat, lon);
    const cam = this.camera;
    cam.updateMatrixWorld();
    const [x, y, z] = toXYZ(lat, lon);
    const c = cam.position;
    const len = c.length();
    if ((x * c.x + y * c.y + z * c.z) / len < 1 / len) return null;
    const v = new THREE.Vector3(x, y, z).project(cam);
    if (v.z > 1 || v.z < -1) return null; // behind the camera (tilted view)
    return [((v.x + 1) / 2) * this.width, ((1 - v.y) / 2) * this.height];
  }

  /** lat/lon under a client pixel, or null if off-globe. */
  pick(clientX, clientY) {
    if (this.ext) return this.ext.pick(clientX, clientY);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    return this.pickNdc(ndc.x, ndc.y);
  }

  pickNdc(x, y) {
    if (this.ext) return this.ext.pick(...this.ext.ndcToClient(x, y));
    const p = this.#hitNdc(x, y);
    return p && toLatLon(p.x, p.y, p.z);
  }

  /** Point on the unit sphere under a client pixel, or null if off-globe. */
  #pickVector(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return this.#hitNdc(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  #hitNdc(x, y) {
    this.raycaster.setFromCamera({ x, y }, this.camera);
    const { origin: o, direction: d } = this.raycaster.ray;
    const b = o.dot(d);
    const c = o.lengthSq() - 1;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    return new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t).normalize();
  }

  /** Current camera altitude above the surface, in globe radii. */
  get altitude() {
    if (this.ext) return this.ext.altitude();
    return this.camera.position.length() - 1;
  }
}

/**
 * Convert a line file into LineSegments position arrays (xyz pairs), grouped
 * into tileDeg x tileDeg tiles (or one group when tileDeg is 0).
 */
function segmentTiles(buf, radius, tileDeg) {
  const n = new Uint32Array(buf, 0, 1)[0];
  const counts = new Uint32Array(buf, 4, n);
  const coords = new Float32Array(buf, 4 + n * 4);
  const cols = tileDeg ? Math.ceil(360 / tileDeg) : 1;
  const tileOf = (lon, lat) =>
    tileDeg ? Math.min(cols - 1, Math.floor((lon + 180) / tileDeg)) + cols * Math.min(Math.ceil(180 / tileDeg) - 1, Math.floor((lat + 90) / tileDeg)) : 0;
  const pieces = (lon0, lat0, lon1, lat1) =>
    Math.max(1, Math.ceil(Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0)) / MAX_STEP_DEG));

  // Pass 1: count segments per tile.
  const tileCounts = new Map();
  let o = 0;
  for (let l = 0; l < n; l++) {
    for (let i = 0; i < counts[l] - 1; i++) {
      const p = (o + i) * 2;
      const lon0 = coords[p], lat0 = coords[p + 1], lon1 = coords[p + 2], lat1 = coords[p + 3];
      if (Math.abs(lon1 - lon0) > 180) continue; // dateline wrap
      const t = tileOf(lon0, lat0);
      tileCounts.set(t, (tileCounts.get(t) ?? 0) + pieces(lon0, lat0, lon1, lat1));
    }
    o += counts[l];
  }
  const arrays = new Map([...tileCounts].map(([t, c]) => [t, { a: new Float32Array(c * 6), w: 0 }]));

  // Pass 2: fill.
  const xyz = (lat, lon, out, k) => {
    const la = lat * D2R;
    const lo = lon * D2R;
    const c = Math.cos(la) * radius;
    out[k] = c * Math.cos(lo);
    out[k + 1] = Math.sin(la) * radius;
    out[k + 2] = -c * Math.sin(lo);
  };
  o = 0;
  for (let l = 0; l < n; l++) {
    for (let i = 0; i < counts[l] - 1; i++) {
      const p = (o + i) * 2;
      const lon0 = coords[p], lat0 = coords[p + 1], lon1 = coords[p + 2], lat1 = coords[p + 3];
      if (Math.abs(lon1 - lon0) > 180) continue;
      const tile = arrays.get(tileOf(lon0, lat0));
      const m = pieces(lon0, lat0, lon1, lat1);
      for (let k = 0; k < m; k++) {
        const t0 = k / m;
        const t1 = (k + 1) / m;
        xyz(lat0 + (lat1 - lat0) * t0, lon0 + (lon1 - lon0) * t0, tile.a, tile.w);
        xyz(lat0 + (lat1 - lat0) * t1, lon0 + (lon1 - lon0) * t1, tile.a, tile.w + 3);
        tile.w += 6;
      }
    }
    o += counts[l];
  }
  return [...arrays.values()].map((t) => t.a);
}
