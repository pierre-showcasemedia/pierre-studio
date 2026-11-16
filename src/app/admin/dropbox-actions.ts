"use server";
// The Dropbox raw mirror's admin actions (Oct 21 2026). Full admins only.
//   disconnectDropbox   forget the stored connection (the refresh token row)
//   mirrorShootAgain    queue a dropbox.mirror job for every file of a shoot
//                       that is not in Dropbox yet, and start on them now
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { clearDropboxConnection, dropboxMirrorEnabled } from "@/lib/dropbox";
import { enqueueMirrorForShoot, MIRROR_KINDS, mirrorNotConfiguredReason } from "@/lib/dropbox-mirror";
import { drainJobs } from "@/lib/jobs";

const enc = (s: string) => encodeURIComponent(s);
const PUSH_MS = 45_000;

export async function disconnectDropbox() {
  const actor = await requireAdmin();
  if (!hasDb()) redirect(`/admin/settings?error=${enc("Demo mode: nothing is saved.")}`);
  try {
    await clearDropboxConnection();
    await logActivity({ actorEmail: actor, action: "dropbox.disconnected" });
  } catch (e) {
    console.error("[dropbox-actions] disconnect", e);
    redirect(`/admin/settings?error=${enc(e instanceof Error ? e.message.slice(0, 160) : "Could not disconnect.")}`);
  }
  revalidatePath("/admin/settings");
  redirect("/admin/settings?saved=dropbox-off");
}

export async function mirrorShootAgain(shootId: string) {
  const actor = await requireAdmin();
  if (!hasDb()) redirect(`/admin/shoots/${shootId}?mirror=demo`);
  const d = db();
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { id: true, listingId: true, status: true } });
  if (!shoot) redirect("/admin/shoots");
  if (shoot.status === "draft") redirect(`/admin/shoots/${shootId}?error=${enc("Submit the shoot first.")}`);
  if (!dropboxMirrorEnabled()) redirect(`/admin/shoots/${shootId}?error=${enc(`The Dropbox mirror is not on here: ${mirrorNotConfiguredReason()}.`)}`);
  let queued = 0;
  try {
    // A new version per request, so a done or dead job from before never
    // blocks it; the shoot's "all in" stamp is cleared so the hub line comes again.
    queued = await enqueueMirrorForShoot({ shootId, listingId: shoot.listingId, onlyMissing: true, version: Math.floor(Date.now() / 1000) });
    if (queued) await d.update(schema.shoots).set({ dropboxSyncedAt: null, updatedAt: new Date() }).where(eq(schema.shoots.id, shootId));
    await logActivity({ actorEmail: actor, action: "shoot.dropbox_requeued", shootId, listingId: shoot.listingId, meta: { count: queued } });
  } catch (e) {
    console.error("[dropbox-actions] mirror again", e);
    redirect(`/admin/shoots/${shootId}?error=${enc(e instanceof Error ? e.message.slice(0, 160) : "Could not queue the copy.")}`);
  }
  if (queued) after(() => drainJobs({ kinds: MIRROR_KINDS, budgetMs: PUSH_MS, limit: 200 }).catch((e) => console.error("[dropbox-actions] drain", e)));
  revalidatePath(`/admin/shoots/${shootId}`);
  redirect(`/admin/shoots/${shootId}?mirror=${queued}`);
}
