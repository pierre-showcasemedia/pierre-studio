// The film review's notes (Oct 26 2026, src/lib/video-review.ts). Each note
// saves the moment it is written; the team hears nothing until the client
// presses Send revision request (POST /api/portal/video-revision).
// POST { slug, op: "add", mediaId, atMs, note }
//      { slug, op: "edit", id, note }   an empty note removes it
// → { ok, notes } (every note this client has on the listing)
import { hasDb } from "@/db";
import { sessionEmail } from "@/lib/portal-auth";
import { listingForEmail } from "@/lib/portal-data";
import { isPartnerEmail } from "@/lib/partner";
import { addVideoNote, cleanAtMs, editVideoNote, VIDEO_NOTE_MAX, videoNotesFor } from "@/lib/video-review";

export async function POST(request: Request) {
  const email = await sessionEmail();
  if (!email) return Response.json({ ok: false }, { status: 401 });
  if (isPartnerEmail(email)) return Response.json({ ok: false, error: "read-only" }, { status: 403 });
  const b = (await request.json().catch(() => ({}))) as { slug?: unknown; op?: unknown; mediaId?: unknown; atMs?: unknown; note?: unknown; id?: unknown };
  const note = String(b.note ?? "");
  if (note.length > VIDEO_NOTE_MAX) return Response.json({ ok: false, error: `Notes are limited to ${VIDEO_NOTE_MAX} characters.` }, { status: 400 });
  // Demo mode (no database): the gallery keeps the notes in the page.
  if (!hasDb()) return Response.json({ ok: true, demo: true });
  const data = await listingForEmail(email, String(b.slug ?? ""));
  if (!data) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  // A locked gallery's films do not play, so there is nothing to comment on.
  if (data.listing.downloadLocked) return Response.json({ ok: false, error: "Films open for notes once the gallery is unlocked." }, { status: 403 });

  if (b.op === "add") {
    const film = data.media.find((m) => m.id === String(b.mediaId ?? "") && m.kind === "video");
    if (!film) return Response.json({ ok: false, error: "That film is not in this gallery." }, { status: 404 });
    const atMs = cleanAtMs(b.atMs);
    if (atMs === null) return Response.json({ ok: false, error: "That time is not in the film." }, { status: 400 });
    if (!note.trim()) return Response.json({ ok: false, error: "Write a note first." }, { status: 400 });
    await addVideoNote({ listingId: data.listing.id, email, mediaId: film.id, filename: film.filename, atMs, note });
  } else if (b.op === "edit") {
    const ok = await editVideoNote({ listingId: data.listing.id, email, id: String(b.id ?? ""), note });
    if (!ok) return Response.json({ ok: false, error: "That note was already sent, so it can no longer change." }, { status: 409 });
  } else {
    return Response.json({ ok: false, error: "unknown op" }, { status: 400 });
  }
  return Response.json({ ok: true, notes: await videoNotesFor(data.listing.id, email) });
}
