// Shoot status vocabulary shared by server and client components. Pure: no
// db, no env, so client bundles can import it.
import { BUSINESS_TZ } from "./business";
import type { ShootStatus, ShootOptions } from "@/db/schema";
import { TWILIGHT_CREDITS } from "./autohdr-constants";

export const STEP_ORDER: ShootStatus[] = [
  "draft",
  "uploaded",
  "transferring",
  "committing",
  "processing",
  "importing",
  "twilight",
  "qc",
  "ready_for_review",
  "published",
  "video_only",
];

// Admin-facing labels. The admin side may say "editing"; it never says a vendor name.
export const STEP_LABELS: Record<ShootStatus, string> = {
  draft: "Uploading",
  uploaded: "Uploaded",
  transferring: "Sending to editing",
  committing: "Starting editing",
  processing: "Editing",
  importing: "Pulling frames",
  twilight: "Virtual twilight",
  qc: "Automatic QC",
  ready_for_review: "Ready for review",
  published: "Published",
  failed: "Stopped",
  video_only: "Video only",
};

export const STEP_BLURBS: Record<ShootStatus, string> = {
  draft: "Files are still landing. Finish the upload to submit.",
  uploaded: "Submitted. Editing has started.",
  transferring: "Files are moving from storage to the editing account.",
  committing: "All files landed. Asking editing to start.",
  processing: "Frames are being edited. Most shoots take 15 to 45 minutes.",
  importing: "Finished frames are being pulled in and sized for the gallery.",
  twilight: "The best exteriors are getting their twilight versions.",
  qc: "Every frame is getting an automatic QC pass before anyone looks at it.",
  ready_for_review: "Every frame is in and QC has run. Approve or reject, then publish.",
  published: "Approved frames are live in the client gallery.",
  failed: "The pipeline stopped. Retry from the shoot page once the cause is clear.",
  video_only: "Video only: raw footage copied to Dropbox. Nothing goes to editing and there is no gallery to publish from this upload.",
};

// the design tokens state colours, always paired with a word.
export const STEP_COLORS: Record<ShootStatus, { bg: string; fg: string }> = {
  draft: { bg: "rgba(95,100,110,.10)", fg: "#5F646E" },
  uploaded: { bg: "rgba(95,100,110,.10)", fg: "#5F646E" },
  transferring: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  committing: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  processing: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  importing: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  twilight: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  qc: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  ready_for_review: { bg: "rgba(154,100,0,.10)", fg: "#9A6400" },
  published: { bg: "rgba(26,127,75,.10)", fg: "#1A7F4B" },
  failed: { bg: "rgba(215,52,42,.08)", fg: "#D7342A" },
  video_only: { bg: "rgba(26,127,75,.10)", fg: "#1A7F4B" },
};

export const ACTIVE_STATUSES: ShootStatus[] = ["uploaded", "transferring", "committing", "processing", "importing", "twilight", "qc"];

export function isActive(s: ShootStatus): boolean {
  return ACTIVE_STATUSES.includes(s);
}

// Where frames can be published from (src/lib/frame-publish.ts and the shoot
// page's Publish bar). Ready for review and published are the normal cases.
// Failed is the recovery (Nov 3 2026, 925 Example Spruce Road): editing stopped
// (credits ran out, a part never finished) and the editors delivered the
// corrected photos by hand through the corrected photos box, which a failed
// shoot already accepts. They are approved like any other frame, and
// publishing them closes the failure (status published, the error cleared).
// Nothing publishes while the pipeline is still running.
export const PUBLISHABLE_STATUSES: ShootStatus[] = ["ready_for_review", "published", "failed"];

export function canPublishFrom(s: ShootStatus): boolean {
  return PUBLISHABLE_STATUSES.includes(s);
}

// How many of a shoot's files are photos (the editing input, the credits
// estimate). Written at submit since Oct 21 2026; older shoots have no video.
export function photoFileCount(s: { fileCount: number; options?: ShootOptions | null }): number {
  const files = s.options?.files;
  return files ? Math.max(0, s.fileCount - files.video) : s.fileCount;
}

// Timeline rail: the five steps an admin cares about.
export type RailStep = { key: string; label: string; state: "done" | "now" | "todo" | "failed" };
export function railFor(status: ShootStatus, failedFrom?: string | null, twilightOn = true): RailStep[] {
  // Video only (Oct 21 2026): two steps, the upload and the Dropbox copy.
  if (status === "video_only") {
    return [
      { key: "upload", label: "Uploaded", state: "done" },
      { key: "dropbox", label: "Dropbox", state: "done" },
    ];
  }
  const steps: { key: string; label: string; covers: ShootStatus[] }[] = [
    { key: "upload", label: "Uploaded", covers: ["draft", "uploaded"] },
    { key: "edit", label: "Editing", covers: ["transferring", "committing", "processing"] },
    { key: "import", label: "Frames in", covers: ["importing"] },
    ...(twilightOn ? [{ key: "twilight", label: "Twilight", covers: ["twilight"] as ShootStatus[] }] : []),
    { key: "qc", label: "QC", covers: ["qc"] },
    { key: "review", label: "Review", covers: ["ready_for_review"] },
    { key: "publish", label: "Published", covers: ["published"] },
  ];
  const effective = (status === "failed" ? (failedFrom as ShootStatus) || "uploaded" : status) as ShootStatus;
  const idx = steps.findIndex((s) => s.covers.includes(effective));
  const cur = idx < 0 ? steps.length - 1 : idx;
  return steps.map((s, i) => ({
    key: s.key,
    label: s.label,
    state: status === "failed" && i === cur ? "failed" : i < cur ? "done" : i === cur ? (status === "published" ? "done" : "now") : "todo",
  }));
}

// Credits, roughly: raws come in brackets of about three, finished JPGs 1:1.
export function estimateCredits(o: ShootOptions | null | undefined, fileCount: number, photoCount: number): { photos: number; edit: number; twilight: number; total: number; exact: boolean } {
  const perPhoto = o?.modelCredits ?? 5;
  const photos = photoCount > 0 ? photoCount : o?.skipHdr ? fileCount : Math.max(1, Math.ceil(fileCount / 3));
  const edit = photos * perPhoto;
  const twilight = o?.twilight?.enabled ? Math.min(o.twilight.count, photos) * TWILIGHT_CREDITS : 0;
  return { photos, edit, twilight, total: edit + twilight, exact: photoCount > 0 };
}

export const fmtBytes = (b: number | null | undefined) =>
  b == null ? "" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;

// Admin times read in local wherever the page renders (Oct 27 2026: the
// server renders in UTC, so "Connected" read 9:06 PM for a 2:06 PM connect).

export const fmtWhen = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { timeZone: BUSINESS_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { timeZone: BUSINESS_TZ, month: "short", day: "numeric", year: "numeric" });
};

// "Nov 1": the day alone, local (the Photo QC cards, the corrected photos box).
export const fmtDate = (when: string | Date | null | undefined) => {
  if (!when) return "";
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return String(when);
  return d.toLocaleDateString("en-US", { timeZone: BUSINESS_TZ, month: "short", day: "numeric" });
};
