// Payments core (docs/booking-to-payment.md). Every path
// that turns money into an unlocked gallery ends in ONE function:
//
//   applyPaid(invoiceId, …) is a single SQL statement (a CTE): the invoice moves
//   to paid only from a payable status (open | processing | review); the
//   listing unlocks only for the rows that statement returned (never an
//   exclusivity_monthly invoice, never an "addon" invoice (the items added
//   after the booking's invoice was paid, Oct 21 2026) and never an
//   "additional_shoot" invoice (a second shoot's own, Oct 27 2026): those
//   neither lock nor unlock (NON_GATING_INVOICE_TYPES); the booking's own
//   invoice governs the lock, so a refund of one never relocks a paid
//   gallery); the activity rows (invoice.paid,
//   listing.unlocked) are inserted from the same CTE. So a replayed webhook, a
//   late event or a second provider can never re-unlock a listing an admin
//   relocked, and never double-logs. Then it enqueues slack.paid (the
//   payments channel line); a route caller drains it in after(). Receipts are
//   the provider's: Stripe and Titus email their own, the pay page is the
//   in-portal receipt, the studio sends none.
//
//   markPaidManually is the admin path (status paid_manual, same unlock CTE,
//   voids the open Stripe invoice or cancels the open Titus checkout first).
//   relockForRefund: a full refund locks the gallery again; a partial logs and
//   posts to the payments channel only.
//   recordPaymentEvent / markEventProcessed: every webhook delivery is a row in
//   payment_events before anything acts on it; a duplicate with processed_at
//   set is answered 200 at once, one with processed_at NULL is re-processed.
//   syncInvoiceFromProvider: a server-side GET of the Stripe invoice or Titus
//   checkout, throttled to one every 30 s per invoice, used wherever a client is
//   waiting (pay page return, locked gallery load, the 402 branches) and by the
//   15-minute payments.reconcile job. Never unlocks from a redirect.
import type Stripe from "stripe";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { InvoiceMeta, InvoiceMethod, InvoiceProvider, InvoiceStatus } from "@/db/schema";
import { logActivity, type ActivityAction } from "./activity";
import { fmtDollars } from "./studio-pricing";
import { siteUrl } from "./brand";
import { currentEnv, enqueueJobs, jobKey, type JobSpec } from "./jobs-core";
import { NON_GATING_INVOICE_TYPES, gatesGallery } from "./invoice-kinds";
import { isPaidAnotherWay, payOtherWay } from "./pay-other";
import { hubListingName, paymentsText, type PayLine } from "./slack";
import { hasStripe, stripeClient } from "./stripe-invoice";
import { cancelCheckout, getCheckout, hasTitus, TitusApiError, type TitusCheckout } from "./titus";

export const PAYABLE_STATUSES: InvoiceStatus[] = ["open", "processing", "review"];
// What a Stripe invoice.paid may settle: Stripe never pays a draft and still
// takes a payment on an uncollectible invoice, so a paid event on a row we
// hold as draft (events arrive out of order) or uncollectible is real money.
export const STRIPE_PAID_FROM: InvoiceStatus[] = [...PAYABLE_STATUSES, "draft", "uncollectible"];
// What an admin's "Mark paid" may settle: a quote still open, the three payable
// statuses, and uncollectible (Stripe's bad-debt flag; the invoice still takes
// a payment, a check in the mail is one). Checked BEFORE the provider object
// is closed, so a row this cannot move never loses its Stripe invoice.
export const MANUAL_PAID_FROM: InvoiceStatus[] = ["needs_quote", ...PAYABLE_STATUSES, "uncollectible"];
export const PAID_STATUSES: InvoiceStatus[] = ["paid", "paid_manual"];
// Invoices that never move the gallery lock (src/lib/invoice-kinds.ts): paying
// one never unlocks and refunding one never relocks.
export { NON_GATING_INVOICE_TYPES, gatesGallery };
const nonGatingSql = () => sql.join(NON_GATING_INVOICE_TYPES.map((t) => sql`${t}`), sql`, `);
const SYNC_THROTTLE_MS = 30_000;

type InvoiceRow = typeof schema.invoices.$inferSelect;

export function isPayable(status: string | null | undefined): boolean {
  return Boolean(status) && (PAYABLE_STATUSES as string[]).includes(status as string);
}
export function isPaid(status: string | null | undefined): boolean {
  return Boolean(status) && (PAID_STATUSES as string[]).includes(status as string);
}

// One database, two environments. Rows written before `env` existed belong to
// production. Nothing in this environment reads, closes or resets a provider
// object of a row another environment owns: its keys do not own that object
// (a preview's Titus key 404s on a production checkout), and the jobs it would
// enqueue would run here with the wrong keys.
export function rowEnv(env: string | null | undefined): string {
  return env ?? "production";
}
export function isOtherEnv(env: string | null | undefined): boolean {
  return rowEnv(env) !== currentEnv();
}

// How a Slack line names the way it was paid. (A pay another way invoice reads
// its booking's detail instead: "check", "ACH transfer", "cash"; see payLineFor.)
export function paymentMethodLabel(method: string | null | undefined, payNowMethod?: string | null): string {
  if (method === "pay_at_close") return "pay at close";
  if (payNowMethod === "us_bank_account" || payNowMethod === "customer_balance" || payNowMethod === "ach_debit") return "bank transfer";
  if (method === "card" || payNowMethod === "card" || payNowMethod === "link") return "card";
  return "payment";
}

// ---- applyPaid --------------------------------------------------------------

export type PaidInput = {
  provider: InvoiceProvider;
  providerRef: string | null; // the Stripe invoice id or the Titus checkout id
  method: InvoiceMethod;
  payNowMethod?: string | null; // card | us_bank_account | … when cheap to know
  source: string; // webhook | webhook_stale | client_success | gallery_load | pay_page_load | pay_page | download | reconcile | operator | admin
  eventId?: string | null;
  invoiceType?: string | null; // Stripe metadata.invoice_type for rows that have no meta yet
  metaPatch?: Partial<InvoiceMeta>;
};

export type PaidResult = {
  changed: boolean; // the invoice moved to paid in this call
  unlocked: boolean; // the listing moved from locked to unlocked in this call
  listingId: string | null;
  clientId: string | null;
  bookingId: string | null;
  jobs: number; // side-effect jobs enqueued (0 on a replay)
};

// provider null: a pay another way invoice (check, ACH transfer or cash) that an
// admin marks paid; it never had a provider object.
type Settle = Omit<PaidInput, "provider"> & { provider: InvoiceProvider | null; status: "paid" | "paid_manual"; from: InvoiceStatus[]; actor: string | null; note?: string | null };

