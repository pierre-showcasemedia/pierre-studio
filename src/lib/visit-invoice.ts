// A second shoot's own invoice (Oct 27 2026). the owner: "Ensure that additional
// calendar invites do not also auto-generate a new invoice. In the popup when
// you add a 'new' or 'second' shoot to a listing, an option should also pop up
// like a checkbox that says 'Create new invoice?' ... If you check it, it will
// have a new box/dialogue where we input new line items and costs if the
// second shoot requires a second invoice."
//
// So adding a visit never touches money unless that box is ticked (it starts
// unticked), or an admin uses "Create invoice" on a visit row later. Then:
//   - one invoices row: provider stripe, method card (never pay at close or
//     pay another way, whatever the booking used), status open, the typed
//     lines as priced line items, booking_id = the booking, the booking's
//     listing, client and address, env = this deployment, description
//     "<street>: <kind>", meta { invoiceType "additional_shoot", visitId,
//     visitKind }; booking_visits.invoice_id points back at it. The booking's
//     own invoice (bookings.invoice_id) never changes;
//   - the same path the booking and the add-on invoices use: the
//     stripe.invoice.create job issues the Stripe invoice (Stripe emails its
//     own copy too), then email.pay_link with this invoice's id sends the business's
//     short "Your invoice for the return trip at <street>" email with the
//     hosted pay link (src/lib/booking-email.ts, modes visit / visit_again),
//     and #payments hears (amounts allowed there only);
//   - it never locks or unlocks the gallery (NON_GATING_INVOICE_TYPES in
//     src/lib/payments.ts): paying it is recorded on it alone, a refund of it
//     never relocks, and the booking's own invoice keeps governing downloads.
// Canceling the visit voids an open invoice (closeProviderObject, the void
// path Cancel booking uses); a paid one is left alone (refund it in Stripe).
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { InvoiceLineItem, InvoiceMeta, InvoiceStatus } from "@/db/schema";
import type { AdminBookingInvoice } from "./admin-types";
import { logActivity } from "./activity";
import { fmtDollars } from "./studio-pricing";
import { currentEnv, enqueueJobs, jobKey, type JobSpec } from "./jobs-core";
import { closeProviderObject, isPaid, payLineFor, transitionInvoice } from "./payments";
import { paymentsText } from "./slack";

export const VISIT_INVOICE_TYPE = "additional_shoot";
// A sane cap for a return trip: anything bigger is a booking of its own.
export const VISIT_INVOICE_MAX_CENTS = 50_000 * 100;
export const VISIT_INVOICE_MAX_LINES = 20;
const LINE_NAME_MAX = 200;

export const isVisitInvoice = (meta: Pick<InvoiceMeta, "invoiceType"> | null | undefined): boolean => meta?.invoiceType === VISIT_INVOICE_TYPE;

// The statuses a visit invoice may be voided from when its visit is canceled.
// processing and review are left alone: a payment is in flight.
const VOIDABLE: InvoiceStatus[] = ["needs_quote", "open", "draft", "uncollectible"];
// A visit whose invoice ended like this may get a new one.
const CLOSED: string[] = ["void", "canceled"];
export const visitInvoiceIsClosed = (status: string | null | undefined): boolean => !status || CLOSED.includes(status);

export type VisitInvoiceLines = { lines: InvoiceLineItem[]; totalCents: number };

