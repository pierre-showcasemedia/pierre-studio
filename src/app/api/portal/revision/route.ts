// The client sends their revision list to the business: every photo note written in
// the lightbox since the last send, plus an optional general note, go out as
// one update to the same request, and the team hears once (hub + email) with
// each photo and its note.
// POST { slug, notes? }
import { hasDb } from "@/db";
import { sessionEmail } from "@/lib/portal-auth";
import { listingForEmail } from "@/lib/portal-data";
import { isPartnerEmail } from "@/lib/partner";
import { emailFrom, notifyEmails, siteUrl } from "@/lib/brand";
import { logActivity } from "@/lib/activity";
import { hubRevisionRequested } from "@/lib/slack";
import { sendRevision } from "@/lib/revisions";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function POST(request: Request) {
  const email = await sessionEmail();
  if (!email) return Response.json({ ok: false }, { status: 401 });
  if (isPartnerEmail(email)) return Response.json({ ok: false, error: "read-only" }, { status: 403 });
  const b = (await request.json().catch(() => ({}))) as { slug?: unknown; notes?: unknown };
  if (!hasDb()) return Response.json({ ok: true, demo: true });
  const data = await listingForEmail(email, String(b.slug ?? ""));
  if (!data) return Response.json({ ok: false, error: "not found" }, { status: 404 });

  const r = await sendRevision({ listingId: data.listing.id, email, notes: typeof b.notes === "string" ? b.notes : null });
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: 400 });
  const { newItems, allItems, generalNote, request: req } = r.sent;
  const street = data.listing.address.split(",")[0];
  const again = allItems.length > newItems.length;

  await logActivity({ actorEmail: email, action: "client.revision_requested", listingId: data.listing.id, meta: { requestId: req.id, files: newItems.length, totalFiles: allItems.length, general: Boolean(generalNote) } });
  const summary = [generalNote, ...newItems.map((i) => `${i.filename}: ${i.note}`)].filter(Boolean).join(" · ");
  await hubRevisionRequested({ listingId: data.listing.id, listing: { address: data.listing.address, nda: data.listing.nda }, clientEmail: email, notes: summary, fileCount: newItems.length }).catch((e) => console.error("revision hub:", e));

  const to = notifyEmails();
  if (to.length && process.env.RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const rows = newItems
        .map((i) => `<tr><td style="padding:8px 12px 8px 0;vertical-align:top;font-family:monospace;font-size:12px;white-space:nowrap;">${esc(i.filename)}</td><td style="padding:8px 0;vertical-align:top;white-space:pre-wrap;">${esc(i.note)}</td></tr>`)
        .join("");
      await resend.emails.send({
        from: emailFrom(),
        to,
        replyTo: email,
        subject: `Revision ${again ? "update" : "requested"}: ${street} (${email})`,
        html: `
          <p><strong>${esc(email)}</strong> ${again ? "added to their revision request" : "requested revisions"} on <strong>${esc(data.listing.address)}</strong>.</p>
          ${generalNote ? `<p style="white-space:pre-wrap;border-left:3px solid #ccc;padding-left:12px;">${esc(generalNote)}</p>` : ""}
          ${rows ? `<table style="border-collapse:collapse;font-size:14px;">${rows}</table>` : ""}
          <p><a href="${siteUrl()}/admin/revisions">Open in admin →</a></p>`,
      });
    } catch (e) {
      console.error("revision notify:", e);
    }
  }
  return Response.json({ ok: true, draft: r.draft });
}
