import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import "@/styles/admin-media.css";
import "@/styles/admin-visibility.css";
import { adminClients, adminListingDetail, adminReplacedOriginals, listingStatusLabel } from "@/lib/admin-data";
import { adminMediaRows } from "@/lib/admin-crud";
import { hasR2, objectExists } from "@/lib/r2";
import { fmtDay, fmtWhen } from "@/lib/shoot-status";
import { approvePendingForListing, setLock } from "../../actions";
import { deleteListing, rebuildBundles, updateListing } from "../../crud-actions";
import { enterViewAs } from "../../../portal/view-as-actions";
import { ActivityFeed, Empty, ListingPill, Lock, ShootPill } from "@/components/admin/bits";
import ListingSectionNav from "@/components/admin/ListingSectionNav";
import RefreshOnReturn from "@/components/admin/RefreshOnReturn";
import { mediaGroupLinks } from "@/lib/media-groups";
import MediaGrid from "@/components/admin/MediaGrid";
import UploadToListing from "@/components/admin/UploadToListing";
import { db, hasDb, schema } from "@/db";
import { isActive } from "@/lib/shoot-status";
import { requireStaff } from "@/lib/admin";
import { qaMaySee } from "@/lib/activity";
import { qaListingStatus } from "@/lib/listing-status";
import { dropboxWebUrl, FINAL_DELIVERY_FOLDER } from "@/lib/dropbox";
import { finalsStatus } from "@/lib/dropbox-mirror";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { clientPick } from "@/lib/pick-options";

