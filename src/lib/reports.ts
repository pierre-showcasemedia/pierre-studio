// Reports (admin only, Oct 21 2026): the numbers behind /admin/reports and
// its CSV downloads. Pure: every function here works on normalized rows
// (src/lib/reports-data.ts loads them from the database, or from the demo
// ledger when there is none) and a date range of local calendar days, so
// the page, the CSV route and a script all add up the same way.
//
// Money is cents everywhere in here. It renders on the admin page and in the
// CSV and nowhere else: nothing in this file posts, emails or logs amounts.
import { addDaysYmd, localYmd } from "./local-date";
import { BOOKING_STATUS_LABEL, BOOKING_STATUS_ORDER } from "./booking-status";
import { business } from "./business";

// The pay rates from src/lib/business.ts.
export const payRates = (): PayRates => ({ perShoot: business.shooterPay.perShoot, byItem: business.shooterPay.byItem, countVisits: business.shooterPay.countVisits, percentOfCollected: business.shooterPay.percentOfCollected });

// ---- Range -------------------------------------------------------------------

export type ReportRange = { from: string; to: string }; // YYYY-MM-DD, inclusive, local

export const REPORT_SECTIONS = ["revenue", "bookings", "unpaid", "revisions", "shooters", "pay", "clients"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];
export const isReportSection = (s: string): s is ReportSection => (REPORT_SECTIONS as readonly string[]).includes(s);
export const SECTION_TITLES: Record<ReportSection, string> = {
  revenue: "Revenue by month",
  bookings: "Bookings by status",
  unpaid: "Unpaid invoices",
  revisions: "Revisions per client",
  shooters: "Shoots per shooter",
  pay: "Shooter pay",
  clients: "Clients",
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// The default is the last 90 days, ending today (local).
export function defaultRange(today = localYmd()): ReportRange {
  return { from: addDaysYmd(today, -90), to: today };
}

export function parseRange(sp: { from?: string | null; to?: string | null }, today = localYmd()): ReportRange {
  const d = defaultRange(today);
  let from = sp.from && YMD.test(sp.from) ? sp.from : d.from;
  let to = sp.to && YMD.test(sp.to) ? sp.to : d.to;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

export const inRange = (ymd: string | null | undefined, r: ReportRange): boolean => Boolean(ymd) && (ymd as string) >= r.from && (ymd as string) <= r.to;
export const monthOf = (ymd: string): string => ymd.slice(0, 7);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}

// Every YYYY-MM the range touches, oldest first, so a quiet month still shows a row.
export function monthsIn(r: ReportRange): string[] {
  const out: string[] = [];
  let [y, m] = r.from.split("-").map(Number);
  const end = monthOf(r.to);
  for (let i = 0; i < 600; i++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    out.push(ym);
    if (ym >= end) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// Whole days between two local calendar dates.
export const daysBetween = (fromYmd: string, toYmd: string): number => Math.round((Date.parse(`${toYmd}T12:00:00Z`) - Date.parse(`${fromYmd}T12:00:00Z`)) / 86_400_000);

// ---- Rows --------------------------------------------------------------------
// Dates are local calendar days (YYYY-MM-DD); money is cents.

export type RInvoice = {
  id: string;
  status: string;
  provider: string | null; // stripe | titus | null
  method: string | null; // card | pay_at_close | other
  amountCents: number;
  refundedCents: number;
  paidYmd: string | null;
  createdYmd: string;
  clientEmail: string | null;
  clientName: string | null;
  clientCompany: string | null;
  listingId: string | null;
  address: string | null;
  bookingId: string | null;
};
export type RBooking = {
  id: string;
  status: string;
  // The shoot date, or the request date when the booking has no date yet:
  // what "in the range" and "per month" key on.
  dateYmd: string;
  shootYmd: string | null;
  createdYmd: string;
  photographerEmail: string | null;
  clientEmail: string;
  clientName: string | null;
  clientCompany: string | null;
  listingId: string;
  address: string;
  serviceIds?: string[]; // the size first, then the package or service (shooter pay by job type)
  servicesLabel?: string | null;
};
// An additional shoot on a booking (return trip, pickup, reshoot, twilight).
export type RVisit = { id: string; bookingId: string; kind: string; status: string; ymd: string; photographerEmail: string | null; address: string };
export type RRevision = { id: string; status: string; createdYmd: string; clientEmail: string; clientName: string | null; items: number; listingId: string; address: string };
export type RShoot = { id: string; createdBy: string; ymd: string; status: string; listingId: string; address: string };
export type ReportRows = { invoices: RInvoice[]; bookings: RBooking[]; revisions: RRevision[]; shoots: RShoot[]; visits?: RVisit[] };

// ---- Money words -----------------------------------------------------------------

// Paid: the two paid statuses plus refunded (paid, then given back in full:
// the gross counts in its month and the refund nets it out, so the month
// reads what the bank saw).
export const REVENUE_STATUSES = new Set(["paid", "paid_manual", "refunded"]);
export const UNPAID_STATUSES = new Set(["open", "needs_quote", "processing", "review"]);

export type ProviderKey = "stripe" | "pay_at_close" | "other";
export const PROVIDER_LABELS: Record<ProviderKey, string> = { stripe: "Stripe card", pay_at_close: "Pay at close", other: "Other" };
export function providerKey(i: { provider: string | null; method: string | null }): ProviderKey {
  if (i.provider === "titus" || i.method === "pay_at_close") return "pay_at_close";
  if (i.provider === "stripe" || i.method === "card") return "stripe";
  return "other";
}
// What a row gave back: a full refund with no amount recorded is the whole invoice.
export const refundOf = (i: { status: string; amountCents: number; refundedCents: number }): number => (i.status === "refunded" ? (i.refundedCents > 0 ? i.refundedCents : i.amountCents) : i.refundedCents);

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  needs_quote: "Needs quote",
  open: "Unpaid",
  processing: "In progress",
  review: "In review",
  paid: "Paid",
  paid_manual: "Paid by hand",
  refunded: "Refunded",
};
export const invoiceStatusLabel = (s: string): string => INVOICE_STATUS_LABEL[s] ?? s.replace(/_/g, " ");
export const methodLabel = (i: { provider: string | null; method: string | null }): string => PROVIDER_LABELS[providerKey(i)];

// "$1,150" when whole dollars, "$1,150.50" otherwise.
export function fmtCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = abs % 100 === 0;
  const s = (abs / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return `${neg ? "-" : ""}$${s}`;
}
// CSV money: a plain decimal, no symbol, no thousands separator.
export const csvDollars = (cents: number): string => (cents / 100).toFixed(2);

// ---- 1. Revenue by month -------------------------------------------------------------

export type RevenueMonth = { month: string; stripe: number; payAtClose: number; other: number; gross: number; refunds: number; net: number; invoices: number };

const emptyMonth = (month: string): RevenueMonth => ({ month, stripe: 0, payAtClose: 0, other: 0, gross: 0, refunds: 0, net: 0, invoices: 0 });

export function revenueByMonth(rows: ReportRows, r: ReportRange): { months: RevenueMonth[]; total: RevenueMonth } {
  const by = new Map<string, RevenueMonth>(monthsIn(r).map((m) => [m, emptyMonth(m)]));
  const total = emptyMonth("Total");
  for (const i of rows.invoices) {
    if (!REVENUE_STATUSES.has(i.status) || !i.paidYmd || !inRange(i.paidYmd, r)) continue;
    const m = by.get(monthOf(i.paidYmd)) ?? emptyMonth(monthOf(i.paidYmd));
    by.set(m.month, m);
    const refund = refundOf(i);
    for (const t of [m, total]) {
      t[providerKey(i) === "stripe" ? "stripe" : providerKey(i) === "pay_at_close" ? "payAtClose" : "other"] += i.amountCents;
      t.gross += i.amountCents;
      t.refunds += refund;
      t.net += i.amountCents - refund;
      t.invoices += 1;
    }
  }
  return { months: [...by.values()].sort((a, b) => a.month.localeCompare(b.month)), total };
}

// ---- 2. Bookings by status ----------------------------------------------------------

export type StatusCount = { status: string; label: string; count: number };
export type BookingMonth = { month: string; requested: number; confirmed: number; shot: number; delivered: number; canceled: number; total: number };

export function bookingsReport(rows: ReportRows, r: ReportRange): { byStatus: StatusCount[]; byMonth: BookingMonth[]; total: number } {
  const inR = rows.bookings.filter((b) => inRange(b.dateYmd, r));
  const byStatus: StatusCount[] = BOOKING_STATUS_ORDER.map((s) => ({ status: s, label: BOOKING_STATUS_LABEL[s], count: inR.filter((b) => b.status === s).length }));
  const other = inR.filter((b) => !(BOOKING_STATUS_ORDER as string[]).includes(b.status)).length;
  if (other) byStatus.push({ status: "other", label: "Other", count: other });
  const months = new Map<string, BookingMonth>(monthsIn(r).map((m) => [m, { month: m, requested: 0, confirmed: 0, shot: 0, delivered: 0, canceled: 0, total: 0 }]));
  for (const b of inR) {
    const m = months.get(monthOf(b.dateYmd)) ?? { month: monthOf(b.dateYmd), requested: 0, confirmed: 0, shot: 0, delivered: 0, canceled: 0, total: 0 };
    months.set(m.month, m);
    if (b.status in m && b.status !== "month" && b.status !== "total") (m as unknown as Record<string, number>)[b.status] += 1;
    m.total += 1;
  }
  return { byStatus, byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)), total: inR.length };
}

