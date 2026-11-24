// The client's time emails (Oct 21 2026). Two he asked for:
//   1. The client moved the shoot from the portal (src/lib/client-reschedule.ts):
//      "Your shoot has been rescheduled: <street>", the new requested day and
//      time, the address, and that nothing is confirmed until they hear from
//      us. No .ics: nothing is on anyone's calendar yet.
//   2. An admin confirms a time the client had moved (Confirm time, or the
//      status set to Confirmed while client_rescheduled_at is set): "Your new
//      time is confirmed: <street>", the same block as the booking
//      confirmation (when, where, services, add-ons, what happens next) and
//      shoot.ics with a higher SEQUENCE, so the entry in their calendar moves.
//      Sent at confirmation only, never at the reschedule itself.
// And two more so the client always hears when a time is set (the
// coordinator's call, Oct 21 2026; the owner can veto): an admin's own first
// Confirm time, "Your shoot time is confirmed: <street>", and an admin moving
// an already confirmed time, "Your shoot has moved: <street>". Same template.
//
// Both run as jobs (email.time_confirmed with a variant, email.rescheduled),
// keyed on the booking and its calendar version, so a Resend hiccup retries
// with backoff and a double click sends one email. A job a newer one
// superseded, a canceled booking, or a time that is no longer confirmed sends
// nothing (SkipJobError). Demo mode never reaches here: the drainer returns
// before any handler without a database.
import { Resend } from "resend";
import { and, eq, gt, lte, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { bookingEmailHtml, bookingEmailSubject, bookingEmailText, preshootChecklistUrl, shootEvent, shootIcs, type BookingEmailInput, type BookingEmailMode } from "./booking-email";
import { itemById } from "./studio-pricing";
import { isTimeConfirmed } from "./booking-status";
import { BUSINESS_TZ, fmtDay, fmtWhen } from "./booking-time";
import { reminderDay } from "./reminder-day";
import { business, mayAutoMessage } from "./business";
import { emailFrom, siteUrl, supportEmail } from "./brand";
import { currentEnv, enqueueJobs, jobKey, NotConfiguredError, SkipJobError, type JobSpec } from "./jobs-core";

export type TimeEmailVariant = "confirmed" | "reconfirmed" | "moved";

const MODE_OF: Record<TimeEmailVariant, BookingEmailMode> = { confirmed: "time_confirmed", reconfirmed: "new_time_confirmed", moved: "time_moved" };

// Which confirmation an admin's Confirm time (or the status Confirmed) sends:
// the client had moved it from the portal → "Your new time is confirmed";
// the time was already confirmed and moved → "Your shoot has moved"; else
// the first confirmation, "Your shoot time is confirmed".
export function timeEmailVariant(p: { clientRescheduled: boolean; wasConfirmed: boolean }): TimeEmailVariant {
  if (p.clientRescheduled) return "reconfirmed";
  if (p.wasConfirmed) return "moved";
  return "confirmed";
}

export function timeConfirmedSpec(p: { bookingId: string; listingId: string; version: number; variant: TimeEmailVariant }): JobSpec {
  return { kind: "email.time_confirmed", idempotencyKey: jobKey("email.time_confirmed", p.bookingId, p.version), bookingId: p.bookingId, listingId: p.listingId, payload: { version: p.version, variant: p.variant } };
}

export function rescheduledSpec(p: { bookingId: string; listingId: string; version: number }): JobSpec {
  return { kind: "email.rescheduled", idempotencyKey: jobKey("email.rescheduled", p.bookingId, p.version), bookingId: p.bookingId, listingId: p.listingId, payload: { version: p.version } };
}

type BookingForEmail = typeof schema.bookings.$inferSelect & {
  listing: { address: string; slug: string } | null;
  client: { name: string | null; email: string } | null;
};

export type BuiltTimeEmail = { to: string; subject: string; html: string; text: string; ics: string | null; sequence: number; mode: BookingEmailMode };

// Everything the email says, from the booking row. Pure apart from the
// checklist env var, so the test route and the check script can render it.
// Nov 24 2026: the reminder names the shoot's day (today, tomorrow, the
// weekday) from `now`, the moment it is built and sent, in the business's
// time zone.
export function buildTimeEmail(b: BookingForEmail, mode: BookingEmailMode, opts: { now?: Date } = {}): BuiltTimeEmail {
  const address = b.listing?.address ?? String(b.property?.street ?? "");
  const street = address.split(",")[0].trim() || "your property";
  const rest = address.split(",").slice(1).join(",").trim();
  const names = (ids: string[] | null) => (ids ?? []).map((id) => itemById(id)?.name ?? id);
  const services = names(b.serviceIds);
  const addons = names(b.addonIds);
  const sequence = Math.max(0, (b.calendarVersion ?? 1) - 1);
  // The reschedule carries no calendar entry (nothing is confirmed); the
  // confirmations carry shoot.ics under the booking's UID with this SEQUENCE.
  const event = mode === "rescheduled" ? null : shootEvent({ bookingId: b.id, desiredDate: b.desiredDate, startTime: b.startTime, street, address: address.trim(), services: [...services, ...addons], sequence });
  const input: BookingEmailInput = {
    clientFirstName: b.client?.name?.split(" ")[0] ?? null,
    street,
    rest,
    when: fmtWhen({ desiredDate: b.desiredDate, startTime: b.startTime }, { long: true }),
    launch: mode === "rescheduled" ? null : b.launchDate ? fmtDay(b.launchDate, { long: true }) : null,
    services,
    addons,
    payment: null,
    portalUrl: `${siteUrl()}/portal/login`,
    updated: false,
    mode,
    address: address.trim() || null,
    event,
    checklistUrl: preshootChecklistUrl(),
    reminderDay: mode === "reminder" ? reminderDay(b.desiredDate, opts.now ?? new Date(), BUSINESS_TZ) : null,
  };
  return { to: b.client?.email ?? "", subject: bookingEmailSubject(street, false, mode, null, input.reminderDay), html: bookingEmailHtml(input), text: bookingEmailText(input), ics: event ? shootIcs(event) : null, sequence, mode };
}

type TimeJob = { id: string; kind: string; bookingId: string | null; idempotencyKey: string; createdAt: Date; payload: { version?: number; variant?: string } | null };

async function loadBooking(bookingId: string): Promise<BookingForEmail> {
  const b = (await db().query.bookings.findFirst({
    where: eq(schema.bookings.id, bookingId),
    with: { listing: { columns: { address: true, slug: true } }, client: { columns: { name: true, email: true } } },
  })) as BookingForEmail | undefined;
  if (!b) throw new SkipJobError("the booking is gone");
  return b;
}

// A newer job of the same kind for the booking carries every later change.
async function supersededBy(job: TimeJob): Promise<boolean> {
  const newer = await db().query.jobs.findFirst({
    where: and(eq(schema.jobs.env, currentEnv()), eq(schema.jobs.kind, job.kind as "email.time_confirmed"), eq(schema.jobs.bookingId, job.bookingId!), ne(schema.jobs.id, job.id), ne(schema.jobs.status, "dead"), gt(schema.jobs.createdAt, job.createdAt)),
    columns: { id: true },
  });
  return Boolean(newer);
}

async function send(built: BuiltTimeEmail, idempotencyKey: string): Promise<string | null> {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) throw new NotConfiguredError("email sending (RESEND_API_KEY)");
  const r = await new Resend(key).emails.send(
    {
      from: emailFrom(),
      replyTo: supportEmail(),
      to: built.to,
      subject: built.subject,
      html: built.html,
      text: built.text,
      attachments: built.ics ? [{ filename: "shoot.ics", content: Buffer.from(built.ics, "utf8").toString("base64") }] : undefined,
    },
    { idempotencyKey }
  );
  // The same key with a different body means an earlier attempt already went
  // out (Resend keeps keys for 24 hours): done, never sent twice.
  if (r.error?.name === "invalid_idempotent_request") return null;
  if (r.error) throw new Error(`Resend rejected the email: ${r.error.message}`);
  return r.data?.id ?? null;
}

