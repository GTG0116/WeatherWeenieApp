# Model Globe

A weather model viewer on a custom WebGL globe. It runs entirely in the browser: model
data is fetched straight from public cloud buckets and every GRIB2 field is decoded on
your machine with the app's own JavaScript decoder. There's no tile service or build
step, so the `public/` folder can be hosted as-is on GitHub Pages, Cloudflare Pages or any
static host. (The one exception is GEPS, which needs a tiny proxy; see below.)

## Models

| Model | Coverage | Steps | Source |
| --- | --- | --- | --- |
| ECMWF IFS (HRES) | Global 0.25° | 3-hourly to 144 h, 6-hourly to 360 h (00/12 UTC) | ECMWF open data, Google Cloud mirror |
| ECMWF AIFS | Global 0.25° | 6-hourly to 360 h | ECMWF open data, Google Cloud mirror |
| GFS | Global 0.25° | hourly to 120 h, 3-hourly to 384 h | NOAA `noaa-gfs-bdp-pds` |
| AIGFS (NOAA's AI GFS) | Global 0.25° | 6-hourly to 384 h | NOAA `noaa-nws-graphcastgfs-pds` |
| DWD ICON | Global (Open-Meteo lat/lon grid) | hourly to 78 h, 3-hourly to 180 h | Open-Meteo `openmeteo` bucket |
| HRRR | CONUS 3 km | hourly to 18 h (48 h at 00/06/12/18 UTC) | NOAA `noaa-hrrr-bdp-pds` |
| RRFS | CONUS 3 km | hourly runs: full output every 3 h (to 84 h at 00/06/12/18 UTC, 18 h at 03/09/15/21 UTC), surface fields only to 18 h in between | NOAA `noaa-rrfs-ops-pds` |
| RAP | North America 13 km | hourly to 21 h (51 h at 03/09/15/21 UTC) | NOAA `noaa-rap-pds` |
| WOOF-NAM (Recast's revived NAM) | North America 12 km (NCEP grid 218) | hourly to 84 h, 00/06/12/18 UTC | [woof-nam.recastsystems.com](https://woof-nam.recastsystems.com/index.html) (CC BY 4.0) |

### Ensembles

| Model | Members | Coverage | Steps | Mean | Source |
| --- | --- | --- | --- | --- | --- |
| GEFS | control + 30 | Global 0.5° | 3-hourly to 240 h, 6-hourly to 384 h | published | NOAA `noaa-gefs-pds` |
| ECMWF ENS | 50 | Global 0.25° | 3-hourly to 144 h, 6-hourly to 360 h (00/12 UTC) | ECMWF's for MSLP, T and Z on a few levels once the run is done; otherwise averaged in the browser | ECMWF open data, Google Cloud mirror |
| ECMWF AIFS ENS | control + 50 | Global 0.25° | 6-hourly to 360 h | ECMWF's for 2 m temperature, MSLP, T and Z on a few levels once the run is done; otherwise averaged in the browser | ECMWF open data, Google Cloud mirror |
| CMC GEPS | control + 20 | Global 0.5° | 3-hourly to 192 h, 6-hourly to 384 h | averaged in the browser | MSC Datamart, via a small proxy |
| REFS | 5 | CONUS 3 km | hourly to 60 h | published (reflectivity as PMM) | NOAA `noaa-rrfs-ops-pds` (members from `rrfsens.*`) |

With an ensemble selected, a **Member** picker appears under the run: the mean (default),
the control, or any single member. ECMWF publishes its own ENS and AIFS ENS mean (the `em`
fields of [Set III](https://www.ecmwf.int/en/forecasts/datasets/set-iii) and
[Set X](https://www.ecmwf.int/en/forecasts/datasets/set-x)) for only a few fields, packed
into the open data's probability files (`…-240h-enfo-ep` for steps 0–240,
`…-360h-enfo-ep` for 246–360) once the whole run is done: mean sea-level pressure,
temperature at 250/500/850 hPa, geopotential height at 300/500/1000 hPa, and for AIFS ENS
2 m temperature. Those are read as one small download (about 250 KB). Every other field,
and these too while the run is still coming in, is averaged here from all 50/51 members
(15–30 MB per field). Members are
fetched and summed in batches inside the decode workers, background preloading pauses while
the hour on screen loads, and finished means are kept in IndexedDB (up to 300 fields), so a
revisit, a reload or the next session shows them straight away. GEPS files hold all 21
members each: its mean is one download per field, decoded member by member across the
workers, and a single member is decoded without unpacking the other 20. For precip type, the
"mean" is the most common type among the members. REFS members are read from the RRFS
ensemble's own files (`rrfsens.YYYYMMDD/HH/m001…m005`), which carry much more than the
ensemble mean: every pressure level from 1000 to 250 hPa, 0–1 km helicity, 0–6 km shear,
gusts, lightning and DCAPE. So a single REFS member has soundings and cross sections, and the
product list follows the member picked.

RRFS runs every hour, but only the 00/03/06/…/21 UTC cycles publish full output
(`2dfld` + `prslev`). The cycles in between publish only the sub-hourly surface files
(`2dfld.subh`, F001–F018), so they're listed as "surface only": temperature, dewpoint, wind,
gusts, pressure, reflectivity, precipitation and precip type, with no upper air, CAPE,
helicity, clouds or soundings. A greyed-out product on one of those runs is a click away:
it switches to the newest full run.

All of these buckets send CORS headers and accept HTTP range requests, which is what lets
a static page read them directly. ICON comes from Open-Meteo's copy because DWD's own
server doesn't allow cross-origin requests.

GEPS is the one model the browser can't fetch directly: Canada's `dd.weather.gc.ca` sends
no CORS headers, so the app relays it through a same-origin proxy that passes only GEPS raw
files (`server/server.js` locally, `worker/index.js` on Cloudflare Workers,
`functions/proxy/msc` on Cloudflare Pages). GitHub Pages can't run the proxy, so there GEPS
shows a message instead of loading.

## Products

| Upper air (1000–10 hPa) | Surface | Precipitation (QPF) | Winter (totals since F000) |
| --- | --- | --- | --- |
| Wind speed + heights (with particles) | 2 m temperature (0 °C line) | Run total since F000 | Snowfall, 10:1 |
| Relative vorticity + heights | 2 m dew point | 1, 3, 6, 12, 24, 48 or 72 h totals | Snowfall, Kuchera |
| Height | 10 m wind speed (with particles) | | Freezing rain (liquid equiv.) |
| Temperature + heights (0 °C line) | 10 m wind gusts | | Sleet (3:1 depth) |
| Temperature anomaly vs 1991–2020 + heights | Precip rate + type | | |
| Height anomaly vs 1991–2020 + heights | Cloud cover (total / low / mid / high) | | |
| Wind shear: sfc–500, sfc–700, 850–200 hPa | Simulated composite reflectivity | | |

### Severe weather

| Product | Where it comes from | Models |
| --- | --- | --- |
| CAPE: surface-based, mixed-layer (90 hPa), most-unstable | published | SB/ML/MU: GFS, HRRR, RRFS, RAP, REFS · MU: IFS, ENS, GEFS, ICON · SB: GEPS |
| CIN: SB / ML / MU | published | GFS, HRRR, RRFS, RAP, REFS · MU: GEFS · SB: GEPS |
| Lapse rate, 700–500 and 850–500 hPa | temperature and height on levels | all |
| LCL height (surface-based) | 2 m temperature and dew point (Bolton) | all |
| Significant tornado parameter (fixed layer) | SBCAPE, SB LCL, published 0–1 km SRH and 0–6 km shear | HRRR, RRFS, RAP |
| Storm-relative helicity, 0–1 / 0–3 km | published | 0–1: HRRR, RRFS, RAP · 0–3: also GFS, REFS |
| DCAPE | computed per grid point from temperature and humidity on levels | all with humidity on levels (not ICON, REFS) |
| Lightning flash density | published | HRRR, RAP, RRFS (hourly max) |

DCAPE needs every level at every grid point, so a global frame downloads ~19 fields (about
15 s); it runs in the decode workers, and its inputs are dropped from the cache afterwards.

### Soundings and cross sections

The three tools under the zoom buttons (or keys **S**, **B**, **X**; **Esc** cancels or
closes):

* **Sounding**: click a point, or just **right-click** the map at any time. Drawn by the
  app itself (`sounding.js`), in a SHARPpy-like layout. Across the top: a skew-T log-p
  (temperature, dew point, wet bulb, the chosen parcel with its CAPE and CIN shaded,
  LCL/LFC/EL, heights above ground, the effective inflow layer, wind barbs, and a readout
  under the pointer) and a hodograph (coloured by layer, a dot per km, Bunkers right/left
  movers and the 0–6 km mean wind, effective-layer SRH shaded). Along the bottom: SB/ML/MU
  CAPE, 0–3 and 0–6 km CAPE, CIN, LCL, LFC and EL; lapse rates, PWAT, mean mixing ratio,
  low/mid RH, DCAPE, freezing and wet-bulb zero levels; bulk shear, SRH and storm-relative
  wind for 0–0.5, 0–1, 0–3, 0–6, 1–3, 3–6 km and the effective layer; SCP, BRN, significant
  severe, STP (effective with CIN, and fixed), EHI and effective SRH/shear; storm-relative
  wind by height; and a rough "possible hazard" guide. SB/ML/MU (header or table rows)
  picks the parcel drawn, and the download button saves the charts as a PNG.
* **Box sounding**: click two corners, or **right-drag** a box on the map at any time; the
  mean profile over every grid point in the box.
* **Cross section**: click the two ends. Relative humidity, wind speed, temperature, θe or θ
  along the great circle, with θe contours (isotherms for the θe fill), the 0 °C line, wind
  barbs and terrain.

The panels follow the map: stepping the forecast hour, or changing model or ensemble member,
reloads them. They're available for every model with temperature, height, wind and humidity
on pressure levels (all but ICON and the REFS mean); HRRR/RRFS/RAP use 24 levels, GFS 21, the ECMWF
and AI models 12, GEFS/GEPS 8. The cross-section and gridded
DCAPE calculations, and every number in the sounding panel, live in `public/js/thermo.js`.

Each level is read only as a window around the area of interest (snapped to 5° tiles and
cached), so a second sounding nearby, a box there, or a cross section through it is
instant. The first sounding of an hour downloads every level (about 100 MB for GFS or
HRRR); those bytes are kept (256–512 MB, by device memory), so a sounding anywhere else that hour only
decodes again, which stops at the last grid row the window needs (and HRRR/RRFS/RAP only
regrid the window). Sounding and cross-section loads jump ahead of everything else in the
queue, and once one is drawn the next forecast hour is loaded for it in the background.
For the locally averaged ENS/AIFS ENS/GEPS means the whole mean of each level is kept
instead, so any later window that hour is free.

A product or level a model doesn't publish is greyed out (for example AIGFS has no gusts,
CAPE, clouds or reflectivity, HRRR/RAP/ICON/AIGFS stop at 50 hPa, and GEFS/GEPS have no
300 hPa temperature).

**QPF** interval totals are the difference of two run totals, so an *N*-hour total needs
the step *N* hours earlier. When a model's steps are coarser than that (GFS is 3-hourly
after 120 h, AIGFS is 6-hourly), the app says so instead of drawing something misleading.
GEFS (6-hour buckets) and REFS (1-hour buckets) publish precipitation that restarts every
bucket; their run totals are built by adding the buckets up.

**Locally derived fields**, where a model doesn't publish one:
* vorticity from u/v (AIFS, AIGFS, ICON, the ensembles); from absolute vorticity for the
  NCEP deterministic models
* precip type from a warm-nose temperature-profile scheme (AIFS, AIGFS, AIFS ENS, GEPS, WOOF-NAM),
  NCEP's categorical rain/snow/sleet/freezing-rain flags (GFS, HRRR, RRFS, RAP, GEFS, REFS),
  or the weather code (ICON)
* precip rate as a 6-hour mean from total precipitation (AIFS, AIGFS, AIFS ENS, GEFS,
  GEPS), or from the 1-hour bucket (REFS), or as a 1-hour mean from the 12-hour buckets (WOOF-NAM)
* dew point from 2 m relative humidity (ICON, GEFS, GEPS)
* ICON totals since F000, summed from its per-interval precipitation and snowfall
* snowfall for models without a snowfall field: precipitation × snow share from precip type

Kuchera snowfall uses the column's maximum temperature (2 m, 925, 850, 700 hPa, skipping
levels below ground), so it needs surface pressure; ICON's Open-Meteo files don't carry
it, so Kuchera isn't offered for ICON.

## Radar

The **Models / Radar** switch at the top of the sidebar gives the whole sidebar to one or
the other. Radar covers all 159 NEXRAD WSR-88D and 45 TDWR sites, with one pill-shaped
button each (TDWRs smaller and yellow) and a search box, plus a marker for each site on the
globe. TDWR markers only appear once you're zoomed in to roughly a metro area (the selected
one always shows), so they don't crowd the NEXRADs. When radar opens, every site's status is fetched from the NWS API
(`api.weather.gov/radar/stations`), and refreshed every 5 minutes. A radar counts as down,
with a red button and marker, when it hasn't sent data for 30 minutes, its RDA isn't
operating, or it reports itself inoperable. The selected site also turns red if its newest
scan in the bucket is over 30 minutes old. Hover a button for the reason.