// The one statement. UPDATE invoices … RETURNING feeds UPDATE listings and the
// INSERT INTO activity through the same CTE, so the three never disagree.
async function settlePaid(invoiceId: string, p: Settle): Promise<PaidResult> {
  const d = db();
  const at = new Date().toISOString();
  const action: ActivityAction = p.status === "paid" ? "invoice.paid" : "invoice.paid_manual";
  const lastEvent = JSON.stringify({ type: action, at, provider: p.provider, providerRef: p.providerRef, source: p.source, eventId: p.eventId ?? null });
  const metaPatch = JSON.stringify({
    ...(p.metaPatch ?? {}),
    ...(p.invoiceType ? { invoiceType: p.invoiceType } : {}),
    ...(p.payNowMethod ? { payNowMethod: p.payNowMethod } : {}),
    ...(p.note ? { paidManualNote: p.note } : {}),
    ...(p.actor && p.status === "paid_manual" ? { paidManualBy: p.actor } : {}),
  });
  const actMeta = JSON.stringify({ invoiceId, provider: p.provider, providerRef: p.providerRef, method: p.method, source: p.source, eventId: p.eventId ?? null, ...(p.note ? { note: p.note } : {}) });
  const unlockMeta = JSON.stringify({ invoiceId, via: "payment", provider: p.provider, source: p.source });
  const from = sql.join(p.from.map((s) => sql`${s}`), sql`, `);
  const res = await d.execute<{ invoices: number; unlocked: number; listing_id: string | null; client_id: string | null; booking_id: string | null }>(sql`
    WITH inv AS (
      UPDATE invoices
         SET status = ${p.status},
             paid_at = COALESCE(paid_at, now()),
             method = ${p.method},
             last_event = ${lastEvent}::jsonb,
             last_checked_at = now(),
             meta = COALESCE(meta, '{}'::jsonb) || ${metaPatch}::jsonb,
             updated_at = now()
       WHERE id = ${invoiceId} AND status IN (${from})
       RETURNING id, listing_id, client_id, booking_id, meta
    ),
    unlock AS (
      UPDATE listings l
         SET download_locked = false
        FROM inv
       WHERE l.id = inv.listing_id
         AND l.download_locked = true
         AND COALESCE(inv.meta->>'invoiceType', 'production') NOT IN (${nonGatingSql()})
       RETURNING l.id
    ),
    act AS (
      INSERT INTO activity (actor_email, action, listing_id, client_id, meta)
      SELECT ${p.actor}::text, ${action}::text, inv.listing_id, inv.client_id, ${actMeta}::jsonb FROM inv
      UNION ALL
      SELECT ${p.actor}::text, 'listing.unlocked'::text, unlock.id, inv.client_id, ${unlockMeta}::jsonb
        FROM unlock JOIN inv ON inv.listing_id = unlock.id
      RETURNING id
    )
    SELECT (SELECT count(*) FROM inv)::int AS invoices,
           (SELECT count(*) FROM unlock)::int AS unlocked,
           (SELECT listing_id FROM inv LIMIT 1) AS listing_id,
           (SELECT client_id FROM inv LIMIT 1) AS client_id,
           (SELECT booking_id FROM inv LIMIT 1) AS booking_id`);
  const row = res.rows[0];
  const changed = Number(row?.invoices ?? 0) > 0;
  const unlocked = Number(row?.unlocked ?? 0) > 0;
  const out: PaidResult = {
    changed,
    unlocked,
    listingId: (row?.listing_id as string | null) ?? null,
    clientId: (row?.client_id as string | null) ?? null,
    bookingId: (row?.booking_id as string | null) ?? null,
    jobs: 0,
  };
  if (!changed) return out;
  // The one side effect of a payment: the line with the amount in the private
  // payments channel. No studio receipt email (Oct 16 2026): Stripe and
  // Titus send theirs, and the pay page shows the paid state.
  const specs: JobSpec[] = [{ kind: "slack.paid", idempotencyKey: jobKey("slack.paid", invoiceId, 1), invoiceId, bookingId: out.bookingId, listingId: out.listingId, payload: { version: 1, invoiceId } }];
  out.jobs = await enqueueJobs(specs);
  return out;
}

// `from` widens the statuses a provider-confirmed payment may settle (Stripe
// passes STRIPE_PAID_FROM); the default is the three payable ones.
export async function applyPaid(invoiceId: string, p: PaidInput & { from?: InvoiceStatus[] }): Promise<PaidResult> {
  const { from, ...rest } = p;
  return settlePaid(invoiceId, { ...rest, status: "paid", from: from ?? PAYABLE_STATUSES, actor: null });
}

// The provider says paid but the row could not move (void, canceled, refunded,
// needs_quote): money changed hands and the gallery stays locked, so the hub
// hears once per status instead of a silent "already void" note. Money-free.
export async function flagUnsettledPaid(invoiceId: string, provider: InvoiceProvider, source: string): Promise<void> {
  const inv = await db().query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { listing: { columns: { address: true, nda: true } } } });
  if (!inv || isPaid(inv.status)) return;
  const name = hubListingName({ address: inv.listing?.address ?? inv.propertyAddress ?? "a listing", nda: inv.listing?.nda ?? false });
  const where = inv.bookingId ? `${siteUrl()}/admin/bookings/${inv.bookingId}` : inv.listingId ? `${siteUrl()}/admin/listings/${inv.listingId}` : `${siteUrl()}/admin`;
  await enqueueJobs([
    {
      kind: "slack.issue",
      idempotencyKey: `slack.issue:unsettled_paid:${inv.id}:${inv.status}`,
      invoiceId: inv.id,
      bookingId: inv.bookingId,
      listingId: inv.listingId,
      payload: { version: 1, note: `${provider === "titus" ? "Titus" : "Stripe"} reports a payment for ${name} (${source}), but its invoice is ${inv.status.replace(/_/g, " ")} here, so nothing unlocked. Check it: ${where}` },
    },
  ]);
}

// ---- closeProviderObject ---------------------------------------------------

export type CloseResult = {
  closed: string | null; // "Stripe invoice" | "Stripe draft" | "pay at close checkout" | null
  paidAtProvider: PaidResult | null; // the provider showed it paid: applyPaid ran, the caller stops
  unclosed: string | null; // why nothing could be closed from here (no key in this environment)
};

