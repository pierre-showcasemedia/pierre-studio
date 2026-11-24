// GET /api/studio/drive/callback?code&state  (admin session + the signed state)
// Google sends the admin back here. The state must be the JWT Connect signed
// for this same admin; then the code is swapped for a REFRESH token, the
// account's name and email are read for the card, and the connection is
// stored in the settings table. The token is never logged, returned or shown.
// Lands back on /admin/settings with a banner.
import { requireAdminApi } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { canConnectDriveHere, DRIVE_SCOPE, driveAccount, driveRootName, exchangeDriveCode, hasDriveApp, saveDriveConnection, verifyDriveState } from "@/lib/google-drive";
import { hasDb } from "@/db";
import { siteUrl } from "@/lib/brand";

export const dynamic = "force-dynamic";

const back = (q: string) => Response.redirect(new URL(`/admin/settings?${q}#google-drive`, siteUrl()).toString(), 303);
const enc = (s: string) => encodeURIComponent(s);

export async function GET(request: Request) {
  const admin = await requireAdminApi();
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");
  if (denied) {
    console.warn(`[drive] callback: Google returned ${denied.slice(0, 60)}`);
    return back(`error=${enc(`Google Drive did not connect (${denied === "access_denied" ? "access was declined" : denied.slice(0, 60)}).`)}`);
  }
  if (!hasDb() || !hasDriveApp() || !canConnectDriveHere()) {
    console.warn("[drive] callback: cannot connect on this deployment");
    return back(`error=${enc("Google Drive cannot be connected from here. Connect from the live portal.")}`);
  }
  if (!code || !(await verifyDriveState(state, admin))) {
    console.warn(`[drive] callback: ${code ? "stale or foreign state" : "no code"}`);
    return back(`error=${enc("That Google sign-in link was stale or not yours. Press Connect again.")}`);
  }
  try {
    const t = await exchangeDriveCode(code);
    // Google lets a person untick the Drive permission on the consent screen.
    if (!t.scope.split(/\s+/).includes(DRIVE_SCOPE)) {
      return back(`error=${enc("Google Drive access was not ticked on Google's screen. Press Connect again and allow it.")}`);
    }
    const me = await driveAccount(t.accessToken).catch(() => ({ name: null, email: null }));
    await saveDriveConnection({ refreshToken: t.refreshToken, name: me.name, email: me.email, connectedBy: admin });
    console.info(`[drive] callback: connected by ${admin}`);
    await logActivity({ actorEmail: admin, action: "drive.connected", meta: { name: me.name, email: me.email, root: driveRootName() } });
    return back("saved=drive");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[drive] connect failed:", msg);
    return back(`error=${enc(msg.slice(0, 160))}`);
  }
}
