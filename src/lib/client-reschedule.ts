// The client moves their own shoot (Oct 2026). From the portal's Bookings tab
// the agent (or a teammate) taps Reschedule, picks an open time from the same
// calendar the website form reads (src/lib/availability.ts), and the booking
// moves:
//   - the date and time change, the booking goes back to Unconfirmed and is
//     flagged "moved by the client" until an admin confirms the new time
//     (Confirm time on the booking clears the flag);
//   - the hello@ calendar event moves (calendar.upsert; Google updates the
//     shooter if one is on it) and reads TENTATIVE again;
//   - the team hears: a line in #bookings (the hub log) and an email to
//     NOTIFY_EMAILS;
//   - the client hears (Oct 21 2026): "Your shoot has been rescheduled", the
//     requested time and that the business confirms it shortly (email.rescheduled job).
// Shot, delivered and canceled shoots cannot be moved here; the client texts.
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { availability, isOpen, shootMinutesFor, type Availability } from "./availability";
import { bookingExtra, quote } from "./studio-pricing";
import { fmtWhen, wallClockToUtc, toHm, toYmd } from "./booking-time";
import { emailFrom, notifyEmails, siteUrl } from "./brand";
import { drainJobs } from "./jobs";
import { currentEnv, enqueueJobs, jobKey } from "./jobs-core";
import { rescheduledSpec } from "./booking-time-email";
import { visibleClientIds } from "./portal-data";
import { isPartnerEmail } from "./partner";
import { business } from "./business";

export const MOVABLE = new Set(["requested", "confirmed"]);

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

async function load(bookingId: string) {
  return db().query.bookings.findFirst({
    where: eq(schema.bookings.id, bookingId),
    with: { listing: { columns: { id: true, address: true, slug: true, nda: true } } },
  });
}

// The booking, if this signed-in client (or a teammate) may move it.
async function forClient(email: string, bookingId: string): Promise<{ ok: true; b: Loaded } | { ok: false; status: number; error: string }> {
  if (isPartnerEmail(email)) return { ok: false, status: 404, error: "not found" };
  const b = await load(bookingId);
  const env = currentEnv();
  if (!b || (b.env && b.env !== env) || (!b.env && env !== "production")) return { ok: false, status: 404, error: "not found" };
  const ids = await visibleClientIds(email);
  if (!ids.includes(b.clientId)) return { ok: false, status: 404, error: "not found" };
  if (!MOVABLE.has(b.status)) return { ok: false, status: 409, error: `This shoot can no longer be moved here. ${business.phone ? `Text us at ${business.phone}` : `Email us at ${business.supportEmail}`} and we will help.` };
  return { ok: true, b };
}

const windowOf = (b: Loaded) => {
  const minutes = shootMinutesFor(quote(b.serviceIds ?? [], b.addonIds ?? [], bookingExtra(b)).minutes);
  const start = b.desiredDate && b.startTime ? wallClockToUtc(b.desiredDate, b.startTime) : b.startsAt ?? null;
  return { minutes, own: start ? { start, end: new Date(start.getTime() + minutes * 60_000) } : null };
};

export async function rescheduleOptions(email: string, bookingId: string): Promise<{ ok: true; availability: Availability; current: { date: string | null; time: string | null; when: string | null } } | { ok: false; status: number; error: string }> {
  const r = await forClient(email, bookingId);
  if (!r.ok) return r;
  const { minutes, own } = windowOf(r.b);
  return {
    ok: true,
    availability: await availability(minutes, { ignore: own }),
    current: { date: r.b.desiredDate, time: r.b.startTime, when: fmtWhen({ desiredDate: r.b.desiredDate, startTime: r.b.startTime }) },
  };
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function clientReschedule(p: { email: string; bookingId: string; date: unknown; time: unknown }): Promise<{ ok: true; when: string } | { ok: false; status: number; error: string }> {
  const email = p.email.trim().toLowerCase();
  const date = toYmd(p.date);
  const time = toHm(p.time);
  if (!date || !time) return { ok: false, status: 400, error: "Pick a day and a start time." };
  const r = await forClient(email, p.bookingId);
  if (!r.ok) return r;
  const b = r.b;
  if (b.desiredDate === date && b.startTime === time) return { ok: false, status: 400, error: "That is the time you already have." };
  const { minutes, own } = windowOf(b);
  if (!(await isOpen(date, time, minutes, own))) return { ok: false, status: 409, error: "That time was just taken. Pick another one." };

  const startsAt = wallClockToUtc(date, time)!;
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  const from = fmtWhen({ desiredDate: b.desiredDate, startTime: b.startTime });
  const when = fmtWhen({ desiredDate: date, startTime: time }) ?? `${date} ${time}`;
  const version = b.calendarVersion + 1;
  const now = new Date();
  const d = db();
  await d
    .update(schema.bookings)
    .set({ desiredDate: date, startTime: time, startsAt, endsAt, status: "requested", calendarVersion: version, clientRescheduledAt: now, clientRescheduledFrom: from, updatedAt: now })
    .where(eq(schema.bookings.id, b.id));
  await d.update(schema.listings).set({ shootDate: new Date(`${date}T00:00:00Z`) }).where(eq(schema.listings.id, b.listingId));
  await logActivity({ actorEmail: email, action: "booking.client_rescheduled", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, email, from, when, date, time, previousStatus: b.status, version } });
  // The calendar moves; the client gets "Your shoot has been rescheduled"
  // (requested, not confirmed, no .ics; src/lib/booking-time-email.ts). The
  // confirmation with the calendar file comes when an admin confirms.
  await enqueueJobs([
    { kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", b.id, version), bookingId: b.id, listingId: b.listingId, payload: { version } },
    rescheduledSpec({ bookingId: b.id, listingId: b.listingId, version }),
  ]);

  // The team's email. NDA listings are named by street only to the team (the
  // team knows the address); never the shooter, never an amount.
  const to = notifyEmails();
  const key = (process.env.RESEND_API_KEY || "").trim();
  const street = (b.listing?.address ?? "a listing").split(",")[0].trim();
  after(async () => {
    if (to.length && key) {
      try {
        const { Resend } = await import("resend");
        const admin = `${siteUrl()}/admin/bookings/${b.id}`;
        await new Resend(key).emails.send({
          from: emailFrom(),
          to,
          replyTo: email,
          subject: `Rescheduled by the client: ${street}, now ${when}`,
          html: `<p><strong>${esc(email)}</strong> moved the shoot at <strong>${esc(b.listing?.address ?? street)}</strong>.</p>
<p>Was: ${esc(from ?? "no time set")}<br/>Now: <strong>${esc(when)}</strong></p>
<p>The booking is back to Unconfirmed. Confirm the new time (or call the client) from the booking page.</p>
<p><a href="${admin}">Open the booking →</a></p>`,
          text: `${email} moved the shoot at ${b.listing?.address ?? street}.\nWas: ${from ?? "no time set"}\nNow: ${when}\n\nThe booking is back to Unconfirmed. Confirm the new time from the booking page:\n${admin}`,
        });
      } catch (e) {
        console.error("[reschedule] team email", e);
      }
    }
    await drainJobs({ bookingId: b.id, budgetMs: 30_000 }).catch((e) => console.error("[reschedule] drain", e));
  });
  return { ok: true, when };
}