// Reads the open provider object back and closes it, so a client cannot pay
// something the studio has moved on from (mark paid, cancel, switch to card,
// reissue). A Stripe open or uncollectible invoice is voided and a draft
// deleted (Stripe refuses to void a draft); a Titus checkout that is not
// already canceled is canceled (a vanished one, 404, has nothing to close).
// If the provider shows it PAID, the real payment wins: applyPaid runs with
// `source` and the caller must stop. A Titus refusal (409 on a checkout mid
// payment) surfaces as a readable error instead of being swallowed.
export async function closeProviderObject(inv: InvoiceRow, source: string): Promise<CloseResult> {
  const none: CloseResult = { closed: null, paidAtProvider: null, unclosed: null };
  if (!inv.providerId) return none;
  if (inv.provider === "stripe") {
    if (!hasStripe()) return { ...none, unclosed: "The Stripe invoice could not be closed from here (no Stripe key in this environment); void it in the Stripe dashboard." };
    const stripe = stripeClient();
    const s = await stripe.invoices.retrieve(inv.providerId);
    if (s.status === "paid") {
      const refs = stripePaymentRefs(s);
      const r = await applyPaid(inv.id, {
        provider: "stripe",
        providerRef: s.id,
        method: "card",
        source,
        from: STRIPE_PAID_FROM,
        invoiceType: s.metadata?.invoice_type ?? null,
        metaPatch: { ...(refs.paymentIntent ? { stripePaymentIntent: refs.paymentIntent } : {}), ...(refs.charge ? { stripeCharge: refs.charge } : {}) },
      });
      return { ...none, paidAtProvider: r };
    }
    if (s.status === "draft") {
      await stripe.invoices.del(inv.providerId);
      return { ...none, closed: "Stripe draft" };
    }
    if (s.status === "open" || s.status === "uncollectible") {
      await stripe.invoices.voidInvoice(inv.providerId);
      return { ...none, closed: "Stripe invoice" };
    }
    return none; // void already
  }
  if (inv.provider === "titus") {
    if (!hasTitus()) return { ...none, unclosed: "The pay at close checkout could not be closed from here (no Titus key in this environment); cancel it in the Titus dashboard." };
    let c: TitusCheckout | null = null;
    try {
      c = await getCheckout(inv.providerId);
    } catch (e) {
      if (!(e instanceof TitusApiError && e.status === 404)) throw e;
    }
    if (c?.status === "succeeded") {
      const r = await applyPaid(inv.id, { provider: "titus", providerRef: c.id, method: "pay_at_close", source, metaPatch: c.loanDecision ? { loanDecision: c.loanDecision } : {} });
      return { ...none, paidAtProvider: r };
    }
    if (!c || c.status === "canceled") return none;
    try {
      await cancelCheckout(inv.providerId);
    } catch (e) {
      if (e instanceof TitusApiError) throw new Error(`Titus would not cancel the pay at close checkout (its status is ${c.status}, Titus answered ${e.status}): ${e.message}`);
      throw e;
    }
    return { ...none, closed: "pay at close checkout" };
  }
  return none;
}

// ---- markPaidManually ------------------------------------------------------

export type ManualPaidResult = PaidResult & { voided: string | null; alreadyPaidAtProvider: boolean; unclosed: string | null; reason: string | null };

// The admin's "Mark paid with note". Refuses first unless the row is in a
// status the manual settle may move (MANUAL_PAID_FROM), THEN closes the open
// provider object (so the client cannot pay twice), then runs the same unlock
// CTE with status paid_manual. The order matters: a void, canceled or refunded
// row must not have its Stripe invoice voided only for the settle to refuse.
// If the provider says the invoice is in fact paid, the real payment wins and
// goes through applyPaid instead. The payments channel hears through the
// slack.paid job settlePaid enqueues (paidLineText renders the marked-paid
// line), so nothing else is posted here.
export async function markPaidManually(invoiceId: string, note: string, actor: string): Promise<ManualPaidResult> {
  const d = db();
  const inv = await d.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId) });
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  if (isOtherEnv(inv.env)) throw new Error(`this invoice belongs to the ${rowEnv(inv.env)} environment and is handled there`);
  const base = { changed: false, unlocked: false, listingId: inv.listingId, clientId: inv.clientId, bookingId: inv.bookingId, jobs: 0, voided: null as string | null, alreadyPaidAtProvider: false, unclosed: null as string | null, reason: null as string | null };
  if (isPaid(inv.status)) return { ...base, reason: "This invoice is already paid." };
  if (!(MANUAL_PAID_FROM as string[]).includes(inv.status)) {
    return { ...base, reason: `An invoice that is ${inv.status.replace(/_/g, " ")} cannot be marked paid by hand; nothing was closed at the provider.` };
  }
  const c = await closeProviderObject(inv, "admin");
  if (c.paidAtProvider) return { ...c.paidAtProvider, voided: null, alreadyPaidAtProvider: true, unclosed: null, reason: null };
  const voided = c.closed ? inv.providerId : null;
  const r = await settlePaid(inv.id, {
    provider: inv.provider ?? (isPaidAnotherWay(inv) ? null : "stripe"),
    providerRef: inv.providerId,
    method: inv.method ?? "other",
    source: "admin",
    status: "paid_manual",
    from: MANUAL_PAID_FROM,
    actor,
    note,
    metaPatch: voided ? { note: `${inv.provider} object ${voided} closed when marked paid by hand`, ...(inv.meta?.note ? { previousNote: inv.meta.note } : {}) } : {},
  });
  return { ...r, voided, alreadyPaidAtProvider: false, unclosed: c.unclosed, reason: r.changed ? null : "Nothing changed: the invoice moved on while it was being marked paid." };
}

// ---- Two checkouts, one shoot -------------------------------------------------

