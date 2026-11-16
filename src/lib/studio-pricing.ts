// The studio's side of pricing. src/lib/booking-pricing.ts is an exact copy
// of the website's src/lib/pricing.ts (never edit it here: change the
// website's file, copy it over, bump PRICING_VERSION); this file is
// everything the studio needs on top of it, built only on the contract every
// buyer's price table shares: PACKAGES (the home's size), ITEMS, priceBooking,
// PRICING_VERSION, PRICING_HASH and usd.
//
// A booking row keeps the size and the package or solo service in
// service_ids (size first), the add-ons in addon_ids, and the full selection
// with quantities in items. quote() re-prices any of that.
import type { InvoiceLineItem } from "@/db/schema";
import { ITEMS, PACKAGES, PRICING_HASH, PRICING_VERSION, priceBooking, usd } from "./booking-pricing";

export { PRICING_HASH, PRICING_VERSION };

export type Selection = { id: string; qty?: number | null; option?: string | null };
export type StudioItem = {
  id: string;
  name: string;
  kind: "size" | "service" | "addon";
  video: boolean;
  quoted: boolean; // no fixed price on the table
  counted: { unit: string; units: string; max: number } | null; // per image, per clip...
};

function counted(price: { kind: string; unit?: string; units?: string; max?: number }): StudioItem["counted"] {
  return price.unit && price.units ? { unit: price.unit, units: price.units, max: price.max ?? 20 } : null;
}

// The home's size options (the website's "packages").
export const SIZES: readonly StudioItem[] = PACKAGES.map((p) => ({ id: p.id, name: p.name, kind: "size" as const, video: false, quoted: p.quoted, counted: null }));
// Services (a photo package, or a video or tour on its own) and add-ons.
export const SERVICES: readonly StudioItem[] = ITEMS.filter((i) => i.role === "service").map((i) => ({ id: i.id, name: i.name, kind: "service" as const, video: Boolean(i.video), quoted: i.price.kind === "quote", counted: counted(i.price) }));
export const ADDONS: readonly StudioItem[] = ITEMS.filter((i) => i.role === "addon").map((i) => ({ id: i.id, name: i.name, kind: "addon" as const, video: Boolean(i.video), quoted: i.price.kind === "quote", counted: counted(i.price) }));
export const ALL_ITEMS: readonly StudioItem[] = [...SIZES, ...SERVICES, ...ADDONS];
const byId = new Map(ALL_ITEMS.map((i) => [i.id, i]));
const SIZE_IDS = new Set(SIZES.map((s) => s.id));

export function itemById(id: string): StudioItem | undefined {
  return byId.get(id);
}
export const isSizeId = (id: string): boolean => SIZE_IDS.has(id);

// A video item on the booking (the Video board's card).
export const isVideoBooking = (serviceIds: string[] | null | undefined, addonIds?: string[] | null): boolean =>
  [...(serviceIds ?? []), ...(addonIds ?? [])].some((id) => byId.get(id)?.video);

// Whole dollars as "$1,250"; an amount with cents keeps them, "$150.50".
export const fmtDollars = (cents: number): string => usd(cents);

export type Quote = {
  tier: number; // the size's tier, the custom tier, or -1 with no size
  lineItems: InvoiceLineItem[];
  totalCents: number; // sum of the priced lines
  pending: boolean; // a quoted or unpriceable line is in the mix
  inquire: boolean; // the size is a custom quote
  custom: boolean; // the client type is quoted to the project
  hasVideo: boolean;
  minutes: number; // calendar duration
  servicesLabel: string; // names only, never prices
  addonsLabel: string;
  reasons: string[]; // why it needs a human to set the amount (the price table's words)
  items: Selection[]; // the selection, cleaned (known ids, quantities in range)
  unknown: string[];
};

export type QuoteExtra = { items?: readonly Selection[] | null; clientType?: string | null; area?: string | null };

// Prices a booking: its service ids (size first), add-on ids and, when the
// row has them, the items with quantities, the client type and the area.
export function quote(serviceIds: readonly string[], addonIds: readonly string[], extra: QuoteExtra = {}): Quote {
  const size = serviceIds.find((id) => SIZE_IDS.has(id)) ?? null;
  const fromIds: Selection[] = [...serviceIds.filter((id) => !SIZE_IDS.has(id)), ...addonIds].map((id) => ({ id, qty: 1 }));
  const given = (extra.items ?? []).filter((s) => s && s.id && !SIZE_IDS.has(s.id));
  // Quantities from items; ids on the row that items doesn't name still count.
  const sel: Selection[] = [...given, ...fromIds.filter((f) => !given.some((g) => g.id === f.id))];
  const p = priceBooking({ package: size, items: sel, clientType: extra.clientType ?? "agent", area: extra.area ?? null });
  const lineItems: InvoiceLineItem[] = p.lines.map((l) => ({
    id: l.id,
    name: l.qty > 1 || (l.unit !== "item" && l.unit) ? `${l.name} (${l.qty} ${l.unit})` : l.name,
    cents: l.priced ? l.cents : 0,
    priced: l.priced,
  }));
  const custom = p.lines.some((l) => !l.priced) && p.quoteReasons.some((r) => /quoted to the project/i.test(r));
  return {
    tier: p.tier,
    lineItems,
    totalCents: p.subtotalCents,
    pending: lineItems.some((l) => !l.priced),
    inquire: Boolean(p.package?.quoted) && p.lines.some((l) => !l.priced),
    custom,
    hasVideo: p.hasVideo,
    minutes: p.minutes,
    servicesLabel: p.servicesLabel,
    addonsLabel: p.addonsLabel,
    reasons: p.quoteReasons,
    items: p.items.map((i) => ({ id: i.id, qty: i.qty, option: i.option })),
    unknown: p.unknown,
  };
}

// The quote extras a booking row carries (items with quantities, the client
// type, the service area in "market").
export function bookingExtra(b: { items?: Selection[] | null; clientType?: string | null; market?: string | null }): QuoteExtra {
  return { items: b.items ?? null, clientType: b.clientType ?? null, area: b.market ?? null };
}

// Resolve ids or names ("Photos", "Virtual staging · $25") to known ids, in
// a pool. Unknown entries come back so the intake can flag the booking for a
// human instead of silently dropping them.
export function resolveItemIds(input: unknown, pool: readonly StudioItem[] = ALL_ITEMS): { ids: string[]; unknown: string[] } {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const ids: string[] = [];
  const unknown: string[] = [];
  const parts: string[] = Array.isArray(input) ? input.map((x) => String((x && typeof x === "object" ? (x as { id?: unknown }).id : x) ?? "")) : typeof input === "string" ? input.split(/;|\n|,/) : [];
  for (const raw of parts) {
    const name = raw.split("·")[0].trim();
    if (!name) continue;
    const k = key(name);
    const hit = pool.find((i) => key(i.id) === k || key(i.name) === k);
    if (hit) {
      if (!ids.includes(hit.id)) ids.push(hit.id);
    } else unknown.push(name);
  }
  return { ids, unknown };
}
