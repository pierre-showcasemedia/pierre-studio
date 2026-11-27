// POST /api/studio/email/test-booking { to, mode?, payment?, detail? }
// mode: new (default) | updated | link | link_again | added | added_again |
// visit | visit_again (a second shoot's own invoice, Oct 27 2026) |
// rescheduled | time_confirmed | new_time_confirmed | time_moved (the add-on
// invoice and the client's time emails, Oct 21 2026: the time emails carry no
// payment row; the reschedule carries no shoot.ics).
// payment: card (default) | pay_at_close | other | quote; detail (with other):
// check (default) | ach | cash.
// Operator-only look at the booking email in a real inbox: renders the same
// template the email.booking job sends, from a fixed SAMPLE booking (no
// database read or write, no client data), and sends it through Resend with
// the shoot.ics attached. Guarded like the payments test harness: the
// x-migrate-token header, never on production, and the recipient must be an
// the business admin address, so it can never reach a client. Subject starts "Test: ".
import { Resend } from "resend";
import { isAdminAllowed } from "@/lib/admin-allow";
import { TIME_EMAIL_MODES, bookingEmailHtml, bookingEmailSubject, bookingEmailText, preshootChecklistUrl, shootEvent, shootIcs, type BookingEmailInput, type BookingEmailMode, type BookingEmailPayment } from "@/lib/booking-email";
import { fmtWhen } from "@/lib/booking-time";
import { brand, emailFrom, siteUrl, supportEmail } from "@/lib/brand";
import { currentEnv } from "@/lib/jobs-core";
import { parsePaymentDetail } from "@/lib/pay-other";
import { hasMigrateToken } from "@/lib/operator-token";
import { BUSINESS_TZ } from "@/lib/business";
import { reminderDay } from "@/lib/reminder-day";

export const dynamic = "force-dynamic";

// A local calendar date n days from now ("2026-10-23").
function localYmd(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 864e5);
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export async function POST(request: Request) {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  if (currentEnv() === "production") return Response.json({ ok: false, error: "test emails never send from production" }, { status: 403 });
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return Response.json({ ok: false, error: "RESEND_API_KEY is not set here" }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as { to?: unknown; mode?: unknown; payment?: unknown; detail?: unknown };
  const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
  if (!to || !(await isAdminAllowed(to))) return Response.json({ ok: false, error: `the recipient must be an ${brand.shortName} admin address` }, { status: 403 });
  const MODES: BookingEmailMode[] = ["new", "updated", "link", "link_again", "added", "added_again", "visit", "visit_again", ...TIME_EMAIL_MODES];
  const mode: BookingEmailMode = MODES.includes(body.mode as BookingEmailMode) ? (body.mode as BookingEmailMode) : "new";
  const timeMode = TIME_EMAIL_MODES.includes(mode);
  const visitMode = mode === "visit" || mode === "visit_again";
  const addedMode = mode === "added" || mode === "added_again" || visitMode;

  const street = "1420 Example Alder Drive";
  const rest = "Springfield, CA 90000";
  const address = `${street}, ${rest}`;
  const desiredDate = localYmd(3);
  const startTime = "10:00";
  const services = ["Photography", "Cinematic listing film"];
  const addons = ["Twilight photography"];
  const payment: BookingEmailPayment =
    body.payment === "quote"
      ? { kind: "quote" }
      : body.payment === "pay_at_close"
        ? { kind: "pay_at_close", totalLabel: "$1,450", payUrl: `${siteUrl()}/portal/login` }
        : body.payment === "other"
          ? { kind: "other", totalLabel: "$1,450", detail: parsePaymentDetail(typeof body.detail === "string" ? body.detail : null) ?? "check" }
          : { kind: "card", totalLabel: "$1,450", payUrl: `${siteUrl()}/portal/login` };
  // The time confirmations carry the calendar file with a higher SEQUENCE (the
  // entry moves); the reschedule and the add-on invoice carry none.
  const event = mode === "rescheduled" || addedMode ? null : shootEvent({ bookingId: "00000000-0000-4000-8000-000000000000", desiredDate, startTime, street, address, services: [...services, ...addons], sequence: timeMode ? 2 : 0 });
  const input: BookingEmailInput = {
    clientFirstName: "Sam",
    street,
    rest,
    when: visitMode ? `${fmtWhen({ desiredDate, startTime: "17:00" }, { long: true })} to 7:00 PM` : fmtWhen({ desiredDate, startTime }, { long: true }),
    launch: null,
    services: addedMode ? [] : services,
    addons: addedMode ? [] : addons,
    ...(visitMode ? { added: ["Return trip, twilight photography", "Drone"], visitLabel: "Return trip" } : addedMode ? { added: ["Twilight photography"] } : {}),
    payment: timeMode ? null : addedMode ? { kind: "card", totalLabel: "$300", payUrl: `${siteUrl()}/portal/login` } : payment,
    portalUrl: `${siteUrl()}/portal/login`,
    updated: mode === "updated",
    mode,
    address,
    event,
    checklistUrl: preshootChecklistUrl(),
    reminderDay: mode === "reminder" ? reminderDay(desiredDate, new Date(), BUSINESS_TZ) : null,
  };
  const subject = `Test: ${bookingEmailSubject(street, input.updated, mode, input.visitLabel, input.reminderDay)}`;
  const resend = new Resend(key);
  const r = await resend.emails.send({
    from: emailFrom(),
    replyTo: supportEmail(),
    to,
    subject,
    html: bookingEmailHtml(input),
    text: bookingEmailText(input),
    attachments: event ? [{ filename: "shoot.ics", content: Buffer.from(shootIcs(event), "utf8").toString("base64") }] : undefined,
  });
  if (r.error) return Response.json({ ok: false, error: r.error.message }, { status: 502 });
  return Response.json({ ok: true, to, subject, id: r.data?.id ?? null, sample: { address, when: input.when, mode, payment: input.payment?.kind ?? null } });
}
