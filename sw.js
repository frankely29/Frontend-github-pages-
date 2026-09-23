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
  /demotiles\.maplibre\.org/
];

/* maplibre-gl is ~900KB from a third-party CDN, and it is the one thing the
 * map cannot start without. It used to sit in NO_CACHE_PATTERNS above, so
 * every cold open re-downloaded it from unpkg before the map could begin --
 * and unpkg's speed is not ours to rely on.
 *
 * It is safe to cache where tiles are not: the URL pins an exact version, so
 * the bytes behind it never change. A version bump changes the URL and misses
 * the cache, which is the correct behaviour. */
const VERSIONED_CDN_PATTERN = /^https:\/\/unpkg\.com\/maplibre-gl@\d[\w.\-]*\//;

// Cacheable asset pattern (same-origin only)
const CACHEABLE_ASSET_PATTERN = /\.(js|css|woff2?|ttf|svg|ico|webmanifest)(\?|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Use per-URL cache.add so one bad URL doesn't zero out the rest of
      // the precache (cache.addAll is atomic; addAll rejects on any single
      // failure). This keeps the shell fallback usable even if one asset
      // is temporarily 404 during a deploy.
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn("SW precache miss for", url, err);
          })
        )
      );
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

  /* The pinned map library: cache-first.
   *
   * Network-first would still pay the round trip on every open, which is the
   * whole problem. The URL carries an exact version, so a hit is always the
   * right bytes and there is nothing to revalidate. */
  if (VERSIONED_CDN_PATTERN.test(event.request.url)) {
    event.respondWith(
      caches.match(event.request).then((hit) => {
        if (hit) return hit;
        return fetch(event.request).then((response) => {
          // An opaque response (no CORS) is cacheable but unreadable, and
          // storing one would serve an opaque body forever. Only keep a real
          // one; the script tag sets crossorigin, so a real one is expected.
          if (response.ok && response.type !== 'opaque') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
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
        .catch(async () => {
          const shell = await caches.match("/");
          if (shell) return shell;
          const exact = await caches.match(event.request);
          if (exact) return exact;
          // Final fallback: return a proper Response so respondWith doesn't
          // resolve to undefined (which would be an opaque network error).
          return new Response(
            "Offline — no cached content available. Reconnect to load the app.",
            { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
          );
        })
    );
    return;
  }
});
