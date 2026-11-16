"use server";
// Tick an automatic QC flag as done, or untick it (Nov 2 2026, the coordinator:
// "make each fix a checkbox that our QC team can checkmark"). Admins and the
// Photo QC team. The gate is re-checked here, and the flag must be one the
// latest QC pass found on that frame of that shoot. Answers instead of
// redirecting or revalidating, so the opened photo stays put (the same reason
// setFrameQc does not refresh the shoot page).
import { and, eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireStaff } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { ISSUE_LABELS, type QcFixDone } from "@/lib/qc-labels";
import { findFix, staffNames, writeQcFix } from "@/lib/qc-fixes";

export type QcFixResult = { ok: true; done: QcFixDone | null; demo?: boolean } | { ok: false; error: string };

export async function setQcFixDone(input: { shootId: string; mediaId: string; fixKey: string; done: boolean }): Promise<QcFixResult> {
  const staff = await requireStaff();
  const shootId = typeof input?.shootId === "string" ? input.shootId : "";
  const mediaId = typeof input?.mediaId === "string" ? input.mediaId : "";
  const fixKey = typeof input?.fixKey === "string" ? input.fixKey.slice(0, 400) : "";
  const done = input?.done === true;
  if (!shootId || !mediaId || !fixKey) return { ok: false, error: "That fix could not be found." };
  if (!hasDb()) {
    // Demo mode: nothing is saved; the tick shows until the page reloads.
    const names = await staffNames([staff.email]);
    return { ok: true, demo: true, done: done ? { by: staff.email, name: names.get(staff.email.toLowerCase()) ?? null, at: new Date().toISOString() } : null };
  }
  try {
    const m = await db().query.media.findFirst({
      where: and(eq(schema.media.id, mediaId), eq(schema.media.shootId, shootId)),
      columns: { id: true, filename: true, listingId: true, qcIssues: true },
    });
    if (!m) return { ok: false, error: "That photo is not on this shoot." };
    const issue = findFix(m.qcIssues, fixKey);
    if (!issue) return { ok: false, error: "QC no longer flags that on this photo. Reload to see the latest flags." };
    const row = await writeQcFix(m.id, fixKey, done, staff.email);
    await logActivity({ actorEmail: staff.email, action: "media.qc_fix", shootId, listingId: m.listingId, meta: { mediaId: m.id, filename: m.filename, type: issue.type, label: ISSUE_LABELS[issue.type], done } });
    return { ok: true, done: row };
  } catch (e) {
    console.error("[qc-fix] write failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: "Could not save that tick. Try again." };
  }
}
