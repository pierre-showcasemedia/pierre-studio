// Merge one shoot into another on the same listing (Nov 5 2026).
//
// the coordinator, 20 Dogwood: the listing was shot on two days, so it had two
// shoots (two cards on the Photo QC board), and the editors' renamed export
// had landed new frames on both. She asked to condense them into one shoot
// that holds only the photos the client sees, all approved and client
// visible. Nothing in the app could delete a submitted shoot or move frames
// from one shoot to another. This does, for two shoots of one listing:
//   - the KEEP set is every frame on either shoot that is client visible
//     right now (src/lib/media-visibility.ts: approved, published, its shoot
//     published). Those rows keep their ids, move onto the kept shoot and are
//     set approved, published, not held, so the gallery stays exactly as the
//     client sees it today (same files, sections, revised flags and order);
//   - every other frame of BOTH shoots is deleted the way the shoot page's
//     Delete does (src/lib/frame-publish.ts deleteFrames): rows only, the
//     files stay in storage, download history keeps its rows (media_id set
//     to null), the QC fix ticks go with their frame (cascade);
//   - the merged shoot's uploaded files (shoot_files, with their Dropbox
//     copies), Video board cards, activity rows and job payloads move to the
//     kept shoot, and the merged shoot row is deleted;
//   - the kept shoot ends up published: its own published_at, or the merged
//     shoot's when it has none (status "published", any old error cleared).
// The listing's loose files (no shoot) are never touched.
//
// Every table that names a media id was checked (Nov 5 2026):
//   downloads.media_id        FK, set null (done here too, as deleteFrames)
//   qc_fix_checks.media_id    FK, cascade (the tick goes with its frame)
//   revision_items.media_id   no FK: a client's per-photo note on a frame
//                             that would be deleted REFUSES the merge, listed
//                             in the preview; with allowRevisionLoss the note
//                             stays (request, filename and text) and only
//                             its media_id is cleared
//   video_comments.media_id   no FK, not null: a film comment on a frame that
//                             would be deleted always refuses
//   jobs.payload.mediaId      dropbox.final and twilight.frame re-read the
//                             frame and skip when it is gone; left as history
//   listings.cover_key        an r2 key: if the cover is a deleted frame it
//                             becomes the first kept gallery photo
// And the one shoot id table not moved below (Nov 6 2026):
//   photo_qc_picks.shoot_id   FK, cascade (the merged shoot's card pick goes
//                             with it; the kept shoot keeps its own, and
//                             revision card picks are keyed by the request)
// There are no favorites, per-photo share links or section tables: a section
// is a column on media and the share link is per listing.
//
// The writes run as ONE transaction (a neon-http batch). After it commits:
// one "download all" rebuild for the listing. Never a client email, never a
// Slack line (the shoot.merged activity row is written in the batch, not
// through logActivity, so the hub never posts it), never a calendar change.
//
// Refused: the same shoot twice, a shoot that is not there, shoots of two
// listings, either shoot still uploading or in editing, nothing client
// visible on either shoot, two kept frames with the same filename (listed),
// revision notes on frames that would go (unless allowRevisionLoss), film
// comments on frames that would go, and an apply whose plan no longer matches
// the preview the person saw (expect).
//
// Called by the shoot page's "Merge into another shoot" page
// (/admin/shoots/<id>/merge, admins only) and the operator op mergeShoot
// (src/app/api/portal/admin-api/route.ts). A dry run unless apply: true.
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { QcState, ShootStatus } from "@/db/schema";
import { fmtDate, isActive } from "./shoot-status";
import { isClientVisibleRow, visibilityOf, type Visibility } from "./visibility";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MergeShootInput = {
  fromShootId?: string | null; // merged, then deleted
  intoShootId?: string | null; // kept
  apply?: boolean;
  // Revision notes on frames that would be deleted: refused unless this is set.
  allowRevisionLoss?: boolean;
  // The fingerprint of the plan the person previewed (plan.fingerprint). When
  // given, apply refuses if the frames changed since.
  expect?: string | null;
  actor?: string | null;
  reason?: string | null;
};

