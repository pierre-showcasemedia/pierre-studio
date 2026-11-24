import type { Metadata } from "next";
import type { DriveMode } from "@/components/gallery/DriveModal";
import { business } from "@/lib/business";
import { notFound, redirect } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { sessionEmail, viewingAs } from "@/lib/portal-auth";
import ViewAsBanner from "@/components/ViewAsBanner";
import { exitViewAs } from "../view-as-actions";
import { isDemo, listingForEmail } from "@/lib/portal-data";
import { isPartnerEmail } from "@/lib/partner";
import { hasR2, objectExists } from "@/lib/r2";
import { hasDb } from "@/db";
import { isPaid, isPayable, syncInvoiceFromProvider } from "@/lib/payments";
import { isPaidAnotherWay } from "@/lib/pay-other";
import PortalGallery from "@/components/PortalGallery";
import { GROUP_AREAS, type GroupBundles } from "@/components/gallery/types";
import ShareButton from "@/components/ShareButton";
import { propertyViews } from "@/lib/property-page";
import { upsellFor, upsellNoteFor } from "@/lib/upsell";
import { bookAgainUrl } from "@/lib/portal-bookings";
import { brand } from "@/lib/brand";
import GalleryHero from "@/components/gallery/GalleryHero";
import Rise from "@/components/gallery/Rise";
import { galleryMedia } from "@/components/gallery/server-media";
import type { DropboxMode } from "@/components/gallery/DropboxModal";
import Link from "next/link";
import { EMPTY_DRAFT, revisionDraftFor } from "@/lib/revisions";
import { videoNotesFor } from "@/lib/video-review";
import { US_STATES } from "@/lib/us-states";

export const metadata: Metadata = { title: "Your gallery", robots: { index: false } };
export const dynamic = "force-dynamic";

const STATES = US_STATES;
function prettyLocation(address: string): string {
  const rest = address.split(",").slice(1).map((s) => s.trim()).filter(Boolean);
  return rest
    .map((part) => STATES[part.replace(/\d/g, "").trim()] ?? part.replace(/\s*\d{5}(-\d{4})?$/, ""))
    .filter(Boolean)
    .join(", ");
}

const sectionSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export default async function PortalListingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ paid?: string }> }) {
  const email = await sessionEmail();
  if (!email) redirect("/portal/login");
  const { slug } = await params;
  const { paid } = await searchParams;
  let data = await listingForEmail(email, slug);
  if (!data) notFound();
  // Step two: a locked gallery whose invoice is out with a provider asks the
  // provider first (throttled to one check per 30 s), so a payment that landed
  // seconds ago, or a provider redirect back here with ?paid=1, shows unlocked
  // without waiting for the webhook. Only the provider's answer unlocks.
  const inv0 = data.listing.invoice;
  if (hasDb() && data.listing.downloadLocked && inv0?.providerId && isPayable(inv0.status)) {
    const r = await syncInvoiceFromProvider(inv0.id, paid ? "client_success" : "gallery_load", { skipThrottle: Boolean(paid) });
    if (r.changed) data = (await listingForEmail(email, slug)) ?? data;
  }
  const { listing, media } = data;
  // Delivered on Pic-Time (Nov 22 2026): the gallery button leads there; the
  // studio grid shows only if photos were also published here.
  const outside = listing.picTimeUrl?.trim() || null;
  const studioMedia = media.length > 0;
  const locked = listing.downloadLocked;
  const prop = await propertyViews(listing.id);
  const upsell = upsellNoteFor(email) ? await upsellFor(listing.id).catch(() => null) : null;
  const upsellUrl = upsell ? await bookAgainUrl(email, brand.marketingUrl, { address: listing.address, items: upsell.items.map((i) => i.id) }) : null;
  const invoice = listing.invoice;
  const payLabel = invoice
    ? isPayable(invoice.status)
      ? isPaidAnotherWay(invoice) ? "Payment" : locked ? "Pay for this gallery" : "Pay invoice"
      : isPaid(invoice.status)
        ? "Receipt"
        : invoice.status === "needs_quote"
          ? "Payment"
          : null
    : null;

  // Signed preview URLs: watermarked derivatives while locked, clean when paid
  // (plus the 2048px file for a sharper lightbox once paid).
  const gallery = await galleryMedia(listing, media, { locked, large: true });
  const hero = gallery.hero;
  let bundles = { full: false, mls: false };
  const sectionBundles: Record<string, { slug: string; mls: boolean }> = {}; // section name → bundle info
  const groupBundles: GroupBundles = {}; // gallery area (photos, revised, films, revised films) → its zip
  const secNames = [...new Set(media.map((m) => m.section).filter((x): x is string => Boolean(x)))];
  if (!locked && hasR2()) {
    const [full, mls] = await Promise.all([
      objectExists(`listings/${slug}/bundles/photos-full.zip`),
      objectExists(`listings/${slug}/bundles/photos-mls.zip`),
    ]);
    bundles = { full, mls };
    // Per-section bundles (bundles/photos-<secslug>.zip)
    await Promise.all(
      secNames.map(async (name) => {
        const sec = sectionSlug(name);
        const [full, mls] = await Promise.all([
          objectExists(`listings/${slug}/bundles/photos-${sec}.zip`),
          objectExists(`listings/${slug}/bundles/photos-${sec}-mls.zip`),
        ]);
        if (full || mls) sectionBundles[name] = { slug: sec, mls };
      })
    );
    // Per-area bundles (bundles/group-<area>.zip), built when the gallery has more than one area.
    await Promise.all(
      GROUP_AREAS.map(async (area) => {
        const [full, mls] = await Promise.all([
          objectExists(`listings/${slug}/bundles/group-${area}.zip`),
          area === "photos" || area === "revised" ? objectExists(`listings/${slug}/bundles/group-${area}-mls.zip`) : Promise.resolve(false),
        ]);
        if (full) groupBundles[area] = { mls };
      })
    );
  } else if (!locked && gallery.demo) {
    // Demo: show every control so the bar can be reviewed locally.
    bundles = { full: true, mls: true };
    for (const name of secNames) sectionBundles[name] = { slug: sectionSlug(name), mls: true };
    for (const area of GROUP_AREAS) groupBundles[area] = { mls: area === "photos" || area === "revised" };
  }

  // Add to Dropbox needs the Dropbox app key. Without one on a real deployment
  // the button is hidden; in demo mode it runs but sends nothing.
  // Nov 18 2026: a business on Google Drive (business.fileStore) offers Save to
  // Google Drive instead, once its OAuth client id is set.
  const onGoogleDrive = business.fileStore === "google_drive";
  const appKey = process.env.NEXT_PUBLIC_DROPBOX_APP_KEY?.trim();
  const dropbox: DropboxMode | null = onGoogleDrive ? null : isDemo() ? { mode: "demo" } : appKey ? { mode: "live", appKey } : null;
  const driveClient = process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID?.trim();
  const drive: DriveMode | null = !onGoogleDrive ? null : isDemo() ? { mode: "demo" } : driveClient ? { mode: "live", clientId: driveClient } : null;

  const impersonating = await viewingAs();
  const street = listing.address.split(",")[0];
  const location = `${prettyLocation(listing.address)}${listing.clientName ? ` · ${listing.clientName}` : ""}`;

  return (
    <>
      {impersonating && <ViewAsBanner email={impersonating} exitAction={exitViewAs} />}
      <Nav overlay={Boolean(hero)} />
      <main>
        {/* Hero: full-bleed cover photo */}
        {hero ? (
          <GalleryHero src={hero.src} srcSet={hero.srcSet} alt={listing.address} title={street} subtitle={location} />
        ) : (
          <section className="section" style={{ paddingBottom: 24 }}>
            <div className="wrap">
              <Rise>
                <h1 className="h2">{street}</h1>
              </Rise>
            </div>
          </section>
        )}

        <section className="g-page">
          <div className="wrap">
            {/* Top bar: back, payment link, status */}
            <Rise className="g-topbar">
              <Link href="/portal" className="muted" style={{ fontSize: 13 }}>← All listings</Link>
              <div className="g-topbar__right">
                {listing.shareToken && <ShareButton token={listing.shareToken} />}
                {business.propertyPage && listing.shareToken && !prop.nda && (
                  <a href={`/property/${listing.shareToken}`} className="chip" target="_blank" rel="noopener noreferrer" title={prop.sources ? `Where visitors came from: ${prop.sources}` : "Your listing's property page to share with buyers"}>
                    Property page · {prop.views === 1 ? "1 view" : `${prop.views} views`}
                  </a>
                )}
                {payLabel && (
                  <Link href={`/portal/${listing.slug}/pay`} className="chip" style={{ textDecoration: "none" }}>
                    {payLabel}
                  </Link>
                )}
                {(studioMedia || !outside) && (
                  <span className={`g-status${locked ? " g-status--locked" : ""}`}>
                    {locked ? "Downloads unlock after payment" : "Paid, downloads unlocked"}
                  </span>
                )}
              </div>
            </Rise>

            {outside && (
              <Rise className="g-sec">
                <div className="kicker" style={{ marginBottom: 12 }}>Your gallery</div>
                <p className="muted" style={{ margin: "0 0 18px", fontSize: 14.5, lineHeight: 1.65, maxWidth: "62ch" }}>
                  Your photos and videos for {street} are ready to view and download in your gallery.
                </p>
                <a href={outside} target="_blank" rel="noreferrer" className="btn btn-primary" style={{ textDecoration: "none" }}>
                  Open your gallery ↗
                </a>
              </Rise>
            )}

            {locked && studioMedia && (
              <p className="muted" style={{ marginTop: 20, fontSize: 14.5, lineHeight: 1.65, maxWidth: "62ch" }}>
                Preview your full gallery below. Watermarks disappear and full-resolution downloads unlock
                automatically the moment payment is received.
              </p>
            )}

            {upsell && upsellUrl && (
              <div style={{ marginTop: 20, border: "1px solid var(--color-line, #e6e8ec)", borderRadius: 14, padding: "18px 22px", display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", justifyContent: "space-between" }}>
                <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, maxWidth: "60ch" }}>
                  Still on the market after {upsell.days} days? Give buyers something new to look at: {upsell.items.map((i) => i.name.toLowerCase()).join(", ")}.
                </p>
                <a href={upsellUrl} className="btn btn-primary">See the options</a>
              </div>
            )}

            {(studioMedia || !outside) && <PortalGallery
              photos={gallery.photos}
              videos={gallery.videos}
              locked={locked}
              bundles={bundles}
              sectionBundles={sectionBundles}
              groupBundles={groupBundles}
              listingId={listing.id}
              slug={listing.slug}
              approvedAt={listing.approvedAt ?? null}
              readOnly={isPartnerEmail(email)}
              dropbox={dropbox}
              drive={drive}
              revisionDraft={isPartnerEmail(email) ? null : hasDb() ? await revisionDraftFor(listing.id, email) : EMPTY_DRAFT}
              videoNotes={isPartnerEmail(email) ? null : await videoNotesFor(listing.id, email)}
            />}

            {/* External tours and links, below all media */}
            {(listing.links?.length ?? 0) > 0 && (
              <Rise className="g-sec g-sec--named">
                <div className="kicker" style={{ marginBottom: 16 }}>Tours and links</div>
                <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                  {listing.links!.map((lk) => (
                    <a key={lk.url} href={lk.url} target="_blank" rel="noreferrer" className="chip" style={{ textDecoration: "none" }}>
                      {lk.label} ↗
                    </a>
                  ))}
                </div>
              </Rise>
            )}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
