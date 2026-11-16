// Presigned PUT URLs for files an admin adds straight to a listing (no editing
// shoot). JPGs land under listings/<slug>/photos/, films under video/, both
// under s/<section>/ when a section is named. Admin or QA team session, or
// x-migrate-token for scripts/push-to-listing.mjs (logged as "claude-token").
// A video editor (Oct 26 2026) may add films only, on a listing with a card
// on the Video board, never into a section. Nov 5 2026: every cut an
// editor uploads lands, so a second version (a vertical, a revision exported
// under the same name) always shows up on the listing, internal only, for an
// admin to make client visible. A name the listing already has is saved as
// "-v2", "-v3" and so on (renamed: true) instead of being refused, so the
// film a client may be watching is never written over.
// POST { files: [{ filename, size, contentType? }], section? }
//   → { files: [{ filename, safeFilename, key, url, contentType, renamed? }], rejected: [] }
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireListingUploaderApi } from "@/lib/admin";
import { listingHasVideoCard } from "@/lib/video-board";
import { hasR2, presignedPutUrl, safeFilename } from "@/lib/r2";
import { isPhotoName, isVideoName, listingUploadKey, uploadContentType } from "@/lib/listing-uploads";
import { versionedFilename } from "@/lib/versioned-filename";

export const dynamic = "force-dynamic";
const MAX_BATCH = 60;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await requireListingUploaderApi(request);
  if (who instanceof Response) return who;
  if (!hasDb()) return Response.json({ ok: false, demo: true, error: "Demo mode: no database, uploads are simulated." }, { status: 503 });
  if (!hasR2()) return Response.json({ ok: false, error: "Storage is not connected (R2 env vars missing)." }, { status: 503 });
  const { id } = await params;
  const listing = await db().query.listings.findFirst({ where: eq(schema.listings.id, id), columns: { id: true, slug: true } });
  if (!listing) return Response.json({ ok: false, error: "Listing not found." }, { status: 404 });
  if (who.video && !(await listingHasVideoCard(listing.id))) return Response.json({ ok: false, error: "This listing has no Video card." }, { status: 403 });
  const b = await request.json().catch(() => ({}));
  const section = !who.video && typeof b.section === "string" && b.section.trim() ? b.section.trim() : null;
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, MAX_BATCH) as { filename: string; size?: number; contentType?: string }[];
  if (!files.length) return Response.json({ ok: false, error: "files are required." }, { status: 400 });
  const seen = new Set<string>();
  // A video editor never writes over a film already on the listing (the
  // client may be watching it): a cut with a taken name gets the next free
  // "-vN" name and lands beside it. Admins replace same-name files in place
  // (a corrected JPG onto its frame), so their names are left alone.
  const taken = who.video ? new Set((await db().query.media.findMany({ where: eq(schema.media.listingId, listing.id), columns: { r2Key: true } })).map((m) => m.r2Key)) : new Set<string>();
  const out: { filename: string; safeFilename: string; key: string; url: string; contentType: string; renamed?: boolean }[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    const asked = safeFilename(String(f.filename || ""));
    if ((!isPhotoName(asked) || who.video) && !isVideoName(asked)) { rejected.push(String(f.filename)); continue; }
    const safe = who.video ? versionedFilename(asked, (n) => seen.has(n) || taken.has(listingUploadKey(listing.slug, section, n))) : asked;
    if (seen.has(safe)) continue;
    seen.add(safe);
    const key = listingUploadKey(listing.slug, section, safe);
    const contentType = uploadContentType(safe);
    out.push({ filename: f.filename, safeFilename: safe, key, url: await presignedPutUrl(key, contentType, 2 * 3600), contentType, ...(safe !== asked ? { renamed: true } : {}) });
  }
  return Response.json({ ok: true, files: out, rejected });
}
