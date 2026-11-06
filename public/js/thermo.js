// Thermodynamics and kinematics for soundings, cross sections and gridded
// severe-weather parameters. Pressures in hPa, temperatures in K, heights in m,
// winds in m/s. Formulas follow Bolton (1980) and the SPC/SHARPpy conventions.

export const RD = 287.04;
const EPS = 0.622;
const CP = 1005.7;
const LV = 2.501e6;
const G = 9.80665;
const KAPPA = RD / CP;

// ---------------------------------------------------------------- moisture
/** Saturation vapour pressure (hPa) over water. */
export const satVap = (t) => 6.112 * Math.exp((17.67 * (t - 273.15)) / (t - 29.65));
/** Saturation mixing ratio (kg/kg). */
export const satMix = (t, p) => {
  const e = Math.min(satVap(t), p * 0.5);
  return (EPS * e) / (p - e);
};
/** Dew point (K) from vapour pressure (hPa). */
export const dewFromVap = (e) => {
  const l = Math.log(Math.max(e, 1e-6) / 6.112);
  return (243.5 * l) / (17.67 - l) + 273.15;
};
export const dewpointFromRh = (t, rh) => dewFromVap(satVap(t) * Math.min(100, Math.max(0.5, rh)) / 100);
export const rhFromDewpoint = (t, td) => (100 * satVap(td)) / satVap(t);
/** Relative humidity (%) from specific humidity (kg/kg). */
export const rhFromQ = (t, q, p) => {
  const w = q / (1 - q);
  return Math.min(100, (100 * ((w * p) / (EPS + w))) / satVap(t));
};
const virtual = (t, w) => (t * (1 + w / EPS)) / (1 + w);

export const theta = (t, p) => t * (1000 / p) ** KAPPA;

/** LCL temperature (K) from temperature and dew point (Bolton eq. 15). */
export const lclTemp = (t, td) => 1 / (1 / (td - 56) + Math.log(t / td) / 800) + 56;

/** Equivalent potential temperature (K), Bolton eq. 43. */
export function thetaE(t, td, p) {
  const r = satMix(td, p) * 1000; // g/kg
  const tl = lclTemp(t, td);
  return t * (1000 / p) ** (0.2854 * (1 - 0.00028 * r)) * Math.exp((3.376 / tl - 0.00254) * r * (1 + 0.00081 * r));
}

/** LCL height above the surface (m) from 2 m temperature and dew point. */
export const lclHeight = (t, td) => Math.max(0, (t - lclTemp(t, Math.min(td, t))) / (G / CP));

// ---------------------------------------------------------------- moist adiabats
/** dT/dp along a pseudo-adiabat (K/hPa). */
function moistLapse(t, p) {
  const rs = satMix(t, p);
  return (RD * t + LV * rs) / (p * (CP + (LV * LV * rs * EPS) / (RD * t * t)));
}

/** Follow a saturated pseudo-adiabat from (t, p0) to p1 (midpoint steps of ≤ maxStep hPa). */
export function moistAdiabat(t, p0, p1, maxStep = 5) {
  const n = Math.max(1, Math.ceil(Math.abs(p1 - p0) / maxStep));
  const dp = (p1 - p0) / n;
  let p = p0;
  for (let i = 0; i < n; i++) {
    const k1 = moistLapse(t, p);
    t += moistLapse(t + (k1 * dp) / 2, p + dp / 2) * dp;
    p += dp;
  }
  return t;
}

/** Wet-bulb temperature (K): lift to the LCL, then back down the moist adiabat. */
export function wetBulb(t, td, p) {
  const tl = lclTemp(t, Math.min(td, t));
  const pl = p * (tl / t) ** (1 / KAPPA);
  return moistAdiabat(tl, pl, p, 10);
}

// ---------------------------------------------------------------- profiles
const interpLog = (p, ps, vs) => {
  // ps descending (surface first)
  const n = ps.length;
  if (p >= ps[0]) return vs[0];
  if (p <= ps[n - 1]) return vs[n - 1];
  let i = 1;
  while (ps[i] > p) i++;
  const f = Math.log(ps[i - 1] / p) / Math.log(ps[i - 1] / ps[i]);
  return vs[i - 1] + f * (vs[i] - vs[i - 1]);
};
const interpHeight = (h, hs, vs) => {
  const n = hs.length;
  if (h <= hs[0]) return vs[0];
  if (h >= hs[n - 1]) return vs[n - 1];
  let i = 1;
  while (hs[i] < h) i++;
  const f = (h - hs[i - 1]) / (hs[i] - hs[i - 1]);
  return vs[i - 1] + f * (vs[i] - vs[i - 1]);
};
export { interpLog };