// ---- 3. Unpaid invoices --------------------------------------------------------------

export type UnpaidRow = {
  id: string;
  status: string;
  clientEmail: string | null;
  clientName: string | null;
  address: string | null;
  listingId: string | null;
  amountCents: number;
  ageDays: number;
  provider: string | null;
  method: string | null;
  bookingId: string | null;
  href: string | null;
};

// Every open invoice right now (not range filtered: a debt is a debt), oldest first.
export function unpaidInvoices(rows: ReportRows, today = localYmd()): UnpaidRow[] {
  return rows.invoices
    .filter((i) => UNPAID_STATUSES.has(i.status))
    .map((i) => ({
      id: i.id,
      status: i.status,
      clientEmail: i.clientEmail,
      clientName: i.clientName,
      address: i.address,
      listingId: i.listingId,
      amountCents: i.amountCents,
      ageDays: Math.max(0, daysBetween(i.createdYmd, today)),
      provider: i.provider,
      method: i.method,
      bookingId: i.bookingId,
      href: i.bookingId ? `/admin/bookings/${i.bookingId}` : i.listingId ? `/admin/listings/${i.listingId}` : null,
    }))
    .sort((a, b) => b.ageDays - a.ageDays || b.amountCents - a.amountCents);
}

export const sumCents = (xs: { amountCents: number }[]): number => xs.reduce((a, x) => a + x.amountCents, 0);

