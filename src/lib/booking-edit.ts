// Edit a booking after it comes in (Oct 21 2026): services and
// add-ons, the custom request, square footage, the property fields, access
// notes, the launch date, the client's name, phone and company, and the
// additional details, in one form on /admin/bookings/<id>. Date and time stay
// with Confirm time / Reschedule.
//
// The invoice follows the services and add-ons (the owner's rules, verbatim
// intent): "If someone changes the services or adds add-ons in the backend,
// it automatically updates the invoice and voids the previous one, sending
// the client a new invoice. If an invoice was already sent and paid by the
// client, a new invoice only with that add-on line item is created." So,
// with the quote recomputed from the price table like the intake does:
//   - not paid, provider stripe or titus (open, draft, uncollectible): the
//     invoice is REISSUED in place like Set amount's reissue: the provider
//     object is closed (closeProviderObject: a Stripe invoice voided, a draft
//     deleted, a Titus checkout canceled; one the provider shows paid wins
//     and the edit falls through to the paid rule), the row keeps its id and
//     gets idempotency_version + 1 and the old provider id in
//     meta.replacedProviderIds, the create job issues the new object and the
//     booking email goes out in "updated" mode with the new pay link;
//   - the new quote needs a human (a quoted size or item, a travel fee to confirm, a per
//     image add-on, nothing priced): the provider object is closed and the
//     invoice waits as needs_quote for Set amount; a needs_quote invoice
//     stays needs_quote with its items refreshed;
//   - pay another way (no provider): the amount is updated, nothing is
//     issued, the updated booking email goes out;
//   - PAID (paid, paid_manual), or a payment in flight (processing, review:
//     a pay at close application or a bank transfer is never canceled from
//     an edit): the invoice is untouched and a NEW "addon" invoice is made
//     for the difference, with the added items as its lines (Stripe card
//     invoice; a pay another way booking gets a provider-less row), linked
//     to the booking (bookings.invoice_id stays; the new row has booking_id)
//     and emailed as "Your added items" with its own pay link. Items removed
//     from a paid booking are never refunded from here: "Refund the
//     difference by hand" (activity, the payments channel, the banner).
//     Additions and removals in the same edit are netted (the client owes
//     the difference, or is owed it by hand). An add-on invoice never locks
//     or unlocks the gallery (src/lib/payments.ts): the booking's own
//     invoice governs the lock.
// Every price difference is worked out between the OLD and the NEW quote of
// the price table (never against what was paid), so a hand-set discount on
// the original invoice is kept and only the change is billed.
//
// planInvoiceChange() is pure (scripts/check-booking-edit.ts checks it on
// sample invoice states); applyBookingEdit() does the writes. Money appears
// in the admin banner, the activity meta and the payments channel only.
import { randomUUID } from "node:crypto";
import { and, asc, eq, ne } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { BookingProperty, InvoiceLineItem, InvoiceMeta, InvoiceStatus } from "@/db/schema";
import { logActivity } from "./activity";
import { ADDONS, bookingExtra, fmtDollars, isSizeId, PRICING_VERSION, quote, type Quote, type Selection, SERVICES, SIZES } from "./studio-pricing";
import { toYmd } from "./booking-time";
import { currentEnv, enqueueJobs, jobKey, type JobSpec } from "./jobs-core";
import { closeProviderObject, isOtherEnv, isPaid, payLineFor, rowEnv } from "./payments";
import { isPaidAnotherWay, payOtherPhrase } from "./pay-other";
import { paymentsText } from "./slack";
import type { AdminBookingInvoice } from "./admin-types";

// ---- The form -----------------------------------------------------------------

export type EditProperty = {
  status: string | null;
  listingType: string | null;
  offMarket: string | null;
  listingAgreement: string | null;
  viewHome: string | null;
  views: string[];
  homeownerHome: string | null;
  videoStyle: string | null;
  musicLink: string | null;
};

export type EditInput = {
  serviceIds: string[]; // the home's size first, then the package or service
  addonIds: string[];
  items: Selection[]; // services and add-ons with quantities
  customRequest: string | null;
  sqft: number | null;
  property: EditProperty;
  accessNotes: string | null;
  launchDate: string | null; // YYYY-MM-DD
  clientNotes: string | null; // the form's "Additional details"
  client: { name: string | null; phone: string | null; company: string | null };
};

const DETAILS_MAX = 4000;
const TEXT_MAX = 2000;

const trimTo = (v: string | null, max: number) => (v ? v.slice(0, max) : null);

