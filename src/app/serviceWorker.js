/*
 * Service worker: makes the app usable offline after the first visit.
 *
 * This file is a template. The build (see vite.config.ts) replaces the two
 * placeholders below with the list of files it produced and a hash of that
 * list, and writes the result to /sw.js.
 *
 * Strategy
 *   - Install: download every file the app needs to start (page, scripts,
 *     styles, the image worker, icons). The page has usually finished loading
 *     before this worker takes control, so relying on requests passing through
 *     it would leave the first visit uncached.
 *   - Page navigations: network first, falling back to the cached shell, so a
 *     new release is picked up whenever the device is online.
 *   - Everything else on this origin: cache first. Built file names contain a
 *     content hash, so a cached copy can never be stale.
 * A new build has a new hash, so it gets a fresh cache and the old one is
 * deleted on activation.
 */
const PRECACHE = self.__PRECACHE_MANIFEST__;
const CACHE = `color-me-worst-${self.__PRECACHE_VERSION__}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
