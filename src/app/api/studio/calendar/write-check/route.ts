// POST /api/studio/calendar/write-check  (x-migrate-token)
// Operator check that the booking calendar can be written: as hello@ (scope
// calendar.events) it creates one private test event 30 days out at 11 PM
// local (outside booking hours, no guests, so nobody is emailed and no open
// time is touched), reads it back, and deletes it. Returns each step's status.
import { calendarUser, googleToken, hasCalendarSync, hasGoogleKeys } from "@/lib/google-calendar";
import { wallClockToUtc } from "@/lib/booking-time";
import { hasMigrateToken } from "@/lib/operator-token";
import { brand } from "@/lib/brand";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  if (!hasGoogleKeys()) return Response.json({ ok: false, step: "env", error: "GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY not set here" });
  let access: string;
  try {
    access = await googleToken("https://www.googleapis.com/auth/calendar.events");
  } catch (e) {
    return Response.json({ ok: false, step: "token", user: calendarUser(), error: e instanceof Error ? e.message : String(e), hint: "Domain-wide delegation needs https://www.googleapis.com/auth/calendar.events for this service account." });
  }
  const auth = { authorization: `Bearer ${access}`, "content-type": "application/json" };
  const day = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const start = wallClockToUtc(day, "23:00")!;
  const end = new Date(start.getTime() + 15 * 60_000);
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent((process.env.GOOGLE_BOOKINGS_CALENDAR || "primary").trim())}/events`;
  const made = await fetch(`${base}?sendUpdates=none`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ summary: `${brand.name} calendar check (deleted right away)`, visibility: "private", transparency: "transparent", start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }),
    cache: "no-store",
  });
  const mj = (await made.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!made.ok || !mj.id) return Response.json({ ok: false, step: "create", status: made.status, error: mj.error?.message ?? null });
  const got = await fetch(`${base}/${mj.id}`, { headers: auth, cache: "no-store" });
  const del = await fetch(`${base}/${mj.id}?sendUpdates=none`, { method: "DELETE", headers: auth, cache: "no-store" });
  return Response.json({ ok: got.ok && del.ok, user: calendarUser(), created: made.status, read: got.status, deleted: del.status, syncOnHere: hasCalendarSync() });
}
