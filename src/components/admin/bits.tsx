// Small server-safe presentational pieces shared by the admin pages.
import Link from "next/link";
import type { ShootStatus as PipelineStatus } from "@/db/schema";
import { STATUS_COLORS, qaListingStatus, type ShootStatus } from "@/lib/listing-status";
import { STEP_COLORS, STEP_LABELS, isActive, fmtWhen, fmtDay } from "@/lib/shoot-status";
import type { AdminActivity, AdminListing } from "@/lib/admin-types";
import { describeActivity } from "@/lib/activity";
import { listingStatusLabel } from "@/lib/admin-data";
import { BOOKING_STATUS_COLORS, bookingStatusLabel } from "@/lib/booking-status";
import { payOtherLabel } from "@/lib/pay-other";

export function ListingPill({ s, onImage = false }: { s: ShootStatus; onImage?: boolean }) {
  const c = STATUS_COLORS[s];
  return (
    <span className={`adm-pill${onImage ? " adm-pill--on-image" : ""}`} style={{ background: c.bg, color: c.fg }}>
      {s}
    </span>
  );
}

export function ShootPill({ s, onImage = false }: { s: PipelineStatus; onImage?: boolean }) {
  const c = STEP_COLORS[s];
  return (
    <span className={`adm-pill${onImage ? " adm-pill--on-image" : ""}`} style={{ background: c.bg, color: c.fg }}>
      {isActive(s) && <span className="adm-dot adm-dot--live" />}
      {STEP_LABELS[s]}
    </span>
  );
}

export function Lock({ locked }: { locked: boolean }) {
  return (
    <span className="adm-pill" style={{ background: locked ? "rgba(95,100,110,.10)" : "rgba(26,127,75,.10)", color: locked ? "#5F646E" : "#1A7F4B" }}>
      {locked ? "Locked" : "Unlocked"}
    </span>
  );
}

export function PageHead({ eyebrow = "Admin", title, lede, children }: { eyebrow?: string; title: React.ReactNode; lede?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="adm-head">
      <div>
        <div className="kicker" style={{ marginBottom: 10 }}>{eyebrow}</div>
        <h1 className="adm-title">{title}</h1>
        {lede && <p className="adm-lede">{lede}</p>}
      </div>
      {children && <div className="adm-actions">{children}</div>}
    </div>
  );
}