| Section | Product | Source (per tilt) | NEXRAD tilts | TDWR tilts |
| --- | --- | --- | --- | --- |
| Reflectivity | Reflectivity | Level III `N0B NAB N1B NBB N2B N3B` / `TZ0–2` | 6 | 3 |
| | Precipitation type | reflectivity, typed by the latest HRRR F001 | 6 | 3 |
| Velocity | Velocity | Level III `N0G NAG N1G`, then `NBU N2U N3U` / `TV0–2` | 6 | 3 |
| | Storm relative velocity | velocity minus the storm motion from `N0S` | 6 | |
| | Spectrum width | Level II `SW` | 6 | |
| Dual-pol | Correlation coefficient | Level II `RHO` · legacy: Level III `N0C`… | 6 | |
| | Differential reflectivity | Level II `ZDR` · legacy: Level III `N0X`… | 6 | |
| | Specific differential phase | computed from Level II `PHI` · legacy: Level III `N0K`… | 6 | |
| | Hydrometeor classification | Level III `N0H`… (legacy only) | 6 | |
| | Hybrid hydrometeor classification | Level III `HHC` (legacy only) | 1 | |
| Precipitation totals | 1-hour / 3-hour / storm total | Level III `DAA` / `DU3` / `DTA` | 1 | |
| Derived | Enhanced echo tops | Level III `EET` | 1 | |
| | Vertically integrated liquid | Level III `DVL` / `NVL` | 1 | 1 |

