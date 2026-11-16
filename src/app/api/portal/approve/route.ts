// Client approves their gallery → listing marked Completed; the team is notified
// (NOTIFY_EMAILS, falling back to ADMIN_EMAILS).
// POST { slug }. Session must be able to see the listing (team-aware).
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { sessionEmail } from "@/lib/portal-auth";
import { listingForEmail } from "@/lib/portal-data";
import { isPartnerEmail } from "@/lib/partner";
import { emailFrom, notifyEmails } from "@/lib/brand";
import { logActivity } from "@/lib/activity";
import { hubGalleryApproved } from "@/lib/slack";

export async function POST(request: Request) {
  const email = await sessionEmail();
  if (!email || !hasDb()) return Response.json({ ok: false }, { status: 401 });
  if (isPartnerEmail(email)) return Response.json({ ok: false, error: "read-only" }, { status: 403 });
  const { slug } = await request.json();
  const data = await listingForEmail(email, String(slug || ""));
  if (!data) return Response.json({ ok: false, error: "not found" }, { status: 404 });

  await db().update(schema.listings).set({ approvedAt: new Date() }).where(eq(schema.listings.id, data.listing.id));
  await logActivity({ actorEmail: email, action: "client.approved", listingId: data.listing.id });
  await hubGalleryApproved({ listingId: data.listing.id, listing: { address: data.listing.address, nda: data.listing.nda }, clientEmail: email });

  // Fire-and-forget note to the team.
  const to = notifyEmails();
  if (to.length) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: emailFrom(),
        to,
        subject: `Gallery approved: ${data.listing.address.split(",")[0]} (${email})`,
        html: `<p><strong>${email}</strong> approved the gallery for <strong>${data.listing.address}</strong>. The shoot is now marked Completed.</p>`,
      });
    } catch (e) {
      console.error("approve notify:", e);
    }
  }
  return Response.json({ ok: true });
}
