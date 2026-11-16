// Merge this shoot into another shoot of the same listing (Nov 5 2026;
// src/lib/merge-shoot.ts). Step 1: pick the shoot to keep (only the other
// shoots of this listing are offered; the one holding the most client
// visible photos is marked Suggested). Step 2: the dry run, read from the
// database as it is now: per shoot how many frames stay, how many are
// deleted and what moves, the kept and deleted filenames, any client revision
// note on a frame that would go, and what a person should know. Nothing
// changes until Merge is pressed on THIS page with MERGE typed. Admins only.
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { listingShootsForMerge, mergeShoot, type MergeShootSide, type ShootCounts } from "@/lib/merge-shoot";
import { fmtWhen } from "@/lib/shoot-status";
import { ShootPill } from "@/components/admin/bits";
import { VISIBILITY_LABEL } from "@/lib/visibility";
import { mergeShootInto } from "../../../merge-shoot-actions";

export const dynamic = "force-dynamic";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function SideCard({ kicker, s, tone }: { kicker: string; s: MergeShootSide; tone?: "from" | "into" }) {
  return (
    <div className="adm-card" style={{ borderRadius: 14, display: "grid", gap: 6, alignContent: "start", ...(tone === "from" ? { borderColor: "rgba(215,52,42,.35)" } : {}) }}>
      <div className="kicker">{kicker}</div>
      <div style={{ fontSize: 17, fontWeight: 600 }}>{cap(s.label)}</div>
      <div className="flex flex-wrap items-center" style={{ gap: 8, fontSize: 13.5 }}>
        <ShootPill s={s.status} /> <span className="adm-mono">{s.frames} frames · {s.clientVisible} client visible · {s.fileCount} files</span>
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>
        by {s.createdBy}{s.publishedAt ? ` · published ${fmtWhen(s.publishedAt)}` : " · never published"}
      </div>
      <Link href={`/admin/shoots/${s.id}`} className="adm-link" style={{ fontSize: 12.5 }}>Open this shoot →</Link>
    </div>
  );
}

const COUNT_ROWS: { k: keyof ShootCounts; label: string }[] = [
  { k: "frames", label: "Frames now" },
  { k: "kept", label: "Kept (client visible)" },
  { k: "deleted", label: "Deleted (internal only)" },
  { k: "files", label: "Uploaded files" },
  { k: "videoCards", label: "Video board cards" },
  { k: "activity", label: "Activity rows" },
  { k: "jobs", label: "Jobs naming the shoot" },
];