export type MergeShootSide = {
  id: string;
  listingId: string;
  status: ShootStatus;
  createdBy: string;
  submittedAt: string | null;
  createdAt: string;
  publishedAt: string | null;
  label: string; // "the shoot uploaded Nov 1"
  nda: boolean; // options.nda: the editing run's NDA name
  autohdrPhotoshootId: number | null;
  fileCount: number;
  frames: number;
  clientVisible: number;
};

export type MergeFrame = {
  id: string;
  shootId: string;
  filename: string;
  r2Key: string;
  kind: "photo" | "video";
  section: string | null;
  revision: boolean;
  sort: number;
  qcState: QcState;
  published: boolean;
  held: boolean;
};

export type KeptFrame = Pick<MergeFrame, "id" | "shootId" | "filename" | "section" | "revision" | "kind">;
export type DeletedFrame = Pick<MergeFrame, "id" | "shootId" | "filename" | "kind"> & { visibility: Visibility };

export type ShootCounts = { frames: number; kept: number; deleted: number; files: number; videoCards: number; activity: number; jobs: number };

export type RevisionConflict = { itemId: string; requestId: string; mediaId: string; filename: string; note: string; status: string; clientEmail: string };

export type MergeShootPlan = {
  ok: boolean; // nothing refuses it (apply would run)
  applied: boolean;
  refused: string[];
  from: MergeShootSide | null;
  into: MergeShootSide | null;
  listing: { id: string; slug: string; address: string; street: string; nda: boolean; clientEmail: string | null } | null;
  counts: { from: ShootCounts; into: ShootCounts } | null;
  kept: KeptFrame[];
  deleted: DeletedFrame[];
  deletedBy: Record<Visibility, number>;
  clashes: string[]; // filenames two kept frames share
  revisionConflicts: RevisionConflict[];
  videoCommentConflicts: number;
  looseFiles: number; // the listing's files on no shoot: untouched
  staleJobs: number; // queued jobs on frames that would be deleted (they skip)
  publishedAt: string | null; // the kept shoot's published_at after the merge
  coverAfter: string | null | undefined; // undefined = the cover is unchanged
  notices: string[];
  fingerprint: string;
  result?: { kept: number; deleted: number; files: number; videoCards: number; activity: number; jobs: number; revisionNotesCleared: number; downloadsCleared: number; bundleRebuild: boolean; activityId: string | null; warnings: string[] };
};

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const streetOf = (address: string): string => address.split(",")[0].trim() || address.trim();
// Same words as the corrected photos box (siblingShootFrames in src/lib/admin-data.ts).
export const shootLabel = (s: { submittedAt: string | null; createdAt: string }) => `the shoot uploaded ${fmtDate(s.submittedAt ?? s.createdAt)}`;
const nameKey = (filename: string) => filename.trim().toLowerCase();

// ---- pure parts (scripts/check-merge-shoot.ts) -----------------------------

// Which frames stay and which go: client visible today on either shoot stays.
export function planKeep(frames: MergeFrame[], published: Record<string, boolean>): { kept: MergeFrame[]; deleted: (MergeFrame & { visibility: Visibility })[] } {
  const kept: MergeFrame[] = [];
  const deleted: (MergeFrame & { visibility: Visibility })[] = [];
  for (const f of frames) {
    const shootPublished = Boolean(published[f.shootId]);
    if (isClientVisibleRow({ qcState: f.qcState, published: f.published, shootId: f.shootId }, shootPublished)) kept.push(f);
    else deleted.push({ ...f, visibility: visibilityOf({ qcState: f.qcState, published: f.published, held: f.held, shootId: f.shootId }, shootPublished) });
  }
  return { kept, deleted };
}