// The edit form as the panel posts it (src/components/admin/EditBookingPanel.tsx).
export function editInputFromForm(f: FormData): EditInput {
  const str = (k: string): string | null => String(f.get(k) ?? "").trim() || null;
  const list = (k: string): string[] => f.getAll(k).map((v) => String(v).trim()).filter(Boolean);
  const yn = (k: string): string | null => {
    const v = str(k);
    return v === "Yes" || v === "No" ? v : null;
  };
  const size = str("size");
  const services = [...new Set(list("services").filter((id) => SERVICES.some((s) => s.id === id)))];
  const serviceIds = [...(size && SIZES.some((s) => s.id === size) ? [size] : []), ...services];
  const addonIds = [...new Set(list("addons").filter((id) => ADDONS.some((a) => a.id === id)))];
  // Counted items (per image, per clip) carry their quantity as qty_<id>.
  const qtyOf = (id: string): number => {
    const n = Math.floor(Number(str(`qty_${id}`) ?? "1"));
    return Number.isFinite(n) && n >= 1 ? n : 1;
  };
  const items: Selection[] = [...services, ...addonIds].map((id) => ({ id, qty: qtyOf(id) }));
  const sqftRaw = (str("sqft") ?? "").replace(/[^0-9.]/g, "");
  const sqftN = sqftRaw ? Math.round(Number(sqftRaw)) : NaN;
  const views = (str("views") ?? "").split(/[,;\n]/).map((v) => v.trim()).filter(Boolean);
  const viewHome = yn("viewHome") ?? (views.length ? "Yes" : null);
  return {
    serviceIds,
    addonIds,
    items,
    customRequest: trimTo(str("customRequest"), TEXT_MAX),
    sqft: Number.isFinite(sqftN) && sqftN > 0 ? sqftN : null,
    property: {
      status: trimTo(str("pStatus"), 120),
      listingType: trimTo(str("pListingType"), 120),
      offMarket: yn("pOffMarket"),
      listingAgreement: yn("pListingAgreement"),
      viewHome,
      views,
      homeownerHome: yn("pHomeownerHome"),
      videoStyle: trimTo(str("pVideoStyle"), 120),
      musicLink: trimTo(str("pMusicLink"), 500),
    },
    accessNotes: trimTo(str("accessNotes"), TEXT_MAX),
    launchDate: toYmd(str("launchDate")),
    clientNotes: trimTo(str("clientNotes"), DETAILS_MAX),
    client: { name: trimTo(str("clientName"), 200), phone: trimTo(str("clientPhone"), 60), company: trimTo(str("clientCompany"), 200) },
  };
}

// ---- What changed -------------------------------------------------------------

type BookingFields = {
  serviceIds: string[] | null;
  addonIds: string[] | null;
  items?: Selection[] | null;
  customRequest: string | null;
  sqft: number | null;
  property: Record<string, unknown> | null;
  accessNotes: string | null;
  launchDate: string | null;
  clientNotes: string | null;
};
type ClientFields = { name: string | null; phone: string | null; company: string | null };

export type EditDiff = { changed: string[]; priceChanged: boolean; clientChanged: string[] };

const sameList = (a: string[] | null | undefined, b: string[] | null | undefined) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
const norm = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const normList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : typeof v === "string" && v.trim() ? v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean) : []);

const PROPERTY_FIELDS: [keyof EditProperty, string][] = [
  ["status", "property status"],
  ["listingType", "listing type"],
  ["offMarket", "off market"],
  ["listingAgreement", "listing agreement"],
  ["viewHome", "view home"],
  ["views", "views"],
  ["homeownerHome", "homeowner home"],
  ["videoStyle", "video style"],
  ["musicLink", "music link"],
];

export function diffEdit(prev: BookingFields, client: ClientFields, input: EditInput): EditDiff {
  const changed: string[] = [];
  if (!sameList(prev.serviceIds, input.serviceIds)) changed.push("services");
  if (!sameList(prev.addonIds, input.addonIds)) changed.push("add-ons");
  const qtys = (l: Selection[] | null | undefined) => JSON.stringify((l ?? []).filter((i) => (i.qty ?? 1) > 1).map((i) => `${i.id}:${i.qty}`).sort());
  if (qtys(prev.items) !== qtys(input.items)) changed.push("quantities");
  if (norm(prev.customRequest) !== input.customRequest) changed.push("custom request");
  if ((prev.sqft ?? null) !== input.sqft) changed.push("square footage");
  const p = prev.property ?? {};
  for (const [key, label] of PROPERTY_FIELDS) {
    const before = key === "views" ? normList(p.views) : norm(p[key]);
    const after = key === "views" ? input.property.views : input.property[key];
    if (key === "views" ? !sameList(before as string[], after as string[]) : before !== after) changed.push(label);
  }
  if (norm(prev.accessNotes) !== input.accessNotes) changed.push("access notes");
  if ((prev.launchDate ?? null) !== input.launchDate) changed.push("launch date");
  if (norm(prev.clientNotes) !== input.clientNotes) changed.push("additional details");
  const clientChanged: string[] = [];
  if (norm(client.name) !== input.client.name) clientChanged.push("name");
  if (norm(client.phone) !== input.client.phone) clientChanged.push("phone");
  if (norm(client.company) !== input.client.company) clientChanged.push("company");
  for (const c of clientChanged) changed.push(`client ${c}`);
  return { changed, priceChanged: changed.includes("services") || changed.includes("add-ons") || changed.includes("quantities") || changed.includes("square footage"), clientChanged };
}

// ---- The invoice plan (pure) --------------------------------------------------

