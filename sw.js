// UMUKOZI service worker: installable app that opens fast and still shows the last screen offline.
// Only same-origin app files are cached. Supabase, Cloudinary and fonts always go straight to the network.
const VERSION = 'umukozi-v3';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Each file is added on its own, so one missing file never stops the app from installing.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // other services: straight to the network

  // Network first, so a new deploy shows up at once. The cache is only used when offline.
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(VERSION);
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      const isPage = req.mode === 'navigate';
      const hit = await caches.match(req, { ignoreSearch: isPage });
      if (hit) return hit;
      if (isPage) {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