// The email.time_confirmed handler.
export async function sendTimeConfirmedEmail(job: TimeJob): Promise<{ to: string; id: string | null }> {
  if (!(process.env.RESEND_API_KEY || "").trim()) throw new NotConfiguredError("email sending (RESEND_API_KEY)");
  if (!job.bookingId) throw new SkipJobError("the job names no booking");
  if (await supersededBy(job)) throw new SkipJobError("a newer time email for this booking covers it");
  const b = await loadBooking(job.bookingId);
  if (b.status === "canceled") throw new SkipJobError("the booking is canceled");
  if (!b.client?.email) throw new SkipJobError("the booking has no client email");
  if (!isTimeConfirmed(b.status)) throw new SkipJobError("the time is no longer confirmed");
  if (!b.desiredDate || !b.startTime) throw new SkipJobError("the booking has no confirmed date and time");
  const variant: TimeEmailVariant = job.payload?.variant === "reconfirmed" || job.payload?.variant === "moved" ? job.payload.variant : "confirmed";
  const built = buildTimeEmail(b, MODE_OF[variant]);
  const id = await send(built, job.idempotencyKey);
  await logActivity({ action: "email.time_confirmed_sent", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, to: built.to, variant, version: job.payload?.version ?? null, sequence: built.sequence, resendId: id } });
  return { to: built.to, id };
}

