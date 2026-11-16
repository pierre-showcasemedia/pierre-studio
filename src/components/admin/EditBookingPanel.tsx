// Edit booking (Oct 21 2026): one form on /admin/bookings/<id> for everything
// about the request except the date and time (those stay with Confirm time /
// Reschedule): services and add-ons, the custom request, square footage, the
// property fields, access notes, the launch date, the client's name, phone and
// company, and the additional details. Saving follows the invoice rules in
// src/lib/booking-edit.ts and says in the banner what happened to the
// invoice and the client's email. Below the form: the add-on invoices the
// edits created (the items added after the booking's invoice was paid), each
// with the same controls the main invoice has. Full admins only: the page
// gates with requireAdmin, and the action checks again.
import { editBooking } from "@/app/admin/booking-edit-actions";
import { markPaid, resendPayLink, setInvoiceAmount } from "@/app/admin/actions";
import { PayPill, fmtMoney } from "@/components/admin/bits";
import type { AdminBookingDetail } from "@/lib/admin-types";
import { ADDONS, SERVICES, SIZES } from "@/lib/studio-pricing";
import { fmtLa } from "@/lib/booking-time";
import { addonInvoicesFor } from "@/lib/booking-edit";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const yn = (v: unknown): "" | "Yes" | "No" => (/^yes$/i.test(str(v)) ? "Yes" : /^no$/i.test(str(v)) ? "No" : "");
const viewsOf = (v: unknown): string => (Array.isArray(v) ? v.map(String).filter(Boolean).join(", ") : str(v));

function YesNo({ id, name, label, value }: { id: string; name: string; label: string; value: "" | "Yes" | "No" }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} defaultValue={value}>
        <option value="">Not answered</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    </div>
  );
}

