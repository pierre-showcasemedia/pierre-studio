// Loads and saves what /admin/scorecard shows (the math is src/lib/scorecard.ts).
//
// From Studio, read only: this environment's bookings for the last 65
// days and the next business day, when a shooter was first named on each
// (activity "booking.shooter_assigned"), when each client booking (website or
// email) was first confirmed (activity "booking.status_set" to confirmed, the
// Confirm time button), the first upload for each listing
// from its shoot day on (shoots), any reshoot or pickup visit added within 14
// days (booking_visits), and paid invoices by month (the reports loader) as
// the revenue cross-check. Only THIS environment's bookings count, the same
// rule as /admin/bookings.
//
// Written here, and only here: scorecard_entries. Until the migrate route has
// created that table the page reads it as empty and says so.
//
// Demo mode (no database, local only): sample shoots built from today's date
// and an in-memory store, so the page and its forms can be tried locally.
import { and, eq, gte, inArray, or } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { currentEnv } from "./jobs-core";
import { localYmd, addDaysYmd } from "./local-date";
import { rowEnv } from "./payments";
import { loadReportRows } from "./reports-data";
import { revenueByMonth } from "./reports";
import { REWORK_DAYS, WINDOW_DAYS, addMonths, monthOf, nextBusinessDay, isWeekend, type ScBooking, type ScEntry, type ScShoot, type ScUpcoming } from "./scorecard";

const DONE_STATUSES = new Set(["confirmed", "shot", "delivered"]);
const REWORK_KINDS = new Set(["reshoot", "pickup"]);
// Bookings a client made (the form, or an email the intake read); an admin's own booking has no confirm clock.
const CLIENT_SOURCES = new Set(["website", "email"]);
const HOUR = 3_600_000, DAY = 86_400_000;

