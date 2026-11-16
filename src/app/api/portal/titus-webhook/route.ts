// Titus → studio (docs/booking-to-payment.md). Pay at
// close only. The raw body is read once and verified with HMAC-SHA256 of
// `${x-webhook-timestamp}.${rawBody}` under TITUS_WEBHOOK_SECRET (constant
// time). 503 until that secret is set, 401 on a bad signature (logged as
// payment.webhook_rejected). Every accepted delivery is a payment_events row
// BEFORE anything acts on it: a duplicate with processed_at set is answered 200
// at once, one whose processing died is re-processed; a throw leaves
// processed_at NULL and returns 500 so Titus retries.
//
// Stale (valid signature, timestamp older than 5 min): stored with stale=true
// and acted on only through syncInvoiceFromProvider (a GET of the checkout
// confirms the status), never from the stale payload.
//
// Envelope { id, createdAt, type, payload = the full entity }. Types:
//   checkout.created / updated            → by payload.status: succeeded →
//     applyPaid (the ONLY unlock here); processing; requires-payment (back to
//     open after a failed attempt); canceled → forget the checkout and bump
//     idempotency_version so the pay page makes a new one
//   checkout.payment_failed               → open, activity, payments channel
//   checkout.loan_application_under_review→ review, activity
//   checkout.loan_application_approved    → activity only, NEVER an unlock
//   checkout.loan_application_denied      → open, activity, payments channel,
//     one money-free line for the team ("switch to card from the admin":
//     #bookings when set, else the hub)
//   refund.created / updated              → relockForRefund once completed
// Order is not guaranteed and retries are exponential, so everything is
// idempotent on the invoice status. processing, canceled and requires-payment
// move the row only for the checkout it holds.
//
// A row that is no longer pay at close (an admin's Switch to card re-keyed it
// as a Stripe invoice after the checkout was made; metadata.invoice_id still
// matches it) is never settled, relocked, moved or retired from here, and is
// never pointed back at a Titus id: a funded checkout or a completed refund is
// one money-free hub line for a human (flagTitusOnCardRow), the rest is noted.
//
// One endpoint (production), one database shared with the previews: a
// checkout a preview created (the env of the row it matched, or
// metadata.env) is that preview's to settle through its own sync hooks, so
// production only records the delivery. Rows with no env are production's.
import { after } from "next/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { logActivity } from "@/lib/activity";
import { drainJobs } from "@/lib/jobs";
import { currentEnv, enqueueJobs } from "@/lib/jobs-core";
import {
  applyPaid,
  flagDuplicateTitusFunding,
  flagTitusOnCardRow,
  flagUnsettledPaid,
  isOtherEnv,
  isPaid,
  logWebhookRejected,
  markEventProcessed,
  noteProviderEvent,
  PAYABLE_STATUSES,
  payLineFor,
  recordEventError,
  recordPaymentEvent,
  relockForRefund,
  resetTitusCheckout,
  retireSupersededTitusCheckout,
  rowEnv,
  syncInvoiceFromProvider,
  transitionInvoice,
} from "@/lib/payments";
import { hubTextPayAtCloseDeclined, paymentsText } from "@/lib/slack";
import { TITUS_WEBHOOK_TOLERANCE_MS, verifyTitusSignature } from "@/lib/titus";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type InvoiceRow = typeof schema.invoices.$inferSelect;
type Db = ReturnType<typeof db>;
type Envelope = { id: string; createdAt: string | null; type: string; payload: Record<string, unknown> };
type Handled = { changed?: boolean; unlocked?: boolean; drain?: boolean; note?: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

// The note once the newer of two checkouts for one shoot has been retired, or not.
const retireNote = (funded: string, stale: string | null, s: { canceled: boolean; flagged: boolean }): string =>
  s.canceled ? `funded through ${funded}; the newer checkout ${stale} was canceled at Titus` : `funded through ${funded}; the newer checkout ${stale} was not canceled at Titus (still open, or funded as well); flagged for the team`;

function parseEnvelope(raw: string): Envelope | null {
  try {
    const o = obj(JSON.parse(raw));
    if (!o) return null;
    const id = str(o.id);
    const type = str(o.type);
    if (!id || !type) return null;
    return { id, createdAt: str(o.createdAt), type, payload: obj(o.payload) ?? obj(o.data) ?? {} };
  } catch {
    return null;
  }
}

// The checkout a delivery is about: checkout.* carries the entity itself,
// refund.* a refund that points at its checkout.
function checkoutIdOf(type: string, p: Record<string, unknown>): string | null {
  if (type.startsWith("checkout.")) return str(p.id);
  return str(p.checkoutId) ?? str(p.checkout_id) ?? str(obj(p.checkout)?.id);
}

// Our invoice: by the checkout id we stored, then metadata.invoice_id, then
// orderId (= listing id) for the newest payable Titus invoice of that listing.
async function findInvoice(d: Db, type: string, p: Record<string, unknown>): Promise<InvoiceRow | null> {
  const checkoutId = checkoutIdOf(type, p);
  if (checkoutId) {
    const row = await d.query.invoices.findFirst({ where: and(eq(schema.invoices.provider, "titus"), eq(schema.invoices.providerId, checkoutId)) });
    if (row) return row;
  }
  const metaInvoice = str(obj(p.metadata)?.invoice_id);
  if (metaInvoice && UUID_RE.test(metaInvoice)) {
    const row = await d.query.invoices.findFirst({ where: eq(schema.invoices.id, metaInvoice) });
    if (row) return row;
  }
  const orderId = str(p.orderId) ?? str(p.order_id);
  if (orderId && UUID_RE.test(orderId)) {
    const row = await d.query.invoices.findFirst({
      where: and(eq(schema.invoices.provider, "titus"), eq(schema.invoices.listingId, orderId), inArray(schema.invoices.status, PAYABLE_STATUSES)),
      orderBy: [desc(schema.invoices.createdAt)],
    });
    if (row) return row;
  }
  return null;
}

async function handle(env: Envelope, row: InvoiceRow): Promise<Handled> {
  const p = env.payload;
  const at = new Date().toISOString();
  const status = str(p.status);
  const loan = str(p.loanDecision) ?? str(p.loan_decision);
  const checkoutId = checkoutIdOf(env.type, p);
  const lastEvent = (extra: Record<string, unknown> = {}) => ({ type: env.type, at, eventId: env.id, provider: "titus", checkoutId, status, ...(loan ? { loanDecision: loan } : {}), ...extra });
  const post = async (key: string, text: string) =>
    enqueueJobs([{ kind: "slack.payment", idempotencyKey: `slack.payment:${key}:${row.id}:${env.id}`, invoiceId: row.id, bookingId: row.bookingId, listingId: row.listingId, payload: { version: 1, text } }]);

  if (env.type.startsWith("refund.")) {
    const refundStatus = str(p.status);
    const done = refundStatus === "completed" || refundStatus === "succeeded" || refundStatus === "refunded";
    if (!done) {
      await noteProviderEvent(row.id, lastEvent({ refundStatus }));
      return { note: `refund ${refundStatus ?? "pending"}; nothing to do yet` };
    }
    if (row.provider !== "titus") {
      // The row moved to card after this checkout was made: a Titus refund
      // must not relock a Stripe row (flagTitusOnCardRow).
      await noteProviderEvent(row.id, lastEvent({ refundStatus, ignored: "the invoice is no longer pay at close" }));
      await flagTitusOnCardRow(row, checkoutId, env.id, "refunded", "webhook");
      return { changed: false, drain: true, note: `refund ${refundStatus} at Titus, but the invoice moved to ${row.provider ?? "another provider"}; nothing relocked, flagged` };
    }
    const owed = row.amountCents ?? row.amountDue ?? 0;
    const dollars = num(p.amount);
    const cents = dollars != null ? Math.round(dollars * 100) : owed;
    const full = cents >= owed || p.full === true;
    const r = await relockForRefund(row.id, cents, full, { provider: "titus", providerRef: str(p.id), eventId: env.id });
    return { changed: r.changed, drain: r.changed };
  }

  // A row that is no longer pay at close: an admin switched it to card after
  // this checkout was made, and findInvoice still matched it through
  // metadata.invoice_id. Nothing from Titus may settle, move or retire a
  // Stripe row, and the row is never pointed back at a Titus id (that would
  // leave the open Stripe invoice payable and send a human to cancel a Stripe
  // id in the Titus dashboard). A funded checkout is money and goes to a human
  // (flagTitusOnCardRow); every other status is only noted.
  if (row.provider !== "titus") {
    await noteProviderEvent(row.id, lastEvent({ ignored: "the invoice is no longer pay at close" }));
    if (status !== "succeeded") return { changed: false, drain: false, note: `${env.type}${status ? ` (${status})` : ""} for a checkout whose invoice moved to card; noted` };
    await flagTitusOnCardRow(row, checkoutId, env.id, "funded", "webhook");
    return { changed: false, unlocked: false, drain: true, note: `succeeded at Titus for ${checkoutId ?? "a checkout"}, but the invoice moved to ${row.provider ?? "another provider"}; nothing settled, flagged` };
  }

  switch (env.type) {
    case "checkout.payment_failed": {
      const t = await transitionInvoice(row.id, "open", { from: ["processing"], lastEvent: lastEvent() });
      if (!t.changed) await noteProviderEvent(row.id, lastEvent());
      if (isPaid(row.status)) return { drain: false, note: "paid row; failure ignored" };
      await logActivity({ action: "invoice.payment_failed", listingId: row.listingId, clientId: row.clientId, meta: { invoiceId: row.id, provider: "titus", eventId: env.id, reason: str(p.failureReason) ?? str(p.reason) ?? null } });
      const l = await payLineFor(row.id);
      if (l) await post("failed", paymentsText.failed({ ...l, reason: str(p.failureReason) ?? str(p.reason) ?? null }));
      return { changed: t.changed, drain: true };
    }
    case "checkout.loan_application_under_review": {
      const t = await transitionInvoice(row.id, "review", {
        from: ["open", "processing"],
        lastEvent: lastEvent(),
        patch: { meta: { ...(row.meta ?? {}), loanDecision: loan ?? "awaiting-approval" } },
        activity: { action: "invoice.loan_review", meta: { provider: "titus", eventId: env.id, loanDecision: loan } },
      });
      if (!t.changed) await noteProviderEvent(row.id, lastEvent());
      if (t.changed) {
        const l = await payLineFor(row.id);
        if (l) await post("review", paymentsText.review(l));
      }
      return { changed: t.changed, drain: t.changed };
    }
    case "checkout.loan_application_approved": {
      // Approval is not money. Activity and a line in the payments channel; the
      // unlock waits for the succeeded status.
      await noteProviderEvent(row.id, lastEvent(), { meta: { ...(row.meta ?? {}), loanDecision: loan ?? "approved" } });
      if (isPaid(row.status)) return { drain: false, note: "paid row; approval noted" };
      await logActivity({ action: "invoice.loan_approved", listingId: row.listingId, clientId: row.clientId, meta: { invoiceId: row.id, provider: "titus", eventId: env.id, loanDecision: loan } });
      const l = await payLineFor(row.id);
      if (l) await post("approved", paymentsText.approved(l));
      return { changed: false, drain: true };
    }
    case "checkout.loan_application_denied": {
      const t = await transitionInvoice(row.id, "open", { from: ["review", "processing"], lastEvent: lastEvent(), patch: { meta: { ...(row.meta ?? {}), loanDecision: loan ?? "denied" } } });
      if (!t.changed) await noteProviderEvent(row.id, lastEvent(), { meta: { ...(row.meta ?? {}), loanDecision: loan ?? "denied" } });
      if (isPaid(row.status)) return { drain: false, note: "paid row; denial ignored" };
      await logActivity({ action: "invoice.loan_denied", listingId: row.listingId, clientId: row.clientId, meta: { invoiceId: row.id, provider: "titus", eventId: env.id, loanDecision: loan } });
      const l = await payLineFor(row.id);
      if (l) {
        await post("denied", paymentsText.denied(l));
        await enqueueJobs([
          {
            kind: "slack.issue",
            idempotencyKey: `slack.issue:loan_denied:${row.id}:${env.id}`,
            invoiceId: row.id,
            bookingId: row.bookingId,
            listingId: row.listingId,
            payload: { version: 1, channel: "bookings", note: hubTextPayAtCloseDeclined({ listing: l.listing, bookingId: row.bookingId, listingId: row.listingId }) },
          },
        ]);
      }
      return { changed: t.changed, drain: true };
    }
    default: {
      // checkout.created / checkout.updated and anything else about the
      // checkout: the entity's status decides.
      if (status === "succeeded") {
        // The checkout that was funded. Normally the one the row holds. When
        // the pay page recreated the checkout (a 404 incident) while the
        // client finished the earlier one, it is not: the earlier one paid,
        // and the newer one must not stay open for a second funding.
        const funded = checkoutId ?? row.providerId;
        const otherCheckout = Boolean(checkoutId) && Boolean(row.providerId) && checkoutId !== row.providerId;
        const r = await applyPaid(row.id, { provider: "titus", providerRef: funded, method: "pay_at_close", source: "webhook", eventId: env.id, metaPatch: loan ? { loanDecision: loan } : {} });
        if (!r.changed) {
          const replay = isPaid(row.status);
          await noteProviderEvent(row.id, lastEvent({ replay, ...(otherCheckout ? { otherCheckout: true } : {}) }));
          if (!replay) {
            // Funded at Titus, but the row is void, canceled or refunded: money
            // moved and nothing unlocked, so the hub hears.
            await flagUnsettledPaid(row.id, "titus", "webhook");
            return { changed: false, unlocked: false, drain: true, note: `succeeded at Titus but the row is ${row.status}; flagged` };
          }
          if (otherCheckout && checkoutId) {
            // Paid already, through a different checkout: the same shoot was
            // funded twice. Recorded and flagged; the refund is a human's call.
            await flagDuplicateTitusFunding(row, checkoutId, env.id);
            return { changed: false, unlocked: false, drain: true, note: `already ${row.status} through ${row.providerId}; a second funded checkout ${checkoutId} was flagged` };
          }
          return { changed: false, unlocked: false, drain: false, note: `already ${row.status}` };
        }
        if (otherCheckout && funded) {
          const s = await retireSupersededTitusCheckout(row, funded, "webhook");
          return { changed: true, unlocked: r.unlocked, drain: true, note: retireNote(funded, row.providerId, s) };
        }
        if (funded && !row.providerId) {
          // The row had forgotten this checkout (a reset) and it paid anyway:
          // point the row back at it so refunds and the admin page find it.
          // Only while the row still holds none: the pay at close button may
          // have made a newer checkout between the read at the top of handle()
          // and this write, and that one must not stay open at Titus with
          // nothing pointing at it. So when the write matched no row, the row
          // is re-read and the newer checkout retired like any superseded one.
          const pinned = await db()
            .update(schema.invoices)
            .set({ providerId: funded, updatedAt: new Date() })
            .where(and(eq(schema.invoices.id, row.id), isNull(schema.invoices.providerId)))
            .returning({ id: schema.invoices.id });
          if (!pinned.length) {
            const fresh = await db().query.invoices.findFirst({ where: eq(schema.invoices.id, row.id) });
            if (fresh?.providerId && fresh.providerId !== funded) {
              const s = await retireSupersededTitusCheckout(fresh, funded, "webhook");
              return { changed: true, unlocked: r.unlocked, drain: true, note: retireNote(funded, fresh.providerId, s) };
            }
          }
        }
        return { changed: true, unlocked: r.unlocked, drain: true };
      }
      if (status === "processing") {
        // Only the checkout the row holds moves it (like canceled and
        // requires-payment below): a processing event about a checkout the
        // pay page already replaced must not freeze the row that page is
        // serving for its successor, nor block the open-only reset.
        if (!(Boolean(checkoutId) && row.providerId === checkoutId)) {
          await noteProviderEvent(row.id, lastEvent({ ignored: "not the current checkout" }));
          return { changed: false, drain: false, note: "processing for a checkout the row does not hold" };
        }
        const t = await transitionInvoice(row.id, "processing", { from: ["open"], lastEvent: lastEvent(), activity: { action: "invoice.processing", meta: { provider: "titus", eventId: env.id } } });
        if (!t.changed) await noteProviderEvent(row.id, lastEvent());
        return { changed: t.changed, drain: false };
      }
      if (status === "canceled") {
        // Only the checkout we hold; a cancel about a checkout we already
        // replaced is just noted.
        if (checkoutId && row.providerId === checkoutId) {
          const t = await resetTitusCheckout(row.id, lastEvent(), checkoutId);
          if (t.changed) {
            const l = await payLineFor(row.id);
            if (l) await post("canceled", paymentsText.canceled(l));
          } else await noteProviderEvent(row.id, lastEvent({ ignored: true }));
          return { changed: t.changed, drain: t.changed };
        }
        await noteProviderEvent(row.id, lastEvent({ ignored: "not the current checkout" }));
        return { changed: false, drain: false, note: "cancel for a replaced checkout" };
      }
      if (status === "requires-payment") {
        // After a failed attempt the checkout is open again. The URL is
        // refreshed only for the checkout the row holds: a created event about
        // one the pay page already replaced must not hand out a dead URL.
        const current = Boolean(checkoutId) && row.providerId === checkoutId;
        const t = row.status === "processing" && current ? await transitionInvoice(row.id, "open", { from: ["processing"], lastEvent: lastEvent() }) : { changed: false };
        if (!t.changed) await noteProviderEvent(row.id, lastEvent(current ? {} : { ignored: "not the current checkout" }), current ? { hostedUrl: str(p.checkoutUrl) ?? row.hostedUrl } : {});
        return { changed: t.changed, drain: false };
      }
      await noteProviderEvent(row.id, lastEvent());
      return { changed: false, drain: false, note: status ? `status ${status} noted` : "no status in payload" };
    }
  }
}

export async function POST(request: Request) {
  const raw = await request.text();
  const secret = (process.env.TITUS_WEBHOOK_SECRET || "").trim();
  if (!secret || !hasDb()) return Response.json({ ok: false, error: "not configured" }, { status: 503 });

  const timestamp = (request.headers.get("x-webhook-timestamp") || "").trim();
  const signature = (request.headers.get("x-webhook-signature") || "").trim();
  if (!verifyTitusSignature(raw, timestamp, signature, secret)) {
    await logWebhookRejected("titus", "bad signature");
    return Response.json({ ok: false, error: "bad signature" }, { status: 401 });
  }
  const env = parseEnvelope(raw);
  if (!env) return Response.json({ ok: false, error: "bad envelope" }, { status: 400 });

  // Timestamp in ms (seconds are tolerated); older than 5 min = stale.
  const tsRaw = Number(timestamp);
  const tsMs = Number.isFinite(tsRaw) ? (tsRaw < 1e12 ? tsRaw * 1000 : tsRaw) : NaN;
  const stale = !Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TITUS_WEBHOOK_TOLERANCE_MS;

  const d = db();
  const row = await findInvoice(d, env.type, env.payload);
  // Another environment's checkout: recorded, then left to that environment.
  const metaEnv = str(obj(env.payload.metadata)?.env);
  const otherEnv = row ? (isOtherEnv(row.env) ? rowEnv(row.env) : null) : metaEnv && metaEnv !== currentEnv() ? metaEnv : null;
  const rec = await recordPaymentEvent({
    provider: "titus",
    providerEventId: env.id,
    type: env.type,
    objectId: checkoutIdOf(env.type, env.payload),
    invoiceId: row?.id ?? null,
    status: str(env.payload.status),
    signatureOk: true,
    stale,
    payload: env as unknown as Record<string, unknown>,
    env: currentEnv(),
  });
  if (rec.duplicate && rec.processedAt) return Response.json({ ok: true, duplicate: true });
  if (otherEnv) {
    const note = `belongs to the ${otherEnv} environment`;
    await markEventProcessed(rec.id, note);
    return Response.json({ ok: true, matched: Boolean(row), type: env.type, stale, changed: false, unlocked: false, note });
  }

  try {
    let result: Handled;
    if (!row) result = { note: stale ? "stale; no matching invoice" : "no matching invoice" };
    else if (stale) {
      // A valid but old delivery never acts on its payload: the checkout is
      // read back from Titus and only that answer moves anything. A stale
      // refund.* delivery is the one case this cannot replay (the checkout
      // read says nothing about refunds), so it is flagged in the note for an
      // operator to check in Titus; a real refund also arrives fresh on retry.
      const s = await syncInvoiceFromProvider(row.id, "webhook_stale");
      const refundNote = env.type.startsWith("refund.") ? "; a stale refund is not replayed, check Titus" : "";
      result = { changed: s.changed, unlocked: s.unlocked, drain: s.changed, note: `stale; synced (${s.skipped ?? s.error ?? s.providerStatus ?? "ok"})${refundNote}` };
    } else result = await handle(env, row);
    await markEventProcessed(rec.id, result.note ?? null);
    const invoiceId = row?.id ?? null;
    if (result.drain && invoiceId) {
      after(async () => {
        try {
          await drainJobs({ budgetMs: 25_000, invoiceId });
        } catch (e) {
          console.error("[titus-webhook] drain:", e);
        }
      });
    }
    return Response.json({ ok: true, matched: Boolean(row), type: env.type, stale, changed: Boolean(result.changed), unlocked: Boolean(result.unlocked), note: result.note ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[titus-webhook]", env.type, message);
    await recordEventError(rec.id, message).catch(() => {});
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
