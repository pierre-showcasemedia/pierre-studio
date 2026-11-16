// Operator probe for the automatic QC pass: runs the Claude call on ONE frame
// and returns the parsed result WITHOUT saving anything, so the key, model
// and prompt can be proven on a deployment before a shoot depends on them.
// Guarded by MIGRATE_TOKEN like the health and migrate routes.
//
//   POST /api/studio/qc/probe   { mediaId }  |  { shootId }  |  { key }  |  { sample: true }
//     sample = the newest approved frame that belongs to a published shoot
//     (or to no shoot at all), so an in-flight shoot is never touched.
import { and, asc, desc, eq, isNull, or, inArray } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { getObjectBuffer, hasR2 } from "@/lib/r2";
import { derivativeKey } from "@/lib/media-keys";
import { makePreview } from "@/lib/derivatives";
import { withOriginalSlot } from "@/lib/image-gate";
import { classifyQcError, hasQc, qcImage, qcModel } from "@/lib/qc";
import { hasMigrateToken } from "@/lib/operator-token";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  if (!hasQc()) return Response.json({ ok: false, qc: false, error: "QC pass skipped: key not set" }, { status: 503 });
  if (!hasR2()) return Response.json({ ok: false, error: "storage not configured" }, { status: 503 });
  const b = await request.json().catch(() => ({}));

  let key: string | null = typeof b.key === "string" && b.key ? b.key : null;
  let filename: string | undefined;
  let section: string | null = null;
  if (!key && hasDb()) {
    const d = db();
    let m: { r2Key: string; filename: string; section: string | null } | undefined;
    if (typeof b.mediaId === "string" && b.mediaId) {
      m = await d.query.media.findFirst({ where: eq(schema.media.id, b.mediaId), columns: { r2Key: true, filename: true, section: true } });
    } else if (typeof b.shootId === "string" && b.shootId) {
      m = await d.query.media.findFirst({ where: eq(schema.media.shootId, b.shootId), orderBy: [asc(schema.media.sort)], columns: { r2Key: true, filename: true, section: true } });
    } else if (b.sample) {
      const published = await d.query.shoots.findMany({ where: eq(schema.shoots.status, "published"), columns: { id: true } });
      const ids = published.map((s) => s.id);
      m = await d.query.media.findFirst({
        where: and(eq(schema.media.kind, "photo"), eq(schema.media.qcState, "approved"), ids.length ? or(isNull(schema.media.shootId), inArray(schema.media.shootId, ids)) : isNull(schema.media.shootId)),
        orderBy: [desc(schema.media.createdAt)],
        columns: { r2Key: true, filename: true, section: true },
      });
    }
    if (!m) return Response.json({ ok: false, error: "no frame found" }, { status: 404 });
    key = m.r2Key;
    filename = m.filename;
    section = m.section;
  }
  if (!key) return Response.json({ ok: false, error: "mediaId, key or sample required" }, { status: 400 });

  const started = Date.now();
  try {
    let preview: Buffer;
    try {
      preview = (await getObjectBuffer(derivativeKey(key, "preview"))).body;
    } catch {
      const original = key;
      preview = await withOriginalSlot(async () => makePreview((await getObjectBuffer(original)).body));
    }
    const r = await qcImage(preview, { filename, section });
    return Response.json({ ok: true, model: qcModel(), ms: Date.now() - started, key, bytes: preview.length, result: r });
  } catch (e) {
    const c = classifyQcError(e);
    return Response.json({ ok: false, model: qcModel(), ms: Date.now() - started, key, kind: c.kind, error: c.message }, { status: 502 });
  }
}
