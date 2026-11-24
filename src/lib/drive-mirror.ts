// The Google Drive mirror (Nov 18 2026). The Dropbox mirror's twin
// (src/lib/dropbox-mirror.ts) for a business that keeps its files in Google
// Drive. Same folders, same rules:
//
//   Listings/<address>/Photo/<file>            every raw photo a shooter uploads
//   Listings/<address>/Video/<file>            every raw clip
//   Listings/<address>/<dropped folder>/...    a dropped folder keeps its shape
//   Listings/<address>/FINAL DELIVERY/<section>/<file>   what the client was delivered
//
// One drive.mirror job per shoot_files row (queued at Submit and by "Copy to
// Google Drive again"), one drive.final job per delivered file version
// (queued by a drive.final_sweep after each delivery email and every ten
// minutes). Each job streams the file from R2 into a Drive resumable upload:
//
//   - the session address and the next byte are saved on the job after every
//     chunk, the lease is refreshed, and near the drain's deadline the job
//     saves and defers: the next tick carries on where Google says it is;
//   - a session Google has forgotten (404 / 410) starts over;
//   - a file of the same name and size already in the folder is a skip; the
//     same name with another size goes under a second name;
//   - Google 429 / 5xx / rate-limit 403 defer for a while (no attempt counted);
//   - not configured or not connected here: NotConfiguredError, the job waits.
//
// mirrorToDrive() is the engine with everything outside injected (DriveMirrorIo);
// scripts/check-drive-mirror.ts runs it against a fake Drive and a fake clock.
import { createHash } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import type { JobKind } from "@/db/schema";
import { logActivity } from "./activity";
import { alternateFilename, cleanDropboxDir, dropboxFolderName, FINAL_DELIVERY_FOLDER, finalSubfolder, mirrorSubfolder } from "./dropbox";
import { DriveApi, driveApi, driveMirrorEnabled, driveRootId, hasDriveApp, isDriveNotFound, isDriveRetry } from "./google-drive";
import { currentEnv, DeferError, drainDeadline, enqueueJobs, FatalJobError, jobKey, NotConfiguredError, SkipJobError } from "./jobs-core";
import { getObjectRange, headObject } from "./r2";
import { countKinds } from "./shoot-files";
import { clientVisibleMedia } from "./media-visibility";
import { contentTypeFor } from "./autohdr-constants";

export const DRIVE_MIRROR_KIND: JobKind = "drive.mirror";
export const DRIVE_FINAL_SWEEP_KIND: JobKind = "drive.final_sweep";
export const DRIVE_FINAL_KIND: JobKind = "drive.final";
export const DRIVE_KINDS: readonly JobKind[] = [DRIVE_MIRROR_KIND, DRIVE_FINAL_SWEEP_KIND, DRIVE_FINAL_KIND];

// Every chunk but the last must be a multiple of 256 KiB (Google's rule).
export const DRIVE_CHUNK_BYTES = 32 * 1024 * 1024;
export const DRIVE_SLICE_MS = 60_000;
export const DRIVE_TAIL_MS = 4_000;
const PLAN_BYTES_PER_SEC = 8e6;
const MAX_RATE_WAITS = 20;
const LEASE_MS = 120_000;

export type DriveCursor = { uri: string; offset: number; name: string; folderId: string; startedAt: string } | null;

export type DriveMirrorApi = Pick<DriveApi, "findChild" | "startUpload" | "putChunk" | "uploadStatus">;

export type DriveMirrorIo = {
  api: DriveMirrorApi;
  folderId: string; // where the file goes
  names: string[]; // the name first, then the one to use when another file holds it
  size: number; // the object's size in storage
  contentType: string;
  read(start: number, endInclusive: number): Promise<Uint8Array>;
  now(): number;
  deadline: number;
  cursor: DriveCursor; // where the previous run stopped, if it did
  persist(cursor: DriveCursor): Promise<void>;
  lease(): Promise<void>;
  chunkBytes?: number; // tests shrink it (a multiple of 256 KiB in production)
};

export type DriveMirrorOutcome = { done: true; fileId: string; name: string; skipped: boolean } | { done: false; cursor: DriveCursor };

export class DriveMirrorError extends Error {
  fatal: boolean;
  constructor(message: string, fatal = false) {
    super(message);
    this.name = "DriveMirrorError";
    this.fatal = fatal;
  }
}

const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

function fits(io: DriveMirrorIo, bytes: number): boolean {
  const need = (bytes / PLAN_BYTES_PER_SEC) * 1000 + 2_000;
  return io.deadline - io.now() - DRIVE_TAIL_MS >= need;
}