**Resolution.** Everything is drawn at the finest resolution the radar produces. That's
super-res (0.5° × 250 m) on the lowest three tilts for reflectivity, velocity, storm
relative velocity, spectrum width and dual-pol, and 1° above that, where the radar itself
doesn't collect super-res. The NWS publishes dual-pol Level III only at 1°, so super-res CC
and ZDR come from the Level II volume. Super-res KDP is computed here from Level II ΦDP, the
way the NEXRAD dual-pol preprocessor does it: a 5-gate median, then a least-squares fit over
25 gates (9 gates at ≥ 40 dBZ) of good gates (ρhv ≥ 0.9, ≥ 20 dBZ), then averaged with the
neighbouring radials. The **Resolution** toggle in the Dual-pol section switches CC, ZDR and
KDP back to the legacy Level III products, which are faster to load and closer to real time.
The hydrometeor classifications exist only at legacy resolution. Super-res storm relative
velocity is the super-res velocity with the radar's own average storm motion (from its legacy
SRM product of the same volume) taken off along each beam. The precipitation totals, echo
tops and VIL only exist at their native 1° / 250 m–1 km grids.

**Tilts** show as angle pills under the selected product's section (↑/↓ steps through
them). The angles are nominal until a scan arrives, then show the radar's own angles (they
vary with the VCP). TDWRs publish no Level II and fewer products, so the rest are greyed
out for them.