// Titus reports `succeeded` for a checkout the row no longer holds: the pay
// page recreated the checkout (a 404 incident, an explicit cancel that was
// not) while the client finished the earlier one. The money is on the earlier
// checkout, so applyPaid has settled the row with it (the caller did that);
// here the newer, still-open checkout is canceled at Titus so the same shoot
// cannot be funded twice, the row points at the funded checkout and remembers
// the retired one in meta.replacedProviderIds. If Titus refuses (409 on a
// checkout mid application) or this environment has no key, the hub hears one
// money-free line so a human cancels it in the Titus dashboard; the webhook
// still answers 200 either way. One that Titus shows funded as well cannot be
// canceled: that is the duplicate funding (flagDuplicateTitusFunding, refund
// wording). A row that is no longer pay at close (Switch to card re-keyed it
// as a Stripe invoice) is left alone: see flagTitusOnCardRow.
export async function retireSupersededTitusCheckout(inv: InvoiceRow, fundedId: string, source: string): Promise<{ canceled: boolean; flagged: boolean }> {
  const stale = inv.providerId;
  if (!stale || stale === fundedId) return { canceled: false, flagged: false };
  // Never on a row that moved to card: a Stripe id is not a checkout to read or
  // cancel at Titus, and the row must not be pointed back at a Titus id.
  if (inv.provider !== "titus") return { canceled: false, flagged: false };
  let canceled = false;
  let fundedToo = false;
  let why: string | null = null;
  if (!hasTitus()) why = "no Titus key in this environment";
  else {
    try {
      const c = await getCheckout(stale);
      if (c.status === "canceled") canceled = true;
      else if (c.status === "succeeded") fundedToo = true; // not cancelable: the duplicate funding, flagged below
      else {
        await cancelCheckout(stale);
        canceled = true;
      }
    } catch (e) {
      if (e instanceof TitusApiError && e.status === 404) canceled = true; // gone at Titus: nothing left to fund
      else why = e instanceof TitusApiError ? `Titus answered ${e.status}` : e instanceof Error ? e.message : String(e);
    }
  }
  const replaced = Array.from(new Set([...(inv.meta?.replacedProviderIds ?? []), stale]));
  const note = canceled
    ? `funded through checkout ${fundedId}; the newer checkout ${stale} was canceled at Titus`
    : fundedToo
      ? `funded through checkout ${fundedId}; the newer checkout ${stale} is funded at Titus as well (a duplicate funding, flagged)`
      : `funded through checkout ${fundedId}; the newer checkout ${stale} is still open at Titus (${why})`;
  // Merged in SQL: applyPaid has just written its own meta (loanDecision, …)
  // and `inv` is the row as it was before, so a whole-object write would
  // undo that.
  const patch = JSON.stringify({ replacedProviderIds: replaced, note, ...(inv.meta?.note ? { previousNote: inv.meta.note } : {}) });
  await db()
    .update(schema.invoices)
    .set({ providerId: fundedId, hostedUrl: null, meta: sql`COALESCE(${schema.invoices.meta}, '{}'::jsonb) || ${patch}::jsonb`, updatedAt: new Date() })
    .where(eq(schema.invoices.id, inv.id));
  if (canceled) return { canceled: true, flagged: false };
  if (fundedToo) {
    // Both checkouts funded the same shoot. "Cancel it in the Titus dashboard"
    // is impossible for a funded checkout; the refund wording and the
    // payment.duplicate_funding row come from the one place that writes them,
    // seen from the row as it now is (paid through fundedId).
    await flagDuplicateTitusFunding({ ...inv, providerId: fundedId }, stale, null);
    return { canceled: false, flagged: true };
  }
  const name = await hubNameFor(inv);
  const where = adminWhere(inv);
  await enqueueJobs([
    {
      kind: "slack.issue",
      idempotencyKey: `slack.issue:superseded_checkout:${inv.id}:${stale}`,
      invoiceId: inv.id,
      bookingId: inv.bookingId,
      listingId: inv.listingId,
      payload: { version: 1, note: `Titus funded ${name} through an earlier pay at close checkout (${source}) while a newer one was still open and could not be canceled from here (${why}). Cancel checkout ${stale} in the Titus dashboard so the client cannot fund this shoot twice. ${where}` },
    },
  ]);
  return { canceled: false, flagged: true };
}

// A second `succeeded`, for a checkout that is not the one that paid the row:
// the client funded the same shoot twice (the retire above could not cancel the
// newer checkout, or both completed within the same minute). Nothing here can
// undo money, so it is recorded (payment.duplicate_funding) and the hub hears
// once per checkout, money-free; the refund is a human's call in Titus.
export async function flagDuplicateTitusFunding(inv: InvoiceRow, checkoutId: string, eventId: string | null): Promise<void> {
  const name = await hubNameFor(inv);
  const where = adminWhere(inv);
  await logActivity({ action: "payment.duplicate_funding", listingId: inv.listingId, clientId: inv.clientId, meta: { invoiceId: inv.id, provider: "titus", checkoutId, paidCheckoutId: inv.providerId, eventId } });
  await enqueueJobs([
    {
      kind: "slack.issue",
      idempotencyKey: `slack.issue:duplicate_funding:${inv.id}:${checkoutId}`,
      invoiceId: inv.id,
      bookingId: inv.bookingId,
      listingId: inv.listingId,
      payload: { version: 1, note: `Titus reports a second funded pay at close checkout (${checkoutId}) for ${name}, whose invoice is already paid through ${inv.providerId ?? "another checkout"}. Refund the duplicate in the Titus dashboard. ${where}` },
    },
  ]);
}

// ---- A Titus event for a row that is no longer pay at close -----------------

// Titus reports money (a funded checkout, or a completed refund of one) for a
// row an admin has since switched to card: the checkout was canceled from the
// admin while the client was completing it, or the cancel never took, and the
// late delivery still matched the row through metadata.invoice_id. Nothing
// here settles, relocks or retires a Stripe row, and the row is never pointed
// back at a Titus id (that would leave the open Stripe invoice payable and
// send a human to cancel a Stripe id in the Titus dashboard). The webhook does
// not void the Stripe invoice either: Stripe's own invoice.voided would then
// move the row to void, which Mark paid refuses. So the hub hears once per
// checkout, money-free, with the two moves that work from the admin: Mark
// paid by hand (it closes the open Stripe invoice first, then settles), or a
// refund in Titus with the card invoice left standing. Recorded as
// payment.titus_after_switch.
export async function flagTitusOnCardRow(inv: InvoiceRow, checkoutId: string | null, eventId: string | null, what: "funded" | "refunded", source: string): Promise<void> {
  const name = await hubNameFor(inv);
  const where = adminWhere(inv);
  await logActivity({ action: "payment.titus_after_switch", listingId: inv.listingId, clientId: inv.clientId, meta: { invoiceId: inv.id, provider: inv.provider, providerId: inv.providerId, checkoutId, what, eventId, source } });
  const which = checkoutId ? `checkout ${checkoutId}` : "a checkout";
  const card = inv.providerId ? `the card invoice ${inv.providerId}` : "the card invoice";
  const note =
    what === "funded"
      ? `Titus reports a funded pay at close ${which} for ${name} (${source}), but its invoice was switched to card after that checkout was made, so nothing was settled here and ${card} is still payable. If the Titus funding stands, mark the invoice paid by hand from the admin (that voids the open Stripe invoice first); otherwise refund the checkout in the Titus dashboard. ${where}`
      : `Titus reports a refund on pay at close ${which} for ${name} (${source}), but its invoice was switched to card, so nothing was relocked here. Check the invoice in the admin and the refund in Titus. ${where}`;
  await enqueueJobs([
    {
      kind: "slack.issue",
      idempotencyKey: `slack.issue:titus_after_switch:${what}:${inv.id}:${checkoutId ?? eventId ?? "unknown"}`,
      invoiceId: inv.id,
      bookingId: inv.bookingId,
      listingId: inv.listingId,
      payload: { version: 1, note },
    },
  ]);
}

async function hubNameFor(inv: InvoiceRow): Promise<string> {
  const listing = inv.listingId ? await db().query.listings.findFirst({ where: eq(schema.listings.id, inv.listingId), columns: { address: true, nda: true } }) : null;
  return hubListingName({ address: listing?.address ?? inv.propertyAddress ?? "a listing", nda: listing?.nda ?? false });
}

