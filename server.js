const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ICLOUD_WEBCAL_URL = 'webcal://p130-caldav.icloud.com/published/2/MTA3OTI1Njk2NjEwNzkyNcZXCPkEBGXyRNljfcPcFp-zudFWU4bonEzIBQUcBqD65_CQJzxTgU71zUDgJ5PLydLI54MLZpM0KcK7zgNS1Yo';
const ICLOUD_HTTPS_URL = ICLOUD_WEBCAL_URL.replace(/^webcal:/i, 'https:');
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const CACHE_FILE = path.join(__dirname, 'cache', 'events.json');

const DEFAULT_CACHE_PAYLOAD = {
  source: ICLOUD_HTTPS_URL,
  fetchedAt: '1970-01-01T00:00:00.000Z',
  ics: 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Trackdays//Cache Seed//EN\nEND:VCALENDAR',
  events: [
    {
      uid: 'seed-event',
      title: 'Cache warming in progress',
      location: 'TBD',
      start: '1970-01-01T00:00:00.000Z',
      end: '1970-01-01T01:00:00.000Z',
      allDay: false,
      date: '1970-01-01'
    }
  ]
};

const cacheState = {
  data: null,
  inflight: null
};

function unfoldICS(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseICalDate(rawValue) {
  if (!rawValue) return null;
  const value = rawValue.trim();

  if (/^\d{8}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6)) - 1;
    const day = Number(value.slice(6, 8));
    return { date: new Date(Date.UTC(year, month, day)), allDay: true };
  }

  const utcMatch = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (utcMatch) {
    const [, y, m, d, hh, mm, ss] = utcMatch;
    return {
      date: new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))),
      allDay: false
    };
  }

  const localMatch = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (localMatch) {
    const [, y, m, d, hh, mm, ss] = localMatch;
    return {
      date: new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)),
      allDay: false
    };
  }

  return null;
}

function parseEventsFromICS(ics) {
  const unfolded = unfoldICS(ics);
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  const events = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const event = {
      uid: '',
      title: '',
      location: '',
      start: null,
      end: null,
      allDay: false,
      date: ''
    };

    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;

      const keyPart = line.slice(0, separator);
      const value = line.slice(separator + 1).trim();
      const key = keyPart.split(';')[0].toUpperCase();

      if (key === 'UID') event.uid = value;
      if (key === 'SUMMARY') event.title = value;
      if (key === 'LOCATION') event.location = value;
      if (key === 'DTSTART') {
        const parsed = parseICalDate(value);
        if (parsed) {
          event.start = parsed.date.toISOString();
          event.allDay = parsed.allDay;
          event.date = parsed.date.toISOString().slice(0, 10);
        }
      }
      if (key === 'DTEND') {
        const parsed = parseICalDate(value);
        if (parsed) event.end = parsed.date.toISOString();
      }
    }

    if (event.start) {
      if (!event.title) event.title = 'Untitled';
      events.push(event);
    }
  }

  events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return events;
}

async function readDiskCache() {
  if (cacheState.data) return cacheState.data;
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    cacheState.data = JSON.parse(raw);
    return cacheState.data;
  } catch (_) {
    return null;
  }
}

async function writeDiskCache(payload) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(payload, null, 2));
}

async function ensureCacheFileExists() {
  try {
    await fs.access(CACHE_FILE);
  } catch (_) {
    await writeDiskCache(DEFAULT_CACHE_PAYLOAD);
  }
}

async function fetchCalendarFromSource() {
  const res = await fetch(ICLOUD_HTTPS_URL, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`iCloud request failed: HTTP ${res.status}`);
  }

  const ics = await res.text();
  return {
    source: ICLOUD_HTTPS_URL,
    fetchedAt: new Date().toISOString(),
    ics,
    events: parseEventsFromICS(ics)
  };
}

async function getCalendarPayload(forceRefresh = false) {
  const disk = await readDiskCache();
  const lastFetchAt = disk ? Date.parse(disk.fetchedAt) : 0;
  const isFresh = disk && Number.isFinite(lastFetchAt) && Date.now() - lastFetchAt < CACHE_TTL_MS;

  if (!forceRefresh && isFresh) {
    return { payload: disk, cache: 'HIT' };
  }

  if (!cacheState.inflight) {
    cacheState.inflight = (async () => {
      try {
        const payload = await fetchCalendarFromSource();
        cacheState.data = payload;
        await writeDiskCache(payload);
        return { payload, cache: 'MISS' };
      } finally {
        cacheState.inflight = null;
      }
    })();
  }

  try {
    return await cacheState.inflight;
  } catch (err) {
    if (disk) return { payload: disk, cache: 'STALE' };
    throw err;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function getStaticPath(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') return path.join(__dirname, 'index.html');
  return path.join(__dirname, urlPath.slice(1));
}

async function serveStatic(req, res) {
  const filePath = getStaticPath(req.url.split('?')[0]);
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/events.json') {
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const result = await getCalendarPayload(forceRefresh);
      return sendJson(res, 200, {
        source: result.payload.source,
        fetchedAt: result.payload.fetchedAt,
        cache: result.cache,
        events: result.payload.events || [],
        ics: result.payload.ics
      });
    }

    if (req.method === 'GET') {
      return serveStatic(req, res);
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    sendJson(res, 500, { error: 'Server error', details: err.message });
  }
});

ensureCacheFileExists()
  .catch((err) => {
    console.error('Failed to initialize cache file', err);
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`Trackdays server listening on http://0.0.0.0:${PORT}`);
    });
  });
