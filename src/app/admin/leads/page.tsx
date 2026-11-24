// Leads from the website's pricing page (Nov 24 2026, src/lib/leads.ts):
// who opened the price list, where the visit came from, and whether they
// have booked since. Following up is by hand; nothing here sends anything.
import Link from "next/link";
import { hasDb } from "@/db";
import { Empty, PageHead } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";
import { adminLeads } from "@/lib/leads";
import { fmtLa } from "@/lib/booking-time";

const TYPE: Record<string, string> = { agent: "Agent", homeowner: "Homeowner", builder: "Builder", other: "Commercial or other" };

export default async function AdminLeads() {
  await requireAdmin();
  const leads = hasDb() ? await adminLeads() : [];
  const booked = leads.filter((l) => l.booked).length;
  return (
    <section className="wrap adm-page">
      <PageHead title="Leads." lede="People who opened your price list on the website. Booked means that email has booked since." />
      {leads.length === 0 ? (
        <Empty>No leads yet. They appear here when someone opens the price list on your website.</Empty>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 18 }}>{leads.length} lead{leads.length === 1 ? "" : "s"} · {booked} booked</p>
          <div className="adm-table-wrap" style={{ marginTop: 12 }}>
            <div className="adm-table-scroll">
              <table className="adm-table">
                <thead>
                  <tr><th>When</th><th>Who</th><th>Type</th><th>Came from</th><th>Booked</th></tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    <tr key={l.id}>
                      <td className="adm-mono muted" style={{ whiteSpace: "nowrap" }}>{fmtLa(l.createdAt)}</td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{l.name}</div>
                        <div className="muted" style={{ fontSize: 12.5 }}><a href={`mailto:${l.email}`}>{l.email}</a>{l.phone ? ` · ${l.phone}` : ""}</div>
                      </td>
                      <td className="muted">{l.clientType ? TYPE[l.clientType] ?? l.clientType : ""}{l.brokerage ? <div style={{ fontSize: 12.5 }}>{l.brokerage}</div> : null}</td>
                      <td className="muted">{l.came}{l.landing ? <div className="adm-mono" style={{ fontSize: 12 }}>{l.landing}</div> : null}</td>
                      <td>{l.booked ? <Link href={`/admin/clients?q=${encodeURIComponent(l.email)}`}>Booked</Link> : <span className="muted">Not yet</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
