// POST /api/studio/payments/test-event { invoiceId, type, overrides? }
// Operator-only (src/lib/payments-test.ts: MIGRATE_TOKEN, never production,
// test client only). Builds a synthetic Stripe event for OUR stored Stripe
// invoice, signs it with THIS deployment's STRIPE_WEBHOOK_SECRET
// (stripe.webhooks.generateTestHeaderString) and POSTs it to this same
// deployment's /api/portal/stripe-webhook, so the real route, the signature
// check, the dedupe in payment_events and applyPaid all run exactly as they
// would for Stripe's own delivery. Returns the webhook's status and JSON and
// the invoice snapshot after.
//
// The invoice is fetched from Stripe first, so the ids, the amounts, the
// customer email and the hosted url are real; then the fields the type implies
// are set:
//   invoice.paid                 status paid, amount_paid = amount_due, a
//                                payments list with a payment intent and charge
//                                (the invoice's own when it has them, else
//                                synthetic pi_test_… / ch_test_… ids, returned
//                                as `refs` so charge.refunded can match later)
//   invoice.payment_failed       status open, attempt_count + 1
//   invoice.voided               status void
//   invoice.marked_uncollectible status uncollectible
//   invoice.finalized            status open
//   charge.refunded              a Charge: amount, amount_refunded, refunded,
//                                payment_intent from the invoice's payments
//                                when present (else our stored refs)
// overrides: { eventId (replay a duplicate), paymentIntent, charge, amount,
// amountRefunded, refunded, attemptCount, object (shallow-merged last) }.
//
// Stripe itself is told NOTHING by this route: after a synthetic invoice.paid
// the real Stripe invoice is still OPEN at Stripe, which is why the caller
// voids it afterwards (admin-api deleteBooking with voidInvoice: true).
import type Stripe from "stripe";
import { stripePaymentRefs } from "@/lib/payments";
import { invoiceSnapshot, loadTestInvoice, num, postSelf, randomHex, rec, str, testGuard } from "@/lib/payments-test";
import { hasStripe, stripeClient } from "@/lib/stripe-invoice";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TYPES = ["invoice.paid", "invoice.payment_failed", "invoice.voided", "invoice.marked_uncollectible", "invoice.finalized", "charge.refunded"] as const;
type TestType = (typeof TYPES)[number];

export async function POST(request: Request) {
  const denied = testGuard(request);
  if (denied) return denied;
  const b = rec(await request.json().catch(() => ({})));
  const invoiceId = str(b.invoiceId) ?? "";
  const type = str(b.type) ?? "";
  const o = rec(b.overrides);
  if (!invoiceId) return Response.json({ ok: false, error: "invoiceId required" }, { status: 400 });
  if (!(TYPES as readonly string[]).includes(type)) return Response.json({ ok: false, error: `type must be one of ${TYPES.join(", ")}` }, { status: 400 });
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!hasStripe() || !secret) return Response.json({ ok: false, error: "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must both be set on this deployment" }, { status: 409 });
  const loaded = await loadTestInvoice(invoiceId);
  if (loaded.denied) return loaded.denied;
  const inv = loaded.inv;
  if (inv.provider !== "stripe" || !inv.providerId) return Response.json({ ok: false, error: `not an issued Stripe invoice (provider ${inv.provider ?? "unset"}, provider id ${inv.providerId ?? "none"})` }, { status: 409 });

  const stripe = stripeClient();
  const real = await stripe.invoices.retrieve(inv.providerId);
  const now = Math.floor(Date.now() / 1000);
  const refs = stripePaymentRefs(real);
  const paymentIntent = str(o.paymentIntent) ?? refs.paymentIntent ?? inv.meta?.stripePaymentIntent ?? `pi_test_${randomHex(12)}`;
  const charge = str(o.charge) ?? refs.charge ?? inv.meta?.stripeCharge ?? `ch_test_${randomHex(12)}`;

  let object: Record<string, unknown>;
  if (type === "charge.refunded") {
    const amount = num(o.amount) ?? (real.amount_paid || real.amount_due);
    const amountRefunded = num(o.amountRefunded) ?? amount;
    object = {
      id: charge,
      object: "charge",
      amount,
      amount_refunded: amountRefunded,
      refunded: typeof o.refunded === "boolean" ? o.refunded : amountRefunded >= amount,
      payment_intent: paymentIntent,
      invoice: real.id,
      customer: typeof real.customer === "string" ? real.customer : real.customer?.id ?? null,
      currency: real.currency,
      status: "succeeded",
      livemode: real.livemode,
      metadata: { ...(real.metadata ?? {}) },
      ...rec(o.object),
    };
  } else {
    // A plain copy of the real invoice (drops the SDK's lastResponse).
    const base = JSON.parse(JSON.stringify(real)) as Record<string, unknown>;
    delete base.lastResponse;
    const transitions = { ...(real.status_transitions ?? {}) } as Record<string, unknown>;
    switch (type as TestType) {
      case "invoice.paid": {
        const payments: Stripe.ApiList<Stripe.InvoicePayment> = {
          object: "list",
          data: [
            {
              id: `inpay_test_${randomHex(8)}`,
              object: "invoice_payment",
              amount_paid: real.amount_due,
              amount_requested: real.amount_due,
              created: now,
              currency: real.currency,
              invoice: real.id,
              is_default: true,
              livemode: real.livemode,
              payment: { type: "payment_intent", payment_intent: paymentIntent, charge },
              status: "paid",
              status_transitions: { canceled_at: null, paid_at: now },
            },
          ],
          has_more: false,
          url: `/v1/invoices/${real.id}/payments`,
        };
        Object.assign(base, { status: "paid", paid: true, amount_paid: real.amount_due, amount_remaining: 0, attempted: true, status_transitions: { ...transitions, paid_at: now }, payments });
        break;
      }
      case "invoice.payment_failed":
        Object.assign(base, { status: "open", attempted: true, attempt_count: num(o.attemptCount) ?? (real.attempt_count ?? 0) + 1 });
        break;
      case "invoice.voided":
        Object.assign(base, { status: "void", status_transitions: { ...transitions, voided_at: now } });
        break;
      case "invoice.marked_uncollectible":
        Object.assign(base, { status: "uncollectible", status_transitions: { ...transitions, marked_uncollectible_at: now } });
        break;
      case "invoice.finalized":
        Object.assign(base, { status: "open", status_transitions: { ...transitions, finalized_at: transitions.finalized_at ?? now } });
        break;
      default:
        break;
    }
    object = { ...base, ...rec(o.object) };
  }

  const eventId = str(o.eventId) ?? `evt_test_${randomHex(12)}`;
  const event = {
    id: eventId,
    object: "event",
    api_version: null,
    created: now,
    livemode: real.livemode,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const webhook = await postSelf(request, "/api/portal/stripe-webhook", payload, { "stripe-signature": header });
  const snap = await invoiceSnapshot(inv.id);
  return Response.json({
    ok: webhook.status >= 200 && webhook.status < 300,
    eventId,
    type,
    refs: { paymentIntent, charge },
    stripeStatusAtProvider: real.status,
    note: "Stripe was told nothing: the real Stripe invoice keeps its status at Stripe. Void it through admin-api deleteBooking { voidInvoice: true } when the run is over.",
    webhook,
    ...snap,
  });
}