/**
 * Build a profile from pressure-level data plus surface values. Levels below
 * the ground are dropped; the surface height comes from the levels' heights.
 * @param {{p: number[], t: number[], gh: number[], u: number[], v: number[], rh: number[]}} lv
 * @param {{sp: number, t2: number, d2: number, u10: number, v10: number}} sfc  sp in Pa
 */
export function buildProfile(lv, sfc) {
  const ps = sfc.sp / 100;
  const idx = lv.p.map((_, i) => i).filter((i) => lv.p[i] < ps - 1 && Number.isFinite(lv.t[i]) && Number.isFinite(lv.gh[i]));
  idx.sort((a, b) => lv.p[b] - lv.p[a]);
  // Surface height: hypsometric from the lowest level above ground.
  let zs = 0;
  if (idx.length) {
    const i = idx[0];
    const tm = (lv.t[i] + sfc.t2) / 2;
    zs = lv.gh[i] - ((RD * tm) / G) * Math.log(ps / lv.p[i]);
  }
  const n = idx.length + 1;
  const out = { p: new Float64Array(n), z: new Float64Array(n), h: new Float64Array(n), t: new Float64Array(n), td: new Float64Array(n), u: new Float64Array(n), v: new Float64Array(n) };
  out.p[0] = ps;
  out.z[0] = zs;
  out.t[0] = sfc.t2;
  out.td[0] = Math.min(sfc.d2, sfc.t2);
  out.u[0] = sfc.u10;
  out.v[0] = sfc.v10;
  idx.forEach((i, k) => {
    out.p[k + 1] = lv.p[i];
    out.z[k + 1] = Math.max(lv.gh[i], zs + 1);
    out.t[k + 1] = lv.t[i];
    out.td[k + 1] = Math.min(lv.t[i], dewpointFromRh(lv.t[i], Number.isFinite(lv.rh[i]) ? lv.rh[i] : 1));
    out.u[k + 1] = lv.u[i];
    out.v[k + 1] = lv.v[i];
  });
  for (let k = 0; k < n; k++) out.h[k] = out.z[k] - zs;
  return out;
}

const heightAt = (prof, p) => interpLog(p, prof.p, prof.h);
const pressureAt = (prof, h) => {
  const n = prof.h.length;
  if (h <= 0) return prof.p[0];
  for (let i = 1; i < n; i++) {
    if (prof.h[i] >= h) {
      const f = (h - prof.h[i - 1]) / (prof.h[i] - prof.h[i - 1]);
      return Math.exp(Math.log(prof.p[i - 1]) + f * Math.log(prof.p[i] / prof.p[i - 1]));
    }
  }
  return prof.p[n - 1];
};
export const tempAtHeight = (prof, h) => interpHeight(h, prof.h, prof.t);

// ---------------------------------------------------------------- parcels
/** Starting point (p, t, td) of the surface-based, mixed-layer (100 hPa) or most-unstable parcel. */
export function parcelStart(prof, kind) {
  const ps = prof.p[0];
  if (kind === 'sb') return { p: ps, t: prof.t[0], td: prof.td[0] };
  if (kind === 'ml') {
    let th = 0;
    let w = 0;
    let n = 0;
    for (let p = ps; p >= ps - 100; p -= 5) {
      const t = interpLog(p, prof.p, prof.t);
      const td = interpLog(p, prof.p, prof.td);
      th += theta(t, p);
      w += satMix(td, p);
      n++;
    }
    th /= n;
    w /= n;
    const t = th * (ps / 1000) ** KAPPA;
    const e = (w * ps) / (EPS + w);
    return { p: ps, t, td: Math.min(t, dewFromVap(e)) };
  }
  // most unstable: highest θe in the lowest 300 hPa
  let best = null;
  for (let p = ps; p >= ps - 300; p -= 5) {
    const t = interpLog(p, prof.p, prof.t);
    const td = interpLog(p, prof.p, prof.td);
    const te = thetaE(t, td, p);
    if (!best || te > best.te) best = { p, t, td, te };
  }
  return best;
}

