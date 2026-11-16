// GET /api/studio/dropbox/callback?code&state  (admin session + the signed state)
// Dropbox sends the admin back here. The state must be the JWT Connect signed
// for this same admin (fresh, unexpired); then the code is swapped for a
// REFRESH token, the account's name and email are read for the card, and
// the connection is stored in the settings table. The token is never
// logged, returned or shown. Lands back on /admin/settings with a banner.
import { requireAdminApi } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { DropboxApi, canConnectDropboxHere, dropboxRoot, exchangeDropboxCode, hasDropboxApp, saveDropboxConnection, verifyDropboxState } from "@/lib/dropbox";
import { hasDb } from "@/db";
import { siteUrl } from "@/lib/brand";

export const dynamic = "force-dynamic";

const back = (q: string) => Response.redirect(new URL(`/admin/settings?${q}`, siteUrl()).toString(), 303);
const enc = (s: string) => encodeURIComponent(s);

export async function GET(request: Request) {
  const admin = await requireAdminApi();
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");
  // Every way back from Dropbox leaves one log line (Oct 27 2026: a reconnect
  // that never landed left no trace, so it could not be told apart from one
  // that was never tried). Never the code or the token.
  if (denied) {
    const detail = (url.searchParams.get("error_description") || "").replace(/\s+/g, " ").slice(0, 120);
    console.warn(`[dropbox] callback: Dropbox returned ${denied.slice(0, 60)}${detail ? `: ${detail}` : ""}`);
    return back(`error=${enc(`Dropbox did not connect (${denied === "access_denied" ? "access was declined" : `${denied.slice(0, 60)}${detail ? `: ${detail}` : ""}`}).`)}`);
  }
  if (!hasDb() || !hasDropboxApp() || !canConnectDropboxHere()) {
    console.warn("[dropbox] callback: cannot connect on this deployment");
    return back(`error=${enc("Dropbox cannot be connected from here. Connect from the live portal.")}`);
  }
  if (!code || !(await verifyDropboxState(state, admin))) {
    console.warn(`[dropbox] callback: ${code ? "stale or foreign state" : "no code"}`);
    return back(`error=${enc("That Dropbox sign-in link was stale or not yours. Press Connect again.")}`);
  }
  try {
    const t = await exchangeDropboxCode(code);
    // The account behind the token, for the settings card (name and email only).
    let name: string | null = null;
    let email: string | null = null;
    try {
      const me = await new DropboxApi({ fetch: (i, init) => fetch(i, init), token: async () => t.accessToken }).currentAccount();
      name = me.name;
      email = me.email;
    } catch (e) {
      console.warn("[dropbox] get_current_account failed:", e instanceof Error ? e.message : e);
    }
    await saveDropboxConnection({ refreshToken: t.refreshToken, accountId: t.accountId, name, email, connectedBy: admin });
    // An account name means a token for one account; none means the team token again.
    console.info(`[dropbox] callback: connected by ${admin} (${name ? "single account" : "no account name: likely the team token"})`);
    await logActivity({ actorEmail: admin, action: "dropbox.connected", meta: { name, email, root: dropboxRoot() } });
    return back("saved=dropbox");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dropbox] connect failed:", msg);
    return back(`error=${enc(msg.slice(0, 160))}`);
  }
}
