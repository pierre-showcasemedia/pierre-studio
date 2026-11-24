// The Google Drive card on /admin/settings (Nov 18 2026), the Dropbox card's
// twin: not set up (the env names to add), not connected (Connect), or
// connected (the account, the Listings folder, Reconnect and Disconnect).
// Never shows a token: driveConnection() has none to give.
import { SectionHead } from "@/components/admin/bits";
import { disconnectDrive } from "@/app/admin/drive-actions";
import { canConnectDriveHere, driveConnection, driveFolderUrl, driveMirrorEnabled, drivePickerConfig, driveRedirectUri, driveRootName, hasDriveApp } from "@/lib/google-drive";
import { hasDb } from "@/db";
import { currentEnv } from "@/lib/jobs-core";
import { fmtWhen } from "@/lib/shoot-status";
import { brand } from "@/lib/brand";

const PILL = {
  ok: { background: "rgba(26,127,75,.10)", color: "#1A7F4B" },
  wait: { background: "rgba(154,100,0,.10)", color: "#9A6400" },
  off: { background: "rgba(95,100,110,.12)", color: "#3F444D" },
};

export async function DriveSettingsCard() {
  const demo = !hasDb();
  const app = hasDriveApp();
  const here = canConnectDriveHere();
  const mirror = driveMirrorEnabled();
  const picker = Boolean(drivePickerConfig());
  const env = currentEnv();
  const conn = demo || !app ? null : await driveConnection().catch(() => null);
  const root = driveRootName();

  return (
    <div className="adm-section" id="google-drive">
      <SectionHead title="Google Drive" />
      <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 14, maxWidth: 820, lineHeight: 1.6 }}>
        Every upload is copied into the business&apos;s Google Drive, <span className="adm-mono">{root}/&lt;listing address&gt;</span>, with raw photos in <span className="adm-mono">Photo</span> and raw video in <span className="adm-mono">Video</span>. What a client is delivered goes into <span className="adm-mono">FINAL DELIVERY</span> in the same folder. Clients can save their photos to their own Drive from the gallery, and the team can import from Drive on the upload page. Connect once, as the Google account whose Drive should hold the files.
      </p>
      <div className="adm-card adm-card--lg" style={{ maxWidth: 1040, display: "grid", gap: 14 }}>
        {demo ? (
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Demo mode: Google Drive connects once the database is set.</p>
        ) : !app ? (
          <>
            <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
              <span className="adm-pill" style={PILL.off}>Not set up</span>
              <span style={{ fontSize: 14 }}>Google Drive is not configured on this deployment.</span>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
              In the business&apos;s Google Cloud project, turn on the Google Drive API and the Google Picker API, publish the consent screen with the <span className="adm-mono">drive.file</span> scope, and make an OAuth client (Web application) with the redirect URI <span className="adm-mono">{driveRedirectUri()}</span>. In Vercel set <span className="adm-mono">NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID</span> and <span className="adm-mono">GOOGLE_DRIVE_CLIENT_SECRET</span> (plus <span className="adm-mono">NEXT_PUBLIC_GOOGLE_PICKER_API_KEY</span> and <span className="adm-mono">NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER</span> for importing from Drive), redeploy, then press Connect here.
            </p>
          </>
        ) : conn?.connected ? (
          <>
            <div className="flex flex-wrap items-center justify-between" style={{ gap: 12 }}>
              <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                <span className="adm-pill" style={PILL.ok}>Connected</span>
                <span style={{ fontSize: 14 }}>
                  <span style={{ fontWeight: 500 }}>{conn.name ?? "Google account"}</span>
                  {conn.email ? <span className="muted"> · {conn.email}</span> : null}
                </span>
              </div>
              <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
                {here && (
                  <a href="/api/studio/drive/connect" className={conn.error ? "btn btn-primary" : "adm-chip adm-chip--quiet"} title="Allow access on Google again. The new connection replaces this one.">
                    {conn.error ? "Reconnect Google Drive →" : "Reconnect"}
                  </a>
                )}
                <form action={disconnectDrive}>
                  <button type="submit" className="adm-chip adm-chip--quiet" title="Forgets the saved connection. Files already copied stay in Drive; new uploads wait until it is connected again.">Disconnect</button>
                </form>
              </div>
            </div>
            <dl className="adm-kv" style={{ margin: 0 }}>
              <div><dt>Folder</dt><dd>{conn.rootId ? <a className="adm-mono" href={driveFolderUrl(conn.rootId)} target="_blank" rel="noreferrer">{root} ↗</a> : <span className="adm-mono">{root}</span>}{conn.rootId ? null : <span className="muted"> (made with the first copy)</span>}</dd></div>
              <div><dt>Connected</dt><dd className="adm-mono muted">{fmtWhen(conn.connectedAt)}{conn.connectedBy ? ` · ${conn.connectedBy}` : ""}</dd></div>
              <div><dt>Copy here</dt><dd>{mirror ? "On: uploads and deliveries on this deployment are copied." : `Off on ${env}: the copy runs on production only.`}</dd></div>
              <div><dt>Import from Drive</dt><dd>{picker ? "On the upload page." : "Add the Picker key and project number in Vercel to import from Drive."}</dd></div>
            </dl>
            {conn.error && <p className="adm-banner adm-banner--warn" style={{ margin: 0 }}>{conn.error}</p>}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between" style={{ gap: 12 }}>
              <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                <span className="adm-pill" style={PILL.wait}>Not connected</span>
                <span style={{ fontSize: 14 }}>Uploads are queued for Google Drive and wait here until it is connected.</span>
              </div>
              {here ? (
                <a href="/api/studio/drive/connect" className="btn btn-primary">Connect Google Drive →</a>
              ) : (
                <span className="adm-chip adm-chip--quiet" aria-disabled="true" title="Google must send you back to the live portal.">Connect from the live portal</span>
              )}
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
              {here
                ? `Connect sends you to Google to allow access once, as the ${brand.shortName} account whose Drive should hold the files. The studio only sees the folders and files it makes there. Only the refresh token is kept, in the database; it is never shown.`
                : `This is a ${env} deployment. Google sends the approval back to ${driveRedirectUri()}, so connect from the live portal; the copy runs there only.`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