// ---- 4. Revisions per client --------------------------------------------------------

export type RevisionClientRow = { clientEmail: string; clientName: string | null; requests: number; items: number; open: number; done: number };

export function revisionsPerClient(rows: ReportRows, r: ReportRange): RevisionClientRow[] {
  const by = new Map<string, RevisionClientRow>();
  for (const v of rows.revisions) {
    if (!inRange(v.createdYmd, r)) continue;
    const key = v.clientEmail.toLowerCase();
    const row = by.get(key) ?? { clientEmail: v.clientEmail, clientName: v.clientName, requests: 0, items: 0, open: 0, done: 0 };
    by.set(key, row);
    row.requests += 1;
    row.items += v.items;
    if (v.status === "done") row.done += 1;
    else row.open += 1;
    if (!row.clientName && v.clientName) row.clientName = v.clientName;
  }
  return [...by.values()].sort((a, b) => b.requests - a.requests || b.items - a.items || a.clientEmail.localeCompare(b.clientEmail));
}

// ---- 5. Shoots per shooter ----------------------------------------------------------

export const UNASSIGNED = "(unassigned)";
export type ShooterMonthRow = { shooter: string; month: string; bookings: number; uploads: number };
export type ShooterTotal = { shooter: string; bookings: number; uploads: number };