// Filenames two kept frames share (case does not matter): after the merge
// they would be two frames of one shoot with one name, and a corrected drop
// would replace whichever it found first.
export function keptClashes(kept: Pick<MergeFrame, "filename">[]): string[] {
  const seen = new Map<string, { name: string; n: number }>();
  for (const k of kept) {
    const key = nameKey(k.filename);
    const s = seen.get(key);
    if (s) s.n++;
    else seen.set(key, { name: k.filename, n: 1 });
  }
  return [...seen.values()].filter((s) => s.n > 1).map((s) => s.name).sort();
}

// The kept shoot's published_at after the merge: its own, else the merged
// shoot's (the earlier of the two when both somehow lack one is null).
export function publishedAfter(from: Pick<MergeShootSide, "publishedAt">, into: Pick<MergeShootSide, "publishedAt">): string | null {
  if (into.publishedAt) return into.publishedAt;
  return from.publishedAt;
}

// The cover after the merge: unchanged unless it is a frame that goes; then
// the first kept main gallery photo (or null).
export function coverAfterMerge(coverKey: string | null, kept: Pick<MergeFrame, "r2Key" | "kind" | "section" | "revision" | "sort">[], deleted: Pick<MergeFrame, "r2Key">[]): string | null | undefined {
  if (!coverKey) return undefined;
  if (!deleted.some((d) => d.r2Key === coverKey) || kept.some((k) => k.r2Key === coverKey)) return undefined;
  const next = [...kept].filter((k) => k.kind === "photo" && !k.section && !k.revision).sort((a, b) => a.sort - b.sort)[0] ?? [...kept].filter((k) => k.kind === "photo").sort((a, b) => a.sort - b.sort)[0];
  return next?.r2Key ?? null;
}

// Which of a listing's shoots to keep when someone asks: the one holding the
// most client-visible frames (fewest frames leave the editing run that made
// them, so Make twilight and restore version keep working on most), then the
// earlier upload.
export function suggestKeep<T extends { id: string; clientVisible: number; submittedAt: string | null; createdAt: string }>(shoots: T[]): T | null {
  if (!shoots.length) return null;
  return [...shoots].sort((a, b) => b.clientVisible - a.clientVisible || (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt))[0];
}

