// Downloads for editing from the listing page (Oct 2026): every photo on the
// listing, loose uploads and shoot frames alike, as one store-only zip.
// Admin or QA team session; never a client route, so this is how internal
// frames leave storage (with the shoot route).
//
//   GET /api/studio/listings/<id>/download?scope=internal|all|selected&ids=a,b,c
//   GET /api/studio/listings/<id>/download?file=<mediaId>   one file, 302 to a signed URL
//
// "internal" = every photo the client cannot see (src/lib/visibility.ts).
// Zips carry photos only; films download one at a time (file=).
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireStaffApi } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { hasR2, signedDownloadUrl } from "@/lib/r2";
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
  const listing = await d.query.listings.findFirst({ where: eq(schema.listings.id, id), columns: { id: true, address: true, nda: true }, with: { shoots: { columns: { id: true, publishedAt: true } } } });
  if (!listing) return Response.json({ ok: false, error: "Listing not found." }, { status: 404 });

  const one = url.searchParams.get("file");
  if (one) {
    const m = await d.query.media.findFirst({ where: and(eq(schema.media.id, one), eq(schema.media.listingId, id)) });
    if (!m) return Response.json({ ok: false, error: "File not found." }, { status: 404 });
    await logActivity({ actorEmail: actor, action: "media.downloaded", listingId: id, shootId: m.shootId, meta: { count: 1, filename: m.filename } });
    return Response.redirect(await signedDownloadUrl(m.r2Key, m.filename, 600), 302);
  }

  const scope = url.searchParams.get("scope") || "internal";
  const ids = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 2000);
  if (scope === "selected" && !ids.length) return Response.json({ ok: false, error: "No files selected." }, { status: 400 });
  const live = new Set(listing.shoots.filter((s) => s.publishedAt).map((s) => s.id));
  let rows = await d.query.media.findMany({
    where: scope === "selected" ? and(eq(schema.media.listingId, id), inArray(schema.media.id, ids)) : eq(schema.media.listingId, id),
    orderBy: [asc(schema.media.revision), asc(schema.media.section), asc(schema.media.sort), asc(schema.media.createdAt)],
  });
  rows = rows.filter((m) => m.kind === "photo");
  if (scope === "internal") rows = rows.filter((m) => !isClientVisibleRow(m, Boolean(m.shootId && live.has(m.shootId))));
  if (!rows.length) return Response.json({ ok: false, error: "No photos match." }, { status: 404 });

  const entries = zipEntries(rows);
  const label = scope === "internal" ? "internal photos" : scope === "selected" ? `${entries.length} selected photos` : "all photos";
  await logActivity({ actorEmail: actor, action: "media.downloaded", listingId: id, meta: { count: entries.length, scope } });
  return zipResponse(entries, `${zipStreet(listing.address, listing.nda)} - ${label} for editing.zip`, "listings/download");
}
