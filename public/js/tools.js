// Map tools: pick a point (sounding), a box (box sounding) or a line (cross
// section) on the globe with clicks, and draw the picked shape over the map.
// Shortcuts: right-click for a sounding, right-drag for a box sounding.
import { greatCircle } from './profile.js';

const SVG = 'http://www.w3.org/2000/svg';

export class MapTools {
  /**
   * @param {import('./globe/globe.js').Globe} globe
   * @param {HTMLElement} stage element the overlay covers
   * @param {{onPoint, onBox, onLine, onModeChange}} handlers
   */
  constructor(globe, stage, handlers) {
    this.globe = globe;
    this.h = handlers;
    this.mode = null; // 'point' | 'box' | 'line'
    this.anchor = null; // first click of a box or line
    this.hover = null;
    this.enabled = true; // whether the model has soundings (set by the app)
    this.drag = null; // box being right-dragged: {a, b}
    this.shapes = {}; // what stays drawn per panel: {sounding, xsect} -> {kind, a, b?}
    this.lastPick = 0;
    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.id = 'tool-overlay';
    stage.appendChild(this.svg);
    globe.on('frame', (moved) => moved && this.#draw());

    const canvas = globe.renderer.domElement;
    let down = null;
    let right = null; // right button held: {x, y, ll, dragging}
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
      if (e.button !== 2 || !this.enabled) return;
      const ll = globe.pick(e.clientX, e.clientY);
      if (!ll) return;
      right = { x: e.clientX, y: e.clientY, ll, dragging: false };
      try {
        canvas.setPointerCapture(e.pointerId); // keep getting moves if the drag leaves the canvas
      } catch {
        // not an active pointer (synthetic event): fine without capture
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button === 2 && right) {
        const r = right;
        const b = r.dragging ? (globe.pick(e.clientX, e.clientY) ?? this.drag?.b) : null;
        right = null;
        this.drag = null;
        if (this.mode) this.setMode(null);
        if (!r.dragging) this.#point(r.ll);
        else if (b) this.#box(r.ll, b);
        else this.#draw();
        return;
      }
      if (e.button !== 0 || !this.mode || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const ll = globe.pick(e.clientX, e.clientY);
      if (ll) this.#click(ll);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (right && e.buttons & 2) {
        if (!right.dragging && Math.hypot(e.clientX - right.x, e.clientY - right.y) > 6) right.dragging = true;
        const ll = right.dragging && globe.pick(e.clientX, e.clientY);
        if (ll) {
          this.drag = { a: right.ll, b: ll };
          this.#draw();
        }
        return;
      }
      if (!this.mode || !this.anchor) return;
      this.hover = globe.pick(e.clientX, e.clientY);
      this.#draw();
    });
  }

  /** A point sounding at a lat/lon (a long press on touch screens). */
  soundingAt(ll) {
    if (!this.enabled) return;
    if (this.mode) this.setMode(null);
    this.#point(ll);
  }

  /** Start (or cancel, if it's the current one) a tool. */
  toggle(mode) {
    this.setMode(this.mode === mode ? null : mode);
  }

  setMode(mode) {
    this.mode = mode;
    this.anchor = null;
    this.hover = null;
    this.globe.renderer.domElement.classList.toggle('picking', !!mode);
    this.h.onModeChange?.(mode);
    this.#draw();
  }

  /** Forget a panel's drawn shape (the panel was closed). */
  clearShape(panel) {
    delete this.shapes[panel];
    this.#draw();
  }

  /** Redraw a panel's shape (its ends were swapped, say). */
  setShape(panel, shape) {
    this.shapes[panel] = shape;
    this.#draw();
  }

  /** Start a cross section at a point: the next click ends it. */
  startLine(ll) {
    this.setMode('line');
    this.anchor = ll;
    this.lastPick = performance.now();
    this.#draw();
  }

  #click(ll) {
    this.lastPick = performance.now();
    if (this.mode === 'point') {
      this.setMode(null);
      this.#point(ll);
      return;
    }
    if (!this.anchor) {
      this.anchor = ll;
      this.#draw();
      return;
    }
    const a = this.anchor;
    const kind = this.mode;
    this.setMode(null);
    if (kind === 'box') this.#box(a, ll);
    else {
      this.shapes.xsect = { kind, a, b: ll };
      this.#draw();
      this.h.onLine(a, ll);
    }
  }

  #point(ll) {
    this.shapes.sounding = { kind: 'point', a: ll };
    this.#draw();
    this.h.onPoint(ll);
  }

  #box(a, b) {
    this.shapes.sounding = { kind: 'box', a, b };
    this.#draw();
    let w = a.lon;
    let e = b.lon;
    if (e < w) [w, e] = [e, w];
    if (e - w > 180) [w, e] = [e, w + 360]; // the short way round, across the dateline
    this.h.onBox({ south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat), west: w, east: e });
  }

  #draw() {
    const svg = this.svg;
    svg.setAttribute('width', this.globe.width);
    svg.setAttribute('height', this.globe.height);
    svg.replaceChildren();
    const live = this.drag
      ? { kind: 'box', ...this.drag }
      : this.anchor && this.hover ? { kind: this.mode, a: this.anchor, b: this.hover } : this.anchor ? { kind: 'point', a: this.anchor } : null;
    // While a new box is dragged out, the old sounding shape gives way to it.
    for (const s of [this.drag ? null : this.shapes.sounding, this.shapes.xsect, live]) {
      if (!s) continue;
      if (s.kind === 'point') this.#marker(s.a);
      else if (s.kind === 'box') this.#path(boxOutline(s.a, s.b), true);
      else {
        this.#path(greatCircle(s.a, s.b, 64), false);
        this.#marker(s.a, 'A');
        this.#marker(s.b, 'B');
      }
    }
  }

  #path(points, closed) {
    let d = '';
    let pen = false;
    for (const p of points) {
      const xy = this.globe.project(p.lat, p.lon);
      if (!xy) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${xy[0].toFixed(1)},${xy[1].toFixed(1)}`;
      pen = true;
    }
    if (!d) return;
    if (closed) d += 'Z';
    for (const [cls, w] of [['halo', 4], ['line', 2]]) {
      const el = document.createElementNS(SVG, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', cls);
      el.setAttribute('stroke-width', w);
      this.svg.appendChild(el);
    }
  }

  #marker(ll, label) {
    const xy = this.globe.project(ll.lat, ll.lon);
    if (!xy) return;
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('cx', xy[0]);
    c.setAttribute('cy', xy[1]);
    c.setAttribute('r', 5);
    c.setAttribute('class', 'dot');
    this.svg.appendChild(c);
    if (label) {
      const t = document.createElementNS(SVG, 'text');
      t.setAttribute('x', xy[0] + 8);
      t.setAttribute('y', xy[1] - 8);
      t.textContent = label;
      this.svg.appendChild(t);
    }
  }
}

/** Outline of a lat/lon box through corners a and b, sampled so it curves with the globe. */
function boxOutline(a, b) {
  const s = Math.min(a.lat, b.lat);
  const n = Math.max(a.lat, b.lat);
  let w = Math.min(a.lon, b.lon);
  let e = Math.max(a.lon, b.lon);
  if (e - w > 180) [w, e] = [e, w + 360];
  const pts = [];
  const k = 24;
  for (let i = 0; i <= k; i++) pts.push({ lat: s, lon: w + ((e - w) * i) / k });
  for (let i = 0; i <= k; i++) pts.push({ lat: s + ((n - s) * i) / k, lon: e });
  for (let i = 0; i <= k; i++) pts.push({ lat: n, lon: e - ((e - w) * i) / k });
  for (let i = 0; i <= k; i++) pts.push({ lat: n - ((n - s) * i) / k, lon: w });
  return pts;
}
