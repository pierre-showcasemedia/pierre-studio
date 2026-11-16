// "Pay another way" (Oct 2026): the booking form's third payment choice. The
// client pays the business by check, ACH transfer or cash; nothing is issued at Stripe
// or Titus. The booking carries payment_method "other" and payment_detail
// (check | ach | cash); its invoice carries method "other" with NO provider and
// is settled only by an admin's Mark paid (payments.markPaidManually, which
// unlocks downloads through the same CTE a webhook uses).
//
// Pure helpers, no database, so pages, emails, Slack and the admin share one
// wording. Client copy rules: plain, sentence case, no em dashes.
import { BOOKING_PAYMENT_DETAILS, type BookingPaymentDetail } from "@/db/schema";

// What the website sends as pay_other ("check" | "ach" | "cash"), tolerant of
// the longer labels a forwarded or hand-built payload might carry.
export function parsePaymentDetail(raw: string | null | undefined): BookingPaymentDetail | null {
  const v = String(raw ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!v) return null;
  if ((BOOKING_PAYMENT_DETAILS as readonly string[]).includes(v)) return v as BookingPaymentDetail;
  if (/^(check|cheque)s?$/.test(v)) return "check";
  if (/^(ach|ach transfer|bank transfer|wire|wire transfer)$/.test(v)) return "ach";
  if (/^(cash|in cash)$/.test(v)) return "cash";
  return null;
}

export function asPaymentDetail(v: unknown): BookingPaymentDetail | null {
  return typeof v === "string" && (BOOKING_PAYMENT_DETAILS as readonly string[]).includes(v) ? (v as BookingPaymentDetail) : null;
}

// The way on its own, lower case for a sentence: "check", "ACH transfer",
// "cash"; unknown = all three.
export function payOtherWay(detail: string | null | undefined): string {
  switch (asPaymentDetail(detail)) {
    case "check":
      return "check";
    case "ach":
      return "ACH transfer";
    case "cash":
      return "cash";
    default:
      return "check, ACH transfer or cash";
  }
}

// The way as a label: "Check", "ACH transfer", "Cash"; unknown = "Another way".
export function payOtherLabel(detail: string | null | undefined): string {
  const d = asPaymentDetail(detail);
  return d ? payOtherWay(d).replace(/^./, (c) => c.toUpperCase()) : "Another way";
}

// "by check", "by ACH transfer", "in cash"; unknown = "by check, ACH transfer or cash".
export function payOtherPhrase(detail: string | null | undefined): string {
  const d = asPaymentDetail(detail);
  return d === "cash" ? "in cash" : `by ${payOtherWay(d)}`;
}

// An invoice the business collects by hand: method "other" and no provider. A legacy
// Stripe row an admin marked paid by hand can also read method "other", but it
// has its provider, so it never matches.
export function isPaidAnotherWay(inv: { method?: string | null; provider?: string | null } | null | undefined): boolean {
  return Boolean(inv && inv.method === "other" && !inv.provider);
}
