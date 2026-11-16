// "Download for editing": the full-resolution originals of a shoot's frames,
// streamed from R2 as one zip (store only: JPEGs do not compress). Admin or
// QA team session required; nothing here is client-facing, so internal frames
// are only ever reachable through this route and its listing twin.
//
//   GET /api/studio/shoots/<id>/download?scope=all|flagged|internal|selected&ids=a,b,c
//   GET /api/studio/shoots/<id>/download?file=<mediaId>          one frame, 302 to a signed URL
//   GET /api/studio/shoots/<id>/download?replaced=<activityId>   the original a corrected final replaced
//   ...&view=1  shows it inline instead (the "Before" of a revised photo, Oct 30 2026)
//
// "flagged" = frames the automatic QC pass raised an issue on, plus rejected
// frames. "internal" = every frame the client cannot see (src/lib/visibility.ts:
// fresh from editing, held back, rejected, waiting to publish). Filenames are
// preserved so corrected files can be re-uploaded and matched back to their
// frame by name.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireStaffApi } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { hasR2, headObject, signedDownloadUrl, signedViewUrl } from "@/lib/r2";
import { qcFlagged } from "@/lib/pipeline";
import { isClientVisibleRow } from "@/lib/visibility";
import { zipEntries, zipResponse, zipStreet } from "@/lib/zip-download";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi();
  if (staff instanceof Response) return staff;
  const actor = staff.email;
  if (!hasDb() || !hasR2()) return Response.json({ ok: false, error: "Demo mode: downloads need storage." }, { status: 503 });
  const { id } = await params;
  const url = new URL(request.url);
  const d = db();
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, id), with: { listing: { columns: { address: true, nda: true } } } });
  if (!shoot) return Response.json({ ok: false, error: "Shoot not found." }, { status: 404 });

  // One frame: hand back a short signed URL with the right filename.
  const one = url.searchParams.get("file");
  if (one) {
    const m = await d.query.media.findFirst({ where: and(eq(schema.media.id, one), eq(schema.media.shootId, id)) });
    if (!m) return Response.json({ ok: false, error: "Frame not found." }, { status: 404 });
    await logActivity({ actorEmail: actor, action: "media.downloaded", shootId: id, listingId: shoot.listingId, meta: { count: 1, filename: m.filename } });
    return Response.redirect(await signedDownloadUrl(m.r2Key, m.filename, 600), 302);
  }

  // The previous file behind a corrected final (finals.ts keeps it under
  // shoots/<id>/replaced/<stamp>/ and logs the swap as media.replaced).
  const replaced = url.searchParams.get("replaced");
  if (replaced) {
    if (!/^[0-9a-f-]{36}$/i.test(replaced)) return Response.json({ ok: false, error: "Not found." }, { status: 404 });
    const row = await d.query.activity.findFirst({ where: and(eq(schema.activity.id, replaced), eq(schema.activity.action, "media.replaced"), eq(schema.activity.shootId, id)) });
    const key = typeof row?.meta?.previous === "string" ? row.meta.previous : "";
    const filename = typeof row?.meta?.filename === "string" ? row.meta.filename : "original.jpg";
    if (!row || !key.startsWith(`shoots/${id}/replaced/`) || !(await headObject(key))) return Response.json({ ok: false, error: "That original is not in storage." }, { status: 404 });
    if (url.searchParams.get("view") === "1") return Response.redirect(await signedViewUrl(key), 302);
    await logActivity({ actorEmail: actor, action: "media.downloaded", shootId: id, listingId: shoot.listingId, meta: { count: 1, filename, replaced: true } });
    return Response.redirect(await signedDownloadUrl(key, filename, 600), 302);
  }

  const scope = url.searchParams.get("scope") || "all";
  const ids = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
  let frames = await d.query.media.findMany({
    where: scope === "selected" && ids.length ? and(eq(schema.media.shootId, id), inArray(schema.media.id, ids)) : eq(schema.media.shootId, id),
    orderBy: [asc(schema.media.section), asc(schema.media.sort)],
  });
  if (scope === "flagged") frames = frames.filter((f) => f.qcState === "rejected" || qcFlagged(f.qcIssues));
  if (scope === "internal") frames = frames.filter((f) => !isClientVisibleRow(f, Boolean(shoot.publishedAt)));
  if (scope === "selected" && !ids.length) frames = [];
  if (!frames.length) return Response.json({ ok: false, error: "No frames match." }, { status: 404 });

  const entries = zipEntries(frames);
  const label = scope === "flagged" ? "flagged frames" : scope === "internal" ? "internal frames" : scope === "selected" ? `${entries.length} selected frames` : "all frames";
  const zipName = `${zipStreet(shoot.listing.address, shoot.listing.nda)} - ${label} for editing.zip`;
  await logActivity({ actorEmail: actor, action: "media.downloaded", shootId: id, listingId: shoot.listingId, meta: { count: entries.length, scope } });
  return zipResponse(entries, zipName);
}
