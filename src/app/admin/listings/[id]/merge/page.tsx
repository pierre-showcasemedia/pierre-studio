// Merge this listing into another (Oct 30 2026; src/lib/merge-listing.ts).
// Step 1: pick the listing to keep (search by address, slug or client).
// Step 2: the dry run, read from the database as it is now: the rows that
// move per table, both clients, what is copied onto the target and what a
// person should know (the calendar retitle and the shooter's update email,
// the invoice that will unlock the target, the old portal link). Nothing
// changes until Merge is pressed on THIS page with MERGE typed. Admins only.
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasDb } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { adminListings } from "@/lib/admin-data";
import { COUNT_LABELS, mergeListing, type MergeCounts, type MergeSide } from "@/lib/merge-listing";
import { listingPick } from "@/lib/pick-options";
import { fmtDay } from "@/lib/shoot-status";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { mergeListingInto } from "../../../crud-actions";

export const dynamic = "force-dynamic";

const FIELD_LABEL: Record<string, string> = { city: "City", state: "State", zip: "Zip", notes: "Notes", links: "Links", coverKey: "Cover photo" };

function SideCard({ kicker, s, tone }: { kicker: string; s: MergeSide; tone?: "from" | "into" }) {
  return (
    <div className="adm-card" style={{ borderRadius: 14, display: "grid", gap: 6, alignContent: "start", ...(tone === "from" ? { borderColor: "rgba(215,52,42,.35)" } : {}) }}>
      <div className="kicker">{kicker}</div>
      <div style={{ fontSize: 17, fontWeight: 600 }}>{s.street}</div>
      <div className="muted" style={{ fontSize: 13.5 }}>{s.address.split(",").slice(1).join(",").trim() || "No city yet"}</div>
      <div style={{ fontSize: 13.5 }}>
        Client: {s.clientName ? `${s.clientName} · ` : ""}{s.clientEmail ?? "unknown"}{s.clientTeam ? <span className="muted"> · team {s.clientTeam}</span> : null}
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>
        slug <code className="adm-mono">{s.slug}</code> · {s.downloadLocked ? "downloads locked" : "downloads unlocked"}
        {s.shootDate ? ` · shoot ${fmtDay(s.shootDate)}` : ""}
        {s.nda ? " · NDA" : ""}
      </div>
    </div>
  );
}

