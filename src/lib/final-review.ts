// Send for final review (Oct 28 2026). the owner: the editors download ALL the
// frames (Download all for editing), fix them, then drop the corrected JPGs
// back on the shoot page with the same filenames, so each one replaces its
// frame in place and the order holds. They press Send for final review,
// which "notifies me, the coordinator, the coordinator, and a manager". Those four do the final
// pass on the shoot page (approve or reject, Publish) and the coordinator delivers to
// the agent from the backend, by hand as always (rule 7).
//
// One hub line per send, flagged and tagged with the final review list
// (Settings → Slack QC tags, src/lib/slack-qc.ts). A send that ends an upload
// run keeps the run's own "Upload finished" line quiet, so the team gets one
// message. Each send is logged (shoot.final_review); the shoot sits in the
// Photo QC board's Final review column, and the shoot page says who sent it,
// until the shoot is published after it.
//
// Nov 3 2026 (the coordinator's flow: upload the revised photos, Run QC again, tick
// every flag, then send): the shoot page has its own Send for final review
// panel (src/components/admin/FinalReviewPanel.tsx). The line goes to the PMs'
// review channel when its webhook is set (src/lib/slack.ts hubFinalReview),
// and says how many QC flags are not ticked; an open flag warns, it never
// stops the send. A second send while one is open (not published since)
// needs again: true, which the panel asks for with a confirm.
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { logActivity } from "./activity";
import { isActive } from "./shoot-status";
import { hubFinalReview } from "./slack";
import { qcFixesFor } from "./qc-fixes";
import { reviewReadiness, type ReviewReadiness } from "./qc-labels";
import { finishUploadRun, type RunFailure } from "./upload-runs";

export const FINAL_REVIEW_ACTION = "shoot.final_review" as const;
// A second press inside this window (a double click, a retry) sends nothing.
const RESEND_MS = 2 * 60_000;

export type FinalReview = { at: Date; by: string | null; corrected: number };

// A send is open until the shoot is published after it.
export function finalReviewOpen(fr: { at: Date | string } | null | undefined, publishedAt: Date | string | null | undefined): boolean {
  if (!fr) return false;
  if (!publishedAt) return true;
  return new Date(fr.at).getTime() > new Date(publishedAt).getTime();
}

// The latest send per shoot.
export async function lastFinalReviews(shootIds: string[]): Promise<Map<string, FinalReview>> {
  const out = new Map<string, FinalReview>();
  if (!hasDb() || !shootIds.length) return out;
  const rows = await db().query.activity.findMany({
    where: and(eq(schema.activity.action, FINAL_REVIEW_ACTION), inArray(schema.activity.shootId, shootIds)),
    orderBy: [desc(schema.activity.createdAt)],
    columns: { shootId: true, createdAt: true, actorEmail: true, meta: true },
  });
  for (const r of rows) {
    if (!r.shootId || out.has(r.shootId)) continue;
    const c = r.meta?.corrected;
    out.set(r.shootId, { at: r.createdAt, by: r.actorEmail, corrected: typeof c === "number" ? c : 0 });
  }
  return out;
}

export type SendResult = { ok: true; sent: boolean; corrected: number; failed: number; reason?: string; by?: string | null; at?: string; readiness?: ReviewReadiness; channel?: "review" | "hub" | null } | { ok: false; error: string };

// The flags and revised photos of a shoot, for the warning and the line.
async function shootReadiness(shootId: string): Promise<ReviewReadiness> {
  const frames = await db().query.media.findMany({ where: eq(schema.media.shootId, shootId), columns: { id: true, qcState: true, corrected: true, qcIssues: true, qcCheckedAt: true } });
  const fixes = await qcFixesFor(frames.map((f) => f.id));
  return reviewReadiness(frames.map((f) => ({ ...f, qcFixes: fixes.get(f.id) ?? {} })));
}

// With a run: the end of an upload (the counts come from the run's own
// rows, src/lib/upload-runs.ts). Without one: a send on its own after an
// Upload only, counting the corrected frames that are not published yet.
export async function sendForFinalReview(p: { shootId: string; actor: string; run?: string | null; total?: number | null; failed?: RunFailure[]; again?: boolean }): Promise<SendResult> {
  const d = db();
  const shoot = await d.query.shoots.findFirst({
    where: eq(schema.shoots.id, p.shootId),
    columns: { id: true, status: true, listingId: true, publishedAt: true },
    with: { listing: { columns: { address: true, nda: true } } },
  });
  if (!shoot) return { ok: false, error: "Shoot not found." };
  if (shoot.status === "draft" || shoot.status === "video_only" || isActive(shoot.status)) return { ok: false, error: "A shoot goes to final review once its frames are in." };
  const failed = p.failed?.length ?? 0;
  let corrected: number;
  if (p.run) {
    const r = await finishUploadRun({ run: p.run, listingId: shoot.listingId, actor: p.actor, total: p.total ?? null, failed: p.failed, published: false, review: true });
    if (!r.posted) return { ok: true, sent: false, corrected: r.totals.corrected, failed, reason: "already sent" };
    // Nothing went in: the run's own line says the upload failed; nobody is tagged.
    if (!r.totals.landed) return { ok: true, sent: false, corrected: 0, failed, reason: "nothing went in" };
    corrected = r.totals.corrected;
  } else {
    const recent = await d.query.activity.findFirst({
      where: and(eq(schema.activity.action, FINAL_REVIEW_ACTION), eq(schema.activity.shootId, shoot.id), gt(schema.activity.createdAt, new Date(Date.now() - RESEND_MS))),
      columns: { id: true, actorEmail: true, createdAt: true },
    });
    const waiting = await d.query.media.findMany({ where: and(eq(schema.media.shootId, shoot.id), eq(schema.media.corrected, true), eq(schema.media.published, false)), columns: { id: true } });
    corrected = waiting.length;
    // A double click or a retry inside two minutes sends nothing, again or not.
    if (recent) return { ok: true, sent: false, corrected, failed: 0, reason: "already sent", by: recent.actorEmail, at: recent.createdAt.toISOString() };
    // Already sent and not published since: only a confirmed Send again goes.
    const last = (await lastFinalReviews([shoot.id])).get(shoot.id) ?? null;
    if (last && finalReviewOpen(last, shoot.publishedAt) && !p.again) return { ok: true, sent: false, corrected, failed: 0, reason: "already sent", by: last.by, at: last.at.toISOString() };
  }
  const readiness = await shootReadiness(shoot.id);
  // Logged before the post, so a second request a moment later finds it.
  await logActivity({ actorEmail: p.actor, action: FINAL_REVIEW_ACTION, shootId: shoot.id, listingId: shoot.listingId, meta: { corrected, failed, openFlags: readiness.openFlags, revisedUnchecked: readiness.revisedUnchecked, ...(p.again ? { again: true } : {}), ...(p.run ? { run: p.run } : {}) } });
  const post = await hubFinalReview({ shootId: shoot.id, listing: shoot.listing, corrected, failed, by: p.actor, openFlags: readiness.openFlags, revisedUnchecked: readiness.revisedUnchecked });
  return { ok: true, sent: true, corrected, failed, by: p.actor, at: new Date().toISOString(), readiness, channel: post.channel };
}