export async function EditBookingPanel({ b }: { b: AdminBookingDetail }) {
  const p = b.property ?? {};
  const canceled = b.status === "canceled";
  const services = new Set(b.serviceIds);
  const addons = new Set(b.addonIds);
  const size = b.serviceIds.find((id) => SIZES.some((s) => s.id === id)) ?? "";
  const qty = (id: string): number => b.items.find((i) => i.id === id)?.qty ?? 1;
  const extra = await addonInvoicesFor(b.id, b.invoice?.id ?? null);
  const paid = Boolean(b.invoice && ["paid", "paid_manual"].includes(b.invoice.status));
  const inFlight = Boolean(b.invoice && ["processing", "review"].includes(b.invoice.status));
  const rule = !b.invoice
    ? "There is no invoice on this booking, so a change to the services only updates the record."
    : paid || inFlight
      ? `The invoice is ${paid ? "paid" : "being paid"}, so it stays as it is: items added here go on a new invoice for the difference only, with its own pay link; items removed are refunded by hand.`
      : b.invoice.status === "needs_quote"
        ? "The invoice is waiting for a quote: a change to the services updates its items, and Set amount still issues it."
        : "The invoice is not paid yet: a change to the services or add-ons reissues it at the new amount (the previous one is voided) and the client gets the updated booking email with the new pay link.";

  return (
    <div className="adm-section" id="edit">
      <div className="adm-section-head"><div className="kicker">Edit booking</div></div>
      <details className="adm-card bk-edit">
        <summary className="bk-edit__summary">
          <span>Edit services, add-ons, property details, access, launch date, the client&apos;s contact and the additional details.</span>
          <span className="muted" style={{ fontSize: 12.5 }}>Date and time stay with Confirm time above.</span>
        </summary>
        <form action={editBooking.bind(null, b.id)} className="bk-edit__form">
          <div className="field">
            <label htmlFor="bk-edit-size">Size of the home</label>
            <select id="bk-edit-size" name="size" defaultValue={size}>
              <option value="">Not given</option>
              {SIZES.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.quoted ? " (quoted)" : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="bk-edit__label">Services</div>
            <div className="bk-edit__checks">
              {SERVICES.map((s) => (
                <label key={s.id} className="bk-edit__check">
                  <input type="checkbox" name="services" value={s.id} defaultChecked={services.has(s.id)} />
                  {s.name}{s.quoted ? <span className="muted"> (quoted)</span> : null}
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="bk-edit__label">Add-ons</div>
            <div className="bk-edit__checks">
              {ADDONS.map((a) => (
                <label key={a.id} className="bk-edit__check">
                  <input type="checkbox" name="addons" value={a.id} defaultChecked={addons.has(a.id)} />
                  {a.name}{a.quoted ? <span className="muted"> (quoted)</span> : null}
                  {a.counted ? (
                    <input type="number" name={`qty_${a.id}`} min={1} max={a.counted.max} step={1} defaultValue={qty(a.id)} aria-label={`${a.name}, number of ${a.counted.units}`} style={{ width: 64, marginLeft: 8 }} />
                  ) : null}
                </label>
              ))}
            </div>
          </div>
          <div className="field"><label htmlFor="bk-edit-custom">Custom request</label><textarea id="bk-edit-custom" name="customRequest" rows={2} defaultValue={b.customRequest ?? ""} placeholder="What they asked for in their own words, when Something else is chosen" style={{ minHeight: 0 }} /></div>

          <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 10 }}>
            <div className="field"><label htmlFor="bk-edit-sqft">Square feet</label><input id="bk-edit-sqft" name="sqft" type="number" min={0} step={1} inputMode="numeric" defaultValue={b.sqft ?? ""} placeholder="2400" /></div>
            <div className="field"><label htmlFor="bk-edit-launch">Launch date</label><input id="bk-edit-launch" name="launchDate" type="date" defaultValue={b.launchDate ?? ""} /></div>
          </div>

          <div className="bk-edit__label">Property</div>
          <div className="grid grid-cols-1 sm:grid-cols-3" style={{ gap: 10 }}>
            <div className="field">
              <label htmlFor="bk-edit-status">Property status</label>
              <input id="bk-edit-status" name="pStatus" list="bk-edit-status-list" defaultValue={str(p.status)} placeholder="Vacant / Staged" autoComplete="off" />
              <datalist id="bk-edit-status-list"><option value="Vacant / Staged" /><option value="Vacant" /><option value="Occupied" /></datalist>
            </div>
            <div className="field">
              <label htmlFor="bk-edit-type">Listing type</label>
              <input id="bk-edit-type" name="pListingType" list="bk-edit-type-list" defaultValue={str(p.listingType)} placeholder="For Sale" autoComplete="off" />
              <datalist id="bk-edit-type-list"><option value="For Sale" /><option value="For Lease" /><option value="Short-Term Rental" /></datalist>
            </div>
            <YesNo id="bk-edit-offmarket" name="pOffMarket" label="Off market" value={yn(p.offMarket)} />
            <YesNo id="bk-edit-agreement" name="pListingAgreement" label="Listing agreement" value={yn(p.listingAgreement)} />
            <YesNo id="bk-edit-viewhome" name="pViewHome" label="View home" value={yn(p.viewHome)} />
            <div className="field"><label htmlFor="bk-edit-views">Views (comma separated)</label><input id="bk-edit-views" name="views" defaultValue={viewsOf(p.views)} placeholder="Ocean, Mountain" /></div>
            <YesNo id="bk-edit-homeowner" name="pHomeownerHome" label="Homeowner home" value={yn(p.homeownerHome)} />
            <div className="field">
              <label htmlFor="bk-edit-video">Video style</label>
              <input id="bk-edit-video" name="pVideoStyle" list="bk-edit-video-list" defaultValue={str(p.videoStyle)} placeholder="Medium" autoComplete="off" />
              <datalist id="bk-edit-video-list"><option value="Slow" /><option value="Medium" /><option value="Fast" /></datalist>
            </div>
            <div className="field"><label htmlFor="bk-edit-music">Music link</label><input id="bk-edit-music" name="pMusicLink" type="url" defaultValue={str(p.musicLink)} placeholder="https://" /></div>
          </div>

          <div className="field"><label htmlFor="bk-edit-access">Access notes</label><textarea id="bk-edit-access" name="accessNotes" rows={2} defaultValue={b.accessNotes ?? ""} placeholder="Lockbox on the side gate, code with the agent." style={{ minHeight: 0 }} /></div>

          <div className="bk-edit__label">Client</div>
          <div className="grid grid-cols-1 sm:grid-cols-3" style={{ gap: 10 }}>
            <div className="field"><label htmlFor="bk-edit-cname">Name</label><input id="bk-edit-cname" name="clientName" defaultValue={b.client.name ?? ""} placeholder="Sam Example" /></div>
            <div className="field"><label htmlFor="bk-edit-cphone">Phone</label><input id="bk-edit-cphone" name="clientPhone" type="tel" defaultValue={b.client.phone ?? ""} placeholder="(555) 010-0100" /></div>
            <div className="field"><label htmlFor="bk-edit-ccompany">Company</label><input id="bk-edit-ccompany" name="clientCompany" defaultValue={b.client.company ?? ""} placeholder="Brokerage" /></div>
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>The client&apos;s email stays {b.client.email}; change it from the client page.</p>

          <div className="field"><label htmlFor="bk-edit-notes">Additional details (the client&apos;s own notes)</label><textarea id="bk-edit-notes" name="clientNotes" rows={3} defaultValue={b.clientNotes ?? ""} placeholder="Shots, rooms or features to capture, anything to avoid" style={{ minHeight: 0 }} /></div>

          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            {rule} Every save updates the event on the hello@ calendar (the title follows the services) and posts Booking updated to the bookings channel. Changes that do not touch the price never email the client.
          </p>
          <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }} disabled={canceled}>Save changes</button>
        </form>
      </details>

      {extra.length > 0 && (
        <div className="adm-card" style={{ marginTop: 14, display: "grid", gap: 14 }}>
          <div className="kicker">Invoices from edits · {extra.length}</div>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Items added after the booking&apos;s invoice was paid. Each is its own invoice with its own pay link; none of them locks or unlocks the gallery.</p>
          {extra.map((inv) => {
            const open = inv.status === "open";
            const settled = ["paid", "paid_manual"].includes(inv.status);
            const manual = inv.method === "other" && !inv.provider;
            const canSetAmount = !canceled && (inv.status === "needs_quote" || inv.status === "open");
            const canMarkPaid = !canceled && ["needs_quote", "open", "processing", "review", "uncollectible"].includes(inv.status);
            return (
              <div key={inv.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 14, display: "grid", gap: 10 }}>
                <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
                  <PayPill status={inv.status} amountCents={inv.amountCents} />
                  <span className="muted" style={{ fontSize: 12.5 }}>{inv.lineItems.map((l) => l.name).join(", ") || inv.description}</span>
                  {inv.provider && <span className="muted" style={{ fontSize: 12.5 }}>via {inv.provider}</span>}
                  {inv.createdAt && <span className="faint" style={{ fontSize: 12 }}>added {fmtLa(inv.createdAt)}</span>}
                  <span style={{ flex: 1 }} />
                  {open && !manual && inv.hostedUrl && (
                    <form action={resendPayLink.bind(null, inv.id)}>
                      <button type="submit" className="adm-chip">Resend pay link</button>
                    </form>
                  )}
                  {inv.hostedUrl && <a href={inv.hostedUrl} target="_blank" rel="noreferrer" className="adm-chip adm-chip--quiet">{inv.provider === "stripe" ? "Open in Stripe" : "Open with the provider"} ↗</a>}
                </div>
                {settled && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Paid{inv.paidAt ? ` ${fmtLa(inv.paidAt)}` : ""}.</p>}
                {canSetAmount && (
                  <form action={setInvoiceAmount.bind(null, inv.id)} className="flex flex-wrap items-end" style={{ gap: 10 }}>
                    <div className="field" style={{ width: 160 }}><label htmlFor={`bk-addon-amount-${inv.id}`}>Total, in dollars</label><input id={`bk-addon-amount-${inv.id}`} name="amount" type="number" min={1} step={1} inputMode="numeric" defaultValue={inv.amountCents ? Math.round(inv.amountCents / 100) : ""} /></div>
                    <input type="hidden" name="label" value="Added items" />
                    <button type="submit" className="adm-chip">{inv.status === "needs_quote" ? "Set amount and send the pay link" : "Set the new amount and reissue"}</button>
                  </form>
                )}
                {canMarkPaid && (
                  <form action={markPaid.bind(null, inv.id)} className="flex flex-wrap items-end" style={{ gap: 10 }}>
                    <div className="field" style={{ width: 320, maxWidth: "100%" }}><label htmlFor={`bk-addon-note-${inv.id}`}>Mark paid, with a note</label><input id={`bk-addon-note-${inv.id}`} name="note" required placeholder="Paid in cash at the shoot" /></div>
                    <button type="submit" className="adm-chip adm-chip--quiet">Mark paid</button>
                  </form>
                )}
                {inv.amountCents != null && <span className="adm-mono muted" style={{ fontSize: 12 }}>{fmtMoney(inv.amountCents)}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
