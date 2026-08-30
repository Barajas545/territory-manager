/* Minimal static server for testing the PWA locally.
   Service workers require http(s), so file:// cannot exercise offline mode.
   Serves the repo at / and also at /territory-manager/ to mirror GitHub Pages. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();
const PORT = Number(process.argv[3] || 8787);
const BASE = '/territory-manager';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end('bad url'); }

  if (pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/';
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Contain path traversal: resolve, then require the result to stay under ROOT.
  const file = path.resolve(ROOT, '.' + pathname);
  if (!file.startsWith(path.resolve(ROOT))) { res.writeHead(403); return res.end('nope'); }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404 ' + pathname); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // No caching, so a reload always picks up edits; the SW does its own caching.
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
    });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  http://localhost:${PORT}${BASE}/  (mirrors GitHub Pages subpath)`);
});
