// GET /api/studio/payments/test-listing-state?listingId=…
// Operator-only (src/lib/payments-test.ts: MIGRATE_TOKEN, never production,
// test client only). Everything a tester needs to assert state without
// database access: the lock, every invoice of the listing (id, status,
// provider, providerId, paidAt, refundedCents), the last 20 activity rows
// (action, meta, created_at) and this environment's jobs for the listing or
// its invoices (kind, status, attempts, lastError).
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { currentEnv } from "@/lib/jobs-core";
import { isTestClientEmail, notTestClient, testGuard } from "@/lib/payments-test";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = testGuard(request);
  if (denied) return denied;
  const listingId = new URL(request.url).searchParams.get("listingId") || "";
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) return Response.json({ ok: false, error: "listingId (uuid) required" }, { status: 400 });
  const d = db();
  const listing = await d.query.listings.findFirst({
    where: eq(schema.listings.id, listingId),
    columns: { id: true, slug: true, address: true, downloadLocked: true, shootDate: true },
    with: { client: { columns: { email: true } } },
  });
  if (!listing) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
  if (!isTestClientEmail(listing.client?.email)) return notTestClient();
  const invoices = await d.query.invoices.findMany({
    where: eq(schema.invoices.listingId, listingId),
    orderBy: [desc(schema.invoices.createdAt)],
    columns: { id: true, status: true, provider: true, providerId: true, paidAt: true, refundedCents: true, amountCents: true, method: true, idempotencyVersion: true, bookingId: true, env: true, lastEvent: true },
  });
  const invoiceIds = invoices.map((i) => i.id);
  const bookingIds = invoices.map((i) => i.bookingId).filter((x): x is string => Boolean(x));
  const activity = await d.query.activity.findMany({
    where: eq(schema.activity.listingId, listingId),
    orderBy: [desc(schema.activity.createdAt)],
    limit: 20,
    columns: { id: true, action: true, actorEmail: true, meta: true, createdAt: true },
  });
  const jobs = await d.query.jobs.findMany({
    where: and(
      eq(schema.jobs.env, currentEnv()),
      or(
        eq(schema.jobs.listingId, listingId),
        ...(invoiceIds.length ? [inArray(schema.jobs.invoiceId, invoiceIds)] : []),
        ...(bookingIds.length ? [inArray(schema.jobs.bookingId, bookingIds)] : [])
      )
    ),
    orderBy: [desc(schema.jobs.createdAt)],
    columns: { id: true, kind: true, status: true, attempts: true, lastError: true, runAt: true, doneAt: true, invoiceId: true, bookingId: true, idempotencyKey: true },
  });
  return Response.json({
    ok: true,
    env: currentEnv(),
    listingId: listing.id,
    slug: listing.slug,
    address: listing.address,
    downloadLocked: listing.downloadLocked,
    invoices,
    activity,
    jobs,
  });
}
