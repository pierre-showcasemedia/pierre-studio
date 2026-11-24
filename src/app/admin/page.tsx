import "@/styles/admin-bookings.css";
import Link from "next/link";
import { adminDashboard, listingStatusLabel } from "@/lib/admin-data";
import { pipelineParked } from "@/lib/pipeline";
import { hasDb } from "@/db";
import { fmtDay as fmtYmd, fmtTime12 } from "@/lib/booking-time";
import { fmtDay, fmtWhen } from "@/lib/shoot-status";
import { ActivityFeed, BookingPill, DatePassedPill, Empty, ListingPill, PageHead, SectionHead, Shooter } from "@/components/admin/bits";
import { requireTeam } from "@/lib/admin";
import { redirect } from "next/navigation";
import { BookingRow } from "./bookings/_components/BookingRow";
import { TZ_SHORT } from "@/lib/business";
import { upsellListings } from "@/lib/upsell";

export default async function AdminDashboard() {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  // Admins only since Oct 26 2026: a creative specialist's home is Upload a
  // shoot, a video editor's the Video board, the Photo QC team's the Photo QC
  // board (nothing is read before any of the redirects).
  const staff = await requireTeam();
  if (staff.role === "creative") redirect("/admin/upload");
  // A video editor's home is the Video board, and the Photo QC team's the
  // Photo QC board (Oct 26 2026).
  if (staff.role === "video") redirect("/admin/video");
  if (staff.role !== "admin") redirect("/admin/photo-qc");
  const { attention, upcoming, recentDeliveries, activity, openRevisions, reviewShoots } = await adminDashboard();
  const parked = hasDb() && pipelineParked() && attention.processing > 0;
  const upsells = await upsellListings().catch(() => []);

  const tiles = [
    { n: attention.processing, l: "Shoots in editing", href: "/admin/shoots?status=active", go: "Watch progress" },
    { n: attention.review, l: "Galleries ready for review", href: "/admin/photo-qc", go: "Start QC" },
    { n: attention.revisionsOpen, l: "Open revision requests", href: "/admin/revisions", go: "Open revisions" },
    { n: attention.deliveredUnpaid, l: "Delivered, not yet paid", href: "/admin/listings?status=Awaiting%20Payment", go: "See listings" },
    { n: attention.publishedNoEmail, l: "Published, email not sent", href: "/admin/listings?sort=updated", go: "Send delivery" },
    { n: attention.failed, l: "Shoots that stopped", href: "/admin/shoots?status=failed", go: "Retry" },
    // Step two: bookings and payments.
    { n: attention.toConfirm, l: "Requests to confirm", href: "/admin/bookings?filter=to_confirm", go: "Confirm times" },
    { n: attention.unpaidBookings, l: "Unpaid bookings", href: "/admin/bookings?filter=unpaid", go: "Open bookings" },
    { n: attention.paymentsInReview, l: "Pay at close in review", href: "/admin/bookings?filter=review", go: "See who" },
    { n: attention.failedJobs, l: "Failed side effects", href: "/admin/bookings?filter=failed", go: "Run again" },
  ];

  return (
    <section className="wrap adm-page">
      <PageHead title="Good to see you." lede="What needs a hand today, and the fastest way to the next shoot.">
        <Link href="/admin/upload" className="btn btn-primary" style={{ padding: "12px 20px" }}>Upload a shoot →</Link>
      </PageHead>

      {parked && (
        <p className="adm-banner adm-banner--warn" style={{ marginTop: 22 }}>
          Editing account not connected. Files are safe; processing starts once it is.
        </p>
      )}

      <div className="adm-section" style={{ marginTop: 28 }}>
        <SectionHead title="Needs attention" />
        <div className="adm-tiles">
          {tiles.map((t) => (
            <Link key={t.l} href={t.href} className={`adm-tile${t.n > 0 ? " is-hot" : ""}`}>
              <span className="adm-tile__n">{t.n}</span>
              <span className="adm-tile__l">{t.l}</span>
              <span className="adm-tile__go">{t.n > 0 ? `${t.go} →` : "All clear"}</span>
            </Link>
          ))}
        </div>
      </div>

      <div className="adm-section">
        <SectionHead title="Quick actions" />
        <div className="adm-actions">
          <Link href="/admin/upload" className="btn btn-primary">Upload a shoot →</Link>
          <Link href="/admin/bookings" className="btn btn-ghost">Bookings →</Link>
          <Link href="/admin/listings/new" className="btn btn-ghost">New listing →</Link>
          <Link href="/admin/clients" className="btn btn-ghost">Find a client →</Link>
        </div>
      </div>

      {reviewShoots.length > 0 && (
        <div className="adm-section">
          <SectionHead title="Ready for your review" href="/admin/shoots?status=ready_for_review" />
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table adm-table--stack">
                <tbody>
                  {reviewShoots.map((s) => (
                    <tr key={s.id}>
                      <td><Link href={`/admin/shoots/${s.id}`} style={{ fontWeight: 500 }}>{s.address.split(",")[0]}{s.nda && <span className="adm-pill" style={{ marginLeft: 8, background: "rgba(11,12,15,.08)" }}>NDA</span>}</Link><div className="muted" style={{ fontSize: 12.5 }}>{s.clientName ?? s.clientEmail}</div></td>
                      <td className="adm-mono muted">{s.photoCount} frames{s.options?.twilight?.enabled ? " + twilight" : ""}</td>
                      <td className="adm-mono muted">ready {fmtWhen(s.readyAt)}</td>
                      <td style={{ textAlign: "right" }}><Link href={`/admin/shoots/${s.id}`} className="adm-chip">Review →</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="adm-section">
        <SectionHead title="Upcoming shoots · next 14 days" href="/admin/bookings" label="All bookings →" />
        {upcoming.length === 0 ? (
          <Empty>No shoots on the calendar in the next two weeks.</Empty>
        ) : (
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table adm-table--stack">
                <tbody>
                  {upcoming.map((u) => {
                    const street = u.address.split(",")[0] || "Address missing";
                    return (
                      <BookingRow key={u.key} href={u.href} className={u.datePassed ? "bk-row--stale" : ""}>
                        <td className="bk-up-time">
                          {u.date ? fmtYmd(u.date) : <span className="muted">Date to confirm</span>}
                          <small>{u.time ? `${fmtTime12(u.time)} ${TZ_SHORT}` : u.date ? "Time to confirm" : "No date yet"}</small>
                        </td>
                        <td>
                          <Link href={u.href} className="bk-row__main">{street}</Link>
                          {u.nda && <span className="adm-pill" style={{ marginLeft: 8, background: "rgba(11,12,15,.08)" }}>NDA</span>}
                          <div className="muted" style={{ fontSize: 12.5 }}>{u.clientName ?? u.clientEmail}</div>
                        </td>
                        <td>{u.kind === "booking" ? <Shooter email={u.shooter} needed={!u.datePassed} /> : <span className="faint" style={{ fontSize: 12.5 }}>No booking</span>}</td>
                        <td>
                          <div className="bk-up-flags">
                            {u.datePassed && <DatePassedPill />}
                            {u.returnShoot ? (
                              <span className="adm-pill" style={{ background: "rgba(0,102,214,.10)", color: "#0066D6" }}>Return shoot</span>
                            ) : u.status ? (
                              <BookingPill s={u.status} />
                            ) : (
                              <span className="adm-pill" style={{ background: "rgba(95,100,110,.10)", color: "#5F646E" }}>Shoot date</span>
                            )}
                          </div>
                        </td>
                        <td style={{ textAlign: "right" }}><Link href={`/admin/upload?listingId=${u.listingId}&clientId=${u.clientId}`} className="adm-chip adm-chip--quiet">Upload</Link></td>
                      </BookingRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="adm-section">
        <SectionHead title="Recent deliveries" href="/admin/listings?sort=updated" />
        {recentDeliveries.length === 0 ? (
          <Empty>No delivery emails sent yet.</Empty>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table adm-table--stack">
              <tbody>
                {recentDeliveries.map((l) => (
                  <tr key={l.id}>
                    <td className="adm-mono" style={{ whiteSpace: "nowrap" }}>{fmtDay(l.deliveryEmailAt)}</td>
                    <td><Link href={`/admin/listings/${l.id}`} style={{ fontWeight: 500 }}>{l.address.split(",")[0]}{l.nda && <span className="adm-pill" style={{ marginLeft: 8, background: "rgba(11,12,15,.08)" }}>NDA</span>}</Link><div className="muted" style={{ fontSize: 12.5 }}>{l.clientName ?? l.clientEmail}</div></td>
                    <td style={{ textAlign: "right" }}><ListingPill s={listingStatusLabel(l)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openRevisions.length > 0 && (
        <div className="adm-section">
          <SectionHead title="Open revision requests" href="/admin/revisions" />
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table adm-table--stack">
                <tbody>
                  {openRevisions.slice(0, 4).map((r) => (
                    <tr key={r.id}>
                      <td className="adm-mono" style={{ whiteSpace: "nowrap" }}>{fmtWhen(r.createdAt)}</td>
                      <td><Link href={`/admin/listings/${r.listingId}`} style={{ fontWeight: 500 }}>{r.address.split(",")[0]}</Link><div className="muted" style={{ fontSize: 12.5 }}>{r.clientName ?? r.clientEmail}</div></td>
                      <td className="muted" style={{ maxWidth: 420 }}>{r.notes.length > 110 ? `${r.notes.slice(0, 110)}…` : r.notes}</td>
                      <td style={{ textAlign: "right" }}><ShootPillLike status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {upsells.length > 0 && (
        <div className="adm-section">
          <SectionHead title="Still on the market: suggest something new" />
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table adm-table--stack">
                <tbody>
                  {upsells.slice(0, 8).map((u) => (
                    <tr key={u.listingId}>
                      <td className="adm-mono" style={{ whiteSpace: "nowrap" }}>{u.days} days</td>
                      <td><Link href={`/admin/listings/${u.listingId}`} style={{ fontWeight: 500 }}>{u.address.split(",")[0]}</Link><div className="muted" style={{ fontSize: 12.5 }}>{u.clientName ?? u.clientEmail}</div></td>
                      <td className="muted">{u.items.map((i) => i.name).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="adm-section">
        <SectionHead title="Recent activity" />
        <ActivityFeed rows={activity} />
      </div>
    </section>
  );
}

// The QA team's dashboard (Oct 2026): shoots in editing, ready for review,
// stopped, and published shoots with frames waiting to publish. No bookings,
// payments, deliveries or client admin.
function ShootPillLike({ status }: { status: "new" | "in_progress" | "done" }) {
  const map = {
    new: { bg: "rgba(0,102,214,.09)", fg: "#0066D6", l: "New" },
    in_progress: { bg: "rgba(154,100,0,.10)", fg: "#9A6400", l: "In progress" },
    done: { bg: "rgba(26,127,75,.10)", fg: "#1A7F4B", l: "Done" },
  }[status];
  return <span className="adm-pill" style={{ background: map.bg, color: map.fg }}>{map.l}</span>;
}