// Bookings (not canceled) by photographer and shoot month; uploads (the shoots
// table, drafts left out) by who submitted them and the month they did.
export function shootsPerShooter(rows: ReportRows, r: ReportRange): { rows: ShooterMonthRow[]; totals: ShooterTotal[] } {
  const by = new Map<string, ShooterMonthRow>();
  const at = (shooter: string, month: string) => {
    const key = `${shooter}\u0000${month}`;
    const row = by.get(key) ?? { shooter, month, bookings: 0, uploads: 0 };
    by.set(key, row);
    return row;
  };
  for (const b of rows.bookings) {
    if (b.status === "canceled" || !inRange(b.dateYmd, r)) continue;
    at(b.photographerEmail?.trim().toLowerCase() || UNASSIGNED, monthOf(b.dateYmd)).bookings += 1;
  }
  for (const s of rows.shoots) {
    if (s.status === "draft" || !inRange(s.ymd, r)) continue;
    at(s.createdBy.trim().toLowerCase(), monthOf(s.ymd)).uploads += 1;
  }
  const totals = new Map<string, ShooterTotal>();
  for (const row of by.values()) {
    const t = totals.get(row.shooter) ?? { shooter: row.shooter, bookings: 0, uploads: 0 };
    totals.set(row.shooter, t);
    t.bookings += row.bookings;
    t.uploads += row.uploads;
  }
  // Busiest shooter first; the unassigned bucket last. Months oldest first inside.
  const order = [...totals.values()].sort((a, b) => (a.shooter === UNASSIGNED ? 1 : 0) - (b.shooter === UNASSIGNED ? 1 : 0) || b.bookings + b.uploads - (a.bookings + a.uploads) || a.shooter.localeCompare(b.shooter));
  const rank = new Map(order.map((t, i) => [t.shooter, i]));
  const list = [...by.values()].sort((a, b) => rank.get(a.shooter)! - rank.get(b.shooter)! || a.month.localeCompare(b.month));
  return { rows: list, totals: order };
}

// ---- 5b. Shooter pay ----------------------------------------------------------------------
// Every shoot a shooter was on in the range (bookings by shoot date, canceled
// ones left out; return trips and other additional shoots too when
// business.shooterPay.countVisits), and what they are owed at the rates in
// src/lib/business.ts. A shoot with no rate shows as "Rate not set" and stays
// out of the total: the report never makes a number up.

// basis: how the pay was worked out. "rate": a per-shoot or job-type rate;
// "percent": a share of collectedCents; "uncollected": percent, nothing
// collected yet; "included": an additional shoot paid as part of its booking;
// "none": no rate (rateCents null).
export type PayBasis = "rate" | "percent" | "uncollected" | "included" | "none";
export type PayLine = { shooter: string; ymd: string; address: string; what: string; kind: "booking" | "visit"; bookingId: string; status: string; rateCents: number | null; basis: PayBasis; collectedCents: number | null };
export type PayTotal = { shooter: string; shoots: number; rated: number; unrated: number; uncollected: number; payCents: number };
export type PayRates = { perShoot: Readonly<Record<string, number>>; byItem: Readonly<Record<string, Readonly<Record<string, number>>>>; countVisits: boolean; percentOfCollected?: number | null };

// A shooter's rate for one shoot: a job-type rate for the first of the
// booking's items that has one, else their per-shoot rate, else null.
export function shooterRate(rates: PayRates, shooter: string, itemIds: readonly string[]): number | null {
  const email = shooter.trim().toLowerCase();
  const byItem = rates.byItem[email];
  if (byItem) for (const id of itemIds) if (typeof byItem[id] === "number") return byItem[id];
  const flat = rates.perShoot[email];
  return typeof flat === "number" ? flat : null;
}

export const PAY_BASIS_LABEL: Record<PayBasis, string> = { rate: "Rate", percent: "Share of collected", uncollected: "Not collected yet", included: "Part of the booking", none: "Rate not set" };