export type ScorecardData = { shoots: ScShoot[]; bookings: ScBooking[]; upcoming: ScUpcoming[]; entries: ScEntry[]; estimate: Record<string, number>; tableMissing: boolean; demo: boolean };

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export async function loadScorecard(person: { email: string }, now = new Date()): Promise<ScorecardData> {
  const today = localYmd(now);
  if (!hasDb()) return demoScorecard(now);
  const d = db();
  const env = currentEnv();
  const since = new Date(`${addDaysYmd(today, -(WINDOW_DAYS + 5))}T00:00:00Z`);
  const upTo = nextBusinessDay(today);

  const windowStart = addDaysYmd(today, -(WINDOW_DAYS - 1));
  const allRows = (await d.query.bookings.findMany({ where: or(gte(schema.bookings.startsAt, since), gte(schema.bookings.createdAt, since)), with: { listing: { columns: { address: true } } }, limit: 3000 }))
    .filter((b) => rowEnv(b.env) === env);
  const bookingRows = allRows.filter((b) => b.status !== "canceled" && b.startsAt);
  const clientRows = allRows.filter((b) => CLIENT_SOURCES.has(b.source) && localYmd(b.createdAt) >= windowStart);
  const address = (b: (typeof allRows)[number]) => b.listing?.address ?? (b.property?.street as string | undefined) ?? "Address not set";
  const ymdOf = (b: (typeof bookingRows)[number]) => b.desiredDate ?? localYmd(b.startsAt!);

  const past = bookingRows.filter((b) => b.startsAt!.getTime() <= now.getTime() && DONE_STATUSES.has(b.status) && ymdOf(b) >= windowStart);
  const upcoming: ScUpcoming[] = bookingRows
    .filter((b) => ymdOf(b) >= today && ymdOf(b) <= upTo)
    .sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime())
    .map((b) => ({ bookingId: b.id, address: address(b), ymd: ymdOf(b), time: b.startTime, status: b.status, shooter: b.photographerEmail }));

  const ids = past.map((b) => b.id), listingIds = [...new Set(past.map((b) => b.listingId))];
  const [named, statusSets, uploads, visits, entries, estimate] = await Promise.all([
    ids.length
      ? d.select({ meta: schema.activity.meta, createdAt: schema.activity.createdAt }).from(schema.activity).where(and(eq(schema.activity.action, "booking.shooter_assigned"), gte(schema.activity.createdAt, new Date(since.getTime() - 30 * DAY))))
      : Promise.resolve([]),
    clientRows.length
      ? d.select({ meta: schema.activity.meta, createdAt: schema.activity.createdAt }).from(schema.activity).where(and(eq(schema.activity.action, "booking.status_set"), gte(schema.activity.createdAt, new Date(`${windowStart}T00:00:00Z`))))
      : Promise.resolve([]),
    listingIds.length ? d.select({ listingId: schema.shoots.listingId, createdAt: schema.shoots.createdAt }).from(schema.shoots).where(and(inArray(schema.shoots.listingId, listingIds), gte(schema.shoots.createdAt, since))) : Promise.resolve([]),
    ids.length ? d.select({ bookingId: schema.bookingVisits.bookingId, kind: schema.bookingVisits.kind, status: schema.bookingVisits.status, createdAt: schema.bookingVisits.createdAt }).from(schema.bookingVisits).where(inArray(schema.bookingVisits.bookingId, ids)) : Promise.resolve([]),
    readEntries(person.email),
    revenueEstimate(today),
  ]);

  // The first time each booking had any shooter named.
  const firstNamed = new Map<string, number>();
  for (const a of named) {
    const bookingId = typeof a.meta?.bookingId === "string" ? a.meta.bookingId : null;
    if (!bookingId || !a.meta?.email) continue;
    const t = a.createdAt.getTime();
    if (!firstNamed.has(bookingId) || t < firstNamed.get(bookingId)!) firstNamed.set(bookingId, t);
  }

  // The first time each booking was set to confirmed (the Confirm time button).
  const firstConfirmed = new Map<string, number>();
  for (const a of statusSets) {
    const bookingId = typeof a.meta?.bookingId === "string" ? a.meta.bookingId : null;
    if (!bookingId || a.meta?.to !== "confirmed") continue;
    const t = a.createdAt.getTime();
    if (!firstConfirmed.has(bookingId) || t < firstConfirmed.get(bookingId)!) firstConfirmed.set(bookingId, t);
  }
  const bookings: ScBooking[] = clientRows
    .map((b) => ({ bookingId: b.id, address: address(b), createdAt: b.createdAt.toISOString(), status: b.status, confirmedAt: firstConfirmed.has(b.id) ? new Date(firstConfirmed.get(b.id)!).toISOString() : null }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const shoots: ScShoot[] = past.map((b) => {
    const starts = b.startsAt!.getTime();
    // An upload counts from 6 hours before the call time (a shooter can start early).
    const up = uploads.filter((u) => u.listingId === b.listingId && u.createdAt.getTime() >= starts - 6 * HOUR).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0];
    const rw = visits.filter((v) => v.bookingId === b.id && REWORK_KINDS.has(v.kind) && v.status !== "canceled" && v.createdAt.getTime() <= starts + REWORK_DAYS * DAY).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0];
    return {
      bookingId: b.id,
      address: address(b),
      ymd: ymdOf(b),
      startsAt: b.startsAt!.toISOString(),
      createdAt: b.createdAt.toISOString(),
      status: b.status,
      shooter: b.photographerEmail,
      shooterNamedAt: firstNamed.has(b.id) ? new Date(firstNamed.get(b.id)!).toISOString() : null,
      uploadedAt: iso(up?.createdAt),
      reworkAt: iso(rw?.createdAt),
      reworkKind: rw?.kind ?? null,
    };
  });

  return { shoots: shoots.sort((a, b) => b.startsAt.localeCompare(a.startsAt)), bookings, upcoming, entries: entries.rows, estimate, tableMissing: entries.missing, demo: false };
}

async function readEntries(person: string): Promise<{ rows: ScEntry[]; missing: boolean }> {
  try {
    const rows = await db().select().from(schema.scorecardEntries).where(eq(schema.scorecardEntries.person, person));
    return { rows: rows.map((r) => ({ kind: r.kind, key: r.key, data: r.data ?? {}, updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString() })), missing: false };
  } catch {
    // Deployed before the migrate route made scorecard_entries.
    return { rows: [], missing: true };
  }
}

// Paid invoices (net of refunds) by month, every market: the cross-check
// beside the finance ledger's eligible revenue.
async function revenueEstimate(today: string): Promise<Record<string, number>> {
  try {
    const from = `${addMonths(monthOf(today), -3)}-01`;
    const { months } = revenueByMonth(await loadReportRows(), { from, to: today });
    return Object.fromEntries(months.map((m) => [m.month, m.net]));
  } catch {
    return {};
  }
}

export async function saveEntry(person: string, kind: string, key: string, data: Record<string, unknown>, by: string): Promise<void> {
  if (!hasDb()) {
    demoStore().set(`${kind}:${key}`, { kind, key, data, updatedBy: by, updatedAt: new Date().toISOString() });
    return;
  }
  const t = schema.scorecardEntries;
  const now = new Date();
  await db().insert(t).values({ person, kind, key, data, updatedBy: by, updatedAt: now }).onConflictDoUpdate({ target: [t.person, t.kind, t.key], set: { data, updatedBy: by, updatedAt: now } });
}