// The name to write under, or the file already there with this exact size.
async function chooseName(io: DriveMirrorIo): Promise<{ name: string; existing: string | null }> {
  for (const name of io.names) {
    const f = await io.api.findChild(io.folderId, name);
    if (!f) return { name, existing: null };
    if (f.size === io.size) return { name, existing: f.id };
  }
  throw new DriveMirrorError(`Every name for this file is taken in Google Drive by a file of another size (${io.names.join(", ")}).`, true);
}

export async function mirrorToDrive(io: DriveMirrorIo): Promise<DriveMirrorOutcome> {
  if (io.size <= 0) throw new DriveMirrorError("The file in storage is empty.", true);
  const CHUNK = io.chunkBytes ?? DRIVE_CHUNK_BYTES;
  let cursor: DriveCursor = io.cursor && io.cursor.folderId === io.folderId ? io.cursor : null;

  // A session from an earlier run: ask Google how far it got.
  if (cursor) {
    try {
      const st = await io.api.uploadStatus(cursor.uri, io.size);
      if (st.done) {
        await io.persist(null);
        return { done: true, fileId: st.file.id, name: cursor.name, skipped: false };
      }
      cursor = { ...cursor, offset: st.next };
    } catch (e) {
      if (!isDriveNotFound(e)) throw e;
      cursor = null; // forgotten: start over
      await io.persist(null);
    }
  }

  for (let guard = 0; guard < 2000; guard++) {
    if (!cursor) {
      const chosen = await chooseName(io);
      if (chosen.existing) return { done: true, fileId: chosen.existing, name: chosen.name, skipped: true };
      if (!fits(io, Math.min(CHUNK, io.size))) return { done: false, cursor: null };
      const uri = await io.api.startUpload(io.folderId, chosen.name, io.size, io.contentType);
      cursor = { uri, offset: 0, name: chosen.name, folderId: io.folderId, startedAt: new Date(io.now()).toISOString() };
      await io.persist(cursor);
    }
    const offset = cursor.offset;
    const len = Math.min(CHUNK, io.size - offset);
    if (!fits(io, len)) {
      await io.persist(cursor);
      return { done: false, cursor };
    }
    const chunk = await io.read(offset, offset + len - 1);
    try {
      const r = await io.api.putChunk(cursor.uri, offset, chunk, io.size);
      if (r.done) {
        await io.persist(null);
        return { done: true, fileId: r.file.id, name: cursor.name, skipped: false };
      }
      // Google says how much it holds; that is where the next chunk starts.
      cursor = { ...cursor, offset: r.next };
      await io.persist(cursor);
      await io.lease();
    } catch (e) {
      if (isDriveNotFound(e)) {
        cursor = null;
        await io.persist(null);
        continue;
      }
      throw e;
    }
  }
  throw new DriveMirrorError("The copy did not finish after many chunks; check the job.");
}

// ---- Job plumbing --------------------------------------------------------------

type JobRow = typeof schema.jobs.$inferSelect;

export function driveNotConfiguredReason(): string {
  if (!hasDriveApp()) return "Google Drive (NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET)";
  return `Google Drive mirror on ${currentEnv()} (production only unless GOOGLE_DRIVE_MIRROR=on)`;
}

