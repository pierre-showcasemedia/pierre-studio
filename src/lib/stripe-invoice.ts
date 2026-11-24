// Stripe invoice at booking (docs/booking-to-payment.md). Runs as the
// `stripe.invoice.create` job on the business's own Stripe account (never the previous portal's):
// find or create the customer, create a send_invoice invoice due the day it is
// issued (local) with one line per priced item, finalize it, store the
// hosted link. Stripe's
// own customer emails (invoice, receipt) stay ON (Oct 16 2026); our
// booking email carries the same hosted link behind its "Pay invoice" button,
// and the studio sends no receipt of its own.
//
// Idempotent end to end: every Stripe call carries an idempotency key derived
// from the invoice id and its idempotency_version, and a row that already has
// a provider_id is left alone.
import Stripe from "stripe";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { fmtDollars } from "./studio-pricing";
import { brand, supportEmail, supportPhone } from "./brand";
import { wallClockToUtc } from "./booking-time";
import { enqueueJobs, NotConfiguredError } from "./jobs-core";
import { addDaysYmd, localYmd } from "./local-date";
import { paymentsText } from "./slack";

export function hasStripe(): boolean {
  return Boolean((process.env.STRIPE_SECRET_KEY || "").trim());
}

export function stripeClient(): Stripe {
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) throw new NotConfiguredError(`${brand.shortName}’s Stripe key (STRIPE_SECRET_KEY)`);
  return new Stripe(key);
}

// Due the same day it is created (Oct 25 2026; it was net 30): 11:59 PM
// local today, as a Unix timestamp. Stripe wants a due date in the future, so
// an invoice issued in the last hour of the day is due the next day instead.
export function dueTodaySeconds(now: Date = new Date()): number {
  const endOf = (ymd: string) => (wallClockToUtc(ymd, "23:59")?.getTime() ?? now.getTime()) + 59_000;
  const today = localYmd(now);
  const due = endOf(today) - now.getTime() >= 60 * 60_000 ? endOf(today) : endOf(addDaysYmd(today, 1));
  return Math.floor(due / 1000);
}

export type StripeInvoiceResult = { skipped?: string; providerId?: string; hostedUrl?: string | null };

