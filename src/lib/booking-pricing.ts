// Showcase Media's price table (Pierre Stephenson, Madison, Wisconsin), for the
// booking form and /api/booking. The ONLY place prices live on the website:
// nothing else on the public site shows a price.
//
// Source: Pierre's Nov 2026 price sheet (PriceSheet-Nov2026.pdf), with
// Showcase Photography and the drone and 3D tour prices on their own from the
// pages of his current site (the PDF doesn't list them). His agent rate sheets
// (Stark Preferred, Preferred Agent, HomeTeam4U) are private: they live only in
// the studio (src/lib/agent-rates.ts), never in this file, because this file
// ships in the public website's code. Never invent a price here.
//
// How it works: the client picks the size of the home (it sets the tier), then
// one package or one service on its own, then add-ons. Size bands follow the
// sheet: tours and bundles break at 1,200 / 3,000 / 5,000 / 7,500 sq ft (7,501+
// is custom), the Complete Walkthrough Video at 2,500 / 5,000 / 7,500 / 10,000.
// The free floor plan covers up to 3,000 sq ft of TOTAL scanned space
// (garages, basements and unfinished areas count), which clients rarely know,
// so the larger floor plan is an add-on they choose by scanned size, never
// charged from the finished size they pick (Pierre, Nov 23 2026).
//
// The block between the SHARED markers is copied, line for line, into the
// studio's src/lib/booking-pricing.ts, so the studio re-prices every booking
// with the same table. Change a price, bump PRICING_VERSION, copy the file to
// the studio, run `npx tsx scripts/check-pricing.ts` in both repos.
// Safe to import from client components (no server code).

// ---- Business rules the form needs ----------------------------------------------
// Where Pierre shoots. No travel fee within 25 miles of Madison and Sun
// Prairie; farther, $0.50 a mile round trip, which Pierre confirms from the
// address (the form doesn't know the miles).
export const TRAVEL_FREE_MILES = 25;
export const TRAVEL_CENTS_PER_MILE = 50; // round trip
export const AREAS = [
  "Within 25 miles of our studio (east Madison, near Sun Prairie)",
  "Elsewhere in Wisconsin",
  "Northern Illinois",
  "Somewhere else",
] as const;
export type Area = (typeof AREAS)[number];
export const HOME_AREAS = new Set<string>(["Within 25 miles of our studio (east Madison, near Sun Prairie)"]);
export const isOutsideArea = (area: string | null | undefined) => Boolean(area && !HOME_AREAS.has(area));

export const CLIENT_TYPES = ["agent", "homeowner", "builder", "other"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export const CLIENT_TYPE_LABELS: Record<ClientType, string> = {
  agent: "Real estate agent",
  homeowner: "Homeowner",
  builder: "Builder or designer",
  other: "Commercial or something else",
};

// One flow: the gallery arrives in the client portal and downloads unlock
// once the invoice is paid. Pierre invoices through Wave for now, and marks
// the invoice paid in the studio. "pay_first" is the studio's name for that flow.
export const BILLING_TYPES = ["pay_first"] as const;
export type BillingType = (typeof BILLING_TYPES)[number];
export function defaultBilling(): BillingType {
  return "pay_first";
}

// A date and a time of day. Twilight is an add-on, photographed near dusk.
export const TIME_WINDOWS = ["morning", "midday", "afternoon"] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];
export const TIME_WINDOW_LABELS: Record<TimeWindow, string> = { morning: "Morning", midday: "Midday", afternoon: "Afternoon" };
// "24 Hr normal turnaround. 48 Hr guaranteed." Walkthrough videos: 48 hours.
export const TURNAROUND = "within 24 hours, 48 hours guaranteed";
// "No waiting days; we respond extremely quickly."
export const CONFIRM_WITHIN = "the same day";

// ==== BEGIN SHARED PRICE TABLE ====
// Every amount is US cents. No sales tax line.

export const PRICING_VERSION = "scm-v3-2026-11-23";

