import Link from "next/link";
import { adminClients } from "@/lib/admin-data";
import { createListing } from "../../actions";
import { PageHead } from "@/components/admin/bits";
import { requireAdmin } from "@/lib/admin";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { clientPick } from "@/lib/pick-options";

export default async function NewListing({ searchParams }: { searchParams: Promise<{ clientId?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireAdmin();
  const { clientId } = await searchParams;
  const clients = await adminClients();
  return (
    <section className="wrap adm-page" style={{ maxWidth: 760 }}>
      <Link href="/admin/listings" className="adm-link muted" style={{ fontSize: 12.5 }}>← Listings</Link>
      <div style={{ marginTop: 14 }}>
        <PageHead title="New listing." lede="Born locked, with a portal slug from the street line. Media comes from Upload a shoot." />
      </div>
      <form action={createListing} className="adm-card adm-card--lg" style={{ marginTop: 26, display: "grid", gap: 16 }}>
        <div className="field">
          <label htmlFor="clientId">Client</label>
          <SearchSelect id="clientId" name="clientId" required defaultValue={clientId ?? ""} options={clients.map(clientPick)} placeholder="Choose a client" title="Choose a client" searchPlaceholder="Search name, company or email" />
          <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>Not here yet? <Link href="/admin/clients" style={{ textDecoration: "underline" }}>Add the client first</Link>.</p>
        </div>
        <div className="field">
          <label htmlFor="address">Street address</label>
          <input id="address" name="address" required placeholder="3201 Example Willow Drive" autoComplete="off" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 14 }}>
          <div className="field">
            <label htmlFor="city">City and state</label>
            <input id="city" name="city" placeholder="Springfield, CA 90000" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="shootDate">Shoot date</label>
            <input id="shootDate" name="shootDate" type="date" />
          </div>
        </div>
        <label className="flex items-center" style={{ gap: 10, fontSize: 14 }}>
          <input type="checkbox" name="nda" style={{ width: 18, height: 18 }} /> NDA listing (hidden from partners, editing runs under the NDA name)
        </label>
        <div className="adm-actions" style={{ marginTop: 6 }}>
          <button type="submit" className="btn btn-primary">Create listing →</button>
          <Link href="/admin/listings" className="btn btn-ghost">Cancel</Link>
        </div>
      </form>
    </section>
  );
}
