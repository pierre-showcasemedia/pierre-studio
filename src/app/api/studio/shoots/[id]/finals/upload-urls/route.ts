// "Upload finals": presigned PUT URLs for corrected JPGs an admin fixed
// locally. Files land in shoots/<id>/finals/<safe filename>; the ingest route
// then matches them to frames by filename. Nothing here ever goes to editing.
// Admins and the QA team.
// POST { files: [{ filename, size, contentType? }] }
//   → { files: [{ filename, safeFilename, key, url, contentType }] }
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireStaffApi } from "@/lib/admin";
import { hasR2, presignedPutUrl, safeFilename } from "@/lib/r2";
import { isActive } from "@/lib/shoot-status";
import { finalsKey } from "@/lib/finals";

export const dynamic = "force-dynamic";
const MAX_BATCH = 60;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi();
  if (staff instanceof Response) return staff;
  if (!hasDb()) return Response.json({ ok: false, demo: true, error: "Demo mode: no database, uploads are simulated." }, { status: 503 });
  if (!hasR2()) return Response.json({ ok: false, error: "Storage is not connected (R2 env vars missing)." }, { status: 503 });
  const { id } = await params;
  const shoot = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, id), columns: { id: true, status: true } });
  if (!shoot) return Response.json({ ok: false, error: "Shoot not found." }, { status: 404 });
  if (shoot.status === "draft" || isActive(shoot.status)) {
    return Response.json({ ok: false, error: "Finals can be uploaded once the frames are in." }, { status: 409 });
  }
  const b = await request.json().catch(() => ({}));
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, MAX_BATCH) as { filename: string; size?: number; contentType?: string }[];
  if (!files.length) return Response.json({ ok: false, error: "files are required." }, { status: 400 });

  const seen = new Set<string>();
  const out: { filename: string; safeFilename: string; key: string; url: string; contentType: string }[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    const safe = safeFilename(String(f.filename || ""));
    if (!/\.jpe?g$/i.test(safe)) { rejected.push(String(f.filename)); continue; }
    if (seen.has(safe)) continue;
    seen.add(safe);
    const key = finalsKey(id, safe);
    out.push({ filename: f.filename, safeFilename: safe, key, url: await presignedPutUrl(key, "image/jpeg"), contentType: "image/jpeg" });
  }
  return Response.json({ ok: true, files: out, rejected });
}
