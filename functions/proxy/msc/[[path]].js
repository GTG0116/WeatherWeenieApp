// Cloudflare Pages Function: relays GEPS files from Canada's MSC Datamart,
// which sends no CORS headers (see server/server.js for the local equivalent).
import { MSC_ORIGIN, mscPath } from '../../../lib/msc-paths.js';

export async function onRequestGet({ request, params }) {
  const rest = (params.path ?? []).join('/') + (new URL(request.url).pathname.endsWith('/') ? '/' : '');
  if (rest === 'ping') return new Response('ok');
  const upstream = mscPath(rest);
  if (!upstream) return new Response('only GEPS raw files are relayed', { status: 403 });
  const range = request.headers.get('Range');
  const up = await fetch(`${MSC_ORIGIN}/${upstream}`, { headers: range ? { Range: range } : {} });
  const headers = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = up.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Cache-Control', upstream.endsWith('/') ? 'no-cache' : 'public, max-age=3600');
  return new Response(up.body, { status: up.status, headers });
}
