// Model catalogue: where each model's data lives, which canonical (ECMWF-style)
// parameters it publishes, and recipes for the ones it doesn't.
//
// Canonical params: 2t 2d 10u 10v 10fg sbcape mlcape mucape sbcin mlcin mucin
// srh1 srh3 ush6 vsh6 ltng dcape msl sp tp sf tprate ptype refc tcc lcc mcc hcc vis
// (surface) and t gh u v vo r (pressure levels). Accumulations
// (tp, sf) are metres of water since F000; visibility is metres. Ensemble
// probabilities are params too ("prob:…", see probability.js).
import { ecmwfSource, fetchRetry, mscSource, ncepSource, openMeteoSource, range } from './sources.js';
import {
  classifyPrecipType, dewpointFromRh, ptypeFromCategorical, ptypeFromWmo, relativeVorticity, vorticity,
} from './derived.js';
import { rhFromQ } from './thermo.js';
import { parseProb } from './probability.js';

const UPPER = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50, 10];
const p2 = (n) => String(n).padStart(2, '0');
const p3 = (n) => String(n).padStart(3, '0');

// ---------------------------------------------------------------- shared recipes
const vortFromWinds = {
  needs: (level) => ({ u: { param: 'u', level }, v: { param: 'v', level } }),
  make: ({ u, v }) => vorticity(u.values, v.values, u.meta),
};
const vortFromAbsv = {
  needs: (level) => ({ a: { param: 'absv', level } }),
  make: ({ a }) => relativeVorticity(a.values, a.meta),
};
const ptypeCategorical = {
  needs: () => ({ rain: { param: 'crain' }, snow: { param: 'csnow' }, fzra: { param: 'cfrzr' }, ip: { param: 'cicep' } }),
  make: ptypeFromCategorical,
};
// Warm-nose scheme from the temperature profile (models without a precip type).
const ptypeProfile = {
  needs: () => ({
    t2: { param: '2t' },
    sp: { param: 'sp' },
    t925: { param: 't', level: 925 },
    t850: { param: 't', level: 850 },
    t700: { param: 't', level: 700 },
  }),
  make: (f) =>
    classifyPrecipType(
      f.t2.values,
      [
        { level: 925, values: f.t925.values },
        { level: 850, values: f.t850.values },
        { level: 700, values: f.t700.values },
      ],
      f.sp.values,
    ),
};
// 6-hour mean rate from accumulated precipitation (m), as kg m⁻² s⁻¹
const tprateFromTp6 = {
  needs: () => ({ tp: { param: 'tp' }, prev: { param: 'tp', stepOffset: -6 } }),
  make: ({ tp, prev }) => {
    const out = new Float32Array(tp.values.length);
    if (!prev) return out;
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, tp.values[i] - prev.values[i]) * (1000 / 21600);
    return out;
  },
};

// Mean rate over the latest precipitation bucket (GEFS: 3 or 6 h; restarts every
// `hours`), kg m⁻² s⁻¹: one field, no running total needed.
const tprateFromBucket = (hours) => ({
  zeroAtStart: true,
  needs: () => ({ b: { param: 'apcp' } }),
  make: ({ b }, ctx) => {
    const span = ctx.step - (ctx.step > 0 ? Math.floor((ctx.step - 1) / hours) * hours : 0) || hours;
    const out = new Float32Array(b.values.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, b.values[i]) * (1000 / (span * 3600));
    return out;
  },
});

// Run total (m) from precipitation published in buckets that restart every
// `hours` (GEFS 6 h, REFS 1 h): the total at the bucket's start plus the bucket.
const tpFromBuckets = (hours) => ({
  zeroAtStart: true,
  needs: (level, ctx) => {
    const start = ctx.step > 0 ? Math.floor((ctx.step - 1) / hours) * hours : 0;
    return { b: { param: 'apcp' }, ...(start > 0 ? { prev: { param: 'tp', stepOffset: start - ctx.step } } : {}) };
  },
  make: ({ b, prev }) => {
    const out = new Float32Array(b.values.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, b.values[i]) + (prev ? prev.values[i] : 0);
    return out;
  },
});
// Snow water since F000 (m) from precipitation buckets and the categorical snow flag
// averaged over the same interval (GEFS: the share of the bucket that fell as snow).
// Built per member; the ensemble mean is the average of the members' totals
// (`meanOfMembers`, see DataSource), not computed from the published mean file:
// NCEP's mean file carries a yes/no snow flag (snow in most members), so mean
// precipitation × that flag drops snow wherever under half the members have it
// and gives all the mean precipitation to snow where just over half do.
const sfFromBuckets = (hours) => ({
  zeroAtStart: true,
  meanOfMembers: true,
  needs: (level, ctx) => {
    const start = ctx.step > 0 ? Math.floor((ctx.step - 1) / hours) * hours : 0;
    return { b: { param: 'apcp' }, s: { param: 'csnow' }, ...(start > 0 ? { prev: { param: 'sf', stepOffset: start - ctx.step } } : {}) };
  },
  make: ({ b, s, prev }) => {
    const out = new Float32Array(b.values.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, b.values[i]) * Math.min(1, Math.max(0, s.values[i])) + (prev ? prev.values[i] : 0);
    return out;
  },
});
// 1-hour mean rate (kg m⁻² s⁻¹) from hourly files whose precipitation bucket
// restarts every `hours` (WOOF-NAM 12 h): this hour's bucket less the last hour's.
const tprateFromBuckets = (hours) => ({
  zeroAtStart: true,
  needs: (level, ctx) => ({ b: { param: 'apcp' }, ...(ctx.step % hours !== 1 ? { prev: { param: 'apcp', stepOffset: -1 } } : {}) }),
  make: ({ b, prev }) => {
    const out = new Float32Array(b.values.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, b.values[i] - (prev ? prev.values[i] : 0)) * (1000 / 3600);
    return out;
  },
});
const dewpointFromRh2 = {
  needs: () => ({ t: { param: '2t' }, rh: { param: 'rh2' } }),
  make: ({ t, rh }) => dewpointFromRh(t.values, rh.values),
};

