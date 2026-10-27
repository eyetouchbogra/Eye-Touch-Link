
const CACHE = 'eye-touch-link-v4';

const FILES = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(async cache => {
      for (const file of FILES) {
        try {
          await cache.add(file);
        } catch (error) {
          console.warn('Could not cache:', file, error);
        }
      }
    })
  );

  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key =>
            key.startsWith('eye-touch-link-') &&
            key !== CACHE
          )
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).catch(() =>
        caches.match('./index.html')
      );
    })
  );
});
