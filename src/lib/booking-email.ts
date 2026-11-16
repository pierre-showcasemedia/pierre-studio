// The booking email (docs/booking-to-payment.md): "You're all set",
// the details table (when, where, services, launch, payment), the pay button,
// Add to Google Calendar, the pre-shoot checklist, and a shoot.ics attachment
// for Apple and Outlook calendars. Sent by the email.booking job in the same
// minute as the booking, and again as "updated" after a revision. Step two
// adds the pay-at-close button (our pay page through a 30-day pay token, never
// a raw provider URL) and the email.pay_link variant ("your payment link", or
// "here is your link again"). Pay another way (Oct 2026: check, ACH transfer or
// cash) has no button and no pay link: the payment row says the business will follow
// up and that nothing is charged by card.
// Layout (Oct 20 2026): a 600px card on a warm grey page, a dark header band
// with the white logo, the details table with hairline rows, rounded-rect
// buttons, and a light footer band with the tagline. All styles inline, table
// layout, so it holds up in Gmail, Apple Mail and Outlook. Client copy rules:
// plain and warm, sentence case, no em dashes, no exclamation marks, never a
// vendor or editing word (Titus is the one named partner); the only phone
// number is the Quo line and the only inbox hello@.
import { Resend } from "resend";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { fmtDollars, itemById } from "./studio-pricing";
import { BUSINESS_TZ, fmtDay, fmtWhen, isYmd, wallClockToUtc, toHm } from "./booking-time";
import { brand, emailAssetBase, emailFrom, siteUrl, supportEmail, supportPhone, mailDomain } from "./brand";
import { DeferError, NotConfiguredError, SkipJobError } from "./jobs-core";
import { isPaidAnotherWay, payOtherPhrase } from "./pay-other";
import { isPayable } from "./payments";
import { visitKindLabel, visitWhenLabel } from "./booking-visits";
import { signPayToken } from "./portal-auth";
import { hasStripe } from "./stripe-invoice";
import type { BookingPaymentDetail } from "@/db/schema";
import { business } from "./business";

const PAGE = "#EEECE8"; // light warm grey behind the card
const PAPER = "#FFFFFF";
const FOG = "#F6F5F2"; // footer band
const INK = "#0B0C0F";
const MUTED = "#5F646E";
const FAINT = "#8A8F98";
const LINE = "#E6E8EC";
const EDGE = "#D3D6DB"; // outline button border
const SERIF = "'Newsreader', Georgia, 'Times New Roman', serif";
const SANS = "'Geist', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The shoot on a calendar: the requested local start plus this many minutes.
export const SHOOT_MINUTES = 120;

export type BookingEmailPayment =
  | { kind: "card"; totalLabel: string | null; payUrl: string | null }
  | { kind: "pay_at_close"; totalLabel: string | null; payUrl: string | null }
  // Check, ACH transfer or cash: never a pay link (detail null = not given).
  | { kind: "other"; totalLabel: string | null; detail: BookingPaymentDetail | null }
  | { kind: "quote" };

// new: the confirmation; updated: after a revision; link: the pay link on its
// own (first time, when the booking email went out before the checkout
// existed); link_again: "Here is your link again" (an admin resend).
// Oct 21 2026: added / added_again: the invoice for items added after the
// booking's invoice was paid (an "addon" invoice, Edit booking); rescheduled:
// the client moved the shoot from the portal (no .ics, nothing confirmed);
// time_confirmed / new_time_confirmed / time_moved: an admin confirmed the
// time, confirmed the client's new time, or moved a confirmed time (same
// block as the confirmation, shoot.ics with a higher SEQUENCE so the entry
// moves). The time emails carry no payment row and no pay button.
// Oct 27 2026: visit / visit_again: a second shoot's own invoice (src/lib/
// visit-invoice.ts): "Your invoice for the return trip at <street>", the
// visit's time, its lines and the pay button; nothing else about the booking.
export type BookingEmailMode = "new" | "updated" | "link" | "link_again" | "added" | "added_again" | "visit" | "visit_again" | "rescheduled" | "time_confirmed" | "new_time_confirmed" | "time_moved";
export const TIME_EMAIL_MODES: BookingEmailMode[] = ["rescheduled", "time_confirmed", "new_time_confirmed", "time_moved"];
const isTimeMode = (m: BookingEmailMode) => TIME_EMAIL_MODES.includes(m);
const isVisitMode = (m: BookingEmailMode) => m === "visit" || m === "visit_again";
// An invoice that is not the booking's own (an add-on, a second shoot): "due
// on receipt", no checklist, no terms.
const isAddedMode = (m: BookingEmailMode) => m === "added" || m === "added_again" || isVisitMode(m);

