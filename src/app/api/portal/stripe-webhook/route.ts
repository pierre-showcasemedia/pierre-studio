// Stripe → studio (docs/booking-to-payment.md, "Stripe"). Every
// delivery is verified on the raw body, recorded in payment_events BEFORE it
// is acted on (a replay with processed_at set is answered 200 at once; one
// whose processing died is re-processed), matched to our invoice row, then
// dispatched:
//   invoice.paid                 → applyPaid (the ONLY path to an unlock here)
//   invoice.payment_failed       → back to open, activity, payments channel
//   invoice.voided /
//   invoice.marked_uncollectible → void, activity, payments channel
//   invoice.finalized / updated  → hosted url, amounts, number in sync; never
//                                  downgrades a paid row
//   charge.refunded              → relockForRefund (full relocks, partial logs)
// If processing throws, processed_at stays NULL and Stripe gets a 500 so it
// retries. Register exactly these event types on the endpoint
// (docs/booking-to-payment.md, "Stripe").
//
// Matching, in order of confidence: metadata.invoice_id (our uuid, set by the
// stripe.invoice.create job), then the stored Stripe id, then the legacy
// street match for invoices made in the Stripe Dashboard before step one.
//
// One Stripe account, one endpoint (production), one database shared with the
// previews: an invoice a preview created (metadata.env, or the env of the row
// it matched) is that preview's to settle through its own sync hooks, so
// production only records the delivery. Rows and events with no env are
// production's. An event about a Stripe invoice the row no longer holds (the
// admin reissued it) is noted and changes nothing, except a payment, which is
// still money.
import Stripe from "stripe";
import { after } from "next/server";
import { and, eq, or, sql } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { InvoiceStatus } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { drainJobs } from "@/lib/jobs";
import { currentEnv, enqueueJobs } from "@/lib/jobs-core";
import {
  applyPaid,
  flagUnsettledPaid,
  isOtherEnv,
  isPaid,
  logWebhookRejected,
  markEventProcessed,
  noteProviderEvent,
  payLineFor,
  recordEventError,
  recordPaymentEvent,
  relockForRefund,
  rowEnv,
  STRIPE_PAID_FROM,
  stripePaymentRefs,
  transitionInvoice,
} from "@/lib/payments";
import { paymentsText } from "@/lib/slack";

export const dynamic = "force-dynamic";
// The after() drain (the payments channel line) runs past the response.
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type InvoiceRow = typeof schema.invoices.$inferSelect;
type Db = ReturnType<typeof db>;

const byStripeId = (id: string) => or(eq(schema.invoices.stripeInvoiceId, id), and(eq(schema.invoices.provider, "stripe"), eq(schema.invoices.providerId, id)));

async function matchInvoice(d: Db, inv: Stripe.Invoice): Promise<InvoiceRow | null> {
  const metaId = inv.metadata?.invoice_id;
  if (metaId && UUID_RE.test(metaId)) {
    const row = await d.query.invoices.findFirst({ where: eq(schema.invoices.id, metaId) });
    if (row) return row;
  }
  return (await d.query.invoices.findFirst({ where: byStripeId(inv.id) })) ?? null;
}

