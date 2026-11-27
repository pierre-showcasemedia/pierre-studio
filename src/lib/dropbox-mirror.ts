// The Dropbox raw mirror (Oct 21 2026). the owner: "when the shooter or uploader
// goes to upload raw files to the upload page, they should also automatically
// be copied into our Dropbox under that specific listing", photos and raw
// video in their own subfolders.
//
// One dropbox.mirror job per shoot_files row (idempotency key on the row id),
// enqueued when a shoot is submitted and by "Copy to Dropbox again" on the
// shoot page. The job streams the file from R2 to Dropbox:
//
//   - up to SINGLE_UPLOAD_MAX in one files/upload;
//   - bigger files through an upload session (start / append_v2 / finish)
//     in CHUNK_BYTES pieces. The session id and offset are saved on the job
//     row after every chunk, the job's lease is refreshed, and when the
//     drain's deadline (or this job's own slice) is near the job stops,
//     saves its cursor and defers: the next tick picks up at the same
//     offset. A session is good for days, so a stalled cron costs nothing;
//     a session Dropbox has forgotten starts over from zero.
//   - a file already at the target path with the same size is a skip;
//     the same name with another size (two shoots, same camera counter)
//     goes under "<name> (shoot xxxxxxxx).<ext>";
//   - Dropbox 429 / 503 defer for the Retry-After it names (no attempt
//     counted, no alert); anything else is a normal failure with backoff;
//   - not configured or not connected here: NotConfiguredError, the job
//     waits quietly (like the calendar jobs).
//
// mirrorFile() is the engine, with every outside thing injected (MirrorIo):
// scripts/check-dropbox-mirror.ts runs it against a fake Dropbox and a fake
// clock. runDropboxMirror() is the job handler around it.
import { createHash } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db, schema } from "@/db";
import type { JobKind } from "@/db/schema";
import { logActivity } from "./activity";
import {
  DropboxApi,
  alternateFilename,
  dropboxWebUrl,
  correctOffsetOf,
  dropboxApi,
  dropboxMirrorEnabled,
  dropboxRoot,
  finalAlternatePath,
  finalTargetPath,
  hasDropboxApp,
  isDropboxConflict,
  isDropboxNotFound,
  isDropboxRetry,
  isDropboxSharingBan,
  listingFolderPath,
  mirrorTargetPath,
  RAW_PHOTOS_SUBFOLDER,
  RAW_VIDEO_SUBFOLDER,
} from "./dropbox";
import { currentEnv, DeferError, drainDeadline, enqueueJobs, FatalJobError, jobKey, NotConfiguredError, SkipJobError } from "./jobs-core";
import { getObjectBuffer, getObjectRange, headObject } from "./r2";
import { countKinds } from "./shoot-files";
import { clientVisibleMedia } from "./media-visibility";
import { business } from "./business";

export const MIRROR_KIND: JobKind = "dropbox.mirror";
export const FOLDER_KIND: JobKind = "dropbox.folder";
export const FINAL_KIND: JobKind = "dropbox.final";
export const FINAL_SWEEP_KIND: JobKind = "dropbox.final_sweep";
// All run in the cron's background pass and the submit route's first pass.
// The raw cleanup (src/lib/r2-raw-cleanup.ts) needs Dropbox too, so it runs in the same pass.
export const MIRROR_KINDS: readonly JobKind[] = [MIRROR_KIND, FOLDER_KIND, FINAL_SWEEP_KIND, FINAL_KIND, "r2.raw_sweep", "r2.raw_cleanup"];
// Dropbox's ceiling for one files/upload request.
export const SINGLE_UPLOAD_MAX = 150 * 1024 * 1024;
// One append per chunk. Well under the 150 MB session ceiling and small
// enough to hold in memory beside the rest of the function.
export const CHUNK_BYTES = 64 * 1024 * 1024;
// The most one run of a job spends before it yields to the other jobs of the
// tick; a long copy comes back on the next tick.
export const MIRROR_SLICE_MS = 60_000;
// Stop this far before the deadline.
export const TAIL_MS = 4_000;
// A cautious throughput for "does the next chunk still fit before the deadline".
const PLAN_BYTES_PER_SEC = 8e6;
// Rate-limit waits before a persistently refusing Dropbox counts as a failure.
const MAX_RATE_WAITS = 20;

export type MirrorCursor = { id: string; offset: number; path: string; startedAt: string } | null;

export type MirrorApi = Pick<DropboxApi, "getMetadata" | "upload" | "sessionStart" | "sessionAppend" | "sessionFinish">;