export default async function MergeListingPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ into?: string; error?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const listings = await adminListings({ sort: "client" });
  const self = listings.find((l) => l.id === id);
  if (!self) notFound();
  const street = self.address.split(",")[0];
  const into = sp.into && sp.into !== id ? sp.into : "";
  const options = listings
    .filter((l) => l.id !== id)
    .map((l) => {
      const o = listingPick(l);
      return { ...o, keywords: [o.keywords, l.slug].filter(Boolean).join(" ") };
    });
  const plan = into && hasDb() ? await mergeListing({ fromListingId: id, intoListingId: into, apply: false }) : null;
  const clientsDiffer = Boolean(plan?.from && plan?.into && !plan.sameClient);
  // Refusals a person can lift here: only "different clients" (the checkbox).
  const hardRefusals = plan ? plan.refused.filter((r) => !(clientsDiffer && r.startsWith("The two listings belong to different clients"))) : [];
  const rows = plan?.counts ? (Object.keys(COUNT_LABELS) as (keyof MergeCounts)[]).map((k) => ({ k, n: plan.counts![k], ...COUNT_LABELS[k] })) : [];
  const moving = rows.filter((r) => r.n > 0);

  return (
    <section className="wrap adm-page">
      <Link href={`/admin/listings/${id}`} className="adm-link muted" style={{ fontSize: 12.5 }}>← Back to {street} (nothing has changed)</Link>
      <div className="adm-head" style={{ marginTop: 14 }}>
        <div>
          <div className="kicker" style={{ marginBottom: 10 }}>Merge listing</div>
          <h1 className="adm-title">Merge {street} into another listing</h1>
          <p className="adm-lede">
            Everything on {street} moves to the listing you pick: bookings, invoices, photos, shoots, revisions and history. Then {street} is deleted. Use it when the same property ended up as two listings.
          </p>
        </div>
      </div>

      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}

      <form method="get" className="adm-card" style={{ marginTop: 22, borderRadius: 14, display: "grid", gap: 10, maxWidth: 640 }}>
        <label htmlFor="merge-into" className="kicker">Listing to keep</label>
        <SearchSelect
          id="merge-into"
          name="into"
          defaultValue={into}
          options={options}
          placeholder="Choose the listing to keep"
          title="Merge into"
          searchPlaceholder="Search address, slug or client"
          required
          submitOnPick
        />
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Picking one shows a preview. Nothing changes yet.</p>
      </form>

      {into && !hasDb() && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>Demo mode: the preview needs the database, and nothing is saved.</p>}

      {plan && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 16, marginTop: 26 }}>
            {plan.from && <SideCard kicker="Merging (will be deleted)" s={plan.from} tone="from" />}
            {plan.into && <SideCard kicker="Into (kept)" s={plan.into} tone="into" />}
          </div>
          {clientsDiffer && (
            <p className="adm-banner adm-banner--warn" style={{ marginTop: 16 }}>
              These listings belong to different clients: {plan.from!.clientEmail} and {plan.into!.clientEmail}. Merge only if it is the same property for the same people.
            </p>
          )}
          {hardRefusals.map((r) => (
            <p key={r} className="adm-banner adm-banner--bad" style={{ marginTop: 16 }}>{r}</p>
          ))}

          {plan.counts && (
            <div className="lsn-block" style={{ marginTop: 28 }}>
              <div className="adm-section-head"><div className="kicker">What moves · preview</div></div>
              {moving.length === 0 ? (
                <p className="muted" style={{ fontSize: 13.5 }}>Nothing points at {plan.from?.street} except the listing itself. Merging just deletes it.</p>
              ) : (
                <div className="adm-table-wrap">
                  <div className="adm-table-scroll">
                    <table className="adm-table adm-table--stack">
                      <tbody>
                        {moving.map((r) => (
                          <tr key={r.k}>
                            <td className="adm-mono" style={{ whiteSpace: "nowrap" }}>{r.table}</td>
                            <td className="adm-mono" style={{ textAlign: "right" }}>{r.n}</td>
                            <td className="muted" style={{ fontSize: 13 }}>{r.what}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <p className="faint" style={{ margin: "10px 0 0", fontSize: 12 }}>
                Nothing on: {rows.filter((r) => r.n === 0).map((r) => r.table).join(", ") || "none"}.
              </p>
            </div>
          )}

          {plan.bookings.length > 0 && (
            <div className="lsn-block" style={{ marginTop: 24 }}>
              <div className="adm-section-head"><div className="kicker">Bookings</div></div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>
                {plan.bookings.map((b) => (
                  <li key={b.id}>
                    <Link href={`/admin/bookings/${b.id}`} className="adm-link adm-mono">{b.id.slice(0, 8)}</Link> · {b.status === "requested" ? "Unconfirmed" : b.status}
                    {" · street "}<span className="adm-mono">{b.street ?? "none"}</span> → <span className="adm-mono">{plan.into?.street}</span>
                    {b.retitle ? " · calendar event retitled" : " · no calendar update"}
                    {b.shooter ? ` · shooter ${b.shooter}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.invoices.length > 0 && (
            <div className="lsn-block" style={{ marginTop: 24 }}>
              <div className="adm-section-head"><div className="kicker">Invoices</div></div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>
                {plan.invoices.map((i) => (
                  <li key={i.id}>
                    <span className="adm-mono">{i.id.slice(0, 8)}</span> · {i.status.replace("_", " ")}{i.provider ? ` · ${i.provider}` : ""}
                    {" · address → "}<span className="adm-mono">{plan.into?.address}</span>
                    {i.gates ? "" : " · does not move the lock"}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.fields.length > 0 && (
            <div className="lsn-block" style={{ marginTop: 24 }}>
              <div className="adm-section-head"><div className="kicker">Copied onto {plan.into?.street} (it has none)</div></div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>
                {plan.fields.map((f) => (
                  <li key={f.field}>{FIELD_LABEL[f.field] ?? f.field}: <span className="adm-mono" style={{ wordBreak: "break-word" }}>{f.value.length > 120 ? `${f.value.slice(0, 120)}…` : f.value}</span></li>
                ))}
              </ul>
            </div>
          )}

          {plan.notices.length > 0 && (
            <div className="lsn-block" style={{ marginTop: 24 }}>
              <div className="adm-section-head"><div className="kicker">Good to know</div></div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>
                {plan.notices.map((n) => <li key={n}>{n}</li>)}
              </ul>
              <p className="muted" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
                {plan.into?.street} keeps its own shoot date, lock and delivery state. Nothing is sent to the client and nothing changes in Stripe.
              </p>
            </div>
          )}

          {plan.from && plan.into && hardRefusals.length === 0 && (
            <form action={mergeListingInto.bind(null, plan.from.id, plan.into.id)} className="adm-card" style={{ marginTop: 28, display: "grid", gap: 12, borderColor: "rgba(215,52,42,.35)", borderRadius: 14, maxWidth: 640 }}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                Merge {plan.from.street} into {plan.into.street}. This runs as one step and cannot be undone from here; {plan.from.street} is deleted.
              </p>
              {clientsDiffer && (
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13.5 }}>
                  <input type="checkbox" name="allowDifferentClient" value="1" required style={{ marginTop: 3 }} />
                  <span>I checked: different clients, same property. Merge anyway.</span>
                </label>
              )}
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="merge-reason">Reason (for the activity log, optional)</label>
                <input id="merge-reason" name="reason" placeholder="Typo in the address on the booking form" autoComplete="off" style={{ padding: "10px 14px", fontSize: 14 }} />
              </div>
              <div className="adm-actions" style={{ alignItems: "center" }}>
                <div className="field" style={{ margin: 0, flex: "0 1 220px" }}>
                  <input name="confirm" placeholder="Type MERGE" required autoComplete="off" aria-label="Type MERGE to confirm" style={{ padding: "10px 14px", fontSize: 14 }} />
                </div>
                <button type="submit" className="adm-chip adm-chip--danger">Merge into {plan.into.street}</button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
