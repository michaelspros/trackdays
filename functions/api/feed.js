const ICLOUD_WEBCAL_URL =
  "webcal://p130-caldav.icloud.com/published/2/MTA3OTI1Njk2NjEwNzkyNcZXCPkEBGXyRNljfcPcFp-zudFWU4bonEzIBQUcBqD65_CQJzxTgU71zUDgJ5PLydLI54MLZpM0KcK7zgNS1Yo";
const ICLOUD_HTTPS_URL = ICLOUD_WEBCAL_URL.replace(/^webcal:/i, "https:");

const EDGE_CACHE_KEY = "https://trackdays.internal/cache/feed.ics";
const EDGE_TTL_SECONDS = 60 * 60;
const BROWSER_TTL_SECONDS = 60 * 5;

function withCacheHeaders(response, edgeState) {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/calendar; charset=utf-8");
  headers.set(
    "Cache-Control",
    `public, max-age=${BROWSER_TTL_SECONDS}, stale-while-revalidate=86400`
  );
  headers.set("CDN-Cache-Control", `public, max-age=${EDGE_TTL_SECONDS}`);
  headers.set("X-Trackdays-Edge-Cache", edgeState);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const cache = caches.default;
  const cacheKey = new Request(EDGE_CACHE_KEY, { method: "GET" });

  if (!forceRefresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return withCacheHeaders(cached, "HIT");
    }
  }

  const upstream = await fetch(ICLOUD_HTTPS_URL, {
    method: "GET",
    cf: { cacheEverything: false, cacheTtl: 0 }
  });

  if (!upstream.ok) {
    const fallback = await cache.match(cacheKey);
    if (fallback) {
      return withCacheHeaders(fallback, "STALE");
    }

    return new Response("Could not fetch upstream calendar feed.", {
      status: upstream.status
    });
  }

  const response = withCacheHeaders(new Response(upstream.body, upstream), forceRefresh ? "REFRESH" : "MISS");
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
