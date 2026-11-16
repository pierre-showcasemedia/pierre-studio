// Raws leave R2 once Dropbox holds a verified copy (Oct 27 2026).
//
// the owner's rule: raws are hosted in Dropbox; the only files that stay in R2
// for good are the finals delivered to clients and served by the portal. So
// every raw upload (shoot_files kinds raw, display and raw_video, under
// shoots/<id>/raw/ or shoots/<id>/raw-video/) is deleted from R2 once BOTH
// sides are checked:
//
//   1. the row says the mirror copied it (dropbox_synced_at, dropbox_path);
//   2. Dropbox has a file at that path with the same size as the R2 object;
//   3. Dropbox's content hash of that file equals the same hash computed here
//      from the R2 bytes (4 MiB blocks, SHA-256 each, SHA-256 of the digests:
//      developers.dropbox.com/dropbox-content-hasher), read in ranges so a
//      5 GB clip carries on across cron ticks;
//   4. editing is done with it: a photo only once its shoot is in review or
//      published (a stopped shoot's retry sends raws again); a clip never
//      goes to editing, but waits for Submit (which checks every file is
//      still in R2; copies start during the upload);
//   5. no media row points at the key, and the key is a raw upload key
//      (never finals/, replaced/ or anything else).
//
// Only then the object is deleted, a HEAD confirms it is gone, and the row
// records r2_deleted_at and the matching hash. Any mismatch keeps the R2
// copy, and the hub hears about it once per shoot. One r2.raw_cleanup job per
// file and Dropbox copy; the cron queues them every 15 minutes (r2.raw_sweep).
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import type { JobKind, ShootStatus } from "@/db/schema";
import { logActivity } from "./activity";
import { dropboxApi, dropboxMirrorEnabled } from "./dropbox";
import { currentEnv, DeferError, drainDeadline, enqueueJobs, FatalJobError, jobKey, NotConfiguredError, SkipJobError } from "./jobs-core";
import { deleteObject, getObjectRange, headObject } from "./r2";

export const RAW_SWEEP_KIND: JobKind = "r2.raw_sweep";
export const RAW_CLEANUP_KIND: JobKind = "r2.raw_cleanup";
export const RAW_SWEEP_MS = 15 * 60_000;

// A photo's raw is kept until editing is done with it.
export const EDITING_DONE: readonly ShootStatus[] = ["ready_for_review", "published", "video_only"];

const BLOCK = 4 * 1024 * 1024;
// Bytes read from R2 per step: whole blocks, small enough for memory.
const RANGE = 8 * BLOCK;
// Stop reading this long before the drain's deadline.
const TAIL_MS = 5_000;

// ---- Dropbox content hash ------------------------------------------------------

// The SHA-256 of each 4 MiB block of `buf`, as hex, joined. `buf` starts on a
// block boundary of the file (every range but the last is whole blocks).
export function blockDigests(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i += BLOCK) out += createHash("sha256").update(buf.subarray(i, Math.min(i + BLOCK, buf.length))).digest("hex");
  return out;
}

// The file's content hash from all its block digests.
export function contentHashFromDigests(hex: string): string {
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}

export function dropboxContentHash(buf: Uint8Array): string {
  return contentHashFromDigests(blockDigests(buf));
}

// ---- What may be deleted -------------------------------------------------------------

export function isRawUploadKey(shootId: string, key: string): boolean {
  const p = `shoots/${shootId}/`;
  if (!key.startsWith(p)) return false;
  const rest = key.slice(p.length);
  return /^(raw|raw-video)\/[^/]+$/.test(rest);
}

type FileLike = { shootId: string; kind: string; r2Key: string; dropboxPath: string | null; dropboxSyncedAt: Date | string | null; r2DeletedAt: Date | string | null };

// Why a raw must stay in R2 for now, or null when it may be checked.
export function cleanupBlocker(f: FileLike, shootStatus: string): string | null {
  if (f.r2DeletedAt) return "already removed from R2";
  if (!isRawUploadKey(f.shootId, f.r2Key)) return "not a raw upload";
  if (!f.dropboxSyncedAt || !f.dropboxPath) return "not in Dropbox yet";
  // Copies now start while the upload runs; Submit checks every file is in R2.
  if (shootStatus === "draft") return "the upload isn't submitted yet";
  if (f.kind !== "raw_video" && !(EDITING_DONE as readonly string[]).includes(shootStatus)) return "editing may still need it";
  return null;
}

// ---- The sweep -----------------------------------------------------------------------

export async function scheduleRawSweep(now = Date.now()): Promise<number> {
  if (!dropboxMirrorEnabled()) return 0;
  return enqueueJobs([{ kind: RAW_SWEEP_KIND, idempotencyKey: jobKey(RAW_SWEEP_KIND, `${currentEnv()}:${Math.floor(now / RAW_SWEEP_MS)}`, 1), payload: { version: 1 } }]);
}

