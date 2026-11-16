// One status vocabulary for a shoot's lifecycle, shared by the client portal
// and the admin. Derived, not stored; approval is the only explicit state.
//   Awaiting Shoot   : no media yet
//   In the edit      : admin only, a shoot is moving through editing
//   In review        : admin only, frames are waiting for QC
//   Awaiting Payment : media delivered but downloads still locked
//   Delivered        : media up + unlocked (or delivery email sent), not yet approved
//   Completed        : client hit Approve
export type ShootStatus = "Awaiting Shoot" | "In the edit" | "In review" | "Awaiting Payment" | "Delivered" | "Completed";

export function shootStatus(l: {
  mediaCount: number;
  downloadLocked: boolean;
  approvedAt?: string | null;
  deliveryEmailAt?: string | null;
  // v1.1, admin views only: the listing's active shoot, if any.
  pipeline?: "processing" | "review" | null;
}): ShootStatus {
  if (l.approvedAt) return "Completed";
  if (l.mediaCount === 0 && l.pipeline === "processing") return "In the edit";
  if (l.mediaCount === 0 && l.pipeline === "review") return "In review";
  if (l.mediaCount === 0) return "Awaiting Shoot";
  if (l.downloadLocked) return "Awaiting Payment";
  return "Delivered";
}

// the design tokens state colors (ink-soft, pacific, warning, success), always with a word.
export const STATUS_COLORS: Record<ShootStatus, { bg: string; fg: string }> = {
  "Awaiting Shoot": { bg: "rgba(95,100,110,.10)", fg: "#5F646E" },
  "In the edit": { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  "In review": { bg: "rgba(154,100,0,.10)", fg: "#9A6400" },
  "Awaiting Payment": { bg: "rgba(154,100,0,.10)", fg: "#9A6400" },
  Delivered: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  Completed: { bg: "rgba(26,127,75,.10)", fg: "#1A7F4B" },
};

// The QA team (Oct 2026) never sees payment state: a locked and an unlocked
// gallery both read "Delivered" for them.
export const qaListingStatus = (s: ShootStatus): ShootStatus => (s === "Awaiting Payment" ? "Delivered" : s);
