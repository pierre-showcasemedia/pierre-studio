// The payments test harness (operator-only, docs/booking-to-payment.md step
// two). Lets an end-to-end tester prove the unlock path on a preview without
// a human and without moving money: a synthetic Stripe or Titus webhook
// delivery signed with THIS deployment's own secret and POSTed to its own
// webhook route (so the real route, the signature check, the dedupe in
// payment_events and applyPaid all run), the pay page link the booking email
// carries, a test-mode Stripe payment, and a read of a listing's state.
//
// Every route under src/app/api/studio/payments/test-* answers:
//   404  without MIGRATE_TOKEN (the same guard as migrate, health and sync),
//   403  on production (currentEnv() === "production"), always,
//   403  unless the target row's client email is the designated test client
//        (/\+studiotest@/i, for example owner+studiotest@example.com),
//   409  when the row belongs to another environment (one shared database).
// Nothing here tells Stripe or Titus anything: a synthetic invoice.paid leaves
// the real Stripe invoice OPEN, which is why the tester voids it afterwards
// (admin-api deleteBooking with voidInvoice: true).
import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { currentEnv } from "./jobs-core";
import { isOtherEnv, rowEnv } from "./payments";
import { hasMigrateToken } from "@/lib/operator-token";

export const TEST_CLIENT_RE = /\+studiotest@/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function randomHex(bytes = 12): string {
  return randomBytes(bytes).toString("hex");
}

// Token, database, never production.
export function testGuard(request: Request): Response | null {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  if (!hasDb()) return Response.json({ ok: false, error: "no database" }, { status: 503 });
  if (currentEnv() === "production") return Response.json({ ok: false, error: "the payments test harness never runs on production" }, { status: 403 });
  return null;
}

export function isTestClientEmail(email: string | null | undefined): boolean {
  return Boolean(email) && TEST_CLIENT_RE.test(email as string);
}

export function notTestClient(): Response {
  return Response.json({ ok: false, error: "only the designated test client (an address matching +studiotest@) may be used here" }, { status: 403 });
}

async function findInvoice(invoiceId: string) {
  return db().query.invoices.findFirst({
    where: eq(schema.invoices.id, invoiceId),
    with: { client: { columns: { id: true, email: true, name: true } }, listing: { columns: { id: true, slug: true, address: true, downloadLocked: true } } },
  });
}
export type TestInvoice = NonNullable<Awaited<ReturnType<typeof findInvoice>>>;

// The invoice a test route acts on, or the refusal to send back.
export async function loadTestInvoice(invoiceId: string): Promise<{ inv: TestInvoice; denied?: undefined } | { inv?: undefined; denied: Response }> {
  if (!UUID_RE.test(invoiceId)) return { denied: Response.json({ ok: false, error: "invoiceId must be a uuid" }, { status: 400 }) };
  const inv = await findInvoice(invoiceId);
  if (!inv) return { denied: Response.json({ ok: false, error: "invoice not found" }, { status: 404 }) };
  if (!isTestClientEmail(inv.client?.email ?? inv.clientEmail)) return { denied: notTestClient() };
  if (isOtherEnv(inv.env)) return { denied: Response.json({ ok: false, error: `this invoice belongs to the ${rowEnv(inv.env)} environment` }, { status: 409 }) };
  return { inv };
}

// This deployment's own origin (the alias or deployment host the caller used),
// so a synthetic delivery lands on the same build that signed it.
export function selfOrigin(request: Request): string {
  const u = new URL(request.url);
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || u.host).split(",")[0].trim();
  const proto = (request.headers.get("x-forwarded-proto") || u.protocol.replace(":", "") || "https").split(",")[0].trim();
  return `${proto}://${host}`;
}

// A self-call needs the caller's Vercel protection bypass to get through.
export function forwardedHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const bypass = request.headers.get("x-vercel-protection-bypass");
  if (bypass) out["x-vercel-protection-bypass"] = bypass;
  return out;
}

export type SelfPost = { url: string; status: number; body: unknown };

export async function postSelf(request: Request, path: string, body: string, headers: Record<string, string>): Promise<SelfPost> {
  const url = `${selfOrigin(request)}${path}`;
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...forwardedHeaders(request), ...headers }, body, cache: "no-store" });
  const text = await r.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text.slice(0, 500);
  }
  return { url, status: r.status, body: json };
}

// The row and its newest payment events, after a test delivery.
export async function invoiceSnapshot(invoiceId: string) {
  const d = db();
  const invoice = await d.query.invoices.findFirst({
    where: eq(schema.invoices.id, invoiceId),
    columns: { id: true, provider: true, providerId: true, status: true, method: true, amountCents: true, paidAt: true, refundedCents: true, idempotencyVersion: true, lastEvent: true, meta: true, env: true, listingId: true, bookingId: true },
    with: { listing: { columns: { id: true, slug: true, downloadLocked: true } } },
  });
  const events = await d.query.paymentEvents.findMany({
    where: eq(schema.paymentEvents.invoiceId, invoiceId),
    orderBy: [desc(schema.paymentEvents.receivedAt)],
    limit: 10,
    columns: { id: true, provider: true, providerEventId: true, type: true, status: true, stale: true, signatureOk: true, receivedAt: true, processedAt: true, note: true, error: true },
  });
  return { invoice, events };
}