function adminWhere(inv: InvoiceRow): string {
  return inv.bookingId ? `${siteUrl()}/admin/bookings/${inv.bookingId}` : inv.listingId ? `${siteUrl()}/admin/listings/${inv.listingId}` : `${siteUrl()}/admin`;
}

// ---- relockForRefund -------------------------------------------------------

export type RefundResult = { changed: boolean; locked: boolean; full: boolean };

// A full refund: invoice → refunded, listing locked again, activity
// listing.locked (reason refund), payments Slack. Partial: refunded_cents,
// activity and the payments channel only. Both idempotent on replay.
export async function relockForRefund(invoiceId: string, refundedCents: number, full: boolean, ctx: { provider?: InvoiceProvider | null; providerRef?: string | null; eventId?: string | null } = {}): Promise<RefundResult> {
  const d = db();
  const inv = await d.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId) });
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  const provider = ctx.provider ?? inv.provider ?? null;
  const at = new Date().toISOString();
  const lastEvent = JSON.stringify({ type: full ? "refund.full" : "refund.partial", at, provider, providerRef: ctx.providerRef ?? null, eventId: ctx.eventId ?? null, refundedCents });
  if (full) {
    const actMeta = JSON.stringify({ invoiceId, provider, providerRef: ctx.providerRef ?? null, eventId: ctx.eventId ?? null, refundedCents });
    const lockMeta = JSON.stringify({ invoiceId, reason: "refund", provider });
    const res = await d.execute<{ invoices: number; locked: number }>(sql`
      WITH inv AS (
        UPDATE invoices
           SET status = 'refunded', refunded_cents = ${refundedCents}, last_event = ${lastEvent}::jsonb, last_checked_at = now(), updated_at = now()
         WHERE id = ${invoiceId} AND status IN ('paid', 'paid_manual')
         RETURNING id, listing_id, client_id, meta
      ),
      lock AS (
        UPDATE listings l
           SET download_locked = true
          FROM inv
         WHERE l.id = inv.listing_id
           AND l.download_locked = false
           AND COALESCE(inv.meta->>'invoiceType', 'production') NOT IN (${nonGatingSql()})
         RETURNING l.id
      ),
      act AS (
        INSERT INTO activity (actor_email, action, listing_id, client_id, meta)
        SELECT NULL::text, 'invoice.refunded'::text, inv.listing_id, inv.client_id, ${actMeta}::jsonb FROM inv
        UNION ALL
        SELECT NULL::text, 'listing.locked'::text, lock.id, inv.client_id, ${lockMeta}::jsonb
          FROM lock JOIN inv ON inv.listing_id = lock.id
        RETURNING id
      )
      SELECT (SELECT count(*) FROM inv)::int AS invoices, (SELECT count(*) FROM lock)::int AS locked`);
    const row = res.rows[0];
    const changed = Number(row?.invoices ?? 0) > 0;
    const locked = Number(row?.locked ?? 0) > 0;
    if (changed) {
      const line = await payLineFor(inv.id);
      if (line) await enqueueJobs([{ kind: "slack.payment", idempotencyKey: `slack.payment:refund:${inv.id}:${refundedCents}:full`, invoiceId: inv.id, bookingId: inv.bookingId, listingId: inv.listingId, payload: { version: 1, text: paymentsText.refunded({ ...line, provider, refunded: fmtDollars(refundedCents), full: true }) } }]);
    }
    return { changed, locked, full: true };
  }
  const rows = await d
    .update(schema.invoices)
    .set({ refundedCents, lastEvent: JSON.parse(lastEvent) as Record<string, unknown>, lastCheckedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.invoices.id, invoiceId), or(isNull(schema.invoices.refundedCents), sql`${schema.invoices.refundedCents} <> ${refundedCents}`)))
    .returning({ id: schema.invoices.id });
  const changed = rows.length > 0;
  if (changed) {
    await logActivity({ action: "invoice.partially_refunded", listingId: inv.listingId, clientId: inv.clientId, meta: { invoiceId, provider, providerRef: ctx.providerRef ?? null, refundedCents } });
    const line = await payLineFor(inv.id);
    if (line) await enqueueJobs([{ kind: "slack.payment", idempotencyKey: `slack.payment:refund:${inv.id}:${refundedCents}:partial`, invoiceId: inv.id, bookingId: inv.bookingId, listingId: inv.listingId, payload: { version: 1, text: paymentsText.refunded({ ...line, provider, refunded: fmtDollars(refundedCents), full: false }) } }]);
  }
  return { changed, locked: false, full: false };
}

// ---- Other status moves ------------------------------------------------------

export type Transition = { changed: boolean; row: InvoiceRow | null };

// Status changes that are not "paid": processing, review, back to open, void,
// canceled. `from` guards the move; paid rows are never downgraded by these.
export async function transitionInvoice(
  invoiceId: string,
  to: InvoiceStatus,
  opts: { from?: InvoiceStatus[]; lastEvent?: Record<string, unknown>; patch?: Partial<typeof schema.invoices.$inferInsert>; activity?: { action: ActivityAction; meta?: Record<string, unknown>; actorEmail?: string | null } } = {}
): Promise<Transition> {
  const d = db();
  const from = opts.from ?? PAYABLE_STATUSES;
  const rows = await d
    .update(schema.invoices)
    .set({ status: to, lastEvent: opts.lastEvent ?? undefined, lastCheckedAt: new Date(), updatedAt: new Date(), ...(opts.patch ?? {}) })
    .where(and(eq(schema.invoices.id, invoiceId), inArray(schema.invoices.status, from)))
    .returning();
  const row = rows[0] ?? null;
  if (row && opts.activity) {
    await logActivity({ actorEmail: opts.activity.actorEmail ?? null, action: opts.activity.action, listingId: row.listingId, clientId: row.clientId, meta: { invoiceId, status: to, ...(opts.activity.meta ?? {}) } });
  }
  return { changed: Boolean(row), row };
}

// Remember the last thing a provider told us, without moving the status.
export async function noteProviderEvent(invoiceId: string, lastEvent: Record<string, unknown>, patch: Partial<typeof schema.invoices.$inferInsert> = {}): Promise<void> {
  await db().update(schema.invoices).set({ lastEvent, lastCheckedAt: new Date(), updatedAt: new Date(), ...patch }).where(eq(schema.invoices.id, invoiceId));
}

