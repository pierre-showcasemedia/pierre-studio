// The shooter's calendar invite (Oct 2026). When an admin assigns a shooter,
// confirms or moves the time, restores or cancels a booking, the shooter gets
// a short internal email with an iCalendar file attached (RFC 5545, iTIP
// METHOD:REQUEST or CANCEL), so Gmail, Google Calendar and Apple Mail show
// Accept / Decline and put the shoot on their calendar. One stable UID per
// booking (booking-<id>@the marketing site) and SEQUENCE = calendar_version,
// so every later invite updates the same event instead of adding a second one.
//
// It runs as the email.shooter_invite job (src/lib/jobs.ts), so a Resend
// hiccup retries with backoff. The handler re-reads the booking every time:
// the invite always carries the latest time, services and notes, and a job
// that a newer one superseded (or a shooter who was replaced) sends nothing.
//
// Shooter-visible text: never an amount (scrubMoney on client-typed text,
// moneyFree on the whole), services and add-ons by name only.
//
// One invite path (Oct 2026): where the booking calendar sync is on
// (src/lib/google-calendar.ts, production), the shooter is a guest on the
// hello@ event and Google sends the invite, so this email is skipped. It
// still runs where the sync is off (previews).
import { Resend } from "resend";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { JobPayload } from "@/db/schema";
import { logActivity } from "./activity";
import { bookingExtra, itemById, quote } from "./studio-pricing";
import { BUSINESS_TZ, fmtDay, fmtTime12, wallClockToUtc } from "./booking-time";
import { bookingStatusLabel, isTimeConfirmed } from "./booking-status";
import { brand, emailFrom, siteUrl, supportEmail, mailDomain } from "./brand";
import { currentEnv, jobKey, NotConfiguredError, SkipJobError, type JobSpec } from "./jobs-core";
import { directionsLine, shootAddress } from "./shoot-address";
import { moneyFree, scrubMoney } from "./slack";
import { TZ_SHORT } from "./business";

export type InviteMethod = "REQUEST" | "CANCEL";

// ---- iCalendar (RFC 5545) ---------------------------------------------------

export type IcsEvent = {
  method: InviteMethod;
  uid: string;
  sequence: number;
  stamp: Date;
  when: { allDay: false; start: Date; end: Date } | { allDay: true; date: string };
  summary: string;
  location: string | null;
  description: string;
  url?: string | null;
  organizer: { email: string; name: string };
  attendee: { email: string; name?: string | null };
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
};

// TEXT values (3.3.11): backslash first, then ; , and line breaks as \n.
export function icsText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// A parameter value (CN): always quoted; a quoted-string cannot hold DQUOTE
// or control characters, so those go.
function icsParam(s: string): string {
  return `"${s.replace(/["\u0000-\u001f\u007f]/g, "").trim()}"`;
}

const utf8 = new TextEncoder();

