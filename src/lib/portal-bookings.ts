// The client's Bookings tab: one line per listing with what the client may
// see about its booking (never prices, never the shooter or internal notes):
// when it is, whether the business has confirmed the time, and the services booked.
// Same environment rule as the admin (one database, two environments).
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { currentEnv } from "@/lib/jobs-core";
import { fmtTime12 } from "@/lib/booking-time";
import { BUSINESS_TZ } from "@/lib/business";

export type PortalBooking = {
  bookingId: string | null;
  listingId: string;
  status: "requested" | "confirmed" | "shot" | "delivered" | "canceled" | string;
  date: string | null; // yyyy-mm-dd, local calendar date
  time: string | null; // "3:30 PM"
  services: string | null;
  movable: boolean; // the client may Reschedule it from the portal
};

const DEMO: PortalBooking[] = [
  { bookingId: null, listingId: "demo-1", status: "shot", date: "2026-07-31", time: "10:00 AM", services: "Photography", movable: false },
  { bookingId: "demo-b2", listingId: "demo-2", status: "confirmed", date: "2026-07-28", time: "2:30 PM", services: "Photography + Cinematic listing film", movable: true },
];

const todayLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export async function bookingsForListings(listingIds: string[]): Promise<Map<string, PortalBooking>> {
  const out = new Map<string, PortalBooking>();
  if (!listingIds.length) return out;
  if (!hasDb()) {
    for (const b of DEMO) if (listingIds.includes(b.listingId)) out.set(b.listingId, b);
    return out;
  }
  const env = currentEnv();
  const rows = await db().query.bookings.findMany({
    where: and(
      inArray(schema.bookings.listingId, listingIds),
      ne(schema.bookings.status, "canceled"),
      env === "production" ? or(eq(schema.bookings.env, env), isNull(schema.bookings.env)) : eq(schema.bookings.env, env)
    ),
    columns: { id: true, listingId: true, status: true, desiredDate: true, startTime: true, servicesLabel: true, createdAt: true },
    orderBy: (b, { desc }) => [desc(b.createdAt)],
  });
  // Newest live booking per listing.
  for (const r of rows) {
    if (out.has(r.listingId)) continue;
    out.set(r.listingId, {
      bookingId: r.id,
      listingId: r.listingId,
      status: r.status,
      date: r.desiredDate ?? null,
      time: r.startTime ? fmtTime12(r.startTime) : null,
      services: r.servicesLabel ?? null,
      movable: (r.status === "requested" || r.status === "confirmed") && (!r.desiredDate || r.desiredDate >= todayLocal()),
    });
  }
  return out;
}