export async function createStripeInvoiceForInvoice(invoiceId: string): Promise<StripeInvoiceResult> {
  const d = db();
  const inv = await d.query.invoices.findFirst({
    where: eq(schema.invoices.id, invoiceId),
    with: { client: true, listing: { columns: { id: true, slug: true, address: true, nda: true } }, booking: { columns: { id: true, market: true, desiredDate: true } } },
  });
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  if (inv.provider !== "stripe") return { skipped: `provider is ${inv.provider ?? "unset"}` };
  if (inv.providerId) return { skipped: "already issued", providerId: inv.providerId, hostedUrl: inv.hostedUrl };
  if (inv.status !== "open") return { skipped: `status is ${inv.status}` };
  // A client discount is a negative line (src/lib/client-pricing.ts): Stripe takes it as a credit item.
  const lines = (inv.lineItems ?? []).filter((l) => l.priced && l.cents !== 0);
  if (!lines.length || !inv.amountCents) return { skipped: "nothing priced" };
  const client = inv.client ?? (inv.clientEmail ? await d.query.clients.findFirst({ where: eq(schema.clients.email, inv.clientEmail) }) : null);
  if (!client) throw new Error("invoice has no client");

  const stripe = stripeClient();
  const idem = (suffix: string) => ({ idempotencyKey: `studio:inv:${inv.id}:v${inv.idempotencyVersion}:${suffix}` });

  // The customer: the one we know, else the one Stripe knows by email, else new.
  let customerId = client.stripeCustomerId;
  if (!customerId) {
    const found = await stripe.customers.list({ email: client.email, limit: 1 });
    customerId = found.data[0]?.id ?? null;
    if (!customerId) {
      const created = await stripe.customers.create(
        { email: client.email, name: client.name ?? undefined, phone: client.phone ?? undefined, metadata: { client_id: client.id, company: client.company ?? "" } },
        idem(`customer:${client.id}`)
      );
      customerId = created.id;
    }
    await d.update(schema.clients).set({ stripeCustomerId: customerId }).where(eq(schema.clients.id, client.id));
  }

  const address = inv.listing?.address ?? inv.propertyAddress ?? "";
  const street = address.split(",")[0].trim();
  const metadata: Record<string, string> = {
    invoice_id: inv.id,
    listing_id: inv.listingId ?? "",
    booking_id: inv.bookingId ?? "",
    client_id: client.id,
    slug: inv.listing?.slug ?? "",
    market: inv.booking?.market ?? "",
    invoice_type: inv.meta?.invoiceType ?? "production", // "addon" for the items added after a paid invoice (never locks or unlocks)
    property_address: address, // the current webhook matches listings by this
    env: inv.env ?? "",
  };

  const created = await stripe.invoices.create(
    {
      customer: customerId,
      collection_method: "send_invoice",
      due_date: dueTodaySeconds(),
      auto_advance: true,
      pending_invoice_items_behavior: "exclude",
      currency: inv.currency ?? "usd",
      description: inv.description ?? `${street} shoot`,
      footer: `Questions: ${[supportEmail(), supportPhone()].filter(Boolean).join(" or ")}. ${brand.signOff}`,
      metadata,
    },
    idem("invoice")
  );
  // Record the Stripe id at once, so a webhook that lands before we finish
  // updates this row instead of making a second one.
  await d
    .update(schema.invoices)
    .set({ providerId: created.id, stripeInvoiceId: created.id, lastCheckedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.invoices.id, inv.id));

  for (const [i, l] of lines.entries()) {
    await stripe.invoiceItems.create(
      { customer: customerId, invoice: created.id, amount: l.cents, currency: inv.currency ?? "usd", description: l.name },
      idem(`item:${i}:${l.id}`)
    );
  }
  // A retry the next day replays the original draft and its old due date; move
  // it to today before finalizing.
  if ((created.due_date ?? 0) * 1000 < Date.now() + 10 * 60_000) await stripe.invoices.update(created.id, { due_date: dueTodaySeconds() });
  const finalized = await stripe.invoices.finalizeInvoice(created.id, { auto_advance: true }, idem("finalize"));

  // A webhook row for this Stripe id made before our first update above
  // (a tiny window) is folded into ours.
  const twin = await d.query.invoices.findFirst({ where: and(eq(schema.invoices.stripeInvoiceId, created.id), ne(schema.invoices.id, inv.id)), columns: { id: true, status: true } });
  if (twin) await d.delete(schema.invoices).where(eq(schema.invoices.id, twin.id));

  const hosted = finalized.hosted_invoice_url ?? null;
  await d
    .update(schema.invoices)
    .set({
      providerId: finalized.id,
      stripeInvoiceId: finalized.id,
      hostedUrl: hosted,
      hostedInvoiceUrl: hosted,
      orderId: finalized.number ?? null,
      amountDue: inv.amountCents,
      status: twin?.status === "paid" ? "paid" : "open",
      ...(twin?.status === "paid" ? { paidAt: new Date() } : {}),
      lastEvent: { type: "invoice.finalized", at: new Date().toISOString(), status: finalized.status ?? null, dueDate: finalized.due_date ?? null },
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.invoices.id, inv.id));
  await logActivity({ action: "invoice.issued", listingId: inv.listingId, clientId: client.id, meta: { invoiceId: inv.id, provider: "stripe", number: finalized.number ?? null, amountCents: inv.amountCents } });
  // The private payments channel hears "invoice sent" with the amount (step
  // two); the hub never carries dollar amounts. As a job, so a missing webhook
  // waits instead of failing this one.
  await enqueueJobs([
    {
      kind: "slack.payment",
      idempotencyKey: `slack.payment:issued:${inv.id}:v${inv.idempotencyVersion}`,
      invoiceId: inv.id,
      bookingId: inv.bookingId,
      listingId: inv.listingId,
      payload: {
        version: inv.idempotencyVersion,
        text: paymentsText.issued({
          // An NDA listing is "an NDA listing" in the payments channel too.
          listing: { address, nda: inv.listing?.nda ?? false },
          listingId: inv.listingId,
          bookingId: inv.bookingId,
          client: client.name ? `${client.name} (${client.email})` : client.email,
          amount: fmtDollars(inv.amountCents ?? 0),
          method: "card",
          provider: "stripe",
          link: hosted,
        }),
      },
    },
  ]);
  return { providerId: finalized.id, hostedUrl: hosted };
}
