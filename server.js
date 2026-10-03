// Minimal zero-dependency server for VN Topster.
// - Serves the static front-end from ./public
// - Proxies VNDB cover images (t.vndb.org doesn't send CORS headers, which
//   would otherwise taint the <canvas> and block PNG export).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ALLOWED_IMG_HOSTS = new Set(['t.vndb.org', 'images.igdb.com']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// Small in-memory LRU cache for proxied images.
const IMG_CACHE_MAX = 400;
const imgCache = new Map(); // url -> { type, buf }

function cacheGet(key) {
  const v = imgCache.get(key);
  if (v) { imgCache.delete(key); imgCache.set(key, v); }
  return v;
}
function cacheSet(key, v) {
  imgCache.set(key, v);
  while (imgCache.size > IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
}

async function handleImg(req, res, url) {
  const target = url.searchParams.get('u');
  let parsed;
  try { parsed = new URL(target); } catch { res.writeHead(400); return res.end('bad url'); }
  if (parsed.protocol !== 'https:' || !ALLOWED_IMG_HOSTS.has(parsed.hostname)) {
    res.writeHead(403); return res.end('forbidden host');
  }
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=604800, immutable',
  };
  const cached = cacheGet(parsed.href);
  if (cached) {
    res.writeHead(200, { ...headers, 'Content-Type': cached.type });
    return res.end(cached.buf);
  }
  try {
    const r = await fetch(parsed.href, { headers: { 'User-Agent': 'VN-Topster/1.0' } });
    if (!r.ok) { res.writeHead(r.status); return res.end(); }
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || 'image/jpeg';
    cacheSet(parsed.href, { type, buf });
    res.writeHead(200, { ...headers, 'Content-Type': type });
    res.end(buf);
  } catch (e) {
    res.writeHead(502); res.end('upstream error');
  }
}

function handleStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/img') return handleImg(req, res, url);
  handleStatic(req, res, url);
}).listen(PORT, () => {
  console.log(`VN Topster running at http://localhost:${PORT}`);
});
