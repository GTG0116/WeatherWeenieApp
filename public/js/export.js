// Save the map as an image, or record a loop of frames as an MP4 (WebCodecs
// H.264, muxed with mp4-muxer) or GIF (gifenc). Exports use the map size
// picked in Settings > Size (or the window at screen resolution), and look like
// the screen: the map is drawn again at a higher pixel ratio, then the town and
// value labels, the broadcast graphic and (without broadcast mode) the title
// and legend are painted on top from their on-screen layout.

const MP4_MUXER = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm';
const GIFENC = 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm';
const FPS = 30;
const AVC_CODECS = ['avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'avc1.640028', 'avc1.42e01f'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const raf = () => new Promise((r) => requestAnimationFrame(r));

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30e3);
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// ------------------------------------------------------------------ DOM -> canvas
/** First shadow of a CSS box-shadow / text-shadow list: {color, x, y, blur} or null. */
function parseShadow(v) {
  if (!v || v === 'none') return null;
  const first = v.split(/,(?![^(]*\))/)[0].trim();
  if (/inset/.test(first)) return null;
  const color = first.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i)?.[0] ?? 'rgba(0,0,0,0.5)';
  const nums = first.replace(color, '').match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
  return { color, x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0 };
}

const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);

/** Paints elements onto a canvas from their on-screen boxes and computed styles. */
class Painter {
  constructor(ctx, origin, k) {
    this.ctx = ctx;
    this.origin = origin; // CSS px point that lands at canvas 0,0
    this.k = k; // canvas px per CSS px
  }

  box(r) {
    const { origin: o, k } = this;
    return { x: (r.left - o.left) * k, y: (r.top - o.top) * k, w: r.width * k, h: r.height * k };
  }

  shadow(s, scale) {
    const ctx = this.ctx;
    if (!s) {
      ctx.shadowColor = 'transparent';
      return;
    }
    ctx.shadowColor = s.color;
    ctx.shadowOffsetX = s.x * scale * this.k;
    ctx.shadowOffsetY = s.y * scale * this.k;
    ctx.shadowBlur = s.blur * scale * this.k;
  }

