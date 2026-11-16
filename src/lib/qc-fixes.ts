// Automatic QC fix checkboxes (Nov 2 2026). the coordinator: "make each fix a
// checkbox that our QC team can checkmark to notate that each flag has been
// done." Every flag the automatic QC found on a frame (media.qc_issues) gets
// a tick in the opened photo's Automatic QC panel; a tick is one
// qc_fix_checks row with who ticked it and when.
//
// Keyed by (media id, qcFixKey(flag)), the flag's type and normalized note
// (src/lib/qc-labels.ts). "Run QC again" rewrites media.qc_issues: a flag that
// comes back word for word on the same photo keeps its tick, a new or
// reworded flag starts unticked, and finishing the pass drops the ticks for
// flags it no longer found (pruneQcFixes), so an old tick never comes back on
// a later pass. Admins and the Photo QC team (the action is staff gated).
import { and, eq, inArray } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { QcIssue } from "@/db/schema";
import { DEMO_STAFF } from "./demo-data";
import { qcFixKey, type QcFixDone } from "./qc-labels";

export type QcFixMap = Map<string, Record<string, QcFixDone>>;

// Staff display names by email (admins.name), for "Done by Name".
export async function staffNames(emails: string[]): Promise<Map<string, string>> {
  const want = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const out = new Map<string, string>();
  if (!want.length) return out;
  if (!hasDb()) {
    for (const s of DEMO_STAFF) if (want.includes(s.email)) out.set(s.email, s.name);
    return out;
  }
  const rows = await db().query.admins.findMany({ where: inArray(schema.admins.email, want), columns: { email: true, name: true } });
  for (const r of rows) if (r.name) out.set(r.email.toLowerCase(), r.name);
  return out;
}

// The ticks on these frames, by media id then fix key. Never throws: a
// missing table (the migration not run yet) or a failed read shows every flag
// unticked rather than breaking the shoot page.
export async function qcFixesFor(mediaIds: string[]): Promise<QcFixMap> {
  const out: QcFixMap = new Map();
  if (!hasDb() || !mediaIds.length) return out;
  try {
    const rows = await db().select().from(schema.qcFixChecks).where(inArray(schema.qcFixChecks.mediaId, mediaIds));
    const names = await staffNames(rows.map((r) => r.checkedBy));
    for (const r of rows) {
      const m = out.get(r.mediaId) ?? {};
      m[r.fixKey] = { by: r.checkedBy, name: names.get(r.checkedBy.toLowerCase()) ?? null, at: r.checkedAt.toISOString() };
      out.set(r.mediaId, m);
    }
  } catch (e) {
    console.error("[qc-fixes] read failed:", e instanceof Error ? e.message : e);
  }
  return out;
}

// The frame's flag with this key, or null when the latest pass did not find it.
export function findFix(issues: QcIssue[] | null | undefined, fixKey: string): QcIssue | null {
  return (issues ?? []).find((i) => qcFixKey(i) === fixKey) ?? null;
}

// Tick or untick one flag. Idempotent both ways.
export async function writeQcFix(mediaId: string, fixKey: string, done: boolean, actor: string): Promise<QcFixDone | null> {
  const d = db();
  if (!done) {
    await d.delete(schema.qcFixChecks).where(and(eq(schema.qcFixChecks.mediaId, mediaId), eq(schema.qcFixChecks.fixKey, fixKey)));
    return null;
  }
  const [row] = await d
    .insert(schema.qcFixChecks)
    .values({ mediaId, fixKey, checkedBy: actor })
    .onConflictDoUpdate({ target: [schema.qcFixChecks.mediaId, schema.qcFixChecks.fixKey], set: { checkedBy: actor, checkedAt: new Date() } })
    .returning();
  const names = await staffNames([actor]);
  return { by: row.checkedBy, name: names.get(actor.toLowerCase()) ?? null, at: row.checkedAt.toISOString() };
}

// After a QC pass: on every frame the pass answered for, drop the ticks for
// flags it did not find again. Frames with no result (rejected frames the
// pass skips, corrected finals) keep theirs. Never throws.
export async function pruneQcFixes(frames: { id: string; qcIssues: QcIssue[] | null }[]): Promise<number> {
  const answered = frames.filter((f) => Array.isArray(f.qcIssues));
  if (!hasDb() || !answered.length) return 0;
  try {
    const d = db();
    const keys = new Map(answered.map((f) => [f.id, new Set(f.qcIssues!.map(qcFixKey))]));
    const rows = await d.select({ id: schema.qcFixChecks.id, mediaId: schema.qcFixChecks.mediaId, fixKey: schema.qcFixChecks.fixKey }).from(schema.qcFixChecks).where(inArray(schema.qcFixChecks.mediaId, [...keys.keys()]));
    const stale = rows.filter((r) => !keys.get(r.mediaId)?.has(r.fixKey)).map((r) => r.id);
    if (stale.length) await d.delete(schema.qcFixChecks).where(inArray(schema.qcFixChecks.id, stale));
    return stale.length;
  } catch (e) {
    console.error("[qc-fixes] prune failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

// A corrected upload replaced this frame's file (src/lib/finals.ts): its old
// flags are gone, so are their ticks. The ticks stay in activity
// (media.qc_fix). Never throws (the table may not exist before the migration).
export async function clearQcFixes(mediaId: string): Promise<void> {
  if (!hasDb()) return;
  try {
    await db().delete(schema.qcFixChecks).where(eq(schema.qcFixChecks.mediaId, mediaId));
  } catch (e) {
    console.error("[qc-fixes] clear failed:", e instanceof Error ? e.message : e);
  }
}
