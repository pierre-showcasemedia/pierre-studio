// Queue a rebuild of a listing's "download all" zips (the bundle.rebuild job
// builds them from client-visible photos and films). The cron runs it. A plain
// module, not a server action, so it is never reachable from a browser on its
// own.
//
// Oct 27 2026 (reported on 1030 Example Magnolia Drive: "Download all" gave 10 of
// the 17 photos, full resolution and MLS alike): the key used to be one per
// listing per minute. The cron drains within
// seconds, so a rebuild that started on the first upload batch or the first
// "Client visible" click claimed that minute's key, and every later change in
// the same minute (the rest of the photos) was dropped as a repeat. The zips
// stayed short until something else touched the listing. Now a request
// coalesces only with a rebuild that is still queued (it has not read the rows
// yet, so it will see this change); otherwise it queues a fresh one.
// rebuildTurn() keeps two rebuilds of one listing from running at once, so an
// older, shorter zip can never land on top of a newer one.
//
// Nov 10 2026: a rebuild now works across several cron runs (src/lib/bundles.ts)
// and sits in the queue, status "queued", between them. So "queued" alone no
// longer means "has not read the rows yet": a rebuild that has begun carries
// payload.bundle, and a request only coalesces with a queued one that has not.
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { JobKind } from "@/db/schema";
import { currentEnv, enqueueJobs } from "./jobs-core";

// The cron drains these in a pass of their own (src/app/api/cron/pipeline),
// and a plain drain leaves them alone: minutes of zip writing never sit in
// front of a booking email, and the rebuild gets the same stretch of every
// run however long the pipeline tick took.
export const BUNDLE_KINDS: readonly JobKind[] = ["bundle.rebuild"];
// Longer than any one run works on a rebuild (four minutes at most), and
// renewed at every checkpoint, so a second run never starts beside it.
export const BUNDLE_LEASE_MS = 6 * 60_000;

// Has this rebuild begun (read the rows, kept its list on the job)?
const begun = sql<boolean>`(${schema.jobs.payload} -> 'bundle') is not null`;
const notBegun = sql`(${schema.jobs.payload} -> 'bundle') is null`;

// settleMs (Nov 10 2026): for uploads. Every ingest batch of a long upload
// used to queue its own rebuild, so a 31 photo upload to 3330 Example Cedar Road
// rebuilt the listing's multi GB zips again and again while the photos were
// still arriving, beside the image work, on the same server. An upload now
// asks for a rebuild that starts once the listing has been quiet this long:
// each batch pushes the queued one back, and it runs once, after the last
// file. A request without settleMs (a publish, a visibility change, the
// Rebuild zips button) is never held back: it pulls a waiting rebuild to now.
export async function enqueueBundleRebuild(listingId: string, opts: { settleMs?: number } = {}): Promise<void> {
  const now = new Date();
  const runAt = opts.settleMs && opts.settleMs > 0 ? new Date(now.getTime() + opts.settleMs) : now;
  const waiting = await db().query.jobs.findFirst({
    where: and(eq(schema.jobs.env, currentEnv()), eq(schema.jobs.kind, "bundle.rebuild"), eq(schema.jobs.listingId, listingId), eq(schema.jobs.status, "queued"), notBegun),
    columns: { id: true, runAt: true },
  });
  if (waiting) {
    // Queued and not begun, so it has not read the rows yet and will see this change.
    const later = opts.settleMs ? waiting.runAt < runAt : false; // an upload: wait for it to go quiet
    const sooner = !opts.settleMs && waiting.runAt > now; // an explicit change: do not sit behind an upload's wait
    if (later || sooner) {
      await db().update(schema.jobs).set({ runAt, updatedAt: now }).where(and(eq(schema.jobs.id, waiting.id), eq(schema.jobs.status, "queued")));
    }
    return;
  }
  await enqueueJobs([{ kind: "bundle.rebuild", idempotencyKey: `bundle.rebuild:${listingId}:${randomUUID()}`, payload: { listingId }, listingId, runAt }]);
}

// ---- Whose turn it is ---------------------------------------------------------------
//
// Two rules, asked when a run picks a rebuild up and again right before each
// zip lands:
// 1. A newer rebuild of the listing that has begun, is being run, or is over
//    owns the zips. This one stops for good ("yield"): it read older rows.
// 2. Otherwise, while another rebuild of the listing is being run (its lease
//    is live), this one waits ("wait").
// A newer rebuild that is still only waiting in the queue (an upload settling)
// stops nobody: the one in progress keeps landing zips until that one begins.
// Together: never two at once, and nothing older lands after something newer
// has begun. Whichever of two runs asks second sees the other as running, so
// they cannot both go.
export type RebuildRow = { id: string; status: string; createdAt: Date; leaseUntil: Date | null; begun: boolean };

export function rebuildTurn(me: { id: string; createdAt: Date }, others: RebuildRow[], now: Date): "go" | "wait" | "yield" {
  const rest = others.filter((o) => o.id !== me.id);
  if (rest.some((o) => o.createdAt.getTime() > me.createdAt.getTime() && (o.begun || o.status !== "queued"))) return "yield";
  if (rest.some((o) => o.status === "running" && o.leaseUntil !== null && o.leaseUntil.getTime() > now.getTime())) return "wait";
  return "go";
}

// The listing's other rebuilds that can matter to rebuildTurn: the ones not
// over yet, and every newer one.
export async function rebuildOthers(listingId: string, me: { id: string; createdAt: Date }): Promise<RebuildRow[]> {
  const rows = await db()
    .select({ id: schema.jobs.id, status: schema.jobs.status, createdAt: schema.jobs.createdAt, leaseUntil: schema.jobs.leaseUntil, begun })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.env, currentEnv()),
        eq(schema.jobs.kind, "bundle.rebuild"),
        eq(schema.jobs.listingId, listingId),
        ne(schema.jobs.id, me.id),
        or(inArray(schema.jobs.status, ["queued", "running"]), gt(schema.jobs.createdAt, me.createdAt))
      )
    );
  return rows.map((r) => ({ ...r, begun: Boolean(r.begun) }));
}
