/* Tambola MP — resilient, user-controlled PWA updates. */
const CACHE_VERSION = 'v36';
const CACHE_NAME = `tambola-mp-${CACHE_VERSION}`;
const STATIC_ASSETS = [
  '/', '/index.html', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/images/ball.png', '/images/numberboard.png', '/images/home-bg.png',
  '/sounds/draw.mp3', '/sounds/mark.mp3', '/sounds/win.mp3',
  '/sounds/error.mp3', '/sounds/claim.mp3', '/sounds/music.mp3',
  ...Array.from({ length: 90 }, (_, index) => `/sounds/numbers/${index + 1}.mp3`),
];

async function cacheAsset(cache, url) {
  try {
    const response = await fetch(url, { cache: 'reload' });
    if (response.ok && response.type === 'basic') await cache.put(url, response);
  } catch (error) {
    console.warn(`[SW] Optional precache failed: ${url}`, error);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(
    (cache) => Promise.allSettled(STATIC_ASSETS.map((url) => cacheAsset(cache, url))),
  ));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('tambola-mp-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, navigation = false) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (navigation) {
      const shell = await caches.match('/index.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.headers.has('range')) return;

  const networkFirstRequest = event.request.mode === 'navigate' ||
    url.pathname.endsWith('.js') || url.pathname.endsWith('.css') ||
    url.pathname.startsWith('/assets/');
  event.respondWith(networkFirstRequest
    ? networkFirst(event.request, event.request.mode === 'navigate')
    : cacheFirst(event.request));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
