# Trackdays

A small self-hosted web app that turns one or more iCal (`.ics`) feeds into a
fast, mobile-friendly trackday agenda. The frontend is a single static HTML
file; a tiny PHP script fetches the feeds, parses the events, and caches them
as JSON on disk.

## Features

- **List and month views** over your trackday calendar.
- **Multiple feeds**: switch between tracks/series via a dropdown.
- **Add-to-calendar** button on each upcoming event.
- **Past events** can be hidden or shown with a single toggle.
- **Light / dark / system theme**, remembered between visits.
- **Mobile-first**: large tap targets, no double-tap zoom, installable as a
  home-screen web app.
- **Offline-friendly**: the last successful fetch is served from cached JSON.

## How it works

```
ICS feed(s) ──► refresh.php ──► data/calendar-<slug>.json ──► index.html
```

1. `index.html` asks `refresh.php?action=feeds` for the configured feed list.
2. When the user picks a feed (or hits **Refresh**), the page POSTs to
   `refresh.php?feed=<slug>`.
3. `refresh.php` downloads the ICS over HTTPS, parses `VEVENT`s, sorts and
   de-duplicates them, and atomically writes
   `data/calendar-<slug>.json`. The first feed is also mirrored to
   `data/calendar.json` for backward compatibility.
4. The page renders events from the JSON response.

## Requirements

- PHP 8.0+ (uses `declare(strict_types=1)` and `never` return type).
- `curl` extension recommended; falls back to `file_get_contents` with an
  HTTPS stream context if curl is unavailable.
- A web server that can serve static files and run PHP (Apache, nginx +
  php-fpm, Caddy, the built-in PHP dev server, etc.).
- A writable `data/` directory.

## Setup

1. Clone the repo into your web root (or a subdirectory of it):

   ```bash
   git clone https://github.com/michaelspros/trackdays.git
   cd trackdays
   ```

2. Copy the example env file and add your feed(s):

   ```bash
   cp .env.example .env
   ```

   Single-feed (legacy) setup:

   ```env
   ICS_URL=https://example.com/published/your-calendar-token
   ```

   Multi-feed setup — add as many as you like by incrementing the number.
   Each feed needs a `_LABEL` (shown in the UI dropdown) and a `_URL`
   (must be `https://`):

   ```env
   ICS_FEED_1_LABEL=Track A
   ICS_FEED_1_URL=https://example.com/published/feed-a-token

   ICS_FEED_2_LABEL=Track B
   ICS_FEED_2_URL=https://example.com/published/feed-b-token
   ```

3. Make sure `data/` is writable by the web server user:

   ```bash
   chmod 775 data
   ```

4. Serve the directory. For quick local testing:

   ```bash
   php -S 127.0.0.1:8080
   ```

   Then open <http://127.0.0.1:8080/>.

## Configuration reference

| Variable                  | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `ICS_URL`                 | Legacy single-feed URL. Used only if no `ICS_FEED_*`.  |
| `ICS_FEED_<n>_LABEL`      | Human-readable name shown in the feed dropdown.        |
| `ICS_FEED_<n>_URL`        | HTTPS URL of the ICS feed.                             |

`<n>` can be any alphanumeric identifier; feeds are listed in natural sort
order of `<n>`. Labels are slugified for use in URLs and filenames.

## Endpoints

`refresh.php` exposes two operations:

- `GET refresh.php?action=feeds` — returns the configured feeds:

  ```json
  { "feeds": [{ "label": "Track A", "slug": "track-a" }], "default": "track-a" }
  ```

- `POST refresh.php?feed=<slug>` — fetches the feed, writes
  `data/calendar-<slug>.json`, and returns the parsed payload:

  ```json
  {
    "fetchedAt": "2026-05-13T12:00:00+00:00",
    "feed": { "label": "Track A", "slug": "track-a" },
    "count": 12,
    "events": [
      {
        "uid": "…",
        "title": "Track day — Group A",
        "location": "Some Circuit",
        "start": "2026-05-20T08:00:00+00:00",
        "end":   "2026-05-20T18:00:00+00:00",
        "allDay": false
      }
    ]
  }
  ```

  Errors are returned as JSON with an `error` field and an appropriate HTTP
  status code.

## Project layout

```
.
├── index.html       # Single-page frontend (HTML + CSS + JS)
├── refresh.php      # Fetches and parses ICS feeds → JSON
├── data/            # Cached JSON (gitignored, created on first refresh)
├── .env.example     # Template for your feed configuration
└── .gitignore
```

## Security notes

- Feed URLs must be `https://` — `refresh.php` refuses anything else.
- `.env` and cached JSON files are gitignored. Don't commit feed tokens.
- The app is intended to run behind your own web server; there is no
  authentication layer.
