// Bundle downloads: the precomputed "download all" zips.
//   /api/portal/bundle/<listingId>/full — every photo and film, originals
//   /api/portal/bundle/<listingId>/mls  — every photo, 2048px MLS-ready set
//   /api/portal/bundle/<listingId>/sec-<slug> — one named section's photos and films
//   /api/portal/bundle/<listingId>/secmls-<slug> — that section's photos at 2048px
//   /api/portal/bundle/<listingId>/grp-<area> — one gallery area (photos, revised, films, revised-films)
//   /api/portal/bundle/<listingId>/grpmls-<area> — a photo area at 2048px (photos, revised)
// Keys and contents: src/lib/bundles.ts.
// Same gate as per-file downloads: session + team ownership (or partner) + unlocked.
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { sessionEmail } from "@/lib/portal-auth";
import { isPartnerEmail, partnerCanSee } from "@/lib/partner";
import { hasR2, objectExists, signedDownloadUrl } from "@/lib/r2";
import { syncLockedListing } from "@/lib/payments";
import { logActivity } from "@/lib/activity";

export async function GET(_req: Request, { params }: { params: Promise<{ listingId: string; kind: string }> }) {
  const { listingId, kind } = await params;
  const z = zipFor(kind);
  if (!z) return Response.json({ ok: false }, { status: 404 });
  const email = await sessionEmail();
  if (!email) return Response.json({ ok: false, error: "not signed in" }, { status: 401 });
  if (!hasDb() || !hasR2()) return Response.json({ ok: false, error: "not configured" }, { status: 503 });

  const d = db();
  const l = await d.query.listings.findFirst({ where: eq(schema.listings.id, listingId), with: { client: true } });
  let allowed = false;
  if (l && isPartnerEmail(email)) {
    allowed = partnerCanSee(l);
  } else if (l) {
    const me = await d.query.clients.findFirst({ where: eq(schema.clients.email, email.toLowerCase()) });
    allowed = Boolean(me && (l.clientId === me.id || (me.team && l.client.team === me.team)));
  }
  if (!l || !allowed) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  if (l.downloadLocked) {
    // Step two: ask the provider first (throttled); only applyPaid can unlock.
    const unlocked = await syncLockedListing(l.id, "download");
    if (!unlocked) return Response.json({ ok: false, error: "locked until payment is received" }, { status: 402 });
  }

  const key = `listings/${l.slug}/bundles/${z.stem}.zip`;
  if (!(await objectExists(key))) return Response.json({ ok: false, error: "bundle not ready yet" }, { status: 404 });

  const street = l.address.split(",")[0].trim().replace(/\s+/g, " ");
  const url = await signedDownloadUrl(key, `${street} - ${z.label}.zip`);

  try {
    // Log one row for the bundle grab (media_id of the first file as anchor).
    const anchor = await d.query.media.findFirst({ where: eq(schema.media.listingId, l.id) });
    if (anchor) await d.insert(schema.downloads).values({ mediaId: anchor.id, listingId: l.id, clientEmail: email.toLowerCase(), filename: z.log });
  } catch {}
  // The activity feed and the hub hear about a client's zip (not a partner's).
  if (!isPartnerEmail(email)) {
    await logActivity({ actorEmail: email.toLowerCase(), action: "client.downloaded", listingId: l.id, clientId: l.clientId, meta: { email: email.toLowerCase(), what: z.what, kind } });
  }

  return Response.redirect(url, 302);
}

const AREA_LABEL: Record<string, string> = { photos: "Photos", revised: "Revised", films: "Films", "revised-films": "Revised films" };

// A bundle kind from the URL: its zip (bundles/<stem>.zip), the download's file
// label, the downloads-log text and the activity line. null for anything else.
function zipFor(kind: string): { stem: string; label: string; log: string; what: string } | null {
  if (kind === "full") return { stem: "photos-full", label: "Full Resolution", log: "Full-res bundle (all photos and films)", what: "the full resolution zip" };
  if (kind === "mls") return { stem: "photos-mls", label: "MLS 2048px Photos", log: "MLS bundle (all photos, 2048px)", what: "the MLS zip (2048px)" };
  let m = /^(sec|secmls)-([a-z0-9-]+)$/.exec(kind);
  if (m) {
    const words = m[2].replace(/-/g, " ");
    return m[1] === "sec"
      ? { stem: `photos-${m[2]}`, label: words, log: `Section bundle (${m[2]})`, what: `the ${words} zip` }
      : { stem: `photos-${m[2]}-mls`, label: `${words} MLS 2048px`, log: `Section MLS bundle (${m[2]})`, what: `the ${words} MLS zip` };
  }
  m = /^(grp|grpmls)-(photos|revised|films|revised-films)$/.exec(kind);
  if (m) {
    const name = AREA_LABEL[m[2]];
    if (m[1] === "grp") return { stem: `group-${m[2]}`, label: name, log: `Area bundle (${m[2]})`, what: `the ${name.toLowerCase()} zip` };
    if (m[2] === "photos" || m[2] === "revised") return { stem: `group-${m[2]}-mls`, label: `${name} MLS 2048px`, log: `Area MLS bundle (${m[2]})`, what: `the ${name.toLowerCase()} MLS zip` };
  }
  return null;
}
