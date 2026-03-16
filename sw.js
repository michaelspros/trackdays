const SHELL_CACHE = "trackdays-shell-v1";
const EVENTS_CACHE = "trackdays-events-v1";
const OFFLINE_EVENTS_URL = "/last-known-events.json";
const SHELL_ASSETS = ["./", "./index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => ![SHELL_CACHE, EVENTS_CACHE].includes(key))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (_) {
        const cached = await caches.match("./index.html");
        return cached || Response.error();
      }
    })());
    return;
  }

  if (url.pathname === OFFLINE_EVENTS_URL) {
    event.respondWith((async () => {
      const cached = await caches.match(OFFLINE_EVENTS_URL);
      return cached || new Response(JSON.stringify({ events: [] }), {
        headers: { "content-type": "application/json" }
      });
    })());
    return;
  }

  if (SHELL_ASSETS.some((asset) => url.pathname.endsWith(asset.replace("./", "/")))) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const network = await fetch(request);
      cache.put(request, network.clone());
      return network;
    })());
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_EVENTS" || !Array.isArray(event.data.payload)) return;

  event.waitUntil((async () => {
    const cache = await caches.open(EVENTS_CACHE);
    const response = new Response(JSON.stringify({ events: event.data.payload, ts: Date.now() }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    });
    await cache.put(OFFLINE_EVENTS_URL, response);
  })());
});
