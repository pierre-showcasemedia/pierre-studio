// The client's Bookings tab: one line per listing with what the client may
// see about its booking (never prices, never the shooter or internal notes):
// when it is, whether the business has confirmed the time, and the services booked.
// Same environment rule as the admin (one database, two environments).
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { currentEnv } from "@/lib/jobs-core";
import { fmtTime12 } from "@/lib/booking-time";
import { BUSINESS_TZ } from "@/lib/business";
import { bookAgainPrefill, signBookAgainToken, verifyBookAgainToken, type BookAgainPrefill } from "@/lib/book-again-token";
import { authSecret } from "@/lib/session-token";

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

// Book again (studio template): the website's booking form, filled in with
// the client's own details and the services from their latest booking, so a
// repeat agent picks the new address, size and date and sends. The link
// carries no personal details: ?again= is a signed token
// (src/lib/book-again-token.ts, 30 days); the website's server trades it for
// the name, email, phone, company and client type at /api/studio/book-again.
// Only the address and the item ids ride in the query.
export async function bookAgainUrl(email: string, marketingUrl: string, opts: { address?: string; items?: string[] } = {}): Promise<string> {
  const base = `${marketingUrl.replace(/\/+$/, "")}/book`;
  if (!hasDb()) return base;
  const client = await db().query.clients.findFirst({ where: eq(schema.clients.email, email.trim().toLowerCase()), columns: { id: true } });
  if (!client) return base;
  const last = opts.items
    ? null
    : await db().query.bookings.findFirst({
        where: and(eq(schema.bookings.clientId, client.id), eq(schema.bookings.env, currentEnv())),
        orderBy: (b, { desc }) => [desc(b.createdAt)],
        columns: { serviceIds: true, addonIds: true },
      });
  const q = new URLSearchParams({ again: signBookAgainToken(client.id, authSecret()) });
  if (opts.address) q.set("address", opts.address);
  const items = opts.items ?? [...(last?.serviceIds ?? []), ...(last?.addonIds ?? [])];
  if (items.length) q.set("items", items.join(","));
  return `${base}?${q.toString()}`;
}

// The other half: a Book again token back from the website's server, as the
// prefill for its form. Null for a bad or expired token or a client that is
// gone; the route answers all of those the same way.
export async function bookAgainLookup(token: unknown, nowMs: number = Date.now()): Promise<BookAgainPrefill | null> {
  if (!hasDb()) return null;
  const t = verifyBookAgainToken(token, authSecret(), nowMs);
  if (!t) return null;
  const client = await db().query.clients.findFirst({ where: eq(schema.clients.id, t.clientId), columns: { id: true, name: true, email: true, phone: true, company: true } });
  if (!client) return null;
  const last = await db().query.bookings.findFirst({
    where: and(eq(schema.bookings.clientId, client.id), eq(schema.bookings.env, currentEnv())),
    orderBy: (b, { desc }) => [desc(b.createdAt)],
    columns: { clientType: true },
  });
  return bookAgainPrefill(client, last?.clientType ?? null);
}
