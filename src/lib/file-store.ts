// Which file service the studio copies into (business.fileStore, Nov 18 2026)
// and the shoot page's view of that copy, the same shape for both: the
// service's name, how many of the shoot's files are in, whether the copy is
// set up here, and the folder link. Server-safe, no JSX.
import type { AdminShoot, AdminShootFile } from "./admin-types";
import { business } from "./business";
import { dropboxMirrorEnabled, hasDropboxApp } from "./dropbox";
import { mirrorSummary } from "./dropbox-mirror";
import { driveFolderUrl, driveMirrorEnabled, hasDriveApp } from "./google-drive";
import type { MirrorState } from "@/components/admin/DropboxMirrorLine";

export const onDrive = (): boolean => business.fileStore === "google_drive";
export const fileStoreName = (): "Dropbox" | "Google Drive" => (onDrive() ? "Google Drive" : "Dropbox");

export type ShootCopyView = {
  service: "Dropbox" | "Google Drive";
  mirror: { total: number; synced: number; photos: number; video: number };
  state: MirrorState;
  syncedAt: string | null;
  folderUrl: string | null; // Drive: the listing folder; Dropbox shows its path instead
  inCopy: (f: AdminShootFile) => boolean;
};

export function shootCopyView(shoot: AdminShoot, files: AdminShootFile[], demo: boolean): ShootCopyView {
  if (onDrive()) {
    return {
      service: "Google Drive",
      mirror: mirrorSummary(files.map((f) => ({ kind: f.kind, dropboxSyncedAt: f.driveSyncedAt ?? null }))),
      state: demo ? "on" : driveMirrorEnabled() ? "on" : hasDriveApp() ? "elsewhere" : "off",
      syncedAt: shoot.driveSyncedAt ?? null,
      folderUrl: shoot.driveFolderId ? driveFolderUrl(shoot.driveFolderId) : null,
      inCopy: (f) => Boolean(f.driveSyncedAt),
    };
  }
  return {
    service: "Dropbox",
    mirror: mirrorSummary(files),
    state: demo ? "on" : dropboxMirrorEnabled() ? "on" : hasDropboxApp() ? "elsewhere" : "off",
    syncedAt: shoot.dropboxSyncedAt,
    folderUrl: null,
    inCopy: (f) => Boolean(f.dropboxSyncedAt),
  };
}