export function shooterPay(rows: ReportRows, r: ReportRange, rates: PayRates): { lines: PayLine[]; totals: PayTotal[] } {
  const lines: PayLine[] = [];
  const byBooking = new Map(rows.bookings.map((b) => [b.id, b]));
  // What each booking has collected so far: its paid invoices (add-on
  // invoices too), net of refunds, whenever they were paid.
  const collected = new Map<string, number>();
  for (const i of rows.invoices) {
    if (!i.bookingId || !REVENUE_STATUSES.has(i.status)) continue;
    collected.set(i.bookingId, (collected.get(i.bookingId) ?? 0) + i.amountCents - refundOf(i));
  }
  const pct = typeof rates.percentOfCollected === "number" && rates.percentOfCollected > 0 ? rates.percentOfCollected : null;
  for (const b of rows.bookings) {
    if (b.status === "canceled" || !b.shootYmd || !inRange(b.shootYmd, r) || !b.photographerEmail?.trim()) continue;
    const shooter = b.photographerEmail.trim().toLowerCase();
    const rate = shooterRate(rates, shooter, b.serviceIds ?? []);
    const got = Math.max(0, collected.get(b.id) ?? 0);
    const base = { shooter, ymd: b.shootYmd, address: b.address, what: b.servicesLabel || "Shoot", kind: "booking" as const, bookingId: b.id, status: b.status };
    if (rate != null) lines.push({ ...base, rateCents: rate, basis: "rate", collectedCents: pct ? got : null });
    else if (pct) lines.push({ ...base, rateCents: Math.round((got * pct) / 100), basis: got > 0 ? "percent" : "uncollected", collectedCents: got });
    else lines.push({ ...base, rateCents: null, basis: "none", collectedCents: null });
  }
  if (rates.countVisits) {
    for (const v of rows.visits ?? []) {
      if (v.status === "canceled" || !inRange(v.ymd, r) || !v.photographerEmail?.trim()) continue;
      const shooter = v.photographerEmail.trim().toLowerCase();
      const b = byBooking.get(v.bookingId);
      const rate = shooterRate(rates, shooter, [`visit:${v.kind}`, ...(b?.serviceIds ?? [])]);
      lines.push({ shooter, ymd: v.ymd, address: v.address || b?.address || "", what: `Additional shoot (${v.kind.replace(/_/g, " ")})`, kind: "visit", bookingId: v.bookingId, status: v.status, rateCents: rate ?? (pct ? 0 : null), basis: rate != null ? "rate" : pct ? "included" : "none", collectedCents: null });
    }
  }
  lines.sort((a, b) => a.shooter.localeCompare(b.shooter) || a.ymd.localeCompare(b.ymd) || a.address.localeCompare(b.address));
  const totals = new Map<string, PayTotal>();
  for (const l of lines) {
    const t = totals.get(l.shooter) ?? { shooter: l.shooter, shoots: 0, rated: 0, unrated: 0, uncollected: 0, payCents: 0 };
    totals.set(l.shooter, t);
    t.shoots += 1;
    if (l.rateCents == null) t.unrated += 1;
    else if (l.basis === "uncollected") t.uncollected += 1;
    else {
      t.rated += 1;
      t.payCents += l.rateCents;
    }
  }
  return { lines, totals: [...totals.values()].sort((a, b) => b.shoots - a.shoots || a.shooter.localeCompare(b.shooter)) };
}

// ---- 6. Clients ----------------------------------------------------------------------

export type ClientRow = { clientEmail: string; clientName: string | null; clientCompany: string | null; paidCents: number; refundedCents: number; paidInvoices: number; bookings: number };

// Paid revenue (net of refunds) in the range by paid date, and bookings (not
// canceled) in the range by shoot date, per client. Sorted by revenue.
export function clientsReport(rows: ReportRows, r: ReportRange): ClientRow[] {
  const by = new Map<string, ClientRow>();
  const at = (email: string | null, name: string | null, company: string | null) => {
    const key = (email ?? "").trim().toLowerCase() || "(no email)";
    const row = by.get(key) ?? { clientEmail: key, clientName: name, clientCompany: company, paidCents: 0, refundedCents: 0, paidInvoices: 0, bookings: 0 };
    by.set(key, row);
    if (!row.clientName && name) row.clientName = name;
    if (!row.clientCompany && company) row.clientCompany = company;
    return row;
  };
  for (const i of rows.invoices) {
    if (!REVENUE_STATUSES.has(i.status) || !i.paidYmd || !inRange(i.paidYmd, r)) continue;
    const row = at(i.clientEmail, i.clientName, i.clientCompany);
    const refund = refundOf(i);
    row.paidCents += i.amountCents - refund;
    row.refundedCents += refund;
    row.paidInvoices += 1;
  }
  for (const b of rows.bookings) {
    if (b.status === "canceled" || !inRange(b.dateYmd, r)) continue;
    at(b.clientEmail, b.clientName, b.clientCompany).bookings += 1;
  }
  return [...by.values()].sort((a, b) => b.paidCents - a.paidCents || b.bookings - a.bookings || a.clientEmail.localeCompare(b.clientEmail));
}

// ---- CSV -----------------------------------------------------------------------------

