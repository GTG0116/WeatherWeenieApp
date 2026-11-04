// Which MSC Datamart paths the GEPS proxy relays: only GEPS raw GRIB2 files and
// their directory listings, so the proxy can't be used to fetch anything else.
export const MSC_ORIGIN = 'https://dd.weather.gc.ca';

const ALLOWED = /^\d{8}\/WXO-DD\/ensemble\/geps\/grib2\/raw\/\d{2}\/(\d{3}\/(CMC_geps-raw_[A-Za-z0-9_]+_latlon0p5x0p5_\d{10}_P\d{3}_allmbrs\.grib2)?)?$/;

/** The upstream path for a proxied request path, or null if it isn't allowed. */
export function mscPath(rest) {
  return ALLOWED.test(rest) ? rest : null;
}
