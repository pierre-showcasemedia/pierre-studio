// Operator lever for the job queue (previews have no cron). Guarded by
// MIGRATE_TOKEN like migrate, health and pipeline/advance; only ever touches
// THIS environment's rows.
//   GET  /api/studio/jobs/drain[?bookingId=]        counts + the latest rows
//   POST /api/studio/jobs/drain { bookingId?, budgetMs?, retryDead?, runNow?, kinds? }
//        retryDead puts dead rows back on the queue; runNow pulls waiting rows
//        (not-configured backoff) forward; then the drain runs. kinds narrows
//        the drain to those kinds (for example ["dropbox.mirror"] or
//        ["bundle.rebuild"], which a plain drain leaves to the cron's own
//        passes).
import { and, desc, eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { JOB_KINDS } from "@/db/schema";
import { drainJobs, jobCounts } from "@/lib/jobs";
import { currentEnv } from "@/lib/jobs-core";
import { hasMigrateToken } from "@/lib/operator-token";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function guard(request: Request): Response | null {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  if (!hasDb()) return Response.json({ ok: false, error: "no database" }, { status: 503 });
  return null;
}

async function recent(bookingId: string | null) {
  const env = currentEnv();
  return db().query.jobs.findMany({
    where: bookingId ? and(eq(schema.jobs.env, env), eq(schema.jobs.bookingId, bookingId)) : eq(schema.jobs.env, env),
    orderBy: [desc(schema.jobs.createdAt)],
    limit: 30,
    columns: { id: true, kind: true, status: true, attempts: true, runAt: true, lastError: true, bookingId: true, invoiceId: true, alertedAt: true, doneAt: true, createdAt: true },
  });
}

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const bookingId = new URL(request.url).searchParams.get("bookingId");
  return Response.json({ ok: true, env: currentEnv(), counts: await jobCounts(), jobs: await recent(bookingId) });
}

export async function POST(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const b = await request.json().catch(() => ({}));
  const bookingId = typeof b.bookingId === "string" ? b.bookingId : null;
  const budget = Math.min(280_000, Math.max(5_000, Number(b.budgetMs) || 50_000));
  const scope = (status: "dead" | "queued") => and(eq(schema.jobs.env, currentEnv()), eq(schema.jobs.status, status), ...(bookingId ? [eq(schema.jobs.bookingId, bookingId)] : []));
  let retried = 0;
  let pulled = 0;
  if (b.retryDead) {
    const rows = await db().update(schema.jobs).set({ status: "queued", attempts: 0, runAt: new Date(), leaseUntil: null, updatedAt: new Date() }).where(scope("dead")).returning({ id: schema.jobs.id });
    retried = rows.length;
  }
  if (b.runNow) {
    const rows = await db().update(schema.jobs).set({ runAt: new Date(), updatedAt: new Date() }).where(scope("queued")).returning({ id: schema.jobs.id });
    pulled = rows.length;
  }
  const kinds = Array.isArray(b.kinds) ? (b.kinds as unknown[]).filter((k): k is string => typeof k === "string" && (JOB_KINDS as readonly string[]).includes(k)) : null;
  const started = Date.now();
  const result = await drainJobs({ budgetMs: budget, bookingId, ...(kinds?.length ? { kinds, limit: 200 } : {}) });
  return Response.json({ ok: true, ms: Date.now() - started, retried, pulled, ...result, counts: await jobCounts(), jobs: await recent(bookingId) });
}