**Precipitation type** colours reflectivity by the surface precipitation type of the latest
HRRR run at forecast hour 1: rain, snow, sleet / mix or freezing rain, from the HRRR's
categorical flags. Where the HRRR has no precipitation of its own, the 2 m wet-bulb
temperature decides rain or snow (≤ 0.5 °C is snow). The HRRR field is downloaded once per
run, and the title says which run is in use. Outside the HRRR domain (Alaska, Hawaii,
Puerto Rico, Guam, Korea, Japan) the type is shown grey as "Unknown".

**3D radar.** The 3D view switch (or the 3 key) asks for a box: drag one around the
storms on the flat map (or click a spot for a 100 km box), anywhere inside the dashed
300 km ring around the selected NEXRAD. The map then tilts to look across the ground at the
box and its whole volume scan is drawn above it, like GR2Analyst's volume explorer. The full
Level II volume is downloaded (5–15 MB) and every tilt decoded, then the gates inside the box
are resampled in the worker using the 4/3-earth beam model, interpolated between tilts and
lightly smoothed. The grid is at most 360 × 360 columns by 56 levels (0.32 km up to 18 km),
so a smaller box gets finer detail, down to 250 m. Each worker keeps the last volume it
decoded, so a new box over the same scan only takes the resampling. The GPU ray-marches just
that box, drawn offscreen at CSS-pixel resolution (about half that, with coarser steps, while
the camera moves) and laid over the map. **New box** picks another area. A new radar asks for
a new box.