// Pre-step-one invoices (made in the Dashboard): match the listing by street
// and customer email, then keep a row keyed by the Stripe id. The row is never
// inserted as paid: invoice.paid moves it through applyPaid like any other.
async function legacyUpsert(d: Db, inv: Stripe.Invoice): Promise<InvoiceRow | null> {
  const email = (inv.customer_email || "").toLowerCase();
  const address = (inv.metadata?.property_address || "").trim();
  const matchByStreet = async (candidate: string) => {
    const street = candidate.split(",")[0].split("—")[0].trim().toLowerCase();
    if (street.length < 5) return null; // "Thank you!" style memos never match
    const all = await d.query.listings.findMany({ with: { client: true } });
    const hit = all.find((l) => l.address.toLowerCase().startsWith(street) && (!email || l.client.email === email));
    return hit ?? null;
  };
  let listing = address ? await matchByStreet(address) : null;
  if (!listing && inv.description) listing = await matchByStreet(inv.description);
  const stripeStatus = inv.status ?? "draft";
  const insertStatus = stripeStatus === "paid" ? "open" : stripeStatus;
  await d
    .insert(schema.invoices)
    .values({
      stripeInvoiceId: inv.id,
      listingId: listing?.id ?? null,
      clientId: listing?.clientId ?? null,
      clientEmail: email || null,
      propertyAddress: address || listing?.address || null,
      status: insertStatus,
      amountDue: inv.amount_due ?? null,
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      provider: "stripe",
      providerId: inv.id,
      hostedUrl: inv.hosted_invoice_url ?? null,
      orderId: inv.number ?? null,
      amountCents: inv.amount_due ?? null,
      currency: inv.currency ?? "usd",
      method: "card",
      description: inv.description ?? null,
      meta: { invoiceType: inv.metadata?.invoice_type || "production", note: "matched from a Stripe webhook (legacy invoice)" },
      // Owned by the environment that saw it (a NULL env would make it
      // production's, and production's reconcile would GET a preview invoice
      // with the wrong key forever). The on-conflict set leaves env alone.
      env: currentEnv(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.invoices.stripeInvoiceId,
      set: {
        // Never downgrade a paid row from a late or replayed event.
        status: sql`CASE WHEN ${schema.invoices.status} IN ('paid', 'paid_manual', 'refunded') THEN ${schema.invoices.status} ELSE ${insertStatus} END`,
        amountDue: inv.amount_due ?? null,
        amountCents: sql`COALESCE(${schema.invoices.amountCents}, ${inv.amount_due ?? null})`,
        hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
        hostedUrl: inv.hosted_invoice_url ?? null,
        provider: sql`COALESCE(${schema.invoices.provider}, 'stripe')`,
        providerId: sql`COALESCE(${schema.invoices.providerId}, ${inv.id})`,
        ...(listing ? { listingId: sql`COALESCE(${schema.invoices.listingId}, ${listing.id})`, clientId: sql`COALESCE(${schema.invoices.clientId}, ${listing.clientId})` } : {}),
        updatedAt: new Date(),
      },
    });
  return (await d.query.invoices.findFirst({ where: byStripeId(inv.id) })) ?? null;
}

// A refund arrives as a charge. We remember the payment intent and charge that
// paid each invoice (meta.stripePaymentIntent / stripeCharge at invoice.paid);
// older rows fall back to Stripe's invoice payments list.
async function matchCharge(d: Db, stripe: Stripe, charge: Stripe.Charge): Promise<InvoiceRow | null> {
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
  if (pi) {
    const byMeta = await d.query.invoices.findFirst({ where: and(eq(schema.invoices.provider, "stripe"), sql`${schema.invoices.meta}->>'stripePaymentIntent' = ${pi}`) });
    if (byMeta) return byMeta;
    try {
      const list = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 1 });
      const ref = list.data[0]?.invoice;
      const invId = typeof ref === "string" ? ref : ref?.id ?? null;
      if (invId) {
        const row = await d.query.invoices.findFirst({ where: byStripeId(invId) });
        if (row) return row;
      }
    } catch (e) {
      console.warn("[stripe-webhook] invoice payments lookup failed:", e instanceof Error ? e.message : e);
    }
  }
  return (await d.query.invoices.findFirst({ where: and(eq(schema.invoices.provider, "stripe"), sql`${schema.invoices.meta}->>'stripeCharge' = ${charge.id}`) })) ?? null;
}

// The method label on the payments channel line ("card" or "bank transfer"):
// one retrieve, best effort, never blocks the unlock.
async function payNowMethodFor(stripe: Stripe, paymentIntent: string | null): Promise<string | null> {
  if (!paymentIntent) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ["payment_method"] });
    const pm = pi.payment_method;
    return pm && typeof pm !== "string" ? pm.type : null;
  } catch {
    return null;
  }
}

type Handled = { changed?: boolean; unlocked?: boolean; drain?: boolean; note?: string | null };

