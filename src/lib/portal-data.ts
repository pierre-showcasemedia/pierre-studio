// Portal reads, with a demo fallback: until DATABASE_URL is set, the portal
// renders sample data so the UI can be built and reviewed end to end.
import { cache } from "react";
import { eq, asc, inArray } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { BookingPaymentDetail, InvoiceLineItem } from "@/db/schema";
import { isPartnerEmail, partnerCanSee } from "@/lib/partner";
import { clientMediaWhere, clientVisibleMedia } from "@/lib/media-visibility";
import { DEMO_PHOTOS } from "@/lib/demo-photos";
import { gatesGallery } from "@/lib/invoice-kinds";

// The listing card's cover must itself be client visible (Oct 2026): a cover
// that was moved to internal only falls back to the first visible main photo,
// exactly like the gallery hero (src/components/gallery/server-media.ts).
// No cover set stays no cover.
type CoverMedia = { r2Key: string; kind: "photo" | "video"; revision: boolean; section: string | null; sort: number };
export function visibleCoverKey(coverKey: string | null, visible: CoverMedia[]): string | null {
  if (!coverKey) return null;
  if (visible.some((m) => m.r2Key === coverKey)) return coverKey;
  const photos = visible.filter((m) => m.kind === "photo").sort((a, b) => a.sort - b.sort);
  return (photos.find((m) => !m.revision && !m.section) ?? photos[0])?.r2Key ?? null;
}

// A client sees their own listings plus every listing owned by clients on the
// same team (multi-email agent teams share one library).
export async function visibleClientIds(email: string): Promise<string[]> {
  const d = db();
  const me = await d.query.clients.findFirst({ where: eq(schema.clients.email, email.toLowerCase()) });
  if (!me) return [];
  if (!me.team) return [me.id];
  const teammates = await d.query.clients.findMany({ where: eq(schema.clients.team, me.team), columns: { id: true } });
  return teammates.map((t) => t.id);
}

export type PortalMedia = {
  id: string;
  kind: "photo" | "video";
  filename: string;
  bytes: number | null;
  r2Key: string;
  revision: boolean;
  section?: string | null;
  // Demo mode only (no database, no storage): a public image to show in place
  // of the R2 derivatives, with its pixel size. Never set on real rows.
  demo?: { url: string; width: number; height: number } | null;
};
// Step two: the portal never hands a client a provider URL directly; the pay
// page (/portal/<slug>/pay) reads this and decides what to show.
export type PortalInvoice = {
  id: string;
  provider: "stripe" | "titus" | null;
  status: string; // needs_quote | open | processing | review | paid | paid_manual | refunded | void | …
  amountCents: number | null;
  providerId: string | null;
  hostedUrl: string | null; // Stripe hosted invoice (the pay page's "Pay invoice" button)
  method: string | null; // card | pay_at_close | other
  paymentDetail: BookingPaymentDetail | null; // method "other": check | ach | cash, from the booking
  description: string | null;
  lineItems: InvoiceLineItem[];
  paidAt: string | null;
  createdAt: string | null;
  env: string | null; // which environment owns the row (null = production); the pay routes act only on their own
  // false = an invoice that never moves the gallery lock (an add-on or a second
  // shoot's own invoice, Oct 2026): the pay page does not promise downloads.
  gates: boolean;
};
export type PortalListing = {
  id: string;
  address: string;
  slug: string;
  shootDate: string | null;
  downloadLocked: boolean;
  mediaCount: number;
  invoice: PortalInvoice | null;
  coverKey: string | null;
  clientName?: string | null;
  shareToken?: string | null;
  links?: { label: string; url: string }[];
  createdAt?: string | null; // booked date
  deliveryEmailAt?: string | null;
  approvedAt?: string | null;
  nda?: boolean;
};

// The booking's payment detail rides along (pay another way: check, ACH
// transfer or cash), so the pay page can say which.
type InvoiceRow = typeof schema.invoices.$inferSelect & { booking?: { paymentDetail: BookingPaymentDetail | null } | null };
const INVOICE_WITH = { with: { booking: { columns: { paymentDetail: true } } } } as const;

function toPortalInvoice(i: InvoiceRow): PortalInvoice {
  return {
    id: i.id,
    provider: i.provider ?? (i.stripeInvoiceId ? "stripe" : null),
    status: i.status,
    amountCents: i.amountCents ?? i.amountDue,
    providerId: i.providerId ?? i.stripeInvoiceId,
    hostedUrl: i.hostedUrl ?? i.hostedInvoiceUrl,
    method: i.method,
    paymentDetail: i.booking?.paymentDetail ?? null,
    description: i.description,
    lineItems: i.lineItems ?? [],
    paidAt: i.paidAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
    env: i.env,
    gates: gatesGallery(i.meta),
  };
}