  element(el, alpha = 1) {
    if (el.hidden) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    alpha *= Number(cs.opacity);
    if (alpha <= 0.01) return;
    const r = el.getBoundingClientRect();
    const scale = el.offsetWidth ? r.width / el.offsetWidth : 1; // CSS transforms (the broadcast graphic's scale)
    const b = this.box(r);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    const radius = Math.min(b.h / 2, (parseFloat(cs.borderTopLeftRadius) || 0) * scale * this.k);
    const grad = el.dataset?.gradient ?? (cs.backgroundImage.startsWith('linear-gradient') ? cs.backgroundImage : null);
    const fillBox = (style) => {
      ctx.fillStyle = style;
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, radius);
      ctx.fill();
    };
    if (!transparent(cs.backgroundColor) || grad) this.shadow(parseShadow(cs.boxShadow), scale);
    if (!transparent(cs.backgroundColor)) fillBox(cs.backgroundColor);
    if (grad) {
      const colors = grad.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/gi) ?? [];
      if (colors.length > 1) {
        const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
        colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c));
        this.shadow(null);
        fillBox(g);
      }
    }
    this.shadow(null);
    if (el.tagName === 'IMG' && el.complete && el.naturalWidth) {
      // object-fit: contain, centred
      const ar = el.naturalWidth / el.naturalHeight;
      let w = b.w;
      let h = w / ar;
      if (h > b.h) {
        h = b.h;
        w = h * ar;
      }
      ctx.drawImage(el, b.x + (b.w - w) / 2, b.y + (b.h - h) / 2, w, h);
    } else if (el.tagName === 'CANVAS') {
      ctx.drawImage(el, b.x, b.y, b.w, b.h);
    }
    this.borders(cs, b, radius, scale);
    // The city dot is a ::after pseudo-element.
    if (el.classList.contains('city')) {
      ctx.beginPath();
      ctx.arc(b.x + b.w / 2, b.y + b.h - 2.5 * this.k, 2.5 * this.k, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 1.5 * this.k;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    // Rounded boxes that clip their content (the alert popup's coloured header).
    const clip = cs.overflow === 'hidden' && radius > 0;
    if (clip) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, radius);
      ctx.clip();
    }
    for (const n of el.childNodes) {
      if (n.nodeType === 1 && n.tagName === 'svg') this.svg(n, alpha);
      else if (n.nodeType === 1 && n.tagName !== 'INPUT' && !n.classList.contains('ap-close')) this.element(n, alpha);
      else if (n.nodeType === 3 && n.textContent.trim()) this.text(n, cs, scale, alpha);
    }
    if (clip) {
      ctx.restore();
      // the border again, over the clipped children
      this.borders(cs, b, radius, scale);
    }
  }

  /** CSS borders: one rounded stroke when all four match, else each side on its own. */
  borders(cs, b, radius, scale) {
    const ctx = this.ctx;
    const side = (s) => ({ w: parseFloat(cs[`border${s}Width`]) || 0, c: cs[`border${s}Color`], st: cs[`border${s}Style`] });
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map(side);
    const vis = (x) => x.w > 0 && x.st !== 'none' && !transparent(x.c);
    if (!sides.some(vis)) return;
    ctx.save();
    const k = scale * this.k;
    const same = sides.every((x) => x.w === sides[0].w && x.c === sides[0].c && vis(x));
    if (same) {
      const w = sides[0].w * k;
      ctx.strokeStyle = sides[0].c;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.roundRect(b.x + w / 2, b.y + w / 2, b.w - w, b.h - w, Math.max(0, radius - w / 2));
      ctx.stroke();
    } else {
      const [t, r, bo, l] = sides;
      const fill = (x, rx, ry, rw, rh) => {
        if (!vis(x)) return;
        ctx.fillStyle = x.c;
        ctx.fillRect(rx, ry, rw, rh);
      };
      fill(t, b.x, b.y, b.w, t.w * k);
      fill(bo, b.x, b.y + b.h - bo.w * k, b.w, bo.w * k);
      fill(l, b.x, b.y, l.w * k, b.h);
      fill(r, b.x + b.w - r.w * k, b.y, r.w * k, b.h);
    }
    ctx.restore();
  }

  /** Small inline icons: paths and circles, with currentColor and CSS variables resolved. */
  svg(el, alpha) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    const b = this.box(el.getBoundingClientRect());
    const vb = el.viewBox?.baseVal;
    if (!vb || !vb.width || !b.w) return;
    const ctx = this.ctx;
    const sx = b.w / vb.width;
    const sy = b.h / vb.height;
    const paint = (v, node) => {
      if (!v || v === 'none') return null;
      if (v === 'currentColor') return cs.color;
      const m = v.match(/^var\((--[\w-]+)\)$/);
      return m ? getComputedStyle(node).getPropertyValue(m[1]).trim() || null : v;
    };
    ctx.save();
    ctx.globalAlpha = alpha * Number(cs.opacity);
    const f = cs.filter;
    const sh = f && f.startsWith('drop-shadow(') ? parseShadow(f.slice(12, -1)) : null;
    ctx.translate(b.x - vb.x * sx, b.y - vb.y * sy);
    ctx.scale(sx, sy);
    for (const n of el.querySelectorAll('path, circle')) {
      const shape = new Path2D();
      if (n.tagName === 'circle') shape.arc(+n.getAttribute('cx'), +n.getAttribute('cy'), +n.getAttribute('r'), 0, Math.PI * 2);
      else shape.addPath(new Path2D(n.getAttribute('d')));
      const fill = paint(n.getAttribute('fill') ?? (n.tagName === 'circle' ? null : 'black'), n);
      const stroke = paint(n.getAttribute('stroke'), n);
      if (sh) {
        ctx.shadowColor = sh.color;
        ctx.shadowBlur = sh.blur * this.k;
      }
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill(shape);
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = +(n.getAttribute('stroke-width') ?? 1);
        ctx.lineCap = n.getAttribute('stroke-linecap') ?? 'butt';
        ctx.lineJoin = n.getAttribute('stroke-linejoin') ?? 'miter';
        ctx.stroke(shape);
      }
    }
    ctx.restore();
  }

  /** The alert popup's leader: a dark-edged white line ending in an arrowhead. */
  leader(svg) {
    if (!svg || svg.style.display === 'none') return;
    const line = svg.querySelector('line');
    if (!line) return;
    const { origin: o, k } = this;
    const x1 = (+line.getAttribute('x1') - o.left) * k;
    const y1 = (+line.getAttribute('y1') - o.top) * k;
    const x2 = (+line.getAttribute('x2') - o.left) * k;
    const y2 = (+line.getAttribute('y2') - o.top) * k;
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    const ctx = this.ctx;
    const a = Math.atan2(y2 - y1, x2 - x1);
    const head = 11 * k;
    const tip = (scale) => {
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * scale * Math.cos(a - 0.45), y2 - head * scale * Math.sin(a - 0.45));
      ctx.lineTo(x2 - head * scale * Math.cos(a + 0.45), y2 - head * scale * Math.sin(a + 0.45));
      ctx.closePath();
    };
    ctx.save();
    ctx.lineCap = 'round';
    const bx = x2 - head * 0.8 * Math.cos(a);
    const by = y2 - head * 0.8 * Math.sin(a);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 5 * k;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    tip(1.25);
    ctx.fillStyle = '#111';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5 * k;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    tip(1);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
  }

  text(node, cs, scale, alpha) {
    const ctx = this.ctx;
    const range = document.createRange();
    const raw = node.textContent;
    const upper = cs.textTransform === 'uppercase';
    const pieces = [];
    // Measure only the visible characters: a leading space must keep its gap, not shift the text.
    const lead = raw.length - raw.trimStart().length;
    range.setStart(node, lead);
    range.setEnd(node, raw.trimEnd().length);
    const rects = range.getClientRects();
    if (rects.length <= 1) pieces.push([raw.trim(), range.getBoundingClientRect()]);
    else {
      // Wrapped text: word by word.
      const re = /\S+/g;
      let m;
      while ((m = re.exec(raw))) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        pieces.push([m[0], range.getBoundingClientRect()]);
      }
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    const size = parseFloat(cs.fontSize) * scale * this.k;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(parseFloat(cs.letterSpacing) || 0) * scale * this.k}px`;
    ctx.fillStyle = cs.color;
    ctx.textBaseline = 'alphabetic';
    this.shadow(parseShadow(cs.textShadow), scale);
    for (const [t, r] of pieces) {
      if (!t || !r.width) continue;
      const s = upper ? t.toUpperCase() : t;
      const b = this.box(r);
      const m = ctx.measureText(s);
      const asc = m.fontBoundingBoxAscent ?? size * 0.8;
      const desc = m.fontBoundingBoxDescent ?? size * 0.2;
      ctx.fillText(s, b.x, b.y + (b.h - (asc + desc)) / 2 + asc);
    }
    ctx.restore();
  }
}

// ------------------------------------------------------------------ exporter
export class Exporter {
  /**
   * @param {object} o
   * @param {import('./globe/globe.js').Globe} o.globe
   * @param {Function} o.frameSize () => {w, h} | null (null: the window, at screen resolution)
   * @param {Function} o.frames () => [{label, sub}] timeline frames
   * @param {Function} o.current () => index on screen
   * @param {Function} o.showFrame async (i) => resolves once frame i is drawn
   * @param {Function} o.fileBase () => file name stem
   * @param {Function} o.broadcastOn () => boolean
   * @param {Function} o.setPlaying (on) => void
   * @param {Function} o.setStatus (text, kind) => void
   * @param {Function} o.isRadar () => boolean
   */
  constructor(o) {
    Object.assign(this, o);
    this.opts = { format: 'mp4', frameMs: 250, pauseMs: 1500, scale: 1, chrome: true };
    this.selected = null;
    this.#buildDialog();
  }

  /** Output size: the picked map size, or the map at screen resolution. */
  size(scale = 1) {
    const stage = document.getElementById('stage').getBoundingClientRect();
    const fs = this.frameSize();
    let k = fs ? fs.w / stage.width : Math.min(window.devicePixelRatio || 1, 2);
    k *= scale;
    const even = (v) => Math.max(2, Math.round(v / 2) * 2); // H.264 wants even sizes
    return { w: even(stage.width * k), h: even(stage.height * k), k, stage };
  }

  /** Draw the map and its overlays into a w × h canvas (between beginCapture and endCapture). */
  async #capture(w, h, k, stage, into) {
    const canvas = into ?? document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: this.opts.format === 'gif' });
    ctx.fillStyle = getComputedStyle(document.getElementById('stage')).backgroundColor || '#04070c';
    ctx.fillRect(0, 0, w, h);
    const map = await this.globe.snapshot();
    ctx.drawImage(map, 0, 0, w, h); // straight away: the WebGL canvas only holds this frame for now
    const kx = w / stage.width;
    const p = new Painter(ctx, stage, kx);
    for (const el of document.querySelectorAll('#labels .lbl:not(.hidden)')) p.element(el);
    // An open alert popup, with its arrow to the spot.
    const pop = document.getElementById('alert-popup');
    if (pop && !pop.hidden && pop.style.visibility !== 'hidden') {
      p.leader(document.getElementById('alert-leader'));
      p.element(pop);
    }
    if (this.broadcastOn()) {
      const bc = document.getElementById('broadcast');
      if (bc && !bc.hidden) p.element(bc);
    } else if (this.opts.chrome) {
      // Without broadcast mode: the title and legend, placed inside the picture.
      const head = document.getElementById('headline');
      const legend = document.getElementById('legend');
      if (head && getComputedStyle(head).display !== 'none' && head.offsetWidth) {
        const r = head.getBoundingClientRect();
        new Painter(ctx, { left: r.left - (stage.width - r.width) / 2, top: r.top - 10 }, kx).element(head);
      }
      if (legend && legend.offsetWidth && legend.children.length) {
        const r = legend.getBoundingClientRect();
        new Painter(ctx, { left: r.left - (stage.width - r.width - 12), top: r.top - (stage.height - r.height - 12) }, kx).element(legend);
      }
    }
    return canvas;
  }

  async saveImage() {
    if (this.busy) return;
    this.busy = true;
    const { w, h, k, stage } = this.size();
    this.setStatus('Saving image…');
    try {
      await document.fonts.ready;
      this.globe.beginCapture(k);
      await raf();
      const canvas = await this.#capture(w, h, k, stage);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const name = `${this.fileBase()}-${stamp()}.png`;
      download(blob, name);
      this.setStatus(`Saved ${name} · ${w}×${h}`, 'done');
    } catch (err) {
      this.setStatus(`Couldn't save the image: ${err.message}`, 'error');
    } finally {
      this.globe.endCapture();
      this.busy = false;
    }
  }

  // ------------------------------------------------------------- video dialog
  #buildDialog() {
    const el = document.createElement('div');
    el.id = 'export-dialog';
    el.hidden = true;
    el.innerHTML = '<div class="ex-card" role="dialog" aria-label="Record video"></div>';
    el.addEventListener('pointerdown', (e) => {
      if (e.target === el && !this.recording) this.closeVideo();
    });
    document.body.appendChild(el);
    this.dialog = el;
  }

  get isOpen() {
    return !this.dialog.hidden;
  }

  openVideo() {
    const frames = this.frames();
    if (!frames.length) {
      this.setStatus('Nothing to record yet: no frames loaded', 'error');
      return;
    }
    // Default: the latest 24 scans of a radar loop, or 16 steps from the one on screen.
    const key = `${this.isRadar()}:${frames.length}:${frames[0]?.label}`;
    if (!this.selected || this.selectedKey !== key) {
      this.selectedKey = key;
      const cur = this.current();
      this.selected = new Set();
      if (this.isRadar()) for (let i = Math.max(0, frames.length - 24); i < frames.length; i++) this.selected.add(i);
      else for (let i = cur; i < Math.min(frames.length, cur + 16); i++) this.selected.add(i);
      this.opts.frameMs = this.isRadar() ? 200 : 500;
    }
    this.dialog.hidden = false;
    this.#render();
  }

  closeVideo() {
    if (this.recording) return;
    this.dialog.hidden = true;
  }

  #mp4Supported() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  }

  #render(progress) {
    const card = this.dialog.querySelector('.ex-card');
    const frames = this.frames();
    const o = this.opts;
    if (o.format === 'mp4' && !this.#mp4Supported()) o.format = 'gif';
    const { w, h } = this.size(o.scale);
    const n = this.selected.size;
    const seconds = n ? (n * o.frameMs + o.pauseMs) / 1000 : 0;
    const fs = this.frameSize();
    card.innerHTML = `
      <div class="ex-head"><span>Record video</span><button class="icon-btn ex-close" aria-label="Close"${this.recording ? ' disabled' : ''}>
        <svg viewBox="0 0 20 20"><path d="m5.5 5.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>
      <div class="ex-body">
        <div class="ex-row"><span>Size</span><b>${w} × ${h}</b><span class="hint">${fs ? 'from Settings › Size' : 'the map at screen resolution · pick a size in Settings › Size'}</span></div>
        <div class="ex-row"><span>Format</span>
          <div class="segmented ex-format">
            <button data-f="mp4" class="${o.format === 'mp4' ? 'active' : ''}"${this.#mp4Supported() ? '' : ' disabled title="This browser can\'t encode H.264 video (WebCodecs): try Chrome, Edge or Safari"'}>MP4</button>
            <button data-f="gif" class="${o.format === 'gif' ? 'active' : ''}">GIF</button>
          </div></div>
        <div class="ex-row"><span>Scale</span>
          <div class="segmented ex-scale">${[1, 0.75, 0.5].map((s) => `<button data-s="${s}" class="${o.scale === s ? 'active' : ''}">${s * 100}%</button>`).join('')}</div></div>
        <label class="slider-row"><span>Each frame</span><output>${o.frameMs} ms</output><input type="range" min="50" max="2000" step="50" value="${o.frameMs}" data-k="frameMs" /></label>
        <label class="slider-row"><span>Pause on the last frame</span><output>${(o.pauseMs / 1000).toFixed(1)} s</output><input type="range" min="0" max="6000" step="250" value="${o.pauseMs}" data-k="pauseMs" /></label>
        ${this.broadcastOn() ? '' : `<div class="toggle${o.chrome ? ' on' : ''}" data-k="chrome"><span>Title &amp; legend in the picture<span class="sub">Broadcast mode draws its own graphic instead</span></span><span class="switch"></span></div>`}
        <div class="ex-frames-head"><span>Frames <b>${n}</b> of ${frames.length}</span>
          <span class="ex-quick">
            <button class="mini-btn" data-q="all">All</button><button class="mini-btn" data-q="none">None</button>
            <button class="mini-btn" data-q="2">Every 2nd</button><button class="mini-btn" data-q="3">Every 3rd</button>
            ${this.isRadar() ? '<button class="mini-btn" data-q="last12">Last 12</button><button class="mini-btn" data-q="last24">Last 24</button>' : '<button class="mini-btn" data-q="next24">Next 24 from here</button>'}
          </span></div>
        <div class="ex-frames">${frames
          .map((f, i) => `<button class="ex-frame${this.selected.has(i) ? ' on' : ''}${i === this.current() ? ' cur' : ''}" data-i="${i}" title="${esc(f.sub ?? '')}">${esc(f.label)}</button>`)
          .join('')}</div>
        <div class="hint-row">Click frames to add or drop them; shift-click picks a range.</div>
      </div>
      <div class="ex-foot">
        <span class="ex-info">${progress ?? (n ? `${n} frames · ${seconds.toFixed(1)} s ${o.format === 'gif' ? 'GIF' : 'MP4'}` : 'Pick some frames')}</span>
        ${this.recording ? '<button class="mini-btn ex-cancel">Cancel</button>' : `<button class="ex-go"${n ? '' : ' disabled'}>Record</button>`}
      </div>
      ${this.recording ? `<div class="ex-progress"><i style="width:${(this.progress ?? 0) * 100}%"></i></div>` : ''}`;
    card.querySelector('.ex-close').onclick = () => this.closeVideo();
    card.querySelector('.ex-cancel')?.addEventListener('click', () => (this.cancelled = true));
    card.querySelector('.ex-go')?.addEventListener('click', () => this.record());
    if (this.recording) return;
    card.querySelectorAll('.ex-format [data-f]').forEach((b) =>
      b.addEventListener('click', () => {
        o.format = b.dataset.f;
        this.#render();
      }),
    );
    card.querySelectorAll('.ex-scale [data-s]').forEach((b) =>
      b.addEventListener('click', () => {
        o.scale = Number(b.dataset.s);
        this.#render();
      }),
    );
    card.querySelectorAll('input[type="range"]').forEach((inp) =>
      inp.addEventListener('input', () => {
        o[inp.dataset.k] = Number(inp.value);
        inp.previousElementSibling.textContent = inp.dataset.k === 'pauseMs' ? `${(o.pauseMs / 1000).toFixed(1)} s` : `${o.frameMs} ms`;
        const nn = this.selected.size;
        card.querySelector('.ex-info').textContent = nn ? `${nn} frames · ${((nn * o.frameMs + o.pauseMs) / 1000).toFixed(1)} s ${o.format === 'gif' ? 'GIF' : 'MP4'}` : 'Pick some frames';
      }),
    );
    card.querySelector('.toggle[data-k="chrome"]')?.addEventListener('click', () => {
      o.chrome = !o.chrome;
      this.#render();
    });
    card.querySelectorAll('[data-q]').forEach((b) =>
      b.addEventListener('click', () => {
        const q = b.dataset.q;
        const all = frames.map((_, i) => i);
        const sel = [...this.selected].sort((a, c) => a - c);
        if (q === 'all') this.selected = new Set(all);
        else if (q === 'none') this.selected = new Set();
        else if (q === '2' || q === '3') {
          const base = sel.length ? sel : all;
          this.selected = new Set(base.filter((_, j) => j % Number(q) === 0 || j === base.length - 1));
        } else if (q === 'last12' || q === 'last24') this.selected = new Set(all.slice(-Number(q.slice(4))));
        else if (q === 'next24') this.selected = new Set(all.slice(this.current(), this.current() + 24));
        this.#render();
      }),
    );
    card.querySelectorAll('.ex-frame').forEach((b) =>
      b.addEventListener('click', (e) => {
        const i = Number(b.dataset.i);
        if (e.shiftKey && this.lastClicked != null) {
          const on = !this.selected.has(i) || this.selected.has(this.lastClicked);
          for (let j = Math.min(i, this.lastClicked); j <= Math.max(i, this.lastClicked); j++) on ? this.selected.add(j) : this.selected.delete(j);
        } else if (this.selected.has(i)) this.selected.delete(i);
        else this.selected.add(i);
        this.lastClicked = i;
        this.#render();
      }),
    );
  }

  // ------------------------------------------------------------- recording
  async #mp4Encoder(w, h) {
    const { Muxer, ArrayBufferTarget } = await import(MP4_MUXER);
    const bitrate = Math.min(25e6, Math.max(2e6, Math.round(w * h * FPS * 0.12)));
    let config = null;
    for (const codec of AVC_CODECS) {
      const c = { codec, width: w, height: h, bitrate, framerate: FPS, avc: { format: 'avc' } };
      try {
        if ((await VideoEncoder.isConfigSupported(c)).supported) {
          config = c;
          break;
        }
      } catch {
        // try the next profile
      }
    }
    if (!config) throw new Error(`this browser can't encode ${w}×${h} H.264: try a smaller scale or GIF`);
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h, frameRate: FPS }, fastStart: 'in-memory' });
    let failure = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => (failure = e),
    });
    encoder.configure(config);
    let n = 0;
    return {
      // Constant frame rate (what social sites want): each picture is repeated for its duration.
      async add(canvas, ms) {
        const reps = Math.max(1, Math.round((ms / 1000) * FPS));
        for (let r = 0; r < reps; r++) {
          if (failure) throw failure;
          const frame = new VideoFrame(canvas, { timestamp: Math.round((n * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
          encoder.encode(frame, { keyFrame: n % (FPS * 2) === 0 });
          frame.close();
          n++;
          while (encoder.encodeQueueSize > 20) await new Promise((res) => setTimeout(res, 5));
        }
      },
      async finish() {
        await encoder.flush();
        if (failure) throw failure;
        encoder.close();
        muxer.finalize();
        return new Blob([muxer.target.buffer], { type: 'video/mp4' });
      },
    };
  }

  async #gifEncoder(w, h) {
    const { GIFEncoder, quantize, applyPalette } = await import(GIFENC);
    const gif = GIFEncoder();
    let first = true;
    return {
      async add(canvas, ms) {
        const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
        const palette = quantize(data, 256);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, w, h, { palette, delay: ms, ...(first ? { repeat: 0 } : {}) });
        first = false;
        await new Promise((r) => setTimeout(r, 0)); // let the page breathe between frames
      },
      async finish() {
        gif.finish();
        return new Blob([gif.bytes()], { type: 'image/gif' });
      },
    };
  }

  async record() {
    if (this.recording || this.busy || !this.selected.size) return;
    const o = this.opts;
    const list = [...this.selected].sort((a, b) => a - b);
    const keep = this.current();
    const { w, h, k, stage } = this.size(o.scale);
    this.recording = true;
    this.busy = true;
    this.cancelled = false;
    this.progress = 0;
    this.setPlaying(false);
    this.#render('Starting…');
    let enc = null;
    try {
      await document.fonts.ready;
      enc = o.format === 'mp4' ? await this.#mp4Encoder(w, h) : await this.#gifEncoder(w, h);
      this.globe.beginCapture(k);
      await raf();
      const canvas = document.createElement('canvas');
      for (let j = 0; j < list.length; j++) {
        if (this.cancelled) throw new Error('cancelled');
        this.progress = j / list.length;
        this.#render(`Frame ${j + 1} of ${list.length} · loading`);
        await this.showFrame(list[j]);
        await raf();
        this.#render(`Frame ${j + 1} of ${list.length} · drawing`);
        await this.#capture(w, h, k, stage, canvas);
        await enc.add(canvas, o.frameMs + (j === list.length - 1 ? o.pauseMs : 0));
      }
      this.#render('Finishing…');
      const blob = await enc.finish();
      const name = `${this.fileBase()}-${stamp()}.${o.format}`;
      download(blob, name);
      this.setStatus(`Saved ${name} · ${w}×${h} · ${(blob.size / 1e6).toFixed(1)} MB`, 'done');
      this.recording = false;
      this.#render(`Saved ${name} · ${(blob.size / 1e6).toFixed(1)} MB`);
    } catch (err) {
      this.recording = false;
      const msg = err.message === 'cancelled' ? 'Cancelled' : `Couldn't record: ${err.message}`;
      this.#render(msg);
      if (err.message !== 'cancelled') this.setStatus(msg, 'error');
    } finally {
      this.recording = false;
      this.busy = false;
      this.globe.endCapture();
      await this.showFrame(keep);
    }
  }
}