async function saveCursor(job: JobRow, c: DriveCursor, extra: Record<string, unknown> = {}): Promise<void> {
  const payload = { ...(job.payload ?? {}), ...extra, driveSession: c ?? undefined };
  await db().update(schema.jobs).set({ payload, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
}

const leaseFor = (job: JobRow) => () =>
  db().update(schema.jobs).set({ leaseUntil: new Date(Date.now() + LEASE_MS) }).where(eq(schema.jobs.id, job.id)).then(() => undefined);

// Google asked for a pause: wait without counting an attempt; one that keeps
// refusing becomes a normal failure (backoff, alert).
async function deferForRate(job: JobRow, e: { status: number; reason: string; retryAfterMs: number | null }): Promise<never> {
  const p = job.payload ?? {};
  const waits = (typeof p.waits === "number" ? p.waits : 0) + 1;
  if (waits > MAX_RATE_WAITS) throw new Error(`Google Drive kept answering ${e.status} (${waits} waits): ${e.reason}`);
  await saveCursor(job, (p.driveSession as DriveCursor) ?? null, { waits });
  const ms = Math.min(600_000, Math.max(5_000, e.retryAfterMs ?? 30_000 * waits));
  throw new DeferError(`Google Drive ${e.status}: waiting ${Math.round(ms / 1000)} s`, ms);
}

// The listing's folder (Listings/<address as it was>), made once and kept, so
// an address edited later never leaves files behind under the old name.
async function listingFolder(api: DriveApi, listing: { id: string; address: string; driveFolderId: string | null }): Promise<string> {
  if (listing.driveFolderId) return listing.driveFolderId;
  const root = await driveRootId(api);
  const id = await api.ensureFolder(root, dropboxFolderName(listing.address));
  await db().update(schema.listings).set({ driveFolderId: id }).where(and(eq(schema.listings.id, listing.id), isNull(schema.listings.driveFolderId)));
  const again = await db().query.listings.findFirst({ where: eq(schema.listings.id, listing.id), columns: { driveFolderId: true } });
  return again?.driveFolderId ?? id;
}

// ---- drive.mirror: one raw file -----------------------------------------------

export async function runDriveMirror(job: JobRow): Promise<void> {
  const p = job.payload ?? {};
  if (!p.shootFileId) throw new FatalJobError("drive.mirror needs payload.shootFileId");
  if (!driveMirrorEnabled()) throw new NotConfiguredError(driveNotConfiguredReason());
  const d = db();
  const file = await d.query.shootFiles.findFirst({ where: eq(schema.shootFiles.id, p.shootFileId), with: { shoot: { with: { listing: true } } } });
  if (!file) throw new FatalJobError("that shoot file no longer exists");
  if (file.driveSyncedAt) throw new SkipJobError("already in Google Drive");
  if (file.r2DeletedAt) throw new SkipJobError("the raw already left storage, so there is nothing to copy");
  const shoot = file.shoot;
  const listing = shoot.listing;
  const head = await headObject(file.r2Key);
  if (!head || head.size <= 0) throw new FatalJobError(`${file.filename} is not in storage, so there is nothing to copy`);

  const api = driveApi();
  try {
    const folder = await listingFolder(api, listing);
    const dir = cleanDropboxDir(file.dropboxDir);
    const target = await api.ensurePath(folder, dir ? dir.split("/") : [mirrorSubfolder(file.kind)]);
    const out = await mirrorToDrive({
      api,
      folderId: target,
      names: [file.filename, alternateFilename(file.filename, shoot.id)],
      size: head.size,
      contentType: file.contentType || contentTypeFor(file.filename, "application/octet-stream"),
      read: (s, e) => getObjectRange(file.r2Key, s, e),
      now: () => Date.now(),
      deadline: Math.min(drainDeadline(), Date.now() + DRIVE_SLICE_MS),
      cursor: (p.driveSession as DriveCursor) ?? null,
      persist: (c) => saveCursor(job, c),
      lease: leaseFor(job),
    });
    if (!out.done) throw new DeferError(`continuing at ${fmtBytes(out.cursor?.offset ?? 0)} of ${fmtBytes(head.size)}`, 1_000);
    await d.update(schema.shootFiles).set({ driveFileId: out.fileId, driveSyncedAt: new Date() }).where(eq(schema.shootFiles.id, file.id));
    // Raw video in Drive: the Video board hears once every clip of the shoot is in.
    if (file.kind === "raw_video") {
      const { queueVideoEditingLine } = await import("./dropbox-mirror");
      await queueVideoEditingLine(shoot.id, listing.id).catch((e) => console.error("[drive-mirror] video editing line", shoot.id, e));
    }
    await noteShootInDrive(shoot.id, listing.id);
  } catch (e) {
    if (e instanceof DriveMirrorError) throw e.fatal ? new FatalJobError(e.message) : new Error(e.message);
    if (isDriveRetry(e)) await deferForRate(job, e);
    throw e;
  }
}

// When the last file of a shoot lands, one activity line (whichever job sets
// the shoot's stamp first posts it).
async function noteShootInDrive(shootId: string, listingId: string): Promise<void> {
  const d = db();
  const files = await d.query.shootFiles.findMany({ where: eq(schema.shootFiles.shootId, shootId), columns: { kind: true, driveSyncedAt: true } });
  if (!files.length || files.some((f) => !f.driveSyncedAt)) return;
  const won = await d
    .update(schema.shoots)
    .set({ driveSyncedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.shoots.id, shootId), isNull(schema.shoots.driveSyncedAt)))
    .returning({ id: schema.shoots.id });
  if (!won.length) return;
  const counts = countKinds(files);
  await logActivity({ action: "shoot.drive_synced", shootId, listingId, meta: { photos: counts.photos, video: counts.video } });
}

// One job per file of the shoot (every file, or only those not yet copied).
// Version 1 at Submit; "Copy to Google Drive again" uses the current time so a
// done or dead job from before never blocks it.
export async function enqueueDriveMirrorForShoot(opts: { shootId: string; listingId: string; onlyMissing?: boolean; version?: number }): Promise<number> {
  const files = await db().query.shootFiles.findMany({
    where: opts.onlyMissing ? and(eq(schema.shootFiles.shootId, opts.shootId), isNull(schema.shootFiles.driveSyncedAt)) : eq(schema.shootFiles.shootId, opts.shootId),
    columns: { id: true },
  });
  if (!files.length) return 0;
  const version = opts.version ?? 1;
  return enqueueJobs(
    files.map((f) => ({
      kind: DRIVE_MIRROR_KIND,
      idempotencyKey: jobKey(DRIVE_MIRROR_KIND, f.id, version),
      payload: { version, shootFileId: f.id, shootId: opts.shootId, listingId: opts.listingId },
      listingId: opts.listingId,
    }))
  );
}

// The shoot page's line: how many of the shoot's files are in Google Drive.
export function driveMirrorSummary(files: { kind: string; driveSyncedAt: string | Date | null }[]): { total: number; synced: number } {
  return { total: files.length, synced: files.filter((f) => f.driveSyncedAt).length };
}

// ---- FINAL DELIVERY ---------------------------------------------------------------

// Listings delivered before this are left alone (the day it went live).
export const DRIVE_FINALS_SINCE = Date.parse("2026-11-18T07:00:00Z");
export const DRIVE_FINAL_SWEEP_MS = 10 * 60_000;

type FinalRow = { id: string; listingId: string; kind: string; r2Key: string; filename: string; section: string | null; bytes: number | null; qcState: string; published: boolean; shootId: string | null; driveFinalKey: string | null; driveFinalBytes: number | null };

// Whether the copy in Drive is missing or older than the file (pure).
export function needsDriveFinal(m: { r2Key: string; bytes: number | null; driveFinalKey: string | null; driveFinalBytes: number | null }): boolean {
  if (m.driveFinalKey !== m.r2Key) return true;
  return m.bytes != null && m.driveFinalBytes !== m.bytes;
}

const versionTag = (m: { r2Key: string; bytes: number | null }) => createHash("sha1").update(`${m.r2Key}:${m.bytes ?? ""}`).digest("hex").slice(0, 12);

export async function planDriveFinals(listingIds: string[]): Promise<{ listingId: string; visible: number; due: FinalRow[] }[]> {
  if (!listingIds.length) return [];
  const d = db();
  const [rows, shoots] = await Promise.all([
    d.query.media.findMany({
      where: inArray(schema.media.listingId, listingIds),
      columns: { id: true, listingId: true, kind: true, r2Key: true, filename: true, section: true, bytes: true, qcState: true, published: true, shootId: true, driveFinalKey: true, driveFinalBytes: true },
    }),
    d.query.shoots.findMany({ where: inArray(schema.shoots.listingId, listingIds), columns: { id: true, listingId: true, publishedAt: true } }),
  ]);
  return listingIds.map((listingId) => {
    const visible = clientVisibleMedia(rows.filter((r) => r.listingId === listingId), shoots.filter((s) => s.listingId === listingId));
    return { listingId, visible: visible.length, due: visible.filter(needsDriveFinal) };
  });
}

async function sweepListingIds(job: { listingId: string | null; payload: { since?: string } | null }): Promise<string[]> {
  if (job.listingId) return [job.listingId];
  const since = job.payload?.since ? new Date(job.payload.since) : new Date(DRIVE_FINALS_SINCE);
  const rows = await db().query.listings.findMany({ where: and(isNotNull(schema.listings.deliveryEmailAt), gte(schema.listings.deliveryEmailAt, since)), columns: { id: true } });
  return rows.map((r) => r.id);
}

export async function runDriveFinalSweep(job: JobRow): Promise<void> {
  if (!driveMirrorEnabled()) throw new NotConfiguredError(driveNotConfiguredReason());
  const plans = await planDriveFinals(await sweepListingIds(job));
  const specs = plans.flatMap((p) =>
    p.due.map((m) => ({
      kind: DRIVE_FINAL_KIND,
      idempotencyKey: jobKey(DRIVE_FINAL_KIND, `${m.id}:${versionTag(m)}`, 1),
      payload: { version: 1, mediaId: m.id, r2Key: m.r2Key },
      listingId: p.listingId,
    }))
  );
  for (let i = 0; i < specs.length; i += 200) await enqueueJobs(specs.slice(i, i + 200));
}

export async function runDriveFinal(job: JobRow): Promise<void> {
  const p = job.payload ?? {};
  if (!p.mediaId) throw new FatalJobError("drive.final needs payload.mediaId");
  if (!driveMirrorEnabled()) throw new NotConfiguredError(driveNotConfiguredReason());
  const d = db();
  const m = await d.query.media.findFirst({ where: eq(schema.media.id, p.mediaId) });
  if (!m) throw new SkipJobError("that file was removed from the listing");
  const [listing, shoots] = await Promise.all([
    d.query.listings.findFirst({ where: eq(schema.listings.id, m.listingId), columns: { id: true, address: true, driveFolderId: true } }),
    d.query.shoots.findMany({ where: eq(schema.shoots.listingId, m.listingId), columns: { id: true, publishedAt: true } }),
  ]);
  if (!listing) throw new FatalJobError("that listing no longer exists");
  if (!clientVisibleMedia([m], shoots).length) throw new SkipJobError("no longer client visible");
  const head = await headObject(m.r2Key);
  if (!head || head.size <= 0) throw new FatalJobError(`${m.filename} is not in storage, so there is nothing to copy`);
  if (m.driveFinalKey === m.r2Key && m.driveFinalBytes === head.size) throw new SkipJobError("already in FINAL DELIVERY");

  const api = driveApi();
  try {
    const folder = await listingFolder(api, listing);
    const target = await api.ensurePath(folder, [FINAL_DELIVERY_FOLDER, finalSubfolder(m)]);
    // A new version of a file already copied: the old copy goes to Drive's
    // trash (restorable there), once, before the new one starts.
    if (!p.driveSession && m.driveFinalId) {
      const old = await api.getFile(m.driveFinalId);
      if (old && old.size !== head.size) await api.trash(m.driveFinalId);
    }
    const dot = m.filename.lastIndexOf(".");
    const second = `${dot > 0 ? m.filename.slice(0, dot) : m.filename} (${m.id.replace(/-/g, "").slice(0, 8)})${dot > 0 ? m.filename.slice(dot) : ""}`;
    const out = await mirrorToDrive({
      api,
      folderId: target,
      names: [m.filename, second],
      size: head.size,
      contentType: contentTypeFor(m.filename, "application/octet-stream"),
      read: (s, e) => getObjectRange(m.r2Key, s, e),
      now: () => Date.now(),
      deadline: Math.min(drainDeadline(), Date.now() + DRIVE_SLICE_MS),
      cursor: (p.driveSession as DriveCursor) ?? null,
      persist: (c) => saveCursor(job, c),
      lease: leaseFor(job),
    });
    if (!out.done) throw new DeferError(`continuing at ${fmtBytes(out.cursor?.offset ?? 0)} of ${fmtBytes(head.size)}`, 1_000);
    await d.update(schema.media).set({ driveFinalId: out.fileId, driveFinalKey: m.r2Key, driveFinalBytes: head.size, driveFinalAt: new Date() }).where(eq(schema.media.id, m.id));
  } catch (e) {
    if (e instanceof DriveMirrorError) throw e.fatal ? new FatalJobError(e.message) : new Error(e.message);
    if (isDriveRetry(e)) await deferForRate(job, e);
    throw e;
  }
}

// After a delivery email (one sweep per send), or by the operator.
export async function enqueueDriveFinalSweep(opts: { listingId?: string; since?: Date; key?: string }): Promise<number> {
  const id = opts.listingId ?? `all:${opts.since?.toISOString() ?? "default"}`;
  return enqueueJobs([{ kind: DRIVE_FINAL_SWEEP_KIND, idempotencyKey: jobKey(DRIVE_FINAL_SWEEP_KIND, `${id}:${opts.key ?? Date.now()}`, 1), payload: { version: 1, ...(opts.since ? { since: opts.since.toISOString() } : {}) }, listingId: opts.listingId ?? null }]);
}

// The minute cron: one sweep of every recently delivered listing per DRIVE_FINAL_SWEEP_MS.
export async function scheduleDriveFinalSweep(now = Date.now()): Promise<number> {
  if (!driveMirrorEnabled()) return 0;
  return enqueueDriveFinalSweep({ key: `${currentEnv()}:${Math.floor(now / DRIVE_FINAL_SWEEP_MS)}` });
}

// The listing page's line: how many delivered files are in FINAL DELIVERY.
export async function driveFinalsStatus(listingId: string): Promise<{ visible: number; copied: number }> {
  const [p] = await planDriveFinals([listingId]);
  return { visible: p?.visible ?? 0, copied: (p?.visible ?? 0) - (p?.due.length ?? 0) };
}
