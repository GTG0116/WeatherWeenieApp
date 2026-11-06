// MSC (GEPS/GDPS) proxy for Cloudflare (used by both the Worker in worker/index.js and the
// Pages Function in functions/proxy/msc). Canada's MSC Datamart sends no CORS
// headers, so the browser can't fetch it directly (server/server.js is the local equivalent).
import { MSC_ORIGIN, mscPath } from './msc-paths.js';

/** Relay `rest` (the path after /proxy/msc/) from dd.weather.gc.ca, passing Range through. */
export async function proxyMsc(request, rest) {
  if (rest === 'ping') return new Response('ok');
  const upstream = mscPath(rest);
  if (!upstream) return new Response('only GEPS and GDPS files are relayed', { status: 403 });
  const range = request.headers.get('Range');
  let up;
  try {
    up = await fetch(`${MSC_ORIGIN}/${upstream}`, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: range ? { Range: range } : {},
    });
  } catch (err) {
    return new Response(`MSC Datamart unreachable: ${err.message}`, { status: 502 });
  }
  const headers = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = up.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Cache-Control', upstream.endsWith('/') ? 'no-cache' : 'public, max-age=3600');
  return new Response(up.body, { status: up.status, headers });
}
