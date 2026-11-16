// The pay page (docs/booking-to-payment.md): the
// one client-facing place to pay, and the receipt once paid. Session required
// (the booking and delivery emails reach it through a 30-day pay token that
// /api/portal/verify turns into a session), the listing must belong to the
// signed-in client or their team, partners never see it.
//
// Nothing here unlocks anything. On every load of a payable invoice that has a
// provider id, the server reads the invoice or checkout back from the provider
// (syncInvoiceFromProvider, throttled 30 s) and only that answer can move the
// status; the same happens with ?paid=1 after a provider redirect.
//
// Client copy: plain and warm, sentence case, no em dashes, no exclamation
// marks, Titus and Stripe are the only names, the Quo line is the only number.
// Pay another way (check, ACH transfer or cash) shows the total and a short
// line that the business follows up; never a card or Titus button.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ViewAsBanner from "@/components/ViewAsBanner";
import AutoRefresh from "@/components/AutoRefresh";
import PayAtCloseButton from "@/components/PayAtCloseButton";
import { exitViewAs } from "../../view-as-actions";
import { hasDb } from "@/db";
import { fmtDollars } from "@/lib/studio-pricing";
import { brand, supportPhone } from "@/lib/brand";
import { isPartnerEmail } from "@/lib/partner";
import { isOtherEnv, isPaid, isPayable, syncInvoiceFromProvider } from "@/lib/payments";
import { sessionEmail, viewingAs } from "@/lib/portal-auth";
import { listingForEmail, type PortalInvoice } from "@/lib/portal-data";
import { hasTitus, titusWebBase } from "@/lib/titus";
import { isPaidAnotherWay, payOtherPhrase } from "@/lib/pay-other";
import { BUSINESS_TZ } from "@/lib/business";

export const metadata: Metadata = { title: "Pay for your gallery", robots: { index: false } };
export const dynamic = "force-dynamic";

type Copy = { pill: string; tone: "warn" | "ok" | "quiet" | "live"; title: string; text: string };

function copyFor(inv: PortalInvoice): Copy {
  const other = isPaidAnotherWay(inv);
  // An invoice that does not hold the gallery (a second shoot's own, or items
  // added later): the same states, with no word about downloads.
  if (!inv.gates) {
    switch (inv.status) {
      case "open":
        if (!other) return { pill: "Awaiting payment", tone: "warn", title: "Pay your invoice", text: "Pay online with a card or a bank transfer. It is due on receipt." };
        break;
      case "processing":
        return { pill: "In progress", tone: "quiet", title: "Payment in progress", text: "Your payment is on its way to us, and this page updates on its own." };
      case "paid":
      case "paid_manual":
        return { pill: "Paid", tone: "ok", title: "Paid, thank you", text: "We have your payment. Keep this page for your records." };
      case "refunded":
        return { pill: "Refunded", tone: "quiet", title: "This payment was refunded", text: `If you have a question about it, text ${supportPhone()}.` };
    }
  }
  switch (inv.status) {
    case "open":
      if (other) {
        const how = payOtherPhrase(inv.paymentDetail);
        return { pill: "Awaiting payment", tone: "warn", title: `Pay ${how}`, text: `You chose to pay ${how}. ${brand.shortName} will follow up with the details, and nothing is charged by card. Downloads unlock as soon as we receive your payment.` };
      }
      return inv.provider === "titus"
        ? { pill: "Pay at close", tone: "warn", title: "Finish your pay at close application", text: "Nothing is due from you today. The balance settles when the listing closes or after six months, and downloads unlock as soon as the agreement is complete." }
        : { pill: "Awaiting payment", tone: "warn", title: "Pay your invoice", text: "Pay online with a card or a bank transfer. Downloads unlock the moment it clears." };
    case "processing":
      return { pill: "In progress", tone: "quiet", title: "Payment in progress", text: "Your payment is on its way to us. Downloads unlock the moment it clears, and this page updates on its own." };
    case "review":
      return { pill: "In review", tone: "quiet", title: "Your pay at close application is being reviewed", text: "Downloads open as soon as it clears. We will email you either way." };
    case "paid":
    case "paid_manual":
      return { pill: "Paid", tone: "ok", title: "Paid, downloads are unlocked", text: "Watermarks are off and full-resolution downloads are open in your gallery. Keep this page for your records." };
    case "needs_quote":
    case "draft":
      return { pill: "Confirming total", tone: "quiet", title: "We are confirming your total", text: "Part of this request is quoted by hand. This page will update, and we will email you before anything is due." };
    case "refunded":
      return { pill: "Refunded", tone: "quiet", title: "This payment was refunded", text: `Downloads are closed again. If you have a question about it, text ${supportPhone()}.` };
    case "void":
    case "canceled":
    case "uncollectible":
    default:
      return { pill: "Replaced", tone: "quiet", title: "This invoice was replaced", text: "Check your email for the current one, or reply to your booking email and we will send it again." };
  }
}

