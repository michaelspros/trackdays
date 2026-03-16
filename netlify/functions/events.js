import { fetchCalendarEvents } from "../../lib/calendar-feed.js";

export async function handler() {
  try {
    const payload = await fetchCalendarEvents(process.env.ICLOUD_CALENDAR_URL || "");
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      },
      body: JSON.stringify(payload)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        error: "Could not load calendar events",
        detail: error instanceof Error ? error.message : "Unknown error"
      })
    };
  }
}