// The email.rescheduled handler: the client's own move, requested, not confirmed.
export async function sendRescheduledEmail(job: TimeJob): Promise<{ to: string; id: string | null }> {
  if (!(process.env.RESEND_API_KEY || "").trim()) throw new NotConfiguredError("email sending (RESEND_API_KEY)");
  if (!job.bookingId) throw new SkipJobError("the job names no booking");
  if (await supersededBy(job)) throw new SkipJobError("a newer reschedule email for this booking covers it");
  const b = await loadBooking(job.bookingId);
  if (b.status === "canceled") throw new SkipJobError("the booking is canceled");
  if (!b.client?.email) throw new SkipJobError("the booking has no client email");
  // An admin already confirmed the new time: the confirmation email covers it.
  if (!b.clientRescheduledAt) throw new SkipJobError("the new time was confirmed already; the confirmation email covers it");
  if (!b.desiredDate) throw new SkipJobError("the booking has no date");
  const built = buildTimeEmail(b, "rescheduled");
  const id = await send(built, job.idempotencyKey);
  await logActivity({ action: "email.rescheduled_sent", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, to: built.to, version: job.payload?.version ?? null, resendId: id } });
  return { to: built.to, id };
}

// ---- The reminder before the shoot (studio template, Nov 18 2026) ----------
// Off unless business.reminderEmail. The minute cron calls scheduleReminders(),
// which queues one email.reminder per Confirmed booking starting within the
// lead time (business.reminderLeadHours, default 24), keyed to that start, so a
// moved shoot gets a fresh reminder and the old job sees the start moved and
// skips. A booking made less than 3 hours ahead gets no reminder. The email
// names the shoot's real day from when it is sent (src/lib/reminder-day.ts).
const MIN_LEAD_MS = 3 * 60 * 60_000;
const reminderKey = (bookingId: string, startsAt: Date) => `email.reminder:${bookingId}:${startsAt.getTime()}`;

export async function scheduleReminders(now: Date = new Date()): Promise<number> {
  if (!business.reminderEmail) return 0;
  const lead = Math.max(1, business.reminderLeadHours) * 60 * 60_000;
  const rows = await db()
    .select({ id: schema.bookings.id, listingId: schema.bookings.listingId, startsAt: schema.bookings.startsAt })
    .from(schema.bookings)
    .where(and(
      eq(schema.bookings.env, currentEnv()),
      eq(schema.bookings.status, "confirmed"),
      gt(schema.bookings.startsAt, new Date(now.getTime() + MIN_LEAD_MS)),
      lte(schema.bookings.startsAt, new Date(now.getTime() + lead)),
    ));
  return enqueueJobs(rows.filter((r) => r.startsAt).map((r) => ({
    kind: "email.reminder" as const,
    idempotencyKey: reminderKey(r.id, r.startsAt!),
    bookingId: r.id,
    listingId: r.listingId,
    payload: { note: r.startsAt!.toISOString() },
  })));
}

// The email.reminder handler: re-reads the booking and skips anything that changed.
export async function sendReminderEmail(job: { bookingId: string | null; idempotencyKey: string; payload: { note?: string } | null }): Promise<{ to: string; id: string | null }> {
  if (!business.reminderEmail) throw new SkipJobError("reminder emails are switched off (business.reminderEmail)");
  if (!(process.env.RESEND_API_KEY || "").trim()) throw new NotConfiguredError("email sending (RESEND_API_KEY)");
  if (!job.bookingId) throw new SkipJobError("the job names no booking");
  const b = await loadBooking(job.bookingId);
  if (b.status !== "confirmed") throw new SkipJobError(`the booking is ${b.status}`);
  if (!b.startsAt || (job.payload?.note && b.startsAt.toISOString() !== job.payload.note)) throw new SkipJobError("the shoot moved; a newer reminder covers it");
  if (b.startsAt.getTime() <= Date.now()) throw new SkipJobError("the shoot has started");
  if (!b.client?.email) throw new SkipJobError("the booking has no client email");
  if (!mayAutoMessage(b.client.email)) throw new SkipJobError("the client is on the never-message list");
  if (!b.desiredDate || !b.startTime) throw new SkipJobError("the booking has no confirmed date and time");
  const built = buildTimeEmail(b, "reminder");
  const id = await send(built, job.idempotencyKey);
  await logActivity({ action: "email.reminder_sent", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, to: built.to, resendId: id } });
  return { to: built.to, id };
}