export type MirrorIo = {
  api: MirrorApi;
  size: number; // the object's size in storage
  readAll(): Promise<Uint8Array>; // the whole object (small files)
  read(start: number, endInclusive: number): Promise<Uint8Array>; // one range (sessions)
  now(): number;
  deadline: number;
  cursor: MirrorCursor; // where the previous run stopped, if it did
  persist(cursor: MirrorCursor): Promise<void>;
  lease(): Promise<void>;
  // The target path first, then the name to use when the target holds a
  // different file of the same name.
  paths: string[];
  // Tests shrink these; production uses the constants above.
  chunkBytes?: number;
  singleUploadMax?: number;
};

export type MirrorOutcome = { done: true; path: string; skipped: boolean } | { done: false; cursor: MirrorCursor };

export class MirrorError extends Error {
  fatal: boolean;
  constructor(message: string, fatal = false) {
    super(message);
    this.name = "MirrorError";
    this.fatal = fatal;
  }
}

// Which of the candidate paths to write to, or the path that already holds
// this exact file. Throws when every candidate holds a different file.
async function choosePath(io: MirrorIo): Promise<{ path: string; exists: boolean }> {
  for (const path of io.paths) {
    const meta = await io.api.getMetadata(path);
    if (!meta) return { path, exists: false };
    if (meta.tag === "file" && meta.size === io.size) return { path, exists: true };
  }
  throw new MirrorError(`Every name for this file is taken in Dropbox by a file of another size (${io.paths.map((p) => p.split("/").pop()).join(", ")}).`, true);
}

const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

function fitsBeforeDeadline(io: MirrorIo, bytes: number): boolean {
  const need = (bytes / PLAN_BYTES_PER_SEC) * 1000 + 2_000;
  return io.deadline - io.now() - TAIL_MS >= need;
}

export async function mirrorFile(io: MirrorIo): Promise<MirrorOutcome> {
  if (io.size <= 0) throw new MirrorError("The file in storage is empty.", true);
  const CHUNK = io.chunkBytes ?? CHUNK_BYTES;
  const SINGLE = io.singleUploadMax ?? SINGLE_UPLOAD_MAX;

  // ---- small: one request ----
  if (io.size <= SINGLE && !io.cursor) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const chosen = await choosePath(io);
      if (chosen.exists) return { done: true, path: chosen.path, skipped: true };
      if (!fitsBeforeDeadline(io, io.size)) return { done: false, cursor: null };
      try {
        const r = await io.api.upload(chosen.path, await io.readAll());
        return { done: true, path: r.path, skipped: false };
      } catch (e) {
        // Raced by another copy of the same file (a second drain): look again.
        if (isDropboxConflict(e) && attempt === 0) continue;
        throw e;
      }
    }
    throw new MirrorError("Dropbox kept answering with a name conflict.");
  }

  // ---- large: an upload session, resumable across runs ----
  let cursor: MirrorCursor = io.cursor;
  let target: string | null = cursor?.path ?? null;
  for (let guard = 0; guard < 400; guard++) {
    if (!target) {
      const chosen = await choosePath(io);
      if (chosen.exists) return { done: true, path: chosen.path, skipped: true };
      target = chosen.path;
    }
    const offset = cursor?.offset ?? 0;
    const len = Math.min(CHUNK, io.size - offset);
    if (!fitsBeforeDeadline(io, len)) {
      await io.persist(cursor);
      return { done: false, cursor };
    }
    const chunk = await io.read(offset, offset + len - 1);
    const last = offset + len >= io.size;
    try {
      if (!cursor) {
        // The first chunk opens the session. A file that fits in one chunk
        // but is over the single-upload ceiling still goes through a session.
        const id = await io.api.sessionStart(chunk);
        cursor = { id, offset: len, path: target, startedAt: new Date(io.now()).toISOString() };
        await io.persist(cursor);
        await io.lease();
        if (last) {
          // Nothing left to send: finish with an empty body.
          const r = await io.api.sessionFinish(cursor.id, cursor.offset, target, new Uint8Array(0));
          await io.persist(null);
          return { done: true, path: r.path, skipped: false };
        }
        continue;
      }
      if (last) {
        const r = await io.api.sessionFinish(cursor.id, offset, target, chunk);
        await io.persist(null);
        return { done: true, path: r.path, skipped: false };
      }
      await io.api.sessionAppend(cursor.id, offset, chunk);
      cursor = { ...cursor, offset: offset + len };
      await io.persist(cursor);
      await io.lease();
    } catch (e) {
      const correct = correctOffsetOf(e);
      if (correct != null && cursor) {
        // Dropbox has more or less than we thought (a chunk landed before a
        // persist failed, or the other way round): carry on from its offset.
        cursor = { ...cursor, offset: correct };
        await io.persist(cursor);
        continue;
      }
      if (isDropboxNotFound(e) && cursor) {
        // The session is gone (expired, or Dropbox lost it): start over.
        cursor = null;
        await io.persist(null);
        continue;
      }
      if (isDropboxConflict(e) && last) {
        // The name was taken while this session ran: finish under the next name.
        const i = io.paths.indexOf(target);
        const next = io.paths[i + 1];
        const meta = await io.api.getMetadata(target);
        if (meta && meta.tag === "file" && meta.size === io.size) {
          await io.persist(null);
          return { done: true, path: target, skipped: true };
        }
        if (!next) throw new MirrorError(`Every name for this file is taken in Dropbox by a file of another size.`, true);
        target = next;
        cursor = cursor ? { ...cursor, path: next } : null;
        await io.persist(cursor);
        continue;
      }
      throw e;
    }
  }
  throw new MirrorError("The copy did not finish after many chunks; check the job.");
}

