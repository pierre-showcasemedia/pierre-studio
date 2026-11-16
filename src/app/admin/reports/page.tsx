// Reports (admin only, Oct 21 2026): revenue by month, bookings by status,
// unpaid invoices, revisions per client, shoots per shooter and the top
// clients, for a date range (last 90 days by default), each with a CSV. The
// numbers come from src/lib/reports.ts; the CSV route uses the same functions.
// Money renders here and in the CSV only.
import Link from "next/link";
import "@/styles/admin-reports.css";
import { Empty, PageHead } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";
import { fmtDay } from "@/lib/shoot-status";
import { localYmd, addDaysYmd } from "@/lib/local-date";
import { loadReportRows } from "@/lib/reports-data";
import {
  SECTION_TITLES,
  bookingsReport,
  clientsReport,
  fmtCents,
  invoiceStatusLabel,
  methodLabel,
  monthLabel,
  parseRange,
  revenueByMonth,
  revisionsPerClient,
  payRates,
  shooterPay,
  shootsPerShooter,
  sumCents,
  unpaidInvoices,
  UNASSIGNED,
  type ReportRange,
  type ReportSection,
} from "@/lib/reports";
import { hasDb } from "@/db";
import { TZ_SHORT, business } from "@/lib/business";

export const dynamic = "force-dynamic";

const PILL: Record<string, { bg: string; fg: string }> = {
  needs_quote: { bg: "rgba(154,100,0,.10)", fg: "#9A6400" },
  open: { bg: "rgba(154,100,0,.10)", fg: "#9A6400" },
  processing: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  review: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
};

function Head({ section, range, note }: { section: ReportSection; range: ReportRange; note?: string }) {
  const csv = `/api/studio/reports/${section}?from=${range.from}&to=${range.to}`;
  return (
    <>
      <div className="rp-head">
        <div className="kicker">{SECTION_TITLES[section]}</div>
        <a href={csv} className="adm-chip adm-chip--quiet" download title="Comma separated, opens in Numbers, Excel or Sheets">Download CSV</a>
      </div>
      {note && <p className="rp-sub">{note}</p>}
    </>
  );
}

