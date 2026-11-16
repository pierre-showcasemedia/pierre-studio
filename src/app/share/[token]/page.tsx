// Public preview-only listing page, reached by unguessable share token.
// Homeowners/sellers see the gallery; downloads exist ONLY behind the signed-in
// portal — this page never mints a download URL, locked or not.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { listingForShareToken } from "@/lib/portal-data";
import { derivativeKey } from "@/lib/media-keys";
import { hasR2, signedViewUrl } from "@/lib/r2";
import ShareGallery from "@/components/ShareGallery";
import GalleryHero from "@/components/gallery/GalleryHero";
import Rise from "@/components/gallery/Rise";
import { galleryMedia } from "@/components/gallery/server-media";
import { brand } from "@/lib/brand";
import { US_STATES } from "@/lib/us-states";

export const dynamic = "force-dynamic";

// Link previews (iMessage etc.) show the property: cover photo + address.
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const data = await listingForShareToken(token);
  if (!data) return { title: "Gallery preview", robots: { index: false } };
  const { listing, media } = data;
  const short = listing.address.split(",")[0];
  const desc = `View-only gallery preview. Photography and film by ${brand.name}.`;
  // The cover must itself be client visible (a cover moved to internal only
  // never reaches a link preview).
  const heroKey = (listing.coverKey && media.some((m) => m.r2Key === listing.coverKey) ? listing.coverKey : null) ?? media.find((m) => m.kind === "photo")?.r2Key;
  const variant = listing.downloadLocked ? ("preview-wm" as const) : ("preview" as const);
  const image = heroKey && hasR2() ? await signedViewUrl(derivativeKey(heroKey, variant)) : undefined;
  return {
    title: `${short} | Gallery preview`,
    description: desc,
    robots: { index: false },
    openGraph: {
      siteName: `${brand.name}`,
      title: `${short} | Gallery preview`,
      description: desc,
      images: image ? [image] : undefined,
      type: "website",
      locale: "en_US",
    },
  };
}

const STATES = US_STATES;
function prettyLocation(address: string): string {
  const rest = address.split(",").slice(1).map((s) => s.trim()).filter(Boolean);
  return rest
    .map((part) => STATES[part.replace(/\d/g, "").trim()] ?? part.replace(/\s*\d{5}(-\d{4})?$/, ""))
    .filter(Boolean)
    .join(", ");
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await listingForShareToken(token);
  if (!data) notFound();
  const { listing, media } = data;
  const locked = listing.downloadLocked;

  // Same payment gating as the portal: unpaid listings show the baked-watermark
  // derivatives and no film playback; paid ones show clean previews (the small
  // corner watermark is added on top by ShareGallery either way). Never the
  // 2048px file, never a download URL.
  const gallery = await galleryMedia(listing, media, { locked, large: false });
  const hero = gallery.hero;

  return (
    <>
      <Nav overlay={Boolean(hero)} />
      <main>
        {hero ? (
          <GalleryHero src={hero.src} srcSet={hero.srcSet} alt={listing.address} title={listing.address.split(",")[0]} subtitle={prettyLocation(listing.address)} />
        ) : (
          <section className="section" style={{ paddingBottom: 24 }}>
            <div className="wrap">
              <Rise>
                <h1 className="h2">{listing.address.split(",")[0]}</h1>
              </Rise>
            </div>
          </section>
        )}

        <section className="g-page">
          <div className="wrap">
            <Rise className="g-topbar">
              <span className="kicker">Gallery preview</span>
              <span className="muted" style={{ fontSize: 13 }}>
                Photography and film by {brand.name}
              </span>
            </Rise>

            <ShareGallery photos={gallery.photos} videos={gallery.videos} locked={locked} />

            <p className="muted" style={{ marginTop: 48, fontSize: 13.5, lineHeight: 1.65 }}>
              This is a view-only preview shared by the listing agent. All media is the work and copyright of{" "}
              <a href={brand.marketingUrl} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{brand.name}</a>.
              Please do not download, screenshot or share this page.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