// Titus canceled the checkout: forget it and bump the idempotency version so
// the next attempt creates a genuinely new one. Status back to open unless the
// row has moved on. `expectedCheckoutId` pins the reset to the checkout the
// caller saw, so a late cancel for a checkout the pay page already replaced
// cannot reset its successor. `from` is the statuses the reset may leave: an
// explicit `canceled` from Titus resets any payable row (the checkout is
// gone), while the 404-driven reset passes ["open"], because a client mid
// application (processing | review) must never be handed a second checkout.
export async function resetTitusCheckout(invoiceId: string, lastEvent: Record<string, unknown>, expectedCheckoutId?: string | null, from: InvoiceStatus[] = PAYABLE_STATUSES): Promise<Transition> {
  const d = db();
  const rows = await d
    .update(schema.invoices)
    .set({ providerId: null, hostedUrl: null, idempotencyVersion: sql`${schema.invoices.idempotencyVersion} + 1`, status: "open", lastEvent, lastCheckedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.invoices.id, invoiceId),
        eq(schema.invoices.provider, "titus"),
        expectedCheckoutId ? eq(schema.invoices.providerId, expectedCheckoutId) : isNotNull(schema.invoices.providerId),
        inArray(schema.invoices.status, from)
      )
    )
    .returning();
  const row = rows[0] ?? null;
  if (row) {
    await logActivity({ action: "invoice.canceled", listingId: row.listingId, clientId: row.clientId, meta: { invoiceId, provider: "titus", version: row.idempotencyVersion } });
  }
  return { changed: Boolean(row), row };
}

// ---- payment_events --------------------------------------------------------

export type RecordedEvent = { id: string; duplicate: boolean; processedAt: Date | null };

export async function recordPaymentEvent(e: {
  provider: InvoiceProvider;
  providerEventId: string;
  type: string | null;
  objectId: string | null;
  invoiceId?: string | null;
  status?: string | null;
  signatureOk: boolean;
  stale: boolean;
  payload: Record<string, unknown> | null;
  env?: string | null;
}): Promise<RecordedEvent> {
  const d = db();
  const inserted = await d
    .insert(schema.paymentEvents)
    .values({
      provider: e.provider,
      providerEventId: e.providerEventId,
      type: e.type,
      objectId: e.objectId,
      invoiceId: e.invoiceId ?? null,
      status: e.status ?? null,
      signatureOk: e.signatureOk,
      stale: e.stale,
      payload: e.payload,
      env: e.env ?? currentEnv(),
    })
    .onConflictDoNothing({ target: [schema.paymentEvents.provider, schema.paymentEvents.providerEventId] })
    .returning({ id: schema.paymentEvents.id });
  if (inserted.length) return { id: inserted[0].id, duplicate: false, processedAt: null };
  const existing = await d.query.paymentEvents.findFirst({
    where: and(eq(schema.paymentEvents.provider, e.provider), eq(schema.paymentEvents.providerEventId, e.providerEventId)),
    columns: { id: true, processedAt: true, invoiceId: true },
  });
  if (!existing) throw new Error("payment event vanished between insert and read");
  // A re-delivery may know the invoice the first one could not match yet.
  if (!existing.invoiceId && e.invoiceId) await d.update(schema.paymentEvents).set({ invoiceId: e.invoiceId }).where(eq(schema.paymentEvents.id, existing.id));
  return { id: existing.id, duplicate: true, processedAt: existing.processedAt };
}

// Processed: `note` is what processing decided ("already paid", "belongs to
// the preview environment"); the error column is cleared, it is for failures.
export async function markEventProcessed(id: string, note?: string | null): Promise<void> {
  await db().update(schema.paymentEvents).set({ processedAt: new Date(), note: note ? note.slice(0, 1000) : null, error: null }).where(eq(schema.paymentEvents.id, id));
}

// payment.webhook_rejected, at most one row per provider per 10 minutes, so
// an unauthenticated caller cannot fill the activity feed with bad signatures.
export async function logWebhookRejected(provider: InvoiceProvider, reason: string): Promise<void> {
  try {
    const recent = await db().query.activity.findFirst({
      where: and(eq(schema.activity.action, "payment.webhook_rejected"), sql`${schema.activity.meta}->>'provider' = ${provider}`, gt(schema.activity.createdAt, new Date(Date.now() - 10 * 60_000))),
      columns: { id: true },
    });
    if (recent) return;
  } catch (e) {
    console.error("[payments] webhook_rejected lookup:", e instanceof Error ? e.message : e);
  }
  await logActivity({ action: "payment.webhook_rejected", meta: { provider, reason } });
}

// Processing threw: keep processed_at NULL (the provider retries, and the retry
// re-processes) but remember why.
export async function recordEventError(id: string, error: string): Promise<void> {
  await db().update(schema.paymentEvents).set({ error: error.slice(0, 1000) }).where(eq(schema.paymentEvents.id, id));
}

export async function attachEventInvoice(id: string, invoiceId: string): Promise<void> {
  await db().update(schema.paymentEvents).set({ invoiceId }).where(eq(schema.paymentEvents.id, id));
}

// ---- syncInvoiceFromProvider -------------------------------------------------

// pay_page is the pay at close button's own POST (/api/portal/pay/checkout),
// the one read that may reset a vanished checkout; pay_page_load is the page
// render, which like gallery_load, download and reconcile only ever notes.
export type SyncSource = "webhook_stale" | "client_success" | "gallery_load" | "pay_page_load" | "pay_page" | "download" | "reconcile" | "operator";

export type SyncResult = {
  ok: boolean;
  skipped?: string;
  provider?: string | null;
  providerStatus?: string | null;
  status?: string | null; // our status after the sync
  changed: boolean;
  unlocked: boolean;
  error?: string;
};

// Reads the payment intent that paid a Stripe invoice, when the payload has it.
export function stripePaymentRefs(inv: Stripe.Invoice): { paymentIntent: string | null; charge: string | null } {
  const payments = inv.payments?.data ?? [];
  const paid = payments.find((p) => p.status === "paid") ?? payments[0];
  const pi = paid?.payment.payment_intent;
  const ch = paid?.payment.charge;
  return {
    paymentIntent: typeof pi === "string" ? pi : pi?.id ?? null,
    charge: typeof ch === "string" ? ch : ch?.id ?? null,
  };
}

