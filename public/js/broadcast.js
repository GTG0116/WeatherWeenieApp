// Broadcast mode: a TV-style graphic over the map, with the station logo, the
// product on screen in big type, the valid/scan time (local or UTC) and a
// compact colour key. Colours, logo, tagline and size are all adjustable, and
// the app's own controls can be hidden for a clean picture.

export const BROADCAST_THEMES = {
  navy: { name: 'Navy', primary: '#0b1a4f', title: '#0b1a4f', titleBg: '#f6f7f9', boxText: '#ffffff' },
  red: { name: 'Storm red', primary: '#8f1111', title: '#8f1111', titleBg: '#f6f7f9', boxText: '#ffffff' },
  emerald: { name: 'Emerald', primary: '#0b4d3b', title: '#0b4d3b', titleBg: '#f3f8f5', boxText: '#ffffff' },
  purple: { name: 'Royal', primary: '#3d1468', title: '#3d1468', titleBg: '#f7f5fb', boxText: '#ffffff' },
  night: { name: 'Night', primary: '#111827', title: '#ffffff', titleBg: '#1f2a3d', boxText: '#ffffff' },
  sky: { name: 'Sky', primary: '#0369a1', title: '#0c2d48', titleBg: '#eaf5fc', boxText: '#ffffff' },
  sunset: { name: 'Sunset', primary: '#c2410c', title: '#7c2d12', titleBg: '#fff7ed', boxText: '#ffffff' },
};

export const COLOR_FIELDS = [
  ['primary', 'Boxes'],
  ['boxText', 'Box text'],
  ['title', 'Title text'],
  ['titleBg', 'Title band'],
];

export const DEFAULT_BROADCAST = {
  on: false,
  timeMode: 'local', // 'local' | 'utc'
  theme: 'navy',
  colors: { ...BROADCAST_THEMES.navy },
  tagline: '',
  logo: null, // data URL of an uploaded logo (null = the bundled one)
  hideUi: false, // clean screen: hide the app's panel, headline, legend and map buttons
  hideTimeline: false,
  scale: 1,
  showLegend: true,
  showDate: true, // the date next to the weekday
};

export function broadcastSettings(saved) {
  const s = { ...DEFAULT_BROADCAST, ...saved, colors: { ...DEFAULT_BROADCAST.colors, ...saved?.colors } };
  delete s.colors.logoBg; // the logo card now takes the main colour
  return s;
}