export default async function MergeShootPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ into?: string; error?: string }> }) {
  // The gate, here and not only in the layout (see the listing merge page).
  await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!hasDb()) {
    return (
      <section className="wrap adm-page">
        <Link href={`/admin/shoots/${id}`} className="adm-link muted" style={{ fontSize: 12.5 }}>← Back to the shoot</Link>
        <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>Demo mode: merging shoots needs the database, and nothing is saved.</p>
      </section>
    );
  }
  const self = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, id), columns: { id: true, listingId: true }, with: { listing: { columns: { address: true } } } });
  if (!self) notFound();
  const street = self.listing.address.split(",")[0];
  const shoots = await listingShootsForMerge(self.listingId);
  const me = shoots.find((s) => s.id === id);
  const others = shoots.filter((s) => s.id !== id);
  const into = sp.into && sp.into !== id && others.some((s) => s.id === sp.into) ? sp.into : "";
  const plan = into ? await mergeShoot({ fromShootId: id, intoShootId: into, apply: false }) : null;
  // Refusals a person can lift here: only the revision notes (the checkbox).
  const hardRefusals = plan ? plan.refused.filter((r) => !/revision notes? (is|are) on photos/.test(r)) : [];

  return (
    <section className="wrap adm-page">
      <Link href={`/admin/shoots/${id}`} className="adm-link muted" style={{ fontSize: 12.5 }}>← Back to the shoot (nothing has changed)</Link>
      <div className="adm-head" style={{ marginTop: 14 }}>
        <div>
          <div className="kicker" style={{ marginBottom: 10 }}>Merge shoot · {street}</div>
          <h1 className="adm-title">Merge {me?.label ?? "this shoot"} into another shoot</h1>
          <p className="adm-lede">
            For a listing with two shoots that should be one. The photos the client sees now, on either shoot, stay on the shoot you keep, all approved and client visible. Every other frame of both shoots is deleted (the files stay in storage), and this shoot is deleted. The client&apos;s gallery does not change.
          </p>
        </div>
      </div>

      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}

      {others.length === 0 ? (
        <p className="adm-banner adm-banner--info" style={{ marginTop: 22 }}>{street} has no other shoot, so there is nothing to merge into.</p>
      ) : (
        <form method="get" className="adm-card" style={{ marginTop: 22, borderRadius: 14, display: "grid", gap: 10, maxWidth: 640 }}>
          <div className="kicker">Shoot to keep</div>
          {others.map((s) => (
            <label key={s.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14 }}>
              <input type="radio" name="into" value={s.id} defaultChecked={into ? into === s.id : s.suggested} required style={{ marginTop: 4 }} />
              <span>
                {cap(s.label)} · <span className="adm-mono">{s.clientVisible} client visible of {s.frames}</span> · {s.status.replace(/_/g, " ")}
                {s.suggested && <span className="adm-pill" style={{ marginLeft: 8 }}>Suggested</span>}
              </span>
            </label>
          ))}
          {me?.suggested && (
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              This shoot holds the most client visible photos, so it is the better one to keep:{" "}
              {others.map((o, i) => (
                <span key={o.id}>{i ? ", " : ""}<Link href={`/admin/shoots/${o.id}/merge?into=${id}`} className="adm-link">merge {o.label} into this one</Link></span>
              ))}
              . Either way the gallery ends up the same; the kept shoot&apos;s photos keep their editing history.
            </p>
          )}
          <div className="adm-actions">
            <button type="submit" className="adm-chip">Show the preview</button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>The preview changes nothing.</p>
        </form>
      )}

      {plan && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 16, marginTop: 26 }}>
            {plan.from && <SideCard kicker="Merging (will be deleted)" s={plan.from} tone="from" />}
            {plan.into && <SideCard kicker="Into (kept)" s={plan.into} tone="into" />}
          </div>
          {hardRefusals.map((r) => (
            <p key={r} className="adm-banner adm-banner--bad" style={{ marginTop: 16 }}>{r}</p>
          ))}

          {plan.counts && (
            <div className="lsn-block" style={{ marginTop: 28 }}>
              <div className="adm-section-head"><div className="kicker">Preview · per shoot</div></div>
              <div className="adm-table-wrap">
                <div className="adm-table-scroll">
                  <table className="adm-table">
                    <thead>
                      <tr><th></th><th style={{ textAlign: "right" }}>Merged</th><th style={{ textAlign: "right" }}>Kept</th></tr>
                    </thead>
                    <tbody>
                      {COUNT_ROWS.map((r) => (
                        <tr key={r.k}>
                          <td>{r.label}</td>
                          <td className="adm-mono" style={{ textAlign: "right" }}>{plan.counts!.from[r.k]}</td>
                          <td className="adm-mono" style={{ textAlign: "right" }}>{plan.counts!.into[r.k]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="faint" style={{ margin: "10px 0 0", fontSize: 12 }}>Files, Video cards, activity and jobs of the merged shoot move to the kept shoot.</p>
            </div>
          )}

          {plan.revisionConflicts.length > 0 && (
            <div className="lsn-block" style={{ marginTop: 24 }}>
              <div className="adm-section-head"><div className="kicker">Client revision notes on frames that would be deleted · {plan.revisionConflicts.length}</div></div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>
                {plan.revisionConflicts.map((c) => (
                  <li key={c.itemId}><span className="adm-mono">{c.filename}</span> · request {c.status.replace("_", " ")} · {c.note.length > 140 ? `${c.note.slice(0, 140)}…` : c.note}</li>
                ))}
              </ul>
            </div>
          )}

          {plan.clashes.length > 0 && (
            <div className="lsn-block" style={{ marginTop: 24 }}>
              <div className="adm-section-head"><div className="kicker">Client visible on both shoots · {plan.clashes.length}</div></div>
              <p className="adm-mono" style={{ fontSize: 12.5, lineHeight: 1.7, margin: 0, wordBreak: "break-word" }}>{plan.clashes.join(", ")}</p>
            </div>
          )}

          <details className="lsn-block" style={{ marginTop: 24 }}>
            <summary className="kicker" style={{ cursor: "pointer" }}>Kept · {plan.kept.length} client visible</summary>
            <p className="adm-mono" style={{ fontSize: 12, lineHeight: 1.7, margin: "10px 0 0", wordBreak: "break-word" }}>
              {plan.kept.map((k) => `${k.filename}${k.section ? ` [${k.section}]` : ""}${k.revision ? " [revised]" : ""}${k.shootId === plan.from?.id ? " (moves)" : ""}`).join(", ") || "none"}
            </p>
          </details>
          <details className="lsn-block" style={{ marginTop: 16 }}>
            <summary className="kicker" style={{ cursor: "pointer" }}>Deleted · {plan.deleted.length} internal only</summary>
            <p className="adm-mono" style={{ fontSize: 12, lineHeight: 1.7, margin: "10px 0 0", wordBreak: "break-word" }}>
              {plan.deleted.map((x) => `${x.filename} (${VISIBILITY_LABEL[x.visibility].split(" ·")[0].toLowerCase()}${x.shootId === plan.from?.id ? ", merged shoot" : ""})`).join(", ") || "none"}
            </p>
          </details>

          {plan.notices.length > 0 && (
            <div className="lsn-block" style={{ marginTop: 24 }}>
              <div className="adm-section-head"><div className="kicker">Good to know</div></div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>
                {plan.notices.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </div>
          )}

          {plan.from && plan.into && hardRefusals.length === 0 && (
            <form action={mergeShootInto.bind(null, plan.from.id, plan.into.id)} className="adm-card" style={{ marginTop: 28, display: "grid", gap: 12, borderColor: "rgba(215,52,42,.35)", borderRadius: 14, maxWidth: 640 }}>
              <input type="hidden" name="expect" value={plan.fingerprint} />
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                Merge {plan.from.label} into {plan.into.label}: keep {plan.kept.length} client visible photos, delete {plan.deleted.length} internal only frames, and delete {plan.from.label}. This runs as one step and cannot be undone from here.
              </p>
              {plan.revisionConflicts.length > 0 && (
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13.5 }}>
                  <input type="checkbox" name="allowRevisionLoss" value="1" required style={{ marginTop: 3 }} />
                  <span>Delete them anyway. The {plan.revisionConflicts.length} revision notes stay on their requests without the photo.</span>
                </label>
              )}
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="merge-reason">Reason (for the activity log, optional)</label>
                <input id="merge-reason" name="reason" placeholder="Two shoot days, one gallery" autoComplete="off" style={{ padding: "10px 14px", fontSize: 14 }} />
              </div>
              <div className="adm-actions" style={{ alignItems: "center" }}>
                <div className="field" style={{ margin: 0, flex: "0 1 220px" }}>
                  <input name="confirm" placeholder="Type MERGE" required autoComplete="off" aria-label="Type MERGE to confirm" style={{ padding: "10px 14px", fontSize: 14 }} />
                </div>
                <button type="submit" className="adm-chip adm-chip--danger">Merge into {plan.into.label}</button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
