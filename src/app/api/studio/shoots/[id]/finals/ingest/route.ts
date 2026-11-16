// "Upload finals", step 2: the browser has PUT corrected JPGs to
// shoots/<id>/finals/<name>; this matches them to frames and swaps them in
// (see src/lib/finals.ts). Batches of a few files per call so big sets fit the
// function budget; the client loops.
// POST { files: ["safe name", ...], run? } → { replaced, added, failed }
// run: the upload run (src/lib/upload-runs.ts); its one hub line comes at the end.
// Admins and the QA team.
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireStaffApi } from "@/lib/admin";
import { hasR2 } from "@/lib/r2";
import { isActive } from "@/lib/shoot-status";
import { ingestFinals } from "@/lib/finals";
import { cleanRun, noteRunBatch } from "@/lib/upload-runs";
import { enqueueBundleRebuild } from "@/lib/bundle-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const MAX_BATCH = 8;
const UPLOAD_SETTLE_MS = 90_000;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi();
  if (staff instanceof Response) return staff;
  if (!hasDb() || !hasR2()) return Response.json({ ok: false, demo: true, error: "Demo mode: no storage." }, { status: 503 });
  const { id } = await params;
  const shoot = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, id), columns: { id: true, status: true, listingId: true } });
  if (!shoot) return Response.json({ ok: false, error: "Shoot not found." }, { status: 404 });
  if (shoot.status === "draft" || isActive(shoot.status)) {
    return Response.json({ ok: false, error: "Finals can be uploaded once the frames are in." }, { status: 409 });
  }
  const b = await request.json().catch(() => ({}));
  const files = (Array.isArray(b.files) ? b.files : []).map(String).filter(Boolean).slice(0, MAX_BATCH);
  if (!files.length) return Response.json({ ok: false, error: "files are required." }, { status: 400 });
  try {
    const run = cleanRun(b.run);
    if (run) await noteRunBatch(run, shoot.listingId);
    const r = await ingestFinals(id, staff.email, files, run);
    // A replaced frame waits for Publish again (internal until then), so it leaves the zips.
    // Once, after the upload goes quiet (src/lib/bundle-jobs.ts), not once per batch.
    if (r.replaced.length) await enqueueBundleRebuild(shoot.listingId, { settleMs: UPLOAD_SETTLE_MS });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error("[finals/ingest]", e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
