// Submit a draft shoot: save the editing options, confirm every file landed,
// flip status to "uploaded" and START EDITING AT ONCE. The response returns
// as soon as the row is saved; the first pipeline steps (create the editing
// shoot, transfer files, commit) run in after() on this same invocation, so
// nobody waits for a scheduler. The cron stays as the safety net.
//
// Oct 21 2026: a shoot's files are photos (raw or display) and raw video
// (kind raw_video). Every file is queued for the Dropbox mirror; only the
// photos go to editing. A shoot with clips and no photos is "video only":
// nothing to edit, status video_only, and the clips are the whole job.
// Oct 26 2026: the upload also makes the listing's Photo and Video folders
// in Dropbox right away (dropbox.folder), and raw video stamps the listing's
// card on the Video board (one is made when there is none).
// POST { options } → { ok, parked, videoOnly, mirror } | 409 { missing: [filename] }
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { ShootOptions } from "@/db/schema";
import { requireUploaderApi } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { hasAutoHdr, AURA_MODEL_ID } from "@/lib/autohdr";
import { TWILIGHT_LOOK_ID } from "@/lib/twilight-preset";
import { hubShootUploaded } from "@/lib/slack";
import { countKinds, landedFiles } from "@/lib/shoot-files";
import { dropMissingFiles } from "@/lib/discard-upload";
import { advanceShoot } from "@/lib/pipeline";
import { TWILIGHT_MAX, TWILIGHT_MIN } from "@/lib/autohdr-constants";
import { dropboxMirrorEnabled } from "@/lib/dropbox";
import { enqueueDropboxFolder, enqueueMirrorForShoot, MIRROR_KINDS, queueVideoEditingLine } from "@/lib/dropbox-mirror";
import { DRIVE_KINDS, enqueueDriveMirrorForShoot } from "@/lib/drive-mirror";
import { driveMirrorEnabled } from "@/lib/google-drive";
import { attachFootage } from "@/lib/video-board";
import { drainJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";
// The after() work (create + transfer + commit, then a first Dropbox pass) needs room beyond the response.
export const maxDuration = 120;
const START_BUDGET_MS = 50_000;
const MIRROR_BUDGET_MS = 30_000;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireUploaderApi();
  if (admin instanceof Response) return admin;
  const { id } = await params;
  if (!hasDb()) return Response.json({ ok: true, demo: true, parked: true, shootId: "demo-s1" });
  const d = db();
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, id), with: { listing: true } });
  if (!shoot) return Response.json({ ok: false, error: "Shoot not found." }, { status: 404 });
  if (shoot.status !== "draft") return Response.json({ ok: false, error: "This shoot was already submitted." }, { status: 409 });

  const b = await request.json().catch(() => ({}));
  const o = (b.options ?? {}) as Partial<ShootOptions> & { twilight?: Partial<ShootOptions["twilight"]> };
  const nda = Boolean(o.nda) || shoot.listing.nda;

  let landed = await landedFiles(id);
  if (!landed.fileCount) return Response.json({ ok: false, error: "No files were uploaded." }, { status: 400 });
  // Nov 2 2026 (20 Dogwood): with { dropMissing: true } the uploader goes
  // on without the files that never landed (src/lib/discard-upload.ts
  // dropMissingFiles). Their names stay in the activity row below.
  let dropped: string[] = [];
  if (landed.missing.length && b.dropMissing === true) {
    const gone = await dropMissingFiles(id, landed.missing);
    dropped = gone.map((g) => g.filename);
    const goneKinds = countKinds(gone);
    const goneNames = new Set(dropped);
    landed = {
      landed: landed.landed,
      missing: landed.missing.filter((n) => !goneNames.has(n)),
      fileCount: landed.fileCount - gone.length,
      kinds: { photos: landed.kinds.photos - goneKinds.photos, video: landed.kinds.video - goneKinds.video },
    };
    if (!landed.fileCount) return Response.json({ ok: false, error: "No files were uploaded." }, { status: 400 });
  }
  if (landed.missing.length) return Response.json({ ok: false, error: `${landed.missing.length} file(s) have not finished uploading.`, missing: landed.missing }, { status: 409 });
  const videoOnly = landed.kinds.photos === 0;

  const options: ShootOptions = {
    indoorModelId: nda ? AURA_MODEL_ID : Number(o.indoorModelId) || AURA_MODEL_ID,
    outdoorModelId: nda ? AURA_MODEL_ID : Number(o.outdoorModelId) || AURA_MODEL_ID,
    modelName: nda ? "Aura" : typeof o.modelName === "string" ? o.modelName : undefined,
    modelCredits: typeof o.modelCredits === "number" ? o.modelCredits : undefined,
    skipHdr: Boolean(o.skipHdr),
    twilight: {
      enabled: !videoOnly && Boolean(o.twilight?.enabled),
      count: Math.min(TWILIGHT_MAX, Math.max(TWILIGHT_MIN, Number(o.twilight?.count) || 6)),
      // Every twilight is the Champagne preset (src/lib/twilight-preset.ts).
      look: TWILIGHT_LOOK_ID,
    },
    nda,
    notes: typeof o.notes === "string" ? o.notes.trim().slice(0, 2000) : undefined,
    source: o.source === "dropbox" || o.source === "google_drive" || o.source === "mixed" ? o.source : "device",
    files: landed.kinds,
  };

  // A display upload means the photos are finished JPGs: record the kind on
  // every photo row (raw video keeps its own kind).
  if (options.skipHdr) await d.update(schema.shootFiles).set({ kind: "display" }).where(and(eq(schema.shootFiles.shootId, id), eq(schema.shootFiles.kind, "raw")));
  if (nda && !shoot.listing.nda) await d.update(schema.listings).set({ nda: true }).where(eq(schema.listings.id, shoot.listingId));

  const parked = !videoOnly && !hasAutoHdr();
  await d.update(schema.shoots).set({
    options,
    status: videoOnly ? "video_only" : "uploaded",
    submittedAt: new Date(),
    stepStartedAt: new Date(),
    fileCount: landed.fileCount,
    error: null,
    updatedAt: new Date(),
  }).where(eq(schema.shoots.id, id));

  // The Dropbox mirror: one job per file, when the app is set up for this
  // environment (a shoot uploaded before that gets "Copy to Dropbox again").
  const mirror = dropboxMirrorEnabled();
  let mirrorJobs = 0;
  if (mirror) {
    try {
      // Photo and Video first, so both folders exist the moment media lands.
      await enqueueDropboxFolder({ listingId: shoot.listingId, subfolders: true, shootId: id });
      mirrorJobs = await enqueueMirrorForShoot({ shootId: id, listingId: shoot.listingId });
      // Clips that finished copying during the upload: #video-editing hears now.
      if (landed.kinds.video > 0) await queueVideoEditingLine(id, shoot.listingId);
    } catch (e) {
      console.error("[submit] mirror enqueue failed", id, e);
    }
  }
  // The Google Drive mirror, the same way (src/lib/drive-mirror.ts).
  let driveJobs = 0;
  if (driveMirrorEnabled()) {
    try {
      driveJobs = await enqueueDriveMirrorForShoot({ shootId: id, listingId: shoot.listingId });
    } catch (e) {
      console.error("[submit] drive enqueue failed", id, e);
    }
  }
  // Raw video: the listing's Video card knows the footage is in.
  if (landed.kinds.video > 0) {
    try {
      await attachFootage({ listingId: shoot.listingId, shootId: id });
    } catch (e) {
      console.error("[submit] video card", id, e);
    }
  }

  await logActivity({
    actorEmail: admin,
    action: "shoot.submitted",
    shootId: id,
    listingId: shoot.listingId,
    meta: { fileCount: landed.fileCount, photos: landed.kinds.photos, video: landed.kinds.video, videoOnly, model: options.modelName ?? options.indoorModelId, twilight: options.twilight.enabled ? options.twilight.count : 0, nda, parked, mirror: mirrorJobs, drive: driveJobs, ...(dropped.length ? { dropped } : {}) },
  });
  await hubShootUploaded({ shootId: id, listing: { address: shoot.listing.address, nda }, fileCount: landed.fileCount, videoCount: landed.kinds.video, by: admin, parked, mirror: mirrorJobs > 0 || driveJobs > 0, mirrorTo: mirrorJobs > 0 && driveJobs > 0 ? "Dropbox and Google Drive" : driveJobs > 0 ? "Google Drive" : "Dropbox" });

  // Editing starts now, not on the next cron run; then a first Dropbox pass
  // on the same invocation so the mirror does not wait for the cron either.
  after(async () => {
    if (!parked && !videoOnly) {
      try {
        const r = await advanceShoot(id, START_BUDGET_MS);
        console.log("[submit] immediate start", id, JSON.stringify(r));
      } catch (e) {
        console.error("[submit] immediate start failed", id, e);
      }
    }
    if (mirrorJobs > 0 || driveJobs > 0) {
      try {
        await drainJobs({ kinds: [...MIRROR_KINDS, ...DRIVE_KINDS], budgetMs: MIRROR_BUDGET_MS, limit: 200 });
      } catch (e) {
        console.error("[submit] mirror drain failed", id, e);
      }
    }
  });
  return Response.json({ ok: true, parked, started: !parked && !videoOnly, videoOnly, mirror: mirrorJobs, dropped, shootId: id });
}
