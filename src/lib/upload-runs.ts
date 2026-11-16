// One hub line per upload (Oct 26 2026). the owner: one drag and drop of the
// Ortega Ranch twilights posted six "Files uploaded" lines (the browser saves
// files in batches of six); "only send a msg when an upload is complete or
// failed and make sure it's one message".
//
// The uploader (UploadToListing, the Video card's cut upload, the
// push-to-listing script) names each run with an id and sends it with every
// ingest call (`run`). Those batches are still logged one activity row each,
// but quietly (src/lib/hub-activity.ts skips a row that carries meta.run).
// When the run ends the uploader calls /api/studio/listings/<id>/upload-done,
// and finishUploadRun() adds the batches up from the activity log and posts
// ONE line: finished, finished with problems (which files failed), or failed.
//
// A run whose tab closed never calls upload-done: the first batch also queues
// a slack.upload_check job 15 minutes out, which waits while batches keep
// arriving and otherwise posts "stopped before it finished". A marker row in
// the jobs table (idempotency key <kind>:<run>:posted) makes sure exactly one
// of the two posts.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { JobKind } from "@/db/schema";
import { logActivity } from "./activity";
import { currentEnv, DeferError, enqueueJobs, jobKey, SkipJobError } from "./jobs-core";

export const UPLOAD_CHECK_KIND: JobKind = "slack.upload_check";
// The backstop's first look, and how long a run may sit idle before it counts as stopped.
const CHECK_AFTER_MS = 15 * 60_000;
const IDLE_MS = 10 * 60_000;
const BATCH_ACTIONS = ["media.uploaded", "media.finals_uploaded"] as const;

// A run id from the browser or a script: letters, digits and dashes.
export function cleanRun(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null;
}

const runIs = (run: string) => sql`${schema.activity.meta}->>'run' = ${run}`;

// The first batch of a run queues the backstop (later batches hit the same key).
export async function noteRunBatch(run: string, listingId: string): Promise<void> {
  try {
    await enqueueJobs([{ kind: UPLOAD_CHECK_KIND, idempotencyKey: jobKey(UPLOAD_CHECK_KIND, run, 1), payload: { version: 1, run }, listingId, runAt: new Date(Date.now() + CHECK_AFTER_MS) }]);
  } catch (e) {
    console.error("[upload-runs] backstop", e);
  }
}

// Claims the run's one summary line: true for exactly one caller.
async function claimSummary(run: string, listingId: string): Promise<boolean> {
  const now = new Date();
  const rows = await db()
    .insert(schema.jobs)
    .values({ kind: UPLOAD_CHECK_KIND, idempotencyKey: jobKey(UPLOAD_CHECK_KIND, `${run}:posted`, 1), payload: { version: 1, run }, listingId, status: "done", doneAt: now, runAt: now, env: currentEnv() })
    .onConflictDoNothing({ target: schema.jobs.idempotencyKey })
    .returning({ id: schema.jobs.id });
  return rows.length > 0;
}

export type RunFailure = { name: string; error: string };

export type RunTotals = { added: number; replaced: number; corrected: number; landed: number };

// The run's batches added up (pure, for the check script).
export function sumBatches(rows: { action: string; meta: Record<string, unknown> | null }[]): RunTotals {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  let added = 0;
  let replaced = 0;
  let corrected = 0;
  for (const r of rows) {
    const m = r.meta ?? {};
    if (r.action === "media.uploaded") {
      added += n(m.added);
      replaced += n(m.replaced);
    } else if (r.action === "media.finals_uploaded") {
      corrected += n(m.added) + n(m.replaced);
    }
  }
  return { added, replaced, corrected, landed: added + replaced + corrected };
}

export async function finishUploadRun(p: {
  run: string;
  listingId: string;
  actor: string | null;
  total?: number | null; // files the uploader tried
  failed?: RunFailure[]; // files that did not go in, as the uploader saw them
  published?: boolean | null; // landed client visible (true) or internal only (false)
  section?: string | null;
  stopped?: boolean; // the backstop: the uploader never said it was done
  review?: boolean; // sent for final review: that line (src/lib/final-review.ts) says it all, so this one stays quiet
}): Promise<{ posted: boolean; totals: RunTotals }> {
  const rows = await db().query.activity.findMany({
    where: and(eq(schema.activity.listingId, p.listingId), inArray(schema.activity.action, [...BATCH_ACTIONS]), runIs(p.run)),
    columns: { action: true, meta: true },
  });
  const totals = sumBatches(rows);
  const failed = (p.failed ?? []).slice(0, 500);
  if (!totals.landed && !failed.length && !p.stopped) return { posted: false, totals }; // nothing happened
  if (!(await claimSummary(p.run, p.listingId))) return { posted: false, totals };
  const total = Math.max(p.total ?? 0, totals.landed + failed.length);
  await logActivity({
    actorEmail: p.actor,
    action: "media.upload_finished",
    listingId: p.listingId,
    meta: {
      run: p.run,
      ...totals,
      total,
      failed: failed.length,
      failedNames: failed.slice(0, 5).map((f) => f.name),
      firstError: failed[0]?.error?.slice(0, 160) ?? null,
      published: p.published ?? null,
      section: p.section ?? null,
      stopped: Boolean(p.stopped),
      // Only a run where something went in is quiet; a failed one still posts its line.
      ...(p.review && totals.landed ? { review: true } : {}),
    },
  });
  return { posted: true, totals };
}

// The backstop job: posts "stopped" for a run that went quiet without
// calling upload-done; waits while its batches are still arriving.
type JobRow = typeof schema.jobs.$inferSelect;
export async function runUploadCheck(job: JobRow): Promise<void> {
  const run = cleanRun(job.payload?.run);
  if (!run || !job.listingId) throw new SkipJobError("no run");
  const last = await db().query.activity.findFirst({
    where: and(eq(schema.activity.listingId, job.listingId), inArray(schema.activity.action, [...BATCH_ACTIONS, "media.upload_finished"]), runIs(run)),
    orderBy: [desc(schema.activity.createdAt)],
    columns: { action: true, actorEmail: true, createdAt: true },
  });
  if (!last || last.action === "media.upload_finished") throw new SkipJobError("already summarized");
  if (Date.now() - last.createdAt.getTime() < IDLE_MS) throw new DeferError("the upload is still going", IDLE_MS);
  const r = await finishUploadRun({ run, listingId: job.listingId, actor: last.actorEmail, stopped: true });
  if (!r.posted) throw new SkipJobError("already summarized");
}