// ---- The job handler ---------------------------------------------------------

type JobRow = typeof schema.jobs.$inferSelect;

export function mirrorNotConfiguredReason(): string {
  if (!hasDropboxApp()) return "Dropbox (NEXT_PUBLIC_DROPBOX_APP_KEY and DROPBOX_APP_SECRET)";
  return `Dropbox mirror on ${currentEnv()} (production only unless DROPBOX_MIRROR=on)`;
}

async function saveCursor(job: JobRow, session: MirrorCursor, extra: Record<string, unknown> = {}): Promise<void> {
  const payload = { ...(job.payload ?? {}), ...extra, session: session ?? undefined };
  await db().update(schema.jobs).set({ payload, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
}

const LEASE_MS = 120_000;

export async function runDropboxMirror(job: JobRow): Promise<void> {
  const p = job.payload ?? {};
  if (!p.shootFileId) throw new FatalJobError("dropbox.mirror needs payload.shootFileId");
  if (!dropboxMirrorEnabled()) throw new NotConfiguredError(mirrorNotConfiguredReason());
  const d = db();
  const file = await d.query.shootFiles.findFirst({ where: eq(schema.shootFiles.id, p.shootFileId), with: { shoot: { with: { listing: true } } } });
  if (!file) throw new FatalJobError("that shoot file no longer exists");
  if (file.dropboxSyncedAt) throw new SkipJobError("already in Dropbox");
  const shoot = file.shoot;
  const listing = shoot.listing;
  const head = await headObject(file.r2Key);
  if (!head || head.size <= 0) throw new FatalJobError(`${file.filename} is not in storage, so there is nothing to copy`);

  const api = dropboxApi();
  try {
    // The listing's folder: made when the shoot was booked (dropbox.folder),
    // or here on the first copy when it was not, and kept for good. The
    // upload creates the Photo or Video folder (or the dropped folder) on its
    // way if it is missing; Photo is not made for a file that has its own.
    let folder = listing.dropboxFolder;
    if (!folder) {
      folder = listingFolderPath(dropboxRoot(), listing.address);
      if (!file.dropboxDir) await api.createFolder(`${folder}/${RAW_PHOTOS_SUBFOLDER}`);
      await api.createFolder(`${folder}/${RAW_VIDEO_SUBFOLDER}`);
      await d.update(schema.listings).set({ dropboxFolder: folder }).where(and(eq(schema.listings.id, listing.id), isNull(schema.listings.dropboxFolder)));
    }
    const deadline = Math.min(drainDeadline(), Date.now() + MIRROR_SLICE_MS);
    const out = await mirrorFile({
      api,
      size: head.size,
      readAll: async () => (await getObjectBuffer(file.r2Key)).body,
      read: (s, e) => getObjectRange(file.r2Key, s, e),
      now: () => Date.now(),
      deadline,
      cursor: p.session ?? null,
      persist: (c) => saveCursor(job, c),
      lease: () => d.update(schema.jobs).set({ leaseUntil: new Date(Date.now() + LEASE_MS) }).where(eq(schema.jobs.id, job.id)).then(() => undefined),
      paths: [mirrorTargetPath(folder, file.kind, file.filename, file.dropboxDir), mirrorTargetPath(folder, file.kind, alternateFilename(file.filename, shoot.id), file.dropboxDir)],
    });
    if (!out.done) {
      const at = out.cursor?.offset ?? 0;
      throw new DeferError(`continuing at ${fmtBytes(at)} of ${fmtBytes(head.size)}`, 1_000);
    }
    await d.update(schema.shootFiles).set({ dropboxPath: out.path, dropboxSyncedAt: new Date() }).where(eq(schema.shootFiles.id, file.id));
    if (file.kind === "raw_video") await queueVideoEditingLine(shoot.id, listing.id).catch((e) => console.error("[dropbox-mirror] video editing line", shoot.id, e));
    await noteShootDone(shoot.id, listing.id, folder);
  } catch (e) {
    if (e instanceof MirrorError) throw e.fatal ? new FatalJobError(e.message) : new Error(e.message);
    if (isDropboxRetry(e)) {
      // Dropbox asked for a pause: wait that long, no attempt counted. A
      // Dropbox that keeps refusing becomes a normal failure (backoff, alert).
      const waits = (typeof (p as { waits?: unknown }).waits === "number" ? (p as { waits: number }).waits : 0) + 1;
      if (waits > MAX_RATE_WAITS) throw new Error(`Dropbox kept answering ${e.status} (${waits} waits): ${e.tag}`);
      await saveCursor(job, p.session ?? null, { waits });
      throw new DeferError(`Dropbox ${e.status}: waiting ${Math.round((e.retryAfterMs ?? 30_000) / 1000)} s`, Math.min(600_000, Math.max(5_000, e.retryAfterMs ?? 30_000)));
    }
    throw e;
  }
}

// When the last file of a shoot lands, one hub line. The UPDATE ... WHERE
// dropbox_synced_at IS NULL makes exactly one job the one that posts it.
async function noteShootDone(shootId: string, listingId: string, folder: string): Promise<void> {
  const d = db();
  const files = await d.query.shootFiles.findMany({ where: eq(schema.shootFiles.shootId, shootId), columns: { kind: true, dropboxSyncedAt: true } });
  if (!files.length || files.some((f) => !f.dropboxSyncedAt)) return;
  const won = await d
    .update(schema.shoots)
    .set({ dropboxSyncedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.shoots.id, shootId), isNull(schema.shoots.dropboxSyncedAt)))
    .returning({ id: schema.shoots.id });
  if (!won.length) return;
  const counts = countKinds(files);
  await logActivity({ action: "shoot.dropbox_synced", shootId, listingId, meta: { photos: counts.photos, video: counts.video, folder } });
}

// The #video-editing line (Nov 1 2026, src/lib/slack.ts): queued once per
// shoot (the job's key) when the shoot is submitted and every clip of it is
// in Dropbox, whatever its photos are still doing. Called when a clip lands
// and at Submit, since an upload's clips often finish copying before Submit
// is pressed. A draft may still have clips on the way (rows are made a batch
// at a time), so it waits for Submit. true = this call queued it.
export const VIDEO_EDITING_KIND: JobKind = "slack.video_editing";

export async function queueVideoEditingLine(shootId: string, listingId: string): Promise<boolean> {
  const d = db();
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { status: true } });
  if (!shoot || shoot.status === "draft") return false;
  // Nov 18 2026: in the business's file store, Dropbox or Google Drive (business.fileStore).
  const drive = business.fileStore === "google_drive";
  const clips = await d.query.shootFiles.findMany({ where: and(eq(schema.shootFiles.shootId, shootId), eq(schema.shootFiles.kind, "raw_video")), columns: { dropboxSyncedAt: true, driveSyncedAt: true } });
  if (!clips.length || clips.some((c) => !(drive ? c.driveSyncedAt : c.dropboxSyncedAt))) return false;
  return (await enqueueJobs([{ kind: VIDEO_EDITING_KIND, idempotencyKey: jobKey(VIDEO_EDITING_KIND, shootId), payload: { version: 1, shootId }, listingId }])) > 0;
}

