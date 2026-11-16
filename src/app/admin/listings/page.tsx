import Link from "next/link";
import { adminClients, adminListings, listingStatusLabel } from "@/lib/admin-data";
import { qaListingStatus } from "@/lib/listing-status";
import type { ListingSort } from "@/lib/admin-types";
import { fmtDay } from "@/lib/shoot-status";
import { setLock } from "../actions";
import { enterViewAs } from "../../portal/view-as-actions";
import { Empty, ListingCard, ListingPill, Lock, PageHead } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { clientPick } from "@/lib/pick-options";

const SORTS: { v: ListingSort; l: string }[] = [
  { v: "newest_shoot", l: "Newest shoot" },
  { v: "client", l: "Client A to Z" },
  { v: "status", l: "Status" },
  { v: "updated", l: "Recently updated" },
];
const STATUSES = ["Awaiting Shoot", "In the edit", "In review", "Awaiting Payment", "Delivered", "Completed"];
// The QA team never sees payment state: "Delivered" covers locked and unlocked.
const QA_STATUSES = ["Awaiting Shoot", "In the edit", "In review", "Delivered", "Completed"];

export default async function AdminListings({ searchParams }: { searchParams: Promise<{ q?: string; sort?: string; clientId?: string; status?: string; view?: string; deleted?: string; error?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  // Admins and the QA team. The QA team gets no lock, view as, new listing or
  // upload controls, and no download lock column (payment state).
  // Admins only since Oct 26 2026: the Photo QC team reaches a listing from a
  // revision or a shoot (the QA branches below stay for when that changes).
  await requireAdmin();
  const admin: boolean = true;
  const sp = await searchParams;
  const sort = (SORTS.some((s) => s.v === sp.sort) ? sp.sort : "newest_shoot") as ListingSort;
  const view = sp.view === "list" ? "list" : "grid";
  const qaDelivered = !admin && sp.status === "Delivered";
  const [rows, clients] = await Promise.all([adminListings({ q: sp.q, sort, clientId: sp.clientId, status: admin ? sp.status : qaDelivered || sp.status === "Awaiting Payment" ? undefined : sp.status }), admin ? adminClients() : Promise.resolve([])]);
  const listings = qaDelivered ? rows.filter((l) => qaListingStatus(listingStatusLabel(l)) === "Delivered") : rows;
  const statusLabel = (l: (typeof rows)[number]) => (admin ? listingStatusLabel(l) : qaListingStatus(listingStatusLabel(l)));
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: sp.q, sort, clientId: sp.clientId, status: sp.status, view, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return `/admin/listings${s ? `?${s}` : ""}`;
  };

  return (
    <section className="wrap adm-page">
      <PageHead eyebrow={admin ? "Admin" : "Photo QC"} title="Listings." lede={admin ? "Every property, who it belongs to and where it stands." : "Every property and where its photos stand. Open one to check, upload and publish its frames."}>
        {admin && <Link href="/admin/listings/new" className="btn btn-ghost">New listing →</Link>}
        {admin && <Link href="/admin/upload" className="btn btn-primary">Upload a shoot →</Link>}
      </PageHead>

      {sp.deleted && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Deleted {sp.deleted}. Its files stay in storage.</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}

      <form method="get" className="adm-toolbar" style={{ marginTop: 26 }}>
        <input type="hidden" name="view" value={view} />
        <div className="field">
          <input name="q" type="search" enterKeyHint="search" defaultValue={sp.q ?? ""} placeholder="Search address, client or email" aria-label="Search listings" />
        </div>
        {admin && (
          <div className="field" style={{ flex: "0 1 200px" }}>
            <SearchSelect name="clientId" defaultValue={sp.clientId ?? ""} options={clients.map(clientPick)} emptyLabel="All clients" title="Filter by client" searchPlaceholder="Search clients" ariaLabel="Filter by client" submitOnPick />
          </div>
        )}
        <div className="field" style={{ flex: "0 1 180px" }}>
          <select name="status" defaultValue={sp.status ?? ""} aria-label="Filter by status">
            <option value="">Any status</option>
            {(admin ? STATUSES : QA_STATUSES).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: "0 1 180px" }}>
          <select name="sort" defaultValue={sort} aria-label="Sort">
            {SORTS.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
          </select>
        </div>
        <button type="submit" className="adm-chip" style={{ height: 44 }}>Apply</button>
        {(sp.q || sp.clientId || sp.status) && <Link href={qs({ q: undefined, clientId: undefined, status: undefined })} className="adm-chip adm-chip--quiet" style={{ height: 44 }}>Clear</Link>}
        <span style={{ flex: 1 }} />
        <div className="adm-seg" role="tablist" aria-label="View">
          <Link href={qs({ view: "grid" })} className={view === "grid" ? "is-active" : ""} role="tab" aria-selected={view === "grid"}>Grid</Link>
          <Link href={qs({ view: "list" })} className={view === "list" ? "is-active" : ""} role="tab" aria-selected={view === "list"}>List</Link>
        </div>
      </form>

      <p className="faint" style={{ fontSize: 12.5, marginTop: 14 }}>{listings.length} listing{listings.length === 1 ? "" : "s"}</p>

      {listings.length === 0 ? (
        <Empty>No listings match. Clear the filters or add a new listing.</Empty>
      ) : view === "grid" ? (
        <div className="adm-grid" style={{ marginTop: 12 }}>
          {listings.map((l) => (
            <ListingCard key={l.id} l={l} viewAs={admin ? enterViewAs : undefined} lockToggle={admin ? setLock.bind(null, l.id, !l.downloadLocked) : undefined} qa={!admin} />
          ))}
        </div>
      ) : (
        <div className="adm-table-wrap" style={{ marginTop: 12 }}>
          <div className="adm-table-scroll">
            <table className="adm-table">
              <thead>
                <tr><th>Property</th><th>Client</th><th>Status</th><th>Shoot</th><th>Files</th>{admin && <th>Downloads</th>}<th></th></tr>
              </thead>
              <tbody>
                {listings.map((l) => (
                  <tr key={l.id}>
                    <td><Link href={`/admin/listings/${l.id}`} style={{ fontWeight: 500 }}>{l.address.split(",")[0]}</Link>{l.nda && <span className="adm-pill" style={{ marginLeft: 8, background: "rgba(11,12,15,.08)" }}>NDA</span>}<div className="muted" style={{ fontSize: 12 }}>{l.address.split(",").slice(1).join(",").trim()}</div></td>
                    <td>{l.clientName ?? l.clientEmail}<div className="muted" style={{ fontSize: 12 }}>{l.clientCompany ?? l.clientEmail}</div></td>
                    <td><ListingPill s={statusLabel(l)} /></td>
                    <td className="adm-mono">{fmtDay(l.shootDate) || ""}</td>
                    <td className="adm-mono">{l.mediaCount}{l.pendingCount ? ` (+${l.pendingCount} QC)` : ""}</td>
                    {admin && <td><Lock locked={l.downloadLocked} /></td>}
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {admin ? (
                        <>
                          <form action={enterViewAs.bind(null, l.clientEmail)} style={{ display: "inline" }}><button type="submit" className="adm-chip adm-chip--quiet">View as</button></form>{" "}
                          <form action={setLock.bind(null, l.id, !l.downloadLocked)} style={{ display: "inline" }}><button type="submit" className="adm-chip adm-chip--quiet">{l.downloadLocked ? "Unlock" : "Lock"}</button></form>
                        </>
                      ) : (
                        <Link href={`/admin/listings/${l.id}`} className="adm-chip adm-chip--quiet">Open</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