export async function enqueueRawSweepNow(): Promise<number> {
  return enqueueJobs([{ kind: RAW_SWEEP_KIND, idempotencyKey: jobKey(RAW_SWEEP_KIND, `now:${Date.now()}`, 1), payload: { version: 1 } }]);
}

// Raws still in R2 that Dropbox has a copy of, with their shoot's status.
async function candidates() {
  return db()
    .select({ id: schema.shootFiles.id, shootId: schema.shootFiles.shootId, kind: schema.shootFiles.kind, r2Key: schema.shootFiles.r2Key, bytes: schema.shootFiles.bytes, dropboxPath: schema.shootFiles.dropboxPath, dropboxSyncedAt: schema.shootFiles.dropboxSyncedAt, r2DeletedAt: schema.shootFiles.r2DeletedAt, status: schema.shoots.status, listingId: schema.shoots.listingId })
    .from(schema.shootFiles)
    .innerJoin(schema.shoots, eq(schema.shoots.id, schema.shootFiles.shootId))
    .where(and(isNull(schema.shootFiles.r2DeletedAt), isNotNull(schema.shootFiles.dropboxSyncedAt), isNotNull(schema.shootFiles.dropboxPath), or(eq(schema.shootFiles.kind, "raw_video"), inArray(schema.shoots.status, [...EDITING_DONE]))));
}

// One cleanup job per file and Dropbox copy: a new copy (Copy to Dropbox
// again) gets a fresh check; a file already checked is not queued twice.
export async function runRawSweep(): Promise<void> {
  if (!dropboxMirrorEnabled()) throw new NotConfiguredError("Dropbox mirror (production only unless DROPBOX_MIRROR=on)");
  const rows = (await candidates()).filter((r) => cleanupBlocker(r, r.status) === null);
  const specs = rows.map((r) => ({
    kind: RAW_CLEANUP_KIND,
    idempotencyKey: jobKey(RAW_CLEANUP_KIND, `${r.id}:${new Date(r.dropboxSyncedAt!).getTime()}`, 1),
    payload: { version: 1, shootFileId: r.id, shootId: r.shootId },
    listingId: r.listingId,
  }));
  for (let i = 0; i < specs.length; i += 200) await enqueueJobs(specs.slice(i, i + 200));
}

// ---- One file ----------------------------------------------------------------------------

type JobRow = typeof schema.jobs.$inferSelect;

