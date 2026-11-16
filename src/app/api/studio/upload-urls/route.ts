// Presigned PUT URLs for a direct browser → R2 upload of one batch of files.
// Creates the draft shoot on the first call. Admin or creative specialist session.
// POST { shootId?, listingId, files: [{ filename, size, contentType?, dir? }], kind?: "raw" | "display" | "raw_video" }
//   → { shootId, files: [{ filename, key, url, contentType }], refused: [{ filename, error }] }
//
// Oct 21 2026: kind raw_video is camera footage for the Dropbox mirror only
// (key shoots/<id>/raw-video/<name>, never sent to editing). One PUT to R2
// tops out at 5 GB, so a bigger clip is refused here with a clear message
// instead of failing at the end of a long upload.
//
// Oct 27 2026: dir is the folder a file was dropped in ("2311 Elm Street -
// 413 raw"); stored as shoot_files.dropbox_dir so the Dropbox copy keeps it.
import { and, eq, inArray } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { ShootFileKind } from "@/db/schema";
import { requireUploaderApi } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { hasR2, presignedPutUrl, safeFilename } from "@/lib/r2";
import { contentTypeFor, isVideoFile, MAX_VIDEO_BYTES } from "@/lib/autohdr-constants";
import { cleanDropboxDir } from "@/lib/dropbox";

export const dynamic = "force-dynamic";
const MAX_BATCH = 60;

const fmtGb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

export async function POST(request: Request) {
  const admin = await requireUploaderApi();
  if (admin instanceof Response) return admin;
  if (!hasDb()) return Response.json({ ok: false, demo: true, error: "Demo mode: no database, uploads are simulated." }, { status: 503 });
  if (!hasR2()) return Response.json({ ok: false, error: "Storage is not connected (R2 env vars missing)." }, { status: 503 });

  const b = await request.json().catch(() => ({}));
  const listingId = String(b.listingId || "");
  const kind: ShootFileKind = b.kind === "display" ? "display" : b.kind === "raw_video" ? "raw_video" : "raw";
  const video = kind === "raw_video";
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, MAX_BATCH) as { filename: string; size?: number; contentType?: string; dir?: string }[];
  if (!listingId || !files.length) return Response.json({ ok: false, error: "listingId and files are required." }, { status: 400 });

  const d = db();
  let shootId = typeof b.shootId === "string" && b.shootId ? b.shootId : null;
  if (shootId) {
    const s = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { id: true, status: true, listingId: true } });
    if (!s || s.listingId !== listingId) return Response.json({ ok: false, error: "Shoot not found." }, { status: 404 });
    if (s.status !== "draft") return Response.json({ ok: false, error: "This shoot was already submitted." }, { status: 409 });
  } else {
    const l = await d.query.listings.findFirst({ where: eq(schema.listings.id, listingId), columns: { id: true } });
    if (!l) return Response.json({ ok: false, error: "Listing not found." }, { status: 404 });
    const [s] = await d.insert(schema.shoots).values({ listingId, createdBy: admin, status: "draft" }).returning({ id: schema.shoots.id });
    shootId = s.id;
    await logActivity({ actorEmail: admin, action: "shoot.created", shootId, listingId });
  }

  // Dedupe by safe filename, within the batch and against rows already there.
  // Video is checked by extension and size, never by MIME.
  const seen = new Set<string>();
  const refused: { filename: string; error: string }[] = [];
  const wanted = files
    .map((f) => ({ ...f, safe: safeFilename(String(f.filename || "")) }))
    .filter((f) => f.safe && !seen.has(f.safe) && seen.add(f.safe))
    .filter((f) => {
      if (!video) return true;
      if (!isVideoFile(f.safe)) {
        refused.push({ filename: f.filename, error: "Not a video format we take." });
        return false;
      }
      if (typeof f.size === "number" && f.size > MAX_VIDEO_BYTES) {
        refused.push({ filename: f.filename, error: `Over ${fmtGb(MAX_VIDEO_BYTES)} (${fmtGb(f.size)}). Split the clip, or add it to the listing's Dropbox folder by hand.` });
        return false;
      }
      return true;
    });
  const existing = wanted.length
    ? await d.query.shootFiles.findMany({ where: and(eq(schema.shootFiles.shootId, shootId), inArray(schema.shootFiles.filename, wanted.map((f) => f.safe))), columns: { filename: true } })
    : [];
  const have = new Set(existing.map((e) => e.filename));

  const out = await Promise.all(
    wanted.map(async (f) => {
      const key = `shoots/${shootId}/${video ? "raw-video" : "raw"}/${f.safe}`;
      const contentType = contentTypeFor(f.safe, typeof f.contentType === "string" && f.contentType ? f.contentType : "application/octet-stream");
      if (!have.has(f.safe)) {
        await d.insert(schema.shootFiles).values({ shootId: shootId!, filename: f.safe, r2Key: key, bytes: typeof f.size === "number" ? f.size : null, contentType, kind, dropboxDir: cleanDropboxDir(f.dir) });
      }
      return { filename: f.filename, key, url: await presignedPutUrl(key, contentType), contentType, safeFilename: f.safe };
    })
  );
  const count = await d.query.shootFiles.findMany({ where: eq(schema.shootFiles.shootId, shootId), columns: { id: true } });
  await d.update(schema.shoots).set({ fileCount: count.length, updatedAt: new Date() }).where(eq(schema.shoots.id, shootId));
  return Response.json({ ok: true, shootId, files: out, refused });
}
