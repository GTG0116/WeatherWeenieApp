// Animated wind particles advected through a u/v field on the globe.
import * as THREE from 'three';
import { toXYZ } from './globe.js';
import { sampleField } from '../data.js';

const TRAIL = 18;
const RADIUS = 1.0015;

export class WindParticles {
  constructor(globe, count = 5000) {
    this.globe = globe;
    this.count = count;
    this.lat = new Float32Array(count);
    this.lon = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.ring = new Float32Array(count * TRAIL * 3);
    this.head = 0;
    this.enabled = false;
    this.field = null;
    this.speedScale = 1;

    const segs = count * (TRAIL - 1);
    const positions = new Float32Array(segs * 2 * 3);
    const alpha = new Float32Array(segs * 2);
    for (let p = 0; p < count; p++) {
      for (let k = 0; k < TRAIL - 1; k++) {
        const s = (p * (TRAIL - 1) + k) * 2;
        alpha[s] = k / (TRAIL - 1);
        alpha[s + 1] = (k + 1) / (TRAIL - 1);
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(positions, 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.1);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0.95 } },
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlpha;
        void main() { gl_FragColor = vec4(uColor, pow(vAlpha, 1.3) * uOpacity); }`,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.LineSegments(this.geometry, this.material);
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    globe.scene.add(this.mesh);

    globe.frameHooks.push((dt) => this.#step(dt));
    globe.on('change', () => (this.viewChanged = true));
  }

  /** @param {number} speedScale multiplier on advection speed (upper-air jets move fast) */
  setField(u, v, meta, speedScale = 1) {
    const first = !this.field;
    this.field = { u, v, meta };
    this.speedScale = speedScale;
    if (first) this.#respawnAll();
  }

  setEnabled(on) {
    this.enabled = on;
    this.mesh.visible = on && !!this.field;
    if (on) this.#respawnAll();
    this.globe.dirty = true;
  }

  clear() {
    this.field = null;
    this.mesh.visible = false;
    this.globe.dirty = true;
  }

  #spawn(p) {
    let ll = null;
    for (let tries = 0; tries < 8 && !ll; tries++) {
      ll = this.globe.pickNdc(Math.random() * 2.2 - 1.1, Math.random() * 2.2 - 1.1);
      // Regional models: spawn inside the domain.
      if (ll && this.field?.meta.regional && !Number.isFinite(sampleField(this.field.u, this.field.meta, ll.lat, ll.lon))) ll = null;
    }
    if (!ll) ll = { lat: Math.asin(Math.random() * 2 - 1) * (180 / Math.PI), lon: Math.random() * 360 - 180 };
    this.lat[p] = ll.lat;
    this.lon[p] = ll.lon;
    this.age[p] = 0;
    this.life[p] = 40 + Math.random() * 90;
    const [x, y, z] = toXYZ(ll.lat, ll.lon, RADIUS);
    for (let k = 0; k < TRAIL; k++) {
      const o = (p * TRAIL + k) * 3;
      this.ring[o] = x;
      this.ring[o + 1] = y;
      this.ring[o + 2] = z;
    }
  }

  #respawnAll() {
    for (let p = 0; p < this.count; p++) {
      this.#spawn(p);
      this.age[p] = Math.random() * this.life[p];
    }
  }

  #step(dt) {
    if (!this.enabled || !this.field) return false;
    this.mesh.visible = true;
    const { u, v, meta } = this.field;
    const cam = this.globe.camera.position;
    const camLen = cam.length();
    const alt = this.globe.altitude;
    // degrees per (m/s) per frame, scaled so on-screen speed is zoom independent
    const k = 0.0055 * this.speedScale * Math.min(1.6, alt) * Math.min(2, dt * 60);
    const minDot = 1 / camLen + 0.02; // cos of the visible cap, with margin
    const head = (this.head + 1) % TRAIL;
    const respawnAll = this.viewChanged && this.globe.flight;
    this.viewChanged = false;

    for (let p = 0; p < this.count; p++) {
      let lat = this.lat[p];
      let lon = this.lon[p];
      const uu = sampleField(u, meta, lat, lon);
      const vv = sampleField(v, meta, lat, lon);
      const cl = Math.max(0.05, Math.cos(lat * (Math.PI / 180)));
      lat += vv * k;
      lon += (uu * k) / cl;
      if (lon > 180) lon -= 360;
      else if (lon < -180) lon += 360;
      this.age[p] += 1;
      const [x, y, z] = toXYZ(lat, lon, RADIUS);
      const facing = (x * cam.x + y * cam.y + z * cam.z) / camLen;
      if (respawnAll || this.age[p] > this.life[p] || lat > 89 || lat < -89 || facing < minDot ||
          !(Math.abs(uu) + Math.abs(vv) > 0.2)) {
        this.#spawn(p);
        continue;
      }
      this.lat[p] = lat;
      this.lon[p] = lon;
      const o = (p * TRAIL + head) * 3;
      this.ring[o] = x;
      this.ring[o + 1] = y;
      this.ring[o + 2] = z;
    }
    this.head = head;

    // Rebuild segments oldest → newest
    const pos = this.positions.array;
    let w = 0;
    for (let p = 0; p < this.count; p++) {
      const base = p * TRAIL;
      for (let s = 0; s < TRAIL - 1; s++) {
        const a = (base + ((head + 1 + s) % TRAIL)) * 3;
        const b = (base + ((head + 2 + s) % TRAIL)) * 3;
        pos[w++] = this.ring[a];
        pos[w++] = this.ring[a + 1];
        pos[w++] = this.ring[a + 2];
        pos[w++] = this.ring[b];
        pos[w++] = this.ring[b + 1];
        pos[w++] = this.ring[b + 2];
      }
    }
    this.positions.needsUpdate = true;
    return true;
  }
}
