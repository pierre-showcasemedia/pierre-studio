// Pure helpers for the automatic QC results, safe for client components
// (no SDK, no env). The server side lives in src/lib/qc.ts.
import type { QcIssue, QcSeverity } from "@/db/schema";

export function worstSeverity(issues: QcIssue[] | null | undefined): QcSeverity | null {
  if (!issues?.length) return null;
  if (issues.some((i) => i.severity === "block")) return "block";
  if (issues.some((i) => i.severity === "fix")) return "fix";
  return "minor";
}

export const ISSUE_LABELS: Record<QcIssue["type"], string> = {
  person: "Person in frame",
  photographer: "Photographer or gear",
  reflection: "Reflection",
  artifact: "Processing artifact",
  blown_window: "Blown window",
  crooked: "Crooked",
  dust: "Dust spot",
  color: "Color cast",
  composition: "Composition",
  other: "Other",
};

// ---- Fix checkboxes (Nov 2 2026) --------------------------------------------
// the coordinator: "make each fix a checkbox that our QC team can checkmark to
// notate that each flag has been done." A flag's done state lives in
// qc_fix_checks under (media id, fix key). The key is the flag itself, its
// type and its note (case, spacing and end punctuation ignored), so "Run QC
// again" keeps the tick on a flag that comes back word for word on the same
// photo and starts a new or reworded flag unticked. Severity is not part of
// the key: the same thing found at a different severity is the same fix.
export type QcFixDone = { by: string; name: string | null; at: string };

export function qcFixKey(issue: Pick<QcIssue, "type" | "note">): string {
  const note = issue.note.toLowerCase().replace(/\s+/g, " ").trim().replace(/[\s.,;:!]+$/, "");
  return `${issue.type}:${note}`;
}

// Done and total over the frame's current flags (a stored tick for a flag
// the latest pass did not find is not counted).
export function qcFixProgress(issues: QcIssue[] | null | undefined, done: Record<string, QcFixDone> | null | undefined): { done: number; total: number } {
  const keys = [...new Set((issues ?? []).map(qcFixKey))];
  return { done: done ? keys.filter((k) => done[k]).length : 0, total: keys.length };
}

// ---- The editors' flow (Nov 3 2026) ------------------------------------------
// the coordinator: photos come back from editing and QC runs; every photo is Internal
// only and stays in its section (no flag rejects or hides one); the editor
// downloads all, fixes them ticking each flag, uploads them back (the Revised
// section: corrected=true), runs QC again on them, ticks what is left, and
// presses Send for final review; a PM does the final pass and publishes.

// Approve all leaves a photo with a block flag for a person: QC used to
// reject those, and a blocking problem should never ship on a bulk click.
export function approveAllSkips(f: { qcState: string; qcIssues: QcIssue[] | null | undefined }): boolean {
  return f.qcState === "pending" && worstSeverity(f.qcIssues) === "block";
}

export type ReviewReadiness = {
  openFlags: number; // flags not ticked yet, on photos that can still ship
  openPhotos: number; // photos with at least one of those
  revised: number; // the editors' corrected uploads
  revisedUnchecked: number; // revised photos QC has not looked at since they were uploaded
};

// What Send for final review warns about. Rejected photos never ship, so
// their flags do not count. A warning, never a block: the editor can still send.
export function reviewReadiness(frames: { qcState: string; corrected: boolean; qcIssues: QcIssue[] | null | undefined; qcCheckedAt: string | Date | null | undefined; qcFixes?: Record<string, QcFixDone> | null }[]): ReviewReadiness {
  const out: ReviewReadiness = { openFlags: 0, openPhotos: 0, revised: 0, revisedUnchecked: 0 };
  for (const f of frames) {
    if (f.qcState === "rejected") continue;
    const p = qcFixProgress(f.qcIssues, f.qcFixes);
    const open = p.total - p.done;
    if (open > 0) { out.openFlags += open; out.openPhotos++; }
    if (f.corrected) {
      out.revised++;
      if (!f.qcCheckedAt) out.revisedUnchecked++;
    }
  }
  return out;
}

// The warning line, or "" when every flag is ticked and QC has seen every revised photo.
export function readinessWarning(r: ReviewReadiness): string {
  const parts: string[] = [];
  if (r.openFlags) parts.push(`${r.openFlags} QC flag${r.openFlags === 1 ? " is" : "s are"} not ticked yet, on ${r.openPhotos} photo${r.openPhotos === 1 ? "" : "s"}.`);
  if (r.revisedUnchecked) parts.push(`${r.revisedUnchecked} revised photo${r.revisedUnchecked === 1 ? " has" : "s have"} not been through QC since ${r.revisedUnchecked === 1 ? "it was" : "they were"} uploaded. Run QC again first.`);
  return parts.join(" ");
}
