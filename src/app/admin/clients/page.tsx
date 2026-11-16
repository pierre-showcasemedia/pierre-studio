import Link from "next/link";
import { adminClientsWithTeams } from "@/lib/admin-crud";
import { createClient } from "../actions";
import { enterViewAs } from "../../portal/view-as-actions";
import { Empty, PageHead } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";

export default async function AdminClients({ searchParams }: { searchParams: Promise<{ q?: string; created?: string; deleted?: string; error?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const sp = await searchParams;
  const clients = await adminClientsWithTeams(sp.q);
  return (
    <section className="wrap adm-page">
      <PageHead title="Clients." lede="Agents and teams. Open the portal as any of them to see exactly what they see.">
        <Link href="/admin/upload" className="btn btn-primary">Upload a shoot →</Link>
      </PageHead>

      <form method="get" className="adm-toolbar" style={{ marginTop: 26 }}>
        <div className="field" style={{ maxWidth: 480 }}>
          <input name="q" type="search" enterKeyHint="search" defaultValue={sp.q ?? ""} placeholder="Find by name, email or company" aria-label="Find a client" autoFocus={!sp.q} />
        </div>
        <button type="submit" className="adm-chip" style={{ height: 44 }}>Find</button>
        {sp.q && <Link href="/admin/clients" className="adm-chip adm-chip--quiet" style={{ height: 44 }}>Clear</Link>}
      </form>
      {sp.created === "demo" && <p className="adm-banner adm-banner--info" style={{ marginTop: 14 }}>Demo mode: the client was not saved. Connect the database to add clients for real.</p>}
      {sp.deleted && <p className="adm-banner adm-banner--ok" style={{ marginTop: 14 }}>Client {sp.deleted} deleted. Their files in storage were left alone.</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 14 }}>{sp.error}</p>}

      {clients.length === 0 ? (
        <Empty>No clients match.</Empty>
      ) : (
        <div className="adm-table-wrap" style={{ marginTop: 18 }}>
          <div className="adm-table-scroll">
            <table className="adm-table">
              <thead>
                <tr><th>Client</th><th>Company</th><th>Team</th><th>Listings</th><th></th></tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/admin/clients/${c.id}`} style={{ fontWeight: 500 }}>{c.name ?? c.email}</Link><div className="muted" style={{ fontSize: 12.5 }}>{c.email}</div></td>
                    <td className="muted">{c.company ?? ""}</td>
                    <td>
                      {c.team ? (
                        <>
                          <Link href={`/admin/teams/${c.team}`}>{c.teamName ?? c.team}</Link>
                          {c.teamName && <div className="adm-mono muted" style={{ fontSize: 12 }}>{c.team}</div>}
                        </>
                      ) : ""}
                    </td>
                    <td className="adm-mono"><Link href={`/admin/listings?clientId=${c.id}`}>{c.listingCount}</Link></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <Link href={`/admin/clients/${c.id}`} className="adm-chip adm-chip--quiet">Open</Link>{" "}
                      <Link href={`/admin/upload?clientId=${c.id}`} className="adm-chip adm-chip--quiet">Upload</Link>{" "}
                      <Link href={`/admin/listings/new?clientId=${c.id}`} className="adm-chip adm-chip--quiet">New listing</Link>{" "}
                      <form action={enterViewAs.bind(null, c.email)} style={{ display: "inline" }}>
                        <button type="submit" className="adm-chip" title={`Open the portal exactly as ${c.email} sees it`}>View as →</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="adm-section">
        <div className="kicker" style={{ marginBottom: 14 }}>Add a client</div>
        <form action={createClient} className="adm-card adm-card--lg grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4" style={{ gap: 12, maxWidth: 1000, alignItems: "end" }}>
          <div className="field"><label htmlFor="c-email">Email</label><input id="c-email" name="email" type="email" required placeholder="agent@brokerage.com" /></div>
          <div className="field"><label htmlFor="c-name">Name</label><input id="c-name" name="name" placeholder="First Last" /></div>
          <div className="field"><label htmlFor="c-company">Company</label><input id="c-company" name="company" placeholder="Brokerage" /></div>
          <div className="field"><label htmlFor="c-phone">Phone</label><input id="c-phone" name="phone" type="tel" autoComplete="off" placeholder="(555) 010 0000" /></div>
          <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Add client →</button>
        </form>
      </div>
    </section>
  );
}
