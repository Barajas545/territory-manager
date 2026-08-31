/* Territory Manager service worker.
   Lives at the GitHub Pages project subpath, so its scope is /territory-manager/.
   Bump CACHE_VERSION on every deploy that changes the shell. */

const CACHE_VERSION = 'v31';
const SHELL_CACHE = `tm-shell-${CACHE_VERSION}`;
const VENDOR_CACHE = `tm-vendor-${CACHE_VERSION}`;
const TILE_CACHE = 'tm-tiles-v1'; // survives shell upgrades; tiles never go stale
const TILE_LIMIT = 800;

const SHELL = ['./', './index.html', './manifest.webmanifest'];

const VENDOR = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js',
  'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
];

// The page itself is non-negotiable: without it there is no offline app at all.
const CRITICAL = './index.html';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // Let this reject. If the page cannot be cached, the install MUST fail so
    // the previous worker and its caches stay in place — otherwise activate
    // would delete a working offline copy and replace it with nothing.
    // Bypass the HTTP cache. GitHub Pages serves the page with a max-age, so a
    // plain add() minutes after a deploy would bake the PREVIOUS page into this
    // version's cache and serve it until the next deploy.
    const fresh = u => new Request(u, { cache: 'reload' });
    await shell.add(fresh(CRITICAL));
    await Promise.all(SHELL.filter(u => u !== CRITICAL).map(u => shell.add(fresh(u)).catch(() => {})));
    const vendor = await caches.open(VENDOR_CACHE);
    await Promise.all(VENDOR.map(u => vendor.add(u).catch(() => {})));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Only discard the old caches once this version's page is genuinely cached.
    const shell = await caches.open(SHELL_CACHE);
    const ok = await shell.match(CRITICAL);
    if (ok) {
      const keep = new Set([SHELL_CACHE, VENDOR_CACHE, TILE_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.map(n => (keep.has(n) ? null : caches.delete(n))));
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* Keep the tile cache bounded. Oldest-inserted first, a good enough proxy for
   least-recently-used here. Counting keys on every tile request meant a full
   cache scan per tile, slowest exactly as the cache fills and panning matters
   most — so track writes and scan only occasionally. */
let tileWrites = 0;
async function trimTiles() {
  if (++tileWrites < 50) return;
  tileWrites = 0;
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map(k => cache.delete(k)));
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Only cache real successes. Both OSM tiles and unpkg send CORS headers, so a
  // response here should never be opaque — and an opaque one cannot be checked,
  // meaning a 404 or a captive-portal page would be cached as if it were a tile
  // and served forever from a cache that is never versioned.
  if (res && res.ok && res.type !== 'opaque') cache.put(request, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache writes

  const url = new URL(req.url);

  // API traffic is never served from the HTTP cache — offline reads come from
  // IndexedDB, which knows about pending local edits. A cached 200 here would
  // silently shadow them.
  if (url.pathname.includes('/api/territory')) return;

  // Map tiles: cache-first, so previously walked areas stay visible offline.
  if (/tile\.openstreetmap\.org/.test(url.hostname)) {
    event.respondWith(
      cacheFirst(req, TILE_CACHE).then(r => { trimTiles(); return r; })
        .catch(() => new Response('', { status: 504 }))
    );
    return;
  }

  if (/unpkg\.com/.test(url.hostname)) {
    event.respondWith(cacheFirst(req, VENDOR_CACHE).catch(() => new Response('', { status: 504 })));
    return;
  }

  // Navigations: serve the cached shell immediately, refresh it in the
  // background. The page is told when a new version is ready.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match('./index.html') || await cache.match('./');
      const network = fetch(req, { cache: 'reload' }).then(res => {
        if (res && res.ok) cache.put('./index.html', res.clone()).catch(() => {});
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('Offline', { status: 503 });
    })());
    return;
  }

  // Same-origin statics.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE).catch(() => fetch(req).catch(() => new Response('', { status: 504 }))));
  }
});
