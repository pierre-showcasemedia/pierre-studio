// Upsell prompts (studio template, Nov 18 2026; off unless
// business.upsell.enabled): at fromDays to toDays on the market, suggest the
// add-ons in business.upsell.itemIds the listing has not had yet. Days on
// market count from the booking's launch date, else the day the delivery email
// went, else the shoot date. Nothing is ever sent from here: the admin
// dashboard lists the listings, and the agent's portal shows a note (client
// logins only, never partners).
import { and, eq, isNotNull, or } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { business } from "./business";
import { itemById } from "./studio-pricing";
import { currentEnv } from "./jobs-core";
import { isPartnerEmail } from "./partner";

export type Upsell = { listingId: string; slug: string; address: string; clientName: string | null; clientEmail: string; days: number; items: { id: string; name: string }[] };

const DAY = 86_400_000;
const ymdMs = (ymd: string) => Date.parse(`${ymd}T12:00:00Z`);

export function daysOnMarket(p: { launchDate: string | null; deliveryEmailAt: Date | null; shootDate: Date | null }, now = Date.now()): number | null {
  const from = p.launchDate ? ymdMs(p.launchDate) : p.deliveryEmailAt?.getTime() ?? p.shootDate?.getTime() ?? null;
  return from == null ? null : Math.floor((now - from) / DAY);
}

export function suggestions(had: Set<string>): { id: string; name: string }[] {
  return business.upsell.itemIds.filter((id) => !had.has(id)).map((id) => ({ id, name: itemById(id)?.name ?? id }));
}

// The portal's note is for the client's own login only. A partner login
// (src/lib/partner.ts) sees paid galleries read only and never gets an upsell.
export const upsellNoteFor = (email: string): boolean => !isPartnerEmail(email);

export function inWindow(days: number | null): boolean {
  return days != null && days >= business.upsell.fromDays && days <= business.upsell.toDays;
}

// Every listing in the window, oldest first (the admin dashboard).
export async function upsellListings(now = Date.now(), onlyListingId?: string): Promise<Upsell[]> {
  if (!hasDb() || !business.upsell.enabled) return [];
  const rows = await db().query.listings.findMany({
    where: and(eq(schema.listings.nda, false), onlyListingId ? eq(schema.listings.id, onlyListingId) : undefined, or(isNotNull(schema.listings.deliveryEmailAt), isNotNull(schema.listings.shootDate))),
    columns: { id: true, slug: true, address: true, deliveryEmailAt: true, shootDate: true },
    with: { client: { columns: { name: true, email: true } }, bookings: { columns: { launchDate: true, serviceIds: true, addonIds: true, env: true, status: true } } },
  });
  const out: Upsell[] = [];
  for (const l of rows) {
    const bookings = l.bookings.filter((b) => b.env === currentEnv() && b.status !== "canceled");
    if (!bookings.length) continue;
    const launch = bookings.map((b) => b.launchDate).filter(Boolean).sort()[0] ?? null;
    const days = daysOnMarket({ launchDate: launch, deliveryEmailAt: l.deliveryEmailAt, shootDate: l.shootDate }, now);
    if (!inWindow(days)) continue;
    const had = new Set(bookings.flatMap((b) => [...(b.serviceIds ?? []), ...(b.addonIds ?? [])]));
    const items = suggestions(had);
    if (items.length) out.push({ listingId: l.id, slug: l.slug, address: l.address, clientName: l.client.name, clientEmail: l.client.email, days: days!, items });
  }
  return out.sort((a, b) => b.days - a.days);
}

// One listing (the agent's portal page).
export async function upsellFor(listingId: string, now = Date.now()): Promise<Upsell | null> {
  if (!hasDb() || !business.upsell.enabled) return null;
  return (await upsellListings(now, listingId))[0] ?? null;
}
