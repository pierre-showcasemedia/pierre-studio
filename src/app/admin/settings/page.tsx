// Settings (one portal, Oct 2026): who can open this admin, and what the
// portal holds. Environment admins are read only here; added ones can go.
// Roles (Oct 2026): every added person is an admin, a creative specialist
// (Oct 21 2026) or on the QA team, and an admin can change it here (never
// their own, never an environment admin).
import { ROLE_LABELS, STAFF_ROLES, type StaffRole } from "@/db/schema";
import { hasDb } from "@/db";
import { adminAdmins } from "@/lib/admin-crud";
import { fmtDay, fmtWhen } from "@/lib/shoot-status";
import { addAdmin, portalCounts, removeAdmin, setAdminRole } from "../crud-actions";
import { disconnectDropbox } from "../dropbox-actions";
import { saveSlackQcTags } from "../slack-actions";
import { saveTwilightPresetAction } from "../twilight-actions";
import { twilightPreset } from "@/lib/twilight-preset";
import { FINAL_REVIEW_DEFAULT, qcIds, qcTags } from "@/lib/slack-qc";
import { Empty, PageHead, SectionHead } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";
import { canConnectDropboxHere, dropboxConnection, dropboxMirrorEnabled, dropboxRedirectUri, dropboxRoot, hasDropboxApp } from "@/lib/dropbox";
import { currentEnv } from "@/lib/jobs-core";
import { brand } from "@/lib/brand";
import { mailDomain } from "@/lib/brand";

const COUNTS: [string, string][] = [
  ["clients", "Clients"],
  ["listings", "Listings"],
  ["media", "Media files"],
];

// The order the role select lists them: most access first.
const ROLE_ORDER: StaffRole[] = ["admin", "creative", "qa", "video"];
const ROLE_PILL: Record<StaffRole, React.CSSProperties> = {
  admin: { background: "rgba(26,127,75,.10)", color: "#1A7F4B" },
  creative: { background: "rgba(95,100,110,.12)", color: "#3F444D" },
  qa: { background: "rgba(0,102,214,.09)", color: "#0066D6" },
  video: { background: "rgba(91,63,181,.10)", color: "#5B3FB5" },
};

function RolePill({ role }: { role: StaffRole }) {
  return <span className="adm-pill" style={ROLE_PILL[role]}>{ROLE_LABELS[role]}</span>;
}