// One shoot as a calendar event. startLocal/endLocal are local wall clock
// ("20261110T113000", for Google's ctz template); start/end are the instants.
export type ShootEvent = {
  uid: string;
  title: string;
  startLocal: string;
  endLocal: string;
  start: Date;
  end: Date;
  location: string;
  details: string;
  sequence: number;
};

export type BookingEmailInput = {
  clientFirstName: string | null;
  street: string;
  rest: string; // "Springfield, CA 90000"
  when: string | null; // "Monday, October 20 at 9:00 AM"
  launch: string | null; // "Friday, October 24"
  services: string[];
  addons: string[];
  // null = no payment row and no pay button (the time emails).
  payment: BookingEmailPayment | null;
  portalUrl: string;
  updated: boolean;
  mode?: BookingEmailMode;
  // Full address for the map link (defaults to street + rest).
  address?: string | null;
  // Google Calendar button and the .ics line; null = no date and time yet.
  event?: ShootEvent | null;
  // The pre-shoot checklist (PRESHOOT_CHECKLIST_URL); null = hidden.
  checklistUrl?: string | null;
  // added / added_again: the items the new invoice bills (its "Added" row).
  added?: string[];
  // visit / visit_again: the second shoot's kind ("Return trip"); its lines
  // ride in `added` and read "Items".
  visitLabel?: string | null;
};

const modeOf = (x: Pick<BookingEmailInput, "updated" | "mode">): BookingEmailMode => x.mode ?? (x.updated ? "updated" : "new");

export function bookingEmailSubject(street: string, updated: boolean, mode?: BookingEmailMode, visitLabel?: string | null): string {
  switch (mode ?? (updated ? "updated" : "new")) {
    case "visit":
      return `Your invoice for the ${(visitLabel || "second shoot").toLowerCase()} at ${street}`;
    case "visit_again":
      return `Your payment link again: ${street}`;
    case "link":
      return `Your payment link: ${street}`;
    case "link_again":
      return `Your payment link again: ${street}`;
    case "updated":
      return `Your updated shoot request: ${street}`;
    case "added":
      return `Your added items: ${street}`;
    case "added_again":
      return `Your payment link again: ${street}`;
    case "rescheduled":
      return `Your shoot has been rescheduled: ${street}`;
    case "time_confirmed":
      return `Your shoot time is confirmed: ${street}`;
    case "new_time_confirmed":
      return `Your new time is confirmed: ${street}`;
    case "time_moved":
      return `Your shoot has moved: ${street}`;
    default:
      return `You're all set: ${street}`;
  }
}

// The pre-shoot checklist link, or null when it is not configured.
export function preshootChecklistUrl(): string | null {
  const v = (process.env.PRESHOOT_CHECKLIST_URL || "").trim();
  return /^https?:\/\//i.test(v) ? v : null;
}

export function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// "2026-11-10" + "11:30" → the shoot as a calendar event, or null without a
// usable date and time. Times are local wall clock; the end is the start
// plus SHOOT_MINUTES.
export function shootEvent(b: {
  bookingId: string;
  desiredDate: string | null;
  startTime: string | null;
  street: string;
  address: string;
  services: string[];
  sequence?: number;
}): ShootEvent | null {
  const ymd = b.desiredDate;
  const hm = toHm(b.startTime);
  if (!isYmd(ymd) || !hm) return null;
  const start = wallClockToUtc(ymd, hm);
  if (!start) return null;
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  const wall = (minutes: number) => new Date(Date.UTC(y, mo - 1, d, h, mi + minutes)).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const lines = [...b.services, "", `Questions? Reply to your confirmation email or text ${supportPhone()}.`];
  return {
    uid: `${b.bookingId}@${mailDomain()}`,
    title: `${brand.shortName} shoot: ${b.street}`,
    startLocal: wall(0),
    endLocal: wall(SHOOT_MINUTES),
    start,
    end: new Date(start.getTime() + SHOOT_MINUTES * 60_000),
    location: b.address,
    details: (b.services.length ? lines : lines.slice(2)).join("\n"),
    sequence: Math.max(0, Math.floor(b.sequence ?? 0)),
  };
}

