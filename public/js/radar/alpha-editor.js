// Volume alpha editor, as in GR2Analyst's volume explorer: a curve of opacity
// against value drawn over the moment's colour bar. Drag across it to draw the
// curve; double-click to reset. The 3D view's isosurface shells (and the
// volumetric cloud's density) take their opacity from it.
const BAR_PX = 10; // colour bar under the plot

export class AlphaEditor {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.canvas
   * @param {HTMLElement} o.title shows the value and opacity under the cursor
   * @param {(alpha: number[]) => void} o.onInput the curve changed (while drawing)
   * @param {() => void} o.onCommit a stroke finished
   * @param {() => void} o.onReset double-click: back to the default curve
   */
  constructor({ canvas, title, onInput, onCommit, onReset }) {
    this.canvas = canvas;
    this.title = title;
    this.onInput = onInput;
    this.onCommit = onCommit;
    this.alpha = [];
    this.opts = null;
    let last = null; // [index, alpha] of the previous point of a stroke
    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height - BAR_PX)));
      return { fx, a: 1 - fy, i: Math.round(fx * (this.alpha.length - 1)) };
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.alpha.length) return;
      try {
        canvas.setPointerCapture(e.pointerId); // keep drawing if the stroke leaves the graph
      } catch {
        // not an active pointer (synthetic event): fine without capture
      }
      const p = at(e);
      last = [p.i, p.a];
      this.#paint(p.i, p.a, p.i, p.a);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.alpha.length) return;
      const p = at(e);
      if (last) {
        this.#paint(last[0], last[1], p.i, p.a);
        last = [p.i, p.a];
      }
      this.#label(p.fx);
    });
    canvas.addEventListener('pointerup', () => {
      if (!last) return;
      last = null;
      this.onCommit();
    });
    canvas.addEventListener('pointerleave', () => !last && this.#label(null));
    canvas.addEventListener('dblclick', () => onReset());
    new ResizeObserver(() => this.#draw()).observe(canvas);
  }

  /**
   * @param {object} o
   * @param {number[]} o.alpha opacity per sample over [vmin, vmax]
   * @param {import('../colormaps.js').Colormap} o.colormap
   * @param {{f: (v: number) => number, label: string}} o.unit display units
   * @param {number} o.threshold canonical units
   * @param {'above'|'below'|'abs'} o.test which side of the threshold is drawn
   */
  set({ alpha, vmin, vmax, colormap, unit, threshold, test, digits }) {
    this.alpha = alpha.slice();
    this.opts = { vmin, vmax, colormap, unit, threshold, test, digits };
    this.#draw();
    this.#label(null);
  }

  /** Set the curve along a straight line from (i0, a0) to (i1, a1). */
  #paint(i0, a0, i1, a1) {
    const n = Math.abs(i1 - i0);
    for (let k = 0; k <= n; k++) {
      const t = n ? k / n : 1;
      const i = Math.round(i0 + (i1 - i0) * t);
      this.alpha[i] = Math.round((a0 + (a1 - a0) * t) * 1000) / 1000;
    }
    this.#draw();
    this.onInput(this.alpha.slice());
  }

  #label(fx) {
    const o = this.opts;
    if (!o || fx === null) {
      this.title.textContent = 'Volume alpha';
      return;
    }
    const v = o.vmin + (o.vmax - o.vmin) * fx;
    const a = this.alpha[Math.round(fx * (this.alpha.length - 1))];
    this.title.textContent = `Volume alpha · [ ${o.unit.f(v).toFixed(o.digits)} ${o.unit.label} ] ${Math.round(a * 100)}%`;
  }

  #draw() {
    const c = this.canvas;
    const o = this.opts;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h || !o) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ph = h - BAR_PX;
    const xOf = (v) => ((v - o.vmin) / (o.vmax - o.vmin)) * w;
    g.fillStyle = '#04070c';
    g.fillRect(0, 0, w, ph);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      g.beginPath();
      g.moveTo(0, Math.round(ph * f) + 0.5);
      g.lineTo(w, Math.round(ph * f) + 0.5);
      g.stroke();
    }
    // Values the threshold leaves out aren't drawn at all: shade them.
    g.fillStyle = 'rgba(255,255,255,0.045)';
    const t = o.threshold;
    if (o.test === 'above') g.fillRect(0, 0, xOf(t), ph);
    else if (o.test === 'below') g.fillRect(xOf(t), 0, w - xOf(t), ph);
    else g.fillRect(xOf(-t), 0, xOf(t) - xOf(-t), ph);
    g.strokeStyle = 'rgba(255, 211, 77, 0.7)';
    g.setLineDash([3, 3]);
    for (const v of o.test === 'abs' ? [-t, t] : [t]) {
      g.beginPath();
      g.moveTo(Math.round(xOf(v)) + 0.5, 0);
      g.lineTo(Math.round(xOf(v)) + 0.5, ph);
      g.stroke();
    }
    g.setLineDash([]);
    // The curve.
    const n = this.alpha.length;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1.5;
    g.beginPath();
    this.alpha.forEach((a, i) => {
      const x = (i / (n - 1)) * w;
      const y = 1 + (1 - a) * (ph - 2);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
    // Colour bar.
    for (let x = 0; x < w; x++) {
      const col = o.colormap.color(o.vmin + ((o.vmax - o.vmin) * (x + 0.5)) / w, 0);
      g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      g.fillRect(x, ph, 1, BAR_PX);
    }
  }
}
