const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_EVENTS = 100;
const EXPAND_DAYS = 90;

let cache = {
  events: [],
  fetchedAt: 0
};

function normalizeFeedUrl(rawUrl) {
  if (!rawUrl) return "";
  return rawUrl.replace(/^webcal:/i, "https:");
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

    out.push(...expandEvent(normalized, now, until));
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

export async function fetchCalendarEvents(calendarUrl) {
  const now = Date.now();
  if (cache.events.length && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { events: cache.events, fetchedAt: cache.fetchedAt };
  }

  const url = normalizeFeedUrl(calendarUrl);
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

  return { events: cache.events, fetchedAt: cache.fetchedAt };
}
