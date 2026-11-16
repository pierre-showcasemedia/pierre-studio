// Additional shoots on a booking (Oct 27 2026). the owner: "a second shoot date.
// This accounts for return trips, reschedules, pickup shots, etc. A button in
// the backend that says 'Add second shoot' on each booking page ... it puts it
// on the hello@ master the business calendar as a shoot and invites the right shooter
// for that pickup shoot."
//
// One row in booking_visits per extra trip. The booking's own time, invoice
// and event stay as they are; each visit is its own event on the business MAIN (id
// <prefix>v<visit hex>, written by calendar.visit_upsert / calendar.visit_cancel in
// src/lib/google-calendar.ts), with the visit's shooter as the one guest, and
// its own 30 minute shoot brief (src/lib/shoot-brief.ts). Nothing here emails
// the client or touches money: a visit gets an invoice only when the admin
// ticks "Create new invoice?" (or uses Create invoice later), which is
// src/lib/visit-invoice.ts.
//
// Until the migrate route has created the table, every read here answers
// "not ready" instead of throwing, so the booking page, the cron and Cancel
// keep working on a deployment that is ahead of its database.
import { and, asc, eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { VISIT_KINDS, type VisitKind, type VisitStatus } from "@/db/schema";
import { logActivity } from "./activity";
import { fmtDay, fmtTime12, BUSINESS_TZ } from "./booking-time";
import { enqueueJobs, jobKey, type JobSpec } from "./jobs-core";
import { business } from "./business";

// The admin's select. "Other" reads "Second shoot" everywhere else (the
// calendar title, Slack, the brief), which says more than "Other".
export const VISIT_KIND_OPTIONS: [VisitKind, string][] = [
  ["return_trip", "Return trip"],
  ["pickup", "Pickup shots"],
  ["reshoot", "Reshoot"],
  ["twilight", "Twilight"],
  ["other", "Other"],
];
const KIND_LABEL: Record<VisitKind, string> = { return_trip: "Return trip", pickup: "Pickup shots", reshoot: "Reshoot", twilight: "Twilight", other: "Second shoot" };
export const visitKindLabel = (k: string | null | undefined): string => KIND_LABEL[(k ?? "other") as VisitKind] ?? "Second shoot";
export const isVisitKind = (k: unknown): k is VisitKind => typeof k === "string" && (VISIT_KINDS as readonly string[]).includes(k);

// Half hours from 6:00 AM to 8:00 PM, so a twilight fits.
export const VISIT_START_TIMES: string[] = Array.from({ length: 29 }, (_, i) => {
  const m = 6 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});
export const VISIT_DURATIONS: [number, string][] = [
  [60, "1 hour"],
  [90, "1.5 hours"],
  [120, "2 hours"],
  [180, "3 hours"],
  [240, "4 hours"],
];
export const DEFAULT_VISIT_MINUTES = 120;

// Google event ids take a-v and 0-9 only: the prefix, "v" and the uuid's hex all fit,
// and no booking's own id (prefix + 32 hex, never a "v" after the prefix) can ever equal one.
export const visitEventIdFor = (visitId: string) => `${business.calendarPrefix}v${visitId.replace(/-/g, "").toLowerCase()}`;

export function visitUpsertSpec(v: { id: string; bookingId: string; listingId: string; calendarVersion: number }): JobSpec {
  return { kind: "calendar.visit_upsert", idempotencyKey: jobKey("calendar.visit_upsert", v.id, v.calendarVersion), bookingId: v.bookingId, listingId: v.listingId, payload: { version: v.calendarVersion, visitId: v.id } };
}
export function visitCancelSpec(v: { id: string; bookingId: string; listingId: string; calendarVersion: number }): JobSpec {
  return { kind: "calendar.visit_cancel", idempotencyKey: jobKey("calendar.visit_cancel", v.id, v.calendarVersion), bookingId: v.bookingId, listingId: v.listingId, payload: { version: v.calendarVersion, visitId: v.id } };
}

const localHm = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

// "Tue, Oct 28, 5:30 PM to 7:30 PM"
export function visitWhenLabel(v: { desiredDate: string; startTime: string; endsAt: Date | string }, opts: { long?: boolean } = {}): string {
  const end = v.endsAt instanceof Date ? v.endsAt : new Date(v.endsAt);
  return `${fmtDay(v.desiredDate, opts)}, ${fmtTime12(v.startTime)} to ${fmtTime12(localHm(end))}`;
}

export function minutesLabel(min: number): string {
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? "" : "s"}`;
  return `${(min / 60).toFixed(1).replace(/\.0$/, "")} hours`;
}

export type AdminVisit = {
  id: string;
  kind: VisitKind;
  kindLabel: string;
  note: string | null;
  desiredDate: string;
  startTime: string;
  startsAt: string;
  endsAt: string;
  minutes: number;
  whenLabel: string;
  photographerEmail: string | null;
  status: VisitStatus;
  calendarVersion: number;
  calendarEventId: string | null;
  calendarSyncedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  invoiceId: string | null; // its own invoice, when one was made (src/lib/visit-invoice.ts)
};

type VisitRow = typeof schema.bookingVisits.$inferSelect;

export function toAdminVisit(v: VisitRow): AdminVisit {
  return {
    id: v.id,
    kind: v.kind,
    kindLabel: visitKindLabel(v.kind),
    note: v.note,
    desiredDate: v.desiredDate,
    startTime: v.startTime,
    startsAt: v.startsAt.toISOString(),
    endsAt: v.endsAt.toISOString(),
    minutes: Math.max(0, Math.round((v.endsAt.getTime() - v.startsAt.getTime()) / 60_000)),
    whenLabel: visitWhenLabel(v),
    photographerEmail: v.photographerEmail,
    status: v.status,
    calendarVersion: v.calendarVersion,
    calendarEventId: v.calendarEventId,
    calendarSyncedAt: v.calendarSyncedAt ? v.calendarSyncedAt.toISOString() : null,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    invoiceId: v.invoiceId ?? null,
  };
}

// The booking page's list. ready false = the table is not there yet (the
// migrate route has not run on this database).
export async function visitsForBooking(bookingId: string): Promise<{ ready: boolean; visits: AdminVisit[] }> {
  if (!hasDb()) return { ready: true, visits: [] };
  try {
    const rows = await db().query.bookingVisits.findMany({ where: eq(schema.bookingVisits.bookingId, bookingId), orderBy: [asc(schema.bookingVisits.startsAt)] });
    return { ready: true, visits: rows.map(toAdminVisit) };
  } catch (e) {
    console.error("[booking-visits] read failed (has the migrate route run?)", e instanceof Error ? e.message : e);
    return { ready: false, visits: [] };
  }
}

// The booking is canceled: every scheduled visit goes with it (its event is
// deleted, Google tells the shooter). Done visits stay as history. Never
// throws: a cancel must not fail because of an extra trip.
export async function cancelVisitsForBooking(bookingId: string, actor: string): Promise<number> {
  if (!hasDb()) return 0;
  try {
    const d = db();
    const rows = await d.query.bookingVisits.findMany({ where: and(eq(schema.bookingVisits.bookingId, bookingId), eq(schema.bookingVisits.status, "scheduled")) });
    const now = new Date();
    for (const v of rows) {
      const version = v.calendarVersion + 1;
      await d.update(schema.bookingVisits).set({ status: "canceled", calendarVersion: version, updatedAt: now }).where(eq(schema.bookingVisits.id, v.id));
      await logActivity({ actorEmail: actor, action: "booking.visit_canceled", listingId: v.listingId, meta: { bookingId, visitId: v.id, kind: v.kind, kindLabel: visitKindLabel(v.kind), when: visitWhenLabel(v), reason: "booking canceled" } });
      await enqueueJobs([visitCancelSpec({ ...v, calendarVersion: version })]);
    }
    return rows.length;
  } catch (e) {
    console.error("[booking-visits] cancel with the booking failed", e instanceof Error ? e.message : e);
    return 0;
  }
}
