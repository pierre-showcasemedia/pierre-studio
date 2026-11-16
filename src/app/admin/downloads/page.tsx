import Link from "next/link";
import { adminClients, adminDownloads, adminListings } from "@/lib/admin-data";
import type { DownloadSort } from "@/lib/admin-types";
import { fmtWhen } from "@/lib/shoot-status";
import { Empty, PageHead } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { clientPick, listingPick } from "@/lib/pick-options";

export default async function AdminDownloads({ searchParams }: { searchParams: Promise<{ clientId?: string; listingId?: string; from?: string; to?: string; sort?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const sp = await searchParams;
  const sort = (["date", "client", "listing"].includes(sp.sort ?? "") ? sp.sort : "date") as DownloadSort;
  const [rows, clients, listings] = await Promise.all([
    adminDownloads({ clientId: sp.clientId, listingId: sp.listingId, from: sp.from, to: sp.to, sort }),
    adminClients(),
    adminListings({ sort: "client" }),
  ]);
  const filtered = Boolean(sp.clientId || sp.listingId || sp.from || sp.to);
  return (
    <section className="wrap adm-page">
      <PageHead title="Downloads." lede="Every signed download a client took, with the file and the listing." />

      <form method="get" className="adm-toolbar" style={{ marginTop: 26 }}>
        <div className="field" style={{ flex: "1 1 200px" }}>
          <SearchSelect name="clientId" defaultValue={sp.clientId ?? ""} options={clients.map(clientPick)} emptyLabel="All clients" title="Filter by client" searchPlaceholder="Search clients" ariaLabel="Client" submitOnPick />
        </div>
        <div className="field" style={{ flex: "1 1 220px" }}>
          <SearchSelect name="listingId" defaultValue={sp.listingId ?? ""} options={listings.map(listingPick)} emptyLabel="All listings" title="Filter by listing" searchPlaceholder="Search address or client" ariaLabel="Listing" submitOnPick />
        </div>
        <div className="field" style={{ flex: "0 1 160px" }}><input type="date" name="from" defaultValue={sp.from ?? ""} aria-label="From" /></div>
        <div className="field" style={{ flex: "0 1 160px" }}><input type="date" name="to" defaultValue={sp.to ?? ""} aria-label="To" /></div>
        <div className="field" style={{ flex: "0 1 150px" }}>
          <select name="sort" defaultValue={sort} aria-label="Sort">
            <option value="date">Newest first</option>
            <option value="client">By client</option>
            <option value="listing">By listing</option>
          </select>
        </div>
        <button type="submit" className="adm-chip" style={{ height: 44 }}>Apply</button>
        {filtered && <Link href="/admin/downloads" className="adm-chip adm-chip--quiet" style={{ height: 44 }}>Clear</Link>}
      </form>

      <p className="faint" style={{ fontSize: 12.5, marginTop: 14 }}>{rows.length} download{rows.length === 1 ? "" : "s"}</p>

      {rows.length === 0 ? (
        <Empty>No downloads match.</Empty>
      ) : (
        <div className="adm-table-wrap" style={{ marginTop: 12 }}>
          <div className="adm-table-scroll">
            <table className="adm-table">
              <thead><tr><th>When</th><th>Client</th><th>File</th><th>Listing</th></tr></thead>
              <tbody>
                {rows.map((d, i) => (
                  <tr key={i}>
                    <td className="adm-mono" style={{ whiteSpace: "nowrap" }}>{fmtWhen(d.at)}</td>
                    <td><Link href={`/admin/downloads?clientId=${clients.find((c) => c.email === d.clientEmail)?.id ?? ""}`}>{d.clientEmail}</Link></td>
                    <td className="adm-mono" style={{ fontSize: 12.5 }}>{d.filename}</td>
                    <td><Link href={`/admin/listings/${d.listingId}`}>{d.address.split(",")[0]}</Link></td>
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