const DEFAULT_LOGO = 'img/broadcast-logo.webp';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class Broadcast {
  /**
   * @param {object} settings see DEFAULT_BROADCAST (persisted by the app)
   * @param {Function} onSettings called after a settings change
   */
  /**
   * @param {Function} [outputSize] () => {w, h} of the picture the map stands for (the
   *   size picked in Settings › Size), or null when the map is the whole window
   */
  constructor(settings, onSettings, outputSize) {
    this.settings = settings;
    this.onSettings = onSettings;
    this.outputSize = outputSize;
    this.info = { product: '', sub: '', time: null, legend: null };
    this.el = document.createElement('div');
    this.el.id = 'broadcast';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="bc-logo"><img alt="" /><span class="bc-tagline"></span></div>
      <div class="bc-title"><span class="bc-product"></span><span class="bc-sub"></span></div>
      <div class="bc-time"></div>
      <div class="bc-legend"></div>`;
    // Part of the map: it moves and sizes with the map frame (frame.js).
    document.getElementById('stage').appendChild(this.el);
    this.exitBtn = document.createElement('button');
    this.exitBtn.id = 'broadcast-exit';
    this.exitBtn.textContent = 'Exit broadcast';
    this.exitBtn.addEventListener('click', () => this.setOn(false));
    document.body.appendChild(this.exitBtn);
    // The exit button shows while the mouse moves in a clean screen.
    let t = 0;
    window.addEventListener('pointermove', () => {
      if (!document.body.classList.contains('broadcast-clean')) return;
      this.exitBtn.classList.add('show');
      clearTimeout(t);
      t = setTimeout(() => this.exitBtn.classList.remove('show'), 2200);
    });
    window.addEventListener('resize', () => this.#fit());
    this.apply();
  }

  setOn(on) {
    this.settings.on = on;
    this.onSettings?.();
    this.apply();
    this.renderPanel();
  }

  /** Product name, time and colour key for what's on screen. */
  update(info) {
    Object.assign(this.info, info);
    if (this.settings.on) this.#render();
  }

  apply() {
    const s = this.settings;
    const b = document.body.classList;
    b.toggle('broadcast', s.on);
    b.toggle('broadcast-clean', s.on && s.hideUi);
    b.toggle('broadcast-no-timeline', s.on && s.hideTimeline);
    this.el.hidden = !s.on;
    this.onApply?.();
    const st = this.el.style;
    for (const [k] of COLOR_FIELDS) st.setProperty(`--bc-${k}`, s.colors[k]);
    this.el.querySelector('.bc-logo img').src = s.logo || DEFAULT_LOGO;
    const tag = this.el.querySelector('.bc-tagline');
    tag.textContent = s.tagline;
    tag.hidden = !s.tagline;
    if (s.on) this.#render();
  }

  #fmtTime(t) {
    if (!t) return '—';
    const d = new Date(t);
    const opts = this.settings.showDate ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'short' };
    if (this.settings.timeMode === 'utc') {
      const day = d.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' }).replace(',', '').toUpperCase();
      return `${day} ${d.toISOString().slice(11, 16)} <small>UTC</small>`;
    }
    const day = d.toLocaleDateString('en-US', opts).replace(',', '').toUpperCase();
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)/, (m, ap) => ` ${ap.toLowerCase()}`);
    return `${day} ${time}`;
  }

  #render() {
    const i = this.info;
    this.el.querySelector('.bc-product').textContent = i.product || '';
    const sub = this.el.querySelector('.bc-sub');
    sub.textContent = i.sub || '';
    sub.hidden = !i.sub;
    this.el.querySelector('.bc-time').innerHTML = this.#fmtTime(i.time);
    const lg = this.el.querySelector('.bc-legend');
    const L = this.settings.showLegend ? i.legend : null;
    lg.hidden = !L;
    if (L) {
      lg.innerHTML = L.segments
        .map(
          (seg) => `<div class="bc-seg${seg.ticks ? ' wide' : ''}">
            <i style="background:${seg.gradient}" data-gradient="${esc(seg.gradient)}"></i>
            ${seg.ticks ? `<div class="bc-ticks">${seg.ticks.map((t) => `<span style="left:${(t.pos * 100).toFixed(1)}%">${esc(t.label)}</span>`).join('')}</div>` : `<b>${esc(seg.label)}</b>`}
          </div>`,
        )
        .join('') + (L.unit ? `<div class="bc-unit">${esc(L.unit)}</div>` : '');
    }
    this.#fit();
  }

  refit() {
    this.#fit();
  }

  /**
   * Scale the whole graphic to the map: it's designed for a 1920 × 1080 picture,
   * so at 100% it takes the same share of an Instagram post, a story or a
   * YouTube frame (fewer pixels on a smaller picture), however big the map
   * shows on screen. It's shrunk further only if it wouldn't fit.
   */
  #fit() {
    if (this.el.hidden) return;
    this.fitTitle();
    this.el.style.setProperty('--bc-scale', 1);
    const stage = this.el.parentElement;
    const cssW = stage?.clientWidth || window.innerWidth;
    const cssH = stage?.clientHeight || window.innerHeight;
    const out = this.outputSize?.() ?? { w: cssW, h: cssH };
    const design = Math.min(out.w / 1920, out.h / 1080); // picture px per design px
    const unit = design * (cssW / out.w); // CSS px per design px
    const inset = Math.max(6, Math.round(30 * unit));
    this.el.style.setProperty('--bc-inset', `${inset}px`);
    const natural = this.el.scrollWidth;
    const room = cssW - this.el.offsetLeft - inset;
    const k = Math.min(this.settings.scale * unit, room / Math.max(1, natural));
    this.el.style.setProperty('--bc-scale', k.toFixed(4));
  }

  /** Very long product names get a smaller title instead of a giant band. */
  fitTitle() {
    const span = this.el.querySelector('.bc-product');
    span.style.fontSize = '';
    const max = 900;
    if (span.offsetWidth > max) span.style.fontSize = `${Math.max(36, Math.floor(76 * (max / span.offsetWidth)))}px`;
  }

  // ------------------------------------------------------------- panel
  bindPanel(el) {
    this.panelEl = el;
    this.renderPanel();
  }

  renderPanel() {
    const el = this.panelEl;
    if (!el) return;
    const s = this.settings;
    el.innerHTML = `
      <div class="toggle${s.on ? ' on' : ''}" data-act="on"><span>Broadcast mode<span class="sub">TV-style graphic over the map</span></span><span class="switch"></span></div>
      <div class="segmented" data-act="time">
        <button data-v="local" class="${s.timeMode === 'local' ? 'active' : ''}">Local time</button>
        <button data-v="utc" class="${s.timeMode === 'utc' ? 'active' : ''}">UTC</button>
      </div>
      <div class="bc-themes">${Object.entries(BROADCAST_THEMES)
        .map(([id, t]) => `<button class="bc-theme${s.theme === id ? ' active' : ''}" data-theme="${id}" title="${t.name}" style="--a:${t.primary};--b:${t.titleBg}"></button>`)
        .join('')}</div>
      <div class="bc-colors">${COLOR_FIELDS.map(([k, label]) => `<label><input type="color" data-color="${k}" value="${s.colors[k]}" />${label}</label>`).join('')}</div>
      <label class="field-row"><span>Tagline</span><input type="text" data-act="tagline" maxlength="60" placeholder="Next to the logo (optional)" value="${esc(s.tagline)}" /></label>
      <div class="ctable">
        <span>${s.logo ? 'Custom logo' : 'Default logo'}</span>
        <button class="mini-btn" data-act="logo">Upload…</button>
        ${s.logo ? '<button class="mini-btn" data-act="logo-reset">Reset</button>' : ''}
      </div>
      <input type="file" accept="image/*" data-act="logo-file" hidden />
      <label class="slider-row"><span>Size <span class="sub-inline">· follows the map size</span></span><output>${Math.round(s.scale * 100)}%</output><input type="range" min="0.4" max="1.4" step="0.05" value="${s.scale}" data-act="scale" /></label>
      <div class="toggle${s.showDate ? ' on' : ''}" data-act="showDate"><span>Date with the weekday<span class="sub">e.g. THU NOV 5 8:53 pm</span></span><span class="switch"></span></div>
      <div class="toggle${s.showLegend ? ' on' : ''}" data-act="showLegend"><span>Colour key</span><span class="switch"></span></div>
      <div class="toggle${s.hideUi ? ' on' : ''}" data-act="hideUi"><span>Clean screen<span class="sub">Off: the app's controls stay usable. On: hidden (Esc or move the mouse to exit)</span></span><span class="switch"></span></div>
      <div class="toggle${s.hideTimeline ? ' on' : ''}" data-act="hideTimeline"><span>Hide timeline<span class="sub">Space and ←/→ still play and step</span></span><span class="switch"></span></div>`;
    const save = () => {
      this.onSettings?.();
      this.apply();
    };
    el.querySelectorAll('.toggle[data-act]').forEach((t) =>
      t.addEventListener('click', () => {
        const k = t.dataset.act;
        if (k === 'on') return this.setOn(!s.on);
        s[k] = !s[k];
        save();
        this.renderPanel();
      }),
    );
    el.querySelectorAll('[data-act="time"] button').forEach((b) =>
      b.addEventListener('click', () => {
        s.timeMode = b.dataset.v;
        save();
        this.onTimeMode?.();
        this.renderPanel();
      }),
    );
    el.querySelectorAll('.bc-theme').forEach((b) =>
      b.addEventListener('click', () => {
        s.theme = b.dataset.theme;
        const { name, ...colors } = BROADCAST_THEMES[s.theme];
        s.colors = colors;
        save();
        this.renderPanel();
      }),
    );
    el.querySelectorAll('[data-color]').forEach((inp) =>
      inp.addEventListener('input', () => {
        s.colors[inp.dataset.color] = inp.value;
        s.theme = 'custom';
        el.querySelectorAll('.bc-theme').forEach((b) => b.classList.remove('active'));
        save();
      }),
    );
    const tag = el.querySelector('[data-act="tagline"]');
    tag.addEventListener('input', () => {
      s.tagline = tag.value;
      save();
    });
    const file = el.querySelector('[data-act="logo-file"]');
    el.querySelector('[data-act="logo"]').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      // Kept small enough for localStorage.
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 360 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        s.logo = c.toDataURL('image/png');
        URL.revokeObjectURL(img.src);
        save();
        this.renderPanel();
      };
      img.src = URL.createObjectURL(f);
    });
    el.querySelector('[data-act="logo-reset"]')?.addEventListener('click', () => {
      s.logo = null;
      save();
      this.renderPanel();
    });
    const scale = el.querySelector('[data-act="scale"]');
    scale.addEventListener('input', () => {
      s.scale = Number(scale.value);
      scale.previousElementSibling.textContent = `${Math.round(s.scale * 100)}%`;
      save();
    });
  }
}