**Isosurface** draws nested lit shells, one at the threshold and one every 5 dBZ past it (5 m/s
for velocity, 2 m/s for spectrum width, 0.75 dB for ZDR, 0.04 for CC), and **Volumetric**
draws a cloud that gets denser where the echo is stronger. In both, the **Volume alpha**
graph sets how opaque each value is: drag across it to draw the curve, double-click or press
Reset to go back to the default ramp. The value under the cursor shows in its title, and the
range the threshold leaves out is shaded. With a low alpha on weak echo, strong cores show
through the outer shells. Curves are saved per moment. Reflectivity, velocity (drawn where
|v| is over the threshold), spectrum width, ZDR and CC (drawn below the threshold) have their
own volumes; other products show reflectivity. Height stretch goes from 1× to 8× (3× by
default). In 3D, drag orbits, right-drag pans and the wheel zooms. The volume follows the
loop: each frame uses the last volume that started by its scan time. TDWRs publish no
Level II, so 3D is NEXRAD only. The code is in `radar/volume.js` and `radar/alpha-editor.js`.

**Keys and right-click.** In radar mode, R, V, C, D, K and S switch to reflectivity,
velocity, correlation coefficient, differential reflectivity, specific differential phase
and storm relative velocity. ←/→ step through the loop, space plays, ↑/↓ change tilt and 3
toggles the 3D view.
Right-click the map for a menu offering to switch to the nearest working NEXRAD, to open
an HRRR sounding at that spot from the latest HRRR analysis (F000), in the same sounding
panel the models use, or to start a cross section there.

**Cross sections** (NEXRAD): the line tool (or **X**) in radar mode draws a vertical slice
through every tilt of the Level II volume that goes with the frame on screen, for
reflectivity, velocity, spectrum width, ZDR or CC (other products show reflectivity), up to
20 km, interpolated between tilts, with each tilt's beam centre, range-folded gates in
purple and a readout under the pointer. It follows the loop and the product, and the ends
can be swapped. Sampling runs in the radar worker that already holds the decoded volume
(`radar/worker.js`, `radar/xsect.js`).

