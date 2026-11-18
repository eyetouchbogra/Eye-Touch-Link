/* Eye Touch Link — offline app-shell cache v23
 * The PIN gate is embedded in index.html. Do not require the unused pin-lock.js
 * file here: a missing optional file would reject cache.addAll() and prevent
 * this service worker from installing, breaking cold offline launches.
 */
const CACHE = 'eye-touch-link-offline-v23';
const REQUIRED = [
  './index.html',
  './supabase-config.js',
  './cloud-sync.js?v=37'
];
const OPTIONAL = [
  './',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/eye-touch-link-logo.svg'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cache only files actually loaded by the live app shell.
    await cache.addAll(REQUIRED);
    // Nonessential visual assets must never block installation.
    await Promise.all(OPTIONAL.map(async path => {
      try { await cache.add(path); }
      catch (error) { console.warn('Optional app-shell cache skipped:', path, error); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('eye-touch-link-') && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(new URL('./index.html', self.registration.scope).href, fresh.clone());
        }
        return fresh;
      } catch (_) {
        const cached = await caches.match(request) ||
          await caches.match(new URL('./index.html', self.registration.scope).href);
        return cached || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(request, fresh.clone());
      }
      return fresh;
    } catch (_) {
      return Response.error();
    }
  })());
});
