// Delivery email preview + confirm. Nothing sends until the button on THIS
// page is pressed; the preview below is the exact HTML that will be sent
// (both come from buildDeliveryEmail). Subject, headline, and body are
// editable — "Update Preview" re-renders with your text before you send.
import Link from "next/link";
import { notFound } from "next/navigation";
import { buildDeliveryEmail } from "@/lib/delivery-send";
import { adminListingDetail } from "@/lib/admin-data";
import { sendDeliveryEmail } from "../../../actions";
import { requireAdmin } from "@/lib/admin";
import { TeamCcPicker } from "@/components/admin/TeamCcPicker";

export const dynamic = "force-dynamic";

export default async function DeliveryEmailPreview({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ subject?: string; headline?: string; body?: string; cc?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const data = await adminListingDetail(id);
  if (!data) notFound();
  const { listing } = data;
  const built = await buildDeliveryEmail(id, { subject: sp.subject, headline: sp.headline, body: sp.body });

  const label: React.CSSProperties = { fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", marginRight: 10 };

  return (
    <section className="wrap" style={{ paddingTop: 40, paddingBottom: 90 }}>
      <Link href={`/admin/listings/${id}`} className="faint" style={{ fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase" }}>
        ← Back (nothing has been sent)
      </Link>
      <h1 className="h2" style={{ marginTop: 16 }}>Delivery email: {listing.address.split(",")[0]}</h1>

      {!built.ok ? (
        <p style={{ marginTop: 18, fontSize: 14, padding: "12px 16px", background: "rgba(215,52,42,.08)", color: "var(--color-live)" }}>
          {built.error}
        </p>
      ) : (
        <>
          <div style={{ marginTop: 18, fontSize: 14, lineHeight: 2 }}>
            <div><span className="faint" style={label}>To</span> {built.to}</div>
            <div><span className="faint" style={label}>Cc</span> {built.cc.length ? `${built.cc.join(", ")} (always)` : "none"}{built.team?.members.length ? <span className="faint">, plus the team members ticked below</span> : null}</div>
          </div>

          {/* Customize + refresh the preview (GET — nothing sends) */}
          <form method="get" style={{ marginTop: 20, maxWidth: 680, display: "grid", gap: 14 }}>
            <div className="field">
              <label htmlFor="subject">Subject</label>
              <input id="subject" name="subject" defaultValue={sp.subject ?? built.defaults.subject} />
            </div>
            <div className="field">
              <label htmlFor="headline">Headline (the large italic line in the email)</label>
              <input id="headline" name="headline" defaultValue={sp.headline ?? built.defaults.headline} />
            </div>
            <div className="field">
              <label htmlFor="body">Body (after the greeting: say exactly what&apos;s in this delivery)</label>
              <textarea id="body" name="body" rows={5} defaultValue={sp.body ?? built.defaults.body} style={{ resize: "vertical" }} />
            </div>
            <button type="submit" className="btn btn-ghost" style={{ justifySelf: "start" }}>Update Preview ↓</button>
          </form>

          {/* Send — carries exactly what the preview shows */}
          <form action={sendDeliveryEmail.bind(null, id)} style={{ marginTop: 26 }}>
            <input type="hidden" name="subject" value={sp.subject ?? ""} />
            <input type="hidden" name="headline" value={sp.headline ?? ""} />
            <input type="hidden" name="body" value={sp.body ?? ""} />
            {built.team && built.team.members.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <TeamCcPicker teamName={built.team.name ?? built.team.slug} members={built.team.members} />
              </div>
            )}
            <div className="field" style={{ maxWidth: 560 }}>
              <label htmlFor="cc">Also CC (optional, anyone else; separate multiple emails with commas)</label>
              <input id="cc" name="cc" type="text" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} defaultValue={sp.cc ?? ""} placeholder="teammate@brokerage.com, assistant@brokerage.com" />
            </div>
            <div className="flex flex-wrap items-center" style={{ gap: 12, marginTop: 16 }}>
              <button type="submit" className="btn btn-primary">Confirm &amp; Send to {built.to}</button>
              <Link href={`/admin/listings/${id}`} className="btn btn-ghost">Cancel</Link>
            </div>
            <p className="faint" style={{ marginTop: 10, fontSize: 12 }}>
              Sends what the preview below shows. Subject: &ldquo;{built.subject}&rdquo;
            </p>
          </form>
          {listing.deliveryEmailAt && (
            <p className="faint" style={{ marginTop: 12, fontSize: 12.5 }}>
              Already sent {listing.deliveryEmailAt}. Confirming will send it again.
            </p>
          )}

          <div className="kicker" style={{ margin: "36px 0 12px" }}>Exact Preview</div>
          <iframe
            title="Delivery email preview"
            srcDoc={built.html}
            sandbox=""
            style={{ width: "100%", height: 1150, border: "1px solid var(--line)", background: "#FFFFFF", display: "block" }}
          />
        </>
      )}
    </section>
  );
}