export function googleCalendarUrl(ev: ShootEvent): string {
  const q = (v: string) => encodeURIComponent(v);
  return (
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&text=${q(ev.title)}` +
    `&dates=${ev.startLocal}/${ev.endLocal}` +
    `&ctz=${q(BUSINESS_TZ)}` +
    (ev.location ? `&location=${q(ev.location)}` : "") +
    `&details=${q(ev.details)}`
  );
}

// RFC 5545 text: escape backslashes, commas, semicolons and newlines.
const icsText = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsUtc = (d: Date) => `${d.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;

// Lines longer than 75 octets fold onto continuation lines starting with a space.
function icsFold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length ? 74 : 75; // continuation lines carry the leading space
    if (bytes + n > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

// The shoot.ics attachment: one VEVENT, UTC instants, CRLF line endings.
export function shootIcs(ev: ShootEvent, now: Date = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${brand.name}//Booking//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `SEQUENCE:${ev.sequence}`,
    `DTSTAMP:${icsUtc(now)}`,
    `DTSTART:${icsUtc(ev.start)}`,
    `DTEND:${icsUtc(ev.end)}`,
    `SUMMARY:${icsText(ev.title)}`,
    ...(ev.location ? [`LOCATION:${icsText(ev.location)}`] : []),
    `DESCRIPTION:${icsText(ev.details)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(icsFold).join("\r\n")}\r\n`;
}

type Copy = { eyebrow: string; headlineHtml: string; headlineText: string; intro: string };

function copyFor(mode: BookingEmailMode, x: BookingEmailInput): Copy {
  const name = x.clientFirstName?.trim() || null;
  const em = (t: string) => `<em style="font-family:${SERIF};font-style:italic;font-weight:400;letter-spacing:-.01em;">${esc(t)}</em>`;
  switch (mode) {
    case "link":
    case "link_again": {
      const kind = x.payment?.kind ?? "card";
      const intro =
        mode === "link_again"
          ? `Here is your payment link again for ${x.street}. Nothing else about your booking has changed.`
          : kind === "card"
            ? `Here is the link to pay your invoice for ${x.street}. Nothing else about your booking has changed.`
            : kind === "other"
              ? `Here are the payment details for ${x.street}. Nothing else about your booking has changed.`
              : `Here is the link to complete your pay at close application for ${x.street}. Nothing else about your booking has changed.`;
      return mode === "link_again"
        ? { eyebrow: "Your payment link", headlineHtml: `Here is your link ${em("again.")}`, headlineText: "Here is your link again.", intro }
        : { eyebrow: "Your payment link", headlineHtml: `Here is your payment ${em("link.")}`, headlineText: "Here is your payment link.", intro };
    }
    case "updated":
      return { eyebrow: "Shoot updated", headlineHtml: `Your shoot is ${em("updated.")}`, headlineText: "Your shoot is updated.", intro: "Here is the new plan:" };
    case "added":
      return {
        eyebrow: "Added to your shoot",
        headlineHtml: `Added to your ${em("shoot.")}`,
        headlineText: "Added to your shoot.",
        intro: `Here is the invoice for what was added to your shoot at ${x.street}. Your earlier payment stands, and nothing else about your booking has changed.`,
      };
    case "added_again":
      return { eyebrow: "Your payment link", headlineHtml: `Here is your link ${em("again.")}`, headlineText: "Here is your link again.", intro: `Here is the payment link again for the items added to your shoot at ${x.street}. Nothing else about your booking has changed.` };
    case "visit": {
      const what = (x.visitLabel || "second shoot").toLowerCase();
      return {
        eyebrow: x.visitLabel || "Second shoot",
        headlineHtml: `Your invoice for the ${em(`${what}.`)}`,
        headlineText: `Your invoice for the ${what}.`,
        intro: `Here is the invoice for the ${what} at ${x.street}. It is separate from your original booking, and nothing else about your booking has changed.`,
      };
    }
    case "visit_again": {
      const what = (x.visitLabel || "second shoot").toLowerCase();
      return { eyebrow: "Your payment link", headlineHtml: `Here is your link ${em("again.")}`, headlineText: "Here is your link again.", intro: `Here is the payment link again for the ${what} at ${x.street}. Nothing else about your booking has changed.` };
    }
    case "rescheduled":
      return { eyebrow: "Shoot rescheduled", headlineHtml: `Shoot has been ${em("rescheduled.")}`, headlineText: "Shoot has been rescheduled.", intro: `${brand.shortName} will confirm your new time shortly. Here is what you asked for:` };
    case "time_confirmed":
      return { eyebrow: "Time confirmed", headlineHtml: `Your shoot time is ${em("confirmed.")}`, headlineText: "Your shoot time is confirmed.", intro: "We have you on our calendar. Here are the details:" };
    case "new_time_confirmed":
      return { eyebrow: "New time confirmed", headlineHtml: `Your new time is ${em("confirmed.")}`, headlineText: "Your new time is confirmed.", intro: "Thanks for letting us know. Here is the updated plan:" };
    case "time_moved":
      return { eyebrow: "Shoot moved", headlineHtml: `Your shoot has ${em("moved.")}`, headlineText: "Your shoot has moved.", intro: "Your shoot has a new time, confirmed on our side. Here is the updated plan:" };
    default:
      return {
        eyebrow: "Shoot confirmed",
        headlineHtml: name ? `You're all set, ${em(`${name}.`)}` : `You're all ${em("set.")}`,
        headlineText: name ? `You're all set, ${name}.` : "You're all set.",
        intro: "We have you on our calendar for a shoot together. Here are the details:",
      };
  }
}

// The payment row of the details table, and the pay button when there is one.
// `added`: the row belongs to an add-on invoice (nothing about the date).
function paymentOf(p: BookingEmailPayment, added = false): { label: string; value: string | null; note: string | null; cta: { href: string; label: string } | null } {
  switch (p.kind) {
    case "card":
      return {
        label: "Total",
        value: p.totalLabel,
        note: added ? (p.payUrl ? "Due on receipt." : "Due on receipt. Your invoice is on its way in a separate email.") : p.payUrl ? "Due at booking, reserves your date." : "Due at booking, reserves your date. Your invoice is on its way in a separate email.",
        cta: p.payUrl ? { href: p.payUrl, label: `Pay invoice${p.totalLabel ? ` · ${p.totalLabel}` : ""}` } : null,
      };
    case "pay_at_close":
      return {
        label: "Pay at close",
        value: p.totalLabel,
        note: p.payUrl ? "Through our partner Titus, nothing due today." : "Through our partner Titus, nothing due today. We'll email you a short application.",
        cta: p.payUrl ? { href: p.payUrl, label: "Complete your pay at close application" } : null,
      };
    case "other":
      return { label: "Total", value: p.totalLabel, note: `${brand.shortName} will follow up about paying ${payOtherPhrase(p.detail)}. Nothing is charged by card.`, cta: null };
    case "quote":
      return { label: "Pricing", value: null, note: "Quoted by hand. We'll send the amount before anything is due.", cta: null };
  }
}

const CHECKLIST_COPY = "To make this easy for everyone, here's our pre-shoot checklist you can share with your sellers. It makes sure the home looks its best for your investment.";
const CANCEL_COPY = "Need to reschedule or cancel? Just reply to this email or reschedule the booking in your client portal. Payment reserves your date. Unexplained cancellations are billed at 50% within 48 hours of the shoot and in full within 24 hours; weather and emergencies we handle case by case.";
const TIME_NOTE = "We'll text you if the time needs to move.";
// The client moved the shoot from the portal: nothing is confirmed yet.
const RESCHEDULED_NOTE = `Nothing is confirmed until you hear from us. ${brand.shortName} will confirm your new time shortly.`;
const CONFIRMED_NOTE = "Confirmed. We'll text you if anything needs to move.";

// What the When row says under the time, by mode.
function whenNote(mode: BookingEmailMode): string {
  if (mode === "rescheduled") return RESCHEDULED_NOTE;
  if (isTimeMode(mode)) return CONFIRMED_NOTE;
  return TIME_NOTE;
}
// The checklist paragraph and the cancellation terms: on the confirmations
// (new, updated, the time confirmations), not on a pay link or a reschedule.
const showTerms = (mode: BookingEmailMode) => !isAddedMode(mode) && mode !== "link" && mode !== "link_again" && mode !== "rescheduled";

const addressOf = (x: BookingEmailInput) => (x.address ?? [x.street, x.rest].filter(Boolean).join(", ")).trim();

export function bookingEmailHtml(x: BookingEmailInput): string {
  const mode = modeOf(x);
  const copy = copyFor(mode, x);
  const logo = `${emailAssetBase()}${brand.logoWhite}`;
  const logoW = 132;
  const logoH = Math.round(logoW / brand.logoRatio);
  const phone = supportPhone();
  const tel = phone.replace(/[^0-9+]/g, "");
  const site = brand.marketingUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const pay = x.payment ? paymentOf(x.payment, isAddedMode(mode)) : null;
  const address = addressOf(x);
  const ev = x.event ?? null;
  const checklist = showTerms(mode) ? x.checklistUrl ?? null : null;
  const terms = showTerms(mode);

  const button = (href: string, label: string, solid: boolean) =>
    `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 10px 0;font-family:${SANS};font-size:14px;font-weight:600;line-height:20px;color:${solid ? PAPER : INK};background:${solid ? INK : PAPER};border:1px solid ${solid ? INK : EDGE};border-radius:8px;padding:12px 20px;text-decoration:none;">${esc(label)}</a>`;

  const muted = (t: string) => `<div style="margin-top:4px;font-family:${SANS};font-size:12.5px;line-height:1.5;color:${MUTED};font-weight:400;">${esc(t)}</div>`;

  const row = (label: string, valueHtml: string, first: boolean) => `
                  <tr>
                    <td class="st-label" width="118" style="width:118px;padding:14px 12px 14px 0;${first ? "" : `border-top:1px solid ${LINE};`}font-family:${SANS};font-size:10.5px;line-height:20px;letter-spacing:.14em;text-transform:uppercase;color:${FAINT};vertical-align:top;">${esc(label)}</td>
                    <td style="padding:14px 0;${first ? "" : `border-top:1px solid ${LINE};`}font-family:${SANS};font-size:14.5px;line-height:1.5;color:${INK};vertical-align:top;">${valueHtml}</td>
                  </tr>`;

  const items = [...x.services, ...x.addons];
  const added = x.added ?? [];
  const rows: [string, string][] = [];
  rows.push(["When", x.when ? `<strong style="font-weight:600;">${esc(x.when).replace(/ (AM|PM)$/, "&nbsp;$1")}</strong>${muted(whenNote(mode))}` : `<strong style="font-weight:600;">Date to be confirmed</strong>${muted("We'll text you to set the time.")}`]);
  if (address) rows.push(["Where", `<a href="${esc(mapsUrl(address))}" style="color:${INK};text-decoration:underline;">${esc(address)}</a>`]);
  if (items.length) rows.push(["Services", items.map(esc).join("<br/>")]);
  if (added.length) rows.push([isVisitMode(mode) ? "Items" : "Added", added.map(esc).join("<br/>")]);
  if (x.launch) rows.push(["Launch", esc(x.launch)]);
  if (pay) rows.push([pay.label, `${pay.value ? `<strong style="font-weight:600;">${esc(pay.value)}</strong>` : ""}${pay.note ? (pay.value ? muted(pay.note) : esc(pay.note)) : ""}`]);
  const details = rows.map(([l, v], i) => row(l, v, i === 0)).join("");

  const buttons = [
    pay?.cta ? button(pay.cta.href, pay.cta.label, true) : "",
    ev ? button(googleCalendarUrl(ev), "Add to Google Calendar", !pay?.cta) : "",
    checklist ? button(checklist, "Pre-shoot checklist", !pay?.cta && !ev) : "",
  ].join("");

  const p = (html: string, pad = "0 40px 22px", size = "15px", color = INK) =>
    `<tr><td class="st-pad" style="padding:${pad};"><p style="margin:0;font-family:${SANS};font-size:${size};line-height:1.65;color:${color};">${html}</p></td></tr>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="light"/>
  <meta name="supported-color-schemes" content="light"/>
  <title>${esc(bookingEmailSubject(x.street, x.updated, mode, x.visitLabel))}</title>
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@1,6..72,400&display=swap" rel="stylesheet"/>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@1,6..72,400&display=swap');
    @media only screen and (max-width:480px) {
      .st-outer { padding:20px 10px 32px !important; }
      .st-pad { padding-left:24px !important; padding-right:24px !important; }
      .st-h1 { font-size:28px !important; }
      .st-label { width:92px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};">
    <tr><td class="st-outer" align="center" style="padding:40px 16px 48px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${PAPER};border-radius:14px;border-collapse:separate;">

        <tr><td class="st-pad" bgcolor="${INK}" style="background:${INK};border-radius:14px 14px 0 0;padding:24px 40px;">
          <a href="${brand.marketingUrl}" style="text-decoration:none;">
            <img src="${logo}" width="${logoW}" height="${logoH}" alt="${brand.name}" style="display:block;border:0;width:${logoW}px;height:${logoH}px;"/>
          </a>
        </td></tr>

        <tr><td class="st-pad" style="padding:40px 40px 0;">
          <p style="margin:0 0 14px;font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:${FAINT};">${esc(copy.eyebrow)}</p>
          <h1 class="st-h1" style="margin:0 0 16px;font-family:${SANS};font-weight:700;font-size:32px;line-height:1.15;letter-spacing:-.02em;color:${INK};">${copy.headlineHtml}</h1>
        </td></tr>

        ${p(esc(copy.intro), "0 40px 20px")}

        <tr><td class="st-pad" style="padding:0 40px 26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};">${details}
          </table>
        </td></tr>

        ${checklist ? p(esc(CHECKLIST_COPY)) : ""}

        ${buttons ? `<tr><td class="st-pad" style="padding:0 40px 14px;">${buttons}</td></tr>` : ""}

        ${ev ? p(`Using Apple or Outlook calendar? Open the attached <strong style="font-weight:600;color:${INK};">shoot.ics</strong> file to add it.`, "0 40px 14px", "13px", MUTED) : ""}

        ${terms ? p(esc(CANCEL_COPY).replace("client portal", `<a href="${esc(x.portalUrl)}" style="color:${MUTED};text-decoration:underline;">client portal</a>`), "0 40px 28px", "13px", MUTED) : ""}

        <tr><td class="st-pad" style="padding:0 40px 36px;">
          <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK};">Best,</p>
          <p style="margin:6px 0 0;font-family:${SANS};font-size:15px;line-height:1.5;font-weight:700;color:${INK};">The ${esc(brand.shortName)} team</p>
          <p style="margin:2px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${MUTED};">${esc(brand.name)}&nbsp;·&nbsp;<a href="tel:${tel}" style="color:${MUTED};text-decoration:none;">${esc(phone)}</a></p>
        </td></tr>

        <tr><td class="st-pad" bgcolor="${FOG}" style="background:${FOG};border-top:1px solid ${LINE};border-radius:0 0 14px 14px;padding:22px 40px 24px;">
          <p style="margin:0 0 6px;font-family:${SANS};font-size:10.5px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:${INK};">Bespoke media, crafted to sell.</p>
          <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">${esc(brand.legalName)}&nbsp;·&nbsp;${esc(business.city)}&nbsp;·&nbsp;<a href="${brand.marketingUrl}" style="color:${MUTED};text-decoration:underline;">${esc(site)}</a></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function bookingEmailText(x: BookingEmailInput): string {
  const mode = modeOf(x);
  const copy = copyFor(mode, x);
  const pay = x.payment ? paymentOf(x.payment, isAddedMode(mode)) : null;
  const address = addressOf(x);
  const ev = x.event ?? null;
  const checklist = showTerms(mode) ? x.checklistUrl ?? null : null;
  const items = [...x.services, ...x.addons];
  const added = x.added ?? [];
  const payLine = pay ? [pay.value, pay.note].filter(Boolean).join(". ") : "";
  const lines = [
    copy.headlineText,
    "",
    copy.intro,
    "",
    `When: ${x.when ?? "Date to be confirmed"}`,
    x.when ? whenNote(mode) : "We'll text you to set the time.",
    ...(address ? [`Where: ${address}`, `Map: ${mapsUrl(address)}`] : []),
    ...(items.length ? [`Services: ${items.join(", ")}`] : []),
    ...(added.length ? [`${isVisitMode(mode) ? "Items" : "Added"}: ${added.join(", ")}`] : []),
    ...(x.launch ? [`Launch: ${x.launch}`] : []),
    ...(pay ? [`${pay.label}: ${payLine}`] : []),
    "",
    ...(checklist ? [CHECKLIST_COPY, `Pre-shoot checklist: ${checklist}`, ""] : []),
    ...(pay?.cta ? [`${pay.cta.label}: ${pay.cta.href}`] : []),
    ...(ev ? [`Add to Google Calendar: ${googleCalendarUrl(ev)}`, "Using Apple or Outlook calendar? Open the attached shoot.ics file to add it."] : []),
    ...(pay?.cta || ev ? [""] : []),
    ...(showTerms(mode) ? [CANCEL_COPY, `Client portal: ${x.portalUrl}`, ""] : []),
    "Best,",
    `The ${brand.shortName} team`,
    `${brand.name} · ${supportPhone()}`,
  ];
  return lines.join("\n");
}

export type BuiltBookingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  bookingId: string;
  listingId: string;
  clientId: string;
  payLink: boolean;
  ics: string | null; // the shoot.ics attachment, when the booking has a date and time
};

// The pay page behind a 30-day token: /api/portal/verify signs the client in
// and lands on /portal/<slug>/pay (with ?invoice= when the delivery email
// names one of several). Never a raw provider URL.
export async function payPageLink(email: string, slug: string, opts: { invoiceId?: string | null } = {}): Promise<string> {
  const token = await signPayToken(email, slug);
  const next = `/portal/${slug}/pay${opts.invoiceId ? `?invoice=${encodeURIComponent(opts.invoiceId)}` : ""}`;
  return `${siteUrl()}/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
}

// Reads the booking and decides the payment line. A card booking whose Stripe
// invoice is not issued yet defers (the stripe.invoice.create job is queued
// just ahead of the email); after 30 minutes the email goes without the button.
// A pay-at-close booking always carries the pay page link; the page itself
// opens (or recreates) the Titus checkout. A canceled booking, or a pay link
// for an invoice that is no longer payable, sends nothing (SkipJobError: the
// job is done, not retried), so a voided invoice never reaches a client.
// `invoiceId` names an invoice other than the booking's own (an add-on
// invoice from Edit booking, Oct 21 2026): the email becomes "added" (or
// "added_again" for a resend) and bills that invoice's lines alone, with its
// own pay link (the pay page with ?invoice=). The pay link job carries the
// invoice id on its row, so an older job (the booking's own invoice) reads
// exactly as before.
export async function buildBookingEmail(bookingId: string, opts: { updated?: boolean; mode?: BookingEmailMode; invoiceId?: string | null } = {}): Promise<BuiltBookingEmail> {
  const b = await db().query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), with: { listing: true, client: true, invoice: true } });
  if (!b) throw new Error(`booking ${bookingId} not found`);
  if (!b.client) throw new Error(`booking ${bookingId} has no client`);
  if (b.status === "canceled") throw new SkipJobError("the booking is canceled; no email goes out");
  const address = b.listing?.address ?? b.property?.street ?? "";
  const street = address.split(",")[0].trim() || "your property";
  const rest = address.split(",").slice(1).join(",").trim();
  const extraId = opts.invoiceId && opts.invoiceId !== b.invoiceId ? opts.invoiceId : null;
  const extra = extraId ? await db().query.invoices.findFirst({ where: and(eq(schema.invoices.id, extraId), eq(schema.invoices.bookingId, b.id)) }) : null;
  if (extraId && !extra) throw new SkipJobError("the invoice is not on this booking; no email goes out");
  const inv = extra ?? b.invoice;
  const again = opts.mode === "link_again" || opts.mode === "added_again" || opts.mode === "visit_again";
  // A second shoot's invoice (Oct 27 2026) reads as its own email, with the
  // visit's time in the When row.
  const visitId = extra && extra.meta?.invoiceType === "additional_shoot" ? extra.meta.visitId ?? null : null;
  const visit = visitId ? await db().query.bookingVisits.findFirst({ where: eq(schema.bookingVisits.id, visitId) }) : null;
  if (visit && visit.status === "canceled") throw new SkipJobError("the second shoot is canceled; no email goes out");
  const mode: BookingEmailMode = extra ? (visitId ? (again ? "visit_again" : "visit") : again ? "added_again" : "added") : opts.mode ?? (opts.updated ? "updated" : "new");
  const linkMode = mode === "link" || mode === "link_again";
  if (linkMode && (!inv || !isPayable(inv.status))) throw new SkipJobError(`the invoice is ${inv?.status ?? "missing"}; no pay link goes out`);
  if (linkMode && isPaidAnotherWay(inv)) throw new SkipJobError("the client pays another way (check, ACH transfer or cash); there is no pay link");
  // An add-on invoice is news only while it is owed (or paid another way,
  // where the amount itself is the news); a voided or paid one sends nothing.
  if (extra && !isPayable(extra.status) && extra.status !== "needs_quote") throw new SkipJobError(`the add-on invoice is ${extra.status}; no email goes out`);
  const total = inv?.amountCents != null && inv.amountCents > 0 ? fmtDollars(inv.amountCents) : null;
  let payment: BookingEmailPayment;
  if (!inv || inv.status === "needs_quote") payment = { kind: "quote" };
  else if (isPaidAnotherWay(inv)) payment = { kind: "other", totalLabel: total, detail: b.paymentDetail ?? null };
  else if (inv.method === "pay_at_close") {
    payment = { kind: "pay_at_close", totalLabel: total, payUrl: b.listing?.slug ? await payPageLink(b.client.email, b.listing.slug, { invoiceId: extra ? extra.id : null }) : null };
  } else {
    const url = inv.hostedUrl ?? inv.hostedInvoiceUrl ?? null;
    const since = extra ? Math.max(extra.createdAt.getTime(), extra.updatedAt.getTime()) : Math.max(b.createdAt.getTime(), b.updatedAt.getTime());
    if (!url && hasStripe() && !inv.providerId && inv.status === "open" && Date.now() - since < 30 * 60_000) {
      throw new DeferError("waiting for the invoice to be issued", 60_000);
    }
    payment = { kind: "card", totalLabel: total, payUrl: url };
  }
  const names = (ids: string[] | null) => (ids ?? []).map((id) => itemById(id)?.name ?? id);
  const services = names(b.serviceIds);
  const addons = names(b.addonIds);
  const fullAddress = address.trim() || null;
  // The add-on email has no calendar entry to add: the booking email carried it.
  const event = extra
    ? null
    : shootEvent({
        bookingId: b.id,
        desiredDate: b.desiredDate,
        startTime: b.startTime,
        street,
        address: fullAddress ?? "",
        services: [...services, ...addons],
        sequence: (b.calendarVersion ?? 1) - 1,
      });
  const input: BookingEmailInput = {
    clientFirstName: b.client.name?.split(" ")[0] ?? null,
    street,
    rest,
    when: visit ? visitWhenLabel(visit, { long: true }) : visitId ? null : fmtWhen({ desiredDate: b.desiredDate, startTime: b.startTime }, { long: true }),
    launch: extra ? null : b.launchDate ? fmtDay(b.launchDate, { long: true }) : null,
    services: extra ? [] : services,
    addons: extra ? [] : addons,
    added: extra ? (extra.lineItems ?? []).map((l) => l.name) : undefined,
    visitLabel: visit ? visitKindLabel(visit.kind) : visitId ? visitKindLabel(extra?.meta?.visitKind) : null,
    payment,
    portalUrl: `${siteUrl()}/portal/login`,
    updated: mode === "updated",
    mode,
    address: fullAddress,
    event,
    checklistUrl: preshootChecklistUrl(),
  };
  const payLink = (payment.kind === "card" || payment.kind === "pay_at_close") && Boolean(payment.payUrl);
  return {
    to: b.client.email,
    subject: bookingEmailSubject(street, input.updated, mode, input.visitLabel),
    html: bookingEmailHtml(input),
    text: bookingEmailText(input),
    bookingId: b.id,
    listingId: b.listingId,
    clientId: b.clientId,
    payLink,
    ics: event ? shootIcs(event) : null,
  };
}

// The shoot.ics attachment for Resend (base64 content), when there is one.
function icsAttachments(built: BuiltBookingEmail): { filename: string; content: string }[] | undefined {
  return built.ics ? [{ filename: "shoot.ics", content: Buffer.from(built.ics, "utf8").toString("base64") }] : undefined;
}

export async function sendBookingEmail(bookingId: string, opts: { version: number; updated: boolean; idempotencyKey: string }): Promise<{ to: string; id: string | null }> {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) throw new NotConfiguredError("email sending (RESEND_API_KEY)");
  const built = await buildBookingEmail(bookingId, { updated: opts.updated });
  const resend = new Resend(key);
  const r = await resend.emails.send(
    { from: emailFrom(), replyTo: supportEmail(), to: built.to, subject: built.subject, html: built.html, text: built.text, attachments: icsAttachments(built) },
    { idempotencyKey: opts.idempotencyKey }
  );
  if (r.error) throw new Error(`Resend rejected the email: ${r.error.message}`);
  await logActivity({
    action: "email.booking_sent",
    listingId: built.listingId,
    clientId: built.clientId,
    meta: { bookingId, to: built.to, version: opts.version, updated: opts.updated, payLink: built.payLink, ics: Boolean(built.ics), resendId: r.data?.id ?? null },
  });
  return { to: built.to, id: r.data?.id ?? null };
}

