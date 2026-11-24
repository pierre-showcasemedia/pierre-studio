// The public property page (src/lib/property-page.ts; off unless
// business.propertyPage): the listing's photos and film as a branded page the
// agent can share, with their card and links, and a view count the agent sees
// in the portal. Preview only: never a download.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ShareGallery from "@/components/ShareGallery";
import GalleryHero from "@/components/gallery/GalleryHero";
import Rise from "@/components/gallery/Rise";
import { galleryMedia } from "@/components/gallery/server-media";
import { propertyPage, recordPropertyView, viewSource, visitorIp } from "@/lib/property-page";
import { brand } from "@/lib/brand";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const data = await propertyPage(token);
  if (!data) return { title: "Property", robots: { index: false } };
  const street = data.listing.address.split(",")[0];
  return { title: street, description: `${data.listing.address}. Photography by ${brand.name}.`, robots: { index: false }, openGraph: { title: street, siteName: brand.name, type: "website" } };
}

export default async function PropertyPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ utm_source?: string; src?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const data = await propertyPage(token);
  if (!data) notFound();
  const { listing, media, agent, links } = data;
  const h = await headers();
  const ua = h.get("user-agent");
  const source = viewSource(sp.utm_source ?? sp.src ?? null, h.get("referer"));
  const ip = visitorIp(h);
  after(() => recordPropertyView(listing.id, ua, source, ip).catch((e) => console.error("[property] view", e)));
  const gallery = await galleryMedia(listing, media, { locked: listing.downloadLocked, large: false });
  const street = listing.address.split(",")[0];
  const rest = listing.address.split(",").slice(1).join(",").trim();
  return (
    <>
      <Nav overlay={Boolean(gallery.hero)} />
      <main>
        {gallery.hero ? (
          <GalleryHero src={gallery.hero.src} srcSet={gallery.hero.srcSet} alt={listing.address} title={street} subtitle={rest} />
        ) : (
          <section className="section" style={{ paddingBottom: 24 }}>
            <div className="wrap"><Rise><h1 className="h2">{street}</h1><p className="muted">{rest}</p>{data.facts && <p className="muted">{data.facts}</p>}</Rise></div>
          </section>
        )}
        <section className="g-page">
          <div className="wrap">
            <Rise className="g-topbar">
              <span className="kicker">Property</span>
              <span className="muted" style={{ fontSize: 13 }}>Photography and film by {brand.name}</span>
            </Rise>
            {(agent || links.length > 0) && (
              <Rise>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 24, justifyContent: "space-between", alignItems: "flex-start", border: "1px solid var(--color-line, #e6e8ec)", borderRadius: 14, padding: "20px 24px", margin: "8px 0 32px" }}>
                  {agent && (
                    <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
                      {agent.headshotUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={agent.headshotUrl} alt={agent.name ?? "Listing agent"} width={88} height={88} style={{ width: 88, height: 88, borderRadius: "50%", objectFit: "cover", flex: "none" }} />
                      )}
                      <div>
                        <div className="kicker" style={{ marginBottom: 8 }}>Listing agent</div>
                        <div style={{ fontSize: 18 }}>{agent.name ?? agent.email}</div>
                        {agent.company && <div className="muted" style={{ fontSize: 14 }}>{agent.company}</div>}
                        <div style={{ fontSize: 14, marginTop: 6, display: "flex", gap: 16, flexWrap: "wrap" }}>
                          {agent.phone && <a href={`tel:${agent.phone.replace(/[^\d+]/g, "")}`} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{agent.phone}</a>}
                          <a href={`mailto:${agent.email}`} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{agent.email}</a>
                        </div>
                      </div>
                      {agent.logoUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={agent.logoUrl} alt={agent.company ? `${agent.company} logo` : "Brokerage logo"} style={{ maxWidth: 160, maxHeight: 64, width: "auto", height: "auto", objectFit: "contain", flex: "none" }} />
                      )}
                    </div>
                  )}
                  {links.length > 0 && (
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      {links.map((l) => (
                        <a key={l.url} href={l.url} className="chip" target="_blank" rel="noopener noreferrer">{l.label}</a>
                      ))}
                    </div>
                  )}
                </div>
              </Rise>
            )}
            <ShareGallery photos={gallery.photos} videos={gallery.videos} locked={listing.downloadLocked} />
            <p className="muted" style={{ marginTop: 48, fontSize: 13.5, lineHeight: 1.65 }}>
              All media is the work and copyright of <a href={brand.marketingUrl} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{brand.name}</a>.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