// The one invoice the portal talks about for a listing: the asked-for one,
// else the newest payable (open | processing | review), else the newest paid,
// else the newest waiting on a quote, else the newest of whatever is left.
// Among payable ones, the invoice that governs the lock comes first (Oct 27
// 2026): a locked gallery's "Pay for this gallery" and its provider read-back
// must reach the booking's own invoice, never a second shoot's or an add-on's
// (paying those never unlocks). Those are reached by ?invoice= from their email.
export function pickPortalInvoice(rows: InvoiceRow[], preferId?: string | null): PortalInvoice | null {
  if (!rows.length) return null;
  const newest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const payable = (s: string) => ["open", "processing", "review"].includes(s);
  const rankOf = (r: InvoiceRow) => (payable(r.status) ? (gatesGallery(r.meta) ? 0 : 0.5) : ["paid", "paid_manual"].includes(r.status) ? 1 : r.status === "needs_quote" || r.status === "draft" ? 2 : 3);
  const preferred = preferId ? newest.find((r) => r.id === preferId) : undefined;
  const pick = preferred ?? [...newest].sort((a, b) => rankOf(a) - rankOf(b))[0];
  return toPortalInvoice(pick);
}

const DEMO_LISTINGS: PortalListing[] = [
  {
    id: "demo-1",
    address: "100 Example Lane, Springfield, CA",
    slug: "100-example-lane",
    shootDate: "2026-07-31",
    downloadLocked: false, // demo: the unlocked state
    mediaCount: 25,
    invoice: {
      id: "demo-inv-1",
      provider: "stripe",
      status: "paid",
      amountCents: 60000,
      providerId: null,
      hostedUrl: null,
      method: "card",
      paymentDetail: null,
      description: "100 Example Lane · Photography",
      lineItems: [{ id: "photography", name: "Photography", cents: 60000, priced: true }],
      paidAt: "2026-07-30T18:00:00.000Z",
      createdAt: "2026-07-28T18:00:00.000Z",
      env: null,
      gates: true,
    },
    coverKey: "demo/photos/1420-Alder-13.jpg",
    shareToken: "demo-share-1",
  },
  {
    id: "demo-2",
    address: "200 Sample Road, Springfield, CA",
    slug: "200-sample-road",
    shootDate: "2026-07-28",
    downloadLocked: true, // demo: the locked (watermarked) state
    mediaCount: 25,
    invoice: {
      id: "demo-inv-2",
      provider: "stripe",
      status: "open",
      amountCents: 115000,
      providerId: null,
      hostedUrl: null,
      method: "card",
      paymentDetail: null,
      description: "200 Sample Road · Photography + Cinematic listing film",
      lineItems: [
        { id: "photography", name: "Photography", cents: 60000, priced: true },
        { id: "film", name: "Cinematic listing film", cents: 55000, priced: true },
      ],
      paidAt: null,
      createdAt: "2026-07-26T18:00:00.000Z",
      env: null,
      gates: true,
    },
    coverKey: null,
    shareToken: "demo-share-2",
  },
];

// Demo gallery: the sample frames (src/lib/demo-photos.ts) laid out like
// a delivered listing, so the gallery can be checked locally end to end:
// main photos, a "Twilight" section, one revised photo and one film.
const demoPhoto = (i: number, extra: Partial<PortalMedia> = {}): PortalMedia => {
  const p = DEMO_PHOTOS[i];
  return {
    id: `demo-m-${i + 1}`,
    kind: "photo",
    filename: p.filename,
    bytes: 2_400_000,
    r2Key: `demo/photos/${p.filename}`,
    revision: false,
    section: null,
    demo: { url: p.url, width: p.width, height: p.height },
    ...extra,
  };
};
const DEMO_TWILIGHT = [18, 19, 20];
const DEMO_REVISED = 21;
const DEMO_MEDIA: PortalMedia[] = [
  ...DEMO_PHOTOS.map((_, i) => i).filter((i) => !DEMO_TWILIGHT.includes(i) && i !== DEMO_REVISED).map((i) => demoPhoto(i)),
  ...DEMO_TWILIGHT.map((i) => demoPhoto(i, { section: "Twilight" })),
  demoPhoto(DEMO_REVISED, { revision: true }),
  {
    id: "demo-film-1",
    kind: "video",
    filename: "1420-Alder-Film.mp4",
    bytes: 480_000_000,
    r2Key: "demo/video/1420-Alder-Film.mp4",
    revision: false,
    section: null,
    demo: { url: DEMO_PHOTOS[12].url, width: DEMO_PHOTOS[12].width, height: DEMO_PHOTOS[12].height }, // poster frame
  },
];

export function isDemo(): boolean {
  return !hasDb();
}

