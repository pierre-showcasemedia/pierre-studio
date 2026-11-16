// Wall-clock helpers for bookings. Every time the form gives us is in the
// business's time zone (business.timeZone): the database stores instants, and
// the calendar, the Slack line and the emails show that wall clock again. No
// library, so the offset comes from Intl (DST safe).
import { BUSINESS_TZ } from "./business";
export { BUSINESS_TZ };

export function isYmd(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// "2026-10-20" | "10/20/2026" | "Oct 20, 2026" → "2026-10-20", or null.
export function toYmd(v: unknown): string | null {
  if (isYmd(v)) return v;
  const s = String(v ?? "").trim();
  if (!s) return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const c = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    return isYmd(c) ? c : null;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

// "09:00" | "9:00" | "9:00 AM" | "2:30pm" | "14:30" → "HH:MM" (24 h), or null.
export function toHm(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? "0");
  const ap = (m[3] ?? "").toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

// Minutes to add to a UTC instant to get local wall clock (-420 PDT, -480 PST).
function tzOffsetMinutes(at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

// local wall clock ("2026-10-20", "09:00") → the instant it names.
export function wallClockToUtc(ymd: string, hm: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  const t = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m || !t) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]));
  let utc = guess - tzOffsetMinutes(new Date(guess)) * 60_000;
  // One more pass for the handful of hours a year where the first guess
  // lands on the other side of a DST switch.
  utc = guess - tzOffsetMinutes(new Date(utc)) * 60_000;
  return new Date(utc);
}

export function fmtTime12(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ap}`;
}

// "Mon, Oct 20" or "Monday, October 20" from a calendar date (no zone shift).
export function fmtDay(ymd: string, opts: { long?: boolean } = {}): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: opts.long ? "long" : "short",
    month: opts.long ? "long" : "short",
    day: "numeric",
  }).format(new Date(`${ymd}T12:00:00Z`));
}

// What the booking asked for, as people read it: "Mon, Oct 20 at 9:00 AM".
export function fmtWhen(b: { desiredDate: string | null; startTime: string | null }, opts: { long?: boolean } = {}): string | null {
  if (!b.desiredDate) return null;
  const day = fmtDay(b.desiredDate, opts);
  return b.startTime ? `${day} at ${fmtTime12(b.startTime)}` : day;
}

// An instant as the team reads it, local: "Oct 20, 9:00 AM" (admin pages;
// the server runs in UTC, so toLocaleString alone would shift the clock).
export function fmtLa(v: Date | string | null | undefined, opts: { date?: boolean } = {}): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    month: "short",
    day: "numeric",
    ...(opts.date ? {} : { hour: "numeric", minute: "2-digit" }),
  }).format(d);
}
