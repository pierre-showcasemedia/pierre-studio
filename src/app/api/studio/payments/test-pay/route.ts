// POST /api/studio/payments/test-pay { invoiceId }
// Operator-only (src/lib/payments-test.ts: MIGRATE_TOKEN, never production,
// test client only), and ONLY when STRIPE_SECRET_KEY is a TEST key (sk_test_):
// a live key answers 403 "live key" and nothing is charged. In test mode it
// pays the invoice for real at Stripe (finalize first if it is still a draft,
// then stripe.invoices.pay with the pm_card_visa test card) and returns the
// Stripe status. Stripe's own invoice.paid delivery then proves the genuine
// Stripe-originated path, when the owner has pointed a test-mode webhook at this
// deployment; otherwise POST /api/studio/payments/sync settles the row from
// the provider read.
import { invoiceSnapshot, loadTestInvoice, rec, str, testGuard } from "@/lib/payments-test";
import { stripeClient } from "@/lib/stripe-invoice";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const denied = testGuard(request);
  if (denied) return denied;
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) return Response.json({ ok: false, error: "STRIPE_SECRET_KEY is not set on this deployment" }, { status: 409 });
  if (!key.startsWith("sk_test_")) return Response.json({ ok: false, error: "live key: this deployment's Stripe key is not a test key, so nothing is paid from here" }, { status: 403 });
  const b = rec(await request.json().catch(() => ({})));
  const invoiceId = str(b.invoiceId) ?? "";
  if (!invoiceId) return Response.json({ ok: false, error: "invoiceId required" }, { status: 400 });
  const loaded = await loadTestInvoice(invoiceId);
  if (loaded.denied) return loaded.denied;
  const inv = loaded.inv;
  if (inv.provider !== "stripe" || !inv.providerId) return Response.json({ ok: false, error: `not an issued Stripe invoice (provider ${inv.provider ?? "unset"}, provider id ${inv.providerId ?? "none"})` }, { status: 409 });
  const stripe = stripeClient();
  let s = await stripe.invoices.retrieve(inv.providerId);
  const before = s.status;
  if (s.status === "draft") s = await stripe.invoices.finalizeInvoice(inv.providerId, { auto_advance: true });
  if (s.status === "open") s = await stripe.invoices.pay(inv.providerId, { payment_method: "pm_card_visa" });
  const snap = await invoiceSnapshot(inv.id);
  return Response.json({
    ok: true,
    stripeInvoice: s.id,
    stripeStatusBefore: before,
    stripeStatus: s.status,
    paidAtStripe: s.status === "paid",
    note: "Stripe's own invoice.paid webhook settles the row when a test-mode endpoint points at this deployment; otherwise POST /api/studio/payments/sync { invoiceId } reads it back.",
    ...snap,
  });
}
