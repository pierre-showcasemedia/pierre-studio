// Step 2 of a direct listing upload: the browser has PUT the files; this makes
// derivatives and media rows (see src/lib/listing-uploads.ts), a few files per
// call so big sets fit the function budget, then queues a zip rebuild. Admin
// or QA team session, or x-migrate-token for scripts/push-to-listing.mjs
// ("claude-token"). A video editor (Oct 26 2026): films only, on a listing
// with a Video card, always internal only.
// POST { files: ["safe name", ...], section?, published?, run? } → { added, replaced, failed }
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireListingUploaderApi } from "@/lib/admin";
import { isVideoName, ingestListingUploads } from "@/lib/listing-uploads";
import { cleanRun, noteRunBatch } from "@/lib/upload-runs";
import { listingHasVideoCard } from "@/lib/video-board";
import { enqueueBundleRebuild } from "@/lib/bundle-jobs";
import { hasR2 } from "@/lib/r2";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const MAX_BATCH = 8;
const UPLOAD_SETTLE_MS = 90_000;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await requireListingUploaderApi(request);
  if (who instanceof Response) return who;
  const admin = who.actor;
  if (!hasDb() || !hasR2()) return Response.json({ ok: false, demo: true, error: "Demo mode: no storage." }, { status: 503 });
  const { id } = await params;
  const listing = await db().query.listings.findFirst({ where: eq(schema.listings.id, id), columns: { id: true } });
  if (!listing) return Response.json({ ok: false, error: "Listing not found." }, { status: 404 });
  if (who.video && !(await listingHasVideoCard(listing.id))) return Response.json({ ok: false, error: "This listing has no Video card." }, { status: 403 });
  const b = await request.json().catch(() => ({}));
  const files = (Array.isArray(b.files) ? b.files : []).map(String).filter(Boolean).filter((f: string) => !who.video || isVideoName(f)).slice(0, MAX_BATCH);
  if (!files.length) return Response.json({ ok: false, error: "files are required." }, { status: 400 });
  try {
    // run: the upload run (src/lib/upload-runs.ts); its one hub line comes at the end.
    const run = cleanRun(b.run);
    if (run) await noteRunBatch(run, id);
    const r = await ingestListingUploads(id, admin, files, { section: !who.video && typeof b.section === "string" ? b.section : null, published: !who.video && b.published === true, run });
    if (r.added.length || r.replaced.length) {
      // Once, after the upload goes quiet (src/lib/bundle-jobs.ts), not once per batch.
      await enqueueBundleRebuild(id, { settleMs: UPLOAD_SETTLE_MS });
    }
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error("[listings/ingest]", e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
