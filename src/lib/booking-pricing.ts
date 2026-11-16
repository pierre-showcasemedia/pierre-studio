// SAMPLE price table for studio-universal. Every price is "Quoted": a buyer's
// studio replaces this whole file with an exact copy of their website's
// src/lib/pricing.ts (same text, so the same PRICING_HASH), and the studio
// re-prices every booking with it. Never invent a price here: an unknown price
// is { kind: "quote" } and shows "Quoted".
//
// The studio reads only the shared contract below: PACKAGES (the home's
// size), ITEMS, priceBooking(), PRICING_VERSION, PRICING_HASH, usd(),
// itemDef(), packageDef(), CUSTOM_TIER, CLIENT_TYPES and AREAS. Its own
// helpers are in src/lib/studio-pricing.ts.
// Safe to import from client components (no server code).

// ---- Business rules the form needs ----------------------------------------------
export const AREAS = ["Home area", "Somewhere else"] as const;
export type Area = (typeof AREAS)[number];
export const HOME_AREAS = new Set<string>(["Home area"]);
export const isOutsideArea = (area: string | null | undefined) => Boolean(area && !HOME_AREAS.has(area));

export const CLIENT_TYPES = ["agent", "homeowner", "builder", "other"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export const CLIENT_TYPE_LABELS: Record<ClientType, string> = {
  agent: "Real estate agent",
  homeowner: "Homeowner",
  builder: "Builder or developer",
  other: "Something else",
};

// Payment is due before delivery: the gallery arrives in the client portal,
// the client pays, and it unlocks once it's paid ("pay_first").
export const BILLING_TYPES = ["pay_first"] as const;
export type BillingType = (typeof BILLING_TYPES)[number];
export function defaultBilling(): BillingType {
  return "pay_first";
}

export const TIME_WINDOWS = ["morning", "midday", "afternoon"] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];
export const TIME_WINDOW_LABELS: Record<TimeWindow, string> = { morning: "Morning", midday: "Midday", afternoon: "Afternoon" };
export const TURNAROUND = "the next day";
export const CONFIRM_WITHIN = "a few hours";

// ==== BEGIN SHARED PRICE TABLE ====
// Every amount is US cents. No sales tax line.

export const PRICING_VERSION = "sample-v1";

// The client picks the home's size first; it sets the tier (0 to 2) for every
// tier-priced item. The largest size is a custom quote.
export const CUSTOM_TIER = 99;
export type PackageId = "small" | "medium" | "large" | "custom";
export type Package = {
  id: PackageId;
  name: string;
  cents: number; // Photos only at this size (the "from" price); 0 when quoted
  quoted: boolean; // true: custom quote, the price is sent by hand
  tier: number;
  hint: string;
  minutes: number;
};
export const PACKAGES: readonly Package[] = [
  { id: "small", name: "Small home", cents: 0, quoted: true, tier: 0, hint: "Set the sizes from the website", minutes: 60 },
  { id: "medium", name: "Medium home", cents: 0, quoted: true, tier: 1, hint: "Set the sizes from the website", minutes: 90 },
  { id: "large", name: "Large home", cents: 0, quoted: true, tier: 2, hint: "Set the sizes from the website", minutes: 120 },
  { id: "custom", name: "Larger homes", cents: 0, quoted: true, tier: CUSTOM_TIER, hint: "Custom quote", minutes: 150 },
];


// Included with every package (none in the sample).
export const INCLUDED: readonly string[] = [];

// Builders and anything commercial get a custom quote.
export const QUOTED_CLIENT_TYPES: readonly ClientType[] = ["builder", "other"];

// package: the photo packages (pick one). solo: a video or 3D tour on its own, no
// photos (also pick one, instead of a package). standalone: add-ons that can go
// with a package or be booked on their own. extras: add-ons that go with an order.
export type ItemGroup = "package" | "solo" | "standalone" | "extras";
export type ItemPrice =
  | { kind: "tier"; cents: readonly number[] }
  | { kind: "flat"; cents: number }
  | { kind: "each"; cents: number; unit: string; units: string; max: number }
  | { kind: "quote"; unit?: string; units?: string; max?: number }; // no price yet: confirmed by hand
export type Item = {
  id: string;
  name: string;
  desc: string;
  group: ItemGroup;
  role: "service" | "addon"; // service ids and add-on ids on the booking row
  price: ItemPrice;
  needs?: readonly string[]; // one of these must be booked too
  pickOne?: boolean; // a package or a solo service: only one per booking
  standalone?: boolean; // can be the whole order on its own
  needsOrder?: boolean; // goes with a package, a solo service or a stand-alone add-on
  floorPlan?: boolean; // floor plan items
  options?: readonly { id: string; name: string }[];
  adminOnly?: boolean; // never on the website form
  video?: boolean; // goes on the Video board
  minutes: number | readonly number[]; // calendar time, per unit for counted items
};

