// The payment gate. Auth session → the media's listing must belong to this
// client AND be unlocked → only then mint a 10-minute R2 signed URL.
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { sessionEmail } from "@/lib/portal-auth";
import { isPartnerEmail, partnerCanSee } from "@/lib/partner";
import { hasR2, signedDownloadUrl } from "@/lib/r2";
import { isClientVisible } from "@/lib/media-visibility";
import { syncLockedListing } from "@/lib/payments";

export async function GET(_req: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const { mediaId } = await params;
  const email = await sessionEmail();
  if (!email) return Response.json({ ok: false, error: "not signed in" }, { status: 401 });
  if (!hasDb() || !hasR2()) {
    return Response.json({ ok: false, error: "demo mode: storage not configured yet" }, { status: 503 });
  }
  const d = db();
  const m = await d.query.media.findFirst({
    where: eq(schema.media.id, mediaId),
    with: { listing: { with: { client: true, shoots: { columns: { id: true, publishedAt: true } } } } },
  });
  // Owner or a teammate of the owner may download; partners any paid, non-excluded listing.
  let allowed = false;
  if (m && isPartnerEmail(email)) {
    allowed = partnerCanSee(m.listing);
  } else if (m) {
    const me = await d.query.clients.findFirst({ where: eq(schema.clients.email, email.toLowerCase()) });
    allowed = Boolean(
      me && (m.listing.clientId === me.id || (me.team && m.listing.client.team === me.team))
    );
  }
  // Frames still in QC, rejected, or not yet published do not exist as far as clients know.
  if (!m || !allowed || !isClientVisible(m, m.listing.shoots)) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  if (m.listing.downloadLocked) {
    // Step two: before refusing, ask the provider about the listing's newest
    // payable invoice (throttled to one check per 30 s). A payment that landed
    // seconds ago unlocks here through applyPaid; nothing else does.
    const unlocked = await syncLockedListing(m.listing.id, "download");
    if (!unlocked) return Response.json({ ok: false, error: "locked until payment is received" }, { status: 402 });
  }
  const url = await signedDownloadUrl(m.r2Key, m.filename);
  // Log the download for the admin activity feed (never block the download on it).
  try {
    await d.insert(schema.downloads).values({ mediaId: m.id, listingId: m.listing.id, clientEmail: email.toLowerCase(), filename: m.filename });
  } catch (e) {
    console.error("download log failed:", e);
  }
  return Response.redirect(url, 302);
}
