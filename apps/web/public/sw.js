/* Recover service worker (§9.5; F-47). Registered with scope /s/ by the student pages.
 *
 * It precaches the app shell only: the offline page, the icon and the manifest. Navigations are
 * network-first and fall back to the offline page when the network or the server fails. Nothing else is
 * ever written to Cache Storage: no /api/ responses, no /s/ pages, no item photos, no storage URLs, so
 * deleted or claimed items cannot linger here after the server removes them.
 */
const CACHE = 'recover-shell-v1';
const OFFLINE_URL = '/offline';
const SHELL = [OFFLINE_URL, '/icons/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function offline(fallback) {
  return caches.match(OFFLINE_URL).then((hit) => hit || fallback || Response.error());
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Other origins (Storage photos, the campus map, presigned uploads) always go straight to the network.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => (response.status >= 500 ? offline(response) : response))
        .catch(() => offline(null)),
    );
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(request)));
  }
  // Everything else (API calls, scripts, styles, photos): default network behavior, never cached here.
});