export const ITEMS: readonly Item[] = [
  { id: "photos", name: "Photos", desc: "Listing photos of the home, inside and out.", group: "package", role: "service", pickOne: true, price: { kind: "quote" }, minutes: 0 },
  { id: "photos_video", name: "Photos and video", desc: "Listing photos plus a property video.", group: "package", role: "service", pickOne: true, price: { kind: "quote" }, video: true, minutes: [60, 75, 90] },
  { id: "video", name: "Property video only", desc: "A property video, on its own.", group: "solo", role: "service", pickOne: true, price: { kind: "quote" }, video: true, minutes: [60, 75, 90] },
  { id: "aerials", name: "Aerial photos", desc: "Drone photos of the property.", group: "standalone", role: "addon", standalone: true, price: { kind: "quote" }, minutes: 30 },
  { id: "twilight", name: "Twilight photos", desc: "Exterior photos at sunset.", group: "standalone", role: "addon", standalone: true, price: { kind: "quote" }, minutes: 0 },
  { id: "floor_plan", name: "Floor plan", desc: "A floor plan of the home.", group: "standalone", role: "addon", standalone: true, floorPlan: true, price: { kind: "quote" }, minutes: 15 },
  { id: "virtual_staging", name: "Virtual staging", desc: "An empty room furnished in the photo.", group: "extras", role: "addon", needsOrder: true, price: { kind: "quote", unit: "image", units: "images", max: 30 }, minutes: 0 },
];

const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
export const itemDef = (id: string): Item | undefined => ITEM_BY_ID.get(id);
export const packageDef = (id: string | null | undefined): Package | undefined => PACKAGES.find((p) => p.id === id);
export const PICK_ONE_IDS = new Set(ITEMS.filter((i) => i.pickOne).map((i) => i.id));

// Counted items (each, or a quote with a unit): the unit names and the most allowed.
export function perUnit(item: Item): { unit: string; units: string; max: number } | null {
  const p = item.price;
  if (p.kind === "each") return { unit: p.unit, units: p.units, max: p.max };
  if (p.kind === "quote" && p.unit && p.units) return { unit: p.unit, units: p.units, max: p.max ?? 20 };
  return null;
}

