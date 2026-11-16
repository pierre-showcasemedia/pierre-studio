// Live status for the shoot page's polling. Admin or QA team session.
//
// v1.2: the poll also keeps the pipeline moving. When the shoot is active,
// nobody holds its lease and nothing has happened for a while, the poll
// schedules one advanceShoot() in after() before answering. On production the
// cron does this anyway; on previews (no cron) an admin with the page open is
// enough to carry a shoot through. The lease keeps the two from colliding.
import { after } from "next/server";
import { requireStaffApi } from "@/lib/admin";
import { adminShootDetail } from "@/lib/admin-data";
import { advanceShoot } from "@/lib/pipeline";
import { isActive } from "@/lib/shoot-status";
import { db, hasDb, schema } from "@/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const KICK_AFTER_MS = 40_000;
const KICK_BUDGET_MS = 45_000;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi();
  if (staff instanceof Response) return staff;
  const { id } = await params;
  const data = await adminShootDetail(id);
  if (!data) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  const { shoot, frames } = data;

  let kicked = false;
  if (hasDb() && isActive(shoot.status)) {
    const row = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, id), columns: { leaseUntil: true, updatedAt: true } });
    const idle = row && (!row.leaseUntil || row.leaseUntil.getTime() < Date.now()) && Date.now() - row.updatedAt.getTime() > KICK_AFTER_MS;
    if (idle) {
      kicked = true;
      after(() => advanceShoot(id, KICK_BUDGET_MS).catch((e) => console.error("[status] kick failed", id, e)));
    }
  }

  const qc = (shoot.progress?.qc as { total?: number; done?: number } | undefined) ?? null;
  return Response.json({
    ok: true,
    status: shoot.status,
    fileCount: shoot.fileCount,
    photoCount: shoot.photoCount,
    frameCount: frames.length,
    qcDone: qc?.done ?? null,
    qcTotal: qc?.total ?? null,
    qcChecked: frames.filter((f) => f.qcCheckedAt).length,
    error: shoot.error,
    updatedAt: shoot.updatedAt,
    progress: shoot.progress,
    kicked,
  });
}
