// GET /api/studio/drive/connect  (admin session)
// The Connect button on /admin/settings: sends the admin to Google's consent
// page asking for offline access (a refresh token) to the files this app
// makes (drive.file), with a signed state bound to their email. Only where
// Google can send them back (production, or GOOGLE_DRIVE_MIRROR=on).
import { requireAdminApi } from "@/lib/admin";
import { canConnectDriveHere, driveAuthorizeUrl, driveRedirectUri, hasDriveApp, signDriveState } from "@/lib/google-drive";
import { hasDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireAdminApi();
  if (admin instanceof Response) return admin;
  if (!hasDb()) return Response.json({ ok: false, demo: true, error: "Demo mode: Google Drive cannot be connected without a database." }, { status: 503 });
  if (!hasDriveApp()) return Response.json({ ok: false, error: "Set NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET in Vercel first." }, { status: 503 });
  if (!canConnectDriveHere()) return Response.json({ ok: false, error: "Previews cannot connect Google Drive. Connect from the live portal.", redirectUri: driveRedirectUri() }, { status: 503 });
  const state = await signDriveState(admin);
  console.info(`[drive] connect: sent ${admin} to Google`);
  return Response.redirect(driveAuthorizeUrl(state), 302);
}
