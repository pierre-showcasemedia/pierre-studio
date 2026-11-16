// One photo's revision note from the gallery lightbox ("Request revision").
// POST { slug, mediaId, note } saves it on the client's open request for the
// listing (an empty note removes it) and returns the client's revision list.
// The team is told only when the client sends the list (POST /api/portal/revision).
import { hasDb } from "@/db";
import { sessionEmail } from "@/lib/portal-auth";
import { listingForEmail } from "@/lib/portal-data";
import { isPartnerEmail } from "@/lib/partner";
import { NOTE_MAX, saveRevisionNote } from "@/lib/revisions";

export async function POST(request: Request) {
  const email = await sessionEmail();
  if (!email) return Response.json({ ok: false }, { status: 401 });
  if (isPartnerEmail(email)) return Response.json({ ok: false, error: "read-only" }, { status: 403 });
  const b = (await request.json().catch(() => ({}))) as { slug?: unknown; mediaId?: unknown; note?: unknown };
  const slug = String(b.slug ?? "");
  const mediaId = String(b.mediaId ?? "");
  const note = String(b.note ?? "");
  if (note.length > NOTE_MAX) return Response.json({ ok: false, error: `Notes are limited to ${NOTE_MAX} characters.` }, { status: 400 });
  // Demo mode (no database): the gallery keeps the list in the page.
  if (!hasDb()) return Response.json({ ok: true, demo: true });
  const data = await listingForEmail(email, slug);
  if (!data) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  // Only a photo this client can see in this gallery.
  const media = data.media.find((m) => m.id === mediaId);
  if (!media) return Response.json({ ok: false, error: "That photo is not in this gallery." }, { status: 404 });
  const draft = await saveRevisionNote({ listingId: data.listing.id, email, mediaId: media.id, filename: media.filename, note });
  return Response.json({ ok: true, draft });
}
