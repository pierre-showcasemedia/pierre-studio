// Teams (one portal, Oct 2026): every team slug in use, who is on it, how
// many listings they own and when they last shot, plus a form to add one.
import Link from "next/link";
import { adminTeams } from "@/lib/admin-crud";
import { fmtDay } from "@/lib/shoot-status";
import { createTeam } from "../crud-actions";
import { Empty, PageHead } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";

export default async function AdminTeams({ searchParams }: { searchParams: Promise<{ deleted?: string; error?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const sp = await searchParams;
  const teams = await adminTeams();
  return (
    <section className="wrap adm-page">
      <PageHead title="Teams." lede="Brokerages and groups of agents. Open a team to see its members and every listing they own.">
        <Link href="/admin/upload" className="btn btn-primary">Upload a shoot →</Link>
      </PageHead>

      {sp.deleted && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Team <span className="adm-mono">{sp.deleted}</span> removed. Its members keep their accounts and listings.</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}

      {teams.length === 0 ? (
        <Empty>No teams yet. Add one below, or give a client a team id on their page.</Empty>
      ) : (
        <div className="adm-table-wrap" style={{ marginTop: 26 }}>
          <div className="adm-table-scroll">
            <table className="adm-table">
              <thead>
                <tr><th>Team</th><th>Id</th><th>Members</th><th>Listings</th><th>Last shoot</th><th></th></tr>
              </thead>
              <tbody>
                {teams.map((t) => {
                  const names = t.members.slice(0, 3).map((m) => m.name ?? m.email);
                  const more = t.members.length - names.length;
                  return (
                    <tr key={t.slug}>
                      <td><Link href={`/admin/teams/${t.slug}`} style={{ fontWeight: 500 }}>{t.name ?? t.slug}</Link></td>
                      <td className="adm-mono muted">{t.slug}</td>
                      <td>
                        <span className="adm-mono">{t.members.length}</span>
                        {names.length > 0 && <div className="muted" style={{ fontSize: 12.5 }}>{names.join(", ")}{more > 0 ? ` and ${more} more` : ""}</div>}
                      </td>
                      <td className="adm-mono">{t.listingCount}</td>
                      <td className="adm-mono muted">{fmtDay(t.lastShoot) || ""}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <Link href={`/admin/teams/${t.slug}`} className="adm-chip adm-chip--quiet">Open</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="adm-section">
        <div className="kicker" style={{ marginBottom: 14 }}>Add a team</div>
        <form action={createTeam} className="adm-card adm-card--lg" style={{ display: "grid", gap: 12, maxWidth: 760 }}>
          <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 12 }}>
            <div className="field"><label htmlFor="t-name">Name</label><input id="t-name" name="name" required placeholder="Coastal Living Group" /></div>
            <div className="field"><label htmlFor="t-slug">Id, optional</label><input id="t-slug" name="slug" placeholder="coastal-living" /></div>
          </div>
          <div className="field">
            <label htmlFor="t-members">Member emails</label>
            <textarea id="t-members" name="members" rows={4} placeholder={"agent@brokerage.com\nsecond@brokerage.com"} style={{ minHeight: 0 }} />
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>One per line or separated by commas. Emails that are already clients join the team. Unknown emails become new clients on it.</p>
          <div className="field"><label htmlFor="t-notes">Notes, optional</label><textarea id="t-notes" name="notes" rows={2} placeholder="Billing contact, office, anything worth knowing" style={{ minHeight: 0 }} /></div>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>The id uses letters, numbers and dashes. Left empty, it comes from the name.</p>
          <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Add team →</button>
        </form>
      </div>
    </section>
  );
}
