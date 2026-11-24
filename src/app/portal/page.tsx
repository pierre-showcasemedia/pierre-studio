import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ViewAsBanner from "@/components/ViewAsBanner";
import { sessionEmail, viewingAs } from "@/lib/portal-auth";
import { exitViewAs } from "./view-as-actions";
import { isStaffAllowed } from "@/lib/admin-allow";
import { isPartnerEmail } from "@/lib/partner";
import { listingsForEmail, isDemo } from "@/lib/portal-data";
import { bookAgainUrl, bookingsForListings, type PortalBooking } from "@/lib/portal-bookings";
import RescheduleButton from "@/components/portal/RescheduleButton";
import { shootStatus, STATUS_COLORS } from "@/lib/listing-status";
import { fmtDay } from "@/lib/booking-time";
import { derivativeKey } from "@/lib/media-keys";
import { hasR2, signedViewUrl } from "@/lib/r2";
import { DEMO_PHOTOS } from "@/lib/demo-photos";
import "@/styles/portal-home.css";
import { brand } from "@/lib/brand";
import { business } from "@/lib/business";
import { profileImagesFor, type ProfileImages } from "@/lib/profile-images-data";

export const metadata: Metadata = { title: "Client Portal", robots: { index: false } };
export const dynamic = "force-dynamic";

function StatusBubble({ s, onImage }: { s: ReturnType<typeof shootStatus>; onImage?: boolean }) {
  const c = STATUS_COLORS[s];
  return (
    <span className={`ph-status${onImage ? " ph-status--on-image" : ""}`} style={{ background: onImage ? undefined : c.bg, color: c.fg }}>
      {s}
    </span>
  );
}

// What the client reads about the booking itself: plain words, no internals.
const BOOKING_WORDS: Record<string, { label: string; tone: "wait" | "ok" | "done" }> = {
  requested: { label: "Requested", tone: "wait" },
  confirmed: { label: "Confirmed", tone: "ok" },
  shot: { label: "Shot", tone: "ok" },
  delivered: { label: "Delivered", tone: "done" },
};

const street = (a: string) => a.split(",")[0].trim();
const rest = (a: string) => a.split(",").slice(1).join(",").trim();
const nice = (ymd: string | null | undefined) => (ymd ? fmtDay(ymd) : null);

function whenLine(b: PortalBooking | undefined, shootDate: string | null): string {
  if (b?.date) return `${fmtDay(b.date)}${b.time ? ` at ${b.time}` : ""}`;
  if (shootDate) return fmtDay(shootDate);
  return "To be scheduled";
}