/**
 * Lift a parcel and integrate its buoyancy (virtual temperature correction).
 * @returns {{cape, cin, lclP, lclH, lfcP, lfcH, elP, elH, trace: {p: number[], t: number[]}}}
 */
export function liftParcel(prof, start, ptop = 100) {
  const tl = lclTemp(start.t, Math.min(start.td, start.t));
  const lclP = start.p * (tl / start.t) ** (1 / KAPPA);
  const w0 = satMix(start.td, start.p);
  const trace = { p: [], t: [] };
  const buoy = [];
  let tm = tl; // parcel temperature on the moist adiabat
  let pm = lclP;
  for (let p = start.p; p >= ptop; p -= 5) {
    let tp;
    let wp;
    if (p >= lclP) {
      tp = start.t * (p / start.p) ** KAPPA;
      wp = w0;
    } else {
      tm = moistAdiabat(tm, pm, p);
      pm = p;
      tp = tm;
      wp = satMix(tp, p);
    }
    trace.p.push(p);
    trace.t.push(tp);
    const te = interpLog(p, prof.p, prof.t);
    const tde = interpLog(p, prof.p, prof.td);
    buoy.push(virtual(tp, wp) - virtual(te, satMix(tde, p)));
  }
  // LFC: lowest positively buoyant level at or above the LCL; EL: last positive-to-negative crossing.
  const ps = trace.p;
  let lfc = -1;
  let el = -1;
  for (let i = 0; i < buoy.length; i++) {
    if (buoy[i] > 0 && ps[i] <= lclP) {
      if (lfc < 0) lfc = i;
      el = i;
    }
  }
  let cape = 0;
  let cin = 0;
  if (lfc >= 0) {
    for (let i = 1; i < buoy.length; i++) {
      const area = RD * 0.5 * (buoy[i] + buoy[i - 1]) * Math.log(ps[i - 1] / ps[i]);
      if (i <= lfc) cin += Math.min(0, area);
      else if (i <= el) cape += area;
    }
  }
  cape = Math.max(0, cape);
  const h = (p) => (p == null ? null : heightAt(prof, p));
  // Buoyant right from the LCL: the LFC is the LCL itself.
  const lfcP = lfc >= 0 ? (lfc > 0 && buoy[lfc - 1] > 0 ? lclP : ps[lfc]) : null;
  const elP = el >= 0 ? ps[el] : null;
  return { cape, cin: cape > 0 ? cin : 0, lclP, lclH: h(lclP), lfcP, lfcH: h(lfcP), elP, elH: h(elP), trace, buoy, lfcIndex: lfc, elIndex: el };
}

/** CAPE (J/kg) of a lifted parcel below a height above ground (3CAPE, 6CAPE). */
export function capeBelow(prof, parcel, hTop) {
  if (parcel.lfcIndex < 0) return 0;
  const pTop = pressureAt(prof, hTop);
  const { p } = parcel.trace;
  const b = parcel.buoy;
  let total = 0;
  for (let i = parcel.lfcIndex + 1; i <= parcel.elIndex && p[i] >= pTop; i++) {
    total += Math.max(0, RD * 0.5 * (b[i] + b[i - 1]) * Math.log(p[i - 1] / p[i]));
  }
  return total;
}

/**
 * Downdraft CAPE: a saturated parcel from the lowest-θe level within 400 hPa of the
 * surface, brought down the moist adiabat at its wet-bulb temperature.
 * Works on plain arrays (p descending, surface first) so it can run per grid point.
 */
export function dcape(n, p, t, td, step = 10) {
  const ps = p[0];
  let minTe = Infinity;
  let p0 = 0;
  for (let i = 0; i < n && p[i] >= ps - 400; i++) {
    const te = thetaE(t[i], td[i], p[i]);
    if (te < minTe) {
      minTe = te;
      p0 = p[i];
    }
  }
  if (!p0 || p0 >= ps - 1) return 0;
  const env = (pp, arr) => {
    let i = 1;
    while (i < n - 1 && p[i] > pp) i++;
    const f = Math.log(p[i - 1] / pp) / Math.log(p[i - 1] / p[i]);
    return arr[i - 1] + f * (arr[i] - arr[i - 1]);
  };
  let tp = wetBulb(env(p0, t), env(p0, td), p0);
  let total = 0;
  let prev = null;
  for (let pp = p0; pp <= ps; pp += step) {
    if (pp > p0) tp = moistAdiabat(tp, pp - step, pp, step);
    const te = env(pp, t);
    const b = virtual(te, satMix(env(pp, td), pp)) - virtual(tp, satMix(tp, pp));
    if (prev) total += RD * 0.5 * (b + prev.b) * Math.log(pp / prev.p);
    prev = { p: pp, b };
  }
  return Math.max(0, total);
}