// ---- The listing's folder (Oct 26 2026) -------------------------------------------
//
// the owner's SOP: the moment a shoot is booked, Dropbox gets a folder named for
// the address; the moment media is uploaded, the Photo and Video folders
// appear inside it. One dropbox.folder job per moment (payload.subfolders
// for the second), waiting quietly until Dropbox is connected. With the
// Video folder made, a view link to it is saved on the listing for the
// Video card (null when the app may not share: the card then links to the
// folder on dropbox.com for team members).

export async function runDropboxFolder(job: JobRow): Promise<void> {
  const p = job.payload ?? {};
  // The half-hourly pass over cards whose Video folder has no share link yet (scheduleVideoLinks).
  if (p.videoLinks) {
    const r = await retryVideoLinks();
    if (r.banned) throw new SkipJobError(`Dropbox is still refusing share links (${r.tried} tried, ${r.linked.length} linked)`);
    return;
  }
  if (!job.listingId) throw new FatalJobError("dropbox.folder needs a listing");
  if (!dropboxMirrorEnabled()) throw new NotConfiguredError(mirrorNotConfiguredReason());
  const d = db();
  const listing = await d.query.listings.findFirst({ where: eq(schema.listings.id, job.listingId), columns: { id: true, address: true, dropboxFolder: true, dropboxVideoLink: true } });
  if (!listing) throw new FatalJobError("that listing no longer exists");
  const api = dropboxApi();
  try {
    const folder = listing.dropboxFolder ?? listingFolderPath(dropboxRoot(), listing.address);
    if (!listing.dropboxFolder) {
      await api.createFolder(folder);
      await d.update(schema.listings).set({ dropboxFolder: folder }).where(and(eq(schema.listings.id, listing.id), isNull(schema.listings.dropboxFolder)));
    }
    if (!p.subfolders) return;
    // Photo only when the upload's photos came loose: a dropped folder
    // ("… raw") is their folder in Dropbox. Video always, for the editors'
    // link (a dropped "video" folder is the same folder; Dropbox ignores case).
    if (!(await photosCameAsFolder(p.shootId))) await api.createFolder(`${folder}/${RAW_PHOTOS_SUBFOLDER}`);
    await api.createFolder(`${folder}/${RAW_VIDEO_SUBFOLDER}`);
    if (!listing.dropboxVideoLink) {
      const link = await api.sharedLink(`${folder}/${RAW_VIDEO_SUBFOLDER}`);
      if (link) await d.update(schema.listings).set({ dropboxVideoLink: link }).where(eq(schema.listings.id, listing.id));
    }
  } catch (e) {
    if (isDropboxRetry(e)) throw new DeferError(`Dropbox ${e.status}: waiting ${Math.round((e.retryAfterMs ?? 30_000) / 1000)} s`, Math.min(600_000, Math.max(5_000, e.retryAfterMs ?? 30_000)));
    // The folders are made; only the share link is refused. Not a failure:
    // wait an hour and ask again (no attempt counted), and the half-hourly
    // pass below keeps asking after this job is done or dead.
    if (isDropboxSharingBan(e)) throw new DeferError(`Dropbox is refusing share links right now (${e.tag}); asking again in an hour`, 3_600_000);
    throw e;
  }
}