const TONES: Record<Copy["tone"], { bg: string; fg: string }> = {
  warn: { bg: "rgba(154,100,0,.10)", fg: "var(--color-warning)" },
  ok: { bg: "rgba(26,127,75,.10)", fg: "var(--color-success)" },
  quiet: { bg: "rgba(95,100,110,.10)", fg: "var(--color-ink-soft)" },
  live: { bg: "rgba(215,52,42,.08)", fg: "var(--color-live)" },
};

function fmtDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, month: "long", day: "numeric", year: "numeric" }).format(d);
}

export default async function PayPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ paid?: string; invoice?: string }> }) {
  const email = await sessionEmail();
  if (!email) redirect("/portal/login");
  if (isPartnerEmail(email)) notFound();
  const { slug } = await params;
  const sp = await searchParams;
  const wanted = sp.invoice && /^[0-9a-f-]{36}$/i.test(sp.invoice) ? sp.invoice : null;
  let data = await listingForEmail(email, slug, { invoiceId: wanted });
  if (!data) notFound();
  let inv = data.listing.invoice;

  // Ask the provider before showing anything a client might act on (the sync
  // itself refuses a row another environment owns). Back from the provider
  // (?paid=1) the read is immediate, not throttled. The page render is a
  // pay_page_load: it notes what Titus says and never resets a checkout; only
  // the pay at close button's own POST (source pay_page) may do that.
  if (hasDb() && inv && inv.providerId && isPayable(inv.status)) {
    const r = await syncInvoiceFromProvider(inv.id, sp.paid ? "client_success" : "pay_page_load", { skipThrottle: Boolean(sp.paid) });
    if (r.changed) {
      data = (await listingForEmail(email, slug, { invoiceId: inv.id })) ?? data;
      inv = data.listing.invoice;
    }
  }
  // A preview admin viewing as a production client (one shared database): the
  // pay at close button must not read or recreate that checkout from here.
  const ownEnv = !inv || !isOtherEnv(inv.env);
  const impersonating = await viewingAs();
  const { listing } = data;
  const street = listing.address.split(",")[0].trim();
  const rest = listing.address.split(",").slice(1).join(",").trim();
  const copy = inv ? copyFor(inv) : null;
  const tone = copy ? TONES[copy.tone] : null;
  const paid = Boolean(inv && isPaid(inv.status));
  const lines = (inv?.lineItems ?? []).filter((l) => l.priced && l.cents > 0);
  const total = inv?.amountCents != null && inv.amountCents > 0 ? fmtDollars(inv.amountCents) : null;
  const waitingForInvoice = Boolean(inv && inv.status === "open" && inv.provider === "stripe" && !inv.hostedUrl);
  const refreshing = Boolean(inv && (inv.status === "processing" || waitingForInvoice || (inv.status === "open" && Boolean(sp.paid))));

  return (
    <>
      {impersonating && <ViewAsBanner email={impersonating} exitAction={exitViewAs} />}
      <Nav />
      <main>
        <section className="section" style={{ minHeight: "62vh", paddingTop: 64 }}>
          <div className="wrap" style={{ maxWidth: 720 }}>
            <Link href={`/portal/${listing.slug}`} className="muted" style={{ fontSize: 13 }}>← Back to the gallery</Link>
            <div className="kicker" style={{ marginTop: 30, marginBottom: 14 }}>{paid ? "Receipt" : "Payment"}</div>
            <h1 className="h2">{street}</h1>
            {rest && <p className="muted" style={{ marginTop: 10, fontSize: 14.5 }}>{rest}</p>}

            {!inv || !copy || !tone ? (
              <p className="muted" style={{ marginTop: 40, fontSize: 15.5, lineHeight: 1.7 }}>
                Nothing is due on this gallery right now. If you were expecting an invoice, reply to your booking email or text {supportPhone()}.
              </p>
            ) : (
              <>
                <div style={{ marginTop: 36, border: "1px solid var(--line)", borderRadius: 14, background: "var(--color-surface)", padding: "8px 24px 10px" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14.5 }}>
                    <tbody>
                      {lines.length ? (
                        lines.map((l) => (
                          <tr key={l.id} style={{ borderBottom: "1px solid var(--line)" }}>
                            <td style={{ padding: "14px 0" }}>{l.name}</td>
                            <td className="mono" style={{ padding: "14px 0", textAlign: "right", whiteSpace: "nowrap", fontSize: 13.5 }}>{fmtDollars(l.cents)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr style={{ borderBottom: "1px solid var(--line)" }}>
                          <td style={{ padding: "14px 0" }}>{inv.description ?? `${street} shoot`}</td>
                          <td className="mono" style={{ padding: "14px 0", textAlign: "right", whiteSpace: "nowrap", fontSize: 13.5 }}>{total ?? ""}</td>
                        </tr>
                      )}
                      <tr>
                        <td style={{ padding: "16px 0 14px", fontWeight: 500 }}>{paid ? "Total paid" : "Total"}</td>
                        <td className="mono" style={{ padding: "16px 0 14px", textAlign: "right", whiteSpace: "nowrap", fontWeight: 500 }}>{total ?? "To be confirmed"}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div style={{ marginTop: 30 }}>
                  <span style={{ display: "inline-block", fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", fontWeight: 500, padding: "8px 14px", borderRadius: 999, background: tone.bg, color: tone.fg }}>
                    {copy.pill}
                  </span>
                  <h2 className="h3" style={{ marginTop: 18 }}>{copy.title}</h2>
                  <p className="muted" style={{ marginTop: 12, fontSize: 15, lineHeight: 1.7, maxWidth: "58ch" }}>{copy.text}</p>
                  {paid && (
                    <p className="muted" style={{ marginTop: 8, fontSize: 13.5 }}>
                      {fmtDay(inv.paidAt) ? `Paid on ${fmtDay(inv.paidAt)}` : "Paid"}
                      {inv.method === "pay_at_close" ? " through pay at close" : inv.method === "card" ? " by card" : isPaidAnotherWay(inv) && inv.paymentDetail ? ` ${payOtherPhrase(inv.paymentDetail)}` : ""}
                    </p>
                  )}

                  <div style={{ marginTop: 24 }}>
                    {paid && <Link href={`/portal/${listing.slug}`} className="btn btn-primary">Open your gallery</Link>}
                    {inv.status === "open" && inv.provider === "stripe" && inv.hostedUrl && (
                      <a href={inv.hostedUrl} className="btn btn-primary">Pay invoice{total ? ` · ${total}` : ""}</a>
                    )}
                    {waitingForInvoice && <p className="muted" style={{ fontSize: 14.5 }}>Your invoice is being prepared. This page will update in a moment.</p>}
                    {inv.status === "open" && inv.provider === "titus" && (hasTitus() && ownEnv ? (
                      <PayAtCloseButton slug={listing.slug} invoiceId={inv.id} webBase={titusWebBase()} />
                    ) : (
                      <p className="muted" style={{ fontSize: 14.5 }}>Pay at close is being set up for this gallery. We will email you when the application is ready.</p>
                    ))}
                  </div>
                </div>
              </>
            )}

            <p className="faint" style={{ marginTop: 44, fontSize: 13, lineHeight: 1.6 }}>
              Questions about this payment? Reply to your booking email or text {supportPhone()}.
            </p>
          </div>
        </section>
      </main>
      <Footer />
      {refreshing && <AutoRefresh />}
    </>
  );
}