const NCEP_SURFACE = ['2t', '2d', '10u', '10v', '10fg', 'mucape', 'msl', 'sp', 'tp', 'tprate', 'refc', 'tcc', 'lcc', 'mcc', 'hcc', 'vis'];
const NCEP_PTYPE = ['crain', 'csnow', 'cfrzr', 'cicep'];
const NCEP_UPPER = ['t', 'gh', 'u', 'v', 'absv', 'r'];
// Severe-weather fields: CAPE/CIN for surface, 90 hPa mixed-layer and most-unstable parcels, helicity
const NCEP_SEVERE = ['sbcape', 'mlcape', 'sbcin', 'mlcin', 'mucin', 'srh3'];
// ...plus 0–1 km helicity, 0–6 km shear and lightning from the convection-allowing models
const HIRES_SEVERE = [...NCEP_SEVERE, 'srh1', 'ush6', 'vsh6', 'ltng'];

// ---------------------------------------------------------------- soundings
// Pressure levels read for soundings and cross sections (t, gh, u, v, r at each),
// and the subset used for gridded DCAPE (which needs every level at every point).
const PROFILE_HIRES = [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];
const PROFILE_GFS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];
const PROFILE_GLOBAL = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100];
const PROFILE_ENS = [1000, 925, 850, 700, 500, 250, 200, 100];
const PROFILE_REFS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 600, 500, 400, 300, 250];
const DCAPE_FINE = [1000, 950, 900, 850, 800, 700, 600, 500];
const DCAPE_GLOBAL = [1000, 925, 850, 700, 600, 500];
const DCAPE_ENS = [1000, 925, 850, 700, 500];

/** Downdraft CAPE per grid point, computed in a decode worker (see worker.js). */
const dcapeFrom = (levels) => ({
  worker: 'dcape',
  levels,
  needs: () => ({
    sp: { param: 'sp' },
    t2: { param: '2t' },
    d2: { param: '2d' },
    ...Object.fromEntries(levels.flatMap((l) => [[`t${l}`, { param: 't', level: l }], [`r${l}`, { param: 'r', level: l }]])),
  }),
});
/** Relative humidity (%) on pressure levels from specific humidity. */
const rFromQ = {
  needs: (level) => ({ t: { param: 't', level }, q: { param: 'q', level } }),
  make: ({ t, q }, { level }) => {
    const out = new Float32Array(t.values.length);
    for (let i = 0; i < out.length; i++) out[i] = rhFromQ(t.values[i], Math.max(0, q.values[i]), level);
    return out;
  },
};

// ---------------------------------------------------------------- ICON via Open-Meteo
const addK = (v) => {
  for (let i = 0; i < v.length; i++) v[i] += 273.15;
};
const times = (k) => (v) => {
  for (let i = 0; i < v.length; i++) v[i] *= k;
};
const ICON_PARAMS = {
  '2t': { name: 'temperature_2m', f: addK },
  rh2: { name: 'relative_humidity_2m' },
  '10u': { name: 'wind_u_component_10m' },
  '10v': { name: 'wind_v_component_10m' },
  '10fg': { name: 'wind_gusts_10m' },
  mucape: { name: 'cape' },
  msl: { name: 'pressure_msl', f: times(100) }, // hPa → Pa
  tcc: { name: 'cloud_cover', f: times(0.01) },
  lcc: { name: 'cloud_cover_low', f: times(0.01) },
  mcc: { name: 'cloud_cover_mid', f: times(0.01) },
  hcc: { name: 'cloud_cover_high', f: times(0.01) },
  precip: { name: 'precipitation' }, // mm since the previous valid time
  snowfall: { name: 'snowfall_water_equivalent' },
  wcode: { name: 'weather_code' },
  t: { name: (l) => `temperature_${l}hPa`, upper: true, f: addK },
  gh: { name: (l) => `geopotential_height_${l}hPa`, upper: true },
  u: { name: (l) => `wind_u_component_${l}hPa`, upper: true },
  v: { name: (l) => `wind_v_component_${l}hPa`, upper: true },
};

// ---------------------------------------------------------------- ensembles
// GEFS file prefix per member: mean, control, perturbed 1..30
const gefsFile = (m) => (m === 'mean' ? 'geavg' : m === '0' ? 'gec00' : `gep${p2(m)}`);
const isbl = (l) => `ISBL_${String(l).padStart(4, '0')}`;
// MSC GEPS variable/level names (files of all 21 members, 0.5°)
const GEPS_PARAMS = {
  '2t': { v: 'TMP', l: 'TGL_2m' },
  rh2: { v: 'RH', l: 'TGL_2m' },
  '10u': { v: 'UGRD', l: 'TGL_10m' },
  '10v': { v: 'VGRD', l: 'TGL_10m' },
  sbcape: { v: 'CAPE', l: 'SFC_0' },
  sbcin: { v: 'CIN', l: 'SFC_0' },
  msl: { v: 'PRMSL', l: 'MSL_0' },
  sp: { v: 'PRES', l: 'SFC_0' },
  tp: { v: 'APCP', l: 'SFC_0', scale: 1e-3, zeroAtStart: true }, // kg m⁻² since F000 → m
  sf: { v: 'ASNOW', l: 'SFC_0', scale: 1e-3, zeroAtStart: true }, // snow water since F000
  tcc: { v: 'TCDC', l: 'SFC_0', scale: 0.01 },
  t: { v: 'TMP', l: isbl, upper: true },
  gh: { v: 'HGT', l: isbl, upper: true },
  u: { v: 'UGRD', l: isbl, upper: true },
  v: { v: 'VGRD', l: isbl, upper: true },
  r: { v: 'RH', l: isbl, upper: true },
};
// MSC GDPS (deterministic, 0.15°): one file per field, MSC's own names.
const gdpsLevel = (l) => `IsbL-${String(l).padStart(4, '0')}`;
// GDPS precip type (instantaneous): 1 rain, 2 rain/snow mix, 3 freezing rain,
// 4 ice pellets, 5 snow, 6 none (worked out from the fields themselves) → table 4.201.
const GDPS_PTYPE = [0, 1, 7, 3, 8, 5, 0];
const GDPS_PARAMS = {
  '2t': { v: 'AirTemp', l: 'AGL-2m' },
  '2d': { v: 'DewPoint', l: 'AGL-2m' },
  '10u': { v: 'WindU', l: 'AGL-10m' },
  '10v': { v: 'WindV', l: 'AGL-10m' },
  '10fg': { v: 'WindGust', l: 'AGL-10m' },
  msl: { v: 'Pressure', l: 'MSL' },
  sp: { v: 'Pressure', l: 'Sfc' },
  tp: { v: 'Precip-Accum', l: 'Sfc', scale: 1e-3, zeroAtStart: true }, // kg m⁻² since F000 → m
  sf: { v: 'Snow-Accum', l: 'Sfc', scale: 1e-3, zeroAtStart: true }, // snow water since F000
  tprate: { v: 'PrecipRate', l: 'Sfc', zeroAtStart: true }, // kg m⁻² s⁻¹; F000 has none
  ptype: {
    v: 'PrecipType-Instant',
    l: 'Sfc',
    f: (v) => {
      for (let i = 0; i < v.length; i++) v[i] = GDPS_PTYPE[Math.round(v[i])] ?? 0;
    },
  },
  tcc: { v: 'TotalCloudCover', l: 'Sfc', scale: 0.01 },
  t: { v: 'AirTemp', l: gdpsLevel, upper: true },
  gh: { v: 'GeopotentialHeight', l: gdpsLevel, upper: true },
  u: { v: 'WindU', l: gdpsLevel, upper: true },
  v: { v: 'WindV', l: gdpsLevel, upper: true },
  r: { v: 'RelativeHumidity', l: gdpsLevel, upper: true },
  vo: { v: 'RelativeVorticity', l: gdpsLevel, upper: true }, // 200, 250, 500, 700, 850 hPa only
};
const PROFILE_GDPS = [1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];