**Color tables**: any product (except precipitation type) can use an uploaded table.
GR2Analyst / RadarScope `.pal` files work (`Color`, `Color4`, `SolidColor`, `SolidColor4`,
`Units`, `Scale`, `Offset`, `RF`), and so do plain `value r g b [a]` lines. Values are
converted using `Scale`/`Offset` (GR's convention, e.g. knots for velocity) or `Units`
(kts, mph, in, mm, kft, km…). Tables are kept in the browser's local storage per product,
and Reset restores the built-in table.

Level III products come from Unidata's `unidata-nexrad-level3` bucket, and Level II volumes
from `unidata-nexrad-level2`. Level II is range-requested only as far as the wanted sweep:
~2.4 MB for the lowest tilt, most of the ~6 MB volume for the highest. Level II volumes only
appear once a volume scan finishes, so they run a few minutes behind Level III. The
timeline becomes a loop of the last two hours of scans: up to 24 Level III frames, or 10
Level II frames (6 above the lowest tilt). It loads in the background, follows new scans as
they arrive, and pauses on the latest scan while playing. Sweeps are drawn in their own
polar geometry by the globe shader (nearest gate, no regridding). Range-folded gates are
purple. The tooltip gives the value, plus range and bearing from the radar. Decoding lives in
`public/js/radar/`: `level3.js` (packets 16, AF1F and raster BA07), `level2.js` (message 31),
`worker.js` (storm-relative velocity and KDP) and `public/js/decode/bzip2.js`, which both
formats need. Colour tables are parsed in `colortables.js`. The site list is
`public/data/radars.json`, built by `tools/build-radars.mjs`.

## Settings: map style, map size, alerts, broadcast

The gear button (map buttons, or **Settings** in the sidebar) opens a drawer beside the map:

- **Map**: the built-in WebGL globe, or a **MapLibre GL** map (loaded from unpkg on demand) with
  CARTO, OpenFreeMap, Esri satellite or a plain base map, or any style URL; globe or flat Mercator
  projection; data opacity and whether the data sits under the labels, under roads too, or on top;
  base-map layer groups on/off; land, water, boundary, road and label colours; label size;
  hillshade; rotate and tilt. The map's own place labels stay hidden: town names and city values
  are the app's on both engines. Model fields and radar are drawn by the same shader in Web Mercator
  for the area in view (`Globe.renderFlat`) and handed to MapLibre as a canvas source. Wind
  particles and the 3D radar view need the WebGL globe.
- **Size**: frame the map at a social media size (X, Instagram square/portrait, stories, Facebook,
  YouTube, 4:3 or custom). Only the map and what's drawn on it change: the sidebar, timeline and
  buttons stay put.
- **Alerts**: NWS watches, warnings and advisories from `api.weather.gov`, shown over radar (and
  over model maps if asked). Every active type can be switched on or off and given its own colour,
  fill and outline. Alerts without a polygon get their zone outlines from the API, simplified and
  cached in IndexedDB. Clicking the map lists every alert at that spot in a draggable popup with
  arrows between them; tags show impact-based details (wind, hail, radar indicated / observed,
  considerable / destructive / catastrophic, PDS, EDS, emergencies). The alert's name opens the
  full text.
- **Broadcast**: a TV-style graphic with the logo, the product on screen, the model and run (or
  the radar site), the weekday, date and time (local or UTC) and a colour key, in seven colour themes or your own colours, with an optional
  tagline and uploaded logo. "Clean screen" hides the app's controls; it's off by default so
  everything stays adjustable.

The **camera** button saves a PNG and the **video** button records an MP4 (H.264 through WebCodecs,
muxed with mp4-muxer; Chrome, Edge, Safari) or a looping GIF (gifenc), both at the size picked in
Settings › Size (or the window at screen resolution), optionally scaled to 75% or 50%. Pick the
frames (all, every 2nd/3rd, the latest scans, or click and shift-click), how long each one shows
and how long to hold the last. The map is drawn again at the export's pixel ratio and the labels,
broadcast graphic (or title and legend) and an open alert popup with its arrow are painted over
it, so files match the screen. The broadcast graphic is laid out for a 1920 × 1080 picture and
scaled to the map size, so at 100% it takes the same share of a square post, a story or a
YouTube frame.

Radar **Resolution** (with the tilts) applies to every NEXRAD product: CC, ZDR and KDP switch to
their Level III legacy products; reflectivity, velocity and spectrum width, whose legacy Level III
files are no longer published, show the super-res scan resampled to 1° radials (1 km gates for
reflectivity).

## How it works

```
public buckets ──HTTP range request──▶ Web Worker pool                 ──▶ WebGL globe
 (AWS S3, GCS, CORS *)                  • GRIB2 decode (5.0 simple,          • colour LUT shader
 run discovery: bucket listings         5.2/5.3 complex + spatial diff,       • contours, isobars
 byte offsets: .idx / .index files      5.40 JPEG 2000, 5.42 CCSDS)          • particles, labels
                                        or Open-Meteo .om
                                        • Lambert / rotated grids → lat/lon
```

* **Download only what's needed.** Each product requests only the GRIB messages it uses,
  using the byte offsets in the run's index file (`.idx` for NOAA, `.index` for ECMWF).
* **Projected grids.** HRRR and RRFS (Lambert conformal) and RAP (rotated lat/lon) are
  regridded in the worker onto a regular lat/lon grid (0.03° for 3 km, 0.12° for RAP), and
  their grid-relative winds are rotated to true north. The mapping is computed once per
  grid and reused. Outside a regional domain the globe shows the base map.
* **Decoding** lives in `public/js/decode/` (`grib2.js`, `aec.js`, `jpx.js`, `regrid.js`);
  ICON uses Open-Meteo's WebAssembly reader, loaded only when ICON is selected. `jpx.js`
  decodes the lossless single-component JPEG 2000 streams GRIB producers write (GEPS).
* **Throttling and mirrors.** Downloads retry with back-off on 429/5xx and network errors.
  ECMWF data comes from Google Cloud's mirror, with ECMWF's own server as the fallback. The
  AWS mirror answers bursts with "503 Slow Down" and no CORS headers, which browsers report
  as a failed fetch, so it isn't used.
* **Soundings and cross sections**: `profile.js` gathers windows of each level,
  `thermo.js` builds the profile and its indices, `sounding.js` draws it, `xsect.js` draws the cross
  section, and `tools.js` handles picking on the globe.
* **Model catalogue** is `public/js/models.js`: where each model's files are, which
  variables map to which products, and recipes for derived fields. `public/js/sources.js`
  does run discovery and builds the download jobs.
* **Whole-run loops.** Once a frame is drawn, every other forecast hour of the run is
  loaded for the current product, level and member (nearest-ahead first), and the timeline
  ticks fill in as frames arrive. Decoded fields are stored as 16-bit values in an
  in-memory LRU of 1–2.5 GB depending on the device: enough for a full run of most
  products. If a run doesn't fit, loading stops at the limit and the status says so.
* **Only the view on screen stays in memory.** Memory holds the whole run of the one
  product being viewed (for the selected model, run and member, with whatever its fields
  are computed from) and nothing else. Changing product, level, model, run or member drops
  every other field, accumulated total and cached GRIB byte right away, and cancels queued
  and in-flight downloads for the old view (aborted in the workers), so the new view gets
  the connection to itself. Leaving radar mode drops decoded scans and volumes; entering
  it drops model fields. Windows for soundings and cross sections of the same run are
  kept. Locally averaged ensemble means are still kept on disk (IndexedDB).
* **ICON reads.** Each Open-Meteo file is opened by one decode worker (every variable of
  that hour goes to it), its header and chunk indexes go through a small block cache, and
  a variable's data is fetched in one or two big range requests rather than ~35 64 KB
  blocks: about twice as fast per field.

Controls: drag to rotate, scroll to zoom (down to town level), double-click to fly to a
point, ←/→ to step through forecast hours, space to play, ↑/↓ to change level, S/B/X for a
sounding, box sounding or cross section (or right-click for a sounding, right-drag for a box
sounding), Esc to cancel or close.

On a phone or tablet: drag to rotate, pinch to zoom (the spot between your fingers stays
put), drag with two fingers to pan, tap for the value at a point, double-tap to zoom in, and
press and hold where you'd right-click on a desktop (a sounding, or the radar menu). The
controls open as a bottom sheet from the layers button at top left; tap the map or drag
the sheet down to put it away.

**City values** (the model's value above each town name) can be switched on for any product
under Overlays. They're on by default for surface temperature, dew point, wind and gusts,
CAPE, lapse rates, LCL, STP, SRH, DCAPE, QPF and the winter totals, and remembered per
product.

Town names are decluttered on screen every frame, most important first, but a town already
shown keeps its place against towns up to 1.5 ranks more important, so panning a little
never knocks out a town in plain view. Zooming in shows progressively smaller places, down
to villages of a few hundred people.

## Run it locally

Any static file server works. With Node 18+:

```bash
npm start
```

Then open http://localhost:8642 (set `PORT` to change it). The local server also runs the
GEPS proxy. No `npm install` is needed;
`three` is only a dev dependency for re-vendoring (see `public/vendor/README.md`).

## Publish on GitHub Pages

1. Push this folder to a GitHub repository (branch `main`).
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` publishes `public/` on every push to
   `main`. The site appears at `https://<user>.github.io/<repo>/`.

All paths in the app are relative, so it works from a project sub-path like `/<repo>/`.

## Publish on Cloudflare (Workers)

1. In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**, and pick
   the repository.
2. Leave the build command empty and the deploy command as `npx wrangler deploy`.
3. Save and deploy. Every push redeploys. `wrangler.toml` serves `public/` as static assets
   (with the caching rules in `public/_headers`) and runs `worker/index.js` only for
   `/proxy/*`, which is the GEPS proxy.

The Worker name in the dashboard must match `name` in `wrangler.toml` (`model-globe`). If
your Worker has a different name, change one of them so they match.

Prefer a **Pages** project instead? Use **Create → Pages → Connect to Git**, set the build
output directory to `public`, and leave the build command empty. Pages ignores this
`wrangler.toml` and deploys `functions/proxy/msc` as the GEPS proxy. Don't use
`wrangler deploy` with a Pages project.

## Data

* `public/data/clim/`: NCEP/NCAR Reanalysis 1991–2020 monthly mean temperature and height,
  converted by `tools/build-climatology.py`. Used for the anomaly products.
* `public/data/geo/`: Natural Earth 50m and 10m coastlines, borders, states and lakes
  (`tools/build-geo.mjs`). Zoomed in, US state lines are the Census Bureau 1:500k
  cartographic boundaries, with Natural Earth 10m admin-1 lines elsewhere
  (`tools/build-states.mjs`); US counties are Census 1:500k too (`tools/build-counties.mjs`).
* `public/data/geo/places/`: GeoNames `cities500`, every populated place of 500+ people
  (~226k), built by `tools/build-places.mjs`. Places of 15k+ people, capitals and state
  seats load at start; the rest are in 5° tiles fetched as you zoom in on them.
* `public/data/base/`: land mask and relief, baked by `tools/build-basemap.mjs`.

Licences: ECMWF open data, DWD ICON (via Open-Meteo) and GeoNames are CC-BY-4.0; NOAA data (models, NEXRAD and TDWR radar) and Census
boundaries are public domain; MSC GEPS data is under the Open Government Licence – Canada. Vendored libraries are listed in `public/vendor/README.md`
(Three.js is MIT; the Open-Meteo reader is GPL-2.0; SharpJS has its own licence: non-commercial
use, and its "SharpJS" mark must stay visible on the chart).
