import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { brand } from "@/lib/brand";
import { ROLE_LABELS } from "@/db/schema";
import { canSeeScorecard, requireTeam } from "@/lib/admin";
import { SCORECARD_PERSON } from "@/lib/scorecard";
import { isDemo } from "@/lib/portal-data";
import { viewingAs } from "@/lib/portal-auth";
import { openRevisionCount } from "@/lib/admin-data";
import { AdminSidebar } from "@/components/admin/AdminNav";
import { SIDEBAR_COOKIE } from "@/lib/admin-sidebar";
import ViewAsBanner from "@/components/ViewAsBanner";
import PhoneKit from "@/components/admin/PhoneKit";
import { exitViewAs } from "../portal/view-as-actions";

// On a phone the admin installs to the Home Screen as "the studio" and opens
// full screen (src/app/studio.webmanifest). The page runs edge to edge under
// the notch and the home indicator; the bars pad themselves with the safe
// areas. maximumScale keeps iPhone from zooming into a tapped field (pinch
// zoom still works there); every admin field is 16px on a phone anyway.
export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false },
  manifest: "/studio.webmanifest",
  appleWebApp: { capable: true, title: `${brand.name}`, statusBarStyle: "default" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, viewportFit: "cover", themeColor: "#FFFFFF" };
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Not the security boundary: Next renders this layout and the page in
  // parallel, so a redirect thrown here does not stop the page from fetching
  // and streaming its data into the 307 body. Every page under /admin calls
  // requireAdmin(), requireStaff(), requireUploader(), requireVideo() or requireTeam() itself
  // as its first statement; this one only decides what the shell shows (the
  // Photo QC team, creative specialists and video editors get their own
  // menu; only admins get Settings).
  const { email, role } = await requireTeam();
  const qa = role !== "admin";
  // The Photo QC team counts the open photo revisions (their Revisions item).
  const [openRevisions, impersonating, jar] = await Promise.all([role === "admin" ? openRevisionCount() : role === "qa" ? openRevisionCount("photo") : Promise.resolve(0), qa ? Promise.resolve(null) : viewingAs(), cookies()]);
  // The sidebar folded to icons or open (Oct 26 2026): the visitor's choice,
  // read here so the page renders at the right width from the first paint.
  const railed = jar.get(SIDEBAR_COOKIE)?.value === "rail";
  const h = 30;
  return (
    <div className="adm-shell" data-side={railed ? "rail" : "open"}>
      <AdminSidebar role={role} email={email} roleLabel={ROLE_LABELS[role]} openRevisions={openRevisions} railed={railed} demo={isDemo()} scorecard={canSeeScorecard({ email, role }, SCORECARD_PERSON.email)} logo={{ src: brand.logoBlack, w: Math.round(h * brand.logoRatio), h }} />
      <div className="adm-main">
        {impersonating && <ViewAsBanner email={impersonating} exitAction={exitViewAs} />}
        <main>{children}</main>
      </div>
      <PhoneKit />
    </div>
  );
}
