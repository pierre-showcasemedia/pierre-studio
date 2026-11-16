// POST { slug, invoiceId? } → the Titus checkout the pay page should open:
// { ok, id, checkoutUrl, status } or { ok, paid: true }. Session + ownership
// (the listing must be the client's or their team's; partners are read-only);
// the invoice must be provider titus in open | review | processing, and owned
// by THIS environment (a preview admin viewing as a production client never
// reads, cancels or recreates a production checkout: one shared database).
//
// An existing checkout is read back from Titus first, through
// payments.syncInvoiceFromProvider (source pay_page, no throttle): succeeded →
// applyPaid (the provider's word, never the browser's) and { paid: true };
// requires-payment or processing → the same id again; canceled → forgotten,
// idempotency_version bumped and a fresh one created below. A 404 is not a
// cancel: the first miss is only noted and the client asked to try again in a
// moment (a wrong key or base URL reads exactly like a dropped checkout); a
// second consecutive miss seen by THIS route (the page render and the gallery
// never count) resets and recreates, and only while the row is still open: a
// row in processing or review has an application in flight and keeps its
// checkout. 503 without TITUS_API_KEY.
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { drainJobs } from "@/lib/jobs";
import { isPartnerEmail } from "@/lib/partner";
import { isOtherEnv, isPaid, isPayable, syncInvoiceFromProvider } from "@/lib/payments";
import { sessionEmail } from "@/lib/portal-auth";
import { listingForEmail } from "@/lib/portal-data";
import { createCheckoutForInvoice, hasTitus } from "@/lib/titus";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const email = await sessionEmail();
  if (!email || !hasDb()) return Response.json({ ok: false, error: "not signed in" }, { status: 401 });
  if (isPartnerEmail(email)) return Response.json({ ok: false, error: "read-only" }, { status: 403 });
  if (!hasTitus()) return Response.json({ ok: false, error: "Pay at close is not available right now" }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const data = await listingForEmail(email, String(b.slug || ""), { invoiceId: typeof b.invoiceId === "string" ? b.invoiceId : null });
  if (!data) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  const inv = data.listing.invoice;
  if (!inv || inv.provider !== "titus" || !isPayable(inv.status)) {
    return Response.json({ ok: false, error: "nothing to pay at close on this gallery" }, { status: 409 });
  }
  if (isOtherEnv(inv.env)) return Response.json({ ok: false, error: "Pay at close is not available right now" }, { status: 409 });
  try {
    if (inv.providerId) {
      const r = await syncInvoiceFromProvider(inv.id, "pay_page", { skipThrottle: true });
      if (!r.ok) throw new Error(r.error ?? "could not read the checkout back");
      if (r.status && isPaid(r.status)) {
        if (r.changed) {
          const invoiceId = inv.id;
          after(async () => {
            try {
              await drainJobs({ budgetMs: 25_000, invoiceId });
            } catch (e) {
              console.error("[pay/checkout] drain:", e);
            }
          });
        }
        return Response.json({ ok: true, paid: true });
      }
      // Re-read: the sync may have refreshed the URL, moved the status, or
      // (canceled, or a second miss) cleared the checkout for a fresh one.
      const fresh = await db().query.invoices.findFirst({ where: eq(schema.invoices.id, inv.id), columns: { providerId: true, hostedUrl: true, status: true } });
      if (fresh?.providerId) {
        if (r.providerStatus === "missing") {
          return Response.json({ ok: false, error: "We could not reach your application just now. Please try again in a moment." }, { status: 503 });
        }
        if (!isPayable(fresh.status)) return Response.json({ ok: false, error: "nothing to pay at close on this gallery" }, { status: 409 });
        return Response.json({ ok: true, id: fresh.providerId, checkoutUrl: fresh.hostedUrl ?? null, status: r.providerStatus ?? "requires-payment" });
      }
    }
    const created = await createCheckoutForInvoice(inv.id);
    if (!created.id) return Response.json({ ok: false, error: created.skipped ?? "could not create the checkout" }, { status: 409 });
    return Response.json({ ok: true, id: created.id, checkoutUrl: created.checkoutUrl ?? null, status: created.status ?? "requires-payment" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[pay/checkout]", message);
    return Response.json({ ok: false, error: "We could not start the application. Please try again in a moment." }, { status: 500 });
  }
}