// ---------------------------------------------------------------- kinematics
export const windAt = (prof, h) => [interpHeight(h, prof.h, prof.u), interpHeight(h, prof.h, prof.v)];

export function bulkShear(prof, h0, h1) {
  const [u0, v0] = windAt(prof, h0);
  const [u1, v1] = windAt(prof, h1);
  return Math.hypot(u1 - u0, v1 - v0);
}

export function meanWind(prof, h0, h1) {
  let su = 0;
  let sv = 0;
  let n = 0;
  for (let h = h0; h <= h1 + 1e-6; h += 250) {
    const [u, v] = windAt(prof, h);
    su += u;
    sv += v;
    n++;
  }
  return [su / n, sv / n];
}

/** Bunkers (2000) right- and left-moving supercell motion. */
export function bunkers(prof) {
  const [mu, mv] = meanWind(prof, 0, 6000);
  const [lu, lv] = meanWind(prof, 0, 500);
  const [uu, uv] = meanWind(prof, 5500, 6000);
  const su = uu - lu;
  const sv = uv - lv;
  const s = Math.hypot(su, sv) || 1;
  const du = (7.5 * sv) / s;
  const dv = (-7.5 * su) / s;
  return { rm: [mu + du, mv + dv], lm: [mu - du, mv - dv], mean: [mu, mv] };
}

/** Storm-relative helicity (m²/s²) from the surface to h1 for storm motion (cu, cv). */
export const srh = (prof, h1, storm) => srhLayer(prof, 0, h1, storm);

/** Storm-relative helicity (m²/s²) of the layer h0–h1 (m AGL). */
export function srhLayer(prof, h0, h1, [cu, cv]) {
  let total = 0;
  let [u0, v0] = windAt(prof, h0);
  for (let h = h0 + 100; h <= h1 + 1e-6; h += 100) {
    const [u1, v1] = windAt(prof, h);
    total += (u1 - cu) * (v0 - cv) - (u0 - cu) * (v1 - cv);
    u0 = u1;
    v0 = v1;
  }
  return total;
}

// ---------------------------------------------------------------- composites
/** Fixed-layer significant tornado parameter (Thompson et al. 2003). */
export function stp(sbcape, lclH, srh1, shear6) {
  const lclT = lclH < 1000 ? 1 : lclH > 2000 ? 0 : (2000 - lclH) / 1000;
  const shrT = shear6 < 12.5 ? 0 : Math.min(shear6, 30) / 20;
  return Math.max(0, (sbcape / 1500) * lclT * (srh1 / 150) * shrT);
}

/** Supercell composite parameter with fixed layers (MUCAPE, 0–3 km SRH, 0–6 km shear). */
export function scp(mucape, srh3, shear6) {
  const shrT = shear6 < 10 ? 0 : Math.min(shear6, 20) / 20;
  return Math.max(0, (mucape / 1000) * (srh3 / 50) * shrT);
}

/** Lapse rate (°C/km) between two heights above the surface. */
export const lapseRate = (prof, h0, h1) => ((tempAtHeight(prof, h0) - tempAtHeight(prof, h1)) / (h1 - h0)) * 1000;

/** Lapse rate (°C/km) between two pressure levels. */
export function lapseRateP(prof, p0, p1) {
  if (p0 > prof.p[0]) return null;
  const t0 = interpLog(p0, prof.p, prof.t);
  const t1 = interpLog(p1, prof.p, prof.t);
  const z0 = interpLog(p0, prof.p, prof.z);
  const z1 = interpLog(p1, prof.p, prof.z);
  return ((t0 - t1) / (z1 - z0)) * 1000;
}

/** Precipitable water (mm). */
export function pwat(prof) {
  let total = 0;
  for (let i = 1; i < prof.p.length; i++) {
    const q0 = satMix(prof.td[i - 1], prof.p[i - 1]);
    const q1 = satMix(prof.td[i], prof.p[i]);
    total += ((q0 + q1) / 2) * (prof.p[i - 1] - prof.p[i]) * 100 / G;
  }
  return total;
}

