// Small canvas helpers shared by the sounding and cross-section panels.

/** A canvas sized to its CSS box at the device pixel ratio; returns a 2D context in CSS pixels. */
export function fitCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * A wind barb at (x, y) for a wind of (u, v) m/s, drawn in knots: staff toward
 * where the wind comes from, feathers on the clockwise side (northern hemisphere).
 */
export function windBarb(ctx, x, y, u, v, len = 22) {
  const kt = Math.hypot(u, v) * 1.943844;
  if (!Number.isFinite(kt)) return;
  ctx.beginPath();
  if (kt < 2.5) {
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  const s = Math.hypot(u, v);
  const dx = -u / s; // screen x is east, screen y is south
  const dy = v / s;
  const px = -dy; // right of the staff, looking outward
  const py = dx;
  const tx = x + dx * len;
  const ty = y + dy * len;
  ctx.moveTo(x, y);
  ctx.lineTo(tx, ty);
  let rest = Math.round(kt / 5) * 5;
  let d = 0;
  const gap = len * 0.15;
  const fl = len * 0.42;
  const at = (k) => [tx - dx * k, ty - dy * k];
  ctx.stroke();
  ctx.beginPath();
  while (rest >= 50) {
    const [ax, ay] = at(d);
    const [bx, by] = at(d + gap * 1.3);
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + px * fl + dx * gap * 0.3, ay + py * fl + dy * gap * 0.3);
    ctx.lineTo(bx, by);
    ctx.closePath();
    ctx.fill();
    d += gap * 1.6;
    rest -= 50;
  }
  ctx.beginPath();
  if (d === 0 && rest < 10) d = gap; // a lone half barb sits in from the tip
  while (rest >= 10) {
    const [ax, ay] = at(d);
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + px * fl + dx * gap * 0.6, ay + py * fl + dy * gap * 0.6);
    d += gap;
    rest -= 10;
  }
  if (rest >= 5) {
    const [ax, ay] = at(d);
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + px * fl * 0.5 + dx * gap * 0.3, ay + py * fl * 0.5 + dy * gap * 0.3);
  }
  ctx.stroke();
}

/** Direction (degrees, meteorological "from") and speed (kt) of a wind. */
export function dirSpeed(u, v) {
  const dir = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  return [Math.round(dir), Math.round(Math.hypot(u, v) * 1.943844)];
}
