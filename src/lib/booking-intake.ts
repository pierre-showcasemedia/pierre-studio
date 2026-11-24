// Booking intake (docs/booking-to-payment.md): the website's booking
// form becomes a client, a listing, a booking, an invoice, activity rows and
// the jobs that do everything else, in ONE database batch. The route only
// guards and parses; this file owns the rules:
//   - submission_id is the booking id: the same id again is a duplicate (no
//     side effects); a new id with the same email + street + date inside 24 h
//     is a revision of the earlier booking.
//   - every price is recomputed here from service and add-on ids; the website's
//     total is only compared (a difference = needs_quote, a human sets the amount).
//   - card → Stripe invoice; pay at close → Titus checkout; both as jobs.
//   - pay another way (check, ACH transfer or cash) → an invoice row with
//     method "other" and no provider: nothing is ever queued at Stripe or
//     Titus for it, an admin settles it with Mark paid.
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, like, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { BookingPaymentDetail, BookingPaymentMethod, BookingProperty, BookingRaw, InvoiceMeta, InvoiceProvider, InvoiceStatus } from "@/db/schema";
import { ADDONS, PRICING_HASH, PRICING_VERSION, SERVICES, SIZES, isSizeId, isVideoBooking, quote, resolveItemIds, type Selection } from "./studio-pricing";
import { business } from "./business";
import { wallClockToUtc, toHm, toYmd } from "./booking-time";
import { siteUrl } from "./brand";
import { currentEnv, jobKey, jobRows, type JobSpec } from "./jobs-core";
import { parsePaymentDetail } from "./pay-other";
import { applyClientDiscount } from "./client-pricing";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const US_STATE_RE = /^(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/i;
const REVISION_WINDOW_MS = 24 * 3600_000;
const REUSE_WINDOW_MS = 90 * 86_400_000;
// The form's "Additional details" box is free text; keep it to a sane size.
const DETAILS_MAX = 4000;

type Body = Record<string, unknown>;
// A statement db().batch() accepts (insert / update builders, not awaited).
type Batchable = Parameters<ReturnType<typeof db>["batch"]>[0][number];

export type IntakePayload = {
  submissionId: string; // uuid; the booking id
  givenId: string | null; // what the website sent when it was not a uuid
  source: string;
  market: string | null; // the service area the client picked (the website's "island" / service_area)
  travelMiles: number | null; // driving miles from the base, worked out by the website's server (travel bands; empty table = unused)
  clientType: string | null; // agent | homeowner | builder | other
  items: Selection[]; // the website's selection with quantities (size not included)
  pricingHash: string | null; // the website's price table fingerprint
  client: { email: string; name: string | null; phone: string | null; company: string | null };
  property: BookingProperty & { sqft: number | null; access: string | null };
  serviceIds: string[];
  addonIds: string[];
  unknownItems: string[]; // names we could not map to the price table
  customRequest: string | null;
  desiredDate: string | null; // YYYY-MM-DD
  startTime: string | null; // HH:MM, business time zone
  launchDate: string | null;
  beds: number | null; // optional form fields (studio template, Nov 22 2026): stored only
  baths: number | null;
  sellerEmail: string | null; // never emailed: automated emails stay off (business switches)
  timeShiftOk: boolean;
  textsOptIn: boolean; // needed before any automated text; texts stay off (business.autoTexts)
  paymentMethod: BookingPaymentMethod | null;
  paymentDetail: BookingPaymentDetail | null; // check | ach | cash, only with paymentMethod "other"
  additionalDetails: string | null; // the form's "Additional details" (bookings.client_notes)
  signedName: string | null;
  signedAt: Date | null;
  websiteTotalCents: number | null;
  estimatedTotalLabel: string | null;
  summary: string | null;
  raw: Body;
};

// ---- Normalizing what the website sends -----------------------------------

const str = (v: unknown): string => {
  if (v == null) return "";
  if (Array.isArray(v)) return str(v[v.length - 1]);
  if (typeof v === "object") return "";
  return String(v).trim();
};
const obj = (v: unknown): Body | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : null);
function first(sources: (Body | null)[], keys: string[]): string {
  for (const src of sources) {
    if (!src) continue;
    for (const k of keys) {
      const s = str(src[k]);
      if (s) return s;
    }
  }
  return "";
}
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : str(v) ? str(v).split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];

// "100 Example Lane, Springfield, CA 90000" → its parts. Anything we cannot
// read with confidence stays in the street line or the city.
export function splitAddress(full: string): { street: string; city: string | null; state: string | null; zip: string | null } {
  const parts = full.split(",").map((s) => s.trim()).filter(Boolean);
  const street = parts[0] ?? "";
  const rest = parts.slice(1).join(", ");
  if (!rest) return { street, city: null, state: null, zip: null };
  const m = /^(.*?)[,\s]*\b([A-Za-z]{2})\.?(?:\s+(\d{5}(?:-\d{4})?))?\s*$/.exec(rest);
  if (m && (m[3] || US_STATE_RE.test(m[2]))) {
    return { street, city: m[1].replace(/[,\s]+$/, "").trim() || null, state: m[2].toUpperCase(), zip: m[3] ?? null };
  }
  return { street, city: rest, state: null, zip: null };
}