// An item name inside a sentence: "the dusk shots", "the Zillow 3D tour only".
export function inSentence(name: string): string {
  return /^(Zillow|AI )/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

// Whole dollars, with cents only when there are some: "$1,350", "$150.50".
export function usd(cents: number): string {
  const frac = Math.round(cents) % 100 !== 0 ? 2 : 0;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
}

// The price column for one item at the chosen tier.
export function priceHint(item: Item, tier: number): string {
  const p = item.price;
  if (p.kind === "quote") return "Quoted";
  if (p.kind === "flat") return usd(p.cents);
  if (p.kind === "each") return `${usd(p.cents)} per ${p.unit}`;
  if (tier >= 0 && tier < p.cents.length) return usd(p.cents[tier]);
  if (tier === CUSTOM_TIER) return "Quoted";
  return `From ${usd(p.cents[0])}`;
}

export type Selection = { id: string; qty?: number | null; option?: string | null };
export type PricingInput = { package: string | null; items: readonly Selection[]; clientType: string | null; area?: string | null };
export type PricedLine = { id: string; name: string; qty: number; unit: string; unitCents: number; cents: number; priced: boolean; from?: boolean; option?: string | null };
export type PricedItem = { id: string; qty: number; option: string | null };
export type PricedBooking = {
  version: string;
  hash: string;
  package: Package | null; // the size of the home
  tier: number; // 0 to 2, CUSTOM_TIER, or -1 with no size
  items: PricedItem[]; // the selection, cleaned: known ids, one each, one package at most, quantities in range
  unknown: string[]; // ids that are not on the price list
  lines: PricedLine[]; // what was booked
  lineItems: PricedLine[]; // the same lines (invoices); there is no tax line
  subtotalCents: number;
  vatCents: number; // always 0: kept so the studio payload keeps its shape
  totalCents: number;
  needsQuote: boolean;
  quoteReasons: string[];
  hasVideo: boolean;
  minutes: number;
  serviceIds: string[]; // the size first, then the package or solo service
  addonIds: string[];
  servicesLabel: string; // names only, never prices
  addonsLabel: string;
};

const clampQty = (v: unknown, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : 1;
};

const minutesAt = (m: Item["minutes"], tier: number): number => (typeof m === "number" ? m : m[tier >= 0 && tier < m.length ? tier : m.length - 1]);

export function priceBooking(input: PricingInput): PricedBooking {
  const pkg = packageDef(input.package) ?? null;
  const tier = pkg ? pkg.tier : -1;
  const clientType = (CLIENT_TYPES as readonly string[]).includes(String(input.clientType)) ? (String(input.clientType) as ClientType) : "agent";
  const quotedClient = QUOTED_CLIENT_TYPES.includes(clientType);
  const reasons: string[] = [];
  const unknown: string[] = [];

  // One of each item, in the order given; one package or solo service at most (the first wins).
  const picked = new Map<string, PricedItem>();
  let pickOne: string | null = null;
  for (const s of input.items) {
    const id = String(s?.id ?? "").trim();
    if (!id) continue;
    const item = ITEM_BY_ID.get(id);
    if (!item) {
      if (!unknown.includes(id)) unknown.push(id);
      continue;
    }
    if (picked.has(id)) continue;
    if (item.pickOne) {
      if (pickOne) continue;
      pickOne = id;
    }
    const unit = perUnit(item);
    const qty = unit ? clampQty(s.qty, unit.max) : 1;
    const option = item.options ? (item.options.find((o) => o.id === s.option) ?? item.options[0]).id : null;
    picked.set(id, { id, qty, option });
  }
  const items = ITEMS.filter((i) => picked.has(i.id)).map((i) => picked.get(i.id)!);
  const has = (id: string) => picked.has(id);
  const hasOrder = items.some((i) => {
    const it = ITEM_BY_ID.get(i.id)!;
    return it.pickOne || it.standalone;
  });

  const lines: PricedLine[] = [];
  let minutes = pkg ? pkg.minutes : 0;
  for (const sel of items) {
    const item = ITEM_BY_ID.get(sel.id)!;
    const opt = item.options?.find((o) => o.id === sel.option);
    const name = opt ? `${item.name} (${opt.name.toLowerCase()})` : item.name;
    const p = item.price;
    const unit = perUnit(item);
    let line: PricedLine;
    if (quotedClient && item.pickOne) {
      line = { id: item.id, name, qty: 1, unit: "item", unitCents: 0, cents: 0, priced: false };
      reasons.push("Builder and commercial shoots are quoted to the project.");
    } else if (p.kind === "quote") {
      line = { id: item.id, name, qty: sel.qty, unit: unit ? (sel.qty === 1 ? unit.unit : unit.units) : "item", unitCents: 0, cents: 0, priced: false };
      reasons.push(`We will confirm the price for the ${inSentence(item.name)}.`);
    } else if (p.kind === "tier") {
      const cents = tier >= 0 && tier < p.cents.length ? p.cents[tier] : null;
      line = { id: item.id, name, qty: 1, unit: "item", unitCents: cents ?? 0, cents: cents ?? 0, priced: cents != null };
      if (cents == null) reasons.push(tier === CUSTOM_TIER ? "This size gets a custom quote. We will send it." : "Pick the size of the home.");
    } else if (p.kind === "flat") {
      line = { id: item.id, name, qty: 1, unit: "item", unitCents: p.cents, cents: p.cents, priced: true };
    } else {
      line = { id: item.id, name, qty: sel.qty, unit: sel.qty === 1 ? p.unit : p.units, unitCents: p.cents, cents: p.cents * sel.qty, priced: true };
    }
    if (opt) line.option = opt.id;
    lines.push(line);
    minutes += minutesAt(item.minutes, tier) * (unit ? sel.qty : 1);
    if (item.needs && !item.needs.some(has)) {
      const names = item.needs.map((id) => inSentence(ITEM_BY_ID.get(id)?.name ?? id));
      reasons.push(`The ${inSentence(item.name)} goes with the ${names.join(" or the ")}.`);
    }
    if (item.needsOrder && !hasOrder) reasons.push(`The ${inSentence(item.name)} goes with a package or another service.`);
  }
  if (!pkg) reasons.push("Pick the size of the home.");
  if (!hasOrder) reasons.push("Pick a package, or a service booked on its own.");
  if (isOutsideArea(input.area)) reasons.push("We will confirm any travel fee.");
  if (unknown.length) reasons.push(`Not on the price list: ${unknown.join(", ")}.`);

  const subtotalCents = lines.reduce((n, l) => n + (l.priced ? l.cents : 0), 0);
  const services = items.filter((i) => ITEM_BY_ID.get(i.id)?.role === "service");
  const addons = items.filter((i) => ITEM_BY_ID.get(i.id)?.role === "addon");
  const label = (i: PricedItem) => {
    const item = ITEM_BY_ID.get(i.id)!;
    return perUnit(item) ? `${item.name} (${i.qty})` : item.name;
  };
  return {
    version: PRICING_VERSION,
    hash: PRICING_HASH,
    package: pkg,
    tier,
    items,
    unknown,
    lines,
    lineItems: lines,
    subtotalCents,
    vatCents: 0,
    totalCents: subtotalCents,
    needsQuote: reasons.length > 0,
    quoteReasons: [...new Set(reasons)],
    hasVideo: items.some((i) => ITEM_BY_ID.get(i.id)?.video),
    minutes: Math.max(60, Math.ceil(minutes / 15) * 15), // calendar blocks in quarter hours
    serviceIds: [...(pkg ? [pkg.id] : []), ...services.map((i) => i.id)],
    addonIds: addons.map((i) => i.id),
    servicesLabel: [...(pkg ? [pkg.name] : []), ...services.map(label)].join(" + "),
    addonsLabel: addons.map(label).join(" + "),
  };
}

// A stable fingerprint of the whole table: the website sends it with every
// booking so the studio can compare it to its own.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
export const PRICE_TABLE = { version: PRICING_VERSION, customTier: CUSTOM_TIER, packages: PACKAGES, included: INCLUDED, quotedClientTypes: QUOTED_CLIENT_TYPES, items: ITEMS };
export const PRICE_TABLE_JSON = canonical(PRICE_TABLE);
export const PRICING_HASH = fnv1a(PRICE_TABLE_JSON);
// ==== END SHARED PRICE TABLE ====

// ---- Website only: the payload /api/booking sends the studio -----------------
// Field names follow the studio's booking contract, so the studio takes it as is: the service area goes in
// "island" and outside the home counties in "off_island"; "service_area" and
// "outside_area" carry the same values under clearer names.
// Priced here from the table above; the browser's total is never trusted.
// Returns a short error for anything the form should have caught.
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildBookingPayload(input: Obj, submissionId: string): { ok: true; payload: Obj } | { ok: false; error: string } {
  const client = obj(input.client);
  const property = obj(input.property);
  const clientType = text(input.client_type) as ClientType;
  if (!(CLIENT_TYPES as readonly string[]).includes(clientType)) return { ok: false, error: "client type" };
  const name = text(client.name);
  const email = text(client.email).toLowerCase();
  const phone = text(client.phone, 60);
  if (name.length < 2 || !EMAIL_RE.test(email)) return { ok: false, error: "name and email" };
  const address = text(property.address, 300);
  if (address.length < 5) return { ok: false, error: "address" };
  const area = text(input.area ?? input.island, 80);
  if (!(AREAS as readonly string[]).includes(area)) return { ok: false, error: "area" };
  const timeWindow = text(input.time_window) as TimeWindow;
  if (!(TIME_WINDOWS as readonly string[]).includes(timeWindow)) return { ok: false, error: "time of day" };
  const desiredDate = text(input.desired_date, 10);
  if (!YMD_RE.test(desiredDate)) return { ok: false, error: "date" };
  const launchDate = YMD_RE.test(text(input.launch_date, 10)) ? text(input.launch_date, 10) : null;
  if (input.agreed_to_terms !== true) return { ok: false, error: "terms" };
  const company = text(client.company) || null;
  const brokerage = clientType === "agent" ? text(input.brokerage) || company : null;
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, 40).map(obj).map((i) => ({ id: text(i.id, 40), qty: typeof i.qty === "number" ? i.qty : Number(i.qty) || 1, option: text(i.option, 40) || null }));
  const priced = priceBooking({ package: text(input.package, 20) || null, items, clientType, area });
  if (!priced.lines.length) return { ok: false, error: "nothing chosen" };
  if (priced.unknown.length) return { ok: false, error: "unknown items" };
  const shown = typeof input.total_cents === "number" ? Math.round(input.total_cents) : null;
  return {
    ok: true,
    payload: {
      submission_id: submissionId,
      source: "website",
      submitted_at: new Date().toISOString(),
      client: { name, email, phone: phone || null, company: clientType === "agent" ? brokerage : company },
      client_type: clientType,
      brokerage,
      billing: defaultBilling(),
      property: { address, access: text(property.access, 2000) || null },
      island: area,
      off_island: isOutsideArea(area),
      service_area: area,
      outside_area: isOutsideArea(area),
      photo_use: "sale",
      time_window: timeWindow,
      desired_date: desiredDate,
      launch_date: launchDate,
      package: priced.package?.id ?? null,
      items: priced.items,
      line_items: priced.lineItems,
      subtotal_cents: priced.subtotalCents,
      vat_cents: 0,
      total_cents: priced.totalCents,
      needs_quote: priced.needsQuote,
      quote_reasons: priced.quoteReasons,
      pricing_version: priced.version,
      pricing_hash: priced.hash,
      notes: text(input.notes, 4000) || null,
      agreed_to_terms: true,
      ...(shown != null && shown !== priced.totalCents ? { browser_total_cents: shown } : {}),
    },
  };
}
