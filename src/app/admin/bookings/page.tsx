// Bookings (docs/booking-to-payment.md): every booking form
// submission in this environment, upcoming first. Date and time, address,
// client, services, payment method, pay status with the amount (money renders
// only under /admin), calendar sync, shooter and booking status. Filters and
// search are plain GET params so the page is shareable. A row opens its
// booking from anywhere on it; the status select changes the status in place.
import "@/styles/admin-bookings.css";
import Link from "next/link";
import { adminBookings } from "@/lib/admin-data";
import type { BookingFilter } from "@/lib/admin-types";
import { DatePassedPill, Empty, PageHead, PaymentMethod, PayPill, Shooter } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";
import { setBookingStatus } from "../actions";
import { BookingRow } from "./_components/BookingRow";
import { StatusSelect } from "./_components/StatusSelect";

// The status select can cancel (closes the provider object) and sends invites.
export const maxDuration = 60;

const FILTERS: { k: BookingFilter; l: string }[] = [
  { k: "upcoming", l: "Upcoming" },
  { k: "to_confirm", l: "To confirm" },
  { k: "rescheduled", l: "Rescheduled" },
  { k: "needs_quote", l: "Needs quote" },
  { k: "unpaid", l: "Unpaid" },
  { k: "review", l: "In review" },
  { k: "failed", l: "Stopped" },
  { k: "all", l: "All" },
];

const EMPTY: Record<BookingFilter, string> = {
  upcoming: "No upcoming bookings. New requests from the website land here within the minute.",
  to_confirm: "Every request is confirmed.",
  rescheduled: "No client reschedules waiting for a confirmed time.",
  needs_quote: "Nothing is waiting for a quote.",
  unpaid: "Every upcoming booking is paid or waiting on pay at close.",
  review: "No pay at close applications are in review.",
  failed: "No side effects have given up. Nice.",
  all: "No bookings yet.",
};

export default async function AdminBookings({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string; done?: string; error?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const sp = await searchParams;
  const filter = (FILTERS.some((f) => f.k === sp.filter) ? sp.filter : "upcoming") as BookingFilter;
  const rows = await adminBookings({ filter, q: sp.q });
  const href = (k: BookingFilter) => `/admin/bookings?filter=${k}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`;
  // Where the status select brings the admin back to.
  const back = href(filter);
  // Remount the selects after every action so a refused change never lingers.
  const nonce = `${sp.done ?? ""}|${sp.error ?? ""}`;

  return (
    <section className="wrap adm-page">
      <PageHead title="Bookings." lede="Every shoot request from the website: when, where, who, and whether it is paid.">
        <Link href="/admin/upload" className="btn btn-primary">Upload a shoot →</Link>
      </PageHead>

      <form method="get" className="adm-toolbar" style={{ marginTop: 26 }}>
        <input type="hidden" name="filter" value={filter} />
        <div className="field" style={{ maxWidth: 480 }}>
          <input name="q" type="search" enterKeyHint="search" defaultValue={sp.q ?? ""} placeholder="Search address or client" aria-label="Search bookings" />
        </div>
        <button type="submit" className="adm-chip" style={{ height: 44 }}>Search</button>
        {sp.q && <Link href={`/admin/bookings?filter=${filter}`} className="adm-chip adm-chip--quiet" style={{ height: 44 }}>Clear</Link>}
        <span style={{ flex: 1 }} />
        <div className="adm-seg" role="tablist" aria-label="Show" style={{ flexWrap: "wrap" }}>
          {FILTERS.map((f) => (
            <Link key={f.k} href={href(f.k)} className={filter === f.k ? "is-active" : ""} role="tab" aria-selected={filter === f.k}>{f.l}</Link>
          ))}
        </div>
      </form>

      {sp.done && <p className="adm-banner adm-banner--ok" style={{ marginTop: 14 }}>{sp.done}</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 14 }}>{sp.error}</p>}
      <p className="faint" style={{ fontSize: 12.5, marginTop: 14 }}>{rows.length} booking{rows.length === 1 ? "" : "s"}</p>

      {rows.length === 0 ? (
        <Empty>{sp.q ? "No bookings match that search." : EMPTY[filter]}</Empty>
      ) : (
        <div className="adm-table-wrap" style={{ marginTop: 12 }}>
          <div className="adm-table-scroll">
            <table className="adm-table adm-table--custom bk-table">
              <thead>
                <tr><th>When</th><th>Property and client</th><th>Services</th><th>Payment</th><th>Shooter</th><th>Status</th><th aria-label="Open" /></tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const street = b.address.split(",")[0] || "Address missing";
                  const live = b.status === "requested" || b.status === "confirmed";
                  // A return shoot's row (Oct 28 2026, adminBookings): it opens the
                  // booking at its Additional shoots, and has no status select (that
                  // select would change the booking, not this trip).
                  const rowHref = b.visit ? `/admin/bookings/${b.id}#visits` : `/admin/bookings/${b.id}`;
                  return (
                    <BookingRow key={b.visit ? `v-${b.visit.id}` : b.id} href={rowHref} className={b.datePassed ? "bk-row--stale" : ""}>
                      <td className="bk-when">
                        {b.when ?? <span className="muted">Date to confirm</span>}
                        {b.visit ? null : b.movedByClient && b.status !== "canceled" ? (
                          <div className="bk-when__sub"><span className="adm-pill bk-moved" title={b.movedByClient.from ? `Moved by the client. Was ${b.movedByClient.from}` : "Moved by the client"}>Rescheduled · unconfirmed</span></div>
                        ) : b.datePassed ? (
                          <div className="bk-when__sub"><DatePassedPill /></div>
                        ) : b.when && b.status === "requested" ? (
                          <div className="bk-when__sub">Unconfirmed time</div>
                        ) : null}
                      </td>
                      <td className="bk-prop">
                        <Link href={rowHref} className="bk-row__main">{street}</Link>
                        {b.nda && <span className="adm-pill" style={{ marginLeft: 8, background: "rgba(11,12,15,.08)", padding: "4px 8px" }}>NDA</span>}
                        <div className="muted bk-sub">{[b.address.split(",").slice(1).join(",").trim(), b.market].filter(Boolean).join(" · ")}</div>
                        <div className="bk-sub">{b.client.name ?? b.client.email}{b.client.company ? <span className="muted"> · {b.client.company}</span> : null}</div>
                      </td>
                      <td className="muted bk-services">{b.servicesLabel ?? "To confirm"}{b.addonsLabel ? <div className="faint bk-sub">{b.addonsLabel}</div> : null}</td>
                      <td className="bk-pay"><PayPill status={b.invoice?.status} amountCents={b.invoice?.amountCents} />{b.visit ? null : <div className="bk-sub muted"><PaymentMethod m={b.paymentMethod} detail={b.paymentDetail} /></div>}</td>
                      <td className="bk-shoot"><Shooter email={b.photographerEmail} needed={b.visit ? true : live && !b.datePassed} /></td>
                      <td className="bk-stat">
                        {b.visit ? (
                          <span className="adm-pill" style={{ background: "rgba(0,102,214,.10)", color: "#0066D6" }}>Scheduled</span>
                        ) : (
                          <StatusSelect key={`${b.id}:${b.status}:${nonce}`} action={setBookingStatus.bind(null, b.id)} status={b.status} back={back} address={street} />
                        )}
                        {b.deadJobs > 0 && <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--color-live)" }}>{b.deadJobs} side effect{b.deadJobs === 1 ? "" : "s"} gave up</div>}
                      </td>
                      <td className="bk-chev" aria-hidden>›</td>
                    </BookingRow>
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
