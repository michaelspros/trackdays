import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const CALENDAR_URL = process.env.ICLOUD_CALENDAR_URL || "";
const ROOT = resolve(".");
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_EVENTS = 100;
const EXPAND_DAYS = 90;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

let cache = {
  events: [],
  fetchedAt: 0
};

function normalizeFeedUrl(rawUrl) {
  if (!rawUrl) return "";
  return rawUrl.replace(/^webcal:/i, "https:");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function unfoldLines(raw) {
  return raw.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function parseICalDate(value, isDateOnly) {
  if (!value) return null;
  if (isDateOnly || /^\d{8}$/.test(value)) {
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(4, 6)) - 1;
    const d = Number(value.slice(6, 8));
    return new Date(Date.UTC(y, m, d));
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;

  const [, y, mo, d, h, mi, s, z] = match;
  if (z === "Z") {
    return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  }

  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function parseRRule(rule) {
  const parts = Object.fromEntries(
    rule.split(";").map((entry) => {
      const [k, v] = entry.split("=");
      return [k?.toUpperCase(), v];
    })
  );

  return {
    freq: parts.FREQ,
    interval: Number(parts.INTERVAL || 1),
    count: parts.COUNT ? Number(parts.COUNT) : null,
    until: parts.UNTIL ? parseICalDate(parts.UNTIL, false) : null
  };
}

function addInterval(date, freq, interval) {
  const next = new Date(date);
  if (freq === "DAILY") next.setDate(next.getDate() + interval);
  if (freq === "WEEKLY") next.setDate(next.getDate() + interval * 7);
  if (freq === "MONTHLY") next.setMonth(next.getMonth() + interval);
  if (freq === "YEARLY") next.setFullYear(next.getFullYear() + interval);
  return next;
}

function expandEvent(event, now, until) {
  const instances = [];
  const durationMs = Math.max(0, event.end.getTime() - event.start.getTime());
  const collect = (startDate, allDay) => {
    const endDate = new Date(startDate.getTime() + durationMs);
    if (endDate < now) return;
    instances.push({
      uid: event.uid,
      title: event.title,
      start: startDate,
      end: endDate,
      allDay,
      location: event.location
    });
  };

  if (!event.rrule) {
    collect(event.start, event.allDay);
    return instances;
  }

  const rule = parseRRule(event.rrule);
  const supported = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
  if (!supported.includes(rule.freq)) {
    collect(event.start, event.allDay);
    return instances;
  }

  let cursor = new Date(event.start);
  let generated = 0;
  while (generated < 1200) {
    if (cursor > until) break;
    if (rule.until && cursor > rule.until) break;
    collect(new Date(cursor), event.allDay);
    generated += 1;
    if (rule.count && generated >= rule.count) break;
    cursor = addInterval(cursor, rule.freq, rule.interval);
  }

  return instances;
}

function parseCalendar(raw) {
  const clean = unfoldLines(raw);
  const lines = clean.split(/\r?\n/);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const rawKey = line.slice(0, idx);
    const value = line.slice(idx + 1).trim();
    const [name, ...params] = rawKey.split(";");
    const key = name.toUpperCase();
    const isDateOnly = params.some((p) => p.toUpperCase() === "VALUE=DATE");

    if (key === "UID") current.uid = value;
    if (key === "SUMMARY") current.title = value;
    if (key === "LOCATION") current.location = value;
    if (key === "DTSTART") {
      current.start = parseICalDate(value, isDateOnly);
      current.allDay = isDateOnly;
    }
    if (key === "DTEND") current.end = parseICalDate(value, isDateOnly);
    if (key === "RRULE") current.rrule = value;
  }

  return events;
}

function sanitizeEvents(events) {
  return events.map((event) => ({
    uid: event.uid,
    title: event.title,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    allDay: event.allDay,
    location: event.location
  }));
}

function parseAndExpand(raw) {
  const now = new Date();
  const until = new Date(now.getTime() + EXPAND_DAYS * 86400000);
  const parsed = parseCalendar(raw);
  const out = [];

  for (const row of parsed) {
    if (!row.start) continue;
    const end = row.end || row.start;
    const normalized = {
      uid: row.uid || "",
      title: (row.title || "Untitled").trim() || "Untitled",
      location: (row.location || "").trim(),
      start: row.start,
      end,
      allDay: !!row.allDay,
      rrule: row.rrule || null
    };

    const expanded = expandEvent(normalized, now, until);
    out.push(...expanded);
    if (out.length >= MAX_EVENTS * 3) break;
  }

  out.sort((a, b) => a.start - b.start);
  const dedupe = [];
  const seen = new Set();
  for (const event of out) {
    const key = `${event.uid}|${event.start.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupe.push(event);
    if (dedupe.length >= MAX_EVENTS) break;
  }

  return dedupe;
}

async function fetchCalendarEvents() {
  const now = Date.now();
  if (cache.events.length && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.events;
  }

  const url = normalizeFeedUrl(CALENDAR_URL);
  if (!url) {
    throw new Error("Missing ICLOUD_CALENDAR_URL environment variable");
  }

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Calendar fetch failed: HTTP ${response.status}`);
  }

  const rawCalendar = await response.text();
  const parsedEvents = parseAndExpand(rawCalendar);
  cache = {
    events: sanitizeEvents(parsedEvents),
    fetchedAt: now
  };

  return cache.events;
}

async function serveStatic(req, res, pathname) {
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
      const events = await fetchCalendarEvents();
      sendJson(res, 200, { events, fetchedAt: cache.fetchedAt });
    } catch (error) {
      sendJson(res, 500, {
        error: "Could not load calendar events",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
    }
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Trackdays server running on http://localhost:${PORT}`);
});
