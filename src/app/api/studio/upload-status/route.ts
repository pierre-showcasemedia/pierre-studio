// Which of a draft shoot's files have actually landed in R2 (HEAD each key).
// Used to resume an interrupted upload and to verify before submit.
// POST { shootId } → { landed: [filename], missing: [filename], fileCount }
//
// Oct 30 2026: a shoot that is gone (Start over, src/lib/discard-upload.ts)
// or already submitted answers ok: false, so the page forgets it.
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireUploaderApi } from "@/lib/admin";
import { hasR2 } from "@/lib/r2";
import { landedFiles } from "@/lib/shoot-files";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const admin = await requireUploaderApi();
  if (admin instanceof Response) return admin;
  if (!hasDb() || !hasR2()) return Response.json({ ok: false, demo: true, landed: [], missing: [], fileCount: 0 }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const shootId = String(b.shootId || "");
  if (!shootId) return Response.json({ ok: false, error: "shootId required" }, { status: 400 });
  const shoot = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { status: true } });
  if (shoot?.status !== "draft") return Response.json({ ok: false, gone: true, landed: [], missing: [], fileCount: 0 });
  const r = await landedFiles(shootId);
  return Response.json({ ok: true, ...r });
}