// ---------------------------------------------------------------- NBM
// NBM files also hold probabilities, percentiles and spreads of the same fields: only
// the plain ones are read (extra: ''). Winds come as speed and direction, and
// precipitation and snowfall as 1 h amounts (every step) and 6 h amounts (every 6th hour).
const nbmAmount = (v, hours, scale) => ({ v, l: 'surface', scale, t: (s) => new RegExp(`^${s - hours}-${s} hour acc fcst$`) });
const nbmPtype = (codes) => ({ v: 'PTYPE', l: 'surface', x: new RegExp(`^prob ${codes}:`) }); // % chance of each type
const NBM_PARAMS = {
  '10fg': { v: 'GUST', l: '10 m above ground' },
  sbcape: { v: 'CAPE', l: 'surface' },
  tcc: { v: 'TCDC', l: 'surface', scale: 0.01 },
  // 10 m wind: speed and direction, turned into u/v in the decode worker (see ncepSource)
  '10u': { v: 'WIND', l: '10 m above ground', polar: { dir: 'wdir', pair: '10v', u: true } },
  '10v': { v: 'WIND', l: '10 m above ground', polar: { dir: 'wdir', pair: '10u' } },
  wdir: { v: 'WDIR', l: '10 m above ground' },
  apcp1: nbmAmount('APCP', 1, 1e-3), // kg m⁻² → m
  tprate: nbmAmount('APCP', 1, 1 / 3600), // the past hour's amount as a mean rate, kg m⁻² s⁻¹
  apcp6: nbmAmount('APCP', 6, 1e-3),
  asnow1: nbmAmount('ASNOW', 1), // snow depth, m
  asnow6: nbmAmount('ASNOW', 6),
  prain: nbmPtype('>=1 <2'),
  pfzra: nbmPtype('>=3 <4'),
  psnow: nbmPtype('>=5 <7'),
  psleet: nbmPtype('>=8 <9'),
};
// Every run (NBM runs hourly) goes hourly to 48 h, then has every field at the
// 3-hourly valid times (00, 03, 06 … UTC) to 192 h and the 6-hourly ones to 264 h.
// The other hours carry precipitation only, so they aren't listed.
const nbmSteps = (hour) => [
  ...range(1, 48, 1),
  ...range(49, 192, 1).filter((s) => (hour + s) % 3 === 0),
  ...range(193, 264, 1).filter((s) => (hour + s) % 6 === 0),
];
// Totals since F000 exist where the amounts join up: every hour to 48 h, then at the
// 6-hourly valid times (where NBM publishes 6 h amounts).
const nbmTotalAt = (step, hour) => step <= 48 || (hour + step) % 6 === 0;
/** An NBM total since F000 (`self`) from its 1 h and 6 h amounts, × k; NaN where they don't join up. */
const nbmTotal = (self, a1, a6, k = 1) => ({
  zeroAtStart: true,
  needs: (level, ctx) => {
    if (!nbmTotalAt(ctx.step, ctx.hour ?? 0)) return { b: { param: a1 } };
    const h = ctx.step <= 48 ? 1 : 6;
    return { b: { param: h === 1 ? a1 : a6 }, ...(ctx.step > h ? { prev: { param: self, stepOffset: -h } } : {}) };
  },
  make: ({ b, prev }, ctx) => {
    const out = new Float32Array(b.values.length);
    if (!nbmTotalAt(ctx.step, ctx.hour ?? 0)) return out.fill(NaN);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, b.values[i]) * k + (prev ? prev.values[i] : 0);
    return out;
  },
});
/** The most likely precip type (table 4.201: rain, freezing rain, snow, ice pellets). */
const nbmPtypeRecipe = {
  needs: () => ({ r: { param: 'prain' }, z: { param: 'pfzra' }, s: { param: 'psnow' }, i: { param: 'psleet' } }),
  make: ({ r, z, s, i }) => {
    const out = new Float32Array(r.values.length);
    const types = [[1, r.values], [3, z.values], [5, s.values], [8, i.values]];
    for (let k = 0; k < out.length; k++) {
      let best = 0;
      let top = 0;
      for (const [code, v] of types) {
        if (v[k] > top) {
          top = v[k];
          best = code;
        }
      }
      out[k] = best;
    }
    return out;
  },
};

const refsMember = (m) => `m${p3(m)}`; // REFS members 1..5 → m001..m005
const NCEP_ENS_LEVELS = [1000, 925, 850, 700, 500, 300, 250, 200, 100, 50, 10];
const NO_300 = NCEP_ENS_LEVELS.filter((l) => l !== 300); // GEFS/GEPS publish no 300 hPa temperature

