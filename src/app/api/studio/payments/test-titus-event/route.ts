// POST /api/studio/payments/test-titus-event { invoiceId, type, status?, loanDecision?, overrides? }
// Operator-only (src/lib/payments-test.ts: MIGRATE_TOKEN, never production,
// test client only). The Titus twin of test-event: a synthetic Titus webhook
// envelope for OUR stored pay at close checkout, signed with THIS deployment's
// TITUS_WEBHOOK_SECRET exactly the way src/lib/titus.ts verifies it (hex
// HMAC-SHA256 of `${timestamp}.${rawBody}`, timestamp in ms) and POSTed to
// this same deployment's /api/portal/titus-webhook. 409 with a clear message
// when TITUS_WEBHOOK_SECRET is unset: the route is never weakened to take an
// unsigned delivery, and those cases are reported as not exercised.
//
// Envelope { id, createdAt, type, payload }. payload for checkout.* is
// { id: the invoice's provider_id (or overrides.checkoutId), status,
//   loanDecision, orderId: the listing id, externalCustomerId, amount in
//   dollars, checkoutUrl, metadata: { listing_id, invoice_id, booking_id, env } };
// for refund.* it is { id: ref_test_…, checkoutId, status, amount, full? }.
// Defaults: status requires-payment (checkout.*), processing (loan_*),
// completed (refund.*); loanDecision awaiting-approval / approved / denied for
// the three loan types. overrides: { eventId (replay a duplicate), checkoutId,
// timestampMs (send a stale one), refundId, amount, full, payload (merged last) }.
//
// Titus itself is told nothing: a checkout that was never funded stays as it
// is at Titus, and the tester cancels it through the API before the booking is
// deleted.
import { createHmac } from "node:crypto";
import { invoiceSnapshot, loadTestInvoice, num, postSelf, randomHex, rec, str, testGuard } from "@/lib/payments-test";
import { TITUS_WEBHOOK_TOLERANCE_MS } from "@/lib/titus";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TYPES = [
  "checkout.created",
  "checkout.updated",
  "checkout.payment_failed",
  "checkout.loan_application_under_review",
  "checkout.loan_application_approved",
  "checkout.loan_application_denied",
  "refund.created",
  "refund.updated",
] as const;

function defaultStatus(type: string): string {
  if (type.startsWith("refund.")) return "completed";
  if (type.startsWith("checkout.loan_application_")) return "processing";
  return "requires-payment";
}

function defaultLoanDecision(type: string): string | null {
  if (type === "checkout.loan_application_under_review") return "awaiting-approval";
  if (type === "checkout.loan_application_approved") return "approved";
  if (type === "checkout.loan_application_denied") return "denied";
  return null;
}

export async function POST(request: Request) {
  const denied = testGuard(request);
  if (denied) return denied;
  const b = rec(await request.json().catch(() => ({})));
  const invoiceId = str(b.invoiceId) ?? "";
  const type = str(b.type) ?? "";
  const o = rec(b.overrides);
  if (!invoiceId) return Response.json({ ok: false, error: "invoiceId required" }, { status: 400 });
  if (!(TYPES as readonly string[]).includes(type)) return Response.json({ ok: false, error: `type must be one of ${TYPES.join(", ")}` }, { status: 400 });
  const secret = (process.env.TITUS_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return Response.json({ ok: false, error: "TITUS_WEBHOOK_SECRET is not set on this deployment, so the Titus webhook answers 503 and these cases cannot be exercised here (the route is never weakened to accept an unsigned delivery)" }, { status: 409 });
  }
  const loaded = await loadTestInvoice(invoiceId);
  if (loaded.denied) return loaded.denied;
  const inv = loaded.inv;
  if (inv.provider !== "titus") return Response.json({ ok: false, error: `not a pay at close invoice (provider ${inv.provider ?? "unset"})` }, { status: 409 });
  const checkoutId = str(o.checkoutId) ?? inv.providerId;
  if (!checkoutId) return Response.json({ ok: false, error: "the invoice has no checkout id yet; run its titus.checkout.create job first or pass overrides.checkoutId" }, { status: 409 });
  // Titus ids are UUIDs. A made-up id must look like one, or the row ends up
  // holding a provider_id that Titus rejects with a validation error instead
  // of a 404, and the cleanup's provider read cannot tell "gone" from "bad".
  if (str(o.checkoutId) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(checkoutId)) {
    return Response.json({ ok: false, error: "overrides.checkoutId must be a UUID, as every Titus checkout id is (any random UUID will do)" }, { status: 400 });
  }

  const status = str(b.status) ?? defaultStatus(type);
  const loanDecision = str(b.loanDecision) ?? defaultLoanDecision(type);
  const dollars = Math.round(inv.amountCents ?? inv.amountDue ?? 0) / 100;
  const metadata = { listing_id: inv.listingId ?? "", invoice_id: inv.id, booking_id: inv.bookingId ?? "", env: inv.env ?? "" };
  const payload: Record<string, unknown> = type.startsWith("refund.")
    ? {
        id: str(o.refundId) ?? `ref_test_${randomHex(10)}`,
        checkoutId,
        status,
        amount: num(o.amount) ?? dollars,
        ...(typeof o.full === "boolean" ? { full: o.full } : {}),
        metadata,
        ...rec(o.payload),
      }
    : {
        id: checkoutId,
        status,
        ...(loanDecision ? { loanDecision } : {}),
        orderId: inv.listingId,
        externalCustomerId: inv.clientId,
        amount: dollars,
        checkoutUrl: inv.hostedUrl,
        metadata,
        ...rec(o.payload),
      };
  const eventId = str(o.eventId) ?? `evt_test_${randomHex(12)}`;
  const envelope = { id: eventId, createdAt: new Date().toISOString(), type, payload };
  const raw = JSON.stringify(envelope);
  const tsMs = num(o.timestampMs) ?? Date.now();
  const timestamp = String(Math.round(tsMs));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  const webhook = await postSelf(request, "/api/portal/titus-webhook", raw, { "x-webhook-timestamp": timestamp, "x-webhook-signature": signature });
  const snap = await invoiceSnapshot(inv.id);
  return Response.json({
    ok: webhook.status >= 200 && webhook.status < 300,
    eventId,
    type,
    checkoutId,
    status,
    loanDecision,
    sentStale: Math.abs(Date.now() - tsMs) > TITUS_WEBHOOK_TOLERANCE_MS,
    note: "Titus was told nothing: the real checkout keeps its status at Titus. Cancel it through the API before the booking is deleted.",
    webhook,
    ...snap,
  });
}
