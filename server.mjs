import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_EVENTS = 100;
const EXPAND_DAYS = 90;

const ICLOUD_WEBCAL_URL = 'webcal://p130-caldav.icloud.com/published/2/MTA3OTI1Njk2NjEwNzkyNcZXCPkEBGXyRNljfcPcFp-zudFWU4bonEzIBQUcBqD65_CQJzxTgU71zUDgJ5PLydLI54MLZpM0KcK7zgNS1Yo';
const ICLOUD_HTTPS_URL = ICLOUD_WEBCAL_URL.replace(/^webcal:/i, 'https:');

const cache = { generatedAt: 0, events: [], inflight: null };

function unfoldIcsLines(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function parseDateValue(value, isAllDay = false) {
  if (!value) return null;
  if (isAllDay && /^\d{8}$/.test(value)) {
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(4, 6)) - 1;
    const d = Number(value.slice(6, 8));
    return new Date(Date.UTC(y, m, d));
  }
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(4, 6)) - 1;
    const d = Number(value.slice(6, 8));
    const hh = Number(value.slice(9, 11));
    const mm = Number(value.slice(11, 13));
    const ss = Number(value.slice(13, 15));
    return new Date(Date.UTC(y, m, d, hh, mm, ss));
  }
  if (/^\d{8}T\d{6}$/.test(value)) {
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(4, 6)) - 1;
    const d = Number(value.slice(6, 8));
    const hh = Number(value.slice(9, 11));
    const mm = Number(value.slice(11, 13));
    const ss = Number(value.slice(13, 15));
    return new Date(y, m, d, hh, mm, ss);
  }
  return new Date(value);
}

function parseRRule(raw) {
  if (!raw) return null;
  const fields = Object.fromEntries(raw.split(';').map((part) => {
    const [key, value] = part.split('=');
    return [key, value];
  }));
  return {
    freq: fields.FREQ,
    interval: Number(fields.INTERVAL || 1),
    count: fields.COUNT ? Number(fields.COUNT) : null,
    until: fields.UNTIL ? parseDateValue(fields.UNTIL, false) : null,
    byday: fields.BYDAY ? new Set(fields.BYDAY.split(',')) : null
  };
}

const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function stepOccurrence(date, freq, interval) {
  const d = new Date(date);
  if (freq === 'DAILY') d.setDate(d.getDate() + interval);
  else if (freq === 'WEEKLY') d.setDate(d.getDate() + 7 * interval);
  else if (freq === 'MONTHLY') d.setMonth(d.getMonth() + interval);
  else if (freq === 'YEARLY') d.setFullYear(d.getFullYear() + interval);
  else d.setDate(d.getDate() + interval);
  return d;
}

function expandOccurrences(event, now, untilWindow) {
  const start = event.start;
  const end = event.end || event.start;
  const durationMs = Math.max(0, end - start);

  if (!event.rrule) return [{ start, end }];

  const rrule = parseRRule(event.rrule);
  if (!rrule?.freq) return [{ start, end }];

  const out = [];
  let curr = new Date(start);
  let count = 0;
  const max = Math.min(rrule.count || 1200, 1200);

  while (count < max && curr <= untilWindow) {
    const dayOk = !rrule.byday || rrule.byday.has(DOW[curr.getDay()]);
    if (dayOk) {
      const occEnd = new Date(curr.getTime() + durationMs);
      if (occEnd >= now) out.push({ start: new Date(curr), end: occEnd });
    }
    count += 1;
    curr = stepOccurrence(curr, rrule.freq, rrule.interval);
    if (rrule.until && curr > rrule.until) break;
  }

  return out;
}

function parseAndNormalizeIcs(rawIcs) {
  const lines = unfoldIcsLines(rawIcs);
  const now = new Date();
  const untilWindow = new Date(now.getTime() + EXPAND_DAYS * 86400000);
  const events = [];

  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current?.dtstart) {
        const allDay = current.dtstartParam?.includes('VALUE=DATE') || false;
        const start = parseDateValue(current.dtstart, allDay);
        const end = parseDateValue(current.dtend, allDay) || start;
        if (start) {
          const baseEvent = {
            uid: current.uid || `${current.summary || 'event'}-${start.getTime()}`,
            title: (current.summary || 'Untitled').trim() || 'Untitled',
            location: (current.location || '').trim(),
            allDay,
            start,
            end,
            rrule: current.rrule
          };

          const occurrences = expandOccurrences(baseEvent, now, untilWindow);
          for (const occ of occurrences) {
            events.push({
              uid: baseEvent.uid,
              title: baseEvent.title,
              location: baseEvent.location,
              allDay: baseEvent.allDay,
              start: occ.start.toISOString(),
              end: occ.end.toISOString()
            });
            if (events.length >= MAX_EVENTS * 3) break;
          }
        }
      }
      current = null;
      continue;
    }

    if (!current) continue;

    const [left, value = ''] = line.split(':', 2);
    const [key, ...params] = left.split(';');
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'uid') current.uid = value;
    else if (lowerKey === 'summary') current.summary = value;
    else if (lowerKey === 'location') current.location = value;
    else if (lowerKey === 'rrule') current.rrule = value;
    else if (lowerKey === 'dtstart') {
      current.dtstart = value;
      current.dtstartParam = params.join(';');
    } else if (lowerKey === 'dtend') {
      current.dtend = value;
    }
  }

  events.sort((a, b) => new Date(a.start) - new Date(b.start));
  const deduped = [];
  const seen = new Set();
  for (const e of events) {
    const key = `${e.uid}|${e.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
    if (deduped.length >= MAX_EVENTS) break;
  }
  return deduped;
}

async function refreshCache(force = false) {
  const now = Date.now();
  if (!force && cache.events.length && now - cache.generatedAt < CACHE_TTL_MS) return;
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    const fetchIcs = async (url) => {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`ICS HTTP ${res.status}`);
      return res.text();
    };

    let rawIcs;
    try {
      rawIcs = await fetchIcs(ICLOUD_HTTPS_URL);
    } catch {
      rawIcs = await fetchIcs(`https://api.allorigins.win/raw?url=${encodeURIComponent(ICLOUD_HTTPS_URL)}`);
    }

    cache.events = parseAndNormalizeIcs(rawIcs);
    cache.generatedAt = Date.now();
  })();

  try {
    await cache.inflight;
  } finally {
    cache.inflight = null;
  }
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300'
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/events') {
    try {
      const force = url.searchParams.get('refresh') === '1';
      await refreshCache(force);
      return sendJson(res, 200, { generatedAt: cache.generatedAt, events: cache.events });
    } catch {
      if (cache.events.length) {
        return sendJson(res, 200, { generatedAt: cache.generatedAt, events: cache.events, stale: true });
      }
      return sendJson(res, 502, { error: 'Unable to load events' });
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile(path.join(process.cwd(), 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('Unable to read index.html');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Trackdays server listening on http://${HOST}:${PORT}`);
});
