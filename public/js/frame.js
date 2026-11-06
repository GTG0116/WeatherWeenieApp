// Map frame: shrink the map (and everything drawn on it: labels, markers,
// the broadcast graphic, alert popups) to a fixed aspect ratio for social media
// posts, fitted into the space between the app's own controls. The sidebar,
// timeline, legend and buttons stay exactly where they are.

export const FRAME_PRESETS = [
  { id: 'full', name: 'Full window' },
  { id: 'x', name: 'X / Twitter post', w: 1600, h: 900 },
  { id: 'ig-square', name: 'Instagram square', w: 1080, h: 1080 },
  { id: 'ig-portrait', name: 'Instagram portrait', w: 1080, h: 1350 },
  { id: 'story', name: 'Story / Reel / TikTok', w: 1080, h: 1920 },
  { id: 'facebook', name: 'Facebook / link preview', w: 1200, h: 630 },
  { id: 'youtube', name: 'YouTube / 16:9 HD', w: 1920, h: 1080 },
  { id: 'classic', name: 'Classic 4:3', w: 1440, h: 1080 },
  { id: 'custom', name: 'Custom size' },
];

export const DEFAULT_FRAME = { preset: 'full', w: 1080, h: 1080, outline: true, res: 2 };

/** Export detail: saved images and videos are this many times the picked size. */
export const EXPORT_DETAIL = [1, 2, 3];

export function exportDetail(s) {
  return EXPORT_DETAIL.includes(Number(s.res)) ? Number(s.res) : DEFAULT_FRAME.res;
}

export function frameSettings(saved) {
  return { ...DEFAULT_FRAME, ...saved };
}

const preset = (s) => FRAME_PRESETS.find((p) => p.id === s.preset) ?? FRAME_PRESETS[0];

/** Target size in pixels, or null for the full window. */
export function frameSize(s) {
  const p = preset(s);
  if (p.id === 'full') return null;
  if (p.id === 'custom') return { w: Math.max(100, s.w | 0), h: Math.max(100, s.h | 0) };
  return { w: p.w, h: p.h };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * Size and place the map stage. Call after anything that moves the app's
 * controls (window resize, sidebar shown or hidden).
 */
export function layoutFrame(s) {
  const stage = document.getElementById('stage');
  const size = frameSize(s);
  const body = document.body;
  body.classList.toggle('framed', !!size);
  body.classList.toggle('frame-outline', !!size && s.outline);
  const label = document.getElementById('frame-label');
  if (!size) {
    stage.style.left = stage.style.top = stage.style.width = stage.style.height = '';
    if (label) label.hidden = true;
    return;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const desktop = vw > 760;
  const panel = document.getElementById('panel');
  const panelOpen = desktop && !body.classList.contains('panel-hidden') && !body.classList.contains('broadcast-clean');
  const pr = panelOpen ? panel.getBoundingClientRect() : null;
  const timeline = document.getElementById('timeline');
  const tr = getComputedStyle(timeline).display !== 'none' ? timeline.getBoundingClientRect() : null;
  const clean = body.classList.contains('broadcast-clean');
  // The settings drawer pushes the map buttons left of it: the frame stays clear of both.
  const drawer = document.getElementById('settings');
  const dr = desktop && drawer && !drawer.hidden ? drawer.getBoundingClientRect() : null;
  const area = {
    left: pr ? pr.right + 14 : 12,
    right: dr ? dr.left - 62 : vw - (desktop && !clean ? 62 : 12),
    top: clean ? 12 : desktop ? 72 : 58,
    bottom: (tr && tr.height ? tr.top : vh) - 12,
  };
  const aw = Math.max(80, area.right - area.left);
  const ah = Math.max(80, area.bottom - area.top);
  const k = Math.min(aw / size.w, ah / size.h);
  const w = Math.round(size.w * k);
  const h = Math.round(size.h * k);
  const left = Math.round(area.left + (aw - w) / 2);
  const top = Math.round(area.top + (ah - h) / 2);
  Object.assign(stage.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  if (label) {
    const g = gcd(size.w, size.h);
    label.hidden = !s.outline;
    label.textContent = `${size.w} × ${size.h} · ${size.w / g}:${size.h / g}${k < 0.999 ? ` · shown at ${Math.round(k * 100)}%` : ''}`;
    label.style.transform = `translate(${left}px, ${Math.max(2, top - 20)}px)`;
  }
}

/** The "Map size" settings tab. */
export function renderFramePanel(el, s, onChange) {
  const size = frameSize(s);
  el.innerHTML = `
    <div class="frame-presets">${FRAME_PRESETS.map(
      (p) => `<button class="frame-preset${s.preset === p.id ? ' active' : ''}" data-id="${p.id}">
        <i style="${p.w ? `aspect-ratio:${p.w}/${p.h}` : p.id === 'custom' ? 'aspect-ratio:1;border-style:dashed' : 'aspect-ratio:16/10;border-style:dotted'}"></i>
        <span>${p.name}${p.w ? `<small>${p.w}×${p.h}</small>` : ''}</span></button>`,
    ).join('')}</div>
    ${
      s.preset === 'custom'
        ? `<div class="frame-custom"><label>W <input type="number" min="100" max="8000" step="10" data-k="w" value="${s.w}" /></label>
           <span>×</span><label>H <input type="number" min="100" max="8000" step="10" data-k="h" value="${s.h}" /></label></div>`
        : ''
    }
    <div class="res-row frame-detail"><span>Export detail</span><div class="segmented" style="grid-template-columns:repeat(${EXPORT_DETAIL.length},1fr)">${EXPORT_DETAIL.map(
      (d) => `<button data-res="${d}" class="${exportDetail(s) === d ? 'active' : ''}">${d}×</button>`,
    ).join('')}</div></div>
    <div class="hint-row">${
      size
        ? `Saved images are ${size.w * exportDetail(s)} × ${size.h * exportDetail(s)}${exportDetail(s) > 1 ? ` (${exportDetail(s)}× the ${size.w} × ${size.h} size) for sharper text and lines` : ''}.`
        : `Saved images are ${exportDetail(s)}× the map at screen resolution.`
    } Videos stay within what MP4 and GIF can hold.</div>
    <div class="toggle${s.outline ? ' on' : ''}" data-act="outline"><span>Frame outline &amp; size label</span><span class="switch"></span></div>
    <div class="hint-row">${
      size
        ? 'Only the map and what is drawn on it change size: the panels stay put. The camera and video buttons save at this shape.'
        : 'Pick a size to frame the map for a social media post. Saved images and videos use it.'
    }</div>`;
  el.querySelectorAll('.frame-preset').forEach((b) =>
    b.addEventListener('click', () => {
      s.preset = b.dataset.id;
      onChange();
      renderFramePanel(el, s, onChange);
    }),
  );
  el.querySelectorAll('.frame-custom input').forEach((inp) =>
    inp.addEventListener('change', () => {
      s[inp.dataset.k] = Math.max(100, Math.min(8000, Number(inp.value) || 1080));
      onChange();
    }),
  );
  el.querySelectorAll('[data-res]').forEach((b) =>
    b.addEventListener('click', () => {
      s.res = Number(b.dataset.res);
      onChange();
      renderFramePanel(el, s, onChange);
    }),
  );
  el.querySelector('[data-act="outline"]').addEventListener('click', () => {
    s.outline = !s.outline;
    onChange();
    renderFramePanel(el, s, onChange);
  });
}
