// Files of an upload that just landed in R2: start their Dropbox copy now,
// while the rest of the shoot is still uploading. Admin or creative specialist.
// POST { shootId, filenames: [stored filename, ...] } → { ok, queued }
//
// Oct 27 2026: the copy used to start only at Submit and then share
// the cron's minute with the editing transfer, so a 29 GB shoot reached
// Dropbox hours after it reached R2. The upload page now reports every few
// seconds which files finished; each report queues their dropbox.mirror jobs
// (the same idempotency keys Submit uses, so nothing is copied twice) and
// runs a copy drain after the response. Several reports overlap, so several
// files copy at once. Submit still queues anything a report missed.
import { after } from "next/server";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireUploaderApi } from "@/lib/admin";
import { dropboxMirrorEnabled } from "@/lib/dropbox";
import { FOLDER_KIND, MIRROR_KIND } from "@/lib/dropbox-mirror";
import { drainJobs } from "@/lib/jobs";
import { enqueueJobs, jobKey } from "@/lib/jobs-core";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_NAMES = 200;
// Copies at once across every drain; a report past this adds its jobs and
// lets the drains already running pick them up.
const MAX_PARALLEL = 6;
// Leaves room under maxDuration for the response and the last chunk's write.
const DRAIN_MS = 270_000;

export async function POST(request: Request) {
  const who = await requireUploaderApi();
  if (who instanceof Response) return who;
  if (!hasDb()) return Response.json({ ok: true, demo: true, queued: 0 });
  if (!dropboxMirrorEnabled()) return Response.json({ ok: true, queued: 0, mirror: false });

  const b = await request.json().catch(() => ({}));
  const shootId = typeof b.shootId === "string" ? b.shootId : "";
  const names = (Array.isArray(b.filenames) ? b.filenames : []).filter((n: unknown): n is string => typeof n === "string" && n.length > 0).slice(0, MAX_NAMES);
  if (!shootId || !names.length) return Response.json({ ok: false, error: "shootId and filenames are required." }, { status: 400 });

  const d = db();
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { id: true, listingId: true } });
  if (!shoot) return Response.json({ ok: false, error: "Shoot not found." }, { status: 404 });
  const files = await d.query.shootFiles.findMany({ where: and(eq(schema.shootFiles.shootId, shootId), inArray(schema.shootFiles.filename, names)), columns: { id: true, dropboxSyncedAt: true } });
  const todo = files.filter((f) => !f.dropboxSyncedAt);
  const queued = todo.length
    ? await enqueueJobs(todo.map((f) => ({ kind: MIRROR_KIND, idempotencyKey: jobKey(MIRROR_KIND, f.id, 1), payload: { version: 1, shootFileId: f.id, shootId, listingId: shoot.listingId }, listingId: shoot.listingId })))
    : 0;
  const [{ n: copying }] = await d
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.kind, MIRROR_KIND), eq(schema.jobs.status, "running"), gt(schema.jobs.leaseUntil, new Date())));
  if (todo.length && Number(copying) < MAX_PARALLEL) {
    after(() =>
      drainJobs({ kinds: [MIRROR_KIND, FOLDER_KIND], budgetMs: DRAIN_MS, limit: 400 })
        .then(() => undefined)
        .catch((e) => console.error("[upload-landed] drain", shootId, e))
    );
  }
  return Response.json({ ok: true, queued });
}
