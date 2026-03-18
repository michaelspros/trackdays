const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const CACHE_FILE = path.join(__dirname, 'cache', 'events.json');
const REFRESH_SCRIPT = path.join(__dirname, 'scripts', 'refresh-cache.js');

const DEFAULT_CACHE_PAYLOAD = {
  source: 'https://p130-caldav.icloud.com/',
  fetchedAt: null,
  events: []
};

function execFileAsync(file, args = []) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [file, ...args], { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureCacheFileExists() {
  try {
    await fs.access(CACHE_FILE);
  } catch (_) {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(DEFAULT_CACHE_PAYLOAD, null, 2));
  }
}

async function readCacheFile() {
  const raw = await fs.readFile(CACHE_FILE, 'utf8');
  return JSON.parse(raw);
}

async function runRefreshScript() {
  await execFileAsync(REFRESH_SCRIPT);
  return readCacheFile();
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
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
    const contentType = ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.json'
        ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8';
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
      const payload = await readCacheFile();
      return sendJson(res, 200, payload);
    }

    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      const payload = await runRefreshScript();
      return sendJson(res, 200, payload);
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
