// Send revision request from the film review (Oct 26 2026): every unsent
// timestamped note on the listing's films, plus an optional general note,
// becomes ONE revision request tagged VIDEO. The listing's Video card takes
// it (back In queue, round + 1), the hub line tags video QC, and the team
// email lists each note with its time.
// POST { slug, notes? } → { ok, notes }
import { hasDb } from "@/db";
import { sessionEmail } from "@/lib/portal-auth";
import { listingForEmail } from "@/lib/portal-data";
import { isPartnerEmail } from "@/lib/partner";
import { emailFrom, notifyEmails, siteUrl } from "@/lib/brand";
import { logActivity } from "@/lib/activity";
import { hubRevisionRequested } from "@/lib/slack";
import { fmtTimecode, linkVideoRevision } from "@/lib/video-board";
import { sendVideoRevision, videoNotesFor } from "@/lib/video-review";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function POST(request: Request) {
  const email = await sessionEmail();
  if (!email) return Response.json({ ok: false }, { status: 401 });
  if (isPartnerEmail(email)) return Response.json({ ok: false, error: "read-only" }, { status: 403 });
  const b = (await request.json().catch(() => ({}))) as { slug?: unknown; notes?: unknown };
  if (!hasDb()) return Response.json({ ok: true, demo: true });
  const data = await listingForEmail(email, String(b.slug ?? ""));
  if (!data) return Response.json({ ok: false, error: "not found" }, { status: 404 });

  const r = await sendVideoRevision({ listingId: data.listing.id, email, notes: typeof b.notes === "string" ? b.notes : null });
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: 400 });
  const { requestId, comments, generalNote, films } = r.sent;
  const street = data.listing.address.split(",")[0];

  let cardId: string | null = null;
  try {
    cardId = await linkVideoRevision({ listingId: data.listing.id, requestId, by: email });
  } catch (e) {
    console.error("video revision card:", e);
  }
  await logActivity({ actorEmail: email, action: "client.revision_requested", listingId: data.listing.id, meta: { requestId, kind: "video", notes: comments.length, films: films.length, general: Boolean(generalNote) } });
  const summary = [generalNote, ...comments.map((c) => `${c.filename} at ${fmtTimecode(c.atMs)}: ${c.note}`)].filter(Boolean).join(" · ");
  await hubRevisionRequested({ listingId: data.listing.id, listing: { address: data.listing.address, nda: data.listing.nda }, clientEmail: email, notes: summary, fileCount: comments.length, kind: "video", videoCardId: cardId }).catch((e) => console.error("video revision hub:", e));

  const to = notifyEmails();
  if (to.length && process.env.RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const rows = comments
        .map((c) => `<tr><td style="padding:8px 12px 8px 0;vertical-align:top;font-family:monospace;font-size:12px;white-space:nowrap;">${esc(c.filename)} · ${fmtTimecode(c.atMs)}</td><td style="padding:8px 0;vertical-align:top;white-space:pre-wrap;">${esc(c.note)}</td></tr>`)
        .join("");
      await resend.emails.send({
        from: emailFrom(),
        to,
        replyTo: email,
        subject: `Video revision requested: ${street} (${email})`,
        html: `
          <p><strong>${esc(email)}</strong> requested video revisions on <strong>${esc(data.listing.address)}</strong>.</p>
          ${generalNote ? `<p style="white-space:pre-wrap;border-left:3px solid #ccc;padding-left:12px;">${esc(generalNote)}</p>` : ""}
          ${rows ? `<table style="border-collapse:collapse;font-size:14px;">${rows}</table>` : ""}
          <p><a href="${siteUrl()}${cardId ? `/admin/video/${cardId}` : "/admin/revisions?kind=video"}">Open in admin →</a></p>`,
      });
    } catch (e) {
      console.error("video revision notify:", e);
    }
  }
  return Response.json({ ok: true, notes: await videoNotesFor(data.listing.id, email) });
}