// ---- The Video share link, asked for again (Nov 5 2026) ------------------------
//
// the owner: the Dropbox link on 925 Example Spruce's Video card did not work. The share
// link is made by the folder job at upload; while Dropbox refused links (the
// Nov 2 block) that step failed, the listing kept no link, and the card fell
// back to the folder on dropbox.com, which only opens for people signed in
// to the business's account (not the editors). So every half hour the cron asks for
// a link for each open Video card whose listing has a folder and no link,
// and stops at the first refusal (the block covers the whole account).
export const VIDEO_LINKS_MS = 30 * 60_000;

export async function scheduleVideoLinks(now = Date.now()): Promise<number> {
  if (!dropboxMirrorEnabled()) return 0;
  return enqueueJobs([{ kind: FOLDER_KIND, idempotencyKey: jobKey(FOLDER_KIND, `video-links:${currentEnv()}:${Math.floor(now / VIDEO_LINKS_MS)}`, 1), payload: { version: 1, videoLinks: true }, listingId: null }]);
}

export async function retryVideoLinks(opts: { max?: number; listingId?: string } = {}): Promise<{ tried: number; linked: string[]; banned: boolean; error: string | null }> {
  const out = { tried: 0, linked: [] as string[], banned: false, error: null as string | null };
  const d = db();
  const env = currentEnv();
  const cards = await d.query.videoProjects.findMany({
    where: and(ne(schema.videoProjects.stage, "complete"), env === "production" ? or(eq(schema.videoProjects.env, env), isNull(schema.videoProjects.env)) : eq(schema.videoProjects.env, env), ...(opts.listingId ? [eq(schema.videoProjects.listingId, opts.listingId)] : [])),
    columns: { id: true, listingId: true },
    with: { listing: { columns: { id: true, address: true, dropboxFolder: true, dropboxVideoLink: true } } },
  });
  const seen = new Set<string>();
  const api = dropboxApi();
  for (const c of cards) {
    const l = c.listing;
    if (!l || seen.has(l.id) || !l.dropboxFolder || l.dropboxVideoLink) continue;
    seen.add(l.id);
    if (out.tried >= (opts.max ?? 10)) break;
    out.tried++;
    try {
      const path = `${l.dropboxFolder}/${RAW_VIDEO_SUBFOLDER}`;
      await api.createFolder(path);
      const link = await api.sharedLink(path);
      if (link) {
        await d.update(schema.listings).set({ dropboxVideoLink: link }).where(and(eq(schema.listings.id, l.id), isNull(schema.listings.dropboxVideoLink)));
        out.linked.push(l.id);
        await logActivity({ action: "dropbox.video_link", listingId: l.id, meta: { url: link } }).catch(() => undefined);
      }
    } catch (e) {
      if (isDropboxSharingBan(e)) {
        out.banned = true;
        out.error = e.tag;
        break;
      }
      if (isDropboxRetry(e)) {
        out.error = `Dropbox ${e.status}`;
        break;
      }
      console.error("[dropbox] video link", l.address, e);
      out.error = e instanceof Error ? e.message : String(e);
    }
  }
  return out;
}

