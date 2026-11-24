"use server";
// The Google Drive mirror's admin actions (Nov 18 2026). Full admins only.
//   disconnectDrive    forget the stored connection (the refresh token row)
//   driveShootAgain    queue a drive.mirror job for every file of a shoot that
//                      is not in Google Drive yet, and start on them now
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { clearDriveConnection, driveMirrorEnabled } from "@/lib/google-drive";
import { DRIVE_KINDS, driveNotConfiguredReason, enqueueDriveMirrorForShoot } from "@/lib/drive-mirror";
import { drainJobs } from "@/lib/jobs";

const enc = (s: string) => encodeURIComponent(s);
const PUSH_MS = 45_000;

export async function disconnectDrive() {
  const actor = await requireAdmin();
  if (!hasDb()) redirect(`/admin/settings?error=${enc("Demo mode: nothing is saved.")}`);
  try {
    await clearDriveConnection();
    await logActivity({ actorEmail: actor, action: "drive.disconnected" });
  } catch (e) {
    console.error("[drive-actions] disconnect", e);
    redirect(`/admin/settings?error=${enc(e instanceof Error ? e.message.slice(0, 160) : "Could not disconnect.")}`);
  }
  revalidatePath("/admin/settings");
  redirect("/admin/settings?saved=drive-off#google-drive");
}

export async function driveShootAgain(shootId: string) {
  const actor = await requireAdmin();
  if (!hasDb()) redirect(`/admin/shoots/${shootId}?mirror=demo`);
  const d = db();
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { id: true, listingId: true, status: true } });
  if (!shoot) redirect("/admin/shoots");
  if (shoot.status === "draft") redirect(`/admin/shoots/${shootId}?error=${enc("Submit the shoot first.")}`);
  if (!driveMirrorEnabled()) redirect(`/admin/shoots/${shootId}?error=${enc(`The Google Drive copy is not on here: ${driveNotConfiguredReason()}.`)}`);
  let queued = 0;
  try {
    queued = await enqueueDriveMirrorForShoot({ shootId, listingId: shoot.listingId, onlyMissing: true, version: Math.floor(Date.now() / 1000) });
    if (queued) await d.update(schema.shoots).set({ driveSyncedAt: null, updatedAt: new Date() }).where(eq(schema.shoots.id, shootId));
    await logActivity({ actorEmail: actor, action: "shoot.drive_requeued", shootId, listingId: shoot.listingId, meta: { count: queued } });
  } catch (e) {
    console.error("[drive-actions] copy again", e);
    redirect(`/admin/shoots/${shootId}?error=${enc(e instanceof Error ? e.message.slice(0, 160) : "Could not queue the copy.")}`);
  }
  if (queued) after(() => drainJobs({ kinds: DRIVE_KINDS, budgetMs: PUSH_MS, limit: 200 }).catch((e) => console.error("[drive-actions] drain", e)));
  revalidatePath(`/admin/shoots/${shootId}`);
  redirect(`/admin/shoots/${shootId}?mirror=${queued}`);
}
