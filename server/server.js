// Local static server for development. The app itself is plain static files in
// public/: the browser fetches model data straight from the public buckets, so
// this mostly serves files (GitHub Pages / Cloudflare Pages do the same in
// production). The one exception is /proxy/msc/: Canada's MSC Datamart (GEPS)
// sends no CORS headers, so those requests are relayed (worker/index.js
// does the same on Cloudflare).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MSC_ORIGIN, mscPath } from '../lib/msc-paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 8642;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** Relay a GEPS file or directory listing from dd.weather.gc.ca, passing Range through. */
function proxyMsc(req, res, rest) {
  if (rest === 'ping') return send(res, 200, 'ok');
  const upstream = mscPath(rest);
  if (!upstream) return send(res, 403, 'only GEPS raw files are relayed');
  const headers = req.headers.range ? { Range: req.headers.range } : {};
  https
    .get(`${MSC_ORIGIN}/${upstream}`, { headers }, (up) => {
      const out = { 'Cache-Control': upstream.endsWith('/') ? 'no-cache' : 'public, max-age=3600' };
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        if (up.headers[h]) out[h] = up.headers[h];
      }
      res.writeHead(up.statusCode, out);
      up.pipe(res);
    })
    .on('error', (err) => send(res, 502, `MSC Datamart unreachable: ${err.message}`));
}

function handle(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname.startsWith('/proxy/msc/')) return proxyMsc(req, res, pathname.slice('/proxy/msc/'.length));
  let file = path.join(root, pathname);
  if (!file.startsWith(root)) return send(res, 403, 'forbidden');
  if (pathname.endsWith('/')) file = path.join(file, 'index.html');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const etag = `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    res.writeHead(200, {
      ETag: etag,
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// Listen on both loopback addresses: on Windows "localhost" resolves to ::1
// first, and an IPv4-only server costs every request a ~200 ms fallback.
http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(`Model Globe running at http://localhost:${PORT}`);
});
http
  .createServer(handle)
  .on('error', () => {}) // IPv6 loopback unavailable: IPv4 alone still works
  .listen(PORT, '::1');
