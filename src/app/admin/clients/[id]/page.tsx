// One client: the editable record, their listings, bookings, invoices,
// downloads, revision requests and activity, and the way in to their portal.
import Link from "next/link";
import { notFound } from "next/navigation";
import { adminClientDetail, adminTeams } from "@/lib/admin-crud";
import { fmtDay, fmtWhen } from "@/lib/shoot-status";
import { deleteClient, sendClientSignInLink, updateClient } from "../../crud-actions";
import { enterViewAs } from "../../../portal/view-as-actions";
import { ActivityFeed, BookingPill, Empty, ListingCard, PayPill, SectionHead, fmtMoney } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";

type Search = { saved?: string; sent?: string; error?: string };

export default async function AdminClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const [data, teams] = await Promise.all([adminClientDetail(id), adminTeams()]);
  if (!data) notFound();
  const { client: c, team, listings, bookings, invoices, downloads, revisions, activity } = data;
  const teamLabel = team?.name ?? c.teamName ?? c.team;
  const openRevs = revisions.filter((r) => r.status !== "done").length;
  const meta: React.ReactNode[] = [];
  if (c.name) meta.push(c.email);
  if (c.company) meta.push(c.company);
  if (c.phone) meta.push(c.phone);
  if (c.team) meta.push(<Link href={`/admin/teams/${c.team}`} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{teamLabel}</Link>);
  meta.push(<>client since <span className="adm-mono">{fmtDay(c.createdAt)}</span></>);

  return (
    <section className="wrap adm-page">
      <Link href="/admin/clients" className="adm-link muted" style={{ fontSize: 12.5 }}>← Clients</Link>
      <div className="adm-head" style={{ marginTop: 14 }}>
        <div>
          <div className="kicker" style={{ marginBottom: 10 }}>Client</div>
          <h1 className="adm-title">{c.name ?? c.email}</h1>
          <p className="adm-lede">
            {meta.map((m, i) => <span key={i}>{i > 0 ? " · " : ""}{m}</span>)}
          </p>
        </div>
        <div className="adm-actions">
          <form action={enterViewAs.bind(null, c.email)}>
            <button type="submit" className="btn btn-primary" title={`Open the portal exactly as ${c.email} sees it`}>View as client →</button>
          </form>
          <form action={sendClientSignInLink.bind(null, c.id)}>
            <button type="submit" className="btn btn-ghost" title="Emails them a sign-in link that works for 15 minutes">Send sign-in link</button>
          </form>
          <Link href={`/admin/upload?clientId=${c.id}`} className="btn btn-ghost">Upload a shoot</Link>
          <Link href={`/admin/listings/new?clientId=${c.id}`} className="btn btn-ghost">New listing</Link>
        </div>
      </div>

      {sp.saved && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Saved.</p>}
      {sp.sent && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Sign-in link sent to {c.email}.</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}

      <div className="adm-section">
        <SectionHead title="Details" />
        <form action={updateClient.bind(null, c.id)} className="adm-card adm-card--lg" style={{ display: "grid", gap: 12, maxWidth: 1000 }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3" style={{ gap: 12 }}>
            <div className="field"><label htmlFor="c-email">Email</label><input id="c-email" name="email" type="email" required defaultValue={c.email} /></div>
            <div className="field"><label htmlFor="c-name">Name</label><input id="c-name" name="name" defaultValue={c.name ?? ""} placeholder="First Last" /></div>
            <div className="field"><label htmlFor="c-company">Company</label><input id="c-company" name="company" defaultValue={c.company ?? ""} placeholder="Brokerage" /></div>
            <div className="field"><label htmlFor="c-phone">Phone</label><input id="c-phone" name="phone" type="tel" autoComplete="off" defaultValue={c.phone ?? ""} placeholder="(555) 010 0000" /></div>
            <div className="field">
              <label htmlFor="c-team">Team id</label>
              <input id="c-team" name="team" list="team-slugs" defaultValue={c.team ?? ""} placeholder="coastal-living" autoComplete="off" />
              <datalist id="team-slugs">
                {teams.map((t) => <option key={t.slug} value={t.slug}>{t.name ?? t.slug}</option>)}
              </datalist>
            </div>
          </div>
          <div className="field"><label htmlFor="c-notes">Notes, internal</label><textarea id="c-notes" name="notes" rows={3} defaultValue={c.notes ?? ""} placeholder="Preferences, access, billing, anything worth knowing" style={{ minHeight: 0 }} /></div>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Changing the email moves their sign-in to the new address. A team id that does not exist yet is created. Clear it to take them off their team.</p>
          <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Save</button>
        </form>
      </div>

      <div className="adm-section">
        <SectionHead title={`Listings · ${listings.length}`} href={`/admin/listings?clientId=${c.id}`} label="On the listings page →" />
        {listings.length === 0 ? (
          <Empty>No listings yet. Add one with New listing, or upload a shoot.</Empty>
        ) : (
          <div className="adm-grid">
            {listings.map((l) => <ListingCard key={l.id} l={l} viewAs={enterViewAs} />)}
          </div>
        )}
      </div>

      <div className="adm-section">
        <SectionHead title={`Bookings · ${bookings.length}`} href="/admin/bookings" label="All bookings →" />
        {bookings.length === 0 ? (
          <Empty>No bookings from this client yet.</Empty>
        ) : (
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table">
                <thead>
                  <tr><th>When</th><th>Property</th><th>Services</th><th>Payment</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {bookings.map((b) => (
                    <tr key={b.id}>
                      <td className="adm-mono" style={{ whiteSpace: "nowrap" }}>{b.when ?? <span className="muted">To confirm</span>}</td>
                      <td><Link href={`/admin/bookings/${b.id}`} style={{ fontWeight: 500 }}>{b.address.split(",")[0]}</Link>{b.nda && <span className="adm-pill" style={{ marginLeft: 8, background: "rgba(11,12,15,.08)" }}>NDA</span>}</td>
                      <td className="muted" style={{ fontSize: 13 }}>{b.servicesLabel ?? "To confirm"}{b.addonsLabel ? `, ${b.addonsLabel}` : ""}</td>
                      <td><PayPill status={b.invoice?.status} amountCents={b.invoice?.amountCents} /></td>
                      <td><BookingPill s={b.status} /></td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}><Link href={`/admin/bookings/${b.id}`} className="adm-chip adm-chip--quiet">Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 24, marginTop: 40 }}>
        <div>
          <SectionHead title={`Invoices · ${invoices.length}`} />
          {invoices.length === 0 ? (
            <Empty>No invoices on file.</Empty>
          ) : (
            invoices.map((inv) => (
              <p key={inv.id} style={{ fontSize: 14, marginBottom: 6 }}>
                <code className="adm-mono">{inv.providerId ?? inv.id.slice(0, 8)}</code>
                {inv.provider ? <span className="muted"> · {inv.provider}</span> : null}
                {" · "}{inv.status.replace(/_/g, " ")}
                {inv.amountCents != null ? ` · ${fmtMoney(inv.amountCents) ?? ""}` : ""}
                {inv.address ? <span className="muted"> · {inv.address.split(",")[0]}</span> : null}
                {inv.hostedUrl && <> · <a href={inv.hostedUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>view</a></>}
              </p>
            ))
          )}
        </div>
        <div>
          <SectionHead title="Recent downloads" href={`/admin/downloads?clientId=${c.id}`} label="All →" />
          {downloads.length === 0 ? (
            <Empty>No downloads yet.</Empty>
          ) : (
            <div className="adm-table-wrap">
              <div className="adm-table-scroll">
                <table className="adm-table">
                  <thead>
                    <tr><th>When</th><th>File</th><th>Property</th></tr>
                  </thead>
                  <tbody>
                    {downloads.map((x, i) => (
                      <tr key={`${x.at}-${i}`}>
                        <td className="adm-mono" style={{ whiteSpace: "nowrap" }}>{fmtWhen(x.at)}</td>
                        <td className="adm-mono" style={{ fontSize: 12 }}>{x.filename}</td>
                        <td><Link href={`/admin/listings/${x.listingId}`}>{x.address.split(",")[0]}</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="adm-section">
        <SectionHead title={`Revision requests · ${openRevs} open`} href="/admin/revisions" label="Manage →" />
        {revisions.length === 0 ? (
          <Empty>No revision requests from this client.</Empty>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {revisions.map((r) => (
              <div key={r.id} className="adm-card">
                <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                  <span className="adm-mono">{fmtWhen(r.createdAt)}</span> · <Link href={`/admin/listings/${r.listingId}`}>{r.address.split(",")[0]}</Link> · {r.status.replace("_", " ")}{r.resolvedAt ? ` · done ${fmtDay(r.resolvedAt)}` : ""}
                </p>
                <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{r.notes}</p>
                {r.filenames.length > 0 && <p className="muted adm-mono" style={{ margin: "8px 0 0", fontSize: 12 }}>{r.filenames.join(", ")}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="adm-section">
        <SectionHead title="Activity" />
        <ActivityFeed rows={activity} />
      </div>

      <div className="adm-section">
        <details className="adm-card">
          <summary className="kicker" style={{ cursor: "pointer" }}>Danger zone</summary>
          <form action={deleteClient.bind(null, c.id)} style={{ display: "grid", gap: 12, marginTop: 14 }}>
            <p style={{ margin: 0, fontSize: 14 }}>Delete this client. A client with listings, bookings or invoices cannot be deleted, so move or delete those first. Files in storage are never touched.</p>
            <button type="submit" className="adm-chip adm-chip--danger" style={{ justifySelf: "start" }}>Delete client</button>
          </form>
        </details>
      </div>
    </section>
  );
}
