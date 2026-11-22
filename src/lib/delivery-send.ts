// Builds the delivery email for a listing, shared by the admin preview page
// and the send action, so what the admin previews is byte-for-byte what sends.
// Step two: the payment block links OUR pay page (/portal/<slug>/pay) through
// the same 30-day pay token the booking email uses (payPageLink), so one click
// lands signed in on the pay page instead of on the login screen; never a
// provider URL. The amount appears only here, in the client's email. An
// invoice paid another way (check, ACH transfer or cash) never gets a pay
// button: the block says payment is arranged with the business.
import { and, asc, eq, ne } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { deliveryEmailHtml, deliveryEmailSubject, defaultDeliveryBody } from "./delivery-email";
import { payPageLink } from "./booking-email";
import { deliveryCc, siteUrl, emailAssetBase } from "./brand";
import { clientMediaWhere, clientVisibleMedia } from "./media-visibility";
import { isPayable } from "./payments";
import { isPaidAnotherWay, payOtherPhrase } from "./pay-other";

export type DeliveryOverrides = { subject?: string | null; headline?: string | null; body?: string | null };
// The client's team (clients sharing clients.team with whoever booked): the
// people the delivery email can CC with one tick each (Oct 24 2026).
export type DeliveryTeam = { slug: string; name: string | null; members: { email: string; name: string | null }[] };

export type BuiltDeliveryEmail =
  | { ok: true; to: string; cc: string[]; subject: string; html: string; address: string;
      team: DeliveryTeam | null;
      defaults: { subject: string; headline: string; body: string } }
  | { ok: false; error: string };

export async function buildDeliveryEmail(listingId: string, overrides: DeliveryOverrides = {}): Promise<BuiltDeliveryEmail> {
  if (!hasDb()) return { ok: false, error: "No database connected." };
  const l0 = await db().query.listings.findFirst({
    where: eq(schema.listings.id, listingId),
    with: { client: true, media: { columns: { id: true, qcState: true, published: true, shootId: true }, where: clientMediaWhere() }, invoices: { with: { booking: { columns: { paymentDetail: true } } } }, shoots: { columns: { id: true, publishedAt: true } } },
  });
  if (!l0) return { ok: false, error: "Listing not found." };
  const l = { ...l0, media: clientVisibleMedia(l0.media, l0.shoots) };
  // A Pic-Time gallery link stands in for studio photos (Nov 22 2026).
  const galleryUrl = l.picTimeUrl?.trim() || null;
  if (!l.media.length && !galleryUrl) {
    return { ok: false, error: "This listing has no published media yet. Publish a shoot, or add the Pic-Time gallery link in the listing's settings, before sending the delivery email." };
  }
  const base = siteUrl();
  const money = (i: { amountCents: number | null; amountDue: number | null }) => {
    const cents = i.amountCents ?? i.amountDue;
    return cents != null ? `$${(cents / 100).toLocaleString()}` : null;
  };
  // Every invoice still owed (open, processing, review), largest first. Each
  // button carries its own tokened link; ?invoice= survives the sign-in.
  // Invoices paid another way are owed too, but never get a pay link.
  const owedAll = l.invoices.filter((i) => isPayable(i.status)).sort((a, b) => (b.amountCents ?? b.amountDue ?? 0) - (a.amountCents ?? a.amountDue ?? 0));
  const owed = owedAll.filter((i) => !isPaidAnotherWay(i));
  const otherPayments = owedAll.filter((i) => isPaidAnotherWay(i)).map((i) => ({ how: payOtherPhrase(i.booking?.paymentDetail), amount: money(i) }));
  const open = owed[0];
  const payUrl = owed.length ? await payPageLink(l.client.email, l.slug) : null;
  const invoices = await Promise.all(owed.map(async (i) => ({ url: await payPageLink(l.client.email, l.slug, { invoiceId: i.id }), amount: money(i) })));
  const defaults = {
    subject: deliveryEmailSubject(l.address),
    headline: "Your gallery is ready.",
    body: defaultDeliveryBody(l.address, l.downloadLocked, Boolean(galleryUrl)),
  };
  const html = deliveryEmailHtml({
    address: l.address,
    coverUrl: l.media.length ? `${emailAssetBase()}/api/portal/cover/${l.id}` : null,
    portalUrl: `${base}/portal/login`,
    galleryUrl,
    // The view-only share page shows studio photos only, so it goes with them.
    shareUrl: l.shareToken && l.media.length ? `${base}/share/${l.shareToken}` : null,
    invoiceUrl: open && payUrl ? payUrl : null,
    invoiceAmount: open ? money(open) : null,
    invoices,
    otherPayments,
    locked: l.downloadLocked,
    clientFirstName: l.client.name?.split(" ")[0] ?? null,
    bodyText: overrides.body?.trim() || null,
    headline: overrides.headline?.trim() || null,
  });
  let team: DeliveryTeam | null = null;
  const slug = l.client.team?.trim() || null;
  if (slug) {
    const d = db();
    const [row, members] = await Promise.all([
      d.query.teams.findFirst({ where: eq(schema.teams.slug, slug), columns: { name: true } }),
      d.query.clients.findMany({
        where: and(eq(schema.clients.team, slug), ne(schema.clients.id, l.client.id)),
        columns: { email: true, name: true },
        orderBy: [asc(schema.clients.name), asc(schema.clients.email)],
      }),
    ]);
    const self = l.client.email.toLowerCase();
    team = { slug, name: row?.name ?? null, members: members.map((m) => ({ email: m.email.toLowerCase(), name: m.name })).filter((m) => m.email !== self) };
  }
  return {
    ok: true,
    to: l.client.email,
    team,
    cc: deliveryCc(), // DELIVERY_CC env; empty = no automatic CC
    subject: overrides.subject?.trim() || defaults.subject,
    html,
    address: l.address,
    defaults,
  };
}