// The agent's headshot and brokerage logo, shown on their property pages
// (studio template, off unless business.profileImages). Plain form posts to
// /api/portal/profile-image (checked and resized there).
function AccountTab({ profile, saved, error }: { profile: ProfileImages; saved?: string; error?: string }) {
  const slots = [
    { kind: "headshot", title: "Headshot", help: "A clear photo of you. It shows in a circle on your property pages.", url: profile.headshotUrl, round: true },
    { kind: "logo", title: "Brokerage logo", help: "Your brokerage or team logo. A PNG with a clear background looks best.", url: profile.logoUrl, round: false },
  ] as const;
  return (
    <div style={{ marginBottom: 32 }}>
      <h2 className="h3" style={{ marginBottom: 6 }}>Your property page card</h2>
      <p className="muted" style={{ margin: "0 0 20px", fontSize: 14.5, lineHeight: 1.6 }}>Add a headshot and your brokerage logo. They show next to your name and contact details on every property page {brand.shortName} makes for you. JPG, PNG or WebP, up to 4 MB.</p>
      {saved && <p style={{ margin: "0 0 16px", fontSize: 14 }} role="status">{saved}</p>}
      {error && <p style={{ margin: "0 0 16px", fontSize: 14, color: "var(--color-bad, #b42318)" }} role="alert">{error}</p>}
      {!profile.found ? (
        <p className="muted" style={{ fontSize: 14.5 }}>Your account is still being set up. Please contact {brand.shortName} and we will sort it out.</p>
      ) : (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {slots.map((s) => (
            <div key={s.kind} style={{ border: "1px solid var(--color-line, #e6e8ec)", borderRadius: 14, padding: "18px 20px", display: "grid", gap: 12, alignContent: "start" }}>
              <div className="kicker">{s.title}</div>
              <div style={{ height: 96, display: "flex", alignItems: "center" }}>
                {s.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.url} alt={s.title} style={s.round ? { width: 96, height: 96, borderRadius: "50%", objectFit: "cover" } : { maxWidth: 200, maxHeight: 80, objectFit: "contain" }} />
                ) : (
                  <span className="muted" style={{ fontSize: 14 }}>Not added yet</span>
                )}
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>{s.help}</p>
              <form action="/api/portal/profile-image" method="post" encType="multipart/form-data" style={{ display: "grid", gap: 10 }}>
                <input type="hidden" name="kind" value={s.kind} />
                <input type="file" name="file" accept="image/jpeg,image/png,image/webp" required aria-label={`Choose a ${s.title.toLowerCase()}`} style={{ fontSize: 13.5 }} />
                <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>{s.url ? "Replace" : "Upload"}</button>
              </form>
              {s.url && (
                <form action="/api/portal/profile-image" method="post" encType="multipart/form-data">
                  <input type="hidden" name="kind" value={s.kind} />
                  <input type="hidden" name="op" value="remove" />
                  <button type="submit" className="btn btn-ghost">Remove</button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default async function PortalPage({ searchParams }: { searchParams: Promise<{ tab?: string; saved?: string; error?: string }> }) {
  const email = await sessionEmail();
  if (!email) redirect("/portal/login");
  const impersonating = await viewingAs();
  const partner = isPartnerEmail(email);
  // Admins and the QA team get the way back to /admin (view as stays admin only).
  const canAdmin = await isStaffAllowed(email);
  const { tab, saved, error } = await searchParams;
  const activeTab = partner ? "galleries" : tab === "bookings" ? "bookings" : tab === "account" && business.profileImages ? "account" : "galleries";
  const profile = activeTab === "account" ? await profileImagesFor(email) : null;
  const listings = await listingsForEmail(email);
  const againUrl = partner || !business.bookAgain ? null : await bookAgainUrl(email, brand.marketingUrl);
  const bookings = activeTab === "bookings" ? await bookingsForListings(listings.map((l) => l.id)) : new Map<string, PortalBooking>();

  // Covers: the 1600px preview (the card is at most ~430px wide, so this is
  // sharp on any screen), watermarked while the gallery is locked.
  const covers: Record<string, string> = {};
  if (activeTab === "galleries") {
    if (hasR2()) {
      await Promise.all(
        listings.map(async (l) => {
          if (!l.coverKey) return;
          covers[l.id] = await signedViewUrl(derivativeKey(l.coverKey, l.downloadLocked ? "preview-wm" : "preview"));
        })
      );
    } else if (isDemo()) {
      listings.forEach((l, i) => (covers[l.id] = DEMO_PHOTOS[(i * 13) % DEMO_PHOTOS.length].url));
    }
  }

  return (
    <>
      {impersonating && <ViewAsBanner email={impersonating} exitAction={exitViewAs} />}
      <Nav />
      <main className="ph">
        <section className="wrap ph-head">
          <div className="ph-head__row">
            <div>
              <div className="kicker ph-rise" style={{ marginBottom: 14 }}>Client portal</div>
              <h1 className="h2 ph-rise" style={{ animationDelay: "80ms" }}>{partner ? "All galleries." : `Welcome to ${brand.shortName}.`}</h1>
              <p className="muted ph-rise" style={{ marginTop: 10, fontSize: 14.5, animationDelay: "160ms" }}>{email}</p>
            </div>
            <div className="ph-head__actions ph-rise" style={{ animationDelay: "200ms" }}>
              {againUrl && (
                <a href={againUrl} className="btn btn-primary">
                  Book again
                </a>
              )}
              {!impersonating && canAdmin && (
                <Link href="/admin" className="chip">
                  Admin →
                </Link>
              )}
              <form action="/api/portal/logout" method="post">
                <button type="submit" className="btn btn-ghost">Sign out</button>
              </form>
            </div>
          </div>
          {isDemo() && <p className="faint" style={{ marginTop: 18, fontSize: 13 }}>Demo data. The database is not connected yet.</p>}
          {!partner && (
            <nav className="ph-tabs ph-rise" aria-label="Portal" style={{ animationDelay: "240ms" }}>
              {(
                [
                  ["galleries", "Galleries", "/portal"],
                  ["bookings", "Bookings", "/portal?tab=bookings"],
                  ["account", "Account", "/portal?tab=account"],
                ] as const
              ).filter(([key]) => key !== "account" || business.profileImages).map(([key, label, href]) => (
                <Link key={key} href={href} scroll={false} className={`ph-tab${activeTab === key ? " is-active" : ""}`} aria-current={activeTab === key ? "page" : undefined}>
                  {/* The dark pill glides to the new tab (view transition). */}
                  {activeTab === key && <span aria-hidden className="ph-tab__ink" />}
                  <span className="ph-tab__label">{label}</span>
                </Link>
              ))}
            </nav>
          )}
        </section>

        <section className="wrap ph-body">
          {activeTab === "account" && profile && <AccountTab profile={profile} saved={saved} error={error} />}

          {listings.length === 0 && activeTab !== "account" && (
            <p className="muted" style={{ fontSize: 15.5, marginTop: 8 }}>
              Nothing here yet. Your shoots will appear here as soon as they are booked.
            </p>
          )}

          {/* ————— Galleries ————— */}
          {activeTab === "galleries" && listings.length > 0 && (
            <div className="ph-grid">
              {listings.map((l, i) => (
                <Link key={l.id} href={`/portal/${l.slug}`} className="ph-card" data-reveal data-reveal-index={i % 3}>
                  <div className="ph-card__cover">
                    {covers[l.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={covers[l.id]} alt={l.address} loading={i < 6 ? "eager" : "lazy"} decoding="async" />
                    ) : (
                      <div className="ph-card__empty">{l.picTimeUrl && l.deliveryEmailAt ? "Your gallery is ready" : "Gallery coming soon"}</div>
                    )}
                    <span className="ph-card__status">
                      <StatusBubble s={shootStatus(l)} onImage />
                    </span>
                  </div>
                  <div className="ph-card__body">
                    <h2 className="h3">{street(l.address)}</h2>
                    <p className="ph-card__meta">
                      {[rest(l.address), l.mediaCount ? `${l.mediaCount} files` : null, nice(l.shootDate)].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* ————— Bookings: every row opens the listing ————— */}
          {activeTab === "bookings" && listings.length > 0 && (
            <div className="ph-bookings" role="list">
              <div className="ph-brow ph-brow--head" aria-hidden>
                <span>Property</span>
                <span>Shoot</span>
                <span>Services</span>
                <span>Delivered</span>
                <span>Status</span>
                <span />
              </div>
              {listings.map((l, i) => {
                const b = bookings.get(l.id);
                const words = b ? BOOKING_WORDS[b.status] : undefined;
                const delivered = l.deliveryEmailAt ?? (l.mediaCount > 0 && !l.downloadLocked ? l.createdAt ?? null : null);
                return (
                  <div key={l.id} className="ph-brow ph-brow--link" role="listitem" data-reveal data-reveal-index={Math.min(i, 4)}>
                    <Link href={`/portal/${l.slug}`} className="ph-brow__hit" aria-label={`Open ${street(l.address)}`} />
                    <span className="ph-brow__prop">
                      <strong>{street(l.address)}</strong>
                      <small>{rest(l.address)}</small>
                    </span>
                    <span className="ph-brow__cell ph-brow__cell--shoot" data-label="Shoot">
                      <span className="ph-brow__when">
                        {whenLine(b, l.shootDate)}
                        {words && words.tone === "wait" && <small>Time to be confirmed</small>}
                      </span>
                      {b?.movable && b.bookingId && !impersonating && <RescheduleButton bookingId={b.bookingId} street={street(l.address)} />}
                    </span>
                    <span className="ph-brow__cell muted" data-label="Services">{b?.services ?? ""}</span>
                    <span className="ph-brow__cell muted" data-label="Delivered">{nice(delivered) ?? (["Delivered", "Completed", "Awaiting Payment"].includes(shootStatus(l)) ? "Yes" : "Not yet")}</span>
                    <span className="ph-brow__cell" data-label="Status">
                      <StatusBubble s={shootStatus(l)} />
                    </span>
                    <span className="ph-brow__go" aria-hidden>
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
