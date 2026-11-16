/*
 * Service worker: makes the app usable offline after the first visit.
 *
 * This file is a template. The build (see vite.config.ts) replaces the two
 * placeholders below with the list of files it produced and a hash of their
 * contents, and writes the result to /sw.js.
 *
 * Strategy
 *   - Install: download every file the app needs to start (page, scripts,
 *     styles, the image worker, icons). The page has usually finished loading
 *     before this worker takes control, so relying on requests passing through
 *     it would leave the first visit uncached.
 *   - Page navigations: network first, falling back to the cached shell. Only
 *     a successful HTML response replaces the cached shell, so a server error
 *     page can never become what the app opens offline.
 *   - /api/*: never touched. Those answers are live and must not be cached.
 *   - Other files on this origin: cache first. Built file names contain a
 *     content hash, so a cached copy can never be stale.
 *
 * Updates
 *   A new build has a new version (a hash of every file's bytes, including
 *   the page and the files in public/), so it installs into a fresh cache. It
 *   does NOT take over pages that are already open: they keep the old worker
 *   and the old cache, so the files they load later (the image worker, for
 *   one) still exist. The new version activates once every tab of the old one
 *   has closed, and only then deletes the old caches, and only this app's.
 */
const PRECACHE = self.__PRECACHE_MANIFEST__;

/*
 * Lookups ignore the response's Vary header. Many static hosts send
 * "Vary: Origin", and the page's own script and style requests carry an
 * Origin header while the install-time downloads do not, so a strict lookup
 * would miss every precached script. These are same-origin static files whose
 * bytes do not depend on any request header, so ignoring Vary is safe.
 */
const LOOKUP = { ignoreVary: true };
const PREFIX = 'color-me-worst-';
const CACHE = `${PREFIX}${self.__PRECACHE_VERSION__}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

function isHtml(response) {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(
        (response) => {
          if (response.ok && isHtml(response)) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put('/', copy)));
            return response;
          }
          // A server error or something that is not the app: prefer the last good shell.
          return caches.match('/', LOOKUP).then((cached) => cached ?? response);
        },
        () => caches.match('/', LOOKUP).then((cached) => cached ?? Response.error()),
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(request, LOOKUP).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const noStore = (response.headers.get('cache-control') ?? '').toLowerCase().includes('no-store');
        if (response.ok && !noStore) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      });
    }),
  );
});
