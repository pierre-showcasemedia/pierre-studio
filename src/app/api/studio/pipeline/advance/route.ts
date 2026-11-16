// Operator lever for ONE shoot (previews have no cron): push it forward now,
// optionally after queueing the automatic QC pass again. Works the single
// shoot only, never the whole belt, so an in-flight shoot elsewhere is never
// touched. Guarded by MIGRATE_TOKEN like the migrate and health routes.
//   POST /api/studio/pipeline/advance  { shootId, qc?: true, budgetMs?: 50000 }
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { advanceShoot, requeueQcRow } from "@/lib/pipeline";
import { hasMigrateToken } from "@/lib/operator-token";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  if (!hasDb()) return Response.json({ ok: false, error: "no database" }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const shootId = typeof b.shootId === "string" ? b.shootId : "";
  if (!shootId) return Response.json({ ok: false, error: "shootId required" }, { status: 400 });
  const budget = Math.min(280_000, Math.max(5_000, Number(b.budgetMs) || 50_000));
  const started = Date.now();
  let requeued: unknown = null;
  if (b.qc) requeued = await requeueQcRow(shootId, "operator");
  const result = await advanceShoot(shootId, budget);
  const shoot = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { status: true, photoCount: true, qcSummary: true, qcCheckedAt: true, error: true, progress: true } });
  return Response.json({ ok: true, ms: Date.now() - started, requeued, result, shoot });
}