async function handle(stripe: Stripe, event: Stripe.Event, row: InvoiceRow | null): Promise<Handled> {
  const at = new Date().toISOString();
  const lastEvent = (extra: Record<string, unknown> = {}) => ({ type: event.type, at, eventId: event.id, provider: "stripe", ...extra });
  if (event.type === "charge.refunded") {
    if (!row) return { note: "no matching invoice", drain: false };
    const charge = event.data.object as Stripe.Charge;
    const full = charge.refunded === true || charge.amount_refunded >= charge.amount;
    const r = await relockForRefund(row.id, charge.amount_refunded, full, { provider: "stripe", providerRef: charge.id, eventId: event.id });
    return { changed: r.changed, drain: r.changed };
  }
  const inv = event.data.object as Stripe.Invoice;
  if (!row) return { note: "no matching invoice", drain: false };
  // The row was matched by metadata.invoice_id but holds (or held) another
  // Stripe invoice: the admin reissued it. A payment on the old object is
  // still money; anything else about it must not move the current one.
  const replaced = (row.meta?.replacedProviderIds ?? []).includes(inv.id) || (Boolean(row.providerId) && row.providerId !== inv.id && row.stripeInvoiceId !== inv.id);
  if (replaced && event.type !== "invoice.paid") {
    await noteProviderEvent(row.id, lastEvent({ status: inv.status ?? null, ignored: "replaced Stripe invoice", stripeInvoice: inv.id }));
    return { changed: false, drain: false, note: `event for a replaced Stripe invoice ${inv.id}` };
  }
  switch (event.type) {
    case "invoice.paid": {
      const refs = stripePaymentRefs(inv);
      const payNowMethod = await payNowMethodFor(stripe, refs.paymentIntent);
      const r = await applyPaid(row.id, {
        provider: "stripe",
        providerRef: inv.id,
        method: "card",
        payNowMethod,
        source: "webhook",
        eventId: event.id,
        from: STRIPE_PAID_FROM,
        invoiceType: inv.metadata?.invoice_type ?? null,
        metaPatch: { ...(refs.paymentIntent ? { stripePaymentIntent: refs.paymentIntent } : {}), ...(refs.charge ? { stripeCharge: refs.charge } : {}) },
      });
      if (!r.changed) {
        const replay = isPaid(row.status);
        await noteProviderEvent(row.id, lastEvent({ status: inv.status ?? null, replay }));
        // Paid at Stripe, but the row is void, canceled, refunded or waiting
        // on a quote: money moved and nothing unlocked, so the hub hears.
        if (!replay) await flagUnsettledPaid(row.id, "stripe", "webhook");
        return { changed: false, unlocked: false, drain: !replay, note: replay ? `already ${row.status}` : `paid at Stripe but the row is ${row.status}; flagged` };
      }
      return { changed: true, unlocked: r.unlocked, drain: true };
    }
    case "invoice.payment_failed": {
      const t = await transitionInvoice(row.id, "open", { from: ["processing"], lastEvent: lastEvent({ attempts: inv.attempt_count }) });
      if (!t.changed) await noteProviderEvent(row.id, lastEvent({ attempts: inv.attempt_count }));
      if (isPaid(row.status)) return { drain: false, note: "paid row; failure ignored" };
      await logActivity({ action: "invoice.payment_failed", listingId: row.listingId, clientId: row.clientId, meta: { invoiceId: row.id, provider: "stripe", eventId: event.id, attempts: inv.attempt_count } });
      const line = await payLineFor(row.id);
      if (line) {
        await enqueueJobs([
          {
            kind: "slack.payment",
            idempotencyKey: `slack.payment:failed:${row.id}:${event.id}`,
            invoiceId: row.id,
            bookingId: row.bookingId,
            listingId: row.listingId,
            payload: { version: 1, text: paymentsText.failed({ ...line, reason: inv.attempt_count ? `attempt ${inv.attempt_count}` : null }) },
          },
        ]);
      }
      return { changed: t.changed, drain: true };
    }
    case "invoice.voided":
    case "invoice.marked_uncollectible": {
      // Voided is final. Uncollectible is Stripe's bad-debt flag and the hosted
      // invoice still takes a payment, so the row keeps that status (it is in
      // STRIPE_PAID_FROM, so a later invoice.paid settles it) instead of void.
      const to: InvoiceStatus = event.type === "invoice.voided" ? "void" : "uncollectible";
      const from: InvoiceStatus[] = to === "void" ? ["needs_quote", "open", "processing", "review", "draft", "uncollectible"] : ["needs_quote", "open", "processing", "review", "draft"];
      const t = await transitionInvoice(row.id, to, {
        from,
        lastEvent: lastEvent({ stripeStatus: inv.status ?? null }),
        activity: { action: to === "void" ? "invoice.voided" : "invoice.uncollectible", meta: { provider: "stripe", eventId: event.id, stripeStatus: inv.status ?? null } },
      });
      if (!t.changed) {
        await noteProviderEvent(row.id, lastEvent({ stripeStatus: inv.status ?? null, ignored: true }));
        return { changed: false, drain: false, note: `row is ${row.status}; not moved to ${to}` };
      }
      const line = await payLineFor(row.id);
      if (line) {
        await enqueueJobs([{ kind: "slack.payment", idempotencyKey: `slack.payment:${to}:${row.id}:${event.id}`, invoiceId: row.id, bookingId: row.bookingId, listingId: row.listingId, payload: { version: 1, text: to === "void" ? paymentsText.voided(line) : paymentsText.uncollectible(line) } }]);
      }
      return { changed: true, drain: true };
    }
    default: {
      // invoice.finalized, invoice.updated, invoice.created, invoice.sent, …:
      // keep what the client sees in step; the status moves only through the
      // events above (draft → open is the one upgrade allowed here).
      const patch: Partial<typeof schema.invoices.$inferInsert> = {
        hostedUrl: inv.hosted_invoice_url ?? row.hostedUrl,
        hostedInvoiceUrl: inv.hosted_invoice_url ?? row.hostedInvoiceUrl,
        amountDue: typeof inv.amount_due === "number" ? inv.amount_due : row.amountDue,
        orderId: inv.number ?? row.orderId,
      };
      if (row.status === "draft" && inv.status === "open") patch.status = "open";
      await noteProviderEvent(row.id, lastEvent({ status: inv.status ?? null }), patch);
      return { changed: Boolean(patch.status), drain: false };
    }
  }
}

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key || !hasDb()) {
    return Response.json({ ok: false, error: "not configured" }, { status: 503 });
  }
  const stripe = new Stripe(key);
  const raw = await request.text();
  let event: Stripe.Event;
  try {
    const sig = request.headers.get("stripe-signature") || "";
    event = await stripe.webhooks.constructEventAsync(raw, sig, secret);
  } catch (e) {
    console.error("stripe-webhook signature:", e);
    await logWebhookRejected("stripe", "bad signature");
    return Response.json({ ok: false, error: "bad signature" }, { status: 400 });
  }

  const wanted = event.type.startsWith("invoice.") || event.type === "charge.refunded";
  if (!wanted) return Response.json({ ok: true, ignored: event.type });
  const d = db();
  const obj = event.data.object as unknown as { id?: string; status?: string | null };

  // Match first, so the event row carries the invoice id from the start. An
  // invoice another environment created is recorded and left to it: never
  // upserted here, never settled here (its Slack line would run with this
  // environment's keys).
  let row: InvoiceRow | null = null;
  let otherEnv: string | null = null;
  if (event.type.startsWith("invoice.")) {
    const inv = event.data.object as Stripe.Invoice;
    row = await matchInvoice(d, inv);
    const metaEnv = (inv.metadata?.env || "").trim() || null;
    if (row) {
      if (isOtherEnv(row.env)) otherEnv = rowEnv(row.env);
    } else if (metaEnv && metaEnv !== currentEnv()) {
      otherEnv = metaEnv;
    } else {
      row = await legacyUpsert(d, inv);
    }
  } else {
    row = await matchCharge(d, stripe, event.data.object as Stripe.Charge);
    if (row && isOtherEnv(row.env)) otherEnv = rowEnv(row.env);
  }

  const rec = await recordPaymentEvent({
    provider: "stripe",
    providerEventId: event.id,
    type: event.type,
    objectId: obj.id ?? null,
    invoiceId: row?.id ?? null,
    status: obj.status ?? null,
    signatureOk: true,
    stale: false,
    payload: event as unknown as Record<string, unknown>,
    env: currentEnv(),
  });
  if (rec.duplicate && rec.processedAt) return Response.json({ ok: true, duplicate: true });
  if (otherEnv) {
    const note = `belongs to the ${otherEnv} environment`;
    await markEventProcessed(rec.id, note);
    return Response.json({ ok: true, matched: Boolean(row), type: event.type, changed: false, unlocked: false, note });
  }

  try {
    const result = await handle(stripe, event, row);
    await markEventProcessed(rec.id, result.note ?? null);
    const invoiceId = row?.id ?? null;
    if (result.drain && invoiceId) {
      after(async () => {
        try {
          await drainJobs({ budgetMs: 25_000, invoiceId });
        } catch (e) {
          console.error("[stripe-webhook] drain:", e);
        }
      });
    }
    return Response.json({ ok: true, matched: Boolean(row), type: event.type, changed: Boolean(result.changed), unlocked: Boolean(result.unlocked), note: result.note ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[stripe-webhook]", event.type, message);
    await recordEventError(rec.id, message).catch(() => {});
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
