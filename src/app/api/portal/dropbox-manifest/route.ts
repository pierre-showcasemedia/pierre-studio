// "Add to Dropbox": mints signed URLs for the Dropbox Saver, which copies
// files server-to-server (nothing touches the client's device).
//
// POST { slug, ids?: string[] }                     (original shape, still works)
//   → the originals of those media, or of every client-visible file
// POST { slug, groups: Group[], ids?: string[] }
//   Group = "photos"          main gallery photos, originals
//         | "mls"             main gallery photos, 2048px MLS files ("<name>-MLS.jpg")
//         | "films"           main gallery films, originals
//         | "revised"         revised files (not in a named section), originals
//         | "section:<name>"  one named section (photos and films), originals
//   ids, when given with groups, keeps only those media.
// → { ok, files: [{ url, filename }], missing } (missing = MLS files not built yet, left out)
//
// Session + team gated (listingForEmail: owner, teammate or partner, client-
// visible media only); refuses while downloads are locked. Every minted URL is
// logged to the downloads feed like any other download.
//
// Demo mode (no database): same checks against the demo listings, and the
// file list comes back without URLs, so nothing can be sent anywhere.
import { db, hasDb, schema } from "@/db";
import { sessionEmail } from "@/lib/portal-auth";
import { listingForEmail } from "@/lib/portal-data";
import { mlsName, type Pick, picksFor, uniqueNames } from "@/lib/portal-save";
import { hasR2, headObject, signedDownloadUrl } from "@/lib/r2";
import { derivativeKey } from "@/lib/media-keys";
import { syncLockedListing } from "@/lib/payments";
import { logActivity } from "@/lib/activity";
import { isPartnerEmail } from "@/lib/partner";

export async function POST(request: Request) {
  const email = await sessionEmail();
  const demo = !hasDb();
  if (!email || (!demo && !hasR2())) return Response.json({ ok: false }, { status: 401 });
  const b = await request.json().catch(() => ({}));
  const data = await listingForEmail(email, String(b?.slug || ""));
  if (!data) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  if (data.listing.downloadLocked) {
    if (demo) return Response.json({ ok: false, error: "downloads are locked until payment" }, { status: 403 });
    // Step two: ask the provider first (throttled); only applyPaid can unlock.
    const unlocked = await syncLockedListing(data.listing.id, "download");
    if (!unlocked) return Response.json({ ok: false, error: "downloads are locked until payment" }, { status: 403 });
  }

  const wanted = Array.isArray(b.ids) && b.ids.length ? new Set<string>(b.ids.map(String)) : null;
  let picks: Pick[];
  if (Array.isArray(b.groups) && b.groups.length) {
    const groups = [...new Set<string>(b.groups.map(String))].slice(0, 50);
    const seen = new Set<string>();
    picks = [];
    for (const g of groups) {
      const got = picksFor(g, data.media);
      if (!got) return Response.json({ ok: false, error: `unknown group: ${g.slice(0, 60)}` }, { status: 400 });
      for (const p of got) {
        const k = `${p.m.id}:${p.variant}`;
        if (seen.has(k) || (wanted && !wanted.has(p.m.id))) continue;
        seen.add(k);
        picks.push(p);
      }
    }
  } else {
    picks = data.media.filter((m) => !wanted || wanted.has(m.id)).map((m) => ({ m, variant: "original" as const }));
  }
  if (!picks.length) return Response.json({ ok: false, error: "no files" }, { status: 400 });

  // MLS files are derivatives: leave out any that are not built yet rather
  // than hand Dropbox a URL that fails.
  let missing = 0;
  if (!demo && picks.some((p) => p.variant === "mls")) {
    const present = await mapLimit(picks, 16, async (p) => p.variant !== "mls" || (await headObject(derivativeKey(p.m.r2Key, "mls"))) !== null);
    missing = present.filter((x) => !x).length;
    picks = picks.filter((_, i) => present[i]);
    if (!picks.length) return Response.json({ ok: false, error: "no files" }, { status: 400 });
  }

  const names = uniqueNames(picks.map((p) => (p.variant === "mls" ? mlsName(p.m.filename) : p.m.filename)));

  if (demo) {
    return Response.json({ ok: true, demo: true, files: names.map((filename) => ({ url: null, filename })), missing });
  }

  const files = await Promise.all(
    picks.map(async (p, i) => ({
      url: await signedDownloadUrl(p.variant === "mls" ? derivativeKey(p.m.r2Key, "mls") : p.m.r2Key, names[i], 3600),
      filename: names[i],
    }))
  );

  await db().insert(schema.downloads).values(
    picks.map((p, i) => ({
      mediaId: p.m.id,
      listingId: data.listing.id,
      clientEmail: email,
      filename: `${names[i]} → Dropbox`,
    }))
  );
  if (!isPartnerEmail(email)) {
    await logActivity({ actorEmail: email.toLowerCase(), action: "client.dropbox", listingId: data.listing.id, meta: { email: email.toLowerCase(), count: files.length } });
  }

  return Response.json({ ok: true, files, missing });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