// The form's rows: line_desc[] and line_amount[] (dollars, up to two decimals).
// A row left empty on both sides is ignored. A string is the banner's error.
export function parseVisitInvoiceLines(formData: FormData): VisitInvoiceLines | string {
  const names = formData.getAll("line_desc").map((v) => String(v ?? "").replace(/\s+/g, " ").trim());
  const amounts = formData.getAll("line_amount").map((v) => String(v ?? "").trim());
  const lines: InvoiceLineItem[] = [];
  for (let i = 0; i < Math.max(names.length, amounts.length); i++) {
    const name = names[i] ?? "";
    const raw = (amounts[i] ?? "").replace(/[$,\s]/g, "");
    if (!name && !raw) continue;
    if (!name) return `Line ${i + 1} needs a description.`;
    if (name.length > LINE_NAME_MAX) return `The description "${name.slice(0, 40)}..." is too long. Keep each line under ${LINE_NAME_MAX} characters.`;
    if (!raw) return `Add an amount for "${name}".`;
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return `The amount for "${name}" is not a dollar amount. Use numbers like 350 or 350.50.`;
    const cents = Math.round(Number(raw) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return `The amount for "${name}" must be above zero.`;
    lines.push({ id: `visit-${lines.length + 1}`, name, cents, priced: true });
  }
  if (!lines.length) return "Add at least one invoice line with a description and an amount, or untick Create new invoice.";
  if (lines.length > VISIT_INVOICE_MAX_LINES) return `Keep it to ${VISIT_INVOICE_MAX_LINES} lines or fewer.`;
  const totalCents = lines.reduce((n, l) => n + l.cents, 0);
  if (totalCents < 100) return "The invoice total must be at least $1.";
  if (totalCents > VISIT_INVOICE_MAX_CENTS) return `The invoice total is ${fmtDollars(totalCents)}. A second shoot invoice is capped at ${fmtDollars(VISIT_INVOICE_MAX_CENTS)}; check the amounts.`;
  return { lines, totalCents };
}

type BookingForInvoice = {
  id: string;
  listingId: string;
  clientId: string;
  invoice?: { status: string } | null;
  listing?: { address: string; nda: boolean } | null;
  property: Record<string, unknown> | null;
  client?: { email: string; name: string | null } | null;
};
type VisitForInvoice = { id: string; kind: string };

// Writes the invoice, links the visit and queues the issue, the pay link email
// and the payments line. The caller has checked the admin, the environment,
// the booking (not canceled), the visit (not canceled, no live invoice) and
// the lines. Returns the new invoice id.
export async function createVisitInvoice(p: { booking: BookingForInvoice; visit: VisitForInvoice; kindLabel: string; whenLabel: string; lines: VisitInvoiceLines; actor: string }): Promise<{ invoiceId: string; amountCents: number; to: string | null }> {
  const d = db();
  const b = p.booking;
  const address = b.listing?.address ?? String(b.property?.street ?? "");
  const street = address.split(",")[0].trim() || "The property";
  const to = b.client?.email ?? null;
  const id = randomUUID();
  const now = new Date();
  const items = p.lines.lines.map((l) => l.name).join(", ");
  await d.insert(schema.invoices).values({
    id,
    listingId: b.listingId,
    clientId: b.clientId,
    clientEmail: to,
    propertyAddress: address || null,
    status: "open",
    amountDue: p.lines.totalCents,
    amountCents: p.lines.totalCents,
    currency: "usd",
    provider: "stripe",
    method: "card",
    description: `${street}: ${p.kindLabel}`,
    lineItems: p.lines.lines,
    meta: {
      invoiceType: VISIT_INVOICE_TYPE,
      visitId: p.visit.id,
      visitKind: p.visit.kind,
      createdBy: p.actor,
      computedTotalCents: p.lines.totalCents,
      note: `${p.kindLabel} on ${p.whenLabel}, invoiced by ${p.actor}; it never locks or unlocks the gallery`,
    },
    bookingId: b.id,
    idempotencyVersion: 1,
    env: currentEnv(),
    createdAt: now,
    updatedAt: now,
  });
  await d.update(schema.bookingVisits).set({ invoiceId: id, updatedAt: now }).where(eq(schema.bookingVisits.id, p.visit.id));
  await logActivity({ actorEmail: p.actor, action: "invoice.visit_created", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, visitId: p.visit.id, invoiceId: id, kindLabel: p.kindLabel, items, amountCents: p.lines.totalCents, provider: "stripe", method: "card" } });
  const base = { invoiceId: id, bookingId: b.id, listingId: b.listingId };
  // The Stripe invoice first, then the email that waits for its hosted link:
  // separate inserts so the drain runs them in that order.
  await enqueueJobs([{ kind: "stripe.invoice.create", idempotencyKey: jobKey("stripe.invoice.create", id, 1), ...base, payload: { version: 1, invoiceId: id } }]);
  await enqueueJobs([{ kind: "email.pay_link", idempotencyKey: jobKey("email.pay_link", id, 1), ...base, payload: { version: 1, again: false } }]);
  const line = await payLineFor(id);
  if (line) await enqueueJobs([{ kind: "slack.payment", idempotencyKey: `slack.payment:visit_invoice:${id}:v1`, ...base, payload: { version: 1, text: paymentsText.visitInvoice({ ...line, by: p.actor, kindLabel: p.kindLabel, items, mainStatus: b.invoice?.status ?? null }) } }]);
  return { invoiceId: id, amountCents: p.lines.totalCents, to };
}

export type VisitVoidResult = {
  // voided: closed here; paid: already paid (left alone); settled: the provider
  // showed it paid, so it was recorded as paid instead; in_flight: a payment is
  // processing or in review (left alone); none: nothing to do.
  state: "voided" | "paid" | "settled" | "in_flight" | "none";
  amount: string | null;
  closed: string | null;
  unclosed: string | null;
};

