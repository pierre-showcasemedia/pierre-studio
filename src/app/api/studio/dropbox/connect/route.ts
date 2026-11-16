// GET /api/studio/dropbox/connect  (admin session)
// The Connect button on /admin/settings: sends the admin to Dropbox's OAuth
// page asking for offline access (a refresh token) with a signed state bound
// to their email. Only where the callback can come back (production, or a
// deployment running with DROPBOX_MIRROR=on and its own registered redirect
// URI); anywhere else it answers with the reason instead of a redirect.
import { requireAdminApi } from "@/lib/admin";
import { canConnectDropboxHere, dropboxAuthorizeUrl, dropboxRedirectUri, hasDropboxApp, signDropboxState } from "@/lib/dropbox";
import { hasDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireAdminApi();
  if (admin instanceof Response) return admin;
  if (!hasDb()) return Response.json({ ok: false, demo: true, error: "Demo mode: Dropbox cannot be connected without a database." }, { status: 503 });
  if (!hasDropboxApp()) return Response.json({ ok: false, error: "Set NEXT_PUBLIC_DROPBOX_APP_KEY and DROPBOX_APP_SECRET in Vercel first." }, { status: 503 });
  if (!canConnectDropboxHere()) return Response.json({ ok: false, error: "Previews cannot connect Dropbox. Connect from the live portal.", redirectUri: dropboxRedirectUri() }, { status: 503 });
  const state = await signDropboxState(admin);
  // With the callback's line, tells "pressed Connect, never came back" (an
  // error page on Dropbox's side) from "never pressed".
  console.info(`[dropbox] connect: sent ${admin} to Dropbox`);
  return Response.redirect(dropboxAuthorizeUrl(state), 302);
}
