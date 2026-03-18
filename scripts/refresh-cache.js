const fs = require('fs/promises');
const path = require('path');

const ICLOUD_WEBCAL_URL = 'webcal://p130-caldav.icloud.com/published/2/MTA3OTI1Njk2NjEwNzkyNcZXCPkEBGXyRNljfcPcFp-zudFWU4bonEzIBQUcBqD65_CQJzxTgU71zUDgJ5PLydLI54MLZpM0KcK7zgNS1Yo';
const ICLOUD_HTTPS_URL = ICLOUD_WEBCAL_URL.replace(/^webcal:/i, 'https:');
const CACHE_FILE = path.join(__dirname, '..', 'cache', 'events.json');

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

async function refreshCacheFile() {
  const response = await fetch(ICLOUD_HTTPS_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`iCloud request failed: HTTP ${response.status}`);
  }

  const ics = await response.text();
  const payload = {
    source: ICLOUD_HTTPS_URL,
    fetchedAt: new Date().toISOString(),
    events: parseEventsFromICS(ics)
  };

  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

refreshCacheFile().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
