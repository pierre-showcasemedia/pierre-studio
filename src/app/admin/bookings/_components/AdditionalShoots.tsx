// "Additional shoots" on the booking page (Oct 27 2026, src/lib/booking-visits.ts):
// every return trip, pickup, reshoot or twilight on this booking, each with
// Edit, Mark done and Cancel, and the "Add second shoot" button that opens
// the form inline. Each one is its own event on the hello@ calendar with its
// own shooter invited. Server component; the forms post to visit-actions.ts.
// Oct 27 2026: a visit has no invoice unless "Create new invoice?" is ticked
// on the add form (or Create invoice is used on its row later); then its row
// shows that invoice (amount, status, the Stripe link, Resend pay link), and
// Cancel asks first, saying what happens to it.
import { PayPill, SectionHead, fmtMoney } from "@/components/admin/bits";
import type { AdminBookingInvoice } from "@/lib/admin-types";
import { fmtLa, fmtTime12 } from "@/lib/booking-time";
import { DEFAULT_VISIT_MINUTES, minutesLabel, VISIT_DURATIONS, VISIT_KIND_OPTIONS, VISIT_START_TIMES, type AdminVisit } from "@/lib/booking-visits";
import { resendPayLink } from "../../actions";
import { addVisit, cancelVisit, createVisitInvoiceForVisit, markVisitDone, updateVisit } from "../../visit-actions";
import { ConfirmSubmit, VisitInvoiceFields } from "./VisitInvoiceFields";
import { TZ_SHORT } from "@/lib/business";

const PAID = ["paid", "paid_manual"];
const CLOSED = ["void", "canceled"];

// What Cancel's confirmation says, by the state of the visit's invoice.
function cancelMessage(v: AdminVisit, inv: AdminBookingInvoice | null): string {
  const head = `Cancel the ${v.kindLabel.toLowerCase()} on ${v.whenLabel}? Its calendar event is deleted and Google tells the shooter.`;
  if (!inv || CLOSED.includes(inv.status) || inv.status === "refunded") return `${head} The client is not emailed.`;
  const amt = fmtMoney(inv.amountCents);
  if (PAID.includes(inv.status)) return `${head} Its invoice${amt ? ` (${amt})` : ""} is paid and stays as it is; refund it in Stripe if the client should get the money back.`;
  if (inv.status === "processing" || inv.status === "review") return `${head} A payment on its invoice${amt ? ` (${amt})` : ""} is in progress, so the invoice is left alone.`;
  return `${head} Its open invoice${amt ? ` (${amt})` : ""} is voided, so the client can no longer pay it.`;
}

// The visit's own invoice on its row.
function VisitInvoice({ inv }: { inv: AdminBookingInvoice }) {
  const open = inv.status === "open";
  return (
    <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
        <span className="kicker" style={{ margin: 0 }}>Invoice</span>
        <PayPill status={inv.status} amountCents={inv.amountCents} />
        <span className="muted" style={{ fontSize: 12.5 }}>card via stripe</span>
        <span style={{ flex: 1 }} />
        {open && inv.hostedUrl && (
          <form action={resendPayLink.bind(null, inv.id)}>
            <button type="submit" className="adm-chip">Resend pay link</button>
          </form>
        )}
        {inv.hostedUrl ? (
          <a href={inv.hostedUrl} target="_blank" rel="noreferrer" className="adm-chip adm-chip--quiet">Open in Stripe ↗</a>
        ) : open ? (
          <span className="muted" style={{ fontSize: 12.5 }}>Being issued at Stripe</span>
        ) : null}
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {inv.lineItems.map((l) => `${l.name} ${fmtMoney(l.cents) ?? ""}`).join(" · ") || inv.description}
        {inv.paidAt ? ` · paid ${fmtLa(inv.paidAt)}` : ""}
      </div>
    </div>
  );
}

const STATUS_PILL: Record<AdminVisit["status"], { label: string; bg: string; fg: string }> = {
  scheduled: { label: "Scheduled", bg: "rgba(0,102,214,.10)", fg: "#0066D6" },
  done: { label: "Done", bg: "rgba(26,127,75,.10)", fg: "#1A7F4B" },
  canceled: { label: "Canceled", bg: "rgba(95,100,110,.10)", fg: "#5F646E" },
};