export function slugify(street: string): string {
  return street.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "listing";
}

// A uuid derived from a seed, so the same thing maps to the same booking id.
function derivedUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function bookingContentKey(email: string, street: string, desiredDate: string | null): string {
  return createHash("sha256").update(`${email.trim().toLowerCase()}|${street.trim().toLowerCase()}|${desiredDate ?? ""}`).digest("hex");
}

export function normalizeBookingPayload(body: Body): { ok: true; p: IntakePayload } | { ok: false; error: string } {
  const client = obj(body.client);
  const property = obj(body.property);
  const timing = obj(body.timing);

  const email = first([client, body], ["email", "client_email"]).toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "a valid email is required" };
  const name =
    first([client, body], ["name", "full_name"]) ||
    [first([client, body], ["first_name", "firstName"]), first([client, body], ["last_name", "lastName"])].filter(Boolean).join(" ") ||
    null;
  const phone = first([client, body], ["phone"]) || null;
  const company = first([client, body], ["company", "brokerage"]) || null;

  const given = first([property, body], ["street", "address", "property_address"]);
  if (given.length < 5) return { ok: false, error: "a property address is required" };
  const split = given.includes(",") ? splitAddress(given) : { street: given, city: null, state: null, zip: null };
  const street = split.street;
  if (street.length < 5) return { ok: false, error: "a property address is required" };
  const city = first([property, body], ["city"]) || split.city;
  const state = (first([property, body], ["state"]) || split.state || "").toUpperCase() || null;
  const zip = first([property, body], ["zip", "postal_code", "zipcode"]) || split.zip;

  const sqftRaw = first([property, body], ["sqft", "square_feet", "squareFootage"]).replace(/[^0-9.]/g, "");
  const sqftN = sqftRaw ? Math.round(Number(sqftRaw)) : NaN;
  const sqft = Number.isFinite(sqftN) && sqftN > 0 ? sqftN : null;

  // The website sends the home's size as "package" and the selection as
  // "items" ([{ id, qty, option }]), priced by the same table
  // (src/lib/booking-pricing.ts). Older shapes (service_ids, addon_ids,
  // services as names) still map.
  const sizeRaw = first([body], ["package", "size"]);
  const sizeHit = sizeRaw ? resolveItemIds([sizeRaw], SIZES) : { ids: [], unknown: [] };
  const rawItems = Array.isArray(body.items) ? (body.items as unknown[]).slice(0, 40) : [];
  const items: Selection[] = [];
  const itemUnknown: string[] = [];
  for (const it of rawItems) {
    const o = obj(it);
    const id = o ? str(o.id) : str(it);
    if (!id || isSizeId(id)) continue;
    const hit = resolveItemIds([id], [...SERVICES, ...ADDONS]);
    if (!hit.ids.length) {
      itemUnknown.push(id);
      continue;
    }
    const qty = o && Number.isFinite(Number(o.qty)) ? Math.max(1, Math.floor(Number(o.qty))) : 1;
    if (!items.some((x) => x.id === hit.ids[0])) items.push({ id: hit.ids[0], qty, option: o ? str(o.option) || null : null });
  }
  const services = resolveItemIds(body.service_ids ?? body.serviceIds ?? body.services, [...SIZES, ...SERVICES]);
  const addons = resolveItemIds(body.addon_ids ?? body.addonIds ?? body.addons, ADDONS);
  const extras = resolveItemIds(body.additional_services ?? body.extras, ADDONS);
  const sizeId = sizeHit.ids[0] ?? services.ids.find(isSizeId) ?? null;
  const serviceIdsAll = [...new Set([...(sizeId ? [sizeId] : []), ...items.filter((i) => SERVICES.some((s) => s.id === i.id)).map((i) => i.id), ...services.ids.filter((id) => !isSizeId(id))])];
  const addonIds = [...new Set([...items.filter((i) => ADDONS.some((a) => a.id === i.id)).map((i) => i.id), ...addons.ids, ...extras.ids])];
  const unknownItems = [...sizeHit.unknown, ...itemUnknown, ...services.unknown, ...addons.unknown, ...extras.unknown].filter((x) => !/^none$/i.test(x));
  const services_ = { ids: serviceIdsAll };

  const desiredDate = toYmd(first([timing, body], ["desired_date", "shoot_date", "date"]));
  const startTime = toHm(first([timing, body], ["start_time", "time"]));
  const launchDate = toYmd(first([timing, body], ["launch_date"]));

  const methodRaw = first([body], ["payment_method"]).toLowerCase().replace(/-/g, "_");
  const payRaw = first([body], ["pay_at_close", "pay_at_close_choice"]).toLowerCase();
  // pay_other (check | ach | cash) names the other way; payment_method "other"
  // wins over the pay_at_close Yes / No the form keeps sending for old readers.
  const detailRaw = parsePaymentDetail(first([body], ["pay_other", "payment_detail", "payOther"]));
  let paymentMethod: BookingPaymentMethod | null =
    methodRaw === "pay_at_close" ? "pay_at_close" : methodRaw === "card" ? "card" : /^(other|another_way|pay_other)$/.test(methodRaw) ? "other" : null;
  if (!paymentMethod && !methodRaw && detailRaw) paymentMethod = "other";
  if (!paymentMethod) paymentMethod = /^(yes|true|1)$/.test(payRaw) ? "pay_at_close" : /^(no|false|0)$/.test(payRaw) ? "card" : null;
  const paymentDetail = paymentMethod === "other" ? detailRaw : null;
  const additionalDetails = first([body], ["additional_details", "additionalDetails", "client_notes", "notes"]).slice(0, DETAILS_MAX) || null;

  const signedName = first([body], ["signed_name", "agreement_terms", "signature"]) || null;
  const signedAtRaw = first([body], ["signed_at"]);
  const agreed = body.agreed_to_terms === true;
  const signedAt = signedAtRaw && !Number.isNaN(Date.parse(signedAtRaw)) ? new Date(signedAtRaw) : signedName || agreed ? new Date() : null;

  const totalRaw = body.total_cents ?? body.totalCents;
  const websiteTotalCents = typeof totalRaw === "number" && Number.isFinite(totalRaw) ? Math.round(totalRaw) : null;
  const estimatedTotalLabel = first([body], ["estimated_total", "estimatedTotal"]) || null;

  const market = first([body], ["service_area", "area", "island", "market"]).slice(0, 80) || null;
  const milesRaw = Number(body.travel_miles);
  const travelMiles = body.travel_miles != null && Number.isFinite(milesRaw) && milesRaw >= 0 ? Math.round(milesRaw) : null;
  const num = (v: unknown, max: number, step: number): number | null => {
    const n = typeof v === "number" ? v : Number(v);
    return v == null || v === "" || !Number.isFinite(n) || n < 0 || n > max ? null : Math.round(n / step) * step;
  };
  const beds = num(body.beds, 30, 1);
  const baths = num(body.baths, 30, 0.5);
  const sellerRaw = typeof body.seller_email === "string" ? body.seller_email.trim().toLowerCase().slice(0, 200) : "";
  const sellerEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sellerRaw) ? sellerRaw : null;
  const timeShiftOk = body.time_shift_ok === true;
  const textsOptIn = body.texts_opt_in === true;
  const clientType = first([body], ["client_type", "clientType"]).toLowerCase() || null;
  const pricingHash = first([body], ["pricing_hash", "pricingHash"]) || null;
  const timeWindow = first([timing, body], ["time_window", "timeWindow"]).toLowerCase() || null;

  // view_home arrives as "Yes" / "No" or as the list of views.
  const viewRaw = first([property, body], ["view_home", "viewHome"]);
  const viewsList = list(property?.views ?? body.views);
  const viewHome = /^(yes|no)$/i.test(viewRaw) ? viewRaw : viewRaw ? "Yes" : viewsList.length ? "Yes" : null;
  const views = viewsList.length ? viewsList : viewRaw && !/^(yes|no)$/i.test(viewRaw) ? list(viewRaw) : [];

  const givenId = first([body], ["submission_id", "submissionId"]) || null;
  const submissionId =
    givenId && UUID_RE.test(givenId)
      ? givenId.toLowerCase()
      : derivedUuid(
          givenId
            ? `id:${givenId}`
            : `content:${[email, street.toLowerCase(), desiredDate, startTime, launchDate, services_.ids.join(","), addonIds.join(","), JSON.stringify(items), sqft, paymentMethod, websiteTotalCents, signedName, ...(paymentDetail ? [paymentDetail] : [])].join("|")}`
        );

  return {
    ok: true,
    p: {
      submissionId,
      givenId: givenId && givenId.toLowerCase() !== submissionId ? givenId : null,
      source: first([body], ["source"]) || "website",
      market,
      travelMiles,
      clientType,
      items,
      pricingHash,
      client: { email, name, phone, company },
      property: {
        street,
        city: city || null,
        state,
        zip: zip || null,
        sqft,
        status: first([property, body], ["status", "property_status"]) || null,
        listingType: first([property, body], ["listing_type", "listingType"]) || null,
        offMarket: first([property, body], ["off_market", "offMarket"]) || null,
        listingAgreement: first([property, body], ["listing_agreement", "listingAgreement"]) || null,
        facing: first([property, body], ["facing"]) || null,
        viewHome,
        views,
        homeownerHome: first([property, body], ["homeowner_home", "homeowner", "homeownerHome"]) || null,
        videoStyle: first([body], ["video_style", "video_speed", "videoStyle"]) || null,
        musicLink: first([body], ["music_link", "musicLink"]) || null,
        timeWindow: startTime ? null : timeWindow,
        access: first([property, body], ["access", "access_notes"]) || null,
      },
      serviceIds: services_.ids,
      addonIds,
      unknownItems,
      customRequest: first([body], ["custom_request", "customRequest"]) || null,
      desiredDate,
      startTime,
      launchDate,
      beds,
      baths,
      sellerEmail,
      timeShiftOk,
      textsOptIn,
      paymentMethod,
      paymentDetail,
      additionalDetails,
      signedName,
      signedAt,
      websiteTotalCents,
      estimatedTotalLabel,
      summary: first([body], ["booking_summary", "summary"]) || null,
      raw: body,
    },
  };
}

