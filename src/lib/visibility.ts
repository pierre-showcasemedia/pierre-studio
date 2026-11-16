// Client visible or internal only (Oct 2026), as the admin and the QA team
// read it. Pure: no database, safe in client components.
//
// The rule for what a client sees lives in src/lib/media-visibility.ts and is
// unchanged: approved AND published AND (no shoot, or the shoot published).
// isClientVisibleRow below is that same rule; scripts/check-qa-role.ts checks
// the two agree on every combination.
//
// Everything a client cannot see is "Internal only", with one reason:
//   held      moved to internal by hand (or a loose file added or kept hidden).
//             The bulk Publish never touches it.
//   rejected  rejected in QC (automatic or by a person). No Publish ever
//             sends it (Nov 2 2026: rejecting also takes it off the listing).
//   pending   fresh from editing, not reviewed. It stays internal until
//             someone approves it; Publish leaves it out.
//   waiting   approved, not live yet (a corrected final, or a frame on a shoot
//             that has not been published). Publish sends it live.
import type { QcState } from "@/db/schema";

export type Visibility = "client" | "held" | "rejected" | "pending" | "waiting";

export type VisibilityRow = { qcState: QcState; published: boolean; held?: boolean | null; shootId: string | null };

// shootPublished: whether the frame's shoot has been published at least once
// (ignored for a loose file with no shoot).
export function isClientVisibleRow(m: VisibilityRow, shootPublished: boolean): boolean {
  return m.qcState === "approved" && m.published && (!m.shootId || shootPublished);
}

export function visibilityOf(m: VisibilityRow, shootPublished: boolean): Visibility {
  if (isClientVisibleRow(m, shootPublished)) return "client";
  if (m.held || (!m.shootId && !m.published)) return "held";
  if (m.qcState === "rejected") return "rejected";
  if (m.qcState === "pending") return "pending";
  return "waiting";
}

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  client: "Client visible",
  held: "Held back",
  rejected: "Rejected · never visible",
  pending: "Not reviewed · approve to publish",
  waiting: "Approved · not published yet",
};

// One line for a tooltip. Admin and QA only: may name the editing step.
export const VISIBILITY_HINT: Record<Visibility, string> = {
  client: "The client sees this in their gallery and can download it once downloads are unlocked.",
  held: "Moved to internal only by hand. The bulk Publish leaves it alone; Publish on the photo itself sends it live.",
  rejected: "Rejected. It never reaches the client and no Publish sends it. Un-reject it to review it again.",
  pending: "Not reviewed yet. It stays internal until someone approves it; Publish leaves it out.",
  waiting: "Approved and not on the listing yet. Publish sends it live.",
};

export const isInternal = (v: Visibility) => v !== "client";