// The visit is canceled: its open invoice goes too, the way Cancel booking
// closes the booking's own (closeProviderObject reads the Stripe invoice back
// first; one Stripe shows paid is recorded as paid and left alone). Queued
// issue and pay link jobs for it are retired so nothing goes out after.
export async function voidVisitInvoice(invoiceId: string, actor: string, reason: string): Promise<VisitVoidResult> {
  const d = db();
  const inv = await d.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId) });
  const none: VisitVoidResult = { state: "none", amount: null, closed: null, unclosed: null };
  if (!inv) return none;
  const amount = inv.amountCents != null ? fmtDollars(inv.amountCents) : null;
  if (isPaid(inv.status)) return { ...none, state: "paid", amount };
  if (inv.status === "processing" || inv.status === "review") return { ...none, state: "in_flight", amount };
  if (!(VOIDABLE as string[]).includes(inv.status)) return { ...none, amount };
  let closed: string | null = null;
  let unclosed: string | null = null;
  if (inv.providerId) {
    const c = await closeProviderObject(inv, "admin");
    if (c.paidAtProvider) return { ...none, state: "settled", amount };
    closed = c.closed;
    unclosed = c.unclosed;
  }
  const now = new Date();
  await d
    .update(schema.jobs)
    .set({ status: "done", doneAt: now, leaseUntil: null, lastError: `skipped: ${reason}`, updatedAt: now })
    .where(and(eq(schema.jobs.env, currentEnv()), eq(schema.jobs.status, "queued"), inArray(schema.jobs.kind, ["stripe.invoice.create", "email.pay_link"]), eq(schema.jobs.invoiceId, inv.id)));
  const t = await transitionInvoice(inv.id, "void", {
    from: VOIDABLE,
    lastEvent: { type: "visit.canceled", at: now.toISOString(), by: actor, closed },
    activity: { action: "invoice.voided", actorEmail: actor, meta: { provider: inv.provider, reason, closed, visitId: inv.meta?.visitId ?? null } },
  });
  if (!t.changed) return { ...none, amount, unclosed };
  const line = await payLineFor(inv.id);
  if (line) {
    const spec: JobSpec = { kind: "slack.payment", idempotencyKey: `slack.payment:visit_invoice_voided:${inv.id}`, invoiceId: inv.id, bookingId: inv.bookingId, listingId: inv.listingId, payload: { version: inv.idempotencyVersion, text: paymentsText.visitInvoiceVoided({ ...line, by: actor, kindLabel: String(inv.meta?.visitKind ?? "second shoot"), closed }) } };
    await enqueueJobs([spec]);
  }
  return { state: "voided", amount, closed, unclosed };
}

// The booking was canceled (Cancel booking or the status control): every
// visit canceled with it (or earlier) whose invoice is still open has it
// voided. A done visit's invoice stays: the trip happened. Never throws.
export async function voidVisitInvoicesForCanceledVisits(bookingId: string, actor: string): Promise<{ voided: number; paid: number; inFlight: number }> {
  const out = { voided: 0, paid: 0, inFlight: 0 };
  if (!hasDb()) return out;
  try {
    const rows = await db().query.bookingVisits.findMany({ where: and(eq(schema.bookingVisits.bookingId, bookingId), eq(schema.bookingVisits.status, "canceled"), isNotNull(schema.bookingVisits.invoiceId)), columns: { invoiceId: true } });
    for (const r of rows) {
      if (!r.invoiceId) continue;
      const v = await voidVisitInvoice(r.invoiceId, actor, "booking canceled");
      if (v.state === "voided") out.voided++;
      else if (v.state === "paid" || v.state === "settled") out.paid++;
      else if (v.state === "in_flight") out.inFlight++;
    }
  } catch (e) {
    console.error("[visit-invoice] void with the booking failed", e instanceof Error ? e.message : e);
  }
  return out;
}

export function toAdminBookingInvoice(i: typeof schema.invoices.$inferSelect): AdminBookingInvoice {
  return {
    id: i.id,
    status: i.status,
    amountCents: i.amountCents ?? i.amountDue,
    provider: i.provider ?? (i.stripeInvoiceId ? "stripe" : null),
    providerId: i.providerId ?? i.stripeInvoiceId,
    hostedUrl: i.hostedUrl ?? i.hostedInvoiceUrl,
    method: i.method,
    paidAt: i.paidAt?.toISOString() ?? null,
    refundedCents: i.refundedCents,
    description: i.description,
    lineItems: i.lineItems ?? [],
    idempotencyVersion: i.idempotencyVersion,
    lastEvent: i.lastEvent ?? null,
    lastCheckedAt: i.lastCheckedAt?.toISOString() ?? null,
    meta: i.meta ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}

// Every second shoot invoice on a booking, oldest first (the booking page's
// visit rows and its Invoice area). Never throws: the page still renders.
export async function visitInvoicesForBooking(bookingId: string): Promise<AdminBookingInvoice[]> {
  if (!hasDb()) return [];
  try {
    const rows = await db().query.invoices.findMany({ where: eq(schema.invoices.bookingId, bookingId), orderBy: [asc(schema.invoices.createdAt)] });
    return rows.filter((r) => isVisitInvoice(r.meta)).map(toAdminBookingInvoice);
  } catch (e) {
    console.error("[visit-invoice] read failed", e instanceof Error ? e.message : e);
    return [];
  }
}