// Content lines longer than 75 octets fold onto continuation lines that start
// with one space (3.1). Counted in UTF-8 octets, never splitting a character.
export function foldLine(line: string): string {
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = utf8.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(cur);
      cur = "";
      bytes = 0;
      limit = 74; // the leading space of a continuation line is one of its 75
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const icsUtc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsDate = (ymd: string) => ymd.replace(/-/g, "");
const nextDay = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export function buildIcs(e: IcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    `PRODID:-//${brand.name}//Studio//EN`,
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${e.method}`,
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `SEQUENCE:${Math.max(0, Math.floor(e.sequence))}`,
    `DTSTAMP:${icsUtc(e.stamp)}`,
    ...(e.when.allDay
      ? [`DTSTART;VALUE=DATE:${icsDate(e.when.date)}`, `DTEND;VALUE=DATE:${icsDate(nextDay(e.when.date))}`]
      : [`DTSTART:${icsUtc(e.when.start)}`, `DTEND:${icsUtc(e.when.end)}`]),
    `SUMMARY:${icsText(e.summary)}`,
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    `DESCRIPTION:${icsText(e.description)}`,
    ...(e.url ? [`URL:${e.url}`] : []),
    `ORGANIZER;CN=${icsParam(e.organizer.name)}:mailto:${e.organizer.email}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=${e.method === "REQUEST" ? "TRUE" : "FALSE"}${e.attendee.name ? `;CN=${icsParam(e.attendee.name)}` : ""}:mailto:${e.attendee.email}`,
    `STATUS:${e.status}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ---- The booking as the shooter needs it -----------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const inviteUid = (bookingId: string) => `booking-${bookingId}@${mailDomain()}`;

// The idempotency key: booking, calendar version, address and method, so a
// double click is one email and a new version is a new one.
export function shooterInviteKey(bookingId: string, version: number, email: string, method: InviteMethod): string {
  return `${jobKey("email.shooter_invite", bookingId, version)}:${email.trim().toLowerCase()}:${method.toLowerCase()}`;
}

export function shooterInviteSpec(p: { bookingId: string; listingId: string; version: number; email: string; method: InviteMethod }): JobSpec {
  const email = p.email.trim().toLowerCase();
  const payload: JobPayload = { bookingId: p.bookingId, version: p.version, email, method: p.method };
  return { kind: "email.shooter_invite", idempotencyKey: shooterInviteKey(p.bookingId, p.version, email, p.method), bookingId: p.bookingId, listingId: p.listingId, payload };
}

type BookingForInvite = typeof schema.bookings.$inferSelect & {
  // city / state / zip: optional, so a caller that loads only the address still type-checks (shootAddress fills them in when present).
  listing: { address: string; nda: boolean; city?: string | null; state?: string | null; zip?: string | null } | null;
  client: { name: string | null; email: string; phone: string | null; company: string | null } | null;
};

export type InviteWhen = { allDay: false; start: Date; end: Date } | { allDay: true; date: string };

// When the event is: the local wall clock the booking holds (confirmTime
// keeps desired_date / start_time in step with starts_at), else starts_at,
// else an all-day event on the date; null when there is no date at all.
// Duration from the price table, like Confirm time.
export function inviteWhen(b: Pick<BookingForInvite, "desiredDate" | "startTime" | "startsAt" | "endsAt" | "serviceIds" | "addonIds" | "sqft" | "items" | "clientType" | "market">): InviteWhen | null {
  const minutes = quote(b.serviceIds ?? [], b.addonIds ?? [], bookingExtra(b)).minutes;
  const start = b.desiredDate && b.startTime ? wallClockToUtc(b.desiredDate, b.startTime) : b.startsAt ?? null;
  if (start) {
    const end = b.startsAt && b.endsAt && b.startsAt.getTime() === start.getTime() && b.endsAt > start ? b.endsAt : new Date(start.getTime() + minutes * 60_000);
    return { allDay: false, start, end };
  }
  if (b.desiredDate) return { allDay: true, date: b.desiredDate };
  return null;
}

const tzParts = (d: Date) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23" });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) if (part.type !== "literal") p[part.type] = part.value;
  return { day: `${p.weekday}, ${p.month} ${p.day}`, hm: `${p.hour.padStart(2, "0")}:${p.minute}` };
};

// "Tue, Oct 20 at 3:30 PM" (subject) and "Tue, Oct 20, 3:30 PM to 5:30 PM local" (body).
export function inviteWhenLabels(w: InviteWhen): { short: string; long: string } {
  if (w.allDay) return { short: fmtDay(w.date), long: `${fmtDay(w.date, { long: true })}, time to be set` };
  const a = tzParts(w.start);
  const b = tzParts(w.end);
  return { short: `${a.day} at ${fmtTime12(a.hm)}`, long: `${a.day}, ${fmtTime12(a.hm)} to ${fmtTime12(b.hm)} ${TZ_SHORT}` };
}

// The organizer is the watched inbox (hello@), not the sending address: a
// shooter's Accept or Decline is mailed to the organizer, and portal@ only
// sends. Falls back to the From address if no support inbox is set.
function organizer(): { email: string; name: string } {
  const support = supportEmail();
  const from = emailFrom();
  const m = /<([^>]+)>/.exec(support || from);
  return { email: (m ? m[1] : support || from).trim(), name: `${brand.name}` };
}

export type BuiltInvite = { to: string; subject: string; text: string; html: string; ics: string; sequence: number; street: string };

// Everything the email and the .ics say, from the booking row. Pure apart from
// the clock (stamp), so it can be checked without a database.
// The last line of the calendar text: the link to the booking page. Studio's
// own lines end there (google-calendar.ts keeps the team's notes apart by it).
export const BOOKING_LINK = "Booking: ";

// The calendar text's sections (the directions, each of Studio's lines, the
// team's notes, the link) one blank line apart, so each reads on its own on a
// phone (Nov 4 2026: "an extra line space above" Services, Access,
// Requests, Contact and the notes). A part left empty adds no gap.
export const sections = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join("\n\n");

// What any calendar entry for the shoot says about it: the street, the full
// address (src/lib/shoot-address.ts) and its Google Maps directions line, the details a shooter needs (never an amount), the title in
// the owner's format ("<street> - <agent> / <service> + <service>", " - TENTATIVE"
// until the time is confirmed) and the description. Used by this invite and
// by the hello@ calendar event (src/lib/google-calendar.ts).
export function shootDetails(b: BookingForInvite) {
  const address = shootAddress(b.listing, rec(b.property));
  // "Directions: https://www.google.com/maps/dir/?api=1&destination=...": the first line of every shoot event.
  const directions = directionsLine(address);
  const street = address.split(",")[0].trim() || "the property";
  const nda = Boolean(b.listing?.nda);
  const payload = rec(b.raw?.payload);
  const formClient = rec(payload.client);
  const prop = rec(b.property);
  const clientName = scrubMoney(b.client?.name ?? str(formClient.name) ?? b.client?.email ?? "the client");
  const company = str(formClient.company) ?? str(payload.company) ?? str(payload.brokerage) ?? b.client?.company ?? null;
  const phone = str(formClient.phone) ?? str(payload.phone) ?? b.client?.phone ?? null;
  const clientEmail = b.client?.email ?? str(formClient.email) ?? null;
  const names = (ids: string[] | null) => (ids ?? []).map((id) => itemById(id)?.name ?? id);
  const services = names(b.serviceIds);
  if (!services.length && b.servicesLabel) services.push(...b.servicesLabel.split(/\s*\+\s*/).filter(Boolean));
  const addons = names(b.addonIds);
  const canceledBooking = b.status === "canceled";
  const tentative = !isTimeConfirmed(b.status);
  const adminUrl = `${siteUrl()}/admin/bookings/${b.id}`;

  const views = Array.isArray(prop.views) ? prop.views.map(String).filter(Boolean).join(", ") : str(prop.views);
  const propertyLine = [str(prop.status), str(prop.listingType), b.sqft ? `${b.sqft.toLocaleString("en-US")} sq ft` : null, /^yes$/i.test(str(prop.offMarket) ?? "") ? "off market" : null, views ? `views: ${views}` : null]
    .filter(Boolean)
    .join(" · ");
  const details: [string, string | null][] = [
    ["Client", [clientName, company ? scrubMoney(company) : null].filter(Boolean).join(" · ")],
    ["Phone", phone ? scrubMoney(phone) : null],
    ["Email", clientEmail],
    ["Services", services.join(", ") || "To confirm"],
    ["Add-ons", addons.length ? addons.join(", ") : null],
    ["Access", b.accessNotes ? scrubMoney(b.accessNotes) : null],
    ["Homeowner home", /^yes$/i.test(str(prop.homeownerHome) ?? "") ? "Yes, the homeowner will be there" : null],
    ["Property", propertyLine ? scrubMoney(propertyLine) : null],
    ["Video style", str(prop.videoStyle) ? scrubMoney(String(prop.videoStyle)) : null],
    ["Music", str(prop.musicLink) ? scrubMoney(String(prop.musicLink)) : null],
    ["Launch", b.launchDate ? fmtDay(b.launchDate, { long: true }) : null],
    ["Custom request", b.customRequest ? scrubMoney(b.customRequest) : null],
    ["Client notes", b.clientNotes ? scrubMoney(b.clientNotes) : null],
  ];
  const shown = details.filter((d): d is [string, string] => Boolean(d[1]));

  const ndaLine = nda ? "NDA property: never post, share or demo anything from this shoot." : null;
  const agent = (b.client?.name ?? str(formClient.name) ?? b.client?.email ?? "client").trim();
  const title = (tentativeTag: boolean) => moneyFree(`${street} - ${scrubMoney(agent)} / ${services.join(" + ") || "services to confirm"}${tentativeTag ? " - TENTATIVE" : ""}`);
  // The calendar text (Oct 31 2026: "10 times less complicated",
  // "should NOT say EVERYTHING about the client"): only what this shoot needs,
  // one or two lines each. The services, the square footage, the access, what the client asked
  // for on this shoot and who to call; the rest of the form and the client's
  // history stay on the booking page, linked on the last line. The weather
  // line goes on top (google-calendar.ts) and any notes the team keeps on the
  // event sit between these lines and the link. One blank line between each.
  const flat = (t: string | null | undefined) => scrubMoney((t ?? "").replace(/\s+/g, " ").trim());
  const stop = (t: string) => (!t || /[.!?…]$/.test(t) ? t : `${t}.`);
  const clip = (t: string, n: number) => {
    if (t.length <= n) return t;
    const cut = t.lastIndexOf(" ", n - 1);
    return `${t.slice(0, cut > n * 0.6 ? cut : n - 1).replace(/[\s,;:.]+$/, "")}…`;
  };
  const access = [stop(flat(b.accessNotes)), /^yes$/i.test(str(prop.homeownerHome) ?? "") ? "Homeowner will be there." : ""].filter(Boolean).join(" ");
  const requests = clip([stop(flat(b.customRequest)), stop(flat(b.clientNotes)), str(prop.videoStyle) ? `Video style: ${flat(String(prop.videoStyle))}.` : ""].filter(Boolean).join(" "), 220);
  const describe = (tentativeTag: boolean) =>
    moneyFree(
      sections(
        tentativeTag && "Time not confirmed yet.",
        `Services: ${[...services, ...addons].join(", ") || "to confirm"}`,
        // The size the booking form sent (bookings.sqft; Nov 4 2026).
        b.sqft ? `Square footage: ${b.sqft.toLocaleString("en-US")} sq ft` : null,
        access && `Access: ${access}`,
        requests && `Requests: ${requests}`,
        `Contact: ${clientName}${phone ? `, ${scrubMoney(phone)}` : ""}`,
        ndaLine,
        `${BOOKING_LINK}${adminUrl}`
      )
    );
  return { address, directions, street, nda, ndaLine, shown, canceledBooking, tentative, adminUrl, title, describe };
}

export function buildShooterInvite(b: BookingForInvite, opts: { method: InviteMethod; to: string; shooterName?: string | null; when: InviteWhen; stamp?: Date }): BuiltInvite {
  const { address, directions, street, ndaLine, shown, canceledBooking, tentative, adminUrl, title, describe } = shootDetails(b);
  const labels = inviteWhenLabels(opts.when);
  const intro =
    opts.method === "CANCEL"
      ? canceledBooking
        ? "This shoot is canceled. It comes off your calendar."
        : "You are no longer on this shoot. It comes off your calendar."
      : tentative
        ? "You are on this shoot. The time is not confirmed yet, so it sits on your calendar as tentative and this invite updates once it is."
        : "You are on this shoot. Accept the invite to keep it on your calendar.";
  const statusLine = `${bookingStatusLabel(b.status)}${tentative ? ", time to confirm" : ""}`;

  const summary = title(tentative && opts.method === "REQUEST");
  const description = sections(directions, describe(tentative && opts.method === "REQUEST"));

  const ics = buildIcs({
    method: opts.method,
    uid: inviteUid(b.id),
    sequence: b.calendarVersion,
    stamp: opts.stamp ?? new Date(),
    when: opts.when,
    summary,
    location: address || null,
    description,
    url: adminUrl,
    organizer: organizer(),
    attendee: { email: opts.to, name: opts.shooterName ?? null },
    status: opts.method === "CANCEL" ? "CANCELLED" : tentative ? "TENTATIVE" : "CONFIRMED",
  });

  const subject = moneyFree(
    opts.method === "CANCEL" ? `${canceledBooking ? "Shoot canceled" : "Shoot reassigned"}: ${street}, ${labels.short}` : `Shoot: ${street}, ${labels.short}`
  );
  const head: [string, string][] = [
    ["When", labels.long],
    ["Where", address || street],
  ];
  const all: [string, string][] = opts.method === "CANCEL" ? head : [...head, ["Status", statusLine], ...shown];
  const text = moneyFree(
    [intro, "", ...all.map(([k, v]) => `${k}: ${v}`), ...(ndaLine ? ["", ndaLine] : []), "", `Open the booking: ${adminUrl}`, "", `${brand.name}`].join("\n")
  );
  const row = ([k, v]: [string, string]) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#5F646E;vertical-align:top;white-space:nowrap;">${esc(k)}</td><td style="padding:6px 0;color:#0B0C0F;white-space:pre-wrap;">${esc(v)}</td></tr>`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px 16px;background:#FFFFFF;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#0B0C0F;">
<div style="max-width:560px;">
<p style="margin:0 0 16px;">${esc(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;line-height:1.5;">${all.map(row).join("")}</table>
${ndaLine ? `<p style="margin:16px 0 0;font-weight:600;">${esc(ndaLine)}</p>` : ""}
<p style="margin:22px 0;"><a href="${esc(adminUrl)}" style="display:inline-block;background:#0B0C0F;color:#FFFFFF;text-decoration:none;border-radius:999px;padding:11px 22px;font-size:13.5px;">Open the booking</a></p>
<p style="margin:0;color:#5F646E;">${esc(brand.name)}</p>
</div>
</body></html>`;
  return { to: opts.to, subject, text, html, ics, sequence: b.calendarVersion, street };
}

// ---- The job ------------------------------------------------------------------

type InviteJob = { id: string; bookingId: string | null; idempotencyKey: string; createdAt: Date; payload: JobPayload | null };

// The email.shooter_invite handler. Sends nothing (SkipJobError, the job is
// done with the reason) when a newer invite for the same address supersedes
// it, when the shooter on the booking is someone else now (a REQUEST), when
// the shooter is back on a live booking or never got a REQUEST (a CANCEL), or
// when there is no date to put on a calendar yet.
export async function sendShooterInvite(job: InviteJob): Promise<{ to: string; id: string | null }> {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) throw new NotConfiguredError("email sending (RESEND_API_KEY)");
  const p = job.payload ?? {};
  const to = String(p.email ?? "").trim().toLowerCase();
  const method: InviteMethod = p.method === "CANCEL" ? "CANCEL" : "REQUEST";
  const bookingId = job.bookingId ?? p.bookingId ?? null;
  if (!bookingId) throw new SkipJobError("the job names no booking");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new SkipJobError("the job names no shooter email");

  const d = db();
  const b = (await d.query.bookings.findFirst({
    where: eq(schema.bookings.id, bookingId),
    with: { listing: { columns: { address: true, nda: true, city: true, state: true, zip: true } }, client: { columns: { name: true, email: true, phone: true, company: true } } },
  })) as BookingForInvite | undefined;
  if (!b) throw new SkipJobError("the booking is gone");

  const sameInvites = and(
    eq(schema.jobs.env, currentEnv()),
    eq(schema.jobs.kind, "email.shooter_invite"),
    eq(schema.jobs.bookingId, b.id),
    ne(schema.jobs.id, job.id),
    sql`${schema.jobs.payload}->>'email' = ${to}`
  );
  const newer = await d.query.jobs.findFirst({ where: and(sameInvites, gt(schema.jobs.createdAt, job.createdAt), ne(schema.jobs.status, "dead")), columns: { id: true } });
  if (newer) throw new SkipJobError("a newer invite for this shooter covers it");

  const shooter = (b.photographerEmail ?? "").trim().toLowerCase();
  if (method === "REQUEST") {
    if (b.status === "canceled") throw new SkipJobError("the booking is canceled");
    if (shooter !== to) throw new SkipJobError(`the shooter is ${shooter || "nobody"} now`);
    if (b.status === "shot" || b.status === "delivered") throw new SkipJobError(`the shoot is already marked ${b.status}`);
  } else {
    if (shooter === to && b.status !== "canceled") throw new SkipJobError("this shooter is on the booking again");
    const sent = await d.query.jobs.findFirst({
      where: and(sameInvites, eq(schema.jobs.status, "done"), isNull(schema.jobs.lastError), sql`${schema.jobs.payload}->>'method' = 'REQUEST'`),
      columns: { id: true },
    });
    if (!sent) throw new SkipJobError("no invite ever went to this address, so there is nothing to cancel");
  }
  const when = inviteWhen(b);
  if (!when) throw new SkipJobError("the booking has no date yet; the invite goes out once the time is set");

  let shooterName: string | null = null;
  try {
    shooterName = (await d.query.admins.findFirst({ where: eq(schema.admins.email, to), columns: { name: true } }))?.name ?? null;
  } catch {
    shooterName = null;
  }
  // DTSTAMP is the job's own time, so a retry sends the same bytes under the
  // same Resend idempotency key.
  const built = buildShooterInvite(b, { method, to, shooterName, when, stamp: job.createdAt });
  const resend = new Resend(key);
  const r = await resend.emails.send(
    {
      from: emailFrom(),
      replyTo: supportEmail(),
      to,
      subject: built.subject,
      text: built.text,
      html: built.html,
      attachments: [{ filename: "invite.ics", content: Buffer.from(built.ics, "utf8").toString("base64"), contentType: `text/calendar; method=${method}; charset=UTF-8` }],
    },
    { idempotencyKey: job.idempotencyKey }
  );
  // The same key with a different body means an earlier attempt already went
  // out (Resend keeps keys for 24 hours): done, never sent twice.
  if (r.error?.name === "invalid_idempotent_request") return { to, id: null };
  if (r.error) throw new Error(`Resend rejected the invite: ${r.error.message}`);
  await logActivity({
    action: "email.shooter_invite_sent",
    listingId: b.listingId,
    clientId: b.clientId,
    meta: { bookingId: b.id, to, method, sequence: built.sequence, resendId: r.data?.id ?? null },
  });
  return { to, id: r.data?.id ?? null };
}