function calendarLine(v: AdminVisit): string {
  if (v.status === "canceled") return v.calendarEventId ? "Removed from the hello@ calendar" : "Never on the calendar";
  if (v.calendarEventId) return `On the hello@ calendar${v.calendarSyncedAt ? ` · synced ${fmtLa(v.calendarSyncedAt)}` : ""}`;
  return "Not on the calendar yet";
}

type Defaults = { date: string; time: string; minutes: number; email: string; kind: string; note: string };

// The fields both forms share. `id` keeps the labels unique on the page.
// A time or length moved in Google Calendar may sit off the lists; it stays
// selectable so saving another field never changes it by accident.
function VisitFields({ id, d }: { id: string; d: Defaults }) {
  const times = VISIT_START_TIMES.includes(d.time) ? VISIT_START_TIMES : [...VISIT_START_TIMES, d.time].sort();
  const lengths = VISIT_DURATIONS.some(([m]) => m === d.minutes) ? VISIT_DURATIONS : [...VISIT_DURATIONS, [d.minutes, minutesLabel(d.minutes)] as [number, string]].sort((a, b) => a[0] - b[0]);
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 10 }}>
        <div className="field"><label htmlFor={`${id}-date`}>Date</label><input id={`${id}-date`} name="date" type="date" required defaultValue={d.date} /></div>
        <div className="field">
          <label htmlFor={`${id}-time`}>Start, {TZ_SHORT}</label>
          <select id={`${id}-time`} name="time" required defaultValue={d.time}>
            {times.map((t) => <option key={t} value={t}>{fmtTime12(t)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-minutes`}>How long</label>
          <select id={`${id}-minutes`} name="minutes" required defaultValue={String(d.minutes)}>
            {lengths.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-kind`}>What it is</label>
          <select id={`${id}-kind`} name="kind" required defaultValue={d.kind}>
            {VISIT_KIND_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-email`}>Shooter email</label>
        <input id={`${id}-email`} name="email" type="email" list="bk-visit-shooters" autoComplete="off" defaultValue={d.email} placeholder="shooter@example.com" />
      </div>
      <div className="field">
        <label htmlFor={`${id}-note`}>Note for the shooter, optional</label>
        <textarea id={`${id}-note`} name="note" rows={2} maxLength={1000} defaultValue={d.note} placeholder="Kitchen and primary bath after the stagers finish" style={{ minHeight: 0 }} />
      </div>
    </>
  );
}

export function AdditionalShoots({ bookingId, visits, ready, canceled, bookingShooter, bookingDate, suggestions, today, clientEmail, invoices }: {
  bookingId: string;
  visits: AdminVisit[];
  ready: boolean;
  canceled: boolean;
  bookingShooter: string | null;
  bookingDate: string | null;
  suggestions: string[];
  today: string;
  clientEmail: string | null;
  invoices: AdminBookingInvoice[]; // the visits' own invoices (src/lib/visit-invoice.ts)
}) {
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const live = visits.filter((v) => v.status === "scheduled").length;
  const addDefaults: Defaults = {
    date: bookingDate && bookingDate >= today ? bookingDate : "",
    time: "10:00",
    minutes: DEFAULT_VISIT_MINUTES,
    email: bookingShooter ?? "",
    kind: "return_trip",
    note: "",
  };
  return (
    <div className="adm-section" id="visits">
      <SectionHead title={`Additional shoots${visits.length ? ` · ${live} scheduled` : ""}`} />
      <datalist id="bk-visit-shooters">
        {suggestions.map((e) => <option key={e} value={e} />)}
      </datalist>
      {!ready && (
        <p className="adm-banner adm-banner--warn" style={{ marginTop: 0 }}>Additional shoots are waiting for the database update (the migrate route). Until it runs, nothing can be added here.</p>
      )}
      <div style={{ display: "grid", gap: 14 }}>
        {visits.map((v) => {
          const pill = STATUS_PILL[v.status];
          const open = v.status === "scheduled" && !canceled;
          const inv = v.invoiceId ? invoiceById.get(v.invoiceId) ?? null : null;
          // A visit that is not canceled may get an invoice when it has none (or its last one was voided).
          const canInvoice = !canceled && v.status !== "canceled" && (!inv || CLOSED.includes(inv.status));
          return (
            <div key={v.id} className="adm-card" style={{ display: "grid", gap: 12 }}>
              <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                <div className="kicker" style={{ margin: 0 }}>{v.kindLabel}</div>
                <span className="adm-pill" style={{ background: pill.bg, color: pill.fg }}>{pill.label}</span>
                <span style={{ flex: 1 }} />
                {open && (
                  <>
                    <form action={markVisitDone.bind(null, v.id, bookingId)}>
                      <button type="submit" className="adm-chip">Mark done</button>
                    </form>
                    <form action={cancelVisit.bind(null, v.id, bookingId)}>
                      <ConfirmSubmit label="Cancel" className="adm-chip adm-chip--quiet" message={cancelMessage(v, inv)} />
                    </form>
                  </>
                )}
              </div>
              <dl className="adm-kv" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
                <div><dt>When, {TZ_SHORT}</dt><dd>{v.whenLabel}</dd></div>
                <div><dt>How long</dt><dd>{minutesLabel(v.minutes)}</dd></div>
                <div><dt>Shooter</dt><dd className={v.photographerEmail ? "" : "muted"} style={{ overflowWrap: "anywhere" }}>{v.photographerEmail ?? "Unassigned"}</dd></div>
                <div><dt>Calendar</dt><dd className={v.calendarEventId && v.status !== "canceled" ? "" : "muted"}>{calendarLine(v)}<span className="faint adm-mono" style={{ marginLeft: 8, fontSize: 11 }}>v{v.calendarVersion}</span></dd></div>
                {v.note && <div style={{ gridColumn: "1 / -1" }}><dt>Note</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{v.note}</dd></div>}
                <div style={{ gridColumn: "1 / -1" }}><dt>Added</dt><dd className="muted" style={{ fontSize: 12.5 }}>{fmtLa(v.createdAt)}{v.createdBy ? ` by ${v.createdBy}` : ""}</dd></div>
              </dl>
              {inv && <VisitInvoice inv={inv} />}
              {!inv && v.invoiceId && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Its invoice could not be read here.</p>}
              {canInvoice && (
                <details className="bk-edit" style={{ border: "1px solid var(--line)", borderRadius: 12 }}>
                  <summary className="bk-edit__summary"><span>{inv ? "Create a new invoice for this shoot (the last one was voided)." : "Create invoice: bill the client for this shoot on its own."}</span></summary>
                  <form action={createVisitInvoiceForVisit.bind(null, v.id, bookingId)} className="bk-edit__form">
                    <VisitInvoiceFields clientEmail={clientEmail} optional={false} />
                    <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Create invoice and email the pay link</button>
                  </form>
                </details>
              )}
              {open && (
                <details className="bk-edit" style={{ border: "1px solid var(--line)", borderRadius: 12 }}>
                  <summary className="bk-edit__summary"><span>Edit the date, time, length, shooter, kind or note.</span></summary>
                  <form action={updateVisit.bind(null, v.id, bookingId)} className="bk-edit__form">
                    <VisitFields id={`bk-visit-${v.id.slice(0, 8)}`} d={{ date: v.desiredDate, time: v.startTime, minutes: v.minutes, email: v.photographerEmail ?? "", kind: v.kind, note: v.note ?? "" }} />
                    <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Moves the event on the hello@ calendar. Google sends the shooter the new time, and a replaced shooter is taken off. A new time or shooter is posted to the bookings channel. The client is not emailed.</p>
                    <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Save changes</button>
                  </form>
                </details>
              )}
            </div>
          );
        })}

        {canceled ? (
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>This booking is canceled. Restore it to add a second shoot.</p>
        ) : ready ? (
          <details className="adm-card bk-edit bk-visit-add">
            <summary className="bk-visit-add__summary">
              <span className="btn btn-primary">Add second shoot</span>
              <span className="muted" style={{ fontSize: 12.5 }}>A return trip, pickup shots, a reshoot or a twilight, on its own date.</span>
            </summary>
            <form action={addVisit.bind(null, bookingId)} className="bk-edit__form">
              <VisitFields id="bk-visit-new" d={addDefaults} />
              <VisitInvoiceFields clientEmail={clientEmail} />
              <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Puts the shoot on the hello@ calendar as its own event, tied to this booking. Google emails the shooter the invite, the shooter gets the shoot brief 30 minutes before, and the bookings channel hears. The booking&apos;s own time and invoice stay as they are. The client is emailed only when Create new invoice is ticked, and then only the new invoice&apos;s pay link.</p>
              <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Add to the calendar</button>
            </form>
          </details>
        ) : null}
      </div>
    </div>
  );
}
