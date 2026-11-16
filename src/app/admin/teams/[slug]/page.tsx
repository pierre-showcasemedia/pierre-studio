// One team: its members, the listings they own, the editable name, id and
// notes, and the way to take the team apart again.
import Link from "next/link";
import { notFound } from "next/navigation";
import { adminTeam } from "@/lib/admin-crud";
import { adminListings, listingStatusLabel } from "@/lib/admin-data";
import { fmtDay } from "@/lib/shoot-status";
import { addTeamMember, deleteTeam, removeTeamMember, updateTeam } from "../../crud-actions";
import { enterViewAs } from "../../../portal/view-as-actions";
import { Empty, ListingPill, Lock, SectionHead } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";

type Search = { saved?: string; error?: string };

export default async function AdminTeamPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const { slug } = await params;
  const sp = await searchParams;
  const team = await adminTeam(slug);
  if (!team) notFound();
  const memberIds = new Set(team.members.map((m) => m.id));
  const all = (await adminListings({ sort: "newest_shoot" })).filter((l) => memberIds.has(l.clientId));
  const listings = all.slice(0, 50);
  const first = team.members[0] ?? null;

  return (
    <section className="wrap adm-page">
      <Link href="/admin/teams" className="adm-link muted" style={{ fontSize: 12.5 }}>← Teams</Link>
      <div className="adm-head" style={{ marginTop: 14 }}>
        <div>
          <div className="kicker" style={{ marginBottom: 10 }}>Team</div>
          <h1 className="adm-title">{team.name ?? team.slug}</h1>
          <p className="adm-lede">
            <span className="adm-mono">{team.slug}</span>
            {" · "}{team.members.length} member{team.members.length === 1 ? "" : "s"}
            {" · "}{team.listingCount} listing{team.listingCount === 1 ? "" : "s"}
            {team.lastShoot ? ` · last shoot ${fmtDay(team.lastShoot)}` : ""}
          </p>
          {team.notes && <p className="muted" style={{ fontSize: 13.5, marginTop: 8, whiteSpace: "pre-wrap" }}>{team.notes}</p>}
        </div>
        <div className="adm-actions">
          {first && <Link href={`/admin/listings/new?clientId=${first.id}`} className="btn btn-ghost">New listing →</Link>}
          <Link href="/admin/upload" className="btn btn-primary">Upload a shoot →</Link>
        </div>
      </div>

      {sp.saved && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Saved.</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}

      <div className="adm-section">
        <SectionHead title={`Members · ${team.members.length}`} />
        {team.members.length === 0 ? (
          <Empty>No members yet. Add one below.</Empty>
        ) : (
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table">
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Phone</th><th>Listings</th><th></th></tr>
                </thead>
                <tbody>
                  {team.members.map((m) => (
                    <tr key={m.id}>
                      <td><Link href={`/admin/clients/${m.id}`} style={{ fontWeight: 500 }}>{m.name ?? m.email}</Link>{m.company && <div className="muted" style={{ fontSize: 12 }}>{m.company}</div>}</td>
                      <td className="muted">{m.email}</td>
                      <td className="muted">{m.phone ?? ""}</td>
                      <td className="adm-mono"><Link href={`/admin/listings?clientId=${m.id}`}>{m.listingCount}</Link></td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <Link href={`/admin/clients/${m.id}`} className="adm-chip adm-chip--quiet">Open</Link>{" "}
                        <form action={enterViewAs.bind(null, m.email)} style={{ display: "inline" }}>
                          <button type="submit" className="adm-chip adm-chip--quiet" title={`Open the portal exactly as ${m.email} sees it`}>View as</button>
                        </form>{" "}
                        <form action={removeTeamMember.bind(null, team.slug, m.id)} style={{ display: "inline" }}>
                          <button type="submit" className="adm-chip adm-chip--quiet" title="Takes this client off the team. Their account and listings stay.">Remove from team</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="adm-section">
        <div className="kicker" style={{ marginBottom: 14 }}>Add a member</div>
        <form action={addTeamMember.bind(null, team.slug)} className="adm-card adm-card--lg grid grid-cols-1 sm:grid-cols-3" style={{ gap: 12, maxWidth: 860, alignItems: "end" }}>
          <div className="field"><label htmlFor="m-email">Email</label><input id="m-email" name="email" type="email" required placeholder="agent@brokerage.com" /></div>
          <div className="field"><label htmlFor="m-name">Name, optional</label><input id="m-name" name="name" placeholder="First Last" /></div>
          <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Add member →</button>
        </form>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>An email that is already a client moves onto this team. An unknown one becomes a new client here.</p>
      </div>

      <div className="adm-section">
        <SectionHead title={`Listings · ${all.length}`} />
        {listings.length === 0 ? (
          <Empty>No listings for this team yet.</Empty>
        ) : (
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table">
                <thead>
                  <tr><th>Property</th><th>Client</th><th>Status</th><th>Shoot</th><th>Files</th><th>Downloads</th><th></th></tr>
                </thead>
                <tbody>
                  {listings.map((l) => (
                    <tr key={l.id}>
                      <td><Link href={`/admin/listings/${l.id}`} style={{ fontWeight: 500 }}>{l.address.split(",")[0]}</Link>{l.nda && <span className="adm-pill" style={{ marginLeft: 8, background: "rgba(11,12,15,.08)" }}>NDA</span>}<div className="muted" style={{ fontSize: 12 }}>{l.address.split(",").slice(1).join(",").trim()}</div></td>
                      <td><Link href={`/admin/clients/${l.clientId}`}>{l.clientName ?? l.clientEmail}</Link><div className="muted" style={{ fontSize: 12 }}>{l.clientCompany ?? l.clientEmail}</div></td>
                      <td><ListingPill s={listingStatusLabel(l)} /></td>
                      <td className="adm-mono">{fmtDay(l.shootDate) || ""}</td>
                      <td className="adm-mono">{l.mediaCount}{l.pendingCount ? ` (+${l.pendingCount} QC)` : ""}</td>
                      <td><Lock locked={l.downloadLocked} /></td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <Link href={`/admin/listings/${l.id}`} className="adm-chip adm-chip--quiet">Open</Link>{" "}
                        <form action={enterViewAs.bind(null, l.clientEmail)} style={{ display: "inline" }}><button type="submit" className="adm-chip adm-chip--quiet">View as</button></form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {all.length > listings.length && <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>Showing the {listings.length} newest of {all.length}.</p>}
      </div>

      <div className="adm-section">
        <SectionHead title="Team details" />
        <form action={updateTeam.bind(null, team.slug)} className="adm-card adm-card--lg" style={{ display: "grid", gap: 12, maxWidth: 760 }}>
          <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 12 }}>
            <div className="field"><label htmlFor="t-name">Name</label><input id="t-name" name="name" defaultValue={team.name ?? ""} placeholder="Coastal Living Group" /></div>
            <div className="field"><label htmlFor="t-slug">Id</label><input id="t-slug" name="slug" defaultValue={team.slug} placeholder={team.slug} /></div>
          </div>
          <div className="field"><label htmlFor="t-notes">Notes</label><textarea id="t-notes" name="notes" rows={3} defaultValue={team.notes ?? ""} placeholder="Billing contact, office, anything worth knowing" style={{ minHeight: 0 }} /></div>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Changing the id moves every member to the new one. Letters, numbers and dashes only.</p>
          <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Save</button>
        </form>
      </div>

      <div className="adm-section">
        <details className="adm-card">
          <summary className="kicker" style={{ cursor: "pointer" }}>Danger zone</summary>
          <form action={deleteTeam.bind(null, team.slug)} style={{ display: "grid", gap: 12, marginTop: 14 }}>
            <p style={{ margin: 0, fontSize: 14 }}>Remove this team. Members keep their accounts and listings. Only the grouping goes away.</p>
            <button type="submit" className="adm-chip adm-chip--danger" style={{ justifySelf: "start" }}>Remove team</button>
          </form>
        </details>
      </div>
    </section>
  );
}