export const csvCell = (v: string | number | null | undefined): string => {
  if (v == null) return "";
  const s = String(v);
  // A cell that starts like a formula is quoted and prefixed so a spreadsheet
  // never runs it (an address or a note is data, not a formula).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const csvLine = (cells: (string | number | null | undefined)[]): string => cells.map(csvCell).join(",");

// The CSV of one section: a filename and every line (header first).
export function sectionCsv(section: ReportSection, rows: ReportRows, r: ReportRange, today = localYmd()): { filename: string; lines: string[] } {
  const filename = `studio-${section}-${r.from}-to-${r.to}.csv`;
  const lines: string[] = [];
  switch (section) {
    case "revenue": {
      const { months, total } = revenueByMonth(rows, r);
      lines.push(csvLine(["Month", "Stripe card", "Pay at close", "Other", "Gross", "Refunds", "Net", "Paid invoices"]));
      for (const m of [...months, total]) lines.push(csvLine([m.month === "Total" ? "Total" : m.month, csvDollars(m.stripe), csvDollars(m.payAtClose), csvDollars(m.other), csvDollars(m.gross), csvDollars(m.refunds), csvDollars(m.net), m.invoices]));
      break;
    }
    case "bookings": {
      const { byStatus, byMonth, total } = bookingsReport(rows, r);
      lines.push(csvLine(["Status", "Bookings"]));
      for (const s of byStatus) lines.push(csvLine([s.label, s.count]));
      lines.push(csvLine(["Total", total]));
      lines.push("");
      lines.push(csvLine(["Month", "Unconfirmed", "Confirmed", "Shot", "Delivered", "Canceled", "Total"]));
      for (const m of byMonth) lines.push(csvLine([m.month, m.requested, m.confirmed, m.shot, m.delivered, m.canceled, m.total]));
      break;
    }
    case "unpaid": {
      lines.push(csvLine(["Client", "Email", "Listing", "Status", "Amount", "Age (days)", "Method", "Provider", "Booking", "Link"]));
      for (const u of unpaidInvoices(rows, today)) lines.push(csvLine([u.clientName, u.clientEmail, u.address, invoiceStatusLabel(u.status), csvDollars(u.amountCents), u.ageDays, methodLabel(u), u.provider, u.bookingId, u.href]));
      break;
    }
    case "revisions": {
      lines.push(csvLine(["Client", "Email", "Requests", "Photo notes", "Open", "Done"]));
      for (const v of revisionsPerClient(rows, r)) lines.push(csvLine([v.clientName, v.clientEmail, v.requests, v.items, v.open, v.done]));
      break;
    }
    case "shooters": {
      const { rows: list, totals } = shootsPerShooter(rows, r);
      lines.push(csvLine(["Shooter", "Month", "Bookings", "Uploads"]));
      for (const s of list) lines.push(csvLine([s.shooter, s.month, s.bookings, s.uploads]));
      for (const t of totals) lines.push(csvLine([t.shooter, "Total", t.bookings, t.uploads]));
      break;
    }
    case "pay": {
      const pay = shooterPay(rows, r, payRates());
      lines.push(csvLine(["Shooter", "Shoot date", "Address", "What", "Status", "Collected", "Pay", "How"]));
      for (const l of pay.lines) lines.push(csvLine([l.shooter, l.ymd, l.address, l.what, l.status, l.collectedCents == null ? "" : csvDollars(l.collectedCents), l.rateCents == null ? "Rate not set" : csvDollars(l.rateCents), PAY_BASIS_LABEL[l.basis]]));
      for (const t of pay.totals) lines.push(csvLine([t.shooter, "Total", `${t.shoots} shoots`, [t.unrated ? `${t.unrated} without a rate` : "", t.uncollected ? `${t.uncollected} not collected yet` : ""].filter(Boolean).join("; "), "", "", csvDollars(t.payCents), ""]));
      break;
    }
    case "clients": {
      lines.push(csvLine(["Client", "Email", "Company", "Paid revenue (net)", "Refunded", "Paid invoices", "Bookings"]));
      for (const c of clientsReport(rows, r)) lines.push(csvLine([c.clientName, c.clientEmail, c.clientCompany, csvDollars(c.paidCents), csvDollars(c.refundedCents), c.paidInvoices, c.bookings]));
      break;
    }
  }
  return { filename, lines };
}
