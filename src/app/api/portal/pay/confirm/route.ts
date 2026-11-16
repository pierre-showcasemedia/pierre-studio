// POST { slug, invoiceId?, checkoutId? } from the pay-at-close button's
// onSuccess. The browser's word counts for nothing: this only asks the server
// to read OUR stored checkout back from Titus (syncInvoiceFromProvider,
// source client_success) and reports the status it found. A succeeded checkout
// unlocks through applyPaid inside that sync, exactly like a webhook would.
import { after } from "next/server";
import { hasDb } from "@/db";
import { drainJobs } from "@/lib/jobs";
import { isPartnerEmail } from "@/lib/partner";
import { isOtherEnv, syncInvoiceFromProvider } from "@/lib/payments";
import { sessionEmail } from "@/lib/portal-auth";
import { listingForEmail } from "@/lib/portal-data";
import { hasTitus } from "@/lib/titus";

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
  if (!inv || inv.provider !== "titus") return Response.json({ ok: false, error: "no pay at close invoice on this gallery" }, { status: 409 });
  // Another environment's row (a preview admin viewing as a production client): nothing to read from here.
  if (isOtherEnv(inv.env)) return Response.json({ ok: true, status: inv.status, changed: false, unlocked: false, skipped: "other environment" });
  // The client just finished the Titus flow: one real read now, not the 30 s
  // throttled answer a webhook may have touched seconds ago.
  const r = await syncInvoiceFromProvider(inv.id, "client_success", { skipThrottle: true });
  if (r.changed) {
    const invoiceId = inv.id;
    after(async () => {
      try {
        await drainJobs({ budgetMs: 25_000, invoiceId });
      } catch (e) {
        console.error("[pay/confirm] drain:", e);
      }
    });
  }
  return Response.json({ ok: true, status: r.status ?? inv.status, changed: r.changed, unlocked: r.unlocked, skipped: r.skipped ?? null });
}