export type PlanInvoice = {
  status: string;
  provider: string | null;
  providerId: string | null;
  amountCents: number | null;
  lineItems: InvoiceLineItem[] | null;
  method: string | null;
  meta: InvoiceMeta | null;
};

export type InvoicePlan =
  | { kind: "none"; reason: string }
  // A needs_quote invoice stays needs_quote with its items refreshed; Set amount issues it.
  | { kind: "update_quote"; lines: InvoiceLineItem[]; amountCents: number; reasons: string[] }
  // An open invoice whose new quote needs a human: the provider object is closed, the row waits as needs_quote.
  | { kind: "to_quote"; lines: InvoiceLineItem[]; amountCents: number; reasons: string[]; close: boolean }
  // An unpaid Stripe or Titus invoice: reissued in place at the new amount.
  | { kind: "reissue"; provider: "stripe" | "titus"; lines: InvoiceLineItem[]; amountCents: number; close: boolean }
  // Pay another way: the amount moves, nothing is issued.
  | { kind: "update_other"; lines: InvoiceLineItem[]; amountCents: number }
  // Paid (or a payment in flight): a new invoice for the difference, the added items as its lines.
  | { kind: "addon"; provider: "stripe" | null; method: "card" | "other"; lines: InvoiceLineItem[]; amountCents: number; needsQuote: boolean; added: string[]; removed: string[]; inFlight: boolean }
  // Paid, and the change lowers the price: nobody refunds from here.
  | { kind: "refund_by_hand"; cents: number; added: string[]; removed: string[]; inFlight: boolean }
  // Paid, and the additions and removals balance out.
  | { kind: "balanced"; added: string[]; removed: string[]; inFlight: boolean };

// Why a quote needs a human (the intake's reasons, minus the website ones).
export function needsQuoteReasons(q: Quote): string[] {
  // The price table's own words (a quoted size or item, a travel fee to
  // confirm), then an empty or unpriced booking.
  const reasons: string[] = [...q.reasons];
  if (!q.lineItems.length) reasons.push("no services chosen");
  if (!reasons.length && q.totalCents <= 0) reasons.push("nothing priced");
  return reasons;
}

// Priced lines stay when the amount covers them and the difference is one
// quoted line; an amount below them (a discount) is a single line.
function quotedLines(priced: InvoiceLineItem[], cents: number, label = "Quoted items"): InvoiceLineItem[] {
  const lines = priced.filter((l) => l.priced && l.cents > 0);
  const sum = lines.reduce((n, l) => n + l.cents, 0);
  if (lines.length && cents === sum) return lines;
  if (lines.length && cents > sum) return [...lines, { id: "quote", name: label, cents: cents - sum, priced: true }];
  return [{ id: "quote", name: label, cents, priced: true }];
}

// The new amount of an unpaid invoice: the new quote, unless the invoice was
// set by hand (its amount is not the old quote), in which case the hand-set
// amount moves by the difference between the two quotes so a discount stays.
function targetAmount(inv: PlanInvoice, oldQ: Quote, newQ: Quote): { cents: number; lines: InvoiceLineItem[]; handSet: boolean } {
  const handSet = inv.amountCents != null && inv.amountCents > 0 && inv.amountCents !== oldQ.totalCents;
  if (!handSet) return { cents: newQ.totalCents, lines: newQ.lineItems, handSet };
  const cents = Math.max(0, (inv.amountCents ?? 0) + (newQ.totalCents - oldQ.totalCents));
  return { cents, lines: quotedLines(newQ.lineItems, cents), handSet };
}

export type LineDiff = { added: InvoiceLineItem[]; unpriced: InvoiceLineItem[]; removed: { name: string; cents: number }[]; addedNames: string[]; removedNames: string[]; net: number };

// Item by item between the old and the new quote (the ids are the price table's).
export function lineDiff(oldQ: Quote, newQ: Quote): LineDiff {
  const added: InvoiceLineItem[] = [];
  const unpriced: InvoiceLineItem[] = [];
  const removed: { name: string; cents: number }[] = [];
  const addedNames: string[] = [];
  const removedNames: string[] = [];
  for (const l of newQ.lineItems) {
    const old = oldQ.lineItems.find((o) => o.id === l.id);
    if (!old) {
      if (l.priced) added.push({ ...l });
      else unpriced.push({ ...l });
      addedNames.push(l.name);
    } else if (l.priced && old.priced && l.cents > old.cents) {
      added.push({ id: `${l.id}-difference`, name: `${l.name} (difference)`, cents: l.cents - old.cents, priced: true });
      addedNames.push(`${l.name} (difference)`);
    } else if (l.priced && old.priced && l.cents < old.cents) {
      removed.push({ name: `${l.name} (difference)`, cents: old.cents - l.cents });
      removedNames.push(`${l.name} (difference)`);
    }
  }
  for (const o of oldQ.lineItems) {
    if (newQ.lineItems.some((l) => l.id === o.id)) continue;
    if (o.priced && o.cents > 0) removed.push({ name: o.name, cents: o.cents });
    removedNames.push(o.name);
  }
  const net = added.reduce((n, l) => n + l.cents, 0) - removed.reduce((n, l) => n + l.cents, 0);
  return { added, unpriced, removed, addedNames, removedNames, net };
}

