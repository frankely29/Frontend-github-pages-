const CACHE_NAME = "tjmap-v1";

// Core shell assets to pre-cache on install
const PRECACHE_URLS = [
  "/",
  "/frontend-shell.css",
  "/index.extracted.css",
  "/navigation.preview.css",
  "/navigation.turnbyturn.css"
];

// Patterns that MUST bypass the service worker (live data, API, external tiles)
const NO_CACHE_PATTERNS = [
  /\/presence\//,
  /\/auth\//,
  /\/me(\/|$|\?)/,
  /\/chat\//,
  /\/events\//,
  /\/frame\//,
  /\/timeline/,
  /\/day_tendency\//,
  /\/admin\//,
  /\/leaderboard/,
  /\/assistant\//,
  /\/drivers\//,
  /web-production-.*\.up\.railway\.app/,
  /router\.project-osrm\.org/,
  /nominatim\.openstreetmap\.org/,
  /tiles\.openfreemap\.org/,
  /basemaps\.cartocdn\.com/,
  /demotiles\.maplibre\.org/,
  /unpkg\.com/
];

// Cacheable asset pattern (same-origin only)
const CACHEABLE_ASSET_PATTERN = /\.(js|css|woff2?|ttf|svg|ico|webmanifest)(\?|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn("SW precache partial failure:", err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or external data sources
  if (NO_CACHE_PATTERNS.some((pattern) => pattern.test(event.request.url))) {
    return;
  }

  // Only cache GET requests
  if (event.request.method !== "GET") {
    return;
  }

  // Same-origin cacheable assets: network-first with cache fallback
  if (url.origin === self.location.origin && CACHEABLE_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
    return;
  }

  // HTML shell: network-first, fall back to cached root shell
  if (event.request.mode === "navigate" || event.request.destination === "document") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(() => {
          return caches.match("/") || caches.match(event.request);
        })
    );
    return;
  }
});
