// Open shoot times for the client's Reschedule (Oct 2026). The same rules and
// the same calendar as the website's booking form (the website repo
// src/lib/availability.ts): days from tomorrow to 40 days out, local time,
// 8:00 AM to 5:00 PM starts every 30 minutes, Sundays closed, and a start is
// open when the whole shoot window misses every busy block on every calendar
// hello@ can see (its own, where bookings live, plus the calendars shared to
// it). Change the rules in both places.
//
// The booking being moved sits on hello@'s calendar too: its own window is
// not counted against it, so a client can shift by half an hour.
//
// No Google keys, or Google down: every time inside the rules is open and the
// team confirms the time, exactly like the website form.
import { googleToken, calendarUser, hasGoogleKeys } from "./google-calendar";
import { wallClockToUtc } from "./booking-time";
import { BUSINESS_TZ, business } from "./business";

export const SCHEDULE = { daysAhead: 40, dayStart: business.schedule.dayStart, dayEnd: business.schedule.dayEnd, stepMinutes: business.schedule.stepMinutes, shootMinutes: 120, closedWeekdays: [...business.schedule.closedWeekdays] as number[], timeZone: BUSINESS_TZ };

export type Slot = { start: string; available: boolean };
export type Day = { date: string; closed: boolean; slots: Slot[] };
export type Availability = { source: "calendar" | "open"; minutes: number; days: Day[] };

type Busy = { start: number; end: number };

const toMin = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const localDate = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: SCHEDULE.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const instant = (date: string, minutes: number) => wallClockToUtc(date, hm(minutes))!.getTime();

// A shoot holds at least two hours, in half-hour steps.
export function shootMinutesFor(quoted: number): number {
  return Math.max(SCHEDULE.shootMinutes, Math.ceil((quoted || 0) / SCHEDULE.stepMinutes) * SCHEDULE.stepMinutes);
}

async function googleBusy(timeMin: number, timeMax: number): Promise<Busy[] | null> {
  if (!hasGoogleKeys()) return null;
  const auth = { authorization: `Bearer ${await googleToken("https://www.googleapis.com/auth/calendar.readonly")}` };
  const user = calendarUser();
  const lr = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=freeBusyReader&maxResults=250", { headers: auth, cache: "no-store" });
  const lj = (await lr.json().catch(() => ({}))) as { items?: { id: string }[] };
  if (!lr.ok) throw new Error(`google calendarList ${lr.status}`);
  const ids = (lj.items ?? []).map((c) => c.id);
  if (!ids.includes(user)) ids.unshift(user);
  const busy: Busy[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), timeZone: SCHEDULE.timeZone, items: ids.slice(i, i + 50).map((id) => ({ id })) }),
      cache: "no-store",
    });
    const j = (await r.json().catch(() => ({}))) as { calendars?: Record<string, { busy?: { start: string; end: string }[] }> };
    if (!r.ok) throw new Error(`google freeBusy ${r.status}`);
    for (const cal of Object.values(j.calendars ?? {})) for (const b of cal.busy ?? []) busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
  }
  return busy;
}

export async function availability(minutes: number, opts: { ignore?: { start: Date; end: Date } | null } = {}): Promise<Availability> {
  const today = localDate(new Date());
  const dates = Array.from({ length: SCHEDULE.daysAhead }, (_, i) => addDays(today, i + 1));
  const dayStart = toMin(SCHEDULE.dayStart);
  const dayEnd = toMin(SCHEDULE.dayEnd);
  let busy: Busy[] = [];
  let source: Availability["source"] = "open";
  try {
    const found = await googleBusy(instant(dates[0], 0), instant(addDays(dates[dates.length - 1], 1), 0));
    if (found) {
      busy = found;
      source = "calendar";
    }
  } catch (e) {
    console.error("[availability] calendar lookup failed, offering open times", e);
  }
  // The booking's own event: freeBusy merges overlapping events, so carve its
  // window out of whatever block holds it.
  const own = opts.ignore;
  if (own) {
    const a = own.start.getTime();
    const z = own.end.getTime();
    busy = busy.flatMap((b) => (b.start < z && b.end > a ? [...(b.start < a ? [{ start: b.start, end: a }] : []), ...(b.end > z ? [{ start: z, end: b.end }] : [])] : [b]));
  }
  const days = dates.map((date): Day => {
    const closed = SCHEDULE.closedWeekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay());
    const slots: Slot[] = [];
    if (!closed)
      // dayEnd is the latest START time (business.schedule.dayEnd), not the end of the day.
      for (let m = dayStart; m <= dayEnd; m += SCHEDULE.stepMinutes) {
        const start = instant(date, m);
        const end = instant(date, m + minutes);
        slots.push({ start: hm(m), available: !busy.some((b) => b.start < end && b.end > start) });
      }
    return { date, closed, slots };
  });
  return { source, minutes, days };
}

// Whether one start is offered and open right now (the POST re-checks).
export async function isOpen(date: string, time: string, minutes: number, ignore?: { start: Date; end: Date } | null): Promise<boolean> {
  const a = await availability(minutes, { ignore });
  return Boolean(a.days.find((d) => d.date === date && !d.closed)?.slots.find((s) => s.start === time && s.available));
}
