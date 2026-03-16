import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { URL } from "node:url";
import { fetchCalendarEvents } from "./lib/calendar-feed.js";

const PORT = Number(process.env.PORT || 3000);
const CALENDAR_URL = process.env.ICLOUD_CALENDAR_URL || "";
const ROOT = resolve(".");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(join(ROOT, safePath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/events") {
    try {
      const payload = await fetchCalendarEvents(CALENDAR_URL);
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 500, {
        error: "Could not load calendar events",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
    }
    return;
  }

  await serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Trackdays server running on http://localhost:${PORT}`);
});