const IN_FLIGHT: string[] = ["processing", "review"];
const DEAD: string[] = ["void", "canceled", "refunded"];

export function planInvoiceChange(p: { invoice: PlanInvoice | null; oldQuote: Quote; newQuote: Quote; priceChanged: boolean }): InvoicePlan {
  const inv = p.invoice;
  if (!inv) return { kind: "none", reason: "There is no invoice on this booking." };
  if (!p.priceChanged) return { kind: "none", reason: `Nothing that changes the price was edited, so the invoice stands${inv.amountCents ? ` at ${fmtDollars(inv.amountCents)}` : ""}.` };
  const s = inv.status;
  if (isPaid(s) || IN_FLIGHT.includes(s)) {
    const inFlight = !isPaid(s);
    const d = lineDiff(p.oldQuote, p.newQuote);
    if (d.net > 0 || d.unpriced.length) {
      const other = isPaidAnotherWay(inv);
      const lines: InvoiceLineItem[] =
        d.removed.length && d.net > 0
          ? [{ id: "changes", name: `Changes to your shoot: ${d.addedNames.join(", ")} added; ${d.removedNames.join(", ")} removed`, cents: d.net, priced: true }, ...d.unpriced]
          : [...(d.net > 0 ? d.added : []), ...d.unpriced];
      return { kind: "addon", provider: other ? null : "stripe", method: other ? "other" : "card", lines, amountCents: Math.max(0, d.net), needsQuote: d.unpriced.length > 0 || d.net < 100, added: d.addedNames, removed: d.removedNames, inFlight };
    }
    if (d.net < 0) return { kind: "refund_by_hand", cents: -d.net, added: d.addedNames, removed: d.removedNames, inFlight };
    if (!d.addedNames.length && !d.removedNames.length) return { kind: "none", reason: `The price did not change, so the ${inFlight ? "payment in flight" : "paid invoice"} stands.` };
    return { kind: "balanced", added: d.addedNames, removed: d.removedNames, inFlight };
  }
  if (DEAD.includes(s)) return { kind: "none", reason: `The invoice is ${s}; it was left alone.` };
  const reasons = needsQuoteReasons(p.newQuote);
  if (s === "needs_quote") return { kind: "update_quote", lines: p.newQuote.lineItems, amountCents: p.newQuote.totalCents, reasons };
  // open | draft | uncollectible
  const target = targetAmount(inv, p.oldQuote, p.newQuote);
  const close = Boolean(inv.providerId);
  if (reasons.length) return { kind: "to_quote", lines: p.newQuote.lineItems, amountCents: p.newQuote.totalCents, reasons, close };
  if (target.cents < 100) return { kind: "to_quote", lines: target.lines, amountCents: target.cents, reasons: ["amount below $1"], close };
  if (isPaidAnotherWay(inv)) return { kind: "update_other", lines: target.lines, amountCents: target.cents };
  const provider = inv.provider === "titus" ? "titus" : "stripe";
  if (provider === "titus" && target.cents > 50_000 * 100) return { kind: "to_quote", lines: target.lines, amountCents: target.cents, reasons: ["over the pay at close limit of $50,000; switch to card"], close };
  return { kind: "reissue", provider, lines: target.lines, amountCents: target.cents, close };
}

// ---- Applying it ---------------------------------------------------------------

export type EditOutcome = { ok: true; message: string } | { ok: false; error: string };

type InvoiceRow = typeof schema.invoices.$inferSelect;
type BookingRow = typeof schema.bookings.$inferSelect & {
  listing: { id: string; address: string; nda: boolean; slug: string } | null;
  client: typeof schema.clients.$inferSelect | null;
  invoice: InvoiceRow | null;
};

type InvoiceResult = { note: string; email: JobSpec | null; specs: JobSpec[] };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const providerObject = (provider: string | null | undefined) => (provider === "titus" ? "pay at close checkout" : "Stripe invoice");
const plural = (items: string[]) => items.join(", ");

function bookingEmailSpec(b: BookingRow, version: number): JobSpec {
  return { kind: "email.booking", idempotencyKey: jobKey("email.booking", b.id, version), bookingId: b.id, listingId: b.listingId, invoiceId: b.invoiceId, payload: { version, updated: true } };
}