export async function getEntry(person: string, kind: string, key: string): Promise<ScEntry | null> {
  if (!hasDb()) return demoStore().get(`${kind}:${key}`) ?? null;
  const t = schema.scorecardEntries;
  const [r] = await db().select().from(t).where(and(eq(t.person, person), eq(t.kind, kind), eq(t.key, key))).limit(1);
  return r ? { kind: r.kind, key: r.key, data: r.data ?? {}, updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString() } : null;
}

export async function deleteEntry(person: string, kind: string, key: string): Promise<void> {
  if (!hasDb()) {
    demoStore().delete(`${kind}:${key}`);
    return;
  }
  const t = schema.scorecardEntries;
  await db().delete(t).where(and(eq(t.person, person), eq(t.kind, kind), eq(t.key, key)));
}

// ---- Demo (no database) --------------------------------------------------------------------

const g = globalThis as typeof globalThis & { __scorecardDemo?: Map<string, ScEntry> };
const demoStore = () => (g.__scorecardDemo ??= new Map());

function demoScorecard(now: Date): ScorecardData {
  const today = localYmd(now);
  const streets = ["1475 Magnolia Dr", "3218 Willow Dr", "925 Spruce Rd", "4585 Via Maria", "806 Holly Rd", "1556 Linden Rd", "2320 Fir Rd", "571 Myrtle Rd"];
  const shooters = ["alex@example.com", "drew@example.com", "kim@example.com"];
  const shoots: ScShoot[] = [];
  for (let back = 1, i = 0; back < WINDOW_DAYS && shoots.length < 24; back++) {
    const ymd = addDaysYmd(today, -back);
    if (isWeekend(ymd)) continue;
    const startsAt = new Date(`${ymd}T17:30:00Z`);
    const late = i % 9 === 4;
    shoots.push({
      bookingId: `demo-${ymd}`,
      address: streets[i % streets.length],
      ymd,
      startsAt: startsAt.toISOString(),
      createdAt: new Date(startsAt.getTime() - (late ? 20 : 96) * HOUR).toISOString(),
      status: back > 4 ? "delivered" : "shot",
      shooter: i % 11 === 7 ? null : shooters[i % shooters.length],
      shooterNamedAt: new Date(startsAt.getTime() - (i % 13 === 5 ? 6 : 50) * HOUR).toISOString(),
      uploadedAt: i % 10 === 3 ? new Date(startsAt.getTime() + 30 * HOUR).toISOString() : new Date(startsAt.getTime() + 5 * HOUR).toISOString(),
      reworkAt: i % 12 === 6 ? new Date(startsAt.getTime() + 3 * DAY).toISOString() : null,
      reworkKind: i % 12 === 6 ? "reshoot" : null,
    });
    i++;
  }
  const next = nextBusinessDay(today);
  const upcoming: ScUpcoming[] = [
    { bookingId: "demo-up-1", address: "21 Hemlock St", ymd: today, time: "14:00", status: "confirmed", shooter: "alex@example.com" },
    { bookingId: "demo-up-2", address: "75 Aspen Rd", ymd: next, time: "10:00", status: "confirmed", shooter: "kim@example.com" },
    { bookingId: "demo-up-3", address: "1030 Magnolia Dr", ymd: next, time: "15:30", status: "requested", shooter: null },
  ];
  const months: Record<string, number> = {};
  for (let n = 3; n >= 0; n--) months[addMonths(monthOf(today), -n)] = 3_850_000 + n * 410_000;
  // Client bookings: most confirmed inside the hour, a couple late, one still waiting.
  const bookings: ScBooking[] = shoots.slice(0, 20).map((s, i) => {
    const created = Date.parse(s.createdAt);
    const after = i % 8 === 3 ? 150 : 12 + (i % 5) * 9;
    return { bookingId: `${s.bookingId}-b`, address: s.address, createdAt: s.createdAt, status: i % 9 === 8 ? "delivered" : s.status, confirmedAt: i % 9 === 8 ? null : new Date(created + after * 60_000).toISOString() };
  });
  bookings.unshift({ bookingId: "demo-new", address: "1030 Magnolia Dr", createdAt: new Date(now.getTime() - 20 * 60_000).toISOString(), status: "requested", confirmedAt: null });
  return { shoots, bookings, upcoming, entries: [...demoStore().values()], estimate: months, tableMissing: false, demo: true };
}