// The client picks the home's size first; it sets the tier (0 to 5) for every
// tier-priced item. Over 10,000 sq ft is a custom quote. "cents" is the
// Showcase Photography price, shown as "from" on the size card.
export const CUSTOM_TIER = 99;
export type PackageId = "up_to_1200" | "to_2500" | "to_3000" | "to_5000" | "to_7500" | "to_10000" | "over_10000";
export type Package = {
  id: PackageId;
  name: string;
  cents: number; // Showcase Photography at this size (the "from" price); 0 when quoted
  quoted: boolean; // true: custom quote, Pierre sends the price
  tier: number;
  hint: string;
  minutes: number;
};
export const PACKAGES: readonly Package[] = [
  { id: "up_to_1200", name: "Up to 1,200 sq ft", cents: 175_00, quoted: false, tier: 0, hint: "Condos, apartments and smaller homes", minutes: 60 },
  { id: "to_2500", name: "1,201 to 2,500 sq ft", cents: 175_00, quoted: false, tier: 1, hint: "Most family homes", minutes: 75 },
  { id: "to_3000", name: "2,501 to 3,000 sq ft", cents: 175_00, quoted: false, tier: 2, hint: "Larger family homes", minutes: 90 },
  { id: "to_5000", name: "3,001 to 5,000 sq ft", cents: 175_00, quoted: false, tier: 3, hint: "Large homes", minutes: 105 },
  { id: "to_7500", name: "5,001 to 7,500 sq ft", cents: 175_00, quoted: false, tier: 4, hint: "Estates", minutes: 120 },
  { id: "to_10000", name: "7,501 to 10,000 sq ft", cents: 175_00, quoted: false, tier: 5, hint: "Very large homes. 3D tours and tour bundles are quoted at this size", minutes: 150 },
  { id: "over_10000", name: "Over 10,000 sq ft", cents: 0, quoted: true, tier: CUSTOM_TIER, hint: "Custom quote. We send the price for your property", minutes: 180 },
];

// Every Showcase Photography shoot and every 3D tour includes a free basic
// floor plan with dimensions, up to 3,000 sq ft of total scanned space. A
// larger plan is the floor_plan_large add-on, by scanned size: 3,001 to 5,000
// $30, 5,001 to 7,500 $50, 7,501 to 10,000 $75. Over 10,000 is quoted.
export const INCLUDED = ["Free basic floor plan with dimensions (up to 3,000 sq ft of total scanned space)"] as const;

// Commercial and other non-residential work is quoted to the project.
export const QUOTED_CLIENT_TYPES: readonly ClientType[] = ["other"];

// package: Showcase Photography and the bundles (pick one). solo: a service on
// its own, no photography (also pick one, instead of a package). portrait:
// business portrait sessions (pick one). standalone: add-ons that can go with
// a package or be booked on their own. extras: add-ons that go with an order.
export type ItemGroup = "package" | "solo" | "portrait" | "standalone" | "extras";
export type ItemPrice =
  | { kind: "tier"; cents: readonly number[] }
  | { kind: "flat"; cents: number }
  | { kind: "each"; cents: number; unit: string; units: string; max: number }
  | { kind: "volume"; steps: readonly { from: number; cents: number }[]; unit: string; units: string; max: number } // every unit at the rate for the quantity booked
  | { kind: "quote"; unit?: string; units?: string; max?: number }; // no price yet: Pierre confirms it
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
  floorPlan?: boolean; // includes the free basic floor plan (up to 3,000 scanned sq ft)
  options?: readonly { id: string; name: string; cents?: number }[]; // cents: a flat item priced by the option chosen
  adminOnly?: boolean; // never on the website form
  video?: boolean; // goes on the Video board
  minutes: number | readonly number[]; // calendar time, per unit for counted items
};

// Packages that include Showcase Photography (the photo add-ons go with these).
const PHOTO_PACKAGES = ["photos", "photo_drone", "tour_bundle", "walkthrough_bundle", "aerial_bundle", "classic", "grand"] as const;
// Everything with a walkthrough video (agent guided tour, advanced imaging).
const WALKTHROUGHS = ["walkthrough_bundle", "grand", "walkthrough_showcase", "walkthrough_complete"] as const;