export function mergeShootRefusals(p: {
  from: MergeShootSide | null;
  into: MergeShootSide | null;
  fromMissing?: string;
  intoMissing?: string;
  kept?: number;
  clashes?: string[];
  revisionConflicts?: number;
  videoCommentConflicts?: number;
  allowRevisionLoss?: boolean;
}): string[] {
  const out: string[] = [];
  if (!p.from) out.push(p.fromMissing ?? "The shoot to merge was not found.");
  if (!p.into) out.push(p.intoMissing ?? "The shoot to keep was not found.");
  if (!p.from || !p.into) return out;
  if (p.from.id === p.into.id) {
    out.push("A shoot cannot be merged into itself. Pick the other shoot.");
    return out;
  }
  if (p.from.listingId !== p.into.listingId) out.push("The two shoots belong to different listings. Merge shoots of one listing only (merge the listings first if they are the same property).");
  for (const s of [p.from, p.into]) {
    if (s.status === "draft") out.push(`${cap(s.label)} is still uploading. Submit it or start over first.`);
    else if (isActive(s.status)) out.push(`${cap(s.label)} is still in editing. Wait until it is ready for review, then merge.`);
  }
  if ((p.kept ?? 0) === 0) out.push("Nothing on either shoot is client visible, so the merge would keep no photos. Publish the photos that should stay first.");
  if (p.clashes?.length)
    out.push(`${plural(p.clashes.length, "filename is", "filenames are")} client visible on both shoots: ${p.clashes.slice(0, 12).join(", ")}${p.clashes.length > 12 ? ", ..." : ""}. Move one copy of each to internal only, then preview again.`);
  if ((p.revisionConflicts ?? 0) > 0 && !p.allowRevisionLoss)
    out.push(`${plural(p.revisionConflicts!, "client revision note is", "client revision notes are")} on photos the merge would delete (listed below). Tick "Delete them anyway" to keep the notes without their photo.`);
  if ((p.videoCommentConflicts ?? 0) > 0) out.push(`${plural(p.videoCommentConflicts!, "film comment is", "film comments are")} on a film the merge would delete. Make the film client visible first.`);
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// What a person should know before pressing Merge, in plain words.
export function mergeShootNotices(p: {
  from: MergeShootSide;
  into: MergeShootSide;
  counts: { from: ShootCounts; into: ShootCounts };
  deletedBy: Record<Visibility, number>;
  movedFromMerged: number;
  looseFiles: number;
  staleJobs: number;
  revisionConflicts: number;
  coverAfter: string | null | undefined;
}): string[] {
  const { from, into, counts, deletedBy } = p;
  const out: string[] = [];
  const del = counts.from.deleted + counts.into.deleted;
  out.push(`${plural(counts.from.kept + counts.into.kept, "client visible photo stays", "client visible photos stay")} on ${into.label}, approved and client visible. The client's gallery does not change.`);
  if (del) {
    const parts = [
      deletedBy.pending ? `${deletedBy.pending} not reviewed` : null,
      deletedBy.rejected ? `${deletedBy.rejected} rejected` : null,
      deletedBy.waiting ? `${deletedBy.waiting} approved but not published yet` : null,
      deletedBy.held ? `${deletedBy.held} held back` : null,
    ].filter(Boolean);
    out.push(`${plural(del, "internal only frame is", "internal only frames are")} deleted from the backend (${parts.join(", ")}). Their files stay in storage.`);
  }
  if (deletedBy.waiting) out.push(`${plural(deletedBy.waiting, "approved photo is", "approved photos are")} waiting for Publish (for example revised photos from an open revision round). The merge deletes them. Publish them first if they should stay.`);
  if (counts.from.files) out.push(`${plural(counts.from.files, "uploaded file")} (raws, with their Dropbox copies) move to ${into.label}.`);
  if (counts.from.videoCards) out.push(`${plural(counts.from.videoCards, "Video board card")} move${counts.from.videoCards === 1 ? "s" : ""} to ${into.label}.`);
  if (p.movedFromMerged) out.push(`${plural(p.movedFromMerged, "kept photo comes", "kept photos come")} from ${from.label}, which had its own editing run. Make twilight and restore version may not work on ${p.movedFromMerged === 1 ? "it" : "them"} afterwards.`);
  if (!into.publishedAt && from.publishedAt) out.push(`${cap(into.label)} was never published; it takes ${from.label}'s publish time.`);
  if (from.nda !== into.nda) out.push(`One shoot ran under the NDA name in editing and the other did not. The listing's own NDA flag is unchanged.`);
  if (p.coverAfter === null) out.push("The cover photo is one of the deleted frames and no kept photo can replace it, so the listing has no cover until one is picked.");
  else if (p.coverAfter) out.push("The cover photo is one of the deleted frames; the first kept gallery photo becomes the cover.");
  if (p.revisionConflicts) out.push(`${plural(p.revisionConflicts, "revision note")} stay${p.revisionConflicts === 1 ? "s" : ""} on its request with the filename and text, without the photo.`);
  if (p.looseFiles) out.push(`${plural(p.looseFiles, "file")} on the listing ${p.looseFiles === 1 ? "is" : "are"} on no shoot (added straight to the listing). The merge leaves ${p.looseFiles === 1 ? "it" : "them"} alone.`);
  if (p.staleJobs) out.push(`${plural(p.staleJobs, "queued job")} (a Dropbox copy or Make twilight) ${p.staleJobs === 1 ? "is" : "are"} on a frame that goes; ${p.staleJobs === 1 ? "it skips" : "they skip"} when ${p.staleJobs === 1 ? "it runs" : "they run"}.`);
  out.push(`${cap(from.label)} is deleted and leaves the Photo QC board. Nothing is emailed to the client, nothing is posted in Slack, and the calendar is not touched. The download zips are rebuilt.`);
  return out;
}

export function planFingerprint(kept: { id: string }[], deleted: { id: string }[]): string {
  const h = createHash("sha256");
  h.update([...kept.map((k) => k.id)].sort().join(","));
  h.update("|");
  h.update([...deleted.map((k) => k.id)].sort().join(","));
  return h.digest("hex").slice(0, 16);
}

const emptyBy = (): Record<Visibility, number> => ({ client: 0, held: 0, rejected: 0, pending: 0, waiting: 0 });

// ---- database ---------------------------------------------------------------

type ShootRow = typeof schema.shoots.$inferSelect;

function side(s: ShootRow, frames: MergeFrame[], published: Record<string, boolean>): MergeShootSide {
  const mine = frames.filter((f) => f.shootId === s.id);
  const submittedAt = iso(s.submittedAt);
  const createdAt = iso(s.createdAt)!;
  return {
    id: s.id,
    listingId: s.listingId,
    status: s.status,
    createdBy: s.createdBy,
    submittedAt,
    createdAt,
    publishedAt: iso(s.publishedAt),
    label: shootLabel({ submittedAt, createdAt }),
    nda: Boolean(s.options?.nda),
    autohdrPhotoshootId: s.autohdrPhotoshootId,
    fileCount: s.fileCount,
    frames: mine.length,
    clientVisible: mine.filter((f) => isClientVisibleRow({ qcState: f.qcState, published: f.published, shootId: f.shootId }, Boolean(published[s.id]))).length,
  };
}

const findShoot = async (id: string | null | undefined): Promise<ShootRow | null> =>
  id && UUID_RE.test(id.trim()) ? ((await db().query.shoots.findFirst({ where: eq(schema.shoots.id, id.trim()) })) ?? null) : null;

// The other shoots of a listing, for the merge page's picker.
export async function listingShootsForMerge(listingId: string): Promise<(MergeShootSide & { suggested: boolean })[]> {
  const d = db();
  const shoots = await d.query.shoots.findMany({ where: eq(schema.shoots.listingId, listingId) });
  if (!shoots.length) return [];
  const frames = await framesOf(shoots.map((s) => s.id));
  const published = Object.fromEntries(shoots.map((s) => [s.id, Boolean(s.publishedAt)]));
  const sides = shoots.map((s) => side(s, frames, published)).sort((a, b) => (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt));
  const best = suggestKeep(sides);
  return sides.map((s) => ({ ...s, suggested: s.id === best?.id }));
}

async function framesOf(shootIds: string[]): Promise<MergeFrame[]> {
  if (!shootIds.length) return [];
  const rows = await db().query.media.findMany({
    where: inArray(schema.media.shootId, shootIds),
    columns: { id: true, shootId: true, filename: true, r2Key: true, kind: true, section: true, revision: true, sort: true, qcState: true, published: true, held: true },
  });
  return rows.map((r) => ({ ...r, shootId: r.shootId! }));
}

export async function mergeShoot(input: MergeShootInput): Promise<MergeShootPlan> {
  const d = db();
  const [fromRow, intoRow] = await Promise.all([findShoot(input.fromShootId), findShoot(input.intoShootId)]);
  const ids = [fromRow?.id, intoRow?.id].filter((x): x is string => Boolean(x));
  const frames = await framesOf([...new Set(ids)]);
  const published: Record<string, boolean> = {};
  if (fromRow) published[fromRow.id] = Boolean(fromRow.publishedAt);
  if (intoRow) published[intoRow.id] = Boolean(intoRow.publishedAt);
  const from = fromRow ? side(fromRow, frames, published) : null;
  const into = intoRow ? side(intoRow, frames, published) : null;
  const plan: MergeShootPlan = {
    ok: false, applied: false, refused: [], from, into, listing: null, counts: null, kept: [], deleted: [], deletedBy: emptyBy(), clashes: [],
    revisionConflicts: [], videoCommentConflicts: 0, looseFiles: 0, staleJobs: 0, publishedAt: null, coverAfter: undefined, notices: [], fingerprint: "",
  };
  const name = (v?: string | null) => v?.trim() || "(none given)";
  if (!from || !into || from.id === into.id || from.listingId !== into.listingId) {
    plan.refused = mergeShootRefusals({ from, into, fromMissing: `No shoot ${name(input.fromShootId)} to merge.`, intoMissing: `No shoot ${name(input.intoShootId)} to keep.` });
    return plan;
  }

  const F = from.id;
  const T = into.id;
  const { kept, deleted } = planKeep(frames, published);
  const deletedIds = deleted.map((x) => x.id);
  const listing = await d.query.listings.findFirst({ where: eq(schema.listings.id, into.listingId), with: { client: { columns: { email: true } } } });
  if (!listing) {
    plan.refused = ["The listing of these shoots was not found."];
    return plan;
  }
  plan.listing = { id: listing.id, slug: listing.slug, address: listing.address, street: streetOf(listing.address), nda: listing.nda, clientEmail: listing.client?.email ?? null };

  const [refRows, revRows, vcRows] = await Promise.all([
    d.execute<Record<string, number>>(sql`
      SELECT
        (SELECT count(*) FROM shoot_files WHERE shoot_id = ${F})::int AS from_files,
        (SELECT count(*) FROM shoot_files WHERE shoot_id = ${T})::int AS into_files,
        (SELECT count(*) FROM video_projects WHERE shoot_id = ${F})::int AS from_video,
        (SELECT count(*) FROM video_projects WHERE shoot_id = ${T})::int AS into_video,
        (SELECT count(*) FROM activity WHERE shoot_id = ${F})::int AS from_activity,
        (SELECT count(*) FROM activity WHERE shoot_id = ${T})::int AS into_activity,
        (SELECT count(*) FROM jobs WHERE payload->>'shootId' = ${F})::int AS from_jobs,
        (SELECT count(*) FROM jobs WHERE payload->>'shootId' = ${T})::int AS into_jobs,
        (SELECT count(*) FROM media WHERE listing_id = ${listing.id} AND shoot_id IS NULL)::int AS loose`),
    deletedIds.length
      ? d
          .select({ itemId: schema.revisionItems.id, requestId: schema.revisionItems.requestId, mediaId: schema.revisionItems.mediaId, filename: schema.revisionItems.filename, note: schema.revisionItems.note, status: schema.revisionRequests.status, clientEmail: schema.revisionItems.clientEmail })
          .from(schema.revisionItems)
          .innerJoin(schema.revisionRequests, eq(schema.revisionRequests.id, schema.revisionItems.requestId))
          .where(inArray(schema.revisionItems.mediaId, deletedIds))
      : Promise.resolve([]),
    deletedIds.length ? d.select({ id: schema.videoComments.id }).from(schema.videoComments).where(inArray(schema.videoComments.mediaId, deletedIds)) : Promise.resolve([]),
  ]);
  const staleJobs = deletedIds.length
    ? Number(
        (
          await d.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued', 'running') AND payload->>'mediaId' IN (${sql.join(deletedIds.map((x) => sql`${x}`), sql`, `)})`)
        ).rows[0]?.n ?? 0
      )
    : 0;
  const r = refRows.rows[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0);
  const countFor = (id: string, pre: "from" | "into"): ShootCounts => ({
    frames: frames.filter((f) => f.shootId === id).length,
    kept: kept.filter((f) => f.shootId === id).length,
    deleted: deleted.filter((f) => f.shootId === id).length,
    files: n(`${pre}_files`),
    videoCards: n(`${pre}_video`),
    activity: n(`${pre}_activity`),
    jobs: n(`${pre}_jobs`),
  });
  plan.counts = { from: countFor(F, "from"), into: countFor(T, "into") };
  plan.kept = kept.map(({ id, shootId, filename, section, revision, kind }) => ({ id, shootId, filename, section, revision, kind }));
  plan.deleted = deleted.map(({ id, shootId, filename, kind, visibility }) => ({ id, shootId, filename, kind, visibility }));
  for (const x of deleted) plan.deletedBy[x.visibility]++;
  plan.clashes = keptClashes(kept);
  plan.revisionConflicts = revRows.map((x) => ({ ...x, mediaId: x.mediaId! }));
  plan.videoCommentConflicts = vcRows.length;
  plan.looseFiles = n("loose");
  plan.staleJobs = staleJobs;
  plan.publishedAt = publishedAfter(from, into);
  plan.coverAfter = coverAfterMerge(listing.coverKey, kept, deleted);
  plan.fingerprint = planFingerprint(kept, deleted);
  plan.refused = mergeShootRefusals({
    from, into, kept: kept.length, clashes: plan.clashes, revisionConflicts: plan.revisionConflicts.length,
    videoCommentConflicts: plan.videoCommentConflicts, allowRevisionLoss: input.allowRevisionLoss,
  });
  if (input.apply && input.expect && input.expect !== plan.fingerprint)
    plan.refused.push("The frames on these shoots changed since the preview (a photo was published, hidden or added). Nothing was changed. Look at the preview again, then merge.");
  plan.ok = plan.refused.length === 0;
  plan.notices = mergeShootNotices({
    from, into, counts: plan.counts, deletedBy: plan.deletedBy, movedFromMerged: plan.counts.from.kept, looseFiles: plan.looseFiles,
    staleJobs, revisionConflicts: input.allowRevisionLoss ? plan.revisionConflicts.length : 0, coverAfter: plan.coverAfter,
  });
  if (!input.apply || !plan.ok) return plan;

  // ---- apply: one transaction ------------------------------------------------
  const now = new Date();
  const actor = input.actor?.trim() || null;
  const keptIds = kept.map((x) => x.id);
  const both = [F, T];
  const meta = {
    from: { id: F, label: from.label, status: from.status, publishedAt: from.publishedAt, autohdrPhotoshootId: from.autohdrPhotoshootId },
    into: { id: T, label: into.label, status: into.status, publishedAt: into.publishedAt },
    counts: plan.counts,
    kept: keptIds.length,
    deleted: deletedIds.length,
    deletedBy: plan.deletedBy,
    deletedFilenames: deleted.map((x) => x.filename).slice(0, 400),
    revisionNotesCleared: input.allowRevisionLoss ? plan.revisionConflicts.length : 0,
    coverChanged: plan.coverAfter !== undefined,
    fingerprint: plan.fingerprint,
    reason: input.reason?.trim() || null,
    via: actor && actor.includes("@") ? "admin" : "operator",
  };
  const publishedAt = plan.publishedAt ? new Date(plan.publishedAt) : now;
  const shootPatch: Partial<typeof schema.shoots.$inferInsert> = {
    status: "published",
    publishedAt,
    publishedBy: intoRow!.publishedAt ? intoRow!.publishedBy : (fromRow!.publishedBy ?? actor),
    fileCount: intoRow!.fileCount + fromRow!.fileCount,
    photoCount: kept.filter((k) => k.kind === "photo").length,
    error: null,
    updatedAt: now,
    ...(!intoRow!.dropboxSyncedAt && fromRow!.dropboxSyncedAt ? { dropboxSyncedAt: fromRow!.dropboxSyncedAt } : {}),
  };

  type Stmt = Parameters<typeof d.batch>[0][number];
  const ret = { id: schema.media.id };
  const stmts: Stmt[] = [
    d.update(schema.media).set({ shootId: T, qcState: "approved", published: true, held: false }).where(and(inArray(schema.media.id, keptIds), inArray(schema.media.shootId, both))).returning(ret),
  ];
  const at = { downloads: -1, revisions: -1, del: -1 };
  if (deletedIds.length) {
    at.downloads = stmts.length;
    stmts.push(d.update(schema.downloads).set({ mediaId: null }).where(inArray(schema.downloads.mediaId, deletedIds)).returning({ id: schema.downloads.id }));
    if (input.allowRevisionLoss && plan.revisionConflicts.length) {
      at.revisions = stmts.length;
      stmts.push(d.update(schema.revisionItems).set({ mediaId: null, updatedAt: now }).where(inArray(schema.revisionItems.mediaId, deletedIds)).returning({ id: schema.revisionItems.id }));
    }
    at.del = stmts.length;
    stmts.push(d.delete(schema.media).where(and(inArray(schema.media.id, deletedIds), inArray(schema.media.shootId, both))).returning(ret));
  }
  const at2 = stmts.length;
  stmts.push(
    d.update(schema.shootFiles).set({ shootId: T }).where(eq(schema.shootFiles.shootId, F)).returning({ id: schema.shootFiles.id }),
    d.update(schema.videoProjects).set({ shootId: T, updatedAt: now }).where(eq(schema.videoProjects.shootId, F)).returning({ id: schema.videoProjects.id }),
    d.update(schema.activity).set({ shootId: T }).where(eq(schema.activity.shootId, F)).returning({ id: schema.activity.id }),
    d
      .update(schema.jobs)
      .set({ payload: sql`jsonb_set(${schema.jobs.payload}, '{shootId}', to_jsonb(${T}::text))` })
      .where(sql`${schema.jobs.payload}->>'shootId' = ${F}`)
      .returning({ id: schema.jobs.id }),
    d.update(schema.shoots).set(shootPatch).where(eq(schema.shoots.id, T)).returning({ id: schema.shoots.id }),
    ...(plan.coverAfter !== undefined ? [d.update(schema.listings).set({ coverKey: plan.coverAfter }).where(eq(schema.listings.id, listing.id)).returning({ id: schema.listings.id })] : []),
    // shoot_files has a foreign key on the shoot: a file that arrived for the
    // merged shoot after the move above stops this delete, and all rolls back.
    d.delete(schema.shoots).where(eq(schema.shoots.id, F)).returning({ id: schema.shoots.id }),
    d.insert(schema.activity).values({ actorEmail: actor, action: "shoot.merged", listingId: listing.id, shootId: T, clientId: listing.clientId, meta }).returning({ id: schema.activity.id }),
  );

  let results: { id: string }[][];
  try {
    results = (await d.batch(stmts as [Stmt, ...Stmt[]])) as { id: string }[][];
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : null;
    const code = (cause as { code?: unknown } | null)?.code ?? (e as { code?: unknown } | null)?.code;
    const msg = `${e instanceof Error ? e.message : String(e)} ${cause?.message ?? ""}`;
    if (code === "23503" || /foreign key/i.test(msg)) {
      plan.ok = false;
      plan.refused = [`Something on ${from.label} changed while merging (a file arrived), so nothing was changed. Open the preview again and merge.`];
      return plan;
    }
    throw e;
  }
  const len = (i: number) => (i >= 0 && Array.isArray(results[i]) ? results[i].length : 0);
  const actRow = results[results.length - 1]?.[0] ?? null;

  plan.applied = true;
  const warnings: string[] = [];
  if (len(0) !== keptIds.length) warnings.push(`${keptIds.length - len(0)} kept frames were not found at apply time.`);
  let bundleRebuild = false;
  try {
    const { enqueueBundleRebuild } = await import("./bundle-jobs");
    await enqueueBundleRebuild(listing.id);
    bundleRebuild = true;
  } catch (e) {
    warnings.push(`The download zips were not queued (${e instanceof Error ? e.message : String(e)}). Press Rebuild zips on the listing.`);
  }
  plan.result = {
    kept: len(0),
    deleted: len(at.del),
    downloadsCleared: len(at.downloads),
    revisionNotesCleared: len(at.revisions),
    files: len(at2),
    videoCards: len(at2 + 1),
    activity: len(at2 + 2),
    jobs: len(at2 + 3),
    bundleRebuild,
    activityId: actRow?.id ?? null,
    warnings,
  };
  return plan;
}