// Every photo of the upload came from a dropped folder (none loose).
async function photosCameAsFolder(shootId: string | undefined): Promise<boolean> {
  if (!shootId || shootId === "backfill") return false;
  const files = await db().query.shootFiles.findMany({ where: eq(schema.shootFiles.shootId, shootId), columns: { kind: true, dropboxDir: true } });
  const photos = files.filter((f) => f.kind !== "raw_video");
  return photos.length > 0 && photos.every((f) => f.dropboxDir);
}

// subfolders false: the address folder at booking; true: Photo and Video at
// upload (a shoot id makes each upload its own job, so a later shoot on the
// same listing still makes sure they are there).
export async function enqueueDropboxFolder(opts: { listingId: string; subfolders?: boolean; shootId?: string; bookingId?: string | null }): Promise<number> {
  const key = opts.subfolders ? jobKey(FOLDER_KIND, `${opts.listingId}:media:${opts.shootId ?? "now"}`, 1) : jobKey(FOLDER_KIND, opts.listingId, 1);
  return enqueueJobs([{ kind: FOLDER_KIND, idempotencyKey: key, payload: { version: 1, subfolders: Boolean(opts.subfolders), ...(opts.subfolders && opts.shootId ? { shootId: opts.shootId } : {}) }, listingId: opts.listingId, bookingId: opts.bookingId ?? null }]);
}

// Where the Video card sends the editors: the saved view link, else the
// folder on dropbox.com (works for people in the account or its team).
export function videoFolderUrl(l: { dropboxFolder: string | null; dropboxVideoLink: string | null }): { url: string; shared: boolean } | null {
  if (l.dropboxVideoLink) return { url: l.dropboxVideoLink, shared: true };
  if (l.dropboxFolder) return { url: dropboxWebUrl(`${l.dropboxFolder}/${RAW_VIDEO_SUBFOLDER}`), shared: false };
  return null;
}

// ---- Enqueueing ---------------------------------------------------------------

// One job per file of the shoot (every file, or only those not yet copied).
// The version keys the jobs: 1 at submit; a later "Copy to Dropbox again"
// uses the current time so a done or dead job from before never blocks it.
export async function enqueueMirrorForShoot(opts: { shootId: string; listingId: string; onlyMissing?: boolean; version?: number }): Promise<number> {
  const d = db();
  const files = await d.query.shootFiles.findMany({
    where: opts.onlyMissing ? and(eq(schema.shootFiles.shootId, opts.shootId), isNull(schema.shootFiles.dropboxSyncedAt)) : eq(schema.shootFiles.shootId, opts.shootId),
    columns: { id: true },
  });
  if (!files.length) return 0;
  const version = opts.version ?? 1;
  return enqueueJobs(
    files.map((f) => ({
      kind: MIRROR_KIND,
      idempotencyKey: jobKey(MIRROR_KIND, f.id, version),
      payload: { version, shootFileId: f.id, shootId: opts.shootId, listingId: opts.listingId },
      listingId: opts.listingId,
    }))
  );
}

// The shoot page's line: how many of the shoot's files are in Dropbox.
export function mirrorSummary(files: { kind: string; dropboxSyncedAt: string | null }[]): { total: number; synced: number; photos: number; video: number } {
  const counts = countKinds(files);
  return { total: files.length, synced: files.filter((f) => f.dropboxSyncedAt).length, ...counts };
}