export default async function AdminSettings({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  const me = await requireAdmin();
  const sp = await searchParams;
  const [admins, counts, dropbox, qc, preset] = await Promise.all([adminAdmins(), portalCounts(), dropboxConnection().catch(() => null), qcTags(), twilightPreset()]);
  const mine = me.trim().toLowerCase();
  const hasCounts = COUNTS.some(([k]) => typeof counts[k] === "number");
  const n = (r: StaffRole) => admins.filter((a) => a.role === r).length;
  const demo = !hasDb();
  const dbxApp = hasDropboxApp();
  const dbxHere = canConnectDropboxHere();
  const dbxMirror = dropboxMirrorEnabled();
  const env = currentEnv();

  return (
    <section className="wrap adm-page">
      <PageHead title="Settings." lede="Who can open this admin, as what, and what the portal holds." />

      {sp.saved === "dropbox" && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Dropbox connected. Raw uploads now copy to {dropboxRoot()}.</p>}
      {sp.saved === "dropbox-off" && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Dropbox disconnected. Raw uploads wait until it is connected again.</p>}
      {sp.saved === "slack" && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Slack QC tags saved. The next photo or video request pings them.</p>}
      {sp.saved === "twilight" && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Twilight preset saved. Every virtual twilight runs {preset?.name ?? "it"} from now on, and any shoot that was waiting for it starts its twilight frames.</p>}
      {sp.saved && sp.saved !== "dropbox" && sp.saved !== "dropbox-off" && sp.saved !== "slack" && sp.saved !== "twilight" && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Saved.</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}

      <div className="adm-section" id="dropbox">
        <SectionHead title="Dropbox" />
        <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 14 }}>
          Every booked shoot gets a folder in the business&apos;s Dropbox, <span className="adm-mono">{dropboxRoot()}/&lt;listing address&gt;</span>. The first upload adds <span className="adm-mono">Photo</span> and <span className="adm-mono">Video</span> inside it, and every raw file is copied into the right one. The Video card links the editors to the Video folder. Connect once, as the account that owns that folder.
        </p>
        <div className="adm-card adm-card--lg" style={{ maxWidth: 1040, display: "grid", gap: 14 }}>
          {demo ? (
            <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Demo mode: Dropbox connects once the database is set.</p>
          ) : !dbxApp ? (
            <>
              <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                <span className="adm-pill" style={{ background: "rgba(95,100,110,.12)", color: "#3F444D" }}>Not set up</span>
                <span style={{ fontSize: 14 }}>The Dropbox app is not configured on this deployment.</span>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                In Vercel, set <span className="adm-mono">NEXT_PUBLIC_DROPBOX_APP_KEY</span> and <span className="adm-mono">DROPBOX_APP_SECRET</span> (the same Dropbox app the Chooser uses), redeploy, then come back here and press Connect. In the Dropbox App Console the redirect URI must be <span className="adm-mono">{dropboxRedirectUri()}</span> and the permissions files.metadata.read, files.metadata.write, files.content.read, files.content.write and account_info.read must be on (plus sharing.read and sharing.write for the editors&rsquo; Video folder link).
              </p>
            </>
          ) : dropbox?.connected ? (
            <>
              <div className="flex flex-wrap items-center justify-between" style={{ gap: 12 }}>
                <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                  <span className="adm-pill" style={{ background: "rgba(26,127,75,.10)", color: "#1A7F4B" }}>Connected</span>
                  <span style={{ fontSize: 14 }}>
                    <span style={{ fontWeight: 500 }}>{dropbox.name ?? "Dropbox account"}</span>
                    {dropbox.email ? <span className="muted"> · {dropbox.email}</span> : null}
                  </span>
                </div>
                <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
                  {/* Reconnect replaces the saved connection in one go (the callback overwrites it), so a broken connection needs no Disconnect first. */}
                  {dbxHere && (
                    <a href="/api/studio/dropbox/connect" className={dropbox.error ? "btn btn-primary" : "adm-chip adm-chip--quiet"} title="Approve the app on Dropbox again. The new connection replaces this one.">
                      {dropbox.error ? "Reconnect Dropbox →" : "Reconnect"}
                    </a>
                  )}
                  <form action={disconnectDropbox}>
                    <button type="submit" className="adm-chip adm-chip--quiet" title="Forgets the saved connection. Files already copied stay in Dropbox; new uploads wait until it is connected again.">Disconnect</button>
                  </form>
                </div>
              </div>
              <dl className="adm-kv" style={{ margin: 0 }}>
                <div><dt>Folder</dt><dd className="adm-mono">{dropboxRoot()}</dd></div>
                <div><dt>Connected</dt><dd className="adm-mono muted">{fmtWhen(dropbox.connectedAt)}{dropbox.connectedBy ? ` · ${dropbox.connectedBy}` : ""}</dd></div>
                <div><dt>Mirror here</dt><dd>{dbxMirror ? "On: raw uploads on this deployment are copied." : `Off on ${env}: the copy runs on production only.`}</dd></div>
              </dl>
              {dropbox.error && <p className="adm-banner adm-banner--warn" style={{ margin: 0 }}>{dropbox.error}</p>}
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between" style={{ gap: 12 }}>
                <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                  <span className="adm-pill" style={{ background: "rgba(154,100,0,.10)", color: "#9A6400" }}>Not connected</span>
                  <span style={{ fontSize: 14 }}>Raw uploads are queued for Dropbox and wait here until it is connected.</span>
                </div>
                {dbxHere ? (
                  <a href="/api/studio/dropbox/connect" className="btn btn-primary">Connect Dropbox →</a>
                ) : (
                  <span className="adm-chip adm-chip--quiet" aria-disabled="true" title="The callback must come back to the live portal.">Connect from the live portal</span>
                )}
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                {dbxHere
                  ? `Connect sends you to Dropbox to approve the app once, as the ${brand.shortName} account that owns the Listings folder. Only the refresh token is kept, in the database; it is never shown.`
                  : `This is a ${env} deployment. Dropbox sends the approval back to ${dropboxRedirectUri()}, so connect from the live portal; the mirror runs there only.`}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="adm-section" id="twilight">
        <SectionHead title="Virtual twilight" />
        <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 14, maxWidth: 760, lineHeight: 1.6 }}>
          Every virtual twilight runs one preset from the {brand.shortName} AutoHDR account on the chosen daytime exteriors, on top of their Aura edit. A private preset has no share link: signed in to AutoHDR as the {brand.shortName} account, pick Champagne in the editor, copy the whole address from the browser bar (it ends in ?preset=…) and paste it here. A shoot that asks for twilight waits until this is set.
        </p>
        <form action={saveTwilightPresetAction} className="adm-card adm-card--lg" style={{ display: "grid", gap: 12, maxWidth: 1040 }}>
          {preset ? (
            <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
              <span className="adm-pill" style={{ background: "rgba(26,127,75,.10)", color: "#1A7F4B" }}>Set</span>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{preset.name}</span>
              <span className="muted" style={{ fontSize: 13 }}>{preset.creditCost != null ? `${preset.creditCost} credits a photo · ` : ""}saved {fmtWhen(preset.savedAt)}{preset.savedBy ? ` · ${preset.savedBy}` : ""}</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
              <span className="adm-pill" style={{ background: "rgba(154,100,0,.10)", color: "#9A6400" }}>Not set</span>
              <span style={{ fontSize: 14 }}>No twilight frames are made until the Champagne preset is saved here.</span>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto]" style={{ gap: 12, alignItems: "end" }}>
            <div className="field">
              <label htmlFor="tw-preset">Champagne preset address or ID</label>
              <input id="tw-preset" name="preset" defaultValue={preset?.uuid ?? ""} placeholder="https://new.autohdr.com/edit?preset=…" autoComplete="off" spellCheck={false} />
            </div>
            <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>{preset ? "Save preset →" : "Set preset →"}</button>
          </div>
        </form>
      </div>

      <div className="adm-section" id="slack">
        <SectionHead title="Slack QC tags" />
        <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 14, maxWidth: 760, lineHeight: 1.6 }}>
          Who the hub pings the moment a request comes in. Photo QC: every photo revision and every gallery ready for review. Video QC: every video revision and every cut moved to In review. Final review: everyone who does the final pass when an editor sends corrected photos (left empty, it tags nobody). Paste the Slack user group&rsquo;s ID (in Slack: the group&rsquo;s page, the three dots, Copy group ID; it starts with S), or on a plan without groups, member IDs (a profile, the three dots, Copy member ID; they start with U), separated by spaces.
        </p>
        <form action={saveSlackQcTags} className="adm-card adm-card--lg grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 12, maxWidth: 1240, alignItems: "end" }}>
          <div className="field">
            <label htmlFor="qc-photo">Photo QC</label>
            <input id="qc-photo" name="photo" defaultValue={qc.photo} placeholder="S0123ABCD" autoComplete="off" spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="qc-video">Video QC</label>
            <input id="qc-video" name="video" defaultValue={qc.video} placeholder="S0456EFGH" autoComplete="off" spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="qc-final">Final review</label>
            <input id="qc-final" name="final" defaultValue={qc.final === FINAL_REVIEW_DEFAULT ? "" : qc.final} placeholder={FINAL_REVIEW_DEFAULT} autoComplete="off" spellCheck={false} />
          </div>
          <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Save tags →</button>
        </form>
        <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>
          {`Now tagging: photo ${qc.photo ? qcIds(qc.photo).length : 0}, video ${qc.video ? qcIds(qc.video).length : 0}, final review ${qcIds(qc.final).length}.`}{!qc.photo && !qc.video ? " Photo and video QC lines post without a ping until their IDs are set." : ""}
        </p>
      </div>

      <div className="adm-section">
        <SectionHead title={`Team · ${admins.length}`} />
        <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 14 }}>
          {STAFF_ROLES.map((r) => `${n(r)} ${r === "qa" ? "photo QC" : `${ROLE_LABELS[r].toLowerCase()}${n(r) === 1 ? "" : "s"}`}`).join(" · ")}
        </p>
        {admins.length === 0 ? (
          <Empty>No admins are set. Add ADMIN_EMAILS in Vercel to get started.</Empty>
        ) : (
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table">
                <thead>
                  <tr><th>Email</th><th>Name</th><th>Role</th><th>Source</th><th>Added by</th><th>Added</th><th></th></tr>
                </thead>
                <tbody>
                  {admins.map((a) => {
                    const self = a.email.toLowerCase() === mine;
                    return (
                      <tr key={a.email}>
                        <td><span style={{ fontWeight: 500 }}>{a.email}</span>{self && <span className="muted" style={{ fontSize: 12.5 }}> · you</span>}</td>
                        <td className="muted">{a.name ?? ""}</td>
                        <td>
                          {a.source === "db" && !self ? (
                            <form action={setAdminRole.bind(null, a.email)} className="flex items-center" style={{ gap: 6 }}>
                              <div className="field" style={{ margin: 0 }}>
                                <select name="role" defaultValue={a.role} aria-label={`Role for ${a.email}`} style={{ padding: "6px 34px 6px 12px", fontSize: 13, minHeight: 0 }}>
                                  {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                                </select>
                              </div>
                              <button type="submit" className="adm-chip adm-chip--quiet">Save</button>
                            </form>
                          ) : (
                            <RolePill role={a.role} />
                          )}
                        </td>
                        <td className="muted">{a.source === "env" ? "Environment" : "Added here"}</td>
                        <td className="muted">{a.addedBy ?? ""}</td>
                        <td className="adm-mono muted">{a.createdAt ? fmtDay(a.createdAt) : ""}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {a.source === "db" && !self && (
                            <form action={removeAdmin.bind(null, a.email)} style={{ display: "inline" }}>
                              <button type="submit" className="adm-chip adm-chip--quiet" title={`${a.email} can no longer open the admin. Their portal sign-in is not affected.`}>Remove</button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>Environment admins come from ADMIN_EMAILS and are managed in Vercel. They are always full admins. Nobody changes their own role; every change is logged.</p>
      </div>

      <div className="adm-section">
        <div className="kicker" style={{ marginBottom: 14 }}>Add someone</div>
        <form action={addAdmin} className="adm-card adm-card--lg grid grid-cols-1 sm:grid-cols-4" style={{ gap: 12, maxWidth: 1040, alignItems: "end" }}>
          <div className="field"><label htmlFor="a-email">Email</label><input id="a-email" name="email" type="email" required placeholder={`name@${mailDomain()}`} /></div>
          <div className="field"><label htmlFor="a-name">Name, optional</label><input id="a-name" name="name" placeholder="First Last" /></div>
          <div className="field">
            <label htmlFor="a-role">Role</label>
            <select id="a-role" name="role" defaultValue="qa">
              <option value="qa">{ROLE_LABELS.qa}</option>
              <option value="creative">{ROLE_LABELS.creative}</option>
              <option value="video">{ROLE_LABELS.video}</option>
              <option value="admin">{ROLE_LABELS.admin}</option>
            </select>
          </div>
          <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Add →</button>
        </form>
        <dl className="adm-kv adm-card" style={{ marginTop: 12, maxWidth: 1040, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div><dt>Admin</dt><dd style={{ fontSize: 13.5, lineHeight: 1.6 }}>Everything: bookings and payments, clients and teams, listings, shoots, delivery emails, reports, settings and view as.</dd></div>
          <div><dt>Creative specialist</dt><dd style={{ fontSize: 13.5, lineHeight: 1.6 }}>The shooter. Upload a shoot only: pick the listing, add the files, choose the look, submit, and watch that upload go through. Nothing else in the admin. Listed first when a booking gets its shooter.</dd></div>
          <div><dt>Photo QC</dt><dd style={{ fontSize: 13.5, lineHeight: 1.6 }}>Two tabs: Photo QC (every shoot from editing to published; open one to check the frames with the automatic QC, approve or reject, publish) and Revisions (photo requests only). From there the shoot and listing pages: every frame (internal ones too), downloads for editing, corrected uploads, Client visible or Internal only. No money, client details, settings, view as, deletes or delivery emails.</dd></div>
          <div><dt>Video editor</dt><dd style={{ fontSize: 13.5, lineHeight: 1.6 }}>The Video board only: every shoot with video as a card, the video side of the booking (speed, music, notes), the client&rsquo;s video history, the Dropbox Video folder, video revisions with their timestamps, and uploading a cut as internal only. No photos, money, clients or anything else.</dd></div>
        </dl>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>They sign in with the same magic link as everyone else, at the portal login, and land in the admin. Adding someone already on the list changes their role.</p>
      </div>

      <div className="adm-section">
        <SectionHead title="This portal" />
        {hasCounts ? (
          <dl className="adm-kv adm-card" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", maxWidth: 560 }}>
            {COUNTS.map(([k, label]) => (
              <div key={k}><dt>{label}</dt><dd className="adm-mono">{(counts[k] ?? 0).toLocaleString("en-US")}</dd></div>
            ))}
          </dl>
        ) : (
          <Empty>Demo mode: counts appear once the database is connected.</Empty>
        )}
      </div>
    </section>
  );
}