// ---------------------------------------------------------------- RRFS
const RRFS_BUCKET = 'https://noaa-rrfs-ops-pds.s3.amazonaws.com';
// Full output, every 3 hours: hourly to 84 h at 00/06/12/18 UTC, 18 h at 03/09/15/21 UTC.
const RRFS_FULL = ncepSource({
  bucket: RRFS_BUCKET,
  files: {
    sfc: (r, s) => `rrfs.${r.date}/${r.hh}/rrfs.t${r.hh}z.2dfld.3km.f${p3(s)}.conus.grib2`,
    prs: (r, s) => `rrfs.${r.date}/${r.hh}/rrfs.t${r.hh}z.prslev.3km.f${p3(s)}.conus.grib2`,
  },
  listing: {
    sfc: { prefix: (r) => `rrfs.${r.date}/${r.hh}/rrfs.t${r.hh}z.2dfld.3km.f`, re: /\.f(\d{3})\.conus\.grib2\.idx$/ },
    prs: { prefix: (r) => `rrfs.${r.date}/${r.hh}/rrfs.t${r.hh}z.prslev.3km.f`, re: /\.f(\d{3})\.conus\.grib2\.idx$/ },
  },
  cycle: 3,
  search: 24,
  maxRuns: 4,
  steps: (hour) => range(0, hour % 6 === 0 ? 84 : 18, 1),
  levels: UPPER,
  profileLevels: PROFILE_HIRES,
  params: [...NCEP_SURFACE, ...HIRES_SEVERE, ...NCEP_PTYPE, ...NCEP_UPPER],
  overrides: { msl: { v: 'MSLET' } },
  gridRelativeWinds: true,
  regrid: { res: 0.03 },
});
// The hourly cycles in between publish only the sub-hourly surface files
// (2dfld.subh, F001–F018, each with its 15/30/45 min and whole-hour fields; the
// whole-hour ones are read): no F000, no upper air, CAPE, helicity or clouds.
const RRFS_HOURLY = ncepSource({
  bucket: RRFS_BUCKET,
  files: { sfc: (r, s) => `rrfs.${r.date}/${r.hh}/rrfs.t${r.hh}z.2dfld.3km.subh.f${p3(s)}.conus.grib2` },
  listing: { sfc: { prefix: (r) => `rrfs.${r.date}/${r.hh}/rrfs.t${r.hh}z.2dfld.3km.subh.f`, re: /\.subh\.f(\d{3})\.conus\.grib2\.idx$/ } },
  cycle: 1,
  search: 8,
  maxRuns: 5,
  steps: (hour) => (hour % 3 === 0 ? [] : range(1, 18, 1)),
  levels: [],
  params: ['2t', '2d', '10u', '10v', '10fg', 'msl', 'sp', 'tp', 'tprate', 'refc', 'vis', ...NCEP_PTYPE],
  overrides: { msl: { v: 'MSLET' } },
  gridRelativeWinds: true,
  regrid: { res: 0.03 },
});

