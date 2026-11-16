// "Today" as the team lives it: the local (America/Los_Angeles) calendar
// date. The server runs in UTC, so new Date().toISOString().slice(0, 10) turns
// into tomorrow at 5 PM local (4 PM in winter) and every booking dated today
// used to drop out of "Upcoming" for the evening.
import { BUSINESS_TZ } from "./booking-time";

const YMD = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

// The local calendar date of an instant, "YYYY-MM-DD".
export function localYmd(at: Date = new Date()): string {
  const p: Record<string, string> = {};
  for (const part of YMD.formatToParts(at)) if (part.type !== "literal") p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

// Calendar arithmetic on a "YYYY-MM-DD" date (no zone involved).
export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