export const ITEMS: readonly Item[] = [
  // Showcase Photography and the bundles. Every one includes up to 40 Showcase Photography images.
  { id: "photos", name: "Showcase Photography", desc: "Up to 40 images, with Showcase editing: HDR detail, blue sky replacement as needed, window views, fire in the fireplaces and green grass.", group: "package", role: "service", pickOne: true, floorPlan: true, price: { kind: "tier", cents: [175_00, 175_00, 175_00, 175_00, 175_00, 175_00] }, minutes: 0 },
  { id: "photo_drone", name: "Photo Drone Bundle", desc: "Showcase Photography and up to 16 drone aerial photos.", group: "package", role: "service", pickOne: true, floorPlan: true, price: { kind: "tier", cents: [240_00, 240_00, 240_00, 240_00, 240_00, 240_00] }, minutes: 20 },
  { id: "tour_bundle", name: "3D Tour Bundle", desc: "Showcase Photography and a 3D virtual tour (Matterport or Zillow), hosted for up to 1 year.", group: "package", role: "service", pickOne: true, floorPlan: true, price: { kind: "tier", cents: [300_00, 325_00, 325_00, 375_00, 470_00] }, minutes: [30, 45, 45, 60, 75] },
  { id: "classic", name: "Classic Bundle", desc: "Showcase Photography, up to 16 drone aerial photos and a 3D virtual tour, hosted for up to 1 year.", group: "package", role: "service", pickOne: true, floorPlan: true, price: { kind: "tier", cents: [365_00, 390_00, 390_00, 440_00, 535_00] }, minutes: [50, 65, 65, 80, 95] },
  { id: "walkthrough_bundle", name: "Highlight Walkthrough Bundle", desc: "Showcase Photography and a 1 to 2 minute edited Highlight Walkthrough Video. Add an agent guided tour or advanced imaging in the next step.", group: "package", role: "service", pickOne: true, floorPlan: true, video: true, price: { kind: "tier", cents: [350_00, 350_00, 350_00, 350_00, 350_00, 350_00] }, minutes: 45 },
  { id: "aerial_bundle", name: "Complete Aerial Bundle", desc: "Showcase Photography, up to 16 drone aerial photos and a 1 to 2 minute cinematic drone highlights video.", group: "package", role: "service", pickOne: true, floorPlan: true, video: true, price: { kind: "tier", cents: [375_00, 375_00, 375_00, 375_00, 375_00, 375_00] }, minutes: 40 },
  { id: "grand", name: "Grand Showcase Bundle", desc: "Everything: Showcase Photography, up to 16 drone aerial photos, a 3D virtual tour hosted for up to 1 year, and a 1 to 2 minute Highlight Walkthrough Video.", group: "package", role: "service", pickOne: true, floorPlan: true, video: true, price: { kind: "tier", cents: [515_00, 540_00, 540_00, 590_00, 685_00] }, minutes: [90, 105, 105, 120, 135] },
  // On their own, no photography
  { id: "drone_photos", name: "Drone Aerial Photography", desc: "Up to 16 drone aerial photos, on their own. Drone flights depend on FAA rules, local rules, safety and the weather.", group: "solo", role: "service", pickOne: true, price: { kind: "flat", cents: 150_00 }, minutes: 45 },
  { id: "drone_video", name: "Cinematic Aerial Video", desc: "A 1 to 2 minute edited drone highlights video, on its own.", group: "solo", role: "service", pickOne: true, video: true, price: { kind: "flat", cents: 150_00 }, minutes: 45 },
  { id: "aerial_package", name: "Complete Aerial Package", desc: "Drone aerial photos and the cinematic aerial video, on their own.", group: "solo", role: "service", pickOne: true, video: true, price: { kind: "flat", cents: 250_00 }, minutes: 60 },
  { id: "tour", name: "3D Virtual Tour", desc: "A Matterport or Zillow 3D virtual tour, hosted for up to 1 year, with a free basic floor plan.", group: "solo", role: "service", pickOne: true, floorPlan: true, options: [{ id: "matterport", name: "Matterport" }, { id: "zillow", name: "Zillow" }], price: { kind: "tier", cents: [150_00, 175_00, 175_00, 225_00, 300_00] }, minutes: [45, 60, 60, 75, 90] },
  { id: "walkthrough_showcase", name: "Showcase Walkthrough Video", desc: "A 1 to 2 minute walkthrough video edited to music, with aerial intro and closing clips. 48 to 72 hour turnaround.", group: "solo", role: "service", pickOne: true, video: true, price: { kind: "flat", cents: 175_00 }, minutes: 60 },
  { id: "walkthrough_complete", name: "Complete Walkthrough Video", desc: "A 2 to 3 minute walkthrough video edited to music, with aerial intro and closing clips. 48 to 72 hour turnaround.", group: "solo", role: "service", pickOne: true, video: true, price: { kind: "tier", cents: [225_00, 225_00, 255_00, 255_00, 280_00, 310_00] }, minutes: [60, 75, 90, 90, 105, 120] },
  // Business portraits
  { id: "portrait_session", name: "Environmental business portrait session", desc: "One person, photographed at your business. Includes 1 retouched image.", group: "portrait", role: "service", pickOne: true, price: { kind: "flat", cents: 295_00 }, minutes: 60 },
  { id: "group_portrait", name: "Group portrait", desc: "Up to 10 people. Includes 1 retouched image.", group: "portrait", role: "service", pickOne: true, price: { kind: "flat", cents: 295_00 }, minutes: 60 },
  { id: "large_group", name: "Large group portrait", desc: "More than 10 people. We send a quote.", group: "portrait", role: "service", pickOne: true, price: { kind: "quote" }, minutes: 90 },
  { id: "portrait_extra_person", name: "Additional person", desc: "Another person in the same portrait session. Includes 1 retouched image.", group: "extras", role: "addon", needs: ["portrait_session"], price: { kind: "each", cents: 150_00, unit: "person", units: "people", max: 20 }, minutes: 20 },
  { id: "portrait_small_group", name: "Small group setup", desc: "A small group added to a portrait session. Includes 1 retouched image.", group: "extras", role: "addon", needs: ["portrait_session"], price: { kind: "each", cents: 95_00, unit: "setup", units: "setups", max: 10 }, minutes: 15 },
  { id: "portrait_retouch", name: "Additional retouched images", desc: "More retouched images from your portrait session.", group: "extras", role: "addon", needs: ["portrait_session", "group_portrait"], price: { kind: "each", cents: 95_00, unit: "image", units: "images", max: 30 }, minutes: 0 },
  // Add-ons that go with an order
  { id: "drone_addon", name: "Add drone photos", desc: "Up to 16 drone aerial photos at the same appointment.", group: "extras", role: "addon", needs: ["photos", "walkthrough_bundle", "tour"], price: { kind: "flat", cents: 69_00 }, minutes: 20 },
  { id: "drone_video_addon", name: "Add cinematic drone video", desc: "A 1 to 2 minute cinematic drone highlights video, added to any package.", group: "extras", role: "addon", needs: PHOTO_PACKAGES, video: true, price: { kind: "flat", cents: 135_00 }, minutes: 20 },
  { id: "agent_tour", name: "Agent guided tour", desc: "You on camera, guiding buyers through the home in your walkthrough video.", group: "extras", role: "addon", needs: WALKTHROUGHS, video: true, price: { kind: "flat", cents: 69_00 }, minutes: 30 },
  { id: "advanced_imaging", name: "Advanced imaging", desc: "Effects and transitions in your video: day to night, four seasons, house drops and reveals, virtual staging, construction timelapse and more.", group: "extras", role: "addon", needs: WALKTHROUGHS, video: true, price: { kind: "each", cents: 30_00, unit: "effect", units: "effects", max: 10 }, minutes: 0 },
  { id: "extra_images", name: "Additional images", desc: "Showcase Photography images beyond the 40 included.", group: "extras", role: "addon", needs: PHOTO_PACKAGES, price: { kind: "each", cents: 4_00, unit: "image", units: "images", max: 60 }, minutes: 0 },
  { id: "virtual_staging", name: "Virtual staging", desc: "An empty room furnished in the photo, in the decor style you choose. $30 each for 1 to 3, $25 each for 4 or more.", group: "extras", role: "addon", needsOrder: true, price: { kind: "volume", steps: [{ from: 1, cents: 30_00 }, { from: 4, cents: 25_00 }], unit: "photo", units: "photos", max: 30 }, minutes: 0 },
  { id: "twilight", name: "Twilight Photography", desc: "6 to 8 images photographed near dusk, with sunset sky replacement as needed. Can also be booked on its own. We confirm the evening with you.", group: "extras", role: "addon", standalone: true, price: { kind: "flat", cents: 125_00 }, minutes: 0 },
  { id: "virtual_twilight", name: "Virtual twilight", desc: "A daytime exterior turned to twilight. $20 each for 1 to 3, $15 each for 4 or more.", group: "extras", role: "addon", needsOrder: true, price: { kind: "volume", steps: [{ from: 1, cents: 20_00 }, { from: 4, cents: 15_00 }], unit: "image", units: "images", max: 20 }, minutes: 0 },
  { id: "floor_plan_large", name: "Larger floor plan", desc: "The free floor plan covers up to 3,000 sq ft of total scanned space, including garages, basements and unfinished areas. For a larger property, pick its scanned size. Not sure? We confirm it after the scan.", group: "extras", role: "addon", needs: [...PHOTO_PACKAGES, "tour"], options: [{ id: "to_5000", name: "3,001 to 5,000 sq ft", cents: 30_00 }, { id: "to_7500", name: "5,001 to 7,500 sq ft", cents: 50_00 }, { id: "to_10000", name: "7,501 to 10,000 sq ft", cents: 75_00 }], price: { kind: "flat", cents: 30_00 }, minutes: 0 },
  { id: "floor_plan_schematic", name: "Schematic floor plan", desc: "Upgrades the free floor plan: total area, cabinets, appliances, fixtures, door swings and a home report.", group: "extras", role: "addon", needs: [...PHOTO_PACKAGES, "tour"], price: { kind: "flat", cents: 50_00 }, minutes: 0 },
  { id: "floor_plan_3d", name: "3D floor plan", desc: "Everything in the schematic plan, plus 3D walls, furniture, color and texture.", group: "extras", role: "addon", needs: [...PHOTO_PACKAGES, "tour"], price: { kind: "flat", cents: 100_00 }, minutes: 0 },
  { id: "floor_plan_cad", name: "CAD files", desc: "The schematic floor plan plus 2D and 3D CAD files (DWG, DAE, OBJ, FBX).", group: "extras", role: "addon", needs: [...PHOTO_PACKAGES, "tour"], price: { kind: "flat", cents: 100_00 }, minutes: 0 },
  // Studio only: quoted work Pierre adds to a booking by hand
  { id: "timelapse", name: "Timelapse photography", desc: "Construction, renovation or business marketing timelapse. Quoted.", group: "extras", role: "addon", adminOnly: true, price: { kind: "quote" }, minutes: 0 },
];

