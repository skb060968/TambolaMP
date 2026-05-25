/* ==============================
   Tambola MP PWA Service Worker
   - Network-first for HTML/JS/CSS
   - Cache-first for static assets (images, sounds, icons)
   ============================== */

const CACHE_NAME = "tambola-mp-v17";

const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/images/ball.png",
  "/images/numberboard.png",
  "/images/home-bg.png",
  "/sounds/draw.mp3",
  "/sounds/mark.mp3",
  "/sounds/win.mp3",
  "/sounds/error.mp3",
  "/sounds/claim.mp3",
  ...Array.from({ length: 90 }, (_, i) => `/sounds/numbers/${i + 1}.mp3`),
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) return caches.delete(key);
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Network-first for HTML/JS/CSS
  if (
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.startsWith("/assets/")
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() =>
          caches
            .match(event.request)
            .then((cached) => cached || caches.match("/index.html")),
        ),
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches
      .match(event.request)
      .then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          }),
      )
      .catch(() => caches.match("/index.html")),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
