import Link from "next/link";
import { fileStoreName, onDrive } from "@/lib/file-store";
import { drivePickerConfig } from "@/lib/google-drive";
import { hasDb } from "@/db";
import { hasAutoHdr } from "@/lib/autohdr";
import { adminClientById, adminListingById, adminShoots } from "@/lib/admin-data";
import { fmtWhen } from "@/lib/shoot-status";
import UploadWizard from "@/components/admin/UploadWizard";
import { Empty, PageHead, ShootPill } from "@/components/admin/bits";
import { requireUploader } from "@/lib/admin";
import { business } from "@/lib/business";

export default async function UploadPage({ searchParams }: { searchParams: Promise<{ clientId?: string; listingId?: string; denied?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  // Admins and creative specialists (the shooters, Oct 21 2026). A creative
  // specialist picks an existing listing and uploads; only an admin can make
  // a listing or a client from here.
  const staff = await requireUploader();
  const creative = staff.role === "creative";
  const sp = await searchParams;
  const listing = sp.listingId ? await adminListingById(sp.listingId) : null;
  const client = listing ? await adminClientById(listing.clientId) : sp.clientId ? await adminClientById(sp.clientId) : null;
  // A creative specialist's own uploads, so they can see each one went through.
  const mine = creative ? (await adminShoots()).filter((s) => s.status !== "draft" && s.createdBy.toLowerCase() === staff.email.toLowerCase()).slice(0, 20) : [];
  return (
    <section className="wrap adm-page" style={{ maxWidth: 820 }}>
      <PageHead eyebrow={creative ? "Creative specialist" : "Admin"} title="Upload a shoot." lede={business.editing === "manual" ? `Straight from the card: raw video for the listing\u2019s ${fileStoreName()} folder, and raws to keep if you want them.` : "Straight from the card. Pick the listing, add the files, choose the look, and editing takes it from there."} />
      {sp.denied && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>That page is for admins. Upload a shoot here, and ask an admin if you need something else.</p>}
      {business.editing === "manual" && (
        <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>
          Photos are edited outside the studio. Add the finished photos on the listing&apos;s page (Listings, the listing, Upload photos): they go straight onto the listing, nothing is sent to editing.{listing ? <> <a className="adm-link" href={`/admin/listings/${listing.id}#upload`}>Open this listing&apos;s upload →</a></> : null} Use this page for raw video, which goes to {fileStoreName()}.
        </p>
      )}
      <div style={{ marginTop: 26 }}>
        <UploadWizard
          demo={!hasDb()}
          dropboxKey={onDrive() ? null : process.env.NEXT_PUBLIC_DROPBOX_APP_KEY || null}
          drivePicker={onDrive() ? drivePickerConfig() : null}
          storeName={fileStoreName()}
          editingConnected={hasAutoHdr()}
          editedOutside={business.editing === "manual"}
          canCreate={!creative}
          initialClient={client ? { id: client.id, email: client.email, name: client.name, company: client.company } : null}
          initialListing={listing ? { id: listing.id, address: listing.address, slug: listing.slug, shootDate: listing.shootDate, nda: listing.nda } : null}
        />
      </div>
      {creative && (
        <div className="adm-section">
          <div className="adm-section-head"><div className="kicker">Your uploads</div></div>
          {mine.length === 0 ? (
            <Empty>Nothing uploaded yet. Your shoots appear here once you submit one.</Empty>
          ) : (
            <div className="adm-table-wrap">
              <div className="adm-table-scroll">
                <table className="adm-table">
                  <thead><tr><th>Listing</th><th>Status</th><th>Files</th><th>Submitted</th><th></th></tr></thead>
                  <tbody>
                    {mine.map((s) => (
                      <tr key={s.id}>
                        <td><Link href={`/admin/shoots/${s.id}`} style={{ fontWeight: 500 }}>{s.address.split(",")[0]}</Link></td>
                        <td><ShootPill s={s.status} /></td>
                        <td className="adm-mono">{s.fileCount}</td>
                        <td className="adm-mono muted" style={{ whiteSpace: "nowrap" }}>{fmtWhen(s.submittedAt ?? s.createdAt)}</td>
                        <td style={{ textAlign: "right" }}><Link href={`/admin/shoots/${s.id}`} className="adm-chip adm-chip--quiet">Open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