async function syncStripe(inv: InvoiceRow, source: SyncSource): Promise<SyncResult> {
  if (!hasStripe()) return { ok: true, skipped: "Stripe is not configured here", provider: "stripe", status: inv.status, changed: false, unlocked: false };
  const stripe = stripeClient();
  const s = await stripe.invoices.retrieve(inv.providerId as string);
  const at = new Date().toISOString();
  const lastEvent = { type: "sync", provider: "stripe", source, at, status: s.status ?? null };
  if (s.status === "paid") {
    const refs = stripePaymentRefs(s);
    const r = await applyPaid(inv.id, {
      provider: "stripe",
      providerRef: s.id,
      method: "card",
      source: `sync:${source}`,
      from: STRIPE_PAID_FROM,
      invoiceType: s.metadata?.invoice_type ?? null,
      metaPatch: { ...(refs.paymentIntent ? { stripePaymentIntent: refs.paymentIntent } : {}), ...(refs.charge ? { stripeCharge: refs.charge } : {}) },
    });
    if (!r.changed && !isPaid(inv.status)) await flagUnsettledPaid(inv.id, "stripe", `sync:${source}`);
    return { ok: true, provider: "stripe", providerStatus: s.status, status: r.changed ? "paid" : inv.status, changed: r.changed, unlocked: r.unlocked };
  }
  if (s.status === "void" || s.status === "uncollectible") {
    // Void is final. Uncollectible is Stripe's bad-debt flag and the hosted
    // invoice still takes a payment, so the row keeps that status (it is in
    // STRIPE_PAID_FROM) instead of being closed as void.
    const to: InvoiceStatus = s.status === "void" ? "void" : "uncollectible";
    const from: InvoiceStatus[] = to === "void" ? [...PAYABLE_STATUSES, "draft", "uncollectible"] : [...PAYABLE_STATUSES, "draft"];
    const t = await transitionInvoice(inv.id, to, { from, lastEvent, activity: { action: to === "void" ? "invoice.voided" : "invoice.uncollectible", meta: { provider: "stripe", providerStatus: s.status, source } } });
    if (!t.changed) await noteProviderEvent(inv.id, lastEvent);
    return { ok: true, provider: "stripe", providerStatus: s.status, status: t.changed ? to : inv.status, changed: t.changed, unlocked: false };
  }
  // open or draft: keep our status, refresh what the client sees.
  await noteProviderEvent(inv.id, lastEvent, {
    hostedUrl: s.hosted_invoice_url ?? inv.hostedUrl,
    hostedInvoiceUrl: s.hosted_invoice_url ?? inv.hostedInvoiceUrl,
    amountDue: typeof s.amount_due === "number" ? s.amount_due : inv.amountDue,
  });
  return { ok: true, provider: "stripe", providerStatus: s.status ?? null, status: inv.status, changed: false, unlocked: false };
}

// How many consecutive misses (404 from Titus) seen by the pay at close
// button itself (source pay_page) an OPEN row tolerates before the stored
// checkout is treated as gone and recreated. Misses from any other source
// (the page render, the gallery, reconcile) are counted for the record but
// never bring a reset closer.
const TITUS_MISSES_BEFORE_RESET = 2;

async function syncTitus(inv: InvoiceRow, source: SyncSource): Promise<SyncResult> {
  if (!hasTitus()) return { ok: true, skipped: "Titus is not configured here", provider: "titus", status: inv.status, changed: false, unlocked: false };
  const at = new Date().toISOString();
  let c: TitusCheckout | null = null;
  try {
    c = await getCheckout(inv.providerId as string);
  } catch (e) {
    if (!(e instanceof TitusApiError && e.status === 404)) throw e;
  }
  if (!c) {
    // A 404 is NOT a cancel. A wrong TITUS_API_BASE_URL, a key that does not
    // own this checkout or a Titus routing incident all read the same as a
    // dropped checkout, so a miss is only noted and the checkout kept: a
    // client may be mid application in it. Only the pay at close button's own
    // POST (source pay_page: a client clicking, nothing else) resets, after two
    // consecutive misses seen by that button, and only while the row is still
    // open: a row in processing or review has an application in flight at
    // Titus, and a fresh checkout next to it is how a shoot gets funded twice.
    // The page render (pay_page_load), the gallery load, reconcile and the
    // 402 branches never reset anything.
    const prev = inv.lastEvent ?? {};
    const wasMissing = prev.type === "sync" && prev.status === "missing";
    const misses = (wasMissing ? Number(prev.misses ?? 1) : 0) + 1;
    const clickMisses = (wasMissing ? Number(prev.clickMisses ?? 0) : 0) + (source === "pay_page" ? 1 : 0);
    const lastEvent = { type: "sync", provider: "titus", source, at, status: "missing", misses, clickMisses, checkoutId: inv.providerId };
    if (source === "pay_page" && clickMisses >= TITUS_MISSES_BEFORE_RESET && inv.status === "open") {
      const t = await resetTitusCheckout(inv.id, { ...lastEvent, type: "checkout.reset" }, inv.providerId, ["open"]);
      return { ok: true, provider: "titus", providerStatus: "missing", status: t.changed ? "open" : inv.status, changed: t.changed, unlocked: false };
    }
    await noteProviderEvent(inv.id, lastEvent);
    return { ok: true, provider: "titus", providerStatus: "missing", status: inv.status, changed: false, unlocked: false };
  }
  const status = c.status;
  const lastEvent = { type: "sync", provider: "titus", source, at, status, loanDecision: c.loanDecision ?? null };
  if (status === "succeeded") {
    const r = await applyPaid(inv.id, { provider: "titus", providerRef: inv.providerId, method: "pay_at_close", source: `sync:${source}`, metaPatch: c.loanDecision ? { loanDecision: c.loanDecision } : {} });
    if (!r.changed && !isPaid(inv.status)) await flagUnsettledPaid(inv.id, "titus", `sync:${source}`);
    return { ok: true, provider: "titus", providerStatus: status, status: r.changed ? "paid" : inv.status, changed: r.changed, unlocked: r.unlocked };
  }
  if (status === "canceled") {
    // Titus said so itself: forget this checkout, the next attempt makes a new one.
    const t = await resetTitusCheckout(inv.id, lastEvent, inv.providerId);
    return { ok: true, provider: "titus", providerStatus: status, status: t.changed ? "open" : inv.status, changed: t.changed, unlocked: false };
  }
  if (status === "processing") {
    const t = await transitionInvoice(inv.id, "processing", { from: ["open"], lastEvent, activity: { action: "invoice.processing", meta: { provider: "titus", source } } });
    if (!t.changed) await noteProviderEvent(inv.id, lastEvent);
    return { ok: true, provider: "titus", providerStatus: status, status: t.changed ? "processing" : inv.status, changed: t.changed, unlocked: false };
  }
  // requires-payment: an attempt that did not go through leaves "processing";
  // a review stays a review until Titus says otherwise.
  const t = inv.status === "processing" ? await transitionInvoice(inv.id, "open", { from: ["processing"], lastEvent }) : { changed: false, row: null };
  if (!t.changed) await noteProviderEvent(inv.id, lastEvent, { hostedUrl: c.checkoutUrl ?? inv.hostedUrl });
  return { ok: true, provider: "titus", providerStatus: status, status: t.changed ? "open" : inv.status, changed: t.changed, unlocked: false };
}

