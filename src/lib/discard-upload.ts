// Start over on an upload that never reached Submit (Oct 30 2026).
//
// the owner, 195 Example Oakleaf Road: an upload of raws paused, and the upload page kept
// offering to resume it. He wanted to begin again with JPGs, but the draft
// shoot remembered every file it had handed a link to, so Submit would have
// waited for raws that were never coming. This removes a draft shoot
// completely:
//   - every object under shoots/<id>/ in storage (raw photos and raw video),
//   - any Dropbox copy that already finished (Dropbox keeps deleted files, so
//     a mistake can still be restored there),
//   - the Dropbox copies still waiting in the queue,
//   - the file rows and the shoot row.
// Only a draft with no editing and no frames: once a shoot is submitted its
// files belong to the editing pipeline, and this refuses. It also waits while
// a Dropbox copy of one of its files is running, so nothing lands after the
// wipe. The activity log keeps "started an upload" and gains "discarded".
//
// Called by the upload page's Start over button (/api/studio/upload-discard)
// and the operator op discardDraftShoot (dry run unless apply: true).
//
// Only some files (extensions, operators only): the same 195 Example Oakleaf Road
// draft, minutes later. the owner had already dropped the JPGs into it and they
// were landing, while the 312 raws of the first try sat in the draft and
// would have held Submit forever. With extensions ["arw", "dng"] only those
// rows go (their objects, Dropbox copies and queued copies too); the shoot
// and every other file stay, so the upload in progress carries on.
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { dropboxApi, isDropboxNotFound } from "./dropbox";
import { MIRROR_KIND } from "./dropbox-mirror";
import { deleteObject, headObject, listKeys } from "./r2";

export type DiscardPlan = {
  shootId: string;
  listingId: string;
  createdBy: string;
  fileRows: number;
  photos: number;
  video: number;
  stored: number; // objects in storage under shoots/<id>/
  storedBytes: number;
  dropboxCopies: number;
  queuedCopies: number;
  kept: number; // file rows left on the shoot (only some files)
};

export type DiscardResult =
  | { ok: true; applied: boolean; plan: DiscardPlan; removed?: { stored: number; dropbox: number; dropboxMissing: number; jobs: number } }
  | { ok: false; status: number; error: string };

