// Upstream data access, entirely from the browser: run discovery from public S3
// bucket listings, GRIB index files for byte ranges, and the decode jobs the
// worker runs. Every bucket used here serves CORS headers (Access-Control-
// Allow-Origin: *, Range allowed), so no server or proxy is needed.

const range = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
export { range };
const pad = (n, w) => String(n).padStart(w, '0');

// ---------------------------------------------------------------------------
// Fetching with retries

const RETRY = new Set([429, 500, 502, 503, 504]);

/**
 * fetch() that rides out throttling and tries mirrors. S3 answers "503 Slow
 * Down" without CORS headers, which the browser reports as a network error,
 * so network errors are retried too. A 404 moves on to the next mirror.
 * @param {string|string[]} urls one URL or mirrors of the same file, in order of preference
 */
export async function fetchRetry(urls, init, tries = 4) {
  const list = Array.isArray(urls) ? urls : [urls];
  let last = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    let missing = null;
    for (const url of list) {
      try {
        const res = await fetch(url, init);
        if (res.ok) return res;
        if (!RETRY.has(res.status)) missing ??= res;
        else last = new Error(`HTTP ${res.status} for ${url.split('/').pop()}`);
      } catch (err) {
        last = err;
      }
    }
    if (missing) return missing;
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 400));
  }
  throw last?.message === 'Failed to fetch' ? new Error(`${new URL(list[0]).host} is not responding (throttled or offline)`) : last;
}

// ---------------------------------------------------------------------------
// S3 listing