// Runs the plan against the invoice. `version` is the booking's new calendar
// version (the updated booking email's key). Never throws for a provider
// refusal: the invoice is left as it is and the note says so.
async function applyInvoicePlan(b: BookingRow, inv: InvoiceRow | null, plan: InvoicePlan, actor: string, version: number, newQ: Quote): Promise<InvoiceResult> {
  const d = db();
  const now = new Date();
  const base = inv ? { invoiceId: inv.id, bookingId: b.id, listingId: b.listingId } : { bookingId: b.id, listingId: b.listingId };
  const street = (b.listing?.address ?? String(b.property?.street ?? "the property")).split(",")[0].trim();
  const metaBase = (m: InvoiceMeta | null): InvoiceMeta => ({ ...(m ?? {}), pricingVersion: PRICING_VERSION, tier: newQ.tier, computedTotalCents: newQ.totalCents, pending: newQ.pending, inquire: newQ.inquire, editedBy: actor, editedAt: now.toISOString() });

  switch (plan.kind) {
    case "none":
      return { note: plan.reason, email: null, specs: [] };

    case "update_quote": {
      if (!inv) return { note: "There is no invoice on this booking.", email: null, specs: [] };
      await d
        .update(schema.invoices)
        .set({ amountCents: plan.amountCents, amountDue: plan.amountCents, lineItems: plan.lines, description: `${street}${newQ.servicesLabel ? ` · ${newQ.servicesLabel}` : ""}`, meta: { ...metaBase(inv.meta), previousAmountCents: inv.amountCents, note: `edited by ${actor}${plan.reasons.length ? `: ${plan.reasons.join("; ")}` : ""}; set the amount to issue it` }, updatedAt: now })
        .where(eq(schema.invoices.id, inv.id));
      await logActivity({ actorEmail: actor, action: "invoice.needs_quote", listingId: b.listingId, clientId: b.clientId, meta: { invoiceId: inv.id, reason: plan.reasons.join("; ") || "items updated by an edit", provider: inv.provider, via: "edit", amountCents: plan.amountCents } });
      const why = plan.reasons.length ? ` (${plan.reasons.join("; ")})` : ` (the price table says ${fmtDollars(plan.amountCents)})`;
      return { note: `The invoice is still waiting for a quote; its items were updated${why}. Use Set amount to issue it and send the pay link. The client gets the updated booking email.`, email: bookingEmailSpec(b, version), specs: [] };
    }

    case "to_quote":
    case "reissue": {
      if (!inv) return { note: "There is no invoice on this booking.", email: null, specs: [] };
      let closed: string | null = null;
      let unclosed = "";
      if (plan.close) {
        try {
          const c = await closeProviderObject(inv, "admin");
          if (c.paidAtProvider) {
            // The provider shows it paid: that payment wins, and the edit bills
            // the added items like any paid invoice.
            const fresh = await d.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.id) });
            const paidPlan = planInvoiceChange({ invoice: fresh ?? { ...inv, status: "paid" }, oldQuote: quote(b.serviceIds ?? [], b.addonIds ?? [], bookingExtra(b)), newQuote: newQ, priceChanged: true });
            const r = await applyInvoicePlan(b, fresh ?? inv, paidPlan, actor, version, newQ);
            return { ...r, note: `${providerObject(inv.provider)} shows this invoice paid, so it was recorded as paid and not reissued.${c.paidAtProvider.unlocked ? " Downloads are unlocked." : ""} ${r.note}` };
          }
          closed = c.closed;
          unclosed = c.unclosed ? ` ${c.unclosed}` : "";
        } catch (e) {
          // Titus refuses to cancel a checkout mid application, or Stripe is
          // unreachable: the invoice stays as it is and the admin decides.
          await d
            .update(schema.invoices)
            .set({ meta: { ...(inv.meta ?? {}), revisedAfterIssue: true, previousAmountCents: inv.amountCents, requestedAmountCents: plan.amountCents, note: `booking edited by ${actor}, but the ${providerObject(inv.provider)} could not be closed: ${errText(e).slice(0, 200)}` }, updatedAt: now })
            .where(eq(schema.invoices.id, inv.id));
          return { note: `The ${providerObject(inv.provider)} could not be closed (${errText(e).slice(0, 160)}), so the invoice was left at ${inv.amountCents ? fmtDollars(inv.amountCents) : "its amount"}. Set the amount to reissue it at ${fmtDollars(plan.amountCents)}. The client was not emailed.`, email: null, specs: [] };
        }
      }
      const reissue = plan.kind === "reissue";
      const status: InvoiceStatus = reissue ? "open" : "needs_quote";
      const nextVersion = inv.idempotencyVersion + 1;
      await d
        .update(schema.invoices)
        .set({
          status,
          amountCents: plan.amountCents,
          amountDue: plan.amountCents,
          lineItems: plan.lines,
          description: `${street}${newQ.servicesLabel ? ` · ${newQ.servicesLabel}` : ""}`,
          idempotencyVersion: nextVersion,
          providerId: null,
          hostedUrl: null,
          hostedInvoiceUrl: null,
          stripeInvoiceId: null,
          orderId: null,
          lastEvent: { type: reissue ? "reissued" : "edited_to_quote", at: now.toISOString(), by: actor, reason: "booking edited", closed, previousProviderId: inv.providerId, previousAmountCents: inv.amountCents },
          lastCheckedAt: now,
          meta: {
            ...metaBase(inv.meta),
            previousAmountCents: inv.amountCents,
            revisedAfterIssue: false,
            replacedProviderIds: [...(inv.meta?.replacedProviderIds ?? []), ...(inv.providerId ? [inv.providerId] : [])],
            note: reissue ? `reissued after a booking edit by ${actor}` : `edited by ${actor}: ${plan.reasons.join("; ")}; set the amount to issue it`,
          },
          updatedAt: now,
        })
        .where(eq(schema.invoices.id, inv.id));
      const line = await payLineFor(inv.id);
      const previous = inv.amountCents ? fmtDollars(inv.amountCents) : null;
      if (reissue) {
        await logActivity({ actorEmail: actor, action: "invoice.amount_set", listingId: b.listingId, clientId: b.clientId, meta: { invoiceId: inv.id, amountCents: plan.amountCents, previousAmountCents: inv.amountCents, provider: plan.provider, lines: plan.lines.length, version: nextVersion, reissued: plan.close, closed, via: "edit" } });
        const kind = plan.provider === "titus" ? "titus.checkout.create" : "stripe.invoice.create";
        // The create job first, then the updated booking email (separate
        // inserts: same run_at, earlier created_at), which waits for the
        // hosted link before it goes.
        await enqueueJobs([{ kind, idempotencyKey: jobKey(kind, inv.id, nextVersion), ...base, payload: { version: nextVersion, invoiceId: inv.id } }]);
        const specs: JobSpec[] = line ? [{ kind: "slack.payment", idempotencyKey: `slack.payment:edited:${inv.id}:v${nextVersion}`, ...base, payload: { version: nextVersion, text: paymentsText.editedReissued({ ...line, by: actor, closed, previous }) } }] : [];
        return {
          note: `Invoice ${plan.close ? "reissued" : "updated"} at ${fmtDollars(plan.amountCents)}${previous ? ` (was ${previous})` : ""}: ${closed ? `the previous ${closed} was closed and ` : ""}the ${providerObject(plan.provider)} is being issued; the updated booking email with the new pay link goes out next.${unclosed}`,
          email: bookingEmailSpec(b, version),
          specs,
        };
      }
      await logActivity({ actorEmail: actor, action: "invoice.needs_quote", listingId: b.listingId, clientId: b.clientId, meta: { invoiceId: inv.id, reason: plan.reasons.join("; "), provider: inv.provider, via: "edit", closed, previousAmountCents: inv.amountCents } });
      const specs: JobSpec[] = line ? [{ kind: "slack.payment", idempotencyKey: `slack.payment:edited_quote:${inv.id}:v${nextVersion}`, ...base, payload: { version: nextVersion, text: paymentsText.editedToQuote({ ...line, by: actor, closed }) } }] : [];
      return {
        note: `The new items need a quote (${plan.reasons.join("; ")}): ${closed ? `the previous ${closed} was closed and ` : ""}the invoice waits for an amount. Use Set amount to issue it and send the pay link. The client gets the updated booking email.${unclosed}`,
        email: bookingEmailSpec(b, version),
        specs,
      };
    }

    case "update_other": {
      if (!inv) return { note: "There is no invoice on this booking.", email: null, specs: [] };
      await d
        .update(schema.invoices)
        .set({ amountCents: plan.amountCents, amountDue: plan.amountCents, lineItems: plan.lines, description: `${street}${newQ.servicesLabel ? ` · ${newQ.servicesLabel}` : ""}`, meta: { ...metaBase(inv.meta), previousAmountCents: inv.amountCents, note: `amount updated after a booking edit by ${actor}` }, updatedAt: now })
        .where(eq(schema.invoices.id, inv.id));
      await logActivity({ actorEmail: actor, action: "invoice.amount_set", listingId: b.listingId, clientId: b.clientId, meta: { invoiceId: inv.id, amountCents: plan.amountCents, previousAmountCents: inv.amountCents, provider: null, lines: plan.lines.length, version: inv.idempotencyVersion, reissued: false, closed: null, via: "edit" } });
      const line = await payLineFor(inv.id);
      const previous = inv.amountCents ? fmtDollars(inv.amountCents) : null;
      const specs: JobSpec[] = line ? [{ kind: "slack.payment", idempotencyKey: `slack.payment:edited_other:${inv.id}:${now.getTime()}`, ...base, payload: { version: inv.idempotencyVersion, text: paymentsText.editedAmount({ ...line, by: actor, previous }) } }] : [];
      return {
        note: `Amount updated to ${fmtDollars(plan.amountCents)}${previous ? ` (was ${previous})` : ""}. This booking pays ${payOtherPhrase(b.paymentDetail)}, so nothing is issued and no pay link goes out; the client gets the updated booking email. Mark it paid when the payment arrives.`,
        email: bookingEmailSpec(b, version),
        specs,
      };
    }

    case "addon": {
      if (!inv) return { note: "There is no invoice on this booking.", email: null, specs: [] };
      const id = randomUUID();
      const items = plural(plan.added);
      const description = `${street} · added items`;
      await d.insert(schema.invoices).values({
        id,
        listingId: b.listingId,
        clientId: b.clientId,
        clientEmail: b.client?.email ?? inv.clientEmail,
        propertyAddress: inv.propertyAddress ?? b.listing?.address ?? null,
        status: plan.needsQuote ? "needs_quote" : "open",
        amountDue: plan.amountCents,
        amountCents: plan.amountCents,
        currency: "usd",
        provider: plan.provider,
        method: plan.method,
        description,
        lineItems: plan.lines,
        meta: {
          pricingVersion: PRICING_VERSION,
          tier: newQ.tier,
          computedTotalCents: plan.amountCents,
          pending: plan.needsQuote,
          invoiceType: "addon",
          addonOf: inv.id,
          addedItems: plan.added,
          removedItems: plan.removed,
          editedBy: actor,
          editedAt: now.toISOString(),
          note: `${plan.inFlight ? "payment in flight on" : "added after"} the paid invoice ${inv.id}: ${items}${plan.removed.length ? `; removed: ${plural(plan.removed)} (netted)` : ""}${plan.needsQuote ? "; set the amount to issue it" : ""}${plan.method === "other" ? `; paid ${payOtherPhrase(b.paymentDetail)}, no pay link; mark it paid when it arrives` : ""}`,
        },
        bookingId: b.id,
        idempotencyVersion: 1,
        env: currentEnv(),
        updatedAt: now,
      });
      await logActivity({ actorEmail: actor, action: "invoice.addon_created", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, invoiceId: id, addonOf: inv.id, amountCents: plan.amountCents, items, removed: plan.removed.join(", ") || null, provider: plan.provider, method: plan.method, needsQuote: plan.needsQuote, inFlight: plan.inFlight } });
      const addonBase = { invoiceId: id, bookingId: b.id, listingId: b.listingId };
      let email: JobSpec | null = null;
      if (!plan.needsQuote) {
        // The Stripe invoice first; the "Your added items" email waits for its
        // hosted link. A pay another way booking gets the email with the amount
        // and no button (the job handles that from the row).
        if (plan.provider === "stripe") await enqueueJobs([{ kind: "stripe.invoice.create", idempotencyKey: jobKey("stripe.invoice.create", id, 1), ...addonBase, payload: { version: 1, invoiceId: id } }]);
        email = { kind: "email.pay_link", idempotencyKey: jobKey("email.pay_link", id, 1), ...addonBase, payload: { version: 1, again: false } };
      }
      const line = await payLineFor(id);
      const specs: JobSpec[] = line ? [{ kind: "slack.payment", idempotencyKey: `slack.payment:addon:${id}:v1`, ...addonBase, payload: { version: 1, text: paymentsText.addonInvoice({ ...line, by: actor, items, paidAmount: inv.amountCents ? fmtDollars(inv.amountCents) : null, needsQuote: plan.needsQuote }) } }] : [];
      const stands = plan.inFlight ? `The ${providerObject(inv.provider)} with the payment in flight (${inv.amountCents ? fmtDollars(inv.amountCents) : "its amount"}) was left alone.` : `The paid invoice${inv.amountCents ? ` (${fmtDollars(inv.amountCents)})` : ""} stands.`;
      const how = plan.needsQuote
        ? `A new invoice for ${items} waits for an amount: use Set amount on it below.`
        : plan.method === "other"
          ? `A new ${fmtDollars(plan.amountCents)} invoice for ${items} is on the booking; it is paid ${payOtherPhrase(b.paymentDetail)}, so the client gets the amount by email and no pay link. Mark it paid when the payment arrives.`
          : `A new ${fmtDollars(plan.amountCents)} invoice for ${items} is being issued and the client gets its pay link by email.`;
      const netted = plan.removed.length ? ` ${plural(plan.removed)} removed, netted against the added items; nothing to refund.` : "";
      return { note: `${stands} ${how}${netted}`, email, specs };
    }

    case "refund_by_hand": {
      if (!inv) return { note: "There is no invoice on this booking.", email: null, specs: [] };
      const items = plural(plan.removed);
      await logActivity({ actorEmail: actor, action: "invoice.refund_by_hand", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, invoiceId: inv.id, cents: plan.cents, items, added: plan.added.join(", ") || null, inFlight: plan.inFlight } });
      const line = await payLineFor(inv.id);
      const specs: JobSpec[] = line ? [{ kind: "slack.payment", idempotencyKey: `slack.payment:refund_by_hand:${inv.id}:${now.getTime()}`, ...base, payload: { version: inv.idempotencyVersion, text: paymentsText.refundByHand({ ...line, amount: fmtDollars(plan.cents), by: actor, items }) } }] : [];
      const netted = plan.added.length ? ` (${plural(plan.added)} added, netted against it)` : "";
      return { note: `Refund the difference by hand: ${fmtDollars(plan.cents)} for ${items}${netted}. The ${plan.inFlight ? "payment in flight" : "paid invoice"} is untouched and nothing was refunded from here. The client was not emailed.`, email: null, specs };
    }

    case "balanced":
      return { note: `${plural(plan.added)} added and ${plural(plan.removed)} removed balance out: nothing more is owed and nothing to refund. The ${plan.inFlight ? "payment in flight" : "paid invoice"} is untouched. The client was not emailed.`, email: null, specs: [] };
  }
}