/** Lowest height (m AGL) where a profile value crosses `value` going up, or null. */
function crossing(prof, arr, value) {
  if (arr[0] <= value) return 0;
  for (let i = 1; i < prof.h.length; i++) {
    if (arr[i] <= value) {
      const f = (arr[i - 1] - value) / (arr[i - 1] - arr[i]);
      return prof.h[i - 1] + f * (prof.h[i] - prof.h[i - 1]);
    }
  }
  return null;
}

/** Everything the sounding panel lists. */
export function soundingIndices(prof) {
  const parcels = {};
  for (const k of ['sb', 'ml', 'mu']) parcels[k] = { start: parcelStart(prof, k), ...liftParcel(prof, parcelStart(prof, k)) };
  const storm = bunkers(prof);
  const s1 = srh(prof, 1000, storm.rm);
  const s3 = srh(prof, 3000, storm.rm);
  const sh1 = bulkShear(prof, 0, 1000);
  const sh6 = bulkShear(prof, 0, 6000);
  const wb = prof.t.map((t, i) => wetBulb(t, prof.td[i], prof.p[i]));
  return {
    parcels,
    dcape: dcape(prof.p.length, prof.p, prof.t, prof.td, 5),
    storm,
    srh1: s1,
    srh3: s3,
    shear1: sh1,
    shear6: sh6,
    lr03: lapseRate(prof, 0, 3000),
    lr36: lapseRate(prof, 3000, 6000),
    lr75: lapseRateP(prof, 700, 500),
    lr85: lapseRateP(prof, 850, 500),
    pwat: pwat(prof),
    fzl: crossing(prof, prof.t, 273.15),
    wbz: crossing(prof, wb, 273.15),
    stp: stp(parcels.sb.cape, parcels.sb.lclH, s1, sh6),
    scp: scp(parcels.mu.cape, s3, sh6),
    pressureAt: (h) => pressureAt(prof, h),
  };
}

// ---------------------------------------------------------------- effective layer & composites
/** Mean relative humidity (%) between two pressures (sampled every 10 hPa). */
export function meanRh(prof, p0, p1) {
  let sum = 0;
  let n = 0;
  for (let p = Math.min(p0, prof.p[0]); p >= p1; p -= 10) {
    sum += rhFromDewpoint(interpLog(p, prof.p, prof.t), interpLog(p, prof.p, prof.td));
    n++;
  }
  return n ? sum / n : NaN;
}

/**
 * Effective inflow layer (Thompson et al. 2007): the lowest contiguous layer of
 * parcels, from the ground up, with CAPE ≥ 100 J/kg and CIN ≥ −250 J/kg.
 * @returns {{pBot: number, pTop: number, hBot: number, hTop: number}|null}
 */
export function effectiveLayer(prof) {
  const ps = prof.p[0];
  let bot = null;
  let top = null;
  for (let p = ps; p >= ps - 300; p -= 10) {
    const r = liftParcel(prof, { p, t: interpLog(p, prof.p, prof.t), td: interpLog(p, prof.p, prof.td) });
    const ok = r.cape >= 100 && r.cin >= -250;
    if (ok && bot == null) bot = p;
    if (ok) top = p;
    else if (bot != null) break;
  }
  if (bot == null) return null;
  return { pBot: bot, pTop: top, hBot: heightAt(prof, bot), hTop: heightAt(prof, top) };
}

/**
 * Everything the sounding's lower tables list beyond soundingIndices: layer
 * CAPE, the effective inflow layer with its helicity and shear, layer
 * kinematics and the composite parameters SPC uses.
 */
