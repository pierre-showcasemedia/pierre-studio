// POST /api/studio/payments/test-pay-link { bookingId }
// Operator-only (src/lib/payments-test.ts: MIGRATE_TOKEN, never production,
// test client only). Returns the same pay page link the booking email carries
// (payPageLink: a 30-day pay token for the booking's client email and listing
// slug, through /api/portal/verify with next = /portal/<slug>/pay), so a
// tester can open the pay page with a session: curl with a cookie jar,
// follow redirects, no JavaScript. `url` is exactly the email's link
// (NEXT_PUBLIC_SITE_URL); `localUrl` is the same path on this deployment's own
// origin, for a preview whose site url points elsewhere.
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { payPageLink } from "@/lib/booking-email";
import { siteUrl } from "@/lib/brand";
import { isOtherEnv, rowEnv } from "@/lib/payments";
import { isTestClientEmail, notTestClient, rec, selfOrigin, str, testGuard } from "@/lib/payments-test";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = testGuard(request);
  if (denied) return denied;
  const b = rec(await request.json().catch(() => ({})));
  const bookingId = str(b.bookingId) ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return Response.json({ ok: false, error: "bookingId (uuid) required" }, { status: 400 });
  const booking = await db().query.bookings.findFirst({
    where: eq(schema.bookings.id, bookingId),
    columns: { id: true, env: true, invoiceId: true, status: true },
    with: { client: { columns: { email: true } }, listing: { columns: { id: true, slug: true } } },
  });
  if (!booking) return Response.json({ ok: false, error: "booking not found" }, { status: 404 });
  if (!isTestClientEmail(booking.client?.email)) return notTestClient();
  if (isOtherEnv(booking.env)) return Response.json({ ok: false, error: `this booking belongs to the ${rowEnv(booking.env)} environment` }, { status: 409 });
  if (!booking.client || !booking.listing) return Response.json({ ok: false, error: "booking has no client or listing" }, { status: 409 });
  const url = await payPageLink(booking.client.email, booking.listing.slug);
  const localUrl = url.startsWith(siteUrl()) ? `${selfOrigin(request)}${url.slice(siteUrl().length)}` : url;
  return Response.json({ ok: true, bookingId: booking.id, listingId: booking.listing.id, slug: booking.listing.slug, invoiceId: booking.invoiceId, url, localUrl, expiresIn: "30 days" });
}
