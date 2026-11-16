// Per-photo revision notes (Oct 2026). In the gallery lightbox the client taps
// "Request revision" on a photo and types what to change; every note saves at
// once (nothing is lost if they close the tab) onto ONE open request per
// client and listing, so the team sees a single consolidated ticket on
// /admin/revisions. "Send to the business" marks the request sent and tells the team
// once, with every note written since the last send.
//
// Open request = the client's newest request on the listing that the business has not
// started (status "new"). Once an admin moves it to In progress or Done, the
// next note starts a new request. A note is "sent" when it was last written
// before submitted_at.
import { and, asc, desc, eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";

export const NOTE_MAX = 2000;

export type RevisionDraftItem = { id: string; mediaId: string | null; filename: string; note: string; updatedAt: string; sent: boolean };
export type RevisionDraft = { requestId: string | null; items: RevisionDraftItem[]; notes: string; sentAt: string | null };

export const EMPTY_DRAFT: RevisionDraft = { requestId: null, items: [], notes: "", sentAt: null };

type RequestRow = typeof schema.revisionRequests.$inferSelect;
type ItemRow = typeof schema.revisionItems.$inferSelect;

const isSent = (i: ItemRow, r: RequestRow) => Boolean(r.submittedAt && i.updatedAt.getTime() <= r.submittedAt.getTime());

async function openRequest(listingId: string, email: string): Promise<RequestRow | null> {
  const r = await db().query.revisionRequests.findFirst({
    where: and(eq(schema.revisionRequests.listingId, listingId), eq(schema.revisionRequests.clientEmail, email.toLowerCase()), eq(schema.revisionRequests.status, "new")),
    orderBy: [desc(schema.revisionRequests.createdAt)],
  });
  return r ?? null;
}

async function itemsOf(requestId: string): Promise<ItemRow[]> {
  return db().query.revisionItems.findMany({ where: eq(schema.revisionItems.requestId, requestId), orderBy: [asc(schema.revisionItems.createdAt)] });
}

function toDraft(r: RequestRow | null, items: ItemRow[]): RevisionDraft {
  if (!r) return EMPTY_DRAFT;
  return {
    requestId: r.id,
    items: items.map((i) => ({ id: i.id, mediaId: i.mediaId, filename: i.filename, note: i.note, updatedAt: i.updatedAt.toISOString(), sent: isSent(i, r) })),
    notes: r.notes,
    sentAt: r.submittedAt?.toISOString() ?? null,
  };
}

// What the gallery shows in the client's revision list on load.
export async function revisionDraftFor(listingId: string, email: string): Promise<RevisionDraft> {
  if (!hasDb()) return EMPTY_DRAFT;
  const r = await openRequest(listingId, email);
  return toDraft(r, r ? await itemsOf(r.id) : []);
}

async function syncFilenames(requestId: string): Promise<ItemRow[]> {
  const items = await itemsOf(requestId);
  await db()
    .update(schema.revisionRequests)
    .set({ filenames: items.length ? items.map((i) => i.filename).join(", ") : null })
    .where(eq(schema.revisionRequests.id, requestId));
  return items;
}

// Save (or, with an empty note, remove) the note on one photo.
export async function saveRevisionNote(p: { listingId: string; email: string; mediaId: string; filename: string; note: string }): Promise<RevisionDraft> {
  const email = p.email.toLowerCase();
  const note = p.note.trim().slice(0, NOTE_MAX);
  const d = db();
  let r = await openRequest(p.listingId, email);
  if (!note) {
    if (!r) return EMPTY_DRAFT;
    await d.delete(schema.revisionItems).where(and(eq(schema.revisionItems.requestId, r.id), eq(schema.revisionItems.mediaId, p.mediaId)));
    const items = await syncFilenames(r.id);
    // A request that never went out and now holds nothing is dropped.
    if (!items.length && !r.notes.trim() && !r.submittedAt) {
      await d.delete(schema.revisionRequests).where(eq(schema.revisionRequests.id, r.id));
      return EMPTY_DRAFT;
    }
    return toDraft(r, items);
  }
  if (!r) {
    [r] = await d.insert(schema.revisionRequests).values({ listingId: p.listingId, clientEmail: email, notes: "", status: "new", submittedAt: null }).returning();
  }
  const now = new Date();
  await d
    .insert(schema.revisionItems)
    .values({ requestId: r.id, listingId: p.listingId, mediaId: p.mediaId, filename: p.filename, note, clientEmail: email, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [schema.revisionItems.requestId, schema.revisionItems.mediaId], set: { note, filename: p.filename, updatedAt: now } });
  return toDraft(r, await syncFilenames(r.id));
}

export type SentRevision = { request: RequestRow; newItems: ItemRow[]; allItems: ItemRow[]; generalNote: string };

// "Send to the business": everything written since the last send, plus an optional
// general note, goes out as one update to the same request.
export async function sendRevision(p: { listingId: string; email: string; notes?: string | null }): Promise<{ ok: true; sent: SentRevision; draft: RevisionDraft } | { ok: false; error: string }> {
  const email = p.email.toLowerCase();
  const general = (p.notes ?? "").trim().slice(0, NOTE_MAX * 2);
  const d = db();
  let r = await openRequest(p.listingId, email);
  const items = r ? await itemsOf(r.id) : [];
  const fresh = r ? items.filter((i) => !isSent(i, r!)) : [];
  if (!fresh.length && !general) return { ok: false, error: "Add a note first." };
  const now = new Date();
  if (!r) {
    [r] = await d.insert(schema.revisionRequests).values({ listingId: p.listingId, clientEmail: email, notes: general, status: "new", submittedAt: now }).returning();
  } else {
    const notes = general ? (r.notes.trim() ? `${r.notes.trim()}\n\n${general}` : general) : r.notes;
    [r] = await d.update(schema.revisionRequests).set({ notes, submittedAt: now }).where(eq(schema.revisionRequests.id, r.id)).returning();
  }
  const all = await syncFilenames(r.id);
  return { ok: true, sent: { request: r, newItems: fresh, allItems: all, generalNote: general }, draft: toDraft(r, all) };
}