// ---- Writing the rows ------------------------------------------------------

export type IntakeResult = {
  kind: "duplicate" | "created" | "revised";
  bookingId: string;
  listingId: string;
  invoiceId: string | null;
  slug: string;
  invoiceStatus: string | null;
  needsQuote: boolean;
  changed?: string[];
};

function nextSlug(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  for (const s of taken) {
    const m = new RegExp(`^${base}-(\\d+)$`).exec(s);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `${base}-${n}`;
}

function defaultShooter(): string | null {
  const v = (process.env.DEFAULT_SHOOTER_EMAIL || "").trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : null;
}

const sameList = (a: unknown, b: unknown) => JSON.stringify([...((a as string[] | null) ?? [])].sort()) === JSON.stringify([...((b as string[] | null) ?? [])].sort());

export async function intakeBooking(p: IntakePayload): Promise<IntakeResult> {
  const d = db();
  const env = currentEnv();
  const now = new Date();

  // 1. The same submission again: a retry of the same form session. No side effects.
  const dup = await d.query.bookings.findFirst({
    where: eq(schema.bookings.id, p.submissionId),
    with: { listing: { columns: { slug: true } }, invoice: { columns: { id: true, status: true } } },
  });
  if (dup) {
    await d.insert(schema.activity).values({ action: "booking.duplicate", listingId: dup.listingId, clientId: dup.clientId, meta: { bookingId: dup.id } });
    return {
      kind: "duplicate",
      bookingId: dup.id,
      listingId: dup.listingId,
      invoiceId: dup.invoiceId,
      slug: dup.listing?.slug ?? "",
      invoiceStatus: dup.invoice?.status ?? null,
      needsQuote: dup.invoice?.status === "needs_quote",
    };
  }

  // 2. Price it ourselves. A client with a saved discount (clients.discount_percent,
  // src/lib/client-pricing.ts) gets it as its own line once the price is final.
  const known = !business.clientDiscount ? null : await d.query.clients.findFirst({ where: eq(schema.clients.email, p.client.email), columns: { discountPercent: true } });
  const q0 = quote(p.serviceIds, p.addonIds, { items: p.items, clientType: p.clientType, area: p.market, miles: p.travelMiles });
  // The price table's own reasons (a quoted size or item, a travel fee to
  // confirm, a builder's project quote), then ours.
  const reasons: string[] = [...q0.reasons];
  if (p.unknownItems.length) reasons.push(`unrecognized: ${p.unknownItems.join(", ")}`);
  if (!q0.lineItems.length) reasons.push("no services chosen");
  if (p.pricingHash && p.pricingHash !== PRICING_HASH) reasons.push("the website's price table differs from the studio's (copy src/lib/pricing.ts over)");
  const mismatch = p.websiteTotalCents != null && !q0.inquire && p.websiteTotalCents !== q0.totalCents;
  if (mismatch) reasons.push("website total differs");
  if (!reasons.length && q0.totalCents <= 0) reasons.push("nothing priced");
  const needsQuote = reasons.length > 0;
  const q = needsQuote || !business.clientDiscount ? q0 : applyClientDiscount(q0, known?.discountPercent);
  const invoiceStatus: InvoiceStatus = needsQuote ? "needs_quote" : "open";
  // The business's way to pay when the form names none (business.payments):
  // a Stripe invoice, or no processor and a person marks it paid.
  const defaultMethod: BookingPaymentMethod = business.payments === "manual" ? "other" : "card";
  const paymentMethod: BookingPaymentMethod = p.paymentMethod === "pay_at_close" && !business.payAtClose ? defaultMethod : (p.paymentMethod ?? defaultMethod);
  // Pay another way has no provider: no Stripe invoice, no Titus checkout, ever.
  const provider: InvoiceProvider | null = paymentMethod === "pay_at_close" ? "titus" : paymentMethod === "other" ? null : "stripe";
  const paymentDetail: BookingPaymentDetail | null = paymentMethod === "other" ? p.paymentDetail : null;
  const notes = [
    ...reasons,
    ...(p.paymentMethod || business.payments !== "stripe" ? [] : ["payment method not given; card assumed"]),
    ...(paymentMethod === "other" ? [paymentDetail ? `pays another way (${paymentDetail}), no pay link; mark it paid when it arrives` : "pays another way (check, ACH transfer or cash not given), no pay link; mark it paid when it arrives"] : []),
  ];
  const meta: InvoiceMeta = {
    pricingVersion: PRICING_VERSION,
    tier: q.tier,
    computedTotalCents: q.totalCents,
    websiteTotalCents: p.websiteTotalCents,
    estimatedTotalLabel: p.estimatedTotalLabel,
    pending: q.pending,
    inquire: q.inquire,
    mismatch,
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };

  // 3. The client (idempotent on email; never overwrites what we already know).
  const existingClient = await d.query.clients.findFirst({ where: eq(schema.clients.email, p.client.email), columns: { id: true } });
  const [client] = await d
    .insert(schema.clients)
    .values({ email: p.client.email, name: p.client.name, phone: p.client.phone, company: p.client.company })
    .onConflictDoUpdate({
      target: schema.clients.email,
      set: {
        name: sql`coalesce(${schema.clients.name}, excluded.name)`,
        phone: sql`coalesce(${schema.clients.phone}, excluded.phone)`,
        company: sql`coalesce(${schema.clients.company}, excluded.company)`,
      },
    })
    .returning({ id: schema.clients.id });
  const clientIsNew = !existingClient;

  // Shared row values.
  const address = [p.property.street, p.property.city, [p.property.state, p.property.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const shootDate = p.desiredDate ? new Date(`${p.desiredDate}T00:00:00Z`) : null;
  const startsAt = p.desiredDate && p.startTime ? wallClockToUtc(p.desiredDate, p.startTime) : null;
  const endsAt = startsAt ? new Date(startsAt.getTime() + q.minutes * 60_000) : null;
  const property: BookingProperty = {
    street: p.property.street,
    city: p.property.city,
    state: p.property.state,
    zip: p.property.zip,
    status: p.property.status,
    listingType: p.property.listingType,
    offMarket: p.property.offMarket,
    listingAgreement: p.property.listingAgreement,
    facing: p.property.facing,
    viewHome: p.property.viewHome,
    views: p.property.views,
    homeownerHome: p.property.homeownerHome,
    videoStyle: p.property.videoStyle,
    musicLink: p.property.musicLink,
  };
  const bookingValues = {
    market: p.market,
    travelMiles: p.travelMiles,
    paymentMethod,
    paymentDetail,
    desiredDate: p.desiredDate,
    startTime: p.startTime,
    startsAt,
    endsAt,
    launchDate: p.launchDate,
    beds: p.beds,
    baths: p.baths,
    sellerEmail: p.sellerEmail,
    timeShiftOk: p.timeShiftOk,
    textsOptIn: p.textsOptIn,
    sqft: p.property.sqft,
    tier: q.tier >= 0 ? q.tier : null,
    serviceIds: p.serviceIds,
    addonIds: p.addonIds,
    items: q.items,
    clientType: p.clientType,
    servicesLabel: q.servicesLabel || null,
    customRequest: p.customRequest,
    accessNotes: p.property.access,
    property,
    signedName: p.signedName,
    signedAt: p.signedAt,
    clientNotes: p.additionalDetails,
    updatedAt: now,
  };
  const listingPatch = {
    shootDate,
    ...(p.property.city ? { city: p.property.city } : {}),
    ...(p.property.state ? { state: p.property.state } : {}),
    ...(p.property.zip ? { zip: p.property.zip } : {}),
  };
  const description = `${p.property.street}${q.servicesLabel ? ` · ${q.servicesLabel}` : ""}`;
  const invoiceInsert = (id: string, bookingId: string, listingId: string) =>
    d.insert(schema.invoices).values({
      id,
      listingId,
      clientId: client.id,
      clientEmail: p.client.email,
      propertyAddress: address,
      status: invoiceStatus,
      amountDue: q.totalCents,
      amountCents: q.totalCents,
      currency: "usd",
      provider,
      method: paymentMethod,
      description,
      lineItems: q.lineItems,
      meta,
      bookingId,
      idempotencyVersion: 1,
      env,
      updatedAt: now,
    });
  const stmts: Batchable[] = [];
  const acts: (typeof schema.activity.$inferInsert)[] = [];
  const specs: JobSpec[] = [];

  // 4. A new submission for the same email + street + date inside 24 h is a
  //    revision of that booking, not a second one.
  const contentKey = bookingContentKey(p.client.email, p.property.street, p.desiredDate);
  const prev = await d.query.bookings.findFirst({
    where: and(
      eq(schema.bookings.contentKey, contentKey),
      eq(schema.bookings.env, env),
      ne(schema.bookings.status, "canceled"),
      gt(schema.bookings.createdAt, new Date(now.getTime() - REVISION_WINDOW_MS))
    ),
    orderBy: [desc(schema.bookings.createdAt)],
    with: { invoice: true, listing: { columns: { id: true, slug: true } } },
  });

  if (prev) {
    const listingId = prev.listingId;
    const slug = prev.listing?.slug ?? slugify(p.property.street);
    const version = prev.calendarVersion + 1;
    const changed: string[] = [];
    if (prev.desiredDate !== p.desiredDate) changed.push("date");
    if (prev.startTime !== p.startTime) changed.push("time");
    if (prev.launchDate !== p.launchDate) changed.push("launch date");
    if (!sameList(prev.serviceIds, p.serviceIds)) changed.push("services");
    if (!sameList(prev.addonIds, p.addonIds)) changed.push("add-ons");
    if (JSON.stringify(prev.items ?? []) !== JSON.stringify(q.items)) changed.push("quantities");
    if (prev.paymentMethod !== paymentMethod || (prev.paymentDetail ?? null) !== paymentDetail) changed.push("payment method");
    if (prev.sqft !== p.property.sqft) changed.push("square footage");
    if (((prev.property as BookingProperty | null)?.listingAgreement ?? null) !== (p.property.listingAgreement ?? null)) changed.push("listing agreement");
    if ((prev.clientNotes ?? null) !== (p.additionalDetails ?? null)) changed.push("additional details");

    const inv = prev.invoice;
    let invoiceId = inv?.id ?? null;
    let invoiceStatusOut: string | null = inv?.status ?? null;
    let issuedConflict = false;
    // An invoice an admin already touched (Set amount, Switch to card, a
    // reissue) is kept like an issued one: a form resubmit never silently
    // undoes an admin's decision; the admin hears and decides.
    const adminTouched = Boolean(inv?.meta?.quotedBy) || inv?.lastEvent?.type === "switched_to_card" || inv?.lastEvent?.type === "reissued";
    stmts.push(d.update(schema.listings).set(listingPatch).where(eq(schema.listings.id, listingId)));
    if (!inv) {
      invoiceId = randomUUID();
      stmts.push(invoiceInsert(invoiceId, prev.id, listingId));
      invoiceStatusOut = invoiceStatus;
      acts.push(
        needsQuote
          ? { action: "invoice.needs_quote", listingId, clientId: client.id, meta: { invoiceId, reason: reasons.join("; "), provider } }
          : { action: "invoice.created", listingId, clientId: client.id, meta: { invoiceId, provider, amountCents: q.totalCents } }
      );
    } else if (!inv.providerId && !adminTouched && (inv.status === "needs_quote" || inv.status === "open")) {
      // Not issued yet and untouched: the invoice simply follows the new request.
      stmts.push(
        d
          .update(schema.invoices)
          .set({
            status: invoiceStatus,
            amountDue: q.totalCents,
            amountCents: q.totalCents,
            provider,
            method: paymentMethod,
            description,
            lineItems: q.lineItems,
            meta: { ...(inv.meta ?? {}), ...meta, previousAmountCents: inv.amountCents },
            updatedAt: now,
          })
          .where(eq(schema.invoices.id, inv.id))
      );
      invoiceStatusOut = invoiceStatus;
    } else {
      // Issued, paid, or set by an admin: never move money around on a form resubmit.
      issuedConflict = inv.amountCents !== q.totalCents || inv.method !== paymentMethod;
      if (issuedConflict) {
        const how = inv.providerId ? "issued" : "set by hand";
        stmts.push(
          d
            .update(schema.invoices)
            .set({
              meta: { ...(inv.meta ?? {}), revisedAfterIssue: true, previousAmountCents: inv.amountCents, requestedAmountCents: q.totalCents, note: `client revised the booking after the invoice was ${how}: ${changed.join(", ") || "details"}` },
              updatedAt: now,
            })
            .where(eq(schema.invoices.id, inv.id))
        );
        acts.push({ action: "invoice.revised_after_issue", listingId, clientId: client.id, meta: { invoiceId: inv.id, changed: changed.join(", "), requestedAmountCents: q.totalCents, amountCents: inv.amountCents, how } });
      }
    }
    const prevRaw: BookingRaw = prev.raw ?? { submissionIds: [prev.id], payload: {} };
    const raw: BookingRaw = {
      ...prevRaw,
      submissionIds: [...new Set([...prevRaw.submissionIds, p.submissionId, ...(p.givenId ? [p.givenId] : [])])],
      payload: p.raw,
      summary: p.summary,
      estimatedTotalLabel: p.estimatedTotalLabel,
      websiteTotalCents: p.websiteTotalCents,
    };
    // A confirmed booking whose client moved the date or time needs confirming
    // again: back to requested (the calendar event goes TENTATIVE with the
    // new version), and the admin page says so.
    const timeChanged = changed.includes("date") || changed.includes("time");
    const reconfirm = prev.status === "confirmed" && timeChanged;
    stmts.push(d.update(schema.bookings).set({ ...bookingValues, invoiceId, calendarVersion: version, raw, ...(reconfirm ? { status: "requested" as const } : {}) }).where(eq(schema.bookings.id, prev.id)));
    acts.push({ action: "booking.revised", listingId, clientId: client.id, meta: { bookingId: prev.id, submissionId: p.submissionId, changed: changed.join(", ") || "details", version, reconfirm } });
    stmts.push(d.insert(schema.activity).values(acts));

    // The provider object, when none exists yet: for a kept invoice (issued,
    // admin-set) its own provider and version decide, never the form's.
    const kept = Boolean(inv) && (Boolean(inv?.providerId) || adminTouched || !(inv?.status === "needs_quote" || inv?.status === "open"));
    const issueProvider = kept ? inv?.provider ?? null : provider;
    const issueNeeded = Boolean(invoiceId) && !inv?.providerId && (kept ? inv?.status === "open" : !needsQuote);
    if (invoiceId && issueNeeded && issueProvider === "stripe") {
      specs.push({ kind: "stripe.invoice.create", idempotencyKey: jobKey("stripe.invoice.create", invoiceId, inv?.idempotencyVersion ?? 1), invoiceId, bookingId: prev.id, listingId, payload: { version: inv?.idempotencyVersion ?? 1, invoiceId } });
    }
    if (invoiceId && issueNeeded && issueProvider === "titus") {
      specs.push({ kind: "titus.checkout.create", idempotencyKey: jobKey("titus.checkout.create", invoiceId, inv?.idempotencyVersion ?? 1), invoiceId, bookingId: prev.id, listingId, payload: { version: inv?.idempotencyVersion ?? 1, invoiceId } });
    }
    specs.push({ kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", prev.id, version), bookingId: prev.id, listingId, payload: { version } });
    specs.push({ kind: "email.booking", idempotencyKey: jobKey("email.booking", prev.id, version), bookingId: prev.id, listingId, invoiceId, payload: { version, updated: true } });
    specs.push({ kind: "slack.booking", idempotencyKey: jobKey("slack.booking", prev.id, version), bookingId: prev.id, listingId, payload: { version, updated: true } });
    // A revision that adds a film or reel gets its Video card (once per booking).
    if (isVideoBooking(p.serviceIds, p.addonIds)) specs.push({ kind: "video.card", idempotencyKey: jobKey("video.card", prev.id, 1), bookingId: prev.id, listingId, payload: { version: 1 } });
    if (issuedConflict) {
      specs.push({
        kind: "slack.issue",
        idempotencyKey: jobKey("slack.issue", prev.id, version),
        bookingId: prev.id,
        listingId,
        invoiceId,
        payload: { version, note: `The booking for ${p.property.street} changed after its invoice was issued (${changed.join(", ") || "details"}). Review the amount: ${siteUrl()}/admin/bookings/${prev.id}` },
      });
    }
    stmts.push(d.insert(schema.jobs).values(jobRows(specs)).onConflictDoNothing({ target: schema.jobs.idempotencyKey }));
    await d.batch(stmts as [Batchable, ...Batchable[]]);
    return { kind: "revised", bookingId: prev.id, listingId, invoiceId, slug, invoiceStatus: invoiceStatusOut, needsQuote: invoiceStatusOut === "needs_quote", changed };
  }

  // 5. A new booking. The listing: reuse this client's listing for the same
  //    street when nothing was published on it in 90 days, otherwise a new one
  //    with a numbered slug (never "do nothing").
  const base = slugify(p.property.street);
  const sameBase = await d.query.listings.findMany({
    where: or(eq(schema.listings.slug, base), like(schema.listings.slug, `${base}-%`)),
    columns: { id: true, slug: true, address: true, clientId: true, createdAt: true },
    with: { media: { columns: { createdAt: true, published: true } }, shoots: { columns: { publishedAt: true } } },
  });
  const cutoff = now.getTime() - REUSE_WINDOW_MS;
  const streetKey = p.property.street.trim().toLowerCase();
  const reusable =
    sameBase
      .filter(
        (l) =>
          l.clientId === client.id &&
          l.address.split(",")[0].trim().toLowerCase() === streetKey &&
          !l.media.some((m) => m.published && m.createdAt.getTime() > cutoff) &&
          !l.shoots.some((s) => s.publishedAt && s.publishedAt.getTime() > cutoff)
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  const listingId = reusable?.id ?? randomUUID();
  const slug = reusable ? reusable.slug : nextSlug(base, sameBase.map((l) => l.slug));
  if (reusable) {
    stmts.push(d.update(schema.listings).set({ ...listingPatch, downloadLocked: true }).where(eq(schema.listings.id, listingId)));
  } else {
    stmts.push(
      d.insert(schema.listings).values({ id: listingId, clientId: client.id, address, slug, shootDate, downloadLocked: true, city: p.property.city, state: p.property.state, zip: p.property.zip })
    );
  }

  const invoiceId = randomUUID();
  stmts.push(invoiceInsert(invoiceId, p.submissionId, listingId));
  const raw: BookingRaw = {
    submissionIds: [p.submissionId, ...(p.givenId ? [p.givenId] : [])],
    payload: p.raw,
    summary: p.summary,
    estimatedTotalLabel: p.estimatedTotalLabel,
    websiteTotalCents: p.websiteTotalCents,
  };
  stmts.push(
    d.insert(schema.bookings).values({
      id: p.submissionId,
      listingId,
      clientId: client.id,
      invoiceId,
      contentKey,
      calendarVersion: 1,
      source: p.source,
      status: "requested",
      ...bookingValues,
      photographerEmail: defaultShooter(),
      raw,
      env,
    })
  );

  if (clientIsNew) acts.push({ action: "client.created", clientId: client.id, meta: { email: p.client.email, via: "booking" } });
  if (!reusable) acts.push({ action: "listing.created", listingId, clientId: client.id, meta: { slug, via: "booking" } });
  acts.push({
    action: "booking.created",
    listingId,
    clientId: client.id,
    meta: { bookingId: p.submissionId, services: q.servicesLabel, addons: q.addonsLabel, paymentMethod, ...(paymentDetail ? { paymentDetail } : {}), amountCents: q.totalCents, desiredDate: p.desiredDate, startTime: p.startTime, reusedListing: Boolean(reusable) },
  });
  acts.push(
    needsQuote
      ? { action: "invoice.needs_quote", listingId, clientId: client.id, meta: { invoiceId, reason: reasons.join("; "), provider } }
      : { action: "invoice.created", listingId, clientId: client.id, meta: { invoiceId, provider, amountCents: q.totalCents } }
  );
  stmts.push(d.insert(schema.activity).values(acts));

  if (!needsQuote && provider === "stripe") {
    specs.push({ kind: "stripe.invoice.create", idempotencyKey: jobKey("stripe.invoice.create", invoiceId, 1), invoiceId, bookingId: p.submissionId, listingId, payload: { version: 1, invoiceId } });
  }
  if (!needsQuote && provider === "titus") {
    specs.push({ kind: "titus.checkout.create", idempotencyKey: jobKey("titus.checkout.create", invoiceId, 1), invoiceId, bookingId: p.submissionId, listingId, payload: { version: 1, invoiceId } });
  }
  specs.push({ kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", p.submissionId, 1), bookingId: p.submissionId, listingId, payload: { version: 1 } });
  specs.push({ kind: "email.booking", idempotencyKey: jobKey("email.booking", p.submissionId, 1), bookingId: p.submissionId, listingId, invoiceId, payload: { version: 1 } });
  specs.push({ kind: "slack.booking", idempotencyKey: jobKey("slack.booking", p.submissionId, 1), bookingId: p.submissionId, listingId, payload: { version: 1 } });
  // Oct 26 2026: the listing's folder in Dropbox the moment the shoot is
  // booked (waits quietly until Dropbox is connected), and a card on the
  // Video board when the booking has a film or reel.
  // Nov 19 2026: Dropbox only for a business on Dropbox (business.fileStore); on Google Drive the folder is made with the first copy.
  if (business.fileStore === "dropbox") specs.push({ kind: "dropbox.folder", idempotencyKey: jobKey("dropbox.folder", listingId, 1), bookingId: p.submissionId, listingId, payload: { version: 1, subfolders: false } });
  if (isVideoBooking(p.serviceIds, p.addonIds)) specs.push({ kind: "video.card", idempotencyKey: jobKey("video.card", p.submissionId, 1), bookingId: p.submissionId, listingId, payload: { version: 1 } });
  stmts.push(d.insert(schema.jobs).values(jobRows(specs)).onConflictDoNothing({ target: schema.jobs.idempotencyKey }));

  await d.batch(stmts as [Batchable, ...Batchable[]]);
  return { kind: "created", bookingId: p.submissionId, listingId, invoiceId, slug, invoiceStatus, needsQuote };
}
