// What the device can afford: memory budgets for the caches, and whether to go
// easy on the GPU. navigator.deviceMemory is Chrome/Edge only (rounded, and
// capped at 8 GB); Safari and Firefox don't say, so phones and tablets are
// assumed small there. iPadOS reports itself as a Mac with a touch screen.
// ?lowend=1 in the URL acts as a small device (for testing the low-end paths).
const ua = navigator.userAgent || '';
const forceLow = /[?&]lowend=1\b/.test(location.search);
const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
const cores = forceLow ? 2 : navigator.hardwareConcurrency || 4;
const memGB = forceLow ? 2 : navigator.deviceMemory ?? (mobile ? 3 : 8);

const MB = 2 ** 20;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const DEVICE = {
  mobile,
  cores,
  memGB,
  /** Little memory, few cores or a phone: smaller canvases, no extra GPU work. */
  lowEnd: mobile || memGB <= 4 || cores <= 4,
};

/**
 * Decoded fields kept in memory (16-bit packed, about 2 MB per 0.25° global field).
 * A whole GFS run of one upper-air product is 209 hours × 3 fields ≈ 1.3 GB, which
 * is more than most devices can spare, so the budget follows the device and
 * preloading stops when it's reached.
 */
export const FIELD_BUDGET =
  (!mobile && memGB >= 8 && cores >= 8 ? 1024 : clamp(memGB * 96, 192, mobile ? 384 : 768)) * MB;

/** Running totals (snowfall, ice) checkpointed per hour, as plain floats. */
export const CHECKPOINT_BUDGET = clamp(FIELD_BUDGET / 2, 96 * MB, 512 * MB);
