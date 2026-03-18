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
  ics: 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Trackdays//Cache Seed//EN\nEND:VCALENDAR'
};

const cacheState = {
  data: null,
  inflight: null
};

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
  const text = await res.text();
  return {
    source: ICLOUD_HTTPS_URL,
    fetchedAt: new Date().toISOString(),
    ics: text
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