export async function listingsForEmail(email: string): Promise<PortalListing[]> {
  if (isDemo()) return DEMO_LISTINGS;
  const d = db();
  // Partners see every paid, delivered listing (minus exclusions), never invoices.
  const partner = isPartnerEmail(email);
  const ids = partner ? [] : await visibleClientIds(email);
  if (!partner && !ids.length) return [];
  const rows = (
    await d.query.listings.findMany({
      where: partner ? undefined : inArray(schema.listings.clientId, ids),
      // Clients only ever see approved AND published media (v1.2 gate).
      with: { media: { columns: { id: true, qcState: true, published: true, shootId: true, r2Key: true, kind: true, revision: true, section: true, sort: true }, where: clientMediaWhere() }, invoices: INVOICE_WITH, shoots: { columns: { id: true, publishedAt: true } } },
      orderBy: (l, { desc }) => [desc(l.createdAt)],
    })
  )
    .map((l) => ({ ...l, media: clientVisibleMedia(l.media, l.shoots) }))
    .filter((l) => !partner || (partnerCanSee(l) && l.media.length > 0));
  return rows.map((l) => ({
    id: l.id,
    address: l.address,
    slug: l.slug,
    shootDate: l.shootDate?.toISOString().slice(0, 10) ?? null,
    downloadLocked: l.downloadLocked,
    mediaCount: l.media.length,
    invoice: partner ? null : pickPortalInvoice(l.invoices),
    coverKey: visibleCoverKey(l.coverKey, l.media),
    createdAt: l.createdAt.toISOString().slice(0, 10),
    deliveryEmailAt: l.deliveryEmailAt?.toISOString().slice(0, 10) ?? null,
    approvedAt: l.approvedAt?.toISOString().slice(0, 10) ?? null,
  }));
}

export async function listingForEmail(email: string, slug: string, opts: { invoiceId?: string | null } = {}): Promise<{ listing: PortalListing; media: PortalMedia[] } | null> {
  if (isDemo()) {
    const listing = DEMO_LISTINGS.find((l) => l.slug === slug);
    return listing ? { listing, media: DEMO_MEDIA } : null;
  }
  const d = db();
  const partner = isPartnerEmail(email);
  const ids = partner ? [] : await visibleClientIds(email);
  if (!partner && !ids.length) return null;
  const l0 = await d.query.listings.findFirst({
    where: eq(schema.listings.slug, slug),
    with: { media: { orderBy: [asc(schema.media.sort)], where: clientMediaWhere() }, invoices: INVOICE_WITH, client: true, shoots: { columns: { id: true, publishedAt: true } } },
  });
  if (!l0) return null;
  const l = { ...l0, media: clientVisibleMedia(l0.media, l0.shoots) };
  // Never leak outside the client/team; partners only reach paid, non-excluded listings.
  if (partner ? !partnerCanSee(l) : !ids.includes(l.clientId)) return null;
  return {
    listing: {
      id: l.id,
      address: l.address,
      slug: l.slug,
      shootDate: l.shootDate?.toISOString().slice(0, 10) ?? null,
      downloadLocked: l.downloadLocked,
      mediaCount: l.media.length,
      invoice: partner ? null : pickPortalInvoice(l.invoices, opts.invoiceId ?? null),
      coverKey: l.coverKey,
      clientName: l.client.name ?? l.client.email,
      shareToken: l.shareToken,
      links: (() => { try { return l.links ? JSON.parse(l.links) : []; } catch { return []; } })(),
      createdAt: l.createdAt.toISOString().slice(0, 10),
      deliveryEmailAt: l.deliveryEmailAt?.toISOString().slice(0, 10) ?? null,
      approvedAt: l.approvedAt?.toISOString().slice(0, 10) ?? null,
      nda: l.nda,
    },
    media: l.media.map((m) => ({ id: m.id, kind: m.kind, filename: m.filename, bytes: m.bytes, r2Key: m.r2Key, revision: m.revision, section: m.section })),
  };
}

// Public share-page lookup: token only, no session. Callers must render
// preview-only: this path never mints download URLs. cache() dedupes the
// generateMetadata + page-render lookups within one request.
export const listingForShareToken = cache(async function listingForShareToken(token: string): Promise<{ listing: PortalListing; media: PortalMedia[] } | null> {
  if (!token) return null;
  if (isDemo()) {
    const listing = DEMO_LISTINGS.find((l) => l.shareToken === token);
    return listing ? { listing: { ...listing, invoice: null }, media: DEMO_MEDIA } : null;
  }
  const d = db();
  const l0 = await d.query.listings.findFirst({
    where: eq(schema.listings.shareToken, token),
    with: { media: { orderBy: [asc(schema.media.sort)], where: clientMediaWhere() }, client: true, shoots: { columns: { id: true, publishedAt: true } } },
  });
  if (!l0) return null;
  const l = { ...l0, media: clientVisibleMedia(l0.media, l0.shoots) };
  return {
    listing: {
      id: l.id,
      address: l.address,
      slug: l.slug,
      shootDate: l.shootDate?.toISOString().slice(0, 10) ?? null,
      downloadLocked: l.downloadLocked,
      mediaCount: l.media.length,
      invoice: null, // homeowners never see the agent's invoice
      coverKey: l.coverKey,
      clientName: l.client.name ?? l.client.email,
      shareToken: l.shareToken,
    },
    media: l.media.map((m) => ({ id: m.id, kind: m.kind, filename: m.filename, bytes: m.bytes, r2Key: m.r2Key, revision: m.revision, section: m.section })),
  };
});

// Does this email exist as a client? (Login emails only go to known clients.)
export async function clientExists(email: string): Promise<boolean> {
  if (isDemo()) return true;
  const d = db();
  const c = await d.query.clients.findFirst({ where: eq(schema.clients.email, email.toLowerCase()) });
  return Boolean(c);
}
