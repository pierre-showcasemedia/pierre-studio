// Titus, the pay-at-close provider (docs/booking-to-payment.md).
// Pay at close is the ONLY thing Titus does for us: a card booking is a Stripe
// invoice, a pay-at-close booking is a Titus checkout created at booking by the
// titus.checkout.create job (payNowEnabled: false). The client never gets the
// raw checkoutUrl in an email (Titus expires unpaid checkouts on its own
// clock); they get our pay page, which opens the checkout in the Browser SDK
// popup and recreates it when Titus has canceled it (idempotency_version + 1).
//
// Downloads never unlock from anything in this file: a succeeded status goes
// through applyPaid (src/lib/payments.ts), from the webhook or a server-side
// GET of the checkout. Never from the SDK callback or a redirect.
//
// API facts (Oct 2026): POST /v1/checkouts (x-api-key, optional idempotency-key
// header; amount in DOLLARS 1..50000), GET /v1/checkouts/{id},
// POST /v1/checkouts/{id}/cancel; every response is { data: entity }; statuses
// requires-payment | processing | succeeded | canceled.
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { fmtDollars } from "./studio-pricing";
import { siteUrl } from "./brand";
import { enqueueJobs, FatalJobError, jobKey, NotConfiguredError, type JobSpec } from "./jobs-core";
import { paymentsText } from "./slack";

export const TITUS_SDK_SRC = "https://assets.gotitus.com/sdk/v1/titus.js";

export function hasTitus(): boolean {
  return Boolean((process.env.TITUS_API_KEY || "").trim());
}

export function titusApiBase(): string {
  return (process.env.TITUS_API_BASE_URL || "https://api.gotitus.com").trim().replace(/\/+$/, "");
}

// Set only against Titus staging; the production SDK needs nothing.
export function titusWebBase(): string | null {
  return (process.env.NEXT_PUBLIC_TITUS_WEB_BASE_URL || "").trim() || null;
}

export class TitusApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "TitusApiError";
    this.status = status;
    this.body = body;
  }
}

export type TitusCheckoutStatus = "requires-payment" | "processing" | "succeeded" | "canceled";

// The checkout entity as we read it. Only the fields we rely on are typed; the
// rest rides along so payloads can be stored whole in payment_events.
export type TitusCheckout = {
  id: string;
  status: TitusCheckoutStatus | string;
  checkoutUrl?: string | null;
  amount?: number | null; // dollars
  orderId?: string | null;
  externalCustomerId?: string | null;
  metadata?: Record<string, string> | null;
  loanDecision?: string | null;
  [k: string]: unknown;
};

export type TitusCreateCheckout = {
  amount: number; // dollars, 1..50000
  successUrl: string;
  cancelUrl: string;
  orderId: string;
  idempotencyKey: string;
  externalCustomerId: string;
  metadata: Record<string, string>;
  project?: {
    address?: { addressLine1: string; city: string; state: string; zip: string };
    contact?: { firstName?: string; lastName?: string; phone?: string; workEmail?: string; brokerage?: string };
  };
  description?: string;
  payNowEnabled: boolean;
  tipOptions: null;
};

