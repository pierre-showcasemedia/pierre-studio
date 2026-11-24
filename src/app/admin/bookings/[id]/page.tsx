// One booking (docs/booking-to-payment.md): the status control,
// the request as the form sent it, the schedule, the invoice with its line
// items and provider link, every side-effect job with "Run now", and the
// status history from the activity log. Money renders here and nowhere a
// shooter or client sees.
import "@/styles/admin-bookings.css";
import Link from "next/link";
import { notFound } from "next/navigation";
import { adminBooking, shooterSuggestions } from "@/lib/admin-data";
import type { AdminBookingDetail, AdminJob } from "@/lib/admin-types";
import { isTimeConfirmed } from "@/lib/booking-status";
import { fmtDay, fmtLa } from "@/lib/booking-time";
import { enterViewAs } from "../../../portal/view-as-actions";
import { assignShooter, confirmTime, markPaid, resendPayLink, runJob, saveBookingNote, setBookingStatus, setInvoiceAmount, switchToCard } from "../../actions";
import { ActivityFeed, BookingPill, DatePassedPill, Empty, JobPill, Lock, PaymentMethod, PayPill, SectionHead, fmtMoney } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";
import { isPaidAnotherWay, payOtherPhrase } from "@/lib/pay-other";
import { StatusControl } from "../_components/StatusControl";
import { EditBookingPanel } from "@/components/admin/EditBookingPanel";
import { ClientFile } from "../_components/ClientFile";
import { AdditionalShoots } from "../_components/AdditionalShoots";
import { visitKindLabel, visitsForBooking } from "@/lib/booking-visits";
import { visitInvoicesForBooking } from "@/lib/visit-invoice";
import { localYmd } from "@/lib/local-date";
import { clientFileFor, EMPTY_CLIENT_FILE } from "@/lib/client-file";
import { hasDb } from "@/db";
import { TZ_SHORT } from "@/lib/business";
import { bookingAttachments } from "@/lib/intake-files";
import { visitLabel } from "@/lib/leads";
import type { LeadVisit } from "@/db/schema";

// Server actions on this page drain the booking's jobs in after(); give them room.
export const maxDuration = 60;

type Search = { done?: string; error?: string };

const PROPERTY_LABELS: [string, string][] = [
  ["status", "Property status"],
  ["listingType", "Listing type"],
  ["offMarket", "Off market"],
  ["listingAgreement", "Listing agreement"],
  ["viewHome", "View home"],
  ["views", "Views"],
  ["homeownerHome", "Homeowner home"],
  ["videoStyle", "Video style"],
  ["musicLink", "Music"],
  ["facing", "Faces"], // asked until Oct 17 2026; propertyRows skips it when the row has none
];

function propertyRows(p: Record<string, unknown> | null): [string, string][] {
  if (!p) return [];
  const out: [string, string][] = [];
  for (const [key, label] of PROPERTY_LABELS) {
    const v = p[key];
    const s = Array.isArray(v) ? v.map(String).filter(Boolean).join(", ") : typeof v === "string" ? v.trim() : v == null ? "" : String(v);
    if (s) out.push([label, s]);
  }
  return out;
}

const jobWaiting = (j: AdminJob) => j.status === "queued" && Boolean(j.lastError) && /not configured/.test(j.lastError ?? "");

// The latest calendar invite job for this shooter (keys end in
// ":<email>:request", src/lib/shooter-invite.ts), as a short line.
function inviteLine(jobs: AdminJob[], email: string | null): string | null {
  if (!email) return null;
  const j = jobs.find((x) => x.kind === "email.shooter_invite" && x.idempotencyKey.endsWith(`:${email.toLowerCase()}:request`));
  if (!j) return null;
  if (j.status === "done") return j.lastError?.startsWith("skipped") ? "invite not sent" : `invite sent ${fmtLa(j.doneAt)}`;
  if (j.status === "dead") return "invite gave up, see the jobs below";
  return jobWaiting(j) ? "invite waiting for email sending" : "invite queued";
}