export function SectionHead({ title, href, label = "See all →" }: { title: string; href?: string; label?: string }) {
  return (
    <div className="adm-section-head">
      <div className="kicker">{title}</div>
      {href && <Link href={href} className="adm-link">{label}</Link>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="muted" style={{ fontSize: 14, padding: "18px 0" }}>{children}</p>;
}

export function ActivityFeed({ rows, showWhere = true }: { rows: AdminActivity[]; showWhere?: boolean }) {
  if (!rows.length) return <Empty>Nothing yet. Activity appears here as the team works.</Empty>;
  return (
    <div className="adm-feed">
      {rows.map((a) => {
        const href = a.shootId ? `/admin/shoots/${a.shootId}` : a.listingId ? `/admin/listings/${a.listingId}` : a.clientId ? `/admin/clients` : null;
        const where = a.address ? a.address.split(",")[0] : a.action === "admin.view_as" ? "Portal" : "";
        return (
          <div key={a.id} className="adm-feed__row">
            <span className="adm-feed__when">{fmtWhen(a.createdAt)}</span>
            <span style={{ minWidth: 0 }}>{describeActivity(a)}</span>
            {showWhere && (
              <span className="adm-feed__where">{href && where ? <Link href={href} className="adm-link" style={{ fontWeight: 400 }}>{where} →</Link> : where}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// One listing card for grids (dashboard upcoming, listings page).
// qa: the QA team's card: no download lock and no payment state (src/lib/listing-status.ts).
export function ListingCard({ l, viewAs, lockToggle, qa = false }: { l: AdminListing; viewAs?: (email: string) => Promise<void>; lockToggle?: () => Promise<void>; qa?: boolean }) {
  const status = qa ? qaListingStatus(listingStatusLabel(l)) : listingStatusLabel(l);
  const street = l.address.split(",")[0];
  const rest = l.address.split(",").slice(1).join(",").trim();
  return (
    <article className="adm-lcard">
      <Link href={`/admin/listings/${l.id}`} className="adm-lcard__cover" aria-label={`Open ${street}`}>
        {l.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={l.coverUrl} alt="" loading="lazy" />
        ) : (
          <span className="adm-lcard__mark">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/watermark.png" alt="" />
          </span>
        )}
        <span style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 6 }}>
          {l.nda && <span className="adm-pill adm-pill--on-image" style={{ color: "#0B0C0F" }}>NDA</span>}
          <ListingPill s={status} onImage />
        </span>
      </Link>
      <div className="adm-lcard__body">
        <Link href={`/admin/listings/${l.id}`} className="adm-lcard__name" style={{ textDecoration: "none" }}>{street}</Link>
        <div className="adm-lcard__meta">
          {rest && <div>{rest}</div>}
          <div>
            {l.clientName ?? l.clientEmail}
            {l.clientCompany ? ` · ${l.clientCompany}` : ""}
          </div>
          <div className="adm-mono" style={{ marginTop: 4, color: "var(--color-ink-faint)" }}>
            {l.shootDate ? `Shoot ${fmtDay(l.shootDate)}` : "No shoot date"} · {l.mediaCount} files{l.pendingCount ? ` · ${l.pendingCount} in QC` : ""}
          </div>
        </div>
      </div>
      <div className="adm-lcard__foot">
        {!qa && <Lock locked={l.downloadLocked} />}
        <span style={{ flex: 1 }} />
        <Link href={`/admin/listings/${l.id}`} className="adm-chip adm-chip--quiet">Open</Link>
        {viewAs && (
          <form action={viewAs.bind(null, l.clientEmail)}>
            <button type="submit" className="adm-chip adm-chip--quiet" title={`Open the portal as ${l.clientEmail}`}>View as client</button>
          </form>
        )}
        {lockToggle && (
          <form action={lockToggle}>
            <button type="submit" className="adm-chip adm-chip--quiet">{l.downloadLocked ? "Unlock" : "Lock"}</button>
          </form>
        )}
      </div>
    </article>
  );
}

// ---- Bookings (step two) ---------------------------------------------------
// Pay status with the amount (money renders only under /admin), the booking
// status and a job status, each as a pill with a word.

const PAY_PILLS: Record<string, { bg: string; fg: string; l: string }> = {
  needs_quote: { bg: "rgba(154,100,0,.10)", fg: "#9A6400", l: "Needs quote" },
  open: { bg: "rgba(154,100,0,.10)", fg: "#9A6400", l: "Unpaid" },
  processing: { bg: "rgba(0,102,214,.09)", fg: "#0066D6", l: "In progress" },
  review: { bg: "rgba(0,102,214,.09)", fg: "#0066D6", l: "In review" },
  paid: { bg: "rgba(26,127,75,.10)", fg: "#1A7F4B", l: "Paid" },
  paid_manual: { bg: "rgba(26,127,75,.10)", fg: "#1A7F4B", l: "Paid by hand" },
  refunded: { bg: "rgba(215,52,42,.08)", fg: "#D7342A", l: "Refunded" },
  void: { bg: "rgba(95,100,110,.10)", fg: "#5F646E", l: "Voided" },
  canceled: { bg: "rgba(95,100,110,.10)", fg: "#5F646E", l: "Canceled" },
  uncollectible: { bg: "rgba(95,100,110,.10)", fg: "#5F646E", l: "Uncollectible" },
  draft: { bg: "rgba(95,100,110,.10)", fg: "#5F646E", l: "Draft" },
};

export const fmtMoney = (cents: number | null | undefined) => {
  if (cents == null) return null;
  const frac = Math.round(cents) % 100 !== 0 ? 2 : 0; // cents only when there are some
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
};

export function PayPill({ status, amountCents, showAmount = true }: { status: string | null | undefined; amountCents?: number | null; showAmount?: boolean }) {
  if (!status) return <span className="adm-pill" style={{ background: "rgba(95,100,110,.10)", color: "#5F646E" }}>No invoice</span>;
  const c = PAY_PILLS[status] ?? { bg: "rgba(95,100,110,.10)", fg: "#5F646E", l: status.replace(/_/g, " ") };
  const amt = showAmount && amountCents != null && amountCents > 0 ? fmtMoney(amountCents) : null;
  return (
    <span className="adm-pill" style={{ background: c.bg, color: c.fg }}>
      {c.l}{amt ? <span style={{ fontFamily: "var(--font-mono)", letterSpacing: ".02em", textTransform: "none" }}>{amt}</span> : null}
    </span>
  );
}

// Words and colors live in src/lib/booking-status.ts (the client status
// controls use the same ones). "requested" reads "Unconfirmed".
export function BookingPill({ s }: { s: string }) {
  const c = (BOOKING_STATUS_COLORS as Record<string, { bg: string; fg: string }>)[s] ?? { bg: "rgba(95,100,110,.10)", fg: "#5F646E" };
  return <span className="adm-pill" style={{ background: c.bg, color: c.fg }}>{bookingStatusLabel(s)}</span>;
}

// The shooter as a small initial plus the name part of the email (the full
// address on hover). "Unassigned" turns amber when the shoot needs someone.
export function Shooter({ email, needed = false }: { email: string | null | undefined; needed?: boolean }) {
  if (!email) {
    return (
      <span className={`bk-shooter bk-shooter--none${needed ? " bk-shooter--need" : ""}`} title={needed ? "Nobody is on this shoot yet" : "No shooter"}>
        <span className="bk-shooter__dot" aria-hidden>?</span>Unassigned
      </span>
    );
  }
  const local = email.split("@")[0];
  const initials = local.split(/[._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("") || local[0] || "?";
  return (
    <span className="bk-shooter" title={email}>
      <span className="bk-shooter__dot" aria-hidden>{initials}</span>
      {local}
    </span>
  );
}

// An Unconfirmed request whose requested time is behind us. It stays in
// Upcoming with this warning until someone sets a new time or a status.
export function DatePassedPill() {
  return (
    <span className="adm-pill" style={{ background: "rgba(215,52,42,.08)", color: "#D7342A" }} title="The requested time has passed and nobody confirmed it. Confirm a new time or set the status.">
      Date passed, set a new time
    </span>
  );
}

const JOB_PILLS: Record<string, { bg: string; fg: string; l: string }> = {
  queued: { bg: "rgba(95,100,110,.10)", fg: "#5F646E", l: "Queued" },
  running: { bg: "rgba(0,102,214,.09)", fg: "#0066D6", l: "Running" },
  done: { bg: "rgba(26,127,75,.10)", fg: "#1A7F4B", l: "Done" },
  dead: { bg: "rgba(215,52,42,.08)", fg: "#D7342A", l: "Gave up" },
};

export function JobPill({ s, waiting = false }: { s: string; waiting?: boolean }) {
  const c = JOB_PILLS[s] ?? { bg: "rgba(95,100,110,.10)", fg: "#5F646E", l: s };
  return (
    <span className="adm-pill" style={{ background: c.bg, color: c.fg }}>
      {s === "running" && <span className="adm-dot adm-dot--live" />}
      {s === "queued" && waiting ? "Waiting" : c.l}
    </span>
  );
}

// "other" = pay another way: the detail (Check, ACH transfer, Cash) when known.
export function PaymentMethod({ m, detail }: { m: string | null | undefined; detail?: string | null }) {
  return <span className="muted">{m === "pay_at_close" ? "Pay at close" : m === "card" ? "Card" : m === "other" ? payOtherLabel(detail) : m ? m.replace(/_/g, " ") : "Not chosen"}</span>;
}