function messageOf(json: unknown, fallback: string): string {
  if (json && typeof json === "object") {
    const j = json as Record<string, unknown>;
    const err = j.error && typeof j.error === "object" ? (j.error as Record<string, unknown>) : null;
    const m = err?.message ?? j.message ?? j.error;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return fallback;
}

async function titusRequest<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const key = (process.env.TITUS_API_KEY || "").trim();
  if (!key) throw new NotConfiguredError("Titus pay at close (TITUS_API_KEY)");
  const headers: Record<string, string> = { "x-api-key": key, accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  const r = await fetch(`${titusApiBase()}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!r.ok) throw new TitusApiError(r.status, messageOf(json, `Titus responded ${r.status}`), json);
  const data = json && typeof json === "object" && "data" in (json as Record<string, unknown>) ? (json as { data: T }).data : (json as T);
  return data;
}

export function getCheckout(id: string): Promise<TitusCheckout> {
  return titusRequest<TitusCheckout>(`/v1/checkouts/${encodeURIComponent(id)}`);
}

export function cancelCheckout(id: string): Promise<TitusCheckout> {
  return titusRequest<TitusCheckout>(`/v1/checkouts/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function createCheckout(body: TitusCreateCheckout): Promise<TitusCheckout> {
  return titusRequest<TitusCheckout>("/v1/checkouts", { method: "POST", body, idempotencyKey: body.idempotencyKey });
}

// Webhook signature: hex HMAC-SHA256 of `${timestamp}.${rawBody}` with
// TITUS_WEBHOOK_SECRET, compared in constant time.
export function verifyTitusSignature(raw: string, timestamp: string, signature: string, secret: string): boolean {
  if (!secret || !timestamp || !signature) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  const given = signature.trim().toLowerCase().replace(/^sha256=/, "");
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

export const TITUS_WEBHOOK_TOLERANCE_MS = 5 * 60_000;

// The idempotency key the checkout for an invoice carries, as body field and
// header: a new idempotency_version (after Titus canceled the last checkout)
// makes a genuinely new checkout; a retry of the same version returns the same.
export function titusIdempotencyKey(listingId: string, invoiceId: string, version: number): string {
  return `listing-${listingId}-inv-${invoiceId}-v${version}`;
}

function digits(s: string | null | undefined): string | undefined {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d : undefined;
}

export type TitusCheckoutResult = { skipped?: string; id?: string; checkoutUrl?: string | null; status?: string };

// Creates the Titus checkout for a pay-at-close invoice and records it on the
// row. Idempotent: a row that already has a provider_id is left alone, and the
// request carries listing-<listingId>-inv-<invoiceId>-v<version>.
export async function createCheckoutForInvoice(invoiceId: string): Promise<TitusCheckoutResult> {
  const d = db();
  const inv = await d.query.invoices.findFirst({
    where: eq(schema.invoices.id, invoiceId),
    with: { client: true, listing: true, booking: { columns: { id: true, market: true, property: true } } },
  });
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  if (inv.provider !== "titus") return { skipped: `provider is ${inv.provider ?? "unset"}` };
  if (inv.providerId) return { skipped: "already created", id: inv.providerId, checkoutUrl: inv.hostedUrl, status: inv.status };
  if (!["open", "review", "processing"].includes(inv.status)) return { skipped: `status is ${inv.status}` };
  if (!inv.listing) throw new Error("invoice has no listing");
  const client = inv.client ?? (inv.clientEmail ? await d.query.clients.findFirst({ where: eq(schema.clients.email, inv.clientEmail) }) : null);
  if (!client) throw new Error("invoice has no client");
  if (!hasTitus()) throw new NotConfiguredError("Titus pay at close (TITUS_API_KEY)");

  const cents = inv.amountCents ?? inv.amountDue ?? 0;
  const dollars = Math.round(cents) / 100;
  // No retry fixes an amount outside the range: the job dies at once with one
  // hub alert (the amount is scrubbed there) and the admin switches to card.
  if (!(dollars >= 1 && dollars <= 50000)) throw new FatalJobError(`amount ${fmtDollars(cents)} is outside the Titus range ($1 to $50,000); switch the booking to card`);

  const listing = inv.listing;
  const prop = (inv.booking?.property ?? {}) as Record<string, unknown>;
  const street = listing.address.split(",")[0].trim();
  // The split address from intake (listings.city/state/zip), else what the
  // booking form said. `project` goes to Titus only when the address is
  // complete (street, city, two-letter state, 5-digit zip); without one the
  // whole block is omitted, never a contact-only project.
  const pick = (a: string | null | undefined, b: unknown): string => (a && a.trim() ? a : typeof b === "string" ? b : "").trim();
  const city = pick(listing.city, prop.city);
  const state = pick(listing.state, prop.state).toUpperCase();
  const zipRaw = pick(listing.zip, prop.zip);
  const zip = /^\d{5}(-\d{4})?$/.test(zipRaw) ? zipRaw.slice(0, 5) : null;
  const address = street && city && /^[A-Z]{2}$/.test(state) && zip ? { addressLine1: street, city, state, zip } : undefined;

  const nameParts = (client.name ?? "").trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] ?? client.email.split("@")[0];
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : undefined;
  const contact = {
    firstName,
    ...(lastName ? { lastName } : {}),
    ...(digits(client.phone) ? { phone: digits(client.phone) } : {}),
    workEmail: client.email,
    ...(client.company ? { brokerage: client.company } : {}),
  };

  const base = siteUrl();
  const version = inv.idempotencyVersion;
  const body: TitusCreateCheckout = {
    amount: dollars,
    successUrl: `${base}/portal/${listing.slug}?paid=1`,
    cancelUrl: `${base}/portal/${listing.slug}/pay`,
    orderId: listing.id,
    idempotencyKey: titusIdempotencyKey(listing.id, inv.id, version),
    externalCustomerId: client.id,
    metadata: {
      listing_id: listing.id,
      invoice_id: inv.id,
      booking_id: inv.bookingId ?? "",
      client_id: client.id,
      slug: listing.slug,
      market: inv.booking?.market ?? "",
      invoice_type: "production",
      source: "studio",
      env: inv.env ?? "",
    },
    ...(address ? { project: { address, contact } } : {}),
    ...(inv.description ? { description: inv.description } : {}),
    payNowEnabled: false,
    tipOptions: null,
  };

  const c = await createCheckout(body);
  if (!c?.id) throw new Error("Titus returned no checkout id");
  const now = new Date();
  await d
    .update(schema.invoices)
    .set({
      providerId: c.id,
      hostedUrl: c.checkoutUrl ?? null,
      orderId: listing.id,
      lastEvent: { type: "checkout.created", at: now.toISOString(), status: c.status ?? null, source: "api" },
      lastCheckedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.invoices.id, inv.id));
  await logActivity({
    action: "invoice.issued",
    listingId: inv.listingId,
    clientId: client.id,
    meta: { invoiceId: inv.id, provider: "titus", checkoutId: c.id, amountCents: cents, version },
  });

  // The payments channel hears "invoice sent" (amounts allowed there); the hub
  // never does. If the booking email went out before this checkout existed
  // without a pay page link, the client gets the link once.
  const specs: JobSpec[] = [
    {
      kind: "slack.payment",
      idempotencyKey: `slack.payment:issued:${inv.id}:v${version}`,
      invoiceId: inv.id,
      bookingId: inv.bookingId,
      listingId: inv.listingId,
      payload: {
        version,
        text: paymentsText.issued({
          listing: { address: listing.address, nda: listing.nda },
          listingId: listing.id,
          bookingId: inv.bookingId,
          client: client.name ? `${client.name} (${client.email})` : client.email,
          amount: fmtDollars(cents),
          method: "pay at close",
          provider: "titus",
        }),
      },
    },
  ];
  if (inv.bookingId) {
    const sent = await d.execute<{ pay_link: string | null }>(sql`
      SELECT meta->>'payLink' AS pay_link FROM activity
       WHERE action = 'email.booking_sent' AND meta->>'bookingId' = ${inv.bookingId}
       ORDER BY created_at DESC LIMIT 1`);
    const row = sent.rows[0];
    if (row && row.pay_link !== "true") {
      specs.push({ kind: "email.pay_link", idempotencyKey: jobKey("email.pay_link", inv.id, version), invoiceId: inv.id, bookingId: inv.bookingId, listingId: inv.listingId, payload: { version, again: false } });
    }
  }
  await enqueueJobs(specs);
  return { id: c.id, checkoutUrl: c.checkoutUrl ?? null, status: c.status };
}