// ---------------------------------------------------------------- WOOF-NAM
// Recast's revival of the NAM 12 km (NCEP grid 218), in NOAA's awphys layout. There is
// no bucket listing: status.json names the newest runs and the last forecast hour
// ready in each (hours arrive in order). Runs before 06 UTC 5 Nov 2026 used an
// earlier layout (no MSLET, gusts or cloud cover; precipitation since F000) and are skipped.
const WOOF_NAM = 'https://woof-nam.recastsystems.com';
const WOOF_NAM_LAYOUT = Date.UTC(2026, 10, 5, 6);
let woofStatus = null;
async function woofNamSteps(run) {
  if (run.time < WOOF_NAM_LAYOUT) return [];
  if (!woofStatus || Date.now() - woofStatus.at > 60e3) {
    const p = fetchRetry(`${WOOF_NAM}/status.json`).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for WOOF-NAM status.json`);
      return res.json();
    });
    woofStatus = { at: Date.now(), p };
    p.catch(() => (woofStatus = null));
  }
  const c = (await woofStatus.p).cycles?.find((x) => Date.parse(x.cycle) === run.time);
  const last = Number(c?.hours_available);
  return c && c.state !== 'skipped' && Number.isFinite(last) ? range(0, Math.min(last, 84), 1) : [];
}

/** A source that also lists another source's runs, tagged with the model view that reads them. */
function withRuns(source, extra, view) {
  return {
    ...source,
    runs: async () => {
      const [own, more] = await Promise.all([source.runs(), extra.runs().catch(() => [])]);
      return [...own, ...more.map((r) => ({ ...r, view }))].sort((a, b) => (a.id < b.id ? 1 : -1));
    },
  };
}

// ---------------------------------------------------------------- catalogue
export const MODELS = {
  ifs: {
    name: 'ECMWF IFS',
    label: 'IFS',
    sub: 'ECMWF',
    group: 'global',
    credit: 'ECMWF open data (CC-BY-4.0)',
    source: ecmwfSource({
      dir: 'ifs',
      // 3-hourly to 144 h; the 00/12 UTC runs continue 6-hourly to 360 h
      steps: (hour) => [...range(0, 144, 3), ...(hour % 12 === 0 ? range(150, 360, 6) : [])],
      levels: UPPER,
      params: ['2t', '2d', '10u', '10v', '10fg', 'mucape', 'msl', 'sp', 'tp', 'sf', 'tprate', 'ptype', 'tcc', 'lcc', 'mcc', 'hcc', 't', 'gh', 'u', 'v', 'vo', 'r'],
    }),
    derived: { dcape: dcapeFrom(DCAPE_GLOBAL) },
    profile: PROFILE_GLOBAL,
  },
  aifs: {
    name: 'ECMWF AIFS',
    label: 'AIFS',
    sub: 'ECMWF AI',
    group: 'global',
    credit: 'ECMWF open data (CC-BY-4.0)',
    source: ecmwfSource({
      dir: 'aifs-single',
      steps: () => range(0, 360, 6),
      levels: UPPER,
      params: ['2t', '2d', '10u', '10v', 'msl', 'sp', 'tp', 'sf', 'tcc', 'lcc', 'mcc', 'hcc', 't', 'gh', 'u', 'v', 'q'],
    }),
    derived: { vo: vortFromWinds, tprate: tprateFromTp6, ptype: ptypeProfile, r: rFromQ, dcape: dcapeFrom(DCAPE_GLOBAL) },
    notes: { ptype: 'type from temperature profile', tprate: '6 h mean' },
    profile: PROFILE_GLOBAL,
  },
  gfs: {
    name: 'GFS',
    label: 'GFS',
    sub: 'NOAA',
    group: 'global',
    credit: 'NOAA GFS via AWS Open Data',
    source: ncepSource({
      bucket: 'https://noaa-gfs-bdp-pds.s3.amazonaws.com',
      files: { sfc: (r, s) => `gfs.${r.date}/${r.hh}/atmos/gfs.t${r.hh}z.pgrb2.0p25.f${p3(s)}` },
      listing: {
        sfc: { prefix: (r) => `gfs.${r.date}/${r.hh}/atmos/gfs.t${r.hh}z.pgrb2.0p25.f`, re: /\.f(\d{3})\.idx$/ },
      },
      cycle: 6,
      search: 36,
      maxRuns: 4,
      steps: () => [...range(0, 120, 1), ...range(123, 384, 3)],
      levels: UPPER,
      profileLevels: PROFILE_GFS,
      params: [...NCEP_SURFACE, ...NCEP_SEVERE, ...NCEP_PTYPE, ...NCEP_UPPER],
    }),
    derived: { vo: vortFromAbsv, ptype: ptypeCategorical, dcape: dcapeFrom(DCAPE_FINE) },
    profile: PROFILE_GFS,
  },
  aigfs: {
    name: 'AIGFS',
    label: 'AIGFS',
    sub: 'NOAA AI',
    group: 'global',
    credit: 'NOAA AIGFS via AWS Open Data',
    source: ncepSource({
      bucket: 'https://noaa-nws-graphcastgfs-pds.s3.amazonaws.com',
      files: {
        sfc: (r, s) => `aigfs.${r.date}/${r.hh}/model/atmos/grib2/aigfs.t${r.hh}z.sfc.f${p3(s)}.grib2`,
        prs: (r, s) => `aigfs.${r.date}/${r.hh}/model/atmos/grib2/aigfs.t${r.hh}z.pres.f${p3(s)}.grib2`,
      },
      listing: {
        sfc: { prefix: (r) => `aigfs.${r.date}/${r.hh}/model/atmos/grib2/aigfs.t${r.hh}z.sfc.f`, re: /\.f(\d{3})\.grib2\.idx$/ },
        prs: { prefix: (r) => `aigfs.${r.date}/${r.hh}/model/atmos/grib2/aigfs.t${r.hh}z.pres.f`, re: /\.f(\d{3})\.grib2\.idx$/ },
      },
      cycle: 6,
      search: 36,
      maxRuns: 4,
      steps: () => range(0, 384, 6),
      levels: [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50],
      params: ['2t', '2d', '10u', '10v', 'msl', 'sp', 'tp', 't', 'gh', 'u', 'v', 'q'],
    }),
    derived: { vo: vortFromWinds, tprate: tprateFromTp6, ptype: ptypeProfile, r: rFromQ, dcape: dcapeFrom(DCAPE_GLOBAL) },
    notes: { ptype: 'type from temperature profile', tprate: '6 h mean' },
    profile: PROFILE_GLOBAL,
  },
  icon: {
    name: 'DWD ICON',
    label: 'ICON',
    sub: 'DWD',
    group: 'global',
    credit: 'DWD ICON via Open-Meteo (CC-BY-4.0)',
    source: openMeteoSource({
      domain: 'dwd_icon',
      // hourly to 78 h, then 3-hourly to 180 h (00/12 UTC) or 120 h (06/18 UTC)
      steps: (hour) => [...range(0, 78, 1), ...range(81, hour % 12 === 0 ? 180 : 120, 3)],
      levels: [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50],
      params: ICON_PARAMS,
    }),
    derived: {
      '2d': {
        needs: () => ({ t: { param: '2t' }, rh: { param: 'rh2' } }),
        make: ({ t, rh }) => dewpointFromRh(t.values, rh.values),
      },
      vo: vortFromWinds,
      // The F000 (analysis) file has no precipitation, snowfall or weather code:
      // totals, rates and types are zero there.
      ptype: { zeroAtStart: true, needs: () => ({ c: { param: 'wcode' } }), make: ({ c }) => ptypeFromWmo(c.values) },
      // Interval totals summed into totals since F000 (see DataSource).
      tp: { sum: 'precip', scale: 1e-3, zeroAtStart: true },
      sf: { sum: 'snowfall', scale: 1e-3, zeroAtStart: true },
      tprate: {
        zeroAtStart: true,
        needs: () => ({ p: { param: 'precip' } }),
        make: ({ p }, ctx) => {
          const hours = Math.max(1, ctx.step - ctx.prevStep);
          const out = new Float32Array(p.values.length);
          for (let i = 0; i < out.length; i++) out[i] = Math.max(0, p.values[i] || 0) / hours / 3600;
          return out;
        },
      },
    },
    notes: { ptype: 'type from weather code', tprate: 'interval mean' },
  },
  gdps: {
    name: 'CMC GDPS',
    label: 'GDPS',
    sub: 'CMC',
    group: 'global',
    credit: 'ECCC MSC Datamart (Open Government Licence – Canada)',
    source: mscSource({
      model: 'gdps',
      // Every field 3-hourly to 240 h (the hours in between carry only some surface fields)
      steps: () => range(0, 240, 3),
      levels: UPPER,
      paramLevels: { vo: [850, 700, 500, 250, 200] },
      profileLevels: PROFILE_GDPS,
      params: GDPS_PARAMS,
    }),
    derived: { vo: vortFromWinds, dcape: dcapeFrom(DCAPE_FINE) }, // vorticity computed only where it isn't published
    profile: PROFILE_GDPS,
  },

  // Ensembles: `members` lists what can be shown — the mean (published, or
  // averaged here from every member), the control (member 0) and members 1..count.
  // ENS and AIFS ENS are 'computed' but take ECMWF's own mean for the few fields
  // it publishes (`publishedMean`, see sources.js).
  gefs: {
    name: 'GEFS',
    label: 'GEFS',
    sub: 'NOAA · 31',
    group: 'ensemble',
    credit: 'NOAA GEFS via AWS Open Data',
    members: { mean: 'published', control: true, count: 30 },
    source: ncepSource({
      bucket: 'https://noaa-gefs-pds.s3.amazonaws.com',
      files: { sfc: (r, s, m) => `gefs.${r.date}/${r.hh}/atmos/pgrb2ap5/${gefsFile(m)}.t${r.hh}z.pgrb2a.0p50.f${p3(s)}` },
      listing: {
        sfc: { prefix: (r) => `gefs.${r.date}/${r.hh}/atmos/pgrb2ap5/geavg.t${r.hh}z.pgrb2a.0p50.f`, re: /\.f(\d{3})\.idx$/ },
      },
      cycle: 6,
      search: 36,
      maxRuns: 4,
      steps: () => [...range(0, 240, 3), ...range(246, 384, 6)],
      levels: NCEP_ENS_LEVELS,
      paramLevels: { t: NO_300, r: NO_300 },
      params: ['2t', 'rh2', '10u', '10v', 'mucape', 'mucin', 'msl', 'sp', 'apcp', 'tcc', ...NCEP_PTYPE, 't', 'gh', 'u', 'v', 'r'],
      overrides: {
        mucape: { l: '180-0 mb above ground' },
        mucin: { l: '180-0 mb above ground' },
        // Cloud cover and precip-type flags are averages over the last interval.
        tcc: { t: /fcst$/ },
        ...Object.fromEntries(NCEP_PTYPE.map((p) => [p, { t: /fcst$/ }])),
      },
    }),
    derived: {
      '2d': dewpointFromRh2,
      vo: vortFromWinds,
      tp: tpFromBuckets(6),
      sf: sfFromBuckets(6), // snowfall maps and probabilities; the mean averages the members
      tprate: tprateFromBucket(6),
      ptype: { ...ptypeCategorical, zeroAtStart: true }, // F000 has no precip-type flags
      dcape: dcapeFrom(DCAPE_ENS),
    },
    notes: { tprate: 'mean over the latest 3–6 h', sf: '10:1, precipitation × snow flag' },
    profile: PROFILE_ENS,
  },
  ens: {
    name: 'ECMWF ENS',
    label: 'ENS',
    sub: 'ECMWF · 50',
    group: 'ensemble',
    credit: 'ECMWF open data (CC-BY-4.0)',
    members: { mean: 'computed', control: false, count: 50 },
    source: ecmwfSource({
      dir: 'ifs',
      stream: 'enfo',
      types: ['ef'],
      publishedMean: true,
      steps: (hour) => [...range(0, 144, 3), ...(hour % 12 === 0 ? range(150, 360, 6) : [])],
      levels: UPPER,
      params: ['2t', '2d', '10u', '10v', '10fg', 'mucape', 'msl', 'sp', 'tp', 'sf', 'tprate', 'ptype', 'tcc', 'lcc', 'mcc', 'hcc', 't', 'gh', 'u', 'v', 'vo', 'r'],
    }),
    derived: { dcape: dcapeFrom(DCAPE_GLOBAL) },
    profile: PROFILE_GLOBAL,
  },
  aifsens: {
    name: 'ECMWF AIFS ENS',
    label: 'AIFS ENS',
    sub: 'ECMWF AI · 51',
    group: 'ensemble',
    credit: 'ECMWF open data (CC-BY-4.0)',
    members: { mean: 'computed', control: true, count: 50 },
    source: ecmwfSource({
      dir: 'aifs-ens',
      stream: 'enfo',
      types: ['cf', 'pf'],
      publishedMean: true,
      steps: () => range(0, 360, 6),
      levels: UPPER,
      params: ['2t', '2d', '10u', '10v', 'msl', 'sp', 'tp', 'sf', 'tcc', 'lcc', 'mcc', 'hcc', 't', 'gh', 'u', 'v', 'q'],
      aliases: { gh: { param: 'z', scale: 1 / 9.80665 } }, // geopotential → geopotential height
    }),
    derived: { vo: vortFromWinds, tprate: tprateFromTp6, ptype: ptypeProfile, r: rFromQ, dcape: dcapeFrom(DCAPE_GLOBAL) },
    notes: { ptype: 'type from temperature profile', tprate: '6 h mean' },
    profile: PROFILE_GLOBAL,
  },
  geps: {
    name: 'CMC GEPS',
    label: 'GEPS',
    sub: 'CMC · 21',
    group: 'ensemble',
    credit: 'ECCC MSC Datamart (Open Government Licence – Canada)',
    members: { mean: 'computed', control: true, count: 20 },
    source: mscSource({
      steps: () => [...range(0, 192, 3), ...range(198, 384, 6)],
      levels: NCEP_ENS_LEVELS,
      paramLevels: { t: NO_300, r: NO_300 },
      params: GEPS_PARAMS,
    }),
    derived: { '2d': dewpointFromRh2, vo: vortFromWinds, tprate: tprateFromTp6, ptype: ptypeProfile, dcape: dcapeFrom(DCAPE_ENS) },
    notes: { ptype: 'type from temperature profile', tprate: '6 h mean' },
    profile: PROFILE_ENS,
  },
  refs: {
    name: 'REFS',
    label: 'REFS',
    sub: 'CONUS 3 km',
    group: 'ensemble',
    regional: true,
    credit: 'NOAA REFS via AWS Open Data',
    members: { mean: 'published', control: false, count: 5 },
    source: ncepSource({
      bucket: 'https://noaa-rrfs-ops-pds.s3.amazonaws.com',
      files: {
        sfc: (r, s) => `refs.${r.date}/${r.hh}/ensprod/refs.t${r.hh}z.mean.f${p2(s)}.conus.grib2`,
        // Reflectivity only as a probability-matched mean
        pmm: (r, s) => `refs.${r.date}/${r.hh}/ensprod/refs.t${r.hh}z.pmmn.f${p2(s)}.conus.grib2`,
      },
      listing: {
        sfc: { prefix: (r) => `refs.${r.date}/${r.hh}/ensprod/refs.t${r.hh}z.mean.f`, re: /\.f(\d+)\.conus\.grib2\.idx$/ },
      },
      cycle: 6,
      search: 30,
      maxRuns: 4,
      steps: () => range(1, 60, 1),
      levels: [925, 850, 700, 500, 250],
      params: ['2t', '2d', '10u', '10v', 'sbcape', 'mlcape', 'mucape', 'sbcin', 'mlcin', 'mucin', 'srh3', 'msl', 'apcp', 'tprate', 'refc', 'tcc', 'lcc', 'mcc', 'hcc', 'vis', ...NCEP_PTYPE, 't', 'gh', 'u', 'v'],
      overrides: {
        msl: { v: 'MSLET' },
        mucape: { l: '180-0 mb above ground' },
        mucin: { l: '180-0 mb above ground' },
        refc: { file: 'pmm' },
        tprate: { v: 'APCP', l: 'surface', t: /^\d+-\d+ hour acc fcst$/, scale: 1 / 3600 }, // 1 h bucket as a mean rate
      },
      gridRelativeWinds: true,
      regrid: { res: 0.03 },
    }),
    derived: {
      vo: vortFromWinds,
      tp: tpFromBuckets(1),
      ptype: ptypeCategorical,
    },
    notes: { tprate: '1 h mean', refc: 'probability-matched mean' },
    // Single members are the RRFS ensemble's own files, which carry much more than the
    // ensemble products: every pressure level (so soundings), helicity, shear, lightning.
    member: {
      source: ncepSource({
        bucket: 'https://noaa-rrfs-ops-pds.s3.amazonaws.com',
        files: {
          sfc: (r, s, m) => `rrfsens.${r.date}/${r.hh}/${refsMember(m)}/rrfs.t${r.hh}z.${refsMember(m)}.2dfldnomads.3km.f${p3(s)}.conus.grib2`,
          prs: (r, s, m) => `rrfsens.${r.date}/${r.hh}/${refsMember(m)}/rrfs.t${r.hh}z.${refsMember(m)}.prslevnomads.3km.f${p3(s)}.conus.grib2`,
        },
        levels: [1000, 925, 850, 700, 600, 500, 400, 300, 250],
        profileLevels: PROFILE_REFS,
        params: ['2t', '2d', '10u', '10v', '10fg', 'sbcape', 'sbcin', 'srh1', 'srh3', 'ush6', 'vsh6', 'ltng', 'sp', 'msl', 'tp', 'tprate', 'refc', 'tcc', 'lcc', 'mcc', 'hcc', 'vis', ...NCEP_PTYPE, ...NCEP_UPPER, 'q'],
        overrides: {
          msl: { v: 'MSLET' },
          tprate: { v: 'APCP', l: 'surface', t: (s) => new RegExp(`^${s - 1}-${s} hour acc fcst$`), scale: 1 / 3600 }, // 1 h bucket as a mean rate
        },
        gridRelativeWinds: true,
        regrid: { res: 0.03 },
      }),
      derived: {
        vo: vortFromAbsv,
        ptype: ptypeCategorical,
        dcape: dcapeFrom(DCAPE_FINE),
      },
      notes: { tprate: '1 h mean', ltng: 'max over the past hour' },
      profile: PROFILE_REFS,
    },
  },

  hrrr: {
    name: 'HRRR',
    label: 'HRRR',
    sub: 'CONUS 3 km',
    group: 'regional',
    regional: true,
    credit: 'NOAA HRRR via AWS Open Data',
    source: ncepSource({
      bucket: 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com',
      files: {
        sfc: (r, s) => `hrrr.${r.date}/conus/hrrr.t${r.hh}z.wrfsfcf${p2(s)}.grib2`,
        prs: (r, s) => `hrrr.${r.date}/conus/hrrr.t${r.hh}z.wrfprsf${p2(s)}.grib2`,
      },
      listing: {
        sfc: { prefix: (r) => `hrrr.${r.date}/conus/hrrr.t${r.hh}z.wrfsfcf`, re: /wrfsfcf(\d{2})\.grib2\.idx$/ },
        prs: { prefix: (r) => `hrrr.${r.date}/conus/hrrr.t${r.hh}z.wrfprsf`, re: /wrfprsf(\d{2})\.grib2\.idx$/ },
      },
      cycle: 1,
      search: 8,
      maxRuns: 6,
      steps: (hour) => range(0, hour % 6 === 0 ? 48 : 18, 1),
      levels: UPPER.slice(0, -1),
      profileLevels: PROFILE_HIRES,
      params: [...NCEP_SURFACE, ...HIRES_SEVERE, ...NCEP_PTYPE, ...NCEP_UPPER],
      overrides: { msl: { v: 'MSLMA' } },
      gridRelativeWinds: true,
      regrid: { res: 0.03 },
    }),
    derived: { vo: vortFromAbsv, ptype: ptypeCategorical, dcape: dcapeFrom(DCAPE_FINE) },
    profile: PROFILE_HIRES,
  },
  rrfs: {
    name: 'RRFS',
    label: 'RRFS',
    sub: 'CONUS 3 km',
    group: 'regional',
    regional: true,
    credit: 'NOAA RRFS via AWS Open Data',
    notes: { ltng: 'max over the past hour' },
    // RRFS runs every hour, but only the 00/03/06/.../21 UTC cycles publish full
    // output (2dfld + prslev); the runs in between are listed with view: 'hourly'
    // and read through views.hourly below.
    source: withRuns(RRFS_FULL, RRFS_HOURLY, 'hourly'),
    derived: { vo: vortFromAbsv, ptype: ptypeCategorical, dcape: dcapeFrom(DCAPE_FINE) },
    profile: PROFILE_HIRES,
    views: {
      hourly: { source: RRFS_HOURLY, derived: { ptype: ptypeCategorical }, notes: {}, profile: null },
    },
  },
  rap: {
    name: 'RAP',
    label: 'RAP',
    sub: 'N. America 13 km',
    group: 'regional',
    regional: true,
    credit: 'NOAA RAP via AWS Open Data',
    source: ncepSource({
      bucket: 'https://noaa-rap-pds.s3.amazonaws.com',
      files: { sfc: (r, s) => `rap.${r.date}/rap.t${r.hh}z.wrfprsf${p2(s)}.grib2` },
      listing: { sfc: { prefix: (r) => `rap.${r.date}/rap.t${r.hh}z.wrfprsf`, re: /wrfprsf(\d{2})\.grib2\.idx$/ } },
      cycle: 1,
      search: 8,
      maxRuns: 6,
      steps: (hour) => range(0, hour % 6 === 3 ? 51 : 21, 1),
      levels: UPPER.slice(0, -1),
      profileLevels: PROFILE_HIRES,
      params: [...NCEP_SURFACE, ...HIRES_SEVERE, ...NCEP_PTYPE, ...NCEP_UPPER],
      overrides: { msl: { v: 'MSLMA' } },
      gridRelativeWinds: true,
      // The native rotated grid reaches over the pole; keep North America.
      regrid: { res: 0.12, clip: { south: 10, north: 75, west: -175, east: -45 } },
    }),
    derived: { vo: vortFromAbsv, ptype: ptypeCategorical, dcape: dcapeFrom(DCAPE_FINE) },
    profile: PROFILE_HIRES,
  },
  nbm: {
    name: 'NBM',
    label: 'NBM',
    sub: 'CONUS 2.5 km',
    group: 'regional',
    regional: true,
    credit: 'NOAA National Blend of Models via AWS Open Data',
    source: ncepSource({
      bucket: 'https://noaa-nbm-grib2-pds.s3.amazonaws.com',
      files: { sfc: (r, s) => `blend.${r.date}/${r.hh}/core/blend.t${r.hh}z.core.f${p3(s)}.co.grib2` },
      listing: { sfc: { prefix: (r) => `blend.${r.date}/${r.hh}/core/blend.t${r.hh}z.core.f`, re: /\.f(\d{3})\.co\.grib2\.idx$/ } },
      cycle: 1,
      search: 8,
      maxRuns: 6,
      steps: nbmSteps,
      levels: [],
      params: ['2t', '2d', 'rh2', 'vis', ...Object.keys(NBM_PARAMS)],
      overrides: NBM_PARAMS,
      extra: '',
      regrid: { res: 0.03 },
    }),
    derived: {
      tp: nbmTotal('tp', 'apcp1', 'apcp6'),
      sf: nbmTotal('sf', 'asnow1', 'asnow6', 0.1), // snow depth → water at 10:1, so the 10:1 map shows NBM's own snowfall
      ptype: nbmPtypeRecipe,
    },
    totalAt: nbmTotalAt,
    notes: { tprate: '1 h mean', ptype: 'most likely type', sf: "NBM's own snow ratios" },
  },
  woofnam: {
    name: 'WOOF-NAM',
    label: 'WOOF-NAM',
    sub: 'N. America 12 km',
    group: 'regional',
    regional: true,
    credit: 'WOOF-NAM by Recast (CC BY 4.0) · not an official NOAA/NWS forecast',
    source: ncepSource({
      bucket: WOOF_NAM,
      files: { sfc: (r, s) => `woof-nam/12km/${r.date}/${r.hh}z/woof-nam.t${r.hh}z.awphys${p2(s)}.tm00.grib2` },
      stepsOf: woofNamSteps,
      cycle: 6,
      search: 36,
      maxRuns: 4,
      steps: () => range(0, 84, 1),
      // Every 25 hPa from 1000 to 50 hPa, all in the one file
      levels: UPPER.slice(0, -1),
      profileLevels: PROFILE_HIRES,
      // No categorical precip type, lightning, low/mid/high cloud, 90 hPa mixed-layer
      // parcel or 0–1 km helicity; absolute vorticity only on a few levels.
      params: ['2t', '2d', '10u', '10v', '10fg', 'sbcape', 'mucape', 'sbcin', 'mucin', 'srh3', 'ush6', 'vsh6', 'msl', 'sp', 'apcp', 'refc', 'tcc', 't', 'gh', 'u', 'v', 'r'],
      overrides: {
        msl: { v: 'MSLET' },
        mucape: { l: '180-0 mb above ground' },
        mucin: { l: '180-0 mb above ground' },
      },
      gridRelativeWinds: true,
      regrid: { res: 0.1 },
    }),
    derived: {
      vo: vortFromWinds,
      // APCP restarts every 12 h (0-1 … 0-12, 12-13 … 12-24, …), as in NOAA's NAM.
      tp: tpFromBuckets(12),
      tprate: tprateFromBuckets(12),
      ptype: ptypeProfile,
      dcape: dcapeFrom(DCAPE_FINE),
    },
    notes: { ptype: 'type from temperature profile', tprate: '1 h mean' },
    profile: PROFILE_HIRES,
  },
};

export const MODEL_IDS = Object.keys(MODELS);

/** Selectable members of an ensemble model ([] for deterministic models). */
export function membersOf(modelId) {
  const e = MODELS[modelId].members;
  if (!e) return [];
  const out = [{ id: 'mean', label: e.mean === 'computed' ? `Mean (of ${e.count + (e.control ? 1 : 0)})` : 'Mean' }];
  if (e.control) out.push({ id: '0', label: 'Control' });
  for (let i = 1; i <= e.count; i++) out.push({ id: String(i), label: `Member ${i}` });
  return out;
}

const memberViews = new Map();
/**
 * A model's catalogue entry as one ensemble member, or one kind of run, sees it.
 * Usually the model itself; a model with a `member` section (REFS) reads single
 * members from other files than its mean, with their own params, recipes and
 * sounding levels, and a run tagged with a `view` (RRFS's surface-only hourly
 * runs) reads through that entry of the model's `views`.
 * @param {string|null} [member] 'mean', '0' control, '1'.., a view name, or null
 */
export function modelFor(modelId, member) {
  const m = MODELS[modelId];
  const key = `${modelId}/${member}`;
  if (m.views?.[member]) {
    if (!memberViews.has(key)) memberViews.set(key, { ...m, ...m.views[member] });
    return memberViews.get(key);
  }
  if (!m.member || member == null || !/^\d+$/.test(member)) return m;
  if (!memberViews.has(key)) memberViews.set(key, { ...m, ...m.member });
  return memberViews.get(key);
}

/** Whether a model (or one of its members) has soundings and cross sections (temperature, height, wind and humidity on levels). */
export function hasProfiles(modelId, member) {
  const levels = modelFor(modelId, member).profile;
  return !!levels && ['sp', '2t', '2d', '10u', '10v'].every((p) => supports(modelId, p, undefined, member)) &&
    levels.every((l) => ['t', 'gh', 'u', 'v', 'r'].every((p) => supports(modelId, p, l, member)));
}

/** The members an ensemble probability is counted over: the control and every perturbed member. */
export function ensembleMembers(modelId) {
  return membersOf(modelId).filter((m) => m.id !== 'mean').map((m) => m.id);
}

/**
 * The recipe a param is computed with, or null when it's read as published: a
 * field the model publishes is always read rather than computed (GDPS publishes
 * vorticity on five levels and is computed from winds only on the others).
 */
export function recipeFor(modelId, param, level, member) {
  const m = modelFor(modelId, member);
  const recipe = m.derived[param];
  if (!recipe || recipe.sum) return recipe ?? null;
  return m.source.has(param, level ?? undefined) ? null : recipe;
}

/** Whether a model (or one of its members) can provide a param (directly or via a recipe). */
export function supports(modelId, param, level, member) {
  const prob = parseProb(param);
  if (prob) {
    // Counted over the members, whatever member is picked: ask what one of them publishes.
    const one = ensembleMembers(modelId)[0];
    if (!one) return false;
    const has = (p, l) => supports(modelId, p, l, one);
    const spec = prob.kind.inputs(has);
    return !!spec && Object.values(spec).every((x) => has(x.param, x.level));
  }
  const m = modelFor(modelId, member);
  const recipe = recipeFor(modelId, param, level, member);
  if (recipe?.sum) return m.source.has(recipe.sum);
  if (recipe) return Object.values(recipe.needs(level, {})).every((s) => supports(modelId, s.param, s.level, member));
  return m.source.has(param, level ?? undefined);
}
