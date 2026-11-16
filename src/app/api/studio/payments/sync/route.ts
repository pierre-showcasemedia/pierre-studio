// Operator lever for payments (previews have no cron and no webhooks pointed
// at them). Guarded by MIGRATE_TOKEN like migrate, health and the job drain.
//   POST /api/studio/payments/sync { invoiceId, force? }
//     asks the provider (Stripe invoice or Titus checkout) about one invoice
//     through syncInvoiceFromProvider and returns what it did: a paid status
//     unlocks through applyPaid exactly as a webhook would; anything else only
//     refreshes the row. force skips the 30 s throttle and the payable-status
//     check (read-only when the row is already paid or void).
//   GET  /api/studio/payments/sync?invoiceId=…   the row + its payment events
//     (each with the stored provider payload, so a denial or a failure can be
//     read exactly as the provider sent it)
import { desc, eq } from "drizzle-orm";
import { after } from "next/server";
import { db, hasDb, schema } from "@/db";
import { drainJobs } from "@/lib/jobs";
import { syncInvoiceFromProvider } from "@/lib/payments";
import { hasMigrateToken } from "@/lib/operator-token";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function guard(request: Request): Response | null {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  if (!hasDb()) return Response.json({ ok: false, error: "no database" }, { status: 503 });
  return null;
}

async function snapshot(invoiceId: string) {
  const d = db();
  const inv = await d.query.invoices.findFirst({
    where: eq(schema.invoices.id, invoiceId),
    columns: { id: true, provider: true, providerId: true, status: true, method: true, amountCents: true, paidAt: true, refundedCents: true, idempotencyVersion: true, lastEvent: true, lastCheckedAt: true, meta: true, env: true, listingId: true, bookingId: true },
    with: { listing: { columns: { id: true, slug: true, downloadLocked: true } } },
  });
  if (!inv) return null;
  const events = await d.query.paymentEvents.findMany({
    where: eq(schema.paymentEvents.invoiceId, invoiceId),
    orderBy: [desc(schema.paymentEvents.receivedAt)],
    limit: 20,
    columns: { id: true, provider: true, providerEventId: true, type: true, status: true, stale: true, signatureOk: true, receivedAt: true, processedAt: true, note: true, error: true, payload: true },
  });
  return { invoice: inv, events };
}

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const invoiceId = new URL(request.url).searchParams.get("invoiceId") || "";
  if (!invoiceId) return Response.json({ ok: false, error: "invoiceId required" }, { status: 400 });
  const snap = await snapshot(invoiceId);
  if (!snap) return Response.json({ ok: false, error: "invoice not found" }, { status: 404 });
  return Response.json({ ok: true, ...snap });
}

export async function POST(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const b = await request.json().catch(() => ({}));
  const invoiceId = typeof b.invoiceId === "string" ? b.invoiceId : "";
  if (!invoiceId) return Response.json({ ok: false, error: "invoiceId required" }, { status: 400 });
  const started = Date.now();
  const result = await syncInvoiceFromProvider(invoiceId, "operator", { force: Boolean(b.force) });
  if (result.changed) {
    after(async () => {
      try {
        await drainJobs({ budgetMs: 30_000, invoiceId });
      } catch (e) {
        console.error("[payments/sync] drain:", e);
      }
    });
  }
  const snap = await snapshot(invoiceId);
  return Response.json({ ok: true, ms: Date.now() - started, result, ...(snap ?? {}) });
}
