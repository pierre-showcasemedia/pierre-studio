// The film review in the client gallery (Oct 26 2026). the owner: like Frame.io,
// agents add comments at points in the film; the comments are saved as a
// ledger; then they finalize and send, and it comes in as ONE revision
// request tagged VIDEO that alerts the hub.
//
// Each comment saves at once (video_comments, request_id null = not sent
// yet), so nothing is lost if the tab closes. Send revision request takes
// every unsent comment the client wrote on the listing (all its films),
// plus an optional general note, and files one revision_requests row with
// media_kind "video". Sent comments stay readable and can no longer be
// edited.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";

export const VIDEO_NOTE_MAX = 1000;
// A film is at most a few hours; anything past that is a bad request.
export const AT_MS_MAX = 6 * 3600 * 1000;

export type VideoNote = { id: string; mediaId: string; filename: string; atMs: number; note: string; sent: boolean; updatedAt: string };

type Row = typeof schema.videoComments.$inferSelect;
const toNote = (r: Row): VideoNote => ({ id: r.id, mediaId: r.mediaId, filename: r.filename, atMs: r.atMs, note: r.note, sent: Boolean(r.sentAt), updatedAt: r.updatedAt.toISOString() });

// Every comment this client wrote on the listing, by film then time.
export async function videoNotesFor(listingId: string, email: string): Promise<VideoNote[]> {
  if (!hasDb()) return [];
  try {
    const rows = await db().query.videoComments.findMany({
      where: and(eq(schema.videoComments.listingId, listingId), eq(schema.videoComments.clientEmail, email.toLowerCase())),
      orderBy: [asc(schema.videoComments.filename), asc(schema.videoComments.atMs)],
      limit: 400,
    });
    return rows.map(toNote);
  } catch (e) {
    // Deployed before the migrate route made the table: no film review yet.
    console.error("[video-review] read", e);
    return [];
  }
}

export function cleanAtMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= AT_MS_MAX ? n : null;
}

export async function addVideoNote(p: { listingId: string; email: string; mediaId: string; filename: string; atMs: number; note: string }): Promise<void> {
  const note = p.note.trim().slice(0, VIDEO_NOTE_MAX);
  if (!note) return;
  await db().insert(schema.videoComments).values({ listingId: p.listingId, mediaId: p.mediaId, filename: p.filename, clientEmail: p.email.toLowerCase(), atMs: p.atMs, note });
}

// Edit (or, empty, remove) one of the client's own comments that is not sent yet.
export async function editVideoNote(p: { listingId: string; email: string; id: string; note: string }): Promise<boolean> {
  const mine = and(eq(schema.videoComments.id, p.id), eq(schema.videoComments.listingId, p.listingId), eq(schema.videoComments.clientEmail, p.email.toLowerCase()), isNull(schema.videoComments.sentAt));
  const note = p.note.trim().slice(0, VIDEO_NOTE_MAX);
  if (!note) {
    const gone = await db().delete(schema.videoComments).where(mine).returning({ id: schema.videoComments.id });
    return gone.length > 0;
  }
  const done = await db().update(schema.videoComments).set({ note, updatedAt: new Date() }).where(mine).returning({ id: schema.videoComments.id });
  return done.length > 0;
}

export type SentVideoRevision = { requestId: string; comments: VideoNote[]; generalNote: string; films: string[] };

// Send revision request: every unsent comment on the listing plus the
// general note, as one video revision request.
export async function sendVideoRevision(p: { listingId: string; email: string; notes?: string | null }): Promise<{ ok: true; sent: SentVideoRevision } | { ok: false; error: string }> {
  const email = p.email.toLowerCase();
  const general = (p.notes ?? "").trim().slice(0, VIDEO_NOTE_MAX * 2);
  const d = db();
  const unsent = await d.query.videoComments.findMany({
    where: and(eq(schema.videoComments.listingId, p.listingId), eq(schema.videoComments.clientEmail, email), isNull(schema.videoComments.sentAt)),
    orderBy: [asc(schema.videoComments.filename), asc(schema.videoComments.atMs)],
  });
  if (!unsent.length && !general) return { ok: false, error: "Add a note on the film first." };
  const films = [...new Set(unsent.map((c) => c.filename))];
  const now = new Date();
  const [req] = await d
    .insert(schema.revisionRequests)
    .values({ listingId: p.listingId, clientEmail: email, notes: general, filenames: films.join(", ") || null, status: "new", submittedAt: now, mediaKind: "video" })
    .returning({ id: schema.revisionRequests.id });
  if (unsent.length) {
    await d.update(schema.videoComments).set({ requestId: req.id, sentAt: now }).where(and(inArray(schema.videoComments.id, unsent.map((c) => c.id)), isNull(schema.videoComments.sentAt)));
  }
  return { ok: true, sent: { requestId: req.id, comments: unsent.map((c) => ({ ...toNote(c), sent: true })), generalNote: general, films } };
}