const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
export const itemDef = (id: string): Item | undefined => ITEM_BY_ID.get(id);
export const packageDef = (id: string | null | undefined): Package | undefined => PACKAGES.find((p) => p.id === id);
export const PICK_ONE_IDS = new Set(ITEMS.filter((i) => i.pickOne).map((i) => i.id));

// Counted items (each, volume, or a quote with a unit): the unit names and the most allowed.
export function perUnit(item: Item): { unit: string; units: string; max: number } | null {
  const p = item.price;
  if (p.kind === "each" || p.kind === "volume") return { unit: p.unit, units: p.units, max: p.max };
  if (p.kind === "quote" && p.unit && p.units) return { unit: p.unit, units: p.units, max: p.max ?? 20 };
  return null;
}

// The per-unit rate of a volume-priced item at a quantity.
export function volumeRate(steps: readonly { from: number; cents: number }[], qty: number): number {
  let cents = steps[0].cents;
  for (const s of steps) if (qty >= s.from) cents = s.cents;
  return cents;
}

// An item name inside a sentence: "the 3D Tour Bundle", "the agent guided tour".
export function inSentence(name: string): string {
  return /^(Showcase|Photo |3D|Classic|Highlight|Complete|Grand|Drone|Cinematic|Twilight|CAD)/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1);
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
  if (p.kind === "flat") return item.options?.some((o) => o.cents != null) ? `From ${usd(Math.min(...item.options.map((o) => o.cents ?? p.cents)))}` : usd(p.cents);
  if (p.kind === "each") return `${usd(p.cents)} per ${p.unit}`;
  if (p.kind === "volume") return `From ${usd(p.steps[p.steps.length - 1].cents)} per ${p.unit}`;
  if (tier >= 0 && tier < p.cents.length) return usd(p.cents[tier]);
  if (tier === CUSTOM_TIER || tier >= p.cents.length) return "Quoted";
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
  tier: number; // 0 to 5, CUSTOM_TIER, or -1 with no size
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
    const name = opt ? `${item.name} (${opt.name})` : item.name;
    const p = item.price;
    const unit = perUnit(item);
    let line: PricedLine;
    if (quotedClient && item.pickOne) {
      line = { id: item.id, name, qty: 1, unit: "item", unitCents: 0, cents: 0, priced: false };
      reasons.push("Commercial work is quoted to the project.");
    } else if (p.kind === "quote") {
      line = { id: item.id, name, qty: sel.qty, unit: unit ? (sel.qty === 1 ? unit.unit : unit.units) : "item", unitCents: 0, cents: 0, priced: false };
      reasons.push(`We confirm the price for the ${inSentence(item.name)}.`);
    } else if (p.kind === "tier") {
      const cents = tier >= 0 && tier < p.cents.length ? p.cents[tier] : null;
      line = { id: item.id, name, qty: 1, unit: "item", unitCents: cents ?? 0, cents: cents ?? 0, priced: cents != null };
      if (cents == null) reasons.push(tier < 0 ? "Pick the size of the property." : `The ${inSentence(item.name)} is quoted for a property this size. We send the price.`);
    } else if (p.kind === "flat") {
      const cents = opt?.cents ?? p.cents;
      line = { id: item.id, name, qty: 1, unit: "item", unitCents: cents, cents, priced: true };
    } else if (p.kind === "volume") {
      const rate = volumeRate(p.steps, sel.qty);
      line = { id: item.id, name, qty: sel.qty, unit: sel.qty === 1 ? p.unit : p.units, unitCents: rate, cents: rate * sel.qty, priced: true };
    } else {
      line = { id: item.id, name, qty: sel.qty, unit: sel.qty === 1 ? p.unit : p.units, unitCents: p.cents, cents: p.cents * sel.qty, priced: true };
    }
    if (opt) line.option = opt.id;
    lines.push(line);
    minutes += minutesAt(item.minutes, tier) * (unit ? sel.qty : 1);
    if (item.needs && !item.needs.some(has)) {
      const names = item.needs.map((id) => inSentence(ITEM_BY_ID.get(id)?.name ?? id));
      reasons.push(names.length > 3 ? `The ${inSentence(item.name)} goes with a package that includes it.` : `The ${inSentence(item.name)} goes with the ${names.join(" or the ")}.`);
    }
    if (item.needsOrder && !hasOrder) reasons.push(`The ${inSentence(item.name)} goes with a package or another service.`);
  }
  if (!pkg) reasons.push("Pick the size of the property.");
  if (!hasOrder) reasons.push("Pick a package, or a service booked on its own.");
  if (isOutsideArea(input.area)) reasons.push("More than 25 miles from our studio, travel is $0.50 a mile round trip. We confirm it with you.");
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
export const PRICE_TABLE = { version: PRICING_VERSION, customTier: CUSTOM_TIER, packages: PACKAGES, included: INCLUDED, travelFreeMiles: TRAVEL_FREE_MILES, travelCentsPerMile: TRAVEL_CENTS_PER_MILE, quotedClientTypes: QUOTED_CLIENT_TYPES, items: ITEMS };
export const PRICE_TABLE_JSON = canonical(PRICE_TABLE);
export const PRICING_HASH = fnv1a(PRICE_TABLE_JSON);
// ==== END SHARED PRICE TABLE ====

// ---- Website only: the payload /api/booking sends the studio -----------------
// Field names follow the studio's booking contract (the same names the shared
// studio reads), so Pierre's studio takes it as is: the service area goes in
// "island" and outside the 25 mile radius in "off_island"; "service_area" and
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
