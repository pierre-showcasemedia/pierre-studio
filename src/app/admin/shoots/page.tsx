import Link from "next/link";
import type { ShootStatus } from "@/db/schema";
import { adminShoots } from "@/lib/admin-data";
import { ACTIVE_STATUSES, estimateCredits, fmtWhen, photoFileCount } from "@/lib/shoot-status";
import { Empty, PageHead, ShootPill } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";

const FILTERS: { k: string; l: string; statuses?: ShootStatus[] }[] = [
  { k: "open", l: "Open", statuses: [...ACTIVE_STATUSES, "ready_for_review", "failed"] },
  { k: "active", l: "In editing", statuses: ACTIVE_STATUSES },
  { k: "ready_for_review", l: "Ready for review", statuses: ["ready_for_review"] },
  { k: "failed", l: "Stopped", statuses: ["failed"] },
  { k: "published", l: "Published", statuses: ["published"] },
  { k: "video_only", l: "Video only", statuses: ["video_only"] },
  { k: "all", l: "All" },
];

export default async function ShootsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  // Admins and the QA team (no upload button and no credits for the QA team).
  // Admins only since Oct 26 2026: the Photo QC team works from the Photo QC
  // board (the QA branches below stay for when that changes again).
  await requireAdmin();
  const admin: boolean = true;
  const { status } = await searchParams;
  const f = FILTERS.find((x) => x.k === status) ?? FILTERS[0];
  const shoots = (await adminShoots({ statuses: f.statuses })).filter((s) => s.status !== "draft");
  return (
    <section className="wrap adm-page">
      <PageHead eyebrow={admin ? "Admin" : "Photo QC"} title="Shoots." lede="Every upload run, from the card to the gallery.">
        {admin && <Link href="/admin/upload" className="btn btn-primary">Upload a shoot →</Link>}
      </PageHead>
      <div className="adm-seg" role="tablist" style={{ marginTop: 24, flexWrap: "wrap" }}>
        {FILTERS.map((x) => (
          <Link key={x.k} href={`/admin/shoots?status=${x.k}`} className={f.k === x.k ? "is-active" : ""} role="tab" aria-selected={f.k === x.k}>{x.l}</Link>
        ))}
      </div>
      {shoots.length === 0 ? (
        <Empty>No shoots here.</Empty>
      ) : (
        <div className="adm-table-wrap" style={{ marginTop: 18 }}>
          <div className="adm-table-scroll">
            <table className="adm-table">
              <thead><tr><th>Listing</th><th>Status</th><th>Files</th><th>Frames</th>{admin && <th>Credits</th>}<th>Updated</th><th></th></tr></thead>
              <tbody>
                {shoots.map((s) => {
                  const c = estimateCredits(s.options, photoFileCount(s), s.photoCount);
                  return (
                    <tr key={s.id}>
                      <td><Link href={`/admin/shoots/${s.id}`} style={{ fontWeight: 500 }}>{s.address.split(",")[0]}</Link><div className="muted" style={{ fontSize: 12.5 }}>{s.clientName ?? s.clientEmail} · by {s.createdBy}</div></td>
                      <td><ShootPill s={s.status} /></td>
                      <td className="adm-mono">{s.fileCount}</td>
                      <td className="adm-mono">{s.photoCount || ""}</td>
                      {admin && <td className="adm-mono muted">{c.exact ? "" : "~"}{c.total}</td>}
                      <td className="adm-mono muted" style={{ whiteSpace: "nowrap" }}>{fmtWhen(s.updatedAt)}</td>
                      <td style={{ textAlign: "right" }}><Link href={`/admin/shoots/${s.id}`} className="adm-chip adm-chip--quiet">Open</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