function providerLink(inv: NonNullable<AdminBookingDetail["invoice"]>): { href: string; label: string } | null {
  if (!inv.hostedUrl) return null;
  if (inv.provider === "stripe") return { href: inv.hostedUrl, label: "Open in Stripe" };
  if (inv.provider === "titus") return { href: inv.hostedUrl, label: "Open in Titus" };
  return { href: inv.hostedUrl, label: "Open with the provider" };
}

export default async function AdminBookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const { id } = await params;
  // Read once per render: the lint rule bans Date.now() inside JSX.
  const renderedAt = new Date().getTime();
  const sp = await searchParams;
  const [data, suggestions, visitData, visitInvoices] = await Promise.all([adminBooking(id), shooterSuggestions(), visitsForBooking(id), visitInvoicesForBooking(id)]);
  const clientFile = data && hasDb() ? await clientFileFor({ clientId: data.booking.client.id, email: data.booking.client.email, phone: data.booking.client.phone, name: data.booking.client.name, company: data.booking.client.company, address: data.booking.address }) : EMPTY_CLIENT_FILE;
  if (!data) notFound();
  const { booking: b, activity, jobs } = data;
  const inv = b.invoice;
  const street = b.address.split(",")[0].trim() || "Address missing";
  const rest = b.address.split(",").slice(1).join(",").trim();
  const lines = (inv?.lineItems ?? []).filter((l) => l.cents > 0 || !l.priced);
  const total = inv?.amountCents != null && inv.amountCents > 0 ? fmtMoney(inv.amountCents) : null;
  const link = inv ? providerLink(inv) : null;
  const prop = propertyRows(b.property);
  const lastEvent = inv?.lastEvent ?? null;
  const submissionIds = b.raw?.submissionIds ?? [];
  const canceled = b.status === "canceled";
  // "Confirmed" is the booking status an admin set (Confirm time or the status
  // control), never the starts_at the form filled in: intake stores a
  // requested start for every booking that came with a time.
  const confirmed = isTimeConfirmed(b.status);
  const invite = inviteLine(jobs, b.photographerEmail);
  const paid = Boolean(inv && ["paid", "paid_manual"].includes(inv.status));
  const payable = Boolean(inv && ["open", "processing", "review"].includes(inv.status));
  // Mark paid: the statuses payments.markPaidManually will settle
  // (MANUAL_PAID_FROM). A void, draft, canceled or refunded row gets no form,
  // so nothing is ever closed at the provider for a row that cannot move.
  const canMarkPaid = Boolean(inv && !canceled && ["needs_quote", "open", "processing", "review", "uncollectible"].includes(inv.status));
  // Set amount: a quote (needs_quote), an open invoice not issued yet, or an
  // issued unpaid one, which is reissued (closed at the provider, new version).
  const canSetAmount = Boolean(inv && !canceled && (inv.status === "needs_quote" || inv.status === "open"));
  const reissue = Boolean(inv && inv.status === "open" && inv.providerId);
  const revisedAfterIssue = Boolean(inv && !paid && !canceled && inv.meta?.revisedAfterIssue);
  const providerObject = inv?.provider === "titus" ? "pay at close checkout" : "Stripe invoice";
  // Pay another way (check, ACH transfer or cash): no provider object, no pay
  // link; Set amount only opens the invoice and Mark paid settles it.
  const manual = isPaidAnotherWay(inv);
  const how = payOtherPhrase(b.paymentDetail);

  return (
    <section className="wrap adm-page">
      <Link href="/admin/bookings" className="adm-link muted" style={{ fontSize: 12.5 }}>← Bookings</Link>
      <div className="adm-head" style={{ marginTop: 14 }}>
        <div>
          <div className="flex flex-wrap items-center" style={{ gap: 10, marginBottom: 10 }}>
            <span className="kicker" style={{ margin: 0 }}>Booking</span>
            <BookingPill s={b.status} />
            {b.movedByClient && b.status !== "canceled" && <span className="adm-pill bk-moved">Rescheduled · unconfirmed</span>}
            {b.datePassed && <DatePassedPill />}
            <PayPill status={inv?.status} amountCents={inv?.amountCents} />
            <Lock locked={b.listingLocked} />
            {b.nda && <span className="adm-pill" style={{ background: "rgba(11,12,15,.08)" }}>NDA</span>}
          </div>
          <h1 className="adm-title">{street}</h1>
          <p className="adm-lede">
            {rest}{rest ? " · " : ""}
            <Link href={`/admin/clients?q=${encodeURIComponent(b.client.email)}`} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{b.client.name ?? b.client.email}</Link>
            {b.client.company ? ` · ${b.client.company}` : ""}
            {b.client.name ? ` · ${b.client.email}` : ""}
            {b.client.phone ? ` · ${b.client.phone}` : ""}
            {b.market ? ` · ${b.market}` : ""}
            {" · booked "}<span className="adm-mono">{fmtLa(b.createdAt)}</span>
          </p>
        </div>
        <div className="adm-actions">
          <Link href={`/admin/listings/${b.listingId}`} className="btn btn-primary">Open the listing →</Link>
          {/* The order's photos live on its listing: this opens the upload panel there. */}
          <Link href={`/admin/listings/${b.listingId}#upload`} className="btn btn-ghost">Upload photos →</Link>
          {b.client.email && (
            <form action={enterViewAs.bind(null, b.client.email)}>
              <button type="submit" className="btn btn-ghost">View as client</button>
            </form>
          )}
        </div>
      </div>

      {sp.done && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>{sp.done}</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}
      {canceled && <p className="adm-banner adm-banner--warn" style={{ marginTop: 18 }}>This booking is canceled. The calendar hold is released and the invoice is closed. Restore it below as Unconfirmed or Confirmed if it is back on; the invoice stays as it is.</p>}
      {b.movedByClient && b.status !== "canceled" && (
        <p className="adm-banner" style={{ marginTop: 18 }}>
          {b.client.name ?? b.client.email} moved this shoot from the portal{b.movedByClient.from ? ` (was ${b.movedByClient.from})` : ""} on {fmtLa(b.movedByClient.at)}. The new time is {b.when ?? "not set"}: confirm it below, or call the client. The calendar shows it as [RESCHEDULED - UNCONFIRMED] until you confirm.
        </p>
      )}
      {b.datePassed && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>The requested time{b.when ? ` (${b.when})` : ""} has passed and nobody confirmed it. Confirm a new time below, or set the status.</p>}
      {b.deadJobs > 0 && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{b.deadJobs} side effect{b.deadJobs === 1 ? "" : "s"} gave up. See the jobs below and run them again once the cause is clear.</p>}
      {revisedAfterIssue && <p className="adm-banner adm-banner--warn" style={{ marginTop: 18 }}>The client changed this booking after the invoice was issued. Review the amount below and reissue it if the total should change.</p>}

      <div className="adm-card bk-status-card" style={{ marginTop: 24 }}>
        <div className="kicker">Status</div>
        {/* Keyed on the saved note: after a save the field starts from what is stored; a status change alone keeps what is typed. */}
        <StatusControl key={b.internalNote ?? ""} action={setBookingStatus.bind(null, b.id)} saveNote={saveBookingNote.bind(null, b.id)} status={b.status} note={b.internalNote} />
        <p className="bk-status-help">
          Confirmed with a date and time emails the client their confirmation (their new time, after a reschedule from the portal); no other status emails them. Confirmed keeps the requested time unless you confirm a new one below. Moving between Unconfirmed and Confirmed updates the calendar and the shooter&apos;s invite.
          Canceled voids the open invoice or closes the pay at close checkout, releases the calendar hold, cancels the shooter&apos;s invite and tells the team; a paid invoice is left alone and downloads are not touched.
          A canceled booking comes back as Unconfirmed or Confirmed, and its invoice stays as it is.
          The note is for the team only and stays on the booking: Save note keeps it without changing the status, and picking a status also saves an edited note and adds it to the history.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 24, marginTop: 32 }}>
        <div>
          <SectionHead title="Schedule" />
          <dl className="adm-kv adm-card" style={{ gridTemplateColumns: "1fr" }}>
            <div><dt>Requested</dt><dd>{b.when ?? "Date to be confirmed"}{b.when && !confirmed && !canceled ? <span className="muted"> · not confirmed yet</span> : null}</dd></div>
            <div><dt>Confirmed</dt><dd className={confirmed && b.startsAt ? "" : "muted"}>{confirmed && b.startsAt ? `${fmtLa(b.startsAt)}${b.endsAt ? ` to ${fmtLa(b.endsAt).split(", ").pop()}` : ""} ${TZ_SHORT}` : "Not yet"}</dd></div>
            <div><dt>Launch</dt><dd className={b.launchDate ? "" : "muted"}>{b.launchDate ? fmtDay(b.launchDate, { long: true }) : "Not given"}</dd></div>
            <div><dt>Shooter</dt><dd className={b.photographerEmail ? "" : "muted"}>{b.photographerEmail ?? "Unassigned"}{invite ? <span className="muted"> · {invite}</span> : null}</dd></div>
            <div><dt>Calendar</dt><dd className={b.calendarSynced ? "" : "muted"}>{b.calendarSynced ? `On the hello@ calendar${b.calendarSyncedAt ? ` · synced ${fmtLa(b.calendarSyncedAt)}` : ""}` : "Not synced yet"}<span className="faint adm-mono" style={{ marginLeft: 8, fontSize: 11 }}>v{b.calendarVersion}</span></dd></div>
          </dl>
        </div>
        <div>
          <SectionHead title="Invoice" />
          {!inv ? (
            <Empty>No invoice on this booking.</Empty>
          ) : (
            <div className="adm-card" style={{ display: "grid", gap: 14 }}>
              <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                <PayPill status={inv.status} amountCents={null} />
                <PaymentMethod m={inv.method ?? b.paymentMethod} detail={b.paymentDetail} />
                {inv.provider && <span className="muted" style={{ fontSize: 12.5 }}>via {inv.provider}</span>}
                <span style={{ flex: 1 }} />
                {link && <a href={link.href} target="_blank" rel="noreferrer" className="adm-chip adm-chip--quiet">{link.label} ↗</a>}
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                <tbody>
                  {lines.length ? (
                    lines.map((l, i) => (
                      <tr key={`${l.id}-${i}`} style={{ borderTop: "1px solid var(--line)" }}>
                        <td style={{ padding: "9px 0" }}>{l.name}</td>
                        <td className="adm-mono" style={{ padding: "9px 0", textAlign: "right", whiteSpace: "nowrap" }}>{l.priced ? fmtMoney(l.cents) : <span className="muted">to quote</span>}</td>
                      </tr>
                    ))
                  ) : (
                    <tr style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "9px 0" }}>{inv.description ?? `${street} shoot`}</td>
                      <td className="adm-mono" style={{ padding: "9px 0", textAlign: "right" }}>{total ?? ""}</td>
                    </tr>
                  )}
                  <tr style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "11px 0 4px", fontWeight: 500 }}>Total</td>
                    <td className="adm-mono" style={{ padding: "11px 0 4px", textAlign: "right", fontWeight: 500 }}>{total ?? <span className="muted">to be set</span>}</td>
                  </tr>
                </tbody>
              </table>
              <dl className="adm-kv" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                <div><dt>Provider id</dt><dd className="adm-mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{inv.providerId ?? <span className="muted">{manual ? `none, paid ${how}` : "not issued yet"}</span>}</dd></div>
                <div><dt>Paid</dt><dd className={inv.paidAt ? "" : "muted"}>{inv.paidAt ? fmtLa(inv.paidAt) : "No"}{inv.refundedCents ? ` · refunded ${fmtMoney(inv.refundedCents)}` : ""}</dd></div>
                <div><dt>Last event</dt><dd className="muted" style={{ fontSize: 12.5 }}>{lastEvent ? `${String(lastEvent.type ?? "event")}${lastEvent.at ? ` · ${fmtLa(String(lastEvent.at))}` : ""}` : "None yet"}</dd></div>
                <div><dt>Checked</dt><dd className="muted" style={{ fontSize: 12.5 }}>{inv.lastCheckedAt ? fmtLa(inv.lastCheckedAt) : "Never"} · v{inv.idempotencyVersion}</dd></div>
                {inv.meta?.note && <div style={{ gridColumn: "1 / -1" }}><dt>Note</dt><dd className="muted" style={{ fontSize: 12.5 }}>{inv.meta.note}</dd></div>}
                {inv.meta?.loanDecision && <div><dt>Pay at close</dt><dd className="muted" style={{ fontSize: 12.5 }}>{String(inv.meta.loanDecision).replace(/-/g, " ")}</dd></div>}
              </dl>
            </div>
          )}
          {visitInvoices.length > 0 && (
            <div className="adm-card" style={{ display: "grid", gap: 10, marginTop: 14 }}>
              <div className="kicker" style={{ margin: 0 }}>Additional invoices · {visitInvoices.length}</div>
              <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Second shoot invoices, each with its own pay link. The invoice above stays the booking&apos;s own and governs downloads; these never lock or unlock the gallery.</p>
              {visitInvoices.map((vi) => (
                <div key={vi.id} className="flex flex-wrap items-center" style={{ gap: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                  <PayPill status={vi.status} amountCents={vi.amountCents} />
                  <a href="#visits" className="adm-link" style={{ fontSize: 13 }}>{visitKindLabel(vi.meta?.visitKind)}</a>
                  <span className="muted" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{vi.lineItems.map((l) => l.name).join(", ") || vi.description}</span>
                  <span style={{ flex: 1 }} />
                  {vi.hostedUrl && <a href={vi.hostedUrl} target="_blank" rel="noreferrer" className="adm-chip adm-chip--quiet">Open in Stripe ↗</a>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="adm-section">
        <SectionHead title="Actions" />
        <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 14 }}>
          <form action={confirmTime.bind(null, b.id)} className="adm-card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <div className="kicker">{confirmed ? "Reschedule" : "Confirm time"}</div>
            <div className="grid grid-cols-2" style={{ gap: 10 }}>
              <div className="field"><label htmlFor="bk-date">Date</label><input id="bk-date" name="date" type="date" required defaultValue={b.desiredDate ?? ""} /></div>
              <div className="field"><label htmlFor="bk-time">Start, {TZ_SHORT}</label><input id="bk-time" name="time" type="time" required step={900} defaultValue={b.startTime ?? ""} /></div>
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Sets the confirmed start and end, marks the booking confirmed, moves the event on the hello@ calendar (Google updates the shooter if one is on it) and tells the bookings channel. The client gets the confirmation by email with the calendar file: their new time after a reschedule from the portal, the moved time, or the first confirmation.</p>
            <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }} disabled={canceled}>{confirmed ? "Reschedule" : "Confirm time"}</button>
          </form>

          <form action={assignShooter.bind(null, b.id)} className="adm-card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <div className="kicker">Assign shooter</div>
            <div className="field">
              <label htmlFor="bk-shooter">Shooter email</label>
              <input id="bk-shooter" name="email" type="email" list="bk-shooter-list" autoComplete="off" defaultValue={b.photographerEmail ?? ""} placeholder="shooter@example.com" />
              <datalist id="bk-shooter-list">
                {suggestions.map((e) => <option key={e} value={e} />)}
              </datalist>
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>The shooter gets an email with a calendar invite (Accept adds the shoot to their calendar), and a replaced shooter gets a cancel. Any email works; the team is suggested. Saving the same shooter again resends the invite. Leave it empty to clear the shooter.</p>
            <button type="submit" className="btn btn-ghost" style={{ justifySelf: "start" }} disabled={canceled}>{b.photographerEmail ? "Save and send the invite" : "Assign and send the invite"}</button>
          </form>

          {inv && (
            <div className="adm-card" style={{ display: "grid", gap: 14, gridColumn: "1 / -1" }}>
              <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                <div className="kicker">Payment</div>
                <PayPill status={inv.status} amountCents={inv.amountCents} />
                <span style={{ flex: 1 }} />
                {payable && !canceled && !manual && (
                  <form action={resendPayLink.bind(null, inv.id)}>
                    <button type="submit" className="adm-chip">Resend pay link</button>
                  </form>
                )}
                {(inv.provider === "titus" || manual) && !paid && !canceled && (
                  <form action={switchToCard.bind(null, inv.id)}>
                    <button type="submit" className="adm-chip" title={manual ? "Issues a Stripe invoice instead of collecting it by hand" : "Closes the pay at close checkout and issues a Stripe invoice instead"}>Switch to card</button>
                  </form>
                )}
                {link && <a href={link.href} target="_blank" rel="noreferrer" className="adm-chip adm-chip--quiet">{link.label} ↗</a>}
              </div>

              {manual && !paid && !canceled && (
                <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>The client pays {how}. Nothing is issued at Stripe or Titus and no pay link goes out. When the payment arrives, mark it paid below; that unlocks downloads.</p>
              )}

              {canSetAmount && (
                <form action={setInvoiceAmount.bind(null, inv.id)} style={{ display: "grid", gap: 10, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                  <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 10 }}>
                    <div className="field"><label htmlFor="inv-amount">Total, in dollars</label><input id="inv-amount" name="amount" type="number" min={1} step={1} inputMode="numeric" defaultValue={inv.amountCents ? Math.round(inv.amountCents / 100) : ""} placeholder="2400" /></div>
                    <div className="field"><label htmlFor="inv-label">Label for the quoted line</label><input id="inv-label" name="label" placeholder="Quoted items" /></div>
                  </div>
                  <div className="field"><label htmlFor="inv-lines">Line items, optional (one per line: Name = 600)</label><textarea id="inv-lines" name="lines" rows={3} placeholder={"Photography = 900\nVirtual staging, 3 images = 150"} style={{ minHeight: 0 }} /></div>
                  <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                    {manual
                      ? "Moves the invoice to open at this amount. Nothing is issued and no email goes out: tell the client the amount when you follow up. Without line items the priced items stay and the difference becomes one quoted line."
                      : reissue
                        ? `Closes the current ${providerObject} (the client has not paid it), issues a new one at this amount and emails a fresh pay link. Without line items the priced items stay and the difference becomes one quoted line.`
                        : `Moves the invoice to open, issues the ${providerObject} and emails the pay link. Without line items the priced items stay and the difference becomes one quoted line.`}
                  </p>
                  <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>{manual ? "Set amount" : reissue ? "Set the new amount and reissue" : "Set amount and send the pay link"}</button>
                </form>
              )}

              {canMarkPaid && (
                <form action={markPaid.bind(null, inv.id)} style={{ display: "grid", gap: 10, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                  <div className="field" style={{ maxWidth: 560 }}><label htmlFor="inv-note">Mark paid, with a note</label><input id="inv-note" name="note" required placeholder="Check received Oct 20, deposited" /></div>
                  <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{manual ? "Records the payment with your name and unlocks downloads." : `Closes the open ${providerObject} so the client cannot pay twice, records the payment with your name and unlocks downloads.`} The payments channel hears; the client gets no email from this.</p>
                  <button type="submit" className="btn btn-ghost" style={{ justifySelf: "start" }}>Mark paid</button>
                </form>
              )}
            </div>
          )}

        </div>
      </div>

      {/* Additional shoots (Oct 27 2026): return trips, pickups, reshoots, twilights; each its own calendar event. */}
      <AdditionalShoots bookingId={b.id} visits={visitData.visits} ready={visitData.ready} canceled={canceled} bookingShooter={b.photographerEmail} bookingDate={b.desiredDate} suggestions={suggestions} today={localYmd()} clientEmail={b.client.email ?? null} invoices={visitInvoices} />

      {/* Edit booking (Oct 2026): services, add-ons, property, access, launch, client, details; the invoice follows. */}
      <EditBookingPanel b={b} />

      <div className="adm-section">
        <SectionHead title="The request" />
        <dl className="adm-kv adm-card">
          <div><dt>Services</dt><dd>{b.servicesLabel ?? <span className="muted">To confirm</span>}</dd></div>
          <div><dt>Add-ons</dt><dd className={b.addonsLabel ? "" : "muted"}>{b.addonsLabel ?? "None"}</dd></div>
          <div><dt>Square feet</dt><dd className="adm-mono">{b.sqft ? b.sqft.toLocaleString("en-US") : "Not given"}{b.tier != null && b.tier >= 0 ? <span className="muted" style={{ fontFamily: "var(--font-sans)" }}>{b.tier === 99 ? " · quoted by hand" : ` · tier ${b.tier}`}</span> : null}</dd></div>
          <div><dt>Payment</dt><dd><PaymentMethod m={b.paymentMethod} detail={b.paymentDetail} /></dd></div>
          {prop.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd style={{ overflowWrap: "anywhere" }}>{/^https?:\/\//.test(value) ? <a href={value} target="_blank" rel="noreferrer" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{value}</a> : value}</dd></div>
          ))}
          {b.customRequest && <div style={{ gridColumn: "1 / -1" }}><dt>Custom request</dt><dd style={{ whiteSpace: "pre-wrap" }}>{b.customRequest}</dd></div>}
          {b.accessNotes && <div style={{ gridColumn: "1 / -1" }}><dt>Access</dt><dd style={{ whiteSpace: "pre-wrap" }}>{b.accessNotes}</dd></div>}
          {b.clientNotes && <div style={{ gridColumn: "1 / -1" }}><dt>Additional details</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{b.clientNotes}</dd></div>}
          {bookingAttachments(b.raw, b.id).map((f) => (
            <div key={f.key} style={{ gridColumn: "1 / -1" }}>
              <dt>{f.kind === "plat" ? "Plat or lot map file" : "File from the client"}</dt>
              <dd><a href={`/api/studio/intake-file?booking=${encodeURIComponent(b.id)}&key=${encodeURIComponent(f.key)}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{f.name}</a></dd>
            </div>
          ))}
          <div><dt>Signed</dt><dd className={b.signedName ? "" : "muted"}>{b.signedName ?? "Not signed"}{b.signedAt ? <span className="muted"> · {fmtLa(b.signedAt)}</span> : null}</dd></div>
          <div><dt>Source</dt><dd className="muted">{b.source}{b.env ? ` · ${b.env}` : ""}</dd></div>
          {b.raw?.payload?.visit && typeof b.raw.payload.visit === "object" ? <div><dt>Came from</dt><dd className="muted">{visitLabel(b.raw.payload.visit as LeadVisit)}</dd></div> : null}
          {b.raw?.estimatedTotalLabel && <div><dt>Website total</dt><dd className="adm-mono">{b.raw.estimatedTotalLabel}</dd></div>}
          {submissionIds.length > 0 && <div style={{ gridColumn: "1 / -1" }}><dt>Submission{submissionIds.length === 1 ? "" : "s"}</dt><dd className="adm-mono faint" style={{ fontSize: 11, wordBreak: "break-all" }}>{submissionIds.join(" · ")}</dd></div>}
          {b.raw?.summary && <div style={{ gridColumn: "1 / -1" }}><dt>Website summary</dt><dd className="muted" style={{ whiteSpace: "pre-wrap", fontSize: 12.5 }}>{b.raw.summary}</dd></div>}
        </dl>
      </div>

      <ClientFile file={clientFile} clientId={b.client.id} clientName={b.client.name} />

      <div className="adm-section" id="jobs">
        <SectionHead title={`Side effects · ${jobs.length}`} />
        {jobs.length === 0 ? (
          <Empty>No jobs for this booking.</Empty>
        ) : (
          <div className="adm-table-wrap">
            <div className="adm-table-scroll">
              <table className="adm-table">
                <thead><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Runs</th><th>Last error</th><th></th></tr></thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id}>
                      <td className="adm-mono">{j.kind}</td>
                      <td><JobPill s={j.status} waiting={jobWaiting(j)} /></td>
                      <td className="adm-mono muted">{j.attempts} of {j.maxAttempts}</td>
                      <td className="adm-mono muted" style={{ whiteSpace: "nowrap" }}>{j.status === "done" ? `done ${fmtLa(j.doneAt)}` : `next ${fmtLa(j.runAt)}`}</td>
                      <td className="muted" style={{ fontSize: 12.5, maxWidth: 360 }}>{j.lastError ? (j.lastError.length > 140 ? `${j.lastError.slice(0, 140)}…` : j.lastError) : ""}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {(j.status === "queued" || j.status === "dead" || (j.status === "running" && new Date(j.runAt).getTime() < renderedAt - 5 * 60_000)) && (
                          <form action={runJob.bind(null, j.id, b.id)} style={{ display: "inline" }}>
                            <button type="submit" className="adm-chip adm-chip--quiet">{j.status === "dead" ? "Run again" : "Run now"}</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="adm-section">
        <SectionHead title="History" />
        <ActivityFeed rows={activity} showWhere={false} />
      </div>
    </section>
  );
}
