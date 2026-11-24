// The shoot page as a creative specialist sees it (Oct 21 2026): their own
// upload, read only. The status rail, the facts of the upload and the file
// list, so they can see it went through. No frames, no QC, no visibility, no
// downloads, no publish, no delivery email and no link to the listing (none of
// those are theirs). Refreshes itself for a while when the pipeline is working.
import Link from "next/link";
import AutoRefresh from "@/components/AutoRefresh";
import DropboxMirrorLine, { type MirrorState } from "@/components/admin/DropboxMirrorLine";
import { ShootPill } from "@/components/admin/bits";
import type { AdminShoot, AdminShootFile } from "@/lib/admin-types";
import { FALLBACK_LOOKS } from "@/lib/autohdr";
import { twilightLookName } from "@/lib/twilight-preset";
import { STEP_BLURBS, fmtBytes, fmtWhen, isActive, railFor } from "@/lib/shoot-status";

export default function CreativeShootView({ shoot, files, mirror, mirrorState, service = "Dropbox", folderUrl = null }: { shoot: AdminShoot; files: AdminShootFile[]; mirror: { total: number; synced: number; photos: number; video: number }; mirrorState: MirrorState; service?: "Dropbox" | "Google Drive"; folderUrl?: string | null }) {
  const o = shoot.options;
  const rail = railFor(shoot.status, (shoot.progress?.failedFrom as string | undefined) ?? null, Boolean(o?.twilight?.enabled));
  const look = twilightLookName(o?.twilight?.look, FALLBACK_LOOKS);
  const name = shoot.address.split(",")[0];
  const active = isActive(shoot.status);
  const videoOnly = shoot.status === "video_only";
  const done = shoot.status === "ready_for_review" || shoot.status === "published";
  // The Dropbox copy runs in the background: keep refreshing while it does.
  const copying = mirrorState === "on" && mirror.total > 0 && mirror.synced < mirror.total;
  return (
    <section className="wrap adm-page">
      {(active || copying) && <AutoRefresh ms={15_000} times={20} />}
      <Link href="/admin/upload" className="adm-link muted" style={{ fontSize: 12.5 }}>← Upload a shoot</Link>
      <div className="adm-head" style={{ marginTop: 14 }}>
        <div>
          <div className="flex flex-wrap items-center" style={{ gap: 10, marginBottom: 10 }}>
            <span className="kicker" style={{ margin: 0 }}>Your upload</span>
            <ShootPill s={shoot.status} />
            {shoot.nda && <span className="adm-pill" style={{ background: "rgba(11,12,15,.08)" }}>NDA</span>}
          </div>
          <h1 className="adm-title">{name}</h1>
          <p className="adm-lede">Uploaded by you · {fmtWhen(shoot.submittedAt ?? shoot.createdAt)}</p>
        </div>
        <div className="adm-actions">
          <Link href="/admin/upload" className="btn btn-primary">Upload another →</Link>
        </div>
      </div>

      {shoot.status === "uploaded" && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Your upload went through. Editing starts from here; the team takes it the rest of the way.</p>}
      {active && shoot.status !== "uploaded" && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>Your upload went through and is in editing. This page refreshes on its own for a while.</p>}
      {videoOnly && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Your upload went through. Video only: the clips are copied to {service} and nothing goes to editing.</p>}
      {done && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Editing finished. The team reviews the frames and delivers the gallery from here.</p>}
      {shoot.status === "failed" && (
        <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>
          This shoot stopped at &ldquo;{String(shoot.progress?.failedFrom ?? "")}&rdquo;. Your files are safe; tell an admin and they can retry it.{shoot.error ? ` ${shoot.error}` : ""}
        </p>
      )}

      <div className="adm-card adm-card--lg" style={{ marginTop: 24 }}>
        <div className="adm-rail">
          {rail.map((s) => (
            <div key={s.key} className={`adm-rail__step is-${s.state}`}>
              <div className="adm-rail__track" />
              <div className="adm-rail__name">{s.label}</div>
            </div>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 14, marginBottom: 0 }}>{STEP_BLURBS[shoot.status]}</p>
      </div>

      <dl className="adm-kv adm-card" style={{ marginTop: 14 }}>
        {!videoOnly && <div><dt>Model</dt><dd>{o?.nda ? "Aura (NDA)" : o?.modelName ?? "Aura"}{o?.skipHdr ? " · finished JPGs" : ""}</dd></div>}
        {!videoOnly && <div><dt>Twilight</dt><dd>{o?.twilight?.enabled ? `${o.twilight.count} frames · ${look}` : "Off"}</dd></div>}
        <div><dt>Files</dt><dd className="adm-mono">{mirror.video ? `${mirror.photos} photo${mirror.photos === 1 ? "" : "s"} · ${mirror.video} clip${mirror.video === 1 ? "" : "s"}` : `${shoot.fileCount} uploaded`}</dd></div>
        {!videoOnly && <div><dt>Frames</dt><dd className="adm-mono">{shoot.photoCount || "pending"}</dd></div>}
        <div><dt>Timing</dt><dd className="adm-mono" style={{ fontSize: 12 }}>submitted {fmtWhen(shoot.submittedAt) || "no"}{shoot.readyAt ? ` · ready ${fmtWhen(shoot.readyAt)}` : ""}{shoot.publishedAt ? ` · published ${fmtWhen(shoot.publishedAt)}` : ""}</dd></div>
        <div style={{ gridColumn: "1 / -1" }}><dt>{service}</dt><dd><DropboxMirrorLine mirror={mirror} state={mirrorState} folder={shoot.dropboxFolder} syncedAt={service === "Google Drive" ? shoot.driveSyncedAt ?? null : shoot.dropboxSyncedAt} admin={false} service={service} folderNode={service === "Google Drive" ? (folderUrl ? <a className="adm-link" style={{ fontSize: 12.5 }} href={folderUrl} target="_blank" rel="noreferrer">Open the folder in Drive ↗</a> : <span className="muted" style={{ fontSize: 12.5 }}>folder is made on the first copy</span>) : undefined} /></dd></div>
        {o?.notes && <div style={{ gridColumn: "1 / -1" }}><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{o.notes}</dd></div>}
      </dl>

      <details className="adm-section" style={{ marginTop: 32 }}>
        <summary className="kicker" style={{ cursor: "pointer" }}>Uploaded files · {files.length}{shoot.fileCount > files.length ? ` of ${shoot.fileCount} shown` : ""}</summary>
        <div className="adm-table-wrap" style={{ marginTop: 12 }}>
          <div className="adm-table-scroll">
            <table className="adm-table">
              <tbody>
                {files.map((f) => (
                  <tr key={f.id}>
                    <td className="adm-mono">{f.filename}</td>
                    <td className="adm-mono muted">{fmtBytes(f.bytes)}</td>
                    <td className="muted">{f.kind === "raw_video" ? "raw video" : f.kind}</td>
                    <td className="muted">{f.kind === "raw_video" ? "not for editing" : f.uploaded ? "sent to editing" : "in storage"}</td>
                    <td className="muted" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{(service === "Google Drive" ? f.driveSyncedAt : f.dropboxSyncedAt) ? `in ${service}` : mirrorState === "off" ? "" : `not in ${service} yet`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </section>
  );
}
