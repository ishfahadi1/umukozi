// UMUKOZI service worker. Goal: the newest release reaches every device, and nobody is stuck on an old screen.
// - App files are always asked from the server again (revalidated), never served old from the browser cache.
// - Only the newest cache survives. Caches of older releases are deleted when a new release activates.
// - Pages reload once when a new release takes over, so the new version shows at once.
// - The admin page is never cached.
// Bump VERSION on every release.

const VERSION = 'umukozi-2026-11-11-v16';

const CACHE = 'umukozi-cache-' + VERSION;
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
  '/favicon-32.png', '/assets/logo.png', '/assets/ish-logo.png', '/assets/landing.jpg', '/assets/landing-tab.jpg',
  '/assets/landing-sq.jpg', '/assets/land.jpg'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Each file is added on its own, so one missing file never stops the app from installing.
    await Promise.all(SHELL.map((url) =>
      fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? cache.put(url, r) : null)).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'VERSION') {
    const reply = event.ports && event.ports[0] ? event.ports[0] : event.source;
    if (reply) reply.postMessage({ type: 'VERSION', version: VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Supabase, XentriPAY, fonts: straight to the network, never through this worker.
  if (url.origin !== self.location.origin) return;
  // The worker file itself is always fetched fresh by the browser.
  if (url.pathname === '/sw.js') return;
  // The admin page is never cached, not even offline.
  if (url.pathname.startsWith('/admin')) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const isPage = req.mode === 'navigate';
  try {
    // 'no-cache' asks the server for the newest copy each time; the server answers 304 when nothing changed.
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok && res.type === 'basic') {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    // Offline only: fall back to the last copy we have.
    const hit = await caches.match(req, { ignoreSearch: isPage });
    if (hit) return hit;
    if (isPage) {
      const shell = await caches.match('/index.html');
      if (shell) return shell;
    }
    return Response.error();
  }
}