// ---- FINAL DELIVERY (Oct 27 2026) ----------------------------------------------
//
// the owner: "whenever FINAL outputs are delivered to clients, I want them to be
// saved in a Dropbox folder as well in that same listing under FINAL DELIVERY".
//
// Delivered = client visible (src/lib/media-visibility.ts) on a listing whose
// delivery email has gone out:
//   - Send delivery email queues a sweep of that listing.
//   - The minute cron queues a sweep of every listing delivered since
//     FINALS_SINCE once per FINAL_SWEEP_MS, so a revised photo or a film made
//     client visible after the email follows on its own.
// A sweep queues one dropbox.final job per client-visible file whose copy is
// missing or out of date; the job copies it to
// <listing folder>/FINAL DELIVERY/<section>/<filename> (src/lib/dropbox.ts)
// with the raw mirror's engine (one request, or a resumable upload session
// for big films). media.dropbox_final_key and _bytes say which version was
// copied: a replaced final (same key, new bytes) is copied again and its old
// copy goes to Dropbox's deleted files (restorable there). A file the team
// later makes internal stays in Dropbox: nothing is removed for that.
// Listings delivered before FINALS_SINCE: admin-api dropboxFinals.
export const FINALS_SINCE = Date.parse("2026-10-27T07:00:00Z"); // local midnight, the day it went live
export const FINAL_SWEEP_MS = 10 * 60_000;

type FinalRow = { id: string; listingId: string; kind: string; r2Key: string; filename: string; section: string | null; bytes: number | null; qcState: string; published: boolean; shootId: string | null; dropboxFinalKey: string | null; dropboxFinalBytes: number | null };

// Whether the copy in Dropbox is missing or older than the file (pure).
export function needsFinalCopy(m: { r2Key: string; bytes: number | null; dropboxFinalKey: string | null; dropboxFinalBytes: number | null }): boolean {
  if (m.dropboxFinalKey !== m.r2Key) return true;
  return m.bytes != null && m.dropboxFinalBytes !== m.bytes;
}

const versionTag = (m: { r2Key: string; bytes: number | null }) => createHash("sha1").update(`${m.r2Key}:${m.bytes ?? ""}`).digest("hex").slice(0, 12);

// Per listing: the client-visible files and those whose copy is due.
export async function planFinals(listingIds: string[]): Promise<{ listingId: string; visible: number; due: FinalRow[] }[]> {
  if (!listingIds.length) return [];
  const d = db();
  const [rows, shoots] = await Promise.all([
    d.query.media.findMany({
      where: inArray(schema.media.listingId, listingIds),
      columns: { id: true, listingId: true, kind: true, r2Key: true, filename: true, section: true, bytes: true, qcState: true, published: true, shootId: true, dropboxFinalKey: true, dropboxFinalBytes: true },
    }),
    d.query.shoots.findMany({ where: inArray(schema.shoots.listingId, listingIds), columns: { id: true, listingId: true, publishedAt: true } }),
  ]);
  return listingIds.map((listingId) => {
    const visible = clientVisibleMedia(rows.filter((r) => r.listingId === listingId), shoots.filter((s) => s.listingId === listingId));
    return { listingId, visible: visible.length, due: visible.filter(needsFinalCopy) };
  });
}

// The listings a sweep covers: one, or every listing delivered since `since`.
async function sweepListingIds(job: { listingId: string | null; payload: { since?: string } | null }): Promise<string[]> {
  if (job.listingId) return [job.listingId];
  const since = job.payload?.since ? new Date(job.payload.since) : new Date(FINALS_SINCE);
  const rows = await db().query.listings.findMany({ where: and(isNotNull(schema.listings.deliveryEmailAt), gte(schema.listings.deliveryEmailAt, since)), columns: { id: true } });
  return rows.map((r) => r.id);
}

export async function runFinalSweep(job: JobRow): Promise<void> {
  if (!dropboxMirrorEnabled()) throw new NotConfiguredError(mirrorNotConfiguredReason());
  const plans = await planFinals(await sweepListingIds(job));
  const specs = plans.flatMap((p) =>
    p.due.map((m) => ({
      kind: FINAL_KIND,
      // One job per version of the file: a replaced final gets a new one.
      idempotencyKey: jobKey(FINAL_KIND, `${m.id}:${versionTag(m)}`, 1),
      payload: { version: 1, mediaId: m.id, r2Key: m.r2Key },
      listingId: p.listingId,
    }))
  );
  for (let i = 0; i < specs.length; i += 200) await enqueueJobs(specs.slice(i, i + 200));
}

