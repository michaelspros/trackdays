import { fetchCalendarEvents } from "../lib/calendar-feed.js";

export default async function handler(req, res) {
  try {
    const payload = await fetchCalendarEvents(process.env.ICLOUD_CALENDAR_URL || "");
    res.status(200).json(payload);
  } catch (error) {
    res.status(500).json({
      error: "Could not load calendar events",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