// The email.pay_link job: the same template, with the pay link alone as the
// news. `again` reads "Here is your link again" (an admin resend); otherwise
// it is the first time the client sees the link.
export async function sendPayLinkEmail(bookingId: string, opts: { idempotencyKey: string; again: boolean; invoiceId?: string | null }): Promise<{ to: string; id: string | null }> {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) throw new NotConfiguredError("email sending (RESEND_API_KEY)");
  const built = await buildBookingEmail(bookingId, { mode: opts.again ? "link_again" : "link", invoiceId: opts.invoiceId ?? null });
  const resend = new Resend(key);
  const r = await resend.emails.send(
    { from: emailFrom(), replyTo: supportEmail(), to: built.to, subject: built.subject, html: built.html, text: built.text, attachments: icsAttachments(built) },
    { idempotencyKey: opts.idempotencyKey }
  );
  if (r.error) throw new Error(`Resend rejected the email: ${r.error.message}`);
  await logActivity({ action: "email.pay_link_sent", listingId: built.listingId, clientId: built.clientId, meta: { bookingId, to: built.to, again: opts.again, payLink: built.payLink, ics: Boolean(built.ics), ...(opts.invoiceId ? { invoiceId: opts.invoiceId } : {}), resendId: r.data?.id ?? null } });
  return { to: built.to, id: r.data?.id ?? null };
}