export async function applyBookingEdit(bookingId: string, input: EditInput, actor: string): Promise<EditOutcome> {
  const d = db();
  const b = (await d.query.bookings.findFirst({
    where: eq(schema.bookings.id, bookingId),
    with: { listing: { columns: { id: true, address: true, nda: true, slug: true } }, client: true, invoice: true },
  })) as BookingRow | undefined;
  if (!b) return { ok: false, error: "Booking not found." };
  if (isOtherEnv(b.env)) return { ok: false, error: `This booking belongs to the ${rowEnv(b.env)} environment and is handled there.` };
  if (b.status === "canceled") return { ok: false, error: "This booking is canceled. Restore it first, then edit it." };
  if (!b.client) return { ok: false, error: "This booking has no client." };
  if (!input.serviceIds.some((id) => !isSizeId(id)) && !input.addonIds.length) return { ok: false, error: "Pick at least one service." };
  const diff = diffEdit(b, b.client, input);
  if (!diff.changed.length) return { ok: true, message: "Nothing changed." };

  const oldQ = quote(b.serviceIds ?? [], b.addonIds ?? [], bookingExtra(b));
  const newQ = quote(input.serviceIds, input.addonIds, { items: input.items, clientType: b.clientType, area: b.market });
  const now = new Date();
  const version = b.calendarVersion + 1;

  // 1. The client's contact.
  if (diff.clientChanged.length) {
    await d.update(schema.clients).set({ name: input.client.name, phone: input.client.phone, company: input.client.company }).where(eq(schema.clients.id, b.client.id));
    await logActivity({ actorEmail: actor, action: "client.updated", clientId: b.client.id, listingId: b.listingId, meta: { to: b.client.email, changed: diff.clientChanged, via: "booking" } });
  }

  // 2. The booking. The street, city, state and zip stay as the form sent
  //    them; the duration follows the services when a time is confirmed.
  const prev = (b.property ?? {}) as BookingProperty;
  const property: BookingProperty = {
    ...prev,
    street: prev.street ?? (b.listing?.address ?? "").split(",")[0].trim(),
    status: input.property.status,
    listingType: input.property.listingType,
    offMarket: input.property.offMarket,
    listingAgreement: input.property.listingAgreement,
    viewHome: input.property.viewHome,
    views: input.property.views,
    homeownerHome: input.property.homeownerHome,
    videoStyle: input.property.videoStyle,
    musicLink: input.property.musicLink,
  };
  await d
    .update(schema.bookings)
    .set({
      serviceIds: input.serviceIds,
      addonIds: input.addonIds,
      items: newQ.items,
      servicesLabel: newQ.servicesLabel || null,
      customRequest: input.customRequest,
      sqft: input.sqft,
      tier: newQ.tier >= 0 ? newQ.tier : null,
      property,
      accessNotes: input.accessNotes,
      launchDate: input.launchDate,
      clientNotes: input.clientNotes,
      endsAt: b.startsAt ? new Date(b.startsAt.getTime() + newQ.minutes * 60_000) : b.endsAt,
      calendarVersion: version,
      updatedAt: now,
    })
    .where(eq(schema.bookings.id, b.id));

  // 3. The invoice.
  const plan = planInvoiceChange({ invoice: b.invoice, oldQuote: oldQ, newQuote: newQ, priceChanged: diff.priceChanged });
  let invoice: InvoiceResult;
  try {
    invoice = await applyInvoicePlan(b, b.invoice, plan, actor, version, newQ);
  } catch (e) {
    invoice = { note: `The invoice could not be updated (${errText(e).slice(0, 160)}); review it below. The client was not emailed.`, email: null, specs: [] };
  }

  // 4. The record, the calendar, the team, the client.
  await logActivity({ actorEmail: actor, action: "booking.edited", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, changed: diff.changed.join(", "), version, invoice: plan.kind, priceChanged: diff.priceChanged } });
  await enqueueJobs([
    { kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", b.id, version), bookingId: b.id, listingId: b.listingId, payload: { version } },
    { kind: "slack.booking", idempotencyKey: jobKey("slack.booking", b.id, version), bookingId: b.id, listingId: b.listingId, payload: { version, updated: true } },
    ...invoice.specs,
  ]);
  if (invoice.email) await enqueueJobs([invoice.email]);
  const emailed = Boolean(invoice.email) || /client was not emailed/.test(invoice.note);
  return { ok: true, message: `Saved: ${diff.changed.join(", ")}. ${invoice.note}${emailed ? "" : " The client was not emailed."} The calendar updates next and the bookings channel sees the change.` };
}

// ---- The add-on invoices a booking carries (the panel lists them) ---------------
// Every invoice on the booking other than its own, minus the second shoot
// invoices (Oct 27 2026): those show on their visit and in the Invoice area.

export async function addonInvoicesFor(bookingId: string, primaryInvoiceId: string | null): Promise<AdminBookingInvoice[]> {
  if (!hasDb()) return [];
  const rows = await db().query.invoices.findMany({
    where: primaryInvoiceId ? and(eq(schema.invoices.bookingId, bookingId), ne(schema.invoices.id, primaryInvoiceId)) : eq(schema.invoices.bookingId, bookingId),
    orderBy: [asc(schema.invoices.createdAt)],
  });
  return rows.filter((i) => i.meta?.invoiceType !== "additional_shoot").map((i) => ({
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
  }));
}
