// Loads the rows /admin/reports adds up (src/lib/reports.ts): invoices,
// bookings, revision requests and shoots, normalized to local calendar days.
// Demo rows when there is no database (src/lib/demo-reports.ts).
//
// Environment: invoices and bookings carry env (preview and production share
// one database; rows written before env existed belong to production), so
// only THIS environment's rows count, the same rule as /admin/bookings and
// payments (rowEnv / currentEnv). Shoots and revision requests have no env
// column and are read whole.
import { inArray } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { demoReportRows } from "./demo-reports";
import { currentEnv } from "./jobs-core";
import { localYmd } from "./local-date";
import { rowEnv } from "./payments";
import { REVENUE_STATUSES, UNPAID_STATUSES, type RBooking, type RInvoice, type RRevision, type RShoot, type RVisit, type ReportRows } from "./reports";

const LIMIT = 5000;
const ymd = (d: Date | null | undefined): string | null => (d ? localYmd(d) : null);

export async function loadReportRows(): Promise<ReportRows> {
  if (!hasDb()) return demoReportRows();
  const d = db();
  const env = currentEnv();
  const mine = (e: string | null | undefined) => rowEnv(e) === env;
  const [inv, bk, rev, sh, vis] = await Promise.all([
    d.query.invoices.findMany({
      where: inArray(schema.invoices.status, [...REVENUE_STATUSES, ...UNPAID_STATUSES]),
      with: { listing: { columns: { id: true, address: true } }, client: { columns: { email: true, name: true, company: true } } },
      limit: LIMIT,
    }),
    d.query.bookings.findMany({
      with: { listing: { columns: { id: true, address: true } }, client: { columns: { email: true, name: true, company: true } } },
      limit: LIMIT,
    }),
    d.query.revisionRequests.findMany({
      with: { items: { columns: { id: true } }, listing: { columns: { id: true, address: true }, with: { client: { columns: { name: true } } } } },
      limit: LIMIT,
    }),
    d.query.shoots.findMany({ with: { listing: { columns: { id: true, address: true } } }, limit: LIMIT }),
    d.query.bookingVisits.findMany({ limit: LIMIT }),
  ]);

  const invoices: RInvoice[] = inv
    .filter((i) => mine(i.env))
    .map((i) => ({
      id: i.id,
      status: i.status,
      provider: i.provider ?? (i.stripeInvoiceId ? "stripe" : null),
      method: i.method,
      amountCents: i.amountCents ?? i.amountDue ?? 0,
      refundedCents: i.refundedCents ?? 0,
      paidYmd: ymd(i.paidAt),
      createdYmd: ymd(i.createdAt) ?? localYmd(),
      clientEmail: i.client?.email ?? i.clientEmail ?? null,
      clientName: i.client?.name ?? null,
      clientCompany: i.client?.company ?? null,
      listingId: i.listing?.id ?? i.listingId ?? null,
      address: i.listing?.address ?? i.propertyAddress ?? null,
      bookingId: i.bookingId ?? null,
    }));

  const bookings: RBooking[] = bk
    .filter((b) => mine(b.env))
    .map((b) => {
      const createdYmd = ymd(b.createdAt) ?? localYmd();
      const street = (b.property?.street as string | undefined) ?? "";
      return {
        id: b.id,
        status: b.status,
        dateYmd: b.desiredDate ?? createdYmd,
        shootYmd: b.desiredDate,
        createdYmd,
        photographerEmail: b.photographerEmail,
        clientEmail: b.client?.email ?? "",
        clientName: b.client?.name ?? null,
        clientCompany: b.client?.company ?? null,
        listingId: b.listingId,
        address: b.listing?.address ?? street,
        serviceIds: b.serviceIds ?? [],
        servicesLabel: b.servicesLabel ?? null,
      };
    });

  const revisions: RRevision[] = rev.map((v) => ({
    id: v.id,
    status: v.status,
    createdYmd: ymd(v.createdAt) ?? localYmd(),
    clientEmail: v.clientEmail,
    clientName: v.listing?.client?.name ?? null,
    items: v.items.length,
    listingId: v.listingId,
    address: v.listing?.address ?? "",
  }));

  const shoots: RShoot[] = sh.map((s) => ({
    id: s.id,
    createdBy: s.createdBy,
    ymd: ymd(s.submittedAt ?? s.createdAt) ?? localYmd(),
    status: s.status,
    listingId: s.listingId,
    address: s.listing?.address ?? "",
  }));

  const bookingAddress = new Map(bookings.map((b) => [b.id, b.address]));
  const visits: RVisit[] = vis
    .filter((v) => mine(v.env))
    .map((v) => ({ id: v.id, bookingId: v.bookingId, kind: v.kind, status: v.status, ymd: v.desiredDate, photographerEmail: v.photographerEmail, address: bookingAddress.get(v.bookingId) ?? "" }));

  return { invoices, bookings, revisions, shoots, visits };
}