// The stored links column is a JSON string: [{ label, url }]. The editor shows
// one per line as "Label | url".
function linksToLines(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return "";
    return parsed
      .map((l) => (l && typeof l === "object" && typeof (l as { url?: unknown }).url === "string" ? `${String((l as { label?: unknown }).label ?? "").trim() || (l as { url: string }).url} | ${(l as { url: string }).url}` : ""))
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

const PILL_LIVE = { background: "rgba(26,127,75,.10)", color: "#1A7F4B" };
const PILL_HIDDEN = { background: "rgba(95,100,110,.10)", color: "#5F646E" };

// A page section's heading: Newsreader italic title, a short line under it,
// and an optional action on the right.
function SectionTitle({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="lsn-section__head">
      <div>
        <h2 className="lsn-section__title">{title}</h2>
        {sub && <p className="lsn-section__sub">{sub}</p>}
      </div>
      {children && <div className="adm-actions" style={{ alignItems: "center" }}>{children}</div>}
    </div>
  );
}

function BlockHead({ title, href, label }: { title: string; href?: string; label?: string }) {
  return (
    <div className="adm-section-head">
      <div className="kicker">{title}</div>
      {href && <Link href={href} className="adm-link">{label}</Link>}
    </div>
  );
}

export default async function AdminListingDetail({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ email?: string; saved?: string; error?: string; bundles?: string; edit?: string; merged?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  // Admins and the QA team. The QA team gets the media work (upload, the
  // grid, visibility, zips), the shoots and the photo feedback; never the
  // listing details, the lock, invoices, downloads by clients, view as, the
  // delivery email or delete. Those blocks are not rendered for them at all,
  // and every action behind them checks the role again.
  const staff = await requireStaff();
  const admin = staff.role === "admin";
  const { id } = await params;
  const { email: emailOutcome, saved, error, bundles, merged } = await searchParams;
  const data = await adminListingDetail(id);
  if (!data) notFound();
  const { listing, media, invoices, downloads, revisionRequests, shoots } = data;
  const activity = admin ? data.activity : data.activity.filter((a) => qaMaySee(a.action));
  const toggle = setLock.bind(null, listing.id, !listing.downloadLocked);
  const status = admin ? listingStatusLabel(listing) : qaListingStatus(listingStatusLabel(listing));
  const pendingLoose = media.filter((m) => m.qcState === "pending" && !m.shootId).length;
  const openRevs = revisionRequests.filter((r) => r.status !== "done");
  // v1.2: finals go onto the latest shoot whose frames are in.
  const finalsShoot = shoots.find((s) => s.status === "published" || s.status === "ready_for_review") ?? null;
  const waiting = media.filter((m) => m.qcState === "approved" && !m.published && !m.held && m.shootId).length;
  // The upload panel routes a corrected JPG to its shoot frame by filename
  // (newest shoot first), and refuses one whose shoot is still in editing.
  const shootFrames = shoots.flatMap((s) => media.filter((m) => m.shootId === s.id).map((m) => ({ shootId: s.id, filename: m.filename, ready: s.status !== "draft" && !isActive(s.status) })));

  // The editor's extras. AdminListing carries no city, state, zip, notes or
  // links, so read them here; demo mode has none. The media grid reads every
  // row (demo mode: public sample frames).
  const editor = hasDb();
  const [clients, extra, rows, replacedOriginals, finals] = await Promise.all([
    admin ? adminClients() : Promise.resolve([]),
    editor && admin ? db().query.listings.findFirst({ where: eq(schema.listings.id, id), columns: { city: true, state: true, zip: true, notes: true, links: true, picTimeUrl: true, dropboxFolder: true, deliveryEmailAt: true } }) : Promise.resolve(null),
    adminMediaRows(id),
    adminReplacedOriginals({ listingId: id }),
    editor && admin ? finalsStatus(id).catch(() => null) : Promise.resolve(null),
  ]);
  const storage = hasR2();
  const bundleBase = `listings/${listing.slug}/bundles`;
  const [zipFull, zipMls] = storage ? await Promise.all([objectExists(`${bundleBase}/photos-full.zip`).catch(() => false), objectExists(`${bundleBase}/photos-mls.zip`).catch(() => false)]) : [false, false];
  const existingNames = rows.map((m) => ({ filename: m.filename, section: m.section }));
  const street = listing.address.split(",")[0];

  return (
    <section className="wrap adm-page">
      {/* Nov 5 2026: a cut uploaded while this page sat open on a phone shows up when the page comes back. */}
      <RefreshOnReturn />
      {/* The Photo QC team has no listing list (Oct 26 2026): they come here from a revision. */}
      <Link href={admin ? "/admin/listings" : "/admin/revisions"} className="adm-link muted" style={{ fontSize: 12.5 }}>{admin ? "← Listings" : "← Revisions"}</Link>
      <div className="adm-head" style={{ marginTop: 14 }}>
        <div>
          <div className="flex flex-wrap items-center" style={{ gap: 10, marginBottom: 10 }}>
            <ListingPill s={status} />
            {admin && <Lock locked={listing.downloadLocked} />}
            {listing.nda && <span className="adm-pill" style={{ background: "rgba(11,12,15,.08)" }}>NDA</span>}
          </div>
          <h1 className="adm-title">{street}</h1>
          <p className="adm-lede">
            {listing.address.split(",").slice(1).join(",").trim()}
            {listing.address.includes(",") ? " · " : ""}
            {admin ? (
              <Link href={`/admin/clients?q=${encodeURIComponent(listing.clientEmail)}`} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{listing.clientName ?? listing.clientEmail}</Link>
            ) : (
              listing.clientName ?? listing.clientEmail
            )}
            {listing.clientCompany ? ` · ${listing.clientCompany}` : ""}
            {listing.shootDate ? ` · shoot ${fmtDay(listing.shootDate)}` : ""}
            {" · "}<span className="adm-mono">{listing.mediaCount}</span> client visible{rows.length > listing.mediaCount ? ` · ${rows.length - listing.mediaCount} internal only` : ""}{listing.pendingCount ? ` · ${listing.pendingCount} in QC` : ""}{waiting ? ` · ${waiting} waiting to publish` : ""}
            {admin && <>{" · slug "}<code className="adm-mono">{listing.slug}</code></>}
          </p>
        </div>
        {admin ? (
          <div className="adm-actions">
            <Link href={`/admin/upload?listingId=${listing.id}&clientId=${listing.clientId}`} className="btn btn-primary">Upload a shoot →</Link>
            <a href="#upload" className="btn btn-ghost">Upload photos</a>
            <Link href={`/admin/listings/${listing.id}/delivery-email`} className="btn btn-ghost" title="Preview the gallery-ready email before sending">
              {listing.deliveryEmailAt ? "Re-send delivery email" : "Send delivery email"}
            </Link>
            <form action={enterViewAs.bind(null, listing.clientEmail)}>
              <button type="submit" className="btn btn-ghost">View as client</button>
            </form>
            <form action={toggle}>
              <button type="submit" className="btn btn-ghost">{listing.downloadLocked ? "Unlock downloads" : "Lock downloads"}</button>
            </form>
            <a href="#details" className="btn btn-ghost">Edit listing</a>
          </div>
        ) : (
          <div className="adm-actions">
            <a href="#upload" className="btn btn-primary">Upload photos</a>
            {finalsShoot && <Link href={`/admin/shoots/${finalsShoot.id}`} className="btn btn-ghost">Open the shoot →</Link>}
          </div>
        )}
      </div>

      {admin && emailOutcome && (
        <p className={`adm-banner ${emailOutcome.startsWith("sent:") ? "adm-banner--ok" : "adm-banner--bad"}`} style={{ marginTop: 18 }}>
          {emailOutcome.startsWith("sent:") ? `Delivery email sent to ${emailOutcome.slice(5)}` : emailOutcome.replace(/^error:/, "")}
        </p>
      )}
      {admin && listing.deliveryEmailAt && <p className="faint" style={{ marginTop: 12, fontSize: 12.5 }}>Delivery email last sent {fmtWhen(listing.deliveryEmailAt)} to {listing.clientEmail}</p>}
      {listing.approvedAt && <p style={{ marginTop: 8, fontSize: 13.5, color: "var(--color-success)" }}>Approved by the client on {fmtDay(listing.approvedAt)}. Project completed.</p>}
      {pendingLoose > 0 && (
        <form action={approvePendingForListing.bind(null, listing.id)} className="adm-banner adm-banner--warn" style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <span>{pendingLoose} frame{pendingLoose === 1 ? "" : "s"} are waiting for QC outside a shoot.</span>
          <button type="submit" className="adm-chip">Approve them</button>
        </form>
      )}

      {waiting > 0 && finalsShoot && (
        <p className="adm-banner adm-banner--warn" style={{ marginTop: 14 }}>
          {waiting} approved frame{waiting === 1 ? " is" : "s are"} waiting for Publish. <Link href={`/admin/shoots/${finalsShoot.id}`} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>Open the shoot to publish</Link>.
        </p>
      )}

      {saved && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Saved.</p>}
      {admin && merged && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Merged {merged} into this listing. Its bookings, invoices and files are here now, and the calendar event is being updated.</p>}
      {error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{error}</p>}
      {bundles === "queued" && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>Download zips are being rebuilt. Give it a minute.</p>}

      {/* Nov 5 2026: one tab per media group (Photos, Film, Twilight,
          Floor Plans, Revised) so nobody scrolls past hundreds of photos to
          reach the film or the revised set. A listing with no files keeps
          one Media tab. */}
      <ListingSectionNav
        items={[
          ...(rows.length ? mediaGroupLinks(rows) : [{ id: "media", label: "Media", count: 0 }]),
          ...(admin ? [{ id: "details", label: "Details" }] : []),
          { id: "shoots", label: "Shoots", count: shoots.length },
          { id: "orders", label: admin ? "Orders and downloads" : "Download zips" },
          { id: "activity", label: "Activity" },
        ]}
      />

      {/* ---- Media ---- */}
      <section id="media" className="lsn-section" style={{ marginTop: 32 }}>
        <SectionTitle title="Media" sub="Every file reads Client visible or Internal only. Drag to set the gallery order; changes save on their own.">
          <a href="#upload" className="adm-chip">Upload photos</a>
        </SectionTitle>
        <div id="upload" className="lsn-block" style={{ marginBottom: 28, scrollMarginTop: 140 }}>
          <BlockHead title="Upload photos and films" />
          <div className="adm-card">
            <UploadToListing listingId={listing.id} demo={!editor} existing={existingNames} shootFrames={shootFrames} />
          </div>
        </div>
        <MediaGrid listingId={listing.id} rows={rows} coverKey={listing.coverKey} demo={!editor} storage={storage} role={admin ? "admin" : "qa"} />
      </section>

      {/* ---- Details (admins only) ---- */}
      {admin && (
      <section id="details" className="lsn-section">
        <span id="edit" aria-hidden />
        <SectionTitle title="Details" sub="What the client sees on the gallery, and who it belongs to." />
        <form action={updateListing.bind(null, listing.id)} className="lset">
          <div className="lset__row">
            <div>
              <label htmlFor="edit-address" className="lset__label">Address</label>
              <p className="lset__hint">The full line the client sees. The street part is the page title.</p>
            </div>
            <div className="lset__fields">
              <div className="field">
                <input id="edit-address" name="address" required defaultValue={listing.address} placeholder="3201 Example Willow Drive, Springfield, CA 90000" autoComplete="off" aria-label="Address" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3" style={{ gap: 12 }}>
                <div className="field">
                  <label htmlFor="edit-city">City</label>
                  <input id="edit-city" name="city" defaultValue={extra?.city ?? ""} placeholder="Springfield" autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor="edit-state">State</label>
                  <input id="edit-state" name="state" defaultValue={extra?.state ?? ""} placeholder="CA" maxLength={2} autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor="edit-zip">Zip</label>
                  <input id="edit-zip" name="zip" defaultValue={extra?.zip ?? ""} placeholder="90000" autoComplete="off" />
                </div>
              </div>
            </div>
          </div>
          <div className="lset__row">
            <div>
              <label htmlFor="edit-slug" className="lset__label">Portal id</label>
              <p className="lset__hint">Letters, numbers and dashes. Changing it changes the client&apos;s link to this gallery.</p>
            </div>
            <div className="lset__fields">
              <div className="field">
                <input id="edit-slug" name="slug" defaultValue={listing.slug} pattern="[A-Za-z0-9-]+" placeholder="3201-example-willow-drive" autoComplete="off" style={{ fontFamily: "var(--font-mono)", fontSize: 14 }} />
              </div>
            </div>
          </div>
          {extra?.dropboxFolder && (
            <div className="lset__row">
              <div>
                <span className="lset__label">Dropbox folder</span>
                <p className="lset__hint">Raw photos go to Photo and raw clips to Video when they are uploaded. Once the delivery email is sent, every file the client can see is copied to {FINAL_DELIVERY_FOLDER}. Kept through address edits, so no file is stranded.</p>
              </div>
              <div className="lset__fields">
                <p className="adm-mono" style={{ margin: 0, fontSize: 13, wordBreak: "break-all" }}>
                  <a href={dropboxWebUrl(extra.dropboxFolder)} target="_blank" rel="noreferrer" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{extra.dropboxFolder}</a>
                </p>
                {finals && finals.visible > 0 && (
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
                    {extra.deliveryEmailAt
                      ? `${FINAL_DELIVERY_FOLDER}: ${finals.copied} of ${finals.visible} delivered file${finals.visible === 1 ? "" : "s"} copied${finals.copied < finals.visible ? ", the rest within a few minutes" : ""}.`
                      : `${FINAL_DELIVERY_FOLDER} fills when the delivery email is sent.`}
                  </p>
                )}
                {extra.dropboxFolder.split("/").pop() !== listing.address.replace(/[\\/]+/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "") && (
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>The folder was named for an earlier address. The files stay there; rename the folder in Dropbox if you want it to match.</p>
                )}
              </div>
            </div>
          )}
          <div className="lset__row">
            <div>
              <label htmlFor="edit-client" className="lset__label">Client</label>
              <p className="lset__hint">Who signs in to see this gallery. Their team sees it too.</p>
            </div>
            <div className="lset__fields">
              <div className="field">
                <SearchSelect
                  id="edit-client"
                  name="clientId"
                  defaultValue={listing.clientId}
                  options={[...(clients.some((c) => c.id === listing.clientId) ? [] : [{ value: listing.clientId, label: listing.clientName ?? listing.clientEmail, sub: listing.clientName ? listing.clientEmail : null }]), ...clients.map(clientPick)]}
                  title="Choose the client"
                  searchPlaceholder="Search name, company or email"
                />
              </div>
            </div>
          </div>
          <div className="lset__row">
            <div>
              <label htmlFor="edit-shootDate" className="lset__label">Shoot</label>
              <p className="lset__hint">The shoot date, and whether the property is under NDA.</p>
            </div>
            <div className="lset__fields">
              <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 12, alignItems: "center" }}>
                <div className="field">
                  <input id="edit-shootDate" name="shootDate" type="date" defaultValue={listing.shootDate ?? ""} aria-label="Shoot date" />
                </div>
                <label className="flex items-center" style={{ gap: 10, fontSize: 14, minHeight: 44 }}>
                  <input type="checkbox" name="nda" defaultChecked={listing.nda} style={{ width: 18, height: 18 }} /> NDA listing (hidden from partners)
                </label>
              </div>
            </div>
          </div>
          <div className="lset__row">
            <div>
              <label htmlFor="edit-pictime" className="lset__label">Pic-Time gallery</label>
              <p className="lset__hint">The link to this listing&apos;s Pic-Time gallery. When it&apos;s set, the client portal and the delivery email send the client there, and the delivery email can go before any photos are uploaded here.</p>
            </div>
            <div className="lset__fields">
              <div className="field">
                <input id="edit-pictime" name="picTimeUrl" type="url" inputMode="url" defaultValue={extra?.picTimeUrl ?? ""} placeholder="https://showcasemediallc.pic-time.com/..." autoComplete="off" />
              </div>
            </div>
          </div>
          <div className="lset__row">
            <div>
              <label htmlFor="edit-links" className="lset__label">Links under the gallery</label>
              <p className="lset__hint">One per line, as Label | https://url.</p>
            </div>
            <div className="lset__fields">
              <div className="field">
                <textarea id="edit-links" name="links" defaultValue={linksToLines(extra?.links)} placeholder={"3D tour | https://...\nProperty site | https://..."} style={{ minHeight: 84, fontFamily: "var(--font-mono)", fontSize: 13 }} />
              </div>
            </div>
          </div>
          <div className="lset__row">
            <div>
              <label htmlFor="edit-notes" className="lset__label">Notes for the team</label>
              <p className="lset__hint">Access quirks, what the client asked for. Never shown to the client.</p>
            </div>
            <div className="lset__fields">
              <div className="field">
                <textarea id="edit-notes" name="notes" defaultValue={extra?.notes ?? ""} placeholder="Access quirks, what the client asked for" style={{ minHeight: 84 }} />
              </div>
            </div>
          </div>
          <div className="lset__foot">
            {!editor && <span className="faint" style={{ fontSize: 12.5, marginRight: "auto" }}>Demo mode: nothing is saved.</span>}
            <button type="submit" className="btn btn-primary">Save changes</button>
          </div>
        </form>
      </section>
      )}

      {/* ---- Shoots ---- */}
      <section id="shoots" className="lsn-section">
        <SectionTitle title="Shoots" sub="Every shoot uploaded for this listing, the originals corrected files replaced, and the client's revision requests.">
          {admin && <Link href={`/admin/upload?listingId=${listing.id}&clientId=${listing.clientId}`} className="adm-chip">Upload another</Link>}
        </SectionTitle>
        {shoots.length === 0 ? (
          <Empty>No shoots uploaded yet for this listing.</Empty>
        ) : (
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table adm-table--stack">
                <tbody>
                  {shoots.map((s) => (
                    <tr key={s.id}>
                      <td><ShootPill s={s.status} /></td>
                      <td className="adm-mono">{s.fileCount} files{s.photoCount ? ` · ${s.photoCount} frames` : ""}</td>
                      <td className="muted">{s.options?.modelName ?? "Aura"}{s.options?.twilight?.enabled ? ` · twilight ${s.options.twilight.count}` : ""}</td>
                      <td className="adm-mono muted" style={{ whiteSpace: "nowrap" }}>{fmtWhen(s.submittedAt ?? s.createdAt)} · {s.createdBy}</td>
                      <td className="muted" style={{ fontSize: 12.5 }}>{(() => { const internal = rows.filter((m) => m.shootId === s.id && !(m.qcState === "approved" && m.published && m.shootPublished)).length; return internal ? `${internal} internal only` : ""; })()}</td>
                      <td style={{ textAlign: "right" }}><Link href={`/admin/shoots/${s.id}`} className="adm-chip adm-chip--quiet">{s.status === "ready_for_review" ? "Review →" : "Open"}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {finalsShoot && (
          <p className="muted" style={{ fontSize: 13, margin: "16px 0 0" }}>
            Corrected JPGs: drop them in <a href="#upload" className="adm-link">Upload photos</a> above. A filename that matches a frame replaces it on its shoot. The shoot page has the same upload and Publish: <Link href={`/admin/shoots/${finalsShoot.id}#finals`} className="adm-link">open the shoot →</Link>
          </p>
        )}

        {replacedOriginals.length > 0 && (
          <details className="lsn-block" style={{ marginTop: 22 }}>
            <summary className="kicker" style={{ cursor: "pointer" }}>Replaced originals · {replacedOriginals.length} · internal only</summary>
            <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>The files a corrected upload replaced, kept in storage. Clients never see these.</p>
            <div className="adm-table-wrap" style={{ marginTop: 12 }}>
              <div className="adm-table-scroll">
                <table className="adm-table adm-table--stack">
                  <tbody>
                    {replacedOriginals.map((r) => (
                      <tr key={r.id}>
                        <td className="adm-mono">{r.filename}</td>
                        <td className="adm-mono muted" style={{ whiteSpace: "nowrap" }}>replaced {fmtWhen(r.at)}{r.by ? ` · ${r.by}` : ""}</td>
                        <td style={{ textAlign: "right" }}><a href={r.href} className="adm-chip adm-chip--quiet">Download original</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </details>
        )}

        {revisionRequests.length > 0 && (
          <div className="lsn-block" style={{ marginTop: 28 }}>
            <BlockHead title={`Revision requests · ${openRevs.length} open`} href={admin ? "/admin/revisions" : undefined} label="Manage →" />
            <div style={{ display: "grid", gap: 10 }}>
              {revisionRequests.map((r) => (
                <div key={r.id} className="adm-card">
                  <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                    <span className="adm-mono">{fmtWhen(r.createdAt)}</span>{admin ? ` · ${r.clientEmail}` : ""} · {r.status.replace("_", " ")}{r.resolvedAt ? ` · done ${fmtDay(r.resolvedAt)}` : ""}
                  </p>
                  {r.notes.trim() && <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{r.notes}</p>}
                  {r.items.length > 0 ? (
                    <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
                      {r.items.map((it) => (
                        <li key={it.id} style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                          <span className="adm-mono muted" style={{ fontSize: 11.5 }}>{it.filename}</span>
                          {it.sent ? null : <span style={{ color: "#9A6400", fontSize: 11.5 }}> · not sent yet</span>}
                          <div style={{ whiteSpace: "pre-wrap" }}>{it.note}</div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    r.filenames.length > 0 && <p className="muted adm-mono" style={{ margin: "8px 0 0", fontSize: 12 }}>{r.filenames.join(", ")}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ---- Orders and downloads (the QA team: the zips only) ---- */}
      <section id="orders" className="lsn-section">
        <SectionTitle title={admin ? "Orders and downloads" : "Download zips"} sub={admin ? "Invoices, the download zips, and what the client has downloaded." : "The client's Download all zips. They hold client visible photos only."} />
        <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 16 }}>
          {admin && (
          <div className="adm-card" style={{ borderRadius: 14 }}>
            <BlockHead title="Invoices" />
            {invoices.length === 0 ? (
              <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>None yet. Bookings create one at intake; the Stripe webhook links older ones by property address.</p>
            ) : (
              invoices.map((inv) => (
                <p key={inv.id} style={{ fontSize: 14, margin: "0 0 6px" }}>
                  <code className="adm-mono">{inv.providerId ?? inv.stripeInvoiceId ?? inv.id.slice(0, 8)}</code>
                  {inv.provider ? <span className="muted"> · {inv.provider}</span> : null} · {inv.status.replace("_", " ")}
                  {inv.method ? <span className="muted"> · {inv.method.replace("_", " ")}</span> : null}
                  {inv.amountCents != null && <> · <span className="adm-mono">${(inv.amountCents / 100).toLocaleString()}</span></>}
                  {inv.hostedUrl && <> · <a href={inv.hostedUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>view</a></>}
                </p>
              ))
            )}
          </div>
          )}
          <div className="adm-card" style={{ borderRadius: 14, display: "grid", gap: 10, alignContent: "start" }}>
            <BlockHead title="Download zips" />
            {storage ? (
              <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                <span className="adm-pill" style={zipFull ? PILL_LIVE : PILL_HIDDEN}>{zipFull ? "Full size ready" : "Full size not built"}</span>
                <span className="adm-pill" style={zipMls ? PILL_LIVE : PILL_HIDDEN}>{zipMls ? "MLS size ready" : "MLS size not built"}</span>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Storage not connected, so there are no zips here.</p>
            )}
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Zips rebuild on their own after uploads, reorders and deletions. Rebuild by hand if a download looks stale.</p>
            <form action={rebuildBundles.bind(null, listing.id)}>
              <button type="submit" className="adm-chip">Rebuild zips</button>
            </form>
          </div>
        </div>
        {admin && (
        <div className="lsn-block" style={{ marginTop: 24 }}>
          <BlockHead title="Downloads" href={`/admin/downloads?listingId=${listing.id}`} label="All →" />
          {downloads.length === 0 ? (
            <Empty>No downloads yet.</Empty>
          ) : (
            <div className="adm-table-wrap">
              <table className="adm-table adm-table--stack">
                <tbody>
                  {downloads.slice(0, 6).map((x, i) => (
                    <tr key={i}>
                      <td className="adm-mono" style={{ whiteSpace: "nowrap" }}>{fmtWhen(x.at)}</td>
                      <td className="muted">{x.clientEmail}</td>
                      <td className="adm-mono" style={{ fontSize: 12 }}>{x.filename}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}
      </section>

      {/* ---- Activity ---- */}
      <section id="activity" className="lsn-section">
        <SectionTitle title="Activity" sub="Who did what on this listing, newest first." />
        <ActivityFeed rows={activity} showWhere={false} />

        {admin && (
        <div className="lsn-block" style={{ marginTop: 40 }}>
          <BlockHead title="Danger zone" />
          <div className="adm-card" style={{ display: "grid", gap: 12, borderRadius: 14, marginBottom: 14 }}>
            <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
              Same property as another listing? Merge moves its bookings, invoices, files and history onto the listing you keep, then deletes this one. You see a preview first.
            </p>
            <div className="adm-actions">
              <Link href={`/admin/listings/${listing.id}/merge`} className="adm-chip">Merge into another listing…</Link>
            </div>
          </div>
          <form action={deleteListing.bind(null, listing.id)} className="adm-card" style={{ display: "grid", gap: 12, borderColor: "rgba(215,52,42,.35)", borderRadius: 14 }}>
            <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
              Delete listing. This removes the listing and its file list, shoots, revision requests and download history from the portal. Files stay in storage. A listing with a booking cannot be deleted; cancel the booking first.
            </p>
            <div className="adm-actions" style={{ alignItems: "center" }}>
              <div className="field" style={{ margin: 0, flex: "0 1 220px" }}>
                <input name="confirm" placeholder="Type DELETE" required autoComplete="off" aria-label="Type DELETE to confirm" style={{ padding: "10px 14px", fontSize: 14 }} />
              </div>
              <button type="submit" className="adm-chip adm-chip--danger">Delete listing</button>
            </div>
          </form>
        </div>
        )}
      </section>
    </section>
  );
}
