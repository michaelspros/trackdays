<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const ICS_URL = 'https://p130-caldav.icloud.com/published/2/MTA3OTI1Njk2NjEwNzkyNcZXCPkEBGXyRNljfcPcFp-zudFWU4bonEzIBQUcBqD65_CQJzxTgU71zUDgJ5PLydLI54MLZpM0KcK7zgNS1Yo';
const OUTPUT_FILE = __DIR__ . '/calendar.json';

function fail(int $status, string $message, array $extra = []): never
{
    http_response_code($status);
    echo json_encode(array_merge(['error' => $message], $extra), JSON_UNESCAPED_SLASHES);
    exit;
}

function fetchIcs(string $url): string
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_USERAGENT => 'TrackdaysRefresher/1.0',
            CURLOPT_HTTPHEADER => ['Accept: text/calendar, text/plain, */*'],
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false || $status >= 400) {
            fail(502, 'Failed to fetch iCal feed', ['status' => $status, 'detail' => $err ?: null]);
        }
        return (string) $body;
    }

    $ctx = stream_context_create([
        'http' => [
            'timeout' => 30,
            'header' => "User-Agent: TrackdaysRefresher/1.0\r\nAccept: text/calendar\r\n",
            'follow_location' => 1,
        ],
    ]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) {
        fail(502, 'Failed to fetch iCal feed');
    }
    return $body;
}

function unfoldIcs(string $raw): string
{
    $normalized = str_replace(["\r\n", "\r"], "\n", $raw);
    return preg_replace("/\n[ \t]/", '', $normalized);
}

function unescapeText(string $value): string
{
    return strtr($value, [
        '\\n' => "\n",
        '\\N' => "\n",
        '\\,' => ',',
        '\\;' => ';',
        '\\\\' => '\\',
    ]);
}

function parseDate(string $value, array $params): ?array
{
    $isDate = isset($params['VALUE']) && strtoupper($params['VALUE']) === 'DATE';
    if ($isDate || preg_match('/^\d{8}$/', $value)) {
        $d = DateTime::createFromFormat('!Ymd', $value, new DateTimeZone('UTC'));
        if (!$d) return null;
        return ['iso' => $d->format('Y-m-d'), 'allDay' => true];
    }

    $isUtc = str_ends_with($value, 'Z');
    $clean = $isUtc ? substr($value, 0, -1) : $value;
    $tz = new DateTimeZone('UTC');
    if (!$isUtc && isset($params['TZID'])) {
        try {
            $tz = new DateTimeZone($params['TZID']);
        } catch (Throwable $e) {
            $tz = new DateTimeZone('UTC');
        }
    }
    $d = DateTime::createFromFormat('Ymd\THis', $clean, $tz);
    if (!$d) return null;
    return ['iso' => $d->format(DateTime::ATOM), 'allDay' => false];
}

function parseLine(string $line): ?array
{
    $colon = strpos($line, ':');
    if ($colon === false) return null;
    $rawKey = substr($line, 0, $colon);
    $value = substr($line, $colon + 1);
    $segments = explode(';', $rawKey);
    $key = strtoupper(array_shift($segments));
    $params = [];
    foreach ($segments as $seg) {
        $eq = strpos($seg, '=');
        if ($eq === false) continue;
        $params[strtoupper(substr($seg, 0, $eq))] = trim(substr($seg, $eq + 1), '"');
    }
    return ['key' => $key, 'value' => $value, 'params' => $params];
}

function parseEvents(string $raw): array
{
    $unfolded = unfoldIcs($raw);
    $lines = explode("\n", $unfolded);
    $events = [];
    $current = null;

    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '') continue;
        if ($trimmed === 'BEGIN:VEVENT') {
            $current = ['skip' => false];
            continue;
        }
        if ($trimmed === 'END:VEVENT') {
            if ($current && !$current['skip'] && isset($current['start'])) {
                unset($current['skip']);
                $events[] = $current;
            }
            $current = null;
            continue;
        }
        if ($current === null) continue;

        $parsed = parseLine($line);
        if (!$parsed) continue;

        switch ($parsed['key']) {
            case 'UID':
                $current['uid'] = $parsed['value'];
                break;
            case 'SUMMARY':
                $current['title'] = unescapeText($parsed['value']);
                break;
            case 'LOCATION':
                $current['location'] = unescapeText($parsed['value']);
                break;
            case 'DTSTART':
                $d = parseDate($parsed['value'], $parsed['params']);
                if ($d) {
                    $current['start'] = $d['iso'];
                    $current['allDay'] = $d['allDay'];
                }
                break;
            case 'DTEND':
                $d = parseDate($parsed['value'], $parsed['params']);
                if ($d) $current['end'] = $d['iso'];
                break;
            case 'RECURRENCE-ID':
                $current['skip'] = true;
                break;
        }
    }

    usort($events, fn($a, $b) => strcmp($a['start'], $b['start']));

    $seen = [];
    $deduped = [];
    foreach ($events as $e) {
        $key = ($e['uid'] ?? '') . '|' . $e['start'];
        if (isset($seen[$key])) continue;
        $seen[$key] = true;
        $deduped[] = [
            'uid' => $e['uid'] ?? null,
            'title' => $e['title'] ?? 'Untitled',
            'location' => $e['location'] ?? '',
            'start' => $e['start'],
            'end' => $e['end'] ?? $e['start'],
            'allDay' => $e['allDay'] ?? false,
        ];
    }

    return $deduped;
}

$ics = fetchIcs(ICS_URL);
$events = parseEvents($ics);

$payload = [
    'fetchedAt' => (new DateTime('now', new DateTimeZone('UTC')))->format(DateTime::ATOM),
    'count' => count($events),
    'events' => $events,
];

$json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
if ($json === false) {
    fail(500, 'Failed to encode JSON', ['detail' => json_last_error_msg()]);
}

$tmp = OUTPUT_FILE . '.tmp';
if (file_put_contents($tmp, $json, LOCK_EX) === false) {
    fail(500, 'Failed to write calendar.json (check directory write permissions)');
}
if (!@rename($tmp, OUTPUT_FILE)) {
    @unlink($tmp);
    fail(500, 'Failed to replace calendar.json');
}

echo $json;