const Num = ({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) => <td className={`rp-num${muted ? " muted" : ""}`}>{children}</td>;

export default async function AdminReports({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const sp = await searchParams;
  const today = localYmd();
  const range = parseRange(sp, today);
  const rows = await loadReportRows();
  const revenue = revenueByMonth(rows, range);
  const bookings = bookingsReport(rows, range);
  const unpaid = unpaidInvoices(rows, today);
  const revisions = revisionsPerClient(rows, range);
  const shooters = shootsPerShooter(rows, range);
  const pay = shooterPay(rows, range, payRates());
  const clients = clientsReport(rows, range);
  const topByBookings = [...clients].sort((a, b) => b.bookings - a.bookings || b.paidCents - a.paidCents).filter((c) => c.bookings > 0).slice(0, 10);
  const topByRevenue = clients.filter((c) => c.paidInvoices > 0).slice(0, 10);
  const rangeLabel = `${fmtDay(range.from)} to ${fmtDay(range.to)}`;
  const quick = (days: number) => `/admin/reports?from=${addDaysYmd(today, -days)}&to=${today}`;
  const custom = Boolean(sp.from || sp.to);

  return (
    <section className="wrap adm-page">
      <PageHead title="Reports." lede="Revenue, bookings, unpaid invoices, revisions, shooters and clients for a date range. Amounts stay on this page and in the CSV it downloads." />

      <form method="get" className="adm-toolbar" style={{ marginTop: 26 }}>
        <div className="field" style={{ flex: "0 1 180px" }}><label htmlFor="rp-from">From</label><input id="rp-from" type="date" name="from" defaultValue={range.from} max={today} /></div>
        <div className="field" style={{ flex: "0 1 180px" }}><label htmlFor="rp-to">To</label><input id="rp-to" type="date" name="to" defaultValue={range.to} /></div>
        <button type="submit" className="adm-chip" style={{ height: 44, alignSelf: "end" }}>Apply</button>
        {custom && <Link href="/admin/reports" className="adm-chip adm-chip--quiet" style={{ height: 44, alignSelf: "end" }}>Last 90 days</Link>}
      </form>
      <div className="rp-quick">
        <span className="faint" style={{ fontSize: 12.5 }}>{rangeLabel} · {TZ_SHORT} days ·</span>
        <Link href={quick(30)} className="adm-link muted">30 days</Link>
        <span className="faint">·</span>
        <Link href={quick(90)} className="adm-link muted">90 days</Link>
        <span className="faint">·</span>
        <Link href={`/admin/reports?from=${today.slice(0, 4)}-01-01&to=${today}`} className="adm-link muted">This year</Link>
        <span className="faint">·</span>
        <Link href={`/admin/reports?from=2020-01-01&to=${today}`} className="adm-link muted">All time</Link>
      </div>
      {!hasDb() && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>Demo data: a made-up quarter so every section has something to show. Real numbers appear once the database is connected.</p>}

      <div className="rp-stats">
        <div className="rp-stat"><span className="rp-stat__n">{fmtCents(revenue.total.net)}</span><span className="rp-stat__l">Net revenue, {revenue.total.invoices} paid invoice{revenue.total.invoices === 1 ? "" : "s"}</span></div>
        <div className="rp-stat"><span className="rp-stat__n">{bookings.total}</span><span className="rp-stat__l">Bookings in the range</span></div>
        <div className="rp-stat"><span className="rp-stat__n">{fmtCents(sumCents(unpaid))}</span><span className="rp-stat__l">Unpaid now, {unpaid.length} invoice{unpaid.length === 1 ? "" : "s"}</span></div>
        <div className="rp-stat"><span className="rp-stat__n">{revisions.reduce((a, r) => a + r.open, 0)}</span><span className="rp-stat__l">Open revision requests in the range</span></div>
      </div>

      {/* 1. Revenue by month */}
      <div className="adm-section">
        <Head section="revenue" range={range} note="Paid invoices by the month they were paid, split by how: Stripe card, pay at close, or another way marked paid by hand. Refunds are taken off in the month of the original payment; a fully refunded invoice nets to zero." />
        <div className="adm-table-wrap">
          <div className="adm-table-scroll">
            <table className="adm-table rp-table">
              <thead><tr><th>Month</th><th className="rp-num">Stripe card</th><th className="rp-num">Pay at close</th><th className="rp-num">Other</th><th className="rp-num">Gross</th><th className="rp-num">Refunds</th><th className="rp-num">Net</th><th className="rp-num">Invoices</th></tr></thead>
              <tbody>
                {revenue.months.map((m) => (
                  <tr key={m.month}>
                    <td style={{ whiteSpace: "nowrap" }}>{monthLabel(m.month)}</td>
                    <Num muted={!m.stripe}>{fmtCents(m.stripe)}</Num>
                    <Num muted={!m.payAtClose}>{fmtCents(m.payAtClose)}</Num>
                    <Num muted={!m.other}>{fmtCents(m.other)}</Num>
                    <Num>{fmtCents(m.gross)}</Num>
                    <Num muted={!m.refunds}>{m.refunds ? `-${fmtCents(m.refunds)}` : fmtCents(0)}</Num>
                    <Num>{fmtCents(m.net)}</Num>
                    <Num muted={!m.invoices}>{m.invoices}</Num>
                  </tr>
                ))}
                <tr className="rp-total">
                  <td>Total</td>
                  <Num>{fmtCents(revenue.total.stripe)}</Num>
                  <Num>{fmtCents(revenue.total.payAtClose)}</Num>
                  <Num>{fmtCents(revenue.total.other)}</Num>
                  <Num>{fmtCents(revenue.total.gross)}</Num>
                  <Num>{revenue.total.refunds ? `-${fmtCents(revenue.total.refunds)}` : fmtCents(0)}</Num>
                  <Num>{fmtCents(revenue.total.net)}</Num>
                  <Num>{revenue.total.invoices}</Num>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 2. Bookings by status */}
      <div className="adm-section">
        <Head section="bookings" range={range} note="Bookings by their shoot date (the request date when no date is set yet). Unconfirmed is a request nobody has confirmed." />
        <div className="rp-split">
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
            <table className="adm-table rp-table">
              <thead><tr><th>Status</th><th className="rp-num">Bookings</th></tr></thead>
              <tbody>
                {bookings.byStatus.map((s) => <tr key={s.status}><td>{s.label}</td><Num muted={!s.count}>{s.count}</Num></tr>)}
                <tr className="rp-total"><td>Total</td><Num>{bookings.total}</Num></tr>
              </tbody>
            </table>
            </div>
          </div>
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table rp-table">
                <thead><tr><th>Month</th><th className="rp-num">Unconfirmed</th><th className="rp-num">Confirmed</th><th className="rp-num">Shot</th><th className="rp-num">Delivered</th><th className="rp-num">Canceled</th><th className="rp-num">Total</th></tr></thead>
                <tbody>
                  {bookings.byMonth.map((m) => (
                    <tr key={m.month}>
                      <td style={{ whiteSpace: "nowrap" }}>{monthLabel(m.month)}</td>
                      <Num muted={!m.requested}>{m.requested}</Num>
                      <Num muted={!m.confirmed}>{m.confirmed}</Num>
                      <Num muted={!m.shot}>{m.shot}</Num>
                      <Num muted={!m.delivered}>{m.delivered}</Num>
                      <Num muted={!m.canceled}>{m.canceled}</Num>
                      <Num>{m.total}</Num>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Unpaid invoices */}
      <div className="adm-section">
        <Head section="unpaid" range={range} note={`Every invoice still open right now (not limited to the range), oldest first: ${unpaid.length} for ${fmtCents(sumCents(unpaid))}. Age counts from the day the invoice was made.`} />
        {unpaid.length === 0 ? (
          <Empty>Nothing unpaid. Every invoice is settled.</Empty>
        ) : (
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table rp-table">
                <thead><tr><th>Client</th><th>Listing</th><th>Status</th><th className="rp-num">Amount</th><th className="rp-num">Age</th><th>Method</th><th></th></tr></thead>
                <tbody>
                  {unpaid.map((u) => {
                    const c = PILL[u.status] ?? { bg: "rgba(95,100,110,.10)", fg: "#5F646E" };
                    return (
                      <tr key={u.id}>
                        <td><span style={{ fontWeight: 500 }}>{u.clientName ?? u.clientEmail ?? "Unknown"}</span>{u.clientName && u.clientEmail && <div className="muted" style={{ fontSize: 12.5 }}>{u.clientEmail}</div>}</td>
                        <td>{u.listingId ? <Link href={`/admin/listings/${u.listingId}`}>{(u.address ?? "Listing").split(",")[0]}</Link> : (u.address ?? "").split(",")[0]}</td>
                        <td><span className="adm-pill" style={{ background: c.bg, color: c.fg }}>{invoiceStatusLabel(u.status)}</span></td>
                        <Num>{fmtCents(u.amountCents)}</Num>
                        <Num muted>{u.ageDays} d</Num>
                        <td className="muted" style={{ whiteSpace: "nowrap" }}>{methodLabel(u)}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{u.href && <Link href={u.href} className="adm-chip adm-chip--quiet">{u.bookingId ? "Booking" : "Listing"} →</Link>}</td>
                      </tr>
                    );
                  })}
                  <tr className="rp-total"><td>Total</td><td></td><td></td><Num>{fmtCents(sumCents(unpaid))}</Num><td></td><td></td><td></td></tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* 4. Revisions per client */}
      <div className="adm-section">
        <Head section="revisions" range={range} note="Revision requests made in the range, per client: how many requests, how many photo notes inside them, and how many are still open." />
        {revisions.length === 0 ? (
          <Empty>No revision requests in this range.</Empty>
        ) : (
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table rp-table">
                <thead><tr><th>Client</th><th className="rp-num">Requests</th><th className="rp-num">Photo notes</th><th className="rp-num">Open</th><th className="rp-num">Done</th></tr></thead>
                <tbody>
                  {revisions.map((v) => (
                    <tr key={v.clientEmail}>
                      <td><span style={{ fontWeight: 500 }}>{v.clientName ?? v.clientEmail}</span>{v.clientName && <div className="muted" style={{ fontSize: 12.5 }}>{v.clientEmail}</div>}</td>
                      <Num>{v.requests}</Num>
                      <Num muted={!v.items}>{v.items}</Num>
                      <Num muted={!v.open}>{v.open}</Num>
                      <Num muted={!v.done}>{v.done}</Num>
                    </tr>
                  ))}
                  <tr className="rp-total"><td>Total</td><Num>{revisions.reduce((a, r) => a + r.requests, 0)}</Num><Num>{revisions.reduce((a, r) => a + r.items, 0)}</Num><Num>{revisions.reduce((a, r) => a + r.open, 0)}</Num><Num>{revisions.reduce((a, r) => a + r.done, 0)}</Num></tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* 5. Shoots per shooter */}
      <div className="adm-section">
        <Head section="shooters" range={range} note="Bookings by the shooter on them (shoot date in the range, canceled ones left out) and uploads by who submitted them (the shoots table). A booking with nobody on it yet counts as unassigned." />
        {shooters.rows.length === 0 ? (
          <Empty>No shoots in this range.</Empty>
        ) : (
          <div className="rp-split">
            <div className="adm-table-wrap">
              <div className="adm-table-scroll">
              <table className="adm-table rp-table">
                <thead><tr><th>Shooter</th><th className="rp-num">Bookings</th><th className="rp-num">Uploads</th></tr></thead>
                <tbody>
                  {shooters.totals.map((t) => (
                    <tr key={t.shooter}>
                      <td className={t.shooter === UNASSIGNED ? "muted" : ""}>{t.shooter === UNASSIGNED ? "Unassigned" : t.shooter}</td>
                      <Num muted={!t.bookings}>{t.bookings}</Num>
                      <Num muted={!t.uploads}>{t.uploads}</Num>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
            <div className="adm-table-wrap">
              <div className="adm-table-scroll">
                <table className="adm-table rp-table">
                  <thead><tr><th>Shooter</th><th>Month</th><th className="rp-num">Bookings</th><th className="rp-num">Uploads</th></tr></thead>
                  <tbody>
                    {shooters.rows.map((s) => (
                      <tr key={`${s.shooter}:${s.month}`}>
                        <td className={s.shooter === UNASSIGNED ? "muted" : ""}>{s.shooter === UNASSIGNED ? "Unassigned" : s.shooter}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{monthLabel(s.month)}</td>
                        <Num muted={!s.bookings}>{s.bookings}</Num>
                        <Num muted={!s.uploads}>{s.uploads}</Num>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 5b. Shooter pay */}
      {business.shooterPay.enabled && (
        <div className="adm-section" id="pay">
          <Head section="pay" range={range} note="Every shoot a shooter was on (shoot date in the range, canceled ones left out, additional shoots included) and their pay at the rates in src/lib/business.ts (a per-shoot rate, or a share of what the booking has collected). A shoot without a rate shows No rate, and one not paid yet shows Not collected; neither is in the total until it is." />
          {pay.lines.length === 0 ? (
            <Empty>No shoots with a shooter on them in this range.</Empty>
          ) : (
            <div className="rp-split">
              <div className="adm-table-wrap">
                <div className="adm-table-scroll">
                  <table className="adm-table rp-table">
                    <thead><tr><th>Shooter</th><th className="rp-num">Shoots</th><th className="rp-num">Pay</th></tr></thead>
                    <tbody>
                      {pay.totals.map((t) => (
                        <tr key={t.shooter}>
                          <td>{t.shooter}{t.unrated || t.uncollected ? <div className="muted" style={{ fontSize: 12 }}>{[t.unrated ? `${t.unrated} without a rate` : "", t.uncollected ? `${t.uncollected} not collected yet` : ""].filter(Boolean).join(", ")}</div> : null}</td>
                          <Num>{t.shoots}</Num>
                          <Num muted={!t.rated}>{t.rated ? fmtCents(t.payCents) : "No rate"}</Num>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="adm-table-wrap">
                <div className="adm-table-scroll">
                  <table className="adm-table rp-table">
                    <thead><tr><th>Shooter</th><th>Date</th><th>Shoot</th><th className="rp-num">Pay</th></tr></thead>
                    <tbody>
                      {pay.lines.map((l, i) => (
                        <tr key={`${l.bookingId}:${l.kind}:${i}`}>
                          <td style={{ whiteSpace: "normal", wordBreak: "break-all", minWidth: 120 }}>{l.shooter}</td>
                          <td style={{ whiteSpace: "nowrap" }}>{fmtDay(l.ymd)}</td>
                          <td style={{ whiteSpace: "normal", minWidth: 160, maxWidth: 260 }}><Link href={`/admin/bookings/${l.bookingId}`}>{l.address}</Link><div className="muted" style={{ fontSize: 12 }}>{l.what}</div></td>
                          <Num muted={l.basis !== "rate" && l.basis !== "percent"}>{l.basis === "none" ? "No rate" : l.basis === "uncollected" ? "Not collected" : l.basis === "included" ? "In booking" : fmtCents(l.rateCents ?? 0)}</Num>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 6. Clients */}
      <div className="adm-section">
        <Head section="clients" range={range} note="Top clients by paid revenue (net of refunds, by the day it was paid) and by bookings (shoot date in the range, canceled ones left out). The CSV has every client." />
        {clients.length === 0 ? (
          <Empty>No paid invoices or bookings in this range.</Empty>
        ) : (
          <div className="rp-split" style={{ gridTemplateColumns: "1fr" }}>
            <div className="adm-table-wrap">
              <div className="adm-table-scroll">
                <table className="adm-table rp-table">
                  <thead><tr><th>By revenue</th><th>Company</th><th className="rp-num">Paid revenue</th><th className="rp-num">Invoices</th><th className="rp-num">Bookings</th></tr></thead>
                  <tbody>
                    {topByRevenue.map((c) => (
                      <tr key={c.clientEmail}>
                        <td><span style={{ fontWeight: 500 }}>{c.clientName ?? c.clientEmail}</span>{c.clientName && <div className="muted" style={{ fontSize: 12.5 }}>{c.clientEmail}</div>}</td>
                        <td className="muted">{c.clientCompany ?? ""}</td>
                        <Num>{fmtCents(c.paidCents)}</Num>
                        <Num>{c.paidInvoices}</Num>
                        <Num muted={!c.bookings}>{c.bookings}</Num>
                      </tr>
                    ))}
                    {topByRevenue.length === 0 && <tr><td colSpan={5} className="muted">No paid invoices in this range.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="adm-table-wrap">
              <div className="adm-table-scroll">
                <table className="adm-table rp-table">
                  <thead><tr><th>By bookings</th><th>Company</th><th className="rp-num">Bookings</th><th className="rp-num">Paid revenue</th></tr></thead>
                  <tbody>
                    {topByBookings.map((c) => (
                      <tr key={c.clientEmail}>
                        <td><span style={{ fontWeight: 500 }}>{c.clientName ?? c.clientEmail}</span>{c.clientName && <div className="muted" style={{ fontSize: 12.5 }}>{c.clientEmail}</div>}</td>
                        <td className="muted">{c.clientCompany ?? ""}</td>
                        <Num>{c.bookings}</Num>
                        <Num muted={!c.paidCents}>{fmtCents(c.paidCents)}</Num>
                      </tr>
                    ))}
                    {topByBookings.length === 0 && <tr><td colSpan={4} className="muted">No bookings in this range.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
