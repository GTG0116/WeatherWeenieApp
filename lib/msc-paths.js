// Which MSC Datamart paths the proxy relays: only GEPS raw and GDPS 15 km GRIB2
// files and their directory listings, so the proxy can't be used to fetch anything else.
export const MSC_ORIGIN = 'https://dd.weather.gc.ca';

const ALLOWED = [
  /^\d{8}\/WXO-DD\/ensemble\/geps\/grib2\/raw\/\d{2}\/(\d{3}\/(CMC_geps-raw_[A-Za-z0-9_]+_latlon0p5x0p5_\d{10}_P\d{3}_allmbrs\.grib2)?)?$/,
  /^\d{8}\/WXO-DD\/model_gdps\/15km\/\d{2}\/(\d{3}\/(\d{8}T\d{2}Z_MSC_GDPS_[A-Za-z0-9_-]+(\.[0-9]+)?[A-Za-z0-9_-]*_LatLon0\.15_PT\d{3}H\.grib2)?)?$/,
];

/** The upstream path for a proxied request path, or null if it isn't allowed. */
export function mscPath(rest) {
  return ALLOWED.some((re) => re.test(rest)) ? rest : null;
}