/** All keys under a prefix (follows continuation tokens). Works for S3 and GCS. */
export async function listKeys(bucket, prefix) {
  const keys = [];
  let token = '';
  do {
    const url = `${bucket}/?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
    const res = await fetchRetry(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} listing ${prefix}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    token = /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? '';
  } while (token);
  return keys;
}

/**
 * Newest runs with at least one step, found by checking cycles backwards from now.
 * @param {(run: {date: string, hh: string, hour: number, time: number}) => Promise<number[]>} stepsOf
 */
async function discoverRuns({ cycle, search, maxRuns, expected, stepsOf, cache }) {
  const now = Date.now();
  const t0 = Math.floor(now / (cycle * 3600e3)) * cycle * 3600e3;
  const candidates = [];
  for (let h = 0; h <= search; h += cycle) {
    const d = new Date(t0 - h * 3600e3);
    const date = d.toISOString().slice(0, 10).replaceAll('-', '');
    const hh = pad(d.getUTCHours(), 2);
    candidates.push({ id: date + hh, date, hh, hour: d.getUTCHours(), time: d.getTime() });
  }
  const found = [];
  for (let i = 0; i < candidates.length && found.length < maxRuns; i += 3) {
    const batch = await Promise.all(
      candidates.slice(i, i + 3).map(async (run) => {
        const want = expected(run.hour);
        const hit = cache.get(run.id);
        // Finished runs never change; re-list unfinished ones at most every 90 s.
        if (hit && (hit.complete || now - hit.checked < 90e3)) return hit;
        let steps;
        try {
          steps = new Set(await stepsOf(run));
        } catch {
          return hit ?? null;
        }
        const have = want.filter((s) => steps.has(s));
        const entry = {
          id: run.id,
          date: run.date,
          hour: run.hour,
          steps: have,
          expected: want,
          complete: have.length === want.length,
          checked: now,
        };
        cache.set(run.id, entry);
        return entry;
      }),
    );
    found.push(...batch.filter((r) => r && r.steps.length));
  }
  return found.slice(0, maxRuns);
}

const stepsFromKeys = (keys, re) => keys.map((k) => re.exec(k)?.[1]).filter(Boolean).map(Number);

// ---------------------------------------------------------------------------
// NCEP models (GFS, AIGFS, HRRR, RAP, RRFS): wgrib2-style .idx files

const INST = /^(anl|\d+ (hour|day) fcst)$/;
const ACC0 = /^0-\d+ (hour|day) acc fcst$/;
const mb = (lvl) => `${lvl} mb`;

/** Canonical (ECMWF-style) parameter names → NCEP variable/level/time. */
export const NCEP_PARAMS = {
  '2t': { v: 'TMP', l: '2 m above ground' },
  '2d': { v: 'DPT', l: '2 m above ground' },
  '10u': { v: 'UGRD', l: '10 m above ground', pair: '10v' },
  '10v': { v: 'VGRD', l: '10 m above ground', pair: '10u' },
  '10fg': { v: 'GUST', l: 'surface' },
  sbcape: { v: 'CAPE', l: 'surface' },
  mlcape: { v: 'CAPE', l: '90-0 mb above ground' },
  mucape: { v: 'CAPE', l: '255-0 mb above ground' },
  sbcin: { v: 'CIN', l: 'surface' },
  mlcin: { v: 'CIN', l: '90-0 mb above ground' },
  mucin: { v: 'CIN', l: '255-0 mb above ground' },
  srh1: { v: 'HLCY', l: '1000-0 m above ground' },
  srh3: { v: 'HLCY', l: '3000-0 m above ground' },
  ush6: { v: 'VUCSH', l: '0-6000 m above ground' }, // 0–6 km shear components
  vsh6: { v: 'VVCSH', l: '0-6000 m above ground' },
  ltng: { v: 'LTNG', l: /^(entire atmosphere|surface)$/, t: /fcst$/ }, // RRFS: max over the past hour
  msl: { v: 'PRMSL', l: 'mean sea level' },
  sp: { v: 'PRES', l: 'surface' },
  tp: { v: 'APCP', l: 'surface', t: ACC0, scale: 1e-3, zeroAtStart: true }, // kg m⁻² → m
  apcp: { v: 'APCP', l: 'surface', t: /^\d+-\d+ hour acc fcst$/, scale: 1e-3 }, // latest bucket (GEFS 6 h, REFS 1 h), m
  rh2: { v: 'RH', l: '2 m above ground' },
  tprate: { v: 'PRATE', l: 'surface' },
  refc: { v: 'REFC', l: /^entire atmosphere/ },
  tcc: { v: 'TCDC', l: /^entire atmosphere/, scale: 0.01 },
  lcc: { v: 'LCDC', l: 'low cloud layer', scale: 0.01 },
  mcc: { v: 'MCDC', l: 'middle cloud layer', scale: 0.01 },
  hcc: { v: 'HCDC', l: 'high cloud layer', scale: 0.01 },
  crain: { v: 'CRAIN', l: 'surface' },
  csnow: { v: 'CSNOW', l: 'surface' },
  cfrzr: { v: 'CFRZR', l: 'surface' },
  cicep: { v: 'CICEP', l: 'surface' },
  t: { v: 'TMP', l: mb, upper: true },
  gh: { v: 'HGT', l: mb, upper: true },
  u: { v: 'UGRD', l: mb, upper: true, pair: 'v' },
  v: { v: 'VGRD', l: mb, upper: true, pair: 'u' },
  absv: { v: 'ABSV', l: mb, upper: true },
  r: { v: 'RH', l: mb, upper: true },
  q: { v: 'SPFH', l: mb, upper: true },
};

function parseIdx(text) {
  const rows = text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split(':');
      return { v: f[3], l: f[4], t: f[5], offset: Number(f[1]) };
    });
  rows.forEach((r, i) => {
    const next = rows.slice(i + 1).find((n) => n.offset > r.offset);
    r.end = next ? next.offset - 1 : null;
  });
  return rows;
}

const scaled = (k) =>
  k && k !== 1
    ? (v) => {
        for (let i = 0; i < v.length; i++) v[i] *= k;
      }
    : null;

const matches = (want, got) => (want instanceof RegExp ? want.test(got) : want === got);

/**
 * @param {object} cfg
 * @param {string} cfg.bucket
 * @param {Record<string, (r: object, step: number, member: string|null) => string>} cfg.files file key per kind ('sfc', 'prs', ...)
 * @param {Record<string, {prefix: (r: object) => string, re: RegExp}>} cfg.listing
 * @param {number[]} cfg.levels pressure levels published
 * @param {Record<string, number[]>} [cfg.paramLevels] per-param levels, where they differ from `levels`
 * @param {number[]} [cfg.profileLevels] extra levels read for soundings and cross sections
 * @param {string[]} cfg.params canonical params published
 * @param {object} [cfg.overrides] per-param changes to NCEP_PARAMS
 * @param {{res: number, clip?: object}} [cfg.regrid] projected grids only
 */
export function ncepSource(cfg) {
  const idxCache = new Map();
  const runCache = new Map();
  const defs = Object.fromEntries(cfg.params.map((p) => [p, { ...NCEP_PARAMS[p], ...cfg.overrides?.[p] }]));
  const levelsOf = (param) => [...(cfg.paramLevels?.[param] ?? cfg.levels), ...(cfg.profileLevels ?? [])];
  const idx = (url) => {
    if (!idxCache.has(url)) {
      idxCache.set(
        url,
        fetchRetry(`${url}.idx`).then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('/').pop()}.idx`);
          return parseIdx(await res.text());
        }),
      );
      idxCache.get(url).catch(() => idxCache.delete(url));
      while (idxCache.size > 400) idxCache.delete(idxCache.keys().next().value);
    }
    return idxCache.get(url);
  };
  const runOf = (id) => ({ date: id.slice(0, 8), hh: id.slice(8, 10), hour: Number(id.slice(8, 10)) });
  const fileUrl = (def, runId, step, member) => {
    const kind = def.file ?? (def.upper ? 'prs' : 'sfc');
    return `${cfg.bucket}/${(cfg.files[kind] ?? cfg.files.sfc)(runOf(runId), step, member)}`;
  };
  const find = async (def, runId, step, level, member) => {
    const url = fileUrl(def, runId, step, member);
    const rows = await idx(url);
    const lvl = typeof def.l === 'function' ? def.l(level) : def.l;
    const time = def.t ?? INST;
    const row = rows.find((r) => r.v === def.v && matches(lvl, r.l) && time.test(r.t));
    if (!row) throw new Error(`${def.v} ${typeof lvl === 'string' ? lvl : ''} not in F${pad(step, 3)}`);
    return { url, range: [row.offset, row.end] };
  };

  return {
    levels: cfg.levels,
    has: (param, level) => !!defs[param] && (!defs[param].upper || levelsOf(param).includes(level)),
    zeroAtStart: (param) => !!defs[param]?.zeroAtStart,
    post: (param) => scaled(defs[param]?.scale),
    async job(runId, step, param, level, member = null) {
      if (!defs[param]) throw new Error(`${param} isn't published`);
      const def = defs[param];
      const main = await find(def, runId, step, level, member);
      const job = { kind: 'grib', ...main, regrid: cfg.regrid ?? null };
      // Grid-relative winds need both components to rotate them.
      if (def.pair && cfg.gridRelativeWinds) {
        const other = await find(defs[def.pair], runId, step, level, member);
        job.pair = { param: def.pair, url: other.url, range: other.range };
        job.isU = def.v === 'UGRD';
      }
      return job;
    },
    runs: () =>
      discoverRuns({
        cycle: cfg.cycle,
        search: cfg.search,
        maxRuns: cfg.maxRuns,
        expected: cfg.steps,
        cache: runCache,
        stepsOf: async (run) => {
          const lists = await Promise.all(
            Object.values(cfg.listing).map(async ({ prefix, re }) => new Set(stepsFromKeys(await listKeys(cfg.bucket, prefix(run)), re))),
          );
          return [...lists[0]].filter((s) => lists.every((l) => l.has(s)));
        },
      }),
  };
}

