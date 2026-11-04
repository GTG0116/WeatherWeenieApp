// Cloudflare Pages Function for the GEPS proxy (only used if this repo is deployed
// as a Pages project; a Workers deploy uses worker/index.js instead).
import { proxyMsc } from '../../../lib/msc-proxy.js';

export async function onRequestGet({ request, params }) {
  const rest = (params.path ?? []).join('/') + (new URL(request.url).pathname.endsWith('/') ? '/' : '');
  return proxyMsc(request, rest);
}