export async function discardDraftShoot(opts: { shootId: string; actor: string; apply: boolean; listingId?: string; extensions?: string[] }): Promise<DiscardResult> {
  const d = db();
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, opts.shootId) });
  if (!shoot || (opts.listingId && shoot.listingId !== opts.listingId)) return { ok: false, status: 404, error: "That upload is gone already." };
  if (shoot.status !== "draft" || shoot.autohdrPhotoshootId) return { ok: false, status: 409, error: "This shoot was already submitted, so its files stay." };
  const frames = await d.query.media.findMany({ where: eq(schema.media.shootId, shoot.id), columns: { id: true }, limit: 1 });
  if (frames.length) return { ok: false, status: 409, error: "This shoot has frames on the listing, so its files stay." };

  const exts = opts.extensions?.map((e) => e.toLowerCase().replace(/^\./, "")).filter(Boolean) ?? [];
  const partial = exts.length > 0;
  const all = await d.query.shootFiles.findMany({ where: eq(schema.shootFiles.shootId, shoot.id) });
  const files = partial ? all.filter((f) => exts.includes((f.filename.split(".").pop() ?? "").toLowerCase())) : all;
  const fileIds = new Set(files.map((f) => f.id));
  const mirrorJobs = (await d.query.jobs.findMany({ where: and(eq(schema.jobs.kind, MIRROR_KIND), eq(schema.jobs.listingId, shoot.listingId)) })).filter(
    (j) => fileIds.has(String(j.payload?.shootFileId ?? "")) || (!partial && j.payload?.shootId === shoot.id)
  );
  if (mirrorJobs.some((j) => j.status === "running" && j.leaseUntil && j.leaseUntil.getTime() > Date.now())) {
    return { ok: false, status: 409, error: "A Dropbox copy of this upload is running. Try again in a minute." };
  }
  // The whole shoot: everything under its prefix, strays included. Some
  // files: only their own keys, so a kept file is never touched.
  const keys = new Set(files.map((f) => f.r2Key));
  const stored = (await listKeys(`shoots/${shoot.id}/`)).filter((o) => !partial || keys.has(o.key));
  const copied = files.filter((f) => f.dropboxSyncedAt && f.dropboxPath);
  const video = files.filter((f) => f.kind === "raw_video").length;
  const plan: DiscardPlan = {
    shootId: shoot.id,
    listingId: shoot.listingId,
    createdBy: shoot.createdBy,
    fileRows: files.length,
    photos: files.length - video,
    video,
    stored: stored.length,
    storedBytes: stored.reduce((a, o) => a + o.size, 0),
    dropboxCopies: copied.length,
    queuedCopies: mirrorJobs.filter((j) => j.status === "queued").length,
    kept: all.length - files.length,
  };
  if (!opts.apply) return { ok: true, applied: false, plan };

  // The queued copies first, then the files, then the rows: if storage or
  // Dropbox fails part way, the shoot is still there and a second run
  // finishes the job.
  if (mirrorJobs.length) await d.delete(schema.jobs).where(inArray(schema.jobs.id, mirrorJobs.map((j) => j.id)));

  let i = 0;
  const worker = async () => {
    while (i < stored.length) await deleteObject(stored[i++].key);
  };
  await Promise.all(Array.from({ length: Math.min(8, stored.length || 1) }, worker));

  let dropbox = 0;
  let dropboxMissing = 0;
  if (copied.length) {
    const api = dropboxApi();
    for (const f of copied) {
      try {
        await api.deletePath(f.dropboxPath!);
        dropbox++;
      } catch (e) {
        if (!isDropboxNotFound(e)) throw e;
        dropboxMissing++;
      }
    }
  }

  if (partial) {
    if (files.length) await d.delete(schema.shootFiles).where(inArray(schema.shootFiles.id, [...fileIds]));
    await d.update(schema.shoots).set({ fileCount: plan.kept, updatedAt: new Date() }).where(eq(schema.shoots.id, shoot.id));
  } else {
    if (files.length) await d.delete(schema.shootFiles).where(eq(schema.shootFiles.shootId, shoot.id));
    await d.delete(schema.shoots).where(eq(schema.shoots.id, shoot.id));
  }

  const removed = { stored: stored.length, dropbox, dropboxMissing, jobs: mirrorJobs.length };
  await logActivity({ actorEmail: opts.actor, action: "shoot.discarded", shootId: shoot.id, listingId: shoot.listingId, meta: { fileCount: files.length, photos: plan.photos, video, bytes: plan.storedBytes, ...removed, ...(partial ? { partial: true, extensions: exts, kept: plan.kept } : {}) } });
  return { ok: true, applied: true, plan, removed };
}

// ---- Submit without the files that never landed (Nov 2 2026) ---------------
//
// 20 Dogwood: 422 of 426 files were in and four drone clips had failed
// every retry (the connection dropped at the end of the run), so Submit sat
// on four rows no object would ever fill and the photos never reached
// editing. The submit route calls this with { dropMissing: true }: each named
// row is checked in storage once more and, when nothing is there, the row
// goes (and any Dropbox copy queued for it). Nothing stored is touched, and a
// row whose object landed in the meantime stays. Returns what went, so the
// route can recount.
export async function dropMissingFiles(shootId: string, filenames: string[]): Promise<{ id: string; filename: string; kind: string }[]> {
  if (!filenames.length) return [];
  const d = db();
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { id: true, listingId: true, status: true } });
  if (!shoot || shoot.status !== "draft") return [];
  const rows = await d.query.shootFiles.findMany({ where: and(eq(schema.shootFiles.shootId, shootId), inArray(schema.shootFiles.filename, filenames)) });
  const gone: { id: string; filename: string; kind: string }[] = [];
  for (const r of rows) {
    const h = await headObject(r.r2Key);
    if (!h || h.size === 0) gone.push({ id: r.id, filename: r.filename, kind: r.kind });
  }
  if (!gone.length) return [];
  const ids = new Set(gone.map((g) => g.id));
  const queued = (await d.query.jobs.findMany({ where: and(eq(schema.jobs.kind, MIRROR_KIND), eq(schema.jobs.listingId, shoot.listingId)), columns: { id: true, payload: true } })).filter(
    (j) => ids.has(String(j.payload?.shootFileId ?? ""))
  );
  if (queued.length) await d.delete(schema.jobs).where(inArray(schema.jobs.id, queued.map((j) => j.id)));
  await d.delete(schema.shootFiles).where(inArray(schema.shootFiles.id, [...ids]));
  return gone;
}