export async function runDropboxFinal(job: JobRow): Promise<void> {
  const p = job.payload ?? {};
  if (!p.mediaId) throw new FatalJobError("dropbox.final needs payload.mediaId");
  if (!dropboxMirrorEnabled()) throw new NotConfiguredError(mirrorNotConfiguredReason());
  const d = db();
  const m = await d.query.media.findFirst({ where: eq(schema.media.id, p.mediaId) });
  if (!m) throw new SkipJobError("that file was removed from the listing");
  const [listing, shoots] = await Promise.all([
    d.query.listings.findFirst({ where: eq(schema.listings.id, m.listingId), columns: { id: true, address: true, dropboxFolder: true } }),
    d.query.shoots.findMany({ where: eq(schema.shoots.listingId, m.listingId), columns: { id: true, publishedAt: true } }),
  ]);
  if (!listing) throw new FatalJobError("that listing no longer exists");
  if (!clientVisibleMedia([m], shoots).length) throw new SkipJobError("no longer client visible");
  const head = await headObject(m.r2Key);
  if (!head || head.size <= 0) throw new FatalJobError(`${m.filename} is not in storage, so there is nothing to copy`);
  if (m.dropboxFinalKey === m.r2Key && m.dropboxFinalBytes === head.size) throw new SkipJobError("already in FINAL DELIVERY");

  const api = dropboxApi();
  try {
    let folder = listing.dropboxFolder;
    if (!folder) {
      folder = listingFolderPath(dropboxRoot(), listing.address);
      await api.createFolder(folder);
      await d.update(schema.listings).set({ dropboxFolder: folder }).where(and(eq(schema.listings.id, listing.id), isNull(schema.listings.dropboxFolder)));
    }
    // A new version of a file already copied: its old copy makes room (Dropbox
    // keeps deleted files, so it can be restored there). Once only: a resumed
    // run already has its session.
    if (!p.session && m.dropboxFinalPath) {
      const old = await api.getMetadata(m.dropboxFinalPath);
      if (old && old.tag === "file" && old.size !== head.size) await api.deletePath(m.dropboxFinalPath);
    }
    const deadline = Math.min(drainDeadline(), Date.now() + MIRROR_SLICE_MS);
    const out = await mirrorFile({
      api,
      size: head.size,
      readAll: async () => (await getObjectBuffer(m.r2Key)).body,
      read: (s, e) => getObjectRange(m.r2Key, s, e),
      now: () => Date.now(),
      deadline,
      cursor: p.session ?? null,
      persist: (c) => saveCursor(job, c),
      lease: () => d.update(schema.jobs).set({ leaseUntil: new Date(Date.now() + LEASE_MS) }).where(eq(schema.jobs.id, job.id)).then(() => undefined),
      paths: [finalTargetPath(folder, m), finalAlternatePath(folder, m)],
    });
    if (!out.done) {
      const at = out.cursor?.offset ?? 0;
      throw new DeferError(`continuing at ${fmtBytes(at)} of ${fmtBytes(head.size)}`, 1_000);
    }
    await d.update(schema.media).set({ dropboxFinalPath: out.path, dropboxFinalKey: m.r2Key, dropboxFinalBytes: head.size, dropboxFinalAt: new Date() }).where(eq(schema.media.id, m.id));
  } catch (e) {
    if (e instanceof MirrorError) throw e.fatal ? new FatalJobError(e.message) : new Error(e.message);
    if (isDropboxRetry(e)) {
      const waits = (typeof p.waits === "number" ? p.waits : 0) + 1;
      if (waits > MAX_RATE_WAITS) throw new Error(`Dropbox kept answering ${e.status} (${waits} waits): ${e.tag}`);
      await saveCursor(job, p.session ?? null, { waits });
      throw new DeferError(`Dropbox ${e.status}: waiting ${Math.round((e.retryAfterMs ?? 30_000) / 1000)} s`, Math.min(600_000, Math.max(5_000, e.retryAfterMs ?? 30_000)));
    }
    throw e;
  }
}

// After a delivery email (one sweep per send), or by the operator.
export async function enqueueFinalSweep(opts: { listingId?: string; since?: Date; key?: string }): Promise<number> {
  const id = opts.listingId ?? `all:${opts.since?.toISOString() ?? "default"}`;
  return enqueueJobs([{ kind: FINAL_SWEEP_KIND, idempotencyKey: jobKey(FINAL_SWEEP_KIND, `${id}:${opts.key ?? Date.now()}`, 1), payload: { version: 1, ...(opts.since ? { since: opts.since.toISOString() } : {}) }, listingId: opts.listingId ?? null }]);
}

// The minute cron: one sweep of every recently delivered listing per FINAL_SWEEP_MS.
export async function scheduleFinalSweep(now = Date.now()): Promise<number> {
  if (!dropboxMirrorEnabled()) return 0;
  return enqueueFinalSweep({ key: `${currentEnv()}:${Math.floor(now / FINAL_SWEEP_MS)}` });
}

// The listing page's line: how many delivered files are in FINAL DELIVERY.
export async function finalsStatus(listingId: string): Promise<{ visible: number; copied: number }> {
  const [p] = await planFinals([listingId]);
  return { visible: p?.visible ?? 0, copied: (p?.visible ?? 0) - (p?.due.length ?? 0) };
}
