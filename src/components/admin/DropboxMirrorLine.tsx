// "Dropbox: 12 of 14 files copied" with the listing's folder (Oct 21 2026),
// on the admin shoot page and the creative specialist's read-only view.
// Server-safe: no hooks. `children` is the admin's "Copy to Dropbox again".
import { fmtWhen } from "@/lib/shoot-status";

export type MirrorState = "on" | "elsewhere" | "off";

export default function DropboxMirrorLine({
  mirror,
  state,
  folder,
  syncedAt,
  admin,
  children,
}: {
  mirror: { total: number; synced: number; photos: number; video: number };
  state: MirrorState;
  folder: string | null;
  syncedAt: string | null;
  admin: boolean;
  children?: React.ReactNode;
}) {
  if (state === "off") {
    return <span className="muted">Not set up.{admin ? " Add the Dropbox app in Vercel, then connect it on Settings." : ""}</span>;
  }
  const all = mirror.total > 0 && mirror.synced === mirror.total;
  const words = all ? `all ${mirror.total} file${mirror.total === 1 ? "" : "s"} copied` : `${mirror.synced} of ${mirror.total} file${mirror.total === 1 ? "" : "s"} copied`;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px" }}>
      <span>
        <span className={all ? "" : "muted"}>{words}</span>
        {all && syncedAt ? <span className="muted"> · {fmtWhen(syncedAt)}</span> : null}
        {!all && state === "elsewhere" ? <span className="muted"> · the copy runs on the live portal</span> : null}
      </span>
      {folder ? <span className="adm-mono muted" style={{ fontSize: 12 }}>{folder}/Raw</span> : <span className="muted" style={{ fontSize: 12.5 }}>folder is made on the first copy</span>}
      {children}
    </span>
  );
}
