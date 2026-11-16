// The app's root service worker, served as /sw.js. It keeps a copy of the app shell so TreasureHunch opens
// offline and on bad connections, and answers repeat visits from the device.
//
// vite.config.js prepends `self.__SW = { build, precache }` when it emits /sw.js: `build` changes whenever
// any precached file does, and `precache` lists this build's files. Push messages are handled by the
// separate Firebase worker (src/firebase-messaging-sw.js, scope /assets/), which this worker never touches.
const { build: BUILD, precache: PRECACHE } = self.__SW;
const SHELL = `shell-${BUILD}`;
const RUNTIME = 'runtime';
const SHELL_URL = '/index.html';
// A page load waits this long for the network before falling back to the stored shell.
const NAVIGATION_TIMEOUT_MS = 4000;
const precached = new Set(PRECACHE);
// Stored files are matched by address alone: the page asks for its scripts in CORS mode and servers
// answer with a Vary header, either of which would otherwise make an identical file look different.
const ANY = { ignoreSearch: true, ignoreVary: true };
const RUNTIME_PATHS = /^\/(?:assets|fonts|icons|illustrations)\//;

// All or nothing: if any file is missing the new worker is discarded and the old one keeps serving.
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache =>
    cache.addAll(PRECACHE.map(path => new Request(path, path === SHELL_URL ? { cache: 'no-cache' } : {})))));
});

// A new build stays in "waiting" until a page asks for it (see src/pwa.js), so an open hunt is never
// switched to different files halfway through.
self.addEventListener('message', event => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name !== SHELL).map(name => caches.delete(name)));
    await self.clients.claim();
    const pages = await self.clients.matchAll({ type: 'window' });
    for (const page of pages) page.postMessage({ type: 'sw-activated', build: BUILD, assets: PRECACHE });
  })());
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

// Pages come from the network so a deploy shows up straight away; the stored shell covers offline,
// a slow connection and a server error. Every route is the same single page.
async function loadPage(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await Promise.race([fetch(request), timeout(NAVIGATION_TIMEOUT_MS)]);
    if (response.ok) return response;
    return (await cache.match(SHELL_URL, ANY)) || response;
  } catch (error) {
    const stored = await cache.match(SHELL_URL, ANY);
    if (stored) return stored;
    throw error;
  }
}

// This build's own files never change under the same name.
async function fromShell(request) {
  const cache = await caches.open(SHELL);
  return (await cache.match(request, ANY)) || fetch(request);
}

// Other static files (a newer build's assets, illustrations, extra map glyph ranges): answer from the
// device when possible and refresh the copy in the background.
async function staleWhileRevalidate(event) {
  const cache = await caches.open(RUNTIME);
  const stored = await cache.match(event.request, { ignoreVary: true });
  const refresh = fetch(event.request).then(response => {
    if (response.ok) cache.put(event.request, response.clone()).catch(() => {});
    return response;
  });
  if (!stored) return refresh;
  event.waitUntil(refresh.catch(() => {}));
  return stored;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Firebase, analytics, fonts and every other origin go straight to the network.
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') { event.respondWith(loadPage(request)); return; }
  if (precached.has(url.pathname)) { event.respondWith(fromShell(request)); return; }
  if (RUNTIME_PATHS.test(url.pathname)) event.respondWith(staleWhileRevalidate(event));
});
