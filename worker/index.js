// Cloudflare Worker entry point (`wrangler deploy`). The site itself is the static
// public/ folder, served by Workers static assets; this script only runs for
// /proxy/* (see run_worker_first in wrangler.toml), which relays GEPS files.
import { proxyMsc } from '../lib/msc-proxy.js';

const PREFIX = '/proxy/msc/';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(PREFIX)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      return proxyMsc(request, pathname.slice(PREFIX.length));
    }
    return env.ASSETS.fetch(request);
  },
};