export function extendedIndices(prof, ix) {
  const { sb, ml, mu } = ix.parcels;
  const rm = ix.storm.rm;
  const eil = effectiveLayer(prof);
  const esrh = eil ? srhLayer(prof, eil.hBot, eil.hTop, rm) : 0;
  // Effective bulk shear: from the inflow base to half the MU equilibrium level.
  const ebwd = eil && mu.elH ? bulkShear(prof, eil.hBot, eil.hBot + 0.5 * (mu.elH - eil.hBot)) : 0;
  const layer = (h0, h1) => {
    const [mu0, mv0] = meanWind(prof, h0, h1);
    return { shear: bulkShear(prof, h0, h1), srh: srhLayer(prof, h0, h1, rm), srw: Math.hypot(mu0 - rm[0], mv0 - rm[1]) };
  };
  const layers = [
    ['0–0.5 km', 0, 500],
    ['0–1 km', 0, 1000],
    ['0–3 km', 0, 3000],
    ['0–6 km', 0, 6000],
    ['1–3 km', 1000, 3000],
    ['3–6 km', 3000, 6000],
  ].map(([name, h0, h1]) => ({ name, ...layer(h0, h1) }));
  if (eil) layers.push({ name: 'Effective', shear: ebwd, srh: esrh, srw: layer(eil.hBot, Math.max(eil.hTop, eil.hBot + 250)).srw });
  // Effective-layer STP with CIN (Thompson et al. 2012), from the mixed-layer parcel.
  const lclT = ml.lclH < 1000 ? 1 : ml.lclH > 2000 ? 0 : (2000 - ml.lclH) / 1000;
  const shrT = ebwd < 12.5 ? 0 : Math.min(ebwd, 30) / 20;
  const cinT = ml.cin > -50 ? 1 : ml.cin < -200 ? 0 : (200 + ml.cin) / 150;
  const stpCin = eil ? Math.max(0, (ml.cape / 1500) * lclT * (esrh / 150) * shrT * cinT) : 0;
  // Bulk Richardson number shear: 0–6 km density-weighted mean wind minus the 0–500 m mean.
  const [a0, b0] = meanWind(prof, 0, 6000);
  const [a1, b1] = meanWind(prof, 0, 500);
  const brnShear = 0.5 * ((a0 - a1) ** 2 + (b0 - b1) ** 2);
  const mlStart = ml.start;
  return {
    eil,
    esrh,
    ebwd,
    layers,
    cape3: { sb: capeBelow(prof, sb, 3000), ml: capeBelow(prof, ml, 3000), mu: capeBelow(prof, mu, 3000) },
    cape6: { sb: capeBelow(prof, sb, 6000), ml: capeBelow(prof, ml, 6000), mu: capeBelow(prof, mu, 6000) },
    stpCin,
    ehi1: (ml.cape * ix.srh1) / 160000,
    ehi3: (ml.cape * ix.srh3) / 160000,
    brn: brnShear > 0.5 ? ml.cape / brnShear : 0,
    sigSvr: ml.cape * ix.shear6,
    meanW: satMix(mlStart.td, mlStart.p) * 1000, // g/kg, lowest 100 hPa
    lowRh: meanRh(prof, prof.p[0], prof.p[0] - 150),
    midRh: meanRh(prof, 700, 500),
    lr26: lapseRate(prof, 2000, 6000),
  };
}

/**
 * A rough guide to the kind of weather a sounding favours, loosely after
 * SHARPpy's "possible hazard" box (its thresholds simplified).
 */
export function hazardType(prof, ix, ex) {
  const { ml, mu } = ix.parcels;
  const kt = 1.943844;
  const t2 = prof.t[0] - 273.15;
  const sfcWind = Math.hypot(prof.u[0], prof.v[0]) * kt;
  const [mwu, mwv] = ix.storm.mean;
  const meanKt = Math.hypot(mwu, mwv) * kt;
  if (ex.stpCin >= 3 && ex.esrh >= 200 && ml.lclH < 1200) return 'PDS Tornado';
  if (ex.stpCin >= 1 || (ix.stp >= 1 && ml.cin > -125)) return 'Tornado';
  if (ex.stpCin >= 0.5 && ex.esrh >= 100) return 'Marginal Tornado';
  if (ix.scp >= 1 || (mu.cape >= 1500 && ex.ebwd * kt >= 35)) return 'Severe';
  if ((mu.cape >= 500 && ix.shear6 * kt >= 25) || (mu.cape >= 1000 && ix.dcape >= 1000)) return 'Marginal Severe';
  if (ix.pwat >= 38 && meanKt < 15 && mu.cape > 0) return 'Flash Flood';
  if (t2 <= 0 && sfcWind >= 30) return 'Blizzard';
  if (t2 >= 37 || (t2 >= 32 && prof.td[0] - 273.15 >= 24)) return 'Excessive Heat';
  return 'None';
}