async function saveHashState(job: JobRow, hashOffset: number, blockHashes: string): Promise<void> {
  await db().update(schema.jobs).set({ payload: { ...(job.payload ?? {}), hashOffset, blockHashes }, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
}

// The R2 copy stays. The first kept file of a shoot is a hub line
// (shoot.r2_raw_kept); later ones are logged only (shoot.r2_raw_kept_again).
async function keep(file: { id: string; filename: string; shootId: string }, listingId: string, reason: string): Promise<never> {
  const told = await db().query.activity.findFirst({ where: and(eq(schema.activity.action, "shoot.r2_raw_kept"), eq(schema.activity.shootId, file.shootId)), columns: { id: true } });
  await logActivity({ action: told ? "shoot.r2_raw_kept_again" : "shoot.r2_raw_kept", shootId: file.shootId, listingId, meta: { file: file.filename, reason } });
  throw new SkipJobError(`kept in R2: ${reason}`);
}

export async function runRawCleanup(job: JobRow): Promise<void> {
  const p = job.payload ?? {};
  if (!p.shootFileId) throw new FatalJobError("r2.raw_cleanup needs payload.shootFileId");
  if (!dropboxMirrorEnabled()) throw new NotConfiguredError("Dropbox mirror (production only unless DROPBOX_MIRROR=on)");
  const d = db();
  const file = await d.query.shootFiles.findFirst({ where: eq(schema.shootFiles.id, p.shootFileId), with: { shoot: { columns: { id: true, status: true, listingId: true } } } });
  if (!file) throw new SkipJobError("that shoot file no longer exists");
  const shoot = file.shoot;

  // Checked again here: the shoot or the row may have moved since the sweep.
  const blocker = cleanupBlocker(file, shoot.status);
  if (blocker) throw new SkipJobError(blocker);
  const usedByMedia = await d.query.media.findFirst({ where: eq(schema.media.r2Key, file.r2Key), columns: { id: true } });
  if (usedByMedia) throw new SkipJobError("a gallery file uses this key");

  const head = await headObject(file.r2Key);
  const api = dropboxApi();
  const meta = await api.getMetadata(file.dropboxPath!);
  if (!head) {
    // Gone from R2 already (a run that deleted it and stopped before writing
    // the row): recorded only when Dropbox has the file at the right size.
    if (meta?.tag === "file" && file.bytes != null && meta.size === file.bytes && meta.contentHash) {
      await d.update(schema.shootFiles).set({ r2DeletedAt: new Date(), dropboxHash: meta.contentHash }).where(and(eq(schema.shootFiles.id, file.id), isNull(schema.shootFiles.r2DeletedAt)));
      await noteShootCleared(shoot.id, shoot.listingId);
      return;
    }
    throw new SkipJobError("not in R2");
  }

  // Dropbox's side: a file at the recorded path, same size, with its hash.
  if (!meta || meta.tag !== "file") return keep(file, shoot.listingId, `Dropbox has no file at ${file.dropboxPath}.`);
  if (meta.size !== head.size) return keep(file, shoot.listingId, `Dropbox's copy is ${meta.size ?? "?"} bytes, R2's is ${head.size}.`);
  if (!meta.contentHash) return keep(file, shoot.listingId, "Dropbox did not return a content hash.");

  // Our side: the same hash from the R2 bytes, resumable across ticks.
  let offset = typeof p.hashOffset === "number" ? p.hashOffset : 0;
  let digests = typeof p.blockHashes === "string" ? p.blockHashes : "";
  if (offset % BLOCK !== 0 || digests.length !== (offset / BLOCK) * 64) {
    offset = 0;
    digests = "";
  }
  const stopAt = drainDeadline() - TAIL_MS;
  while (offset < head.size) {
    if (Date.now() > stopAt) {
      await saveHashState(job, offset, digests);
      throw new DeferError(`hashing at ${Math.round(offset / 1e6)} of ${Math.round(head.size / 1e6)} MB`, 1_000);
    }
    const end = Math.min(offset + RANGE, head.size) - 1;
    const buf = await getObjectRange(file.r2Key, offset, end);
    if (buf.length !== end - offset + 1) throw new Error(`R2 returned ${buf.length} bytes for ${end - offset + 1}`);
    digests += blockDigests(buf);
    offset = end + 1;
  }
  const ours = contentHashFromDigests(digests);
  if (ours !== meta.contentHash) {
    await saveHashState(job, 0, "");
    return keep(file, shoot.listingId, "Dropbox's copy does not match the R2 bytes (content hash).");
  }

  // Verified. Delete, confirm it is gone, record it.
  await deleteObject(file.r2Key);
  if (await headObject(file.r2Key)) throw new Error("R2 still has the object after the delete");
  await d.update(schema.shootFiles).set({ r2DeletedAt: new Date(), dropboxHash: ours }).where(and(eq(schema.shootFiles.id, file.id), isNull(schema.shootFiles.r2DeletedAt)));
  await noteShootCleared(shoot.id, shoot.listingId);
}

// When the last raw of a shoot leaves R2: one activity row.
async function noteShootCleared(shootId: string, listingId: string): Promise<void> {
  const d = db();
  const files = await d.query.shootFiles.findMany({ where: eq(schema.shootFiles.shootId, shootId), columns: { r2DeletedAt: true, bytes: true } });
  if (!files.length || files.some((f) => !f.r2DeletedAt)) return;
  const done = await d.query.activity.findFirst({ where: and(eq(schema.activity.action, "shoot.r2_raws_removed"), eq(schema.activity.shootId, shootId)), columns: { id: true } });
  if (done) return;
  await logActivity({ action: "shoot.r2_raws_removed", shootId, listingId, meta: { files: files.length, bytes: files.reduce((a, f) => a + (f.bytes ?? 0), 0) } });
}

// ---- Status (admin-api r2RawCleanup) ---------------------------------------------------

export async function rawCleanupStatus(): Promise<Record<string, { files: number; bytes: number }>> {
  const rows = await db()
    .select({ shootId: schema.shootFiles.shootId, kind: schema.shootFiles.kind, r2Key: schema.shootFiles.r2Key, bytes: schema.shootFiles.bytes, dropboxPath: schema.shootFiles.dropboxPath, dropboxSyncedAt: schema.shootFiles.dropboxSyncedAt, r2DeletedAt: schema.shootFiles.r2DeletedAt, status: schema.shoots.status })
    .from(schema.shootFiles)
    .innerJoin(schema.shoots, eq(schema.shoots.id, schema.shootFiles.shootId));
  const out: Record<string, { files: number; bytes: number }> = {};
  for (const r of rows) {
    const k = cleanupBlocker(r, r.status) ?? "ready to check";
    out[k] = out[k] ?? { files: 0, bytes: 0 };
    out[k].files++;
    out[k].bytes += r.bytes ?? 0;
  }
  return out;
}