// ---------------------------------------------------------------------------
// ECMWF open data (IFS, AIFS, and their ensembles): JSON-lines .index files.
// Google Cloud's mirror first: the AWS mirror throttles hard ("503 Slow Down",
// without CORS headers) and ECMWF's own server rate-limits, so it's the fallback.

const ECMWF_MIRRORS = ['https://storage.googleapis.com/ecmwf-open-data', 'https://data.ecmwf.int/forecasts'];

// Cloud cover in % under WMO codes (AIFS); ECMWF's local codes (IFS) are fractions.
const PERCENT_CLOUD = new Set([1, 3, 4, 5]);

/**
 * @param {object} cfg
 * @param {string} cfg.dir 'ifs', 'aifs-single', 'aifs-ens'
 * @param {'oper'|'enfo'} [cfg.stream]
 * @param {string[]} [cfg.types] file types per step: ['fc'] (oper), ['ef'] (IFS ENS), ['cf', 'pf'] (AIFS ENS)
 * @param {Record<string, {param: string, scale: number}>} [cfg.aliases] canonical param → published param
 */
export function ecmwfSource({ dir, stream = 'oper', types = ['fc'], steps, levels, params, aliases = {} }) {
  const idxCache = new Map();
  const runCache = new Map();
  const runDir = (date, hh) => `${date}/${hh}z/${dir}/0p25/${stream}`;
  const stem = (runId, step, type) => {
    const date = runId.slice(0, 8);
    const hh = runId.slice(8, 10);
    return `${runDir(date, hh)}/${date}${hh}0000-${step}h-${stream}-${type}`;
  };
  const mirrors = (path) => ECMWF_MIRRORS.map((m) => `${m}/${path}`);
  const indexOf = (runId, step, type) =>
    fetchRetry(mirrors(`${stem(runId, step, type)}.index`)).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for the F${pad(step, 3)} index`);
      return (await res.text())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .map((e) => ({
          param: e.param,
          levtype: e.levtype,
          level: e.levelist ?? null,
          member: e.number ?? '0',
          type,
          offset: e._offset,
          length: e._length,
        }));
    });
  const index = (runId, step) => {
    const key = `${runId}/${step}`;
    if (!idxCache.has(key)) {
      idxCache.set(key, Promise.all(types.map((t) => indexOf(runId, step, t))).then((lists) => lists.flat()));
      idxCache.get(key).catch(() => idxCache.delete(key));
      while (idxCache.size > 400) idxCache.delete(idxCache.keys().next().value);
    }
    return idxCache.get(key);
  };
  const gribJob = (runId, step, e) => {
    const [url, ...alt] = mirrors(`${stem(runId, step, e.type)}.grib2`);
    return { kind: 'grib', url, alt, range: [e.offset, e.offset + e.length - 1] };
  };
  return {
    levels,
    has: (param, level) => params.includes(param) && (level == null || levels.includes(level)),
    zeroAtStart: () => false,
    post: (param) => {
      const k = aliases[param]?.scale;
      return (v, meta) => {
        const cloudPct = meta.discipline === 0 && meta.category === 6 && PERCENT_CLOUD.has(meta.number);
        const f = (k ?? 1) * (cloudPct ? 0.01 : 1);
        if (f !== 1) for (let i = 0; i < v.length; i++) v[i] *= f;
      };
    },
    /** member: null (deterministic), 'mean' (all members, averaged locally), or a member number. */
    async job(runId, step, param, level, member = null) {
      const entries = await index(runId, step);
      const src = aliases[param]?.param ?? param;
      const levtype = level ? 'pl' : 'sfc';
      const all = entries.filter((x) => x.param === src && x.levtype === levtype && (level ? x.level === String(level) : true));
      const what = `${param}${level ? ' @' + level : ''}`;
      if (member === 'mean') {
        if (!all.length) throw new Error(`${what} not in step ${step}`);
        // Precip type is categorical: take the most common type instead of a mean.
        return { kind: 'mean', reduce: param === 'ptype' ? 'mode' : 'mean', parts: all.map((e) => gribJob(runId, step, e)) };
      }
      const e = member == null ? all[0] : all.find((x) => x.member === member);
      if (!e) throw new Error(`${what}${member ? ` (member ${member})` : ''} not in step ${step}`);
      return gribJob(runId, step, e);
    },
    runs: () =>
      discoverRuns({
        cycle: 6,
        search: 60,
        maxRuns: 4,
        expected: steps,
        cache: runCache,
        stepsOf: async (run) =>
          stepsFromKeys(
            await listKeys(ECMWF_MIRRORS[0], `${runDir(run.date, run.hh)}/`),
            new RegExp(`-(\\d+)h-${stream}-${types[types.length - 1]}\\.index$`),
          ),
      }),
  };
}

// ---------------------------------------------------------------------------
// Canadian GEPS from the MSC Datamart. dd.weather.gc.ca sends no CORS headers,
// so requests go through a same-origin proxy (server/server.js locally,
// worker/index.js on Cloudflare). Each file holds one variable for
// all 21 members, JPEG 2000 packed.

const MSC_PROXY = 'proxy/msc';

/**
 * @param {object} cfg
 * @param {Record<string, {v: string, l: string|((level: number) => string), upper?: boolean, scale?: number, zeroAtStart?: boolean}>} cfg.params
 */
export function mscSource({ steps, levels, paramLevels = {}, params }) {
  const runCache = new Map();
  let proxyOk = null;
  // Absolute, since the decode workers resolve relative URLs against their own script.
  const proxy = () => new URL(MSC_PROXY, document.baseURI).href;
  const rawDir = (date, hh) => `${proxy()}/${date}/WXO-DD/ensemble/geps/grib2/raw/${hh}`;
  const levelsOf = (param) => paramLevels[param] ?? levels;
  const checkProxy = () =>
    (proxyOk ??= fetch(`${proxy()}/ping`)
      .then(async (res) => res.ok && (await res.text()).trim() === 'ok')
      .catch(() => false));
  return {
    levels,
    has: (param, level) => !!params[param] && (!params[param].upper || levelsOf(param).includes(level)),
    zeroAtStart: (param) => !!params[param]?.zeroAtStart,
    post: (param) => scaled(params[param]?.scale),
    async job(runId, step, param, level, member = 'mean') {
      const p = params[param];
      const date = runId.slice(0, 8);
      const hh = runId.slice(8, 10);
      const lvl = typeof p.l === 'function' ? p.l(level) : p.l;
      const f = pad(step, 3);
      return {
        kind: 'grib',
        url: `${rawDir(date, hh)}/${f}/CMC_geps-raw_${p.v}_${lvl}_latlon0p5x0p5_${runId}_P${f}_allmbrs.grib2`,
        range: null, // no index files: the whole file (all members) is read
        member: member === 'mean' ? 'mean' : Number(member ?? 0),
      };
    },
    async runs() {
      if (!(await checkProxy())) {
        throw new Error('GEPS needs the small MSC proxy (dd.weather.gc.ca has no CORS): run it with npm start or deploy on Cloudflare Pages');
      }
      return discoverRuns({
        cycle: 12,
        search: 48,
        maxRuns: 4,
        expected: steps,
        cache: runCache,
        stepsOf: async (run) => {
          const res = await fetchRetry(`${rawDir(run.date, run.hh)}/`);
          if (!res.ok) return [];
          return [...(await res.text()).matchAll(/href="(\d{3})\/"/g)].map((m) => Number(m[1]));
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Open-Meteo "spatial" files (DWD ICON, regridded to lat/lon by Open-Meteo):
// one .om file per valid time holding every variable.

const OPEN_METEO_BUCKET = 'https://openmeteo.s3.amazonaws.com';

export function openMeteoSource({ domain, steps, levels, params }) {
  const runCache = new Map();
  const base = `${OPEN_METEO_BUCKET}/data_spatial/${domain}`;
  const runPath = (id) => `${id.slice(0, 4)}/${id.slice(4, 6)}/${id.slice(6, 8)}/${id.slice(8, 10)}00Z`;
  const fileOf = (id, step) => {
    const t = new Date(Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8), +id.slice(8, 10)) + step * 3600e3);
    const iso = t.toISOString();
    return `${base}/${runPath(id)}/${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}.om`;
  };
  const variableOf = (param, level) => {
    const p = params[param];
    return typeof p.name === 'function' ? p.name(level) : p.name;
  };
  return {
    levels,
    has: (param, level) => !!params[param] && (!params[param].upper || levels.includes(level)),
    zeroAtStart: () => false,
    post: (param) => params[param]?.f ?? null,
    async job(runId, step, param, level) {
      return { kind: 'om', url: fileOf(runId, step), variable: variableOf(param, level) };
    },
    runs: () =>
      discoverRuns({
        cycle: 6,
        search: 48,
        maxRuns: 4,
        expected: steps,
        cache: runCache,
        stepsOf: async (run) => {
          const keys = await listKeys(OPEN_METEO_BUCKET, `data_spatial/${domain}/${runPath(run.id)}/`);
          return keys
            .map((k) => /(\d{4})-(\d\d)-(\d\d)T(\d\d)(\d\d)\.om$/.exec(k))
            .filter(Boolean)
            .map((m) => Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - run.time) / 3600e3));
        },
      }),
  };
}