// `force` skips the 30 s throttle AND the payable-status check (an operator
// re-reading a closed row); `skipThrottle` only the throttle (a client who just
// finished the provider flow should see the answer now, not in 30 s).
export async function syncInvoiceFromProvider(invoiceId: string, source: SyncSource, opts: { force?: boolean; skipThrottle?: boolean } = {}): Promise<SyncResult> {
  const d = db();
  const inv = await d.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId) });
  if (!inv) return { ok: false, skipped: "invoice not found", changed: false, unlocked: false };
  // Another environment's row (one shared database): never ask a provider
  // about it from here, whatever the caller (a preview admin viewing as a
  // production client, an operator, reconcile).
  if (isOtherEnv(inv.env)) return { ok: true, skipped: `belongs to the ${rowEnv(inv.env)} environment`, provider: inv.provider, status: inv.status, changed: false, unlocked: false };
  if (!inv.provider || !inv.providerId) return { ok: true, skipped: "no provider id yet", provider: inv.provider, status: inv.status, changed: false, unlocked: false };
  if (!isPayable(inv.status) && !opts.force) return { ok: true, skipped: `status is ${inv.status}`, provider: inv.provider, status: inv.status, changed: false, unlocked: false };
  const fresh = opts.force || opts.skipThrottle || source === "webhook_stale";
  if (!fresh && inv.lastCheckedAt && Date.now() - inv.lastCheckedAt.getTime() < SYNC_THROTTLE_MS) {
    return { ok: true, skipped: "checked in the last 30 s", provider: inv.provider, status: inv.status, changed: false, unlocked: false };
  }
  // Claim the check first so parallel page loads do not all call the provider.
  await d.update(schema.invoices).set({ lastCheckedAt: new Date() }).where(eq(schema.invoices.id, inv.id));
  try {
    if (inv.provider === "stripe") return await syncStripe(inv, source);
    if (inv.provider === "titus") return await syncTitus(inv, source);
    return { ok: true, skipped: `unknown provider ${String(inv.provider)}`, provider: inv.provider, status: inv.status, changed: false, unlocked: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[payments] sync ${inv.provider} ${inv.providerId} (${source}):`, message);
    return { ok: false, error: message, provider: inv.provider, status: inv.status, changed: false, unlocked: false };
  }
}

// The 402 branches: before refusing a download on a locked listing, ask the
// provider about the newest payable invoice that has a provider id and that
// governs the lock (an add-on or a second shoot's invoice never unlocks, so
// reading one back here would only spend the check). True when the listing
// is unlocked now.
export async function syncLockedListing(listingId: string, source: SyncSource): Promise<boolean> {
  const d = db();
  const inv = await d.query.invoices.findFirst({
    where: and(
      eq(schema.invoices.listingId, listingId),
      isNotNull(schema.invoices.providerId),
      inArray(schema.invoices.status, PAYABLE_STATUSES),
      sql`COALESCE(${schema.invoices.meta}->>'invoiceType', 'production') NOT IN (${nonGatingSql()})`
    ),
    orderBy: [desc(schema.invoices.createdAt)],
    columns: { id: true },
  });
  if (!inv) return false;
  const r = await syncInvoiceFromProvider(inv.id, source);
  if (!r.changed) return false;
  const l = await d.query.listings.findFirst({ where: eq(schema.listings.id, listingId), columns: { downloadLocked: true } });
  return Boolean(l && !l.downloadLocked);
}

// The payments.reconcile job: last resort behind the webhooks and the sync
// hooks. Up to `limit` payable invoices with a provider id that nobody has
// checked in 10 minutes, this environment only (legacy rows with no env belong
// to production).
export async function reconcileInvoices(limit = 50): Promise<{ checked: number; changed: number; unlocked: number; errors: number }> {
  const env = currentEnv();
  const cutoff = new Date(Date.now() - 10 * 60_000);
  const rows = await db().query.invoices.findMany({
    where: and(
      isNotNull(schema.invoices.providerId),
      inArray(schema.invoices.status, PAYABLE_STATUSES),
      or(isNull(schema.invoices.lastCheckedAt), lt(schema.invoices.lastCheckedAt, cutoff)),
      env === "production" ? or(eq(schema.invoices.env, env), isNull(schema.invoices.env)) : eq(schema.invoices.env, env)
    ),
    orderBy: [sql`${schema.invoices.lastCheckedAt} ASC NULLS FIRST`],
    limit,
    columns: { id: true },
  });
  const out = { checked: 0, changed: 0, unlocked: 0, errors: 0 };
  for (const r of rows) {
    const s = await syncInvoiceFromProvider(r.id, "reconcile");
    out.checked++;
    if (s.changed) out.changed++;
    if (s.unlocked) out.unlocked++;
    if (!s.ok) out.errors++;
  }
  return out;
}

// ---- Slack helpers ----------------------------------------------------------

// Everything a payments-channel line needs about an invoice.
export async function payLineFor(invoiceId: string): Promise<PayLine | null> {
  const inv = await db().query.invoices.findFirst({
    where: eq(schema.invoices.id, invoiceId),
    with: { listing: { columns: { id: true, address: true, nda: true } }, client: { columns: { name: true, email: true } }, booking: { columns: { paymentDetail: true } } },
  });
  if (!inv) return null;
  const email = inv.client?.email ?? inv.clientEmail ?? null;
  const other = isPaidAnotherWay(inv);
  const cents = inv.amountCents ?? inv.amountDue;
  const type = inv.meta?.invoiceType ?? null;
  return {
    listing: { address: inv.listing?.address ?? inv.propertyAddress ?? "a listing", nda: inv.listing?.nda ?? false },
    listingId: inv.listingId,
    bookingId: inv.bookingId,
    client: inv.client?.name ? `${inv.client.name} (${inv.client.email})` : email,
    amount: cents != null ? fmtDollars(cents) : null,
    method: other ? payOtherWay(inv.booking?.paymentDetail) : paymentMethodLabel(inv.method, inv.meta?.payNowMethod ?? null),
    provider: inv.provider ?? null,
    // Which invoice of the booking this is, when it is not the booking's own.
    what: type === "additional_shoot" ? "second shoot invoice" : type === "addon" ? "added items invoice" : null,
    unlocks: gatesGallery(inv.meta),
  };
}

// The slack.paid job: one line in the payments channel once an invoice is paid.
export async function paidLineText(invoiceId: string): Promise<string | null> {
  const inv = await db().query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), columns: { status: true, meta: true } });
  if (!inv) return null;
  const line = await payLineFor(invoiceId);
  if (!line) return null;
  // An exclusivity_monthly, add-on or second shoot invoice never unlocks a gallery (the CTE skips them), so its line does not claim one.
  if (inv.status === "paid_manual") return paymentsText.paidManual({ ...line, by: inv.meta?.paidManualBy ?? "an admin", note: inv.meta?.paidManualNote ?? null, unlocks: gatesGallery(inv.meta) });
  return paymentsText.paid({ ...line, unlocks: gatesGallery(inv.meta) });
}
