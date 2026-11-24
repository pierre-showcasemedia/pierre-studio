// "Save to Google Drive" (Nov 18 2026): the client's photos and films go
// straight from storage into the client's OWN Google Drive, server to server;
// nothing downloads to the device. The browser signs the client in to Google
// (Google Identity Services, scope drive.file, a one-hour token that is never
// stored here) and drives the copy one file per request, so a big gallery
// never runs into a time limit.
//
// POST { slug, step: "plan", groups?, ids? }
//   → { ok, files: [{ mediaId, variant, filename }], missing, folderName }
//   The same groups as Save to Dropbox (src/lib/portal-save.ts).
// POST { slug, step: "copy", token, folderId?, mediaId, variant, filename }
//   → { ok, folderId }   the first copy makes "<address> · <business>" in My Drive
//
// Session + team gated (listingForEmail: owner, teammate or partner, client-
// visible media only), refused while downloads are locked, on every request.
// Every copied file is logged to the downloads feed like a download.
import { db, hasDb, schema } from "@/db";
import { sessionEmail } from "@/lib/portal-auth";
import { listingForEmail } from "@/lib/portal-data";
import { getObjectRange, hasR2, headObject } from "@/lib/r2";
import { derivativeKey } from "@/lib/media-keys";
import { syncLockedListing } from "@/lib/payments";
import { logActivity } from "@/lib/activity";
import { isPartnerEmail } from "@/lib/partner";
import { mlsName, picksForBody, uniqueNames } from "@/lib/portal-save";
import { driveApiWithToken, DriveError, isDriveNotFound } from "@/lib/google-drive";
import { DRIVE_CHUNK_BYTES } from "@/lib/drive-mirror";
import { contentTypeFor } from "@/lib/autohdr-constants";
import { brand } from "@/lib/brand";
import { onDrive } from "@/lib/file-store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const folderNameFor = (address: string) => `${address.split(",")[0].replace(/[\\/]+/g, "-").trim() || "Listing"} · ${brand.shortName}`.slice(0, 120);

export async function POST(request: Request) {
  // Nov 24 2026: only a business on Google Drive (business.fileStore) has Save to Google Drive.
  if (!onDrive()) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  const email = await sessionEmail();
  const demo = !hasDb();
  if (!email || (!demo && !hasR2())) return Response.json({ ok: false }, { status: 401 });
  const b = await request.json().catch(() => ({}));
  const data = await listingForEmail(email, String(b?.slug || ""));
  if (!data) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  if (data.listing.downloadLocked) {
    if (demo) return Response.json({ ok: false, error: "downloads are locked until payment" }, { status: 403 });
    const unlocked = await syncLockedListing(data.listing.id, "download");
    if (!unlocked) return Response.json({ ok: false, error: "downloads are locked until payment" }, { status: 403 });
  }

  if (b.step === "plan") {
    const r = picksForBody(b, data.media);
    if ("error" in r) return Response.json({ ok: false, error: r.error }, { status: 400 });
    let picks = r.picks;
    if (!picks.length) return Response.json({ ok: false, error: "no files" }, { status: 400 });
    let missing = 0;
    if (!demo && picks.some((p) => p.variant === "mls")) {
      const present = await Promise.all(picks.map(async (p) => p.variant !== "mls" || (await headObject(derivativeKey(p.m.r2Key, "mls"))) !== null));
      missing = present.filter((x) => !x).length;
      picks = picks.filter((_, i) => present[i]);
      if (!picks.length) return Response.json({ ok: false, error: "no files" }, { status: 400 });
    }
    const names = uniqueNames(picks.map((p) => (p.variant === "mls" ? mlsName(p.m.filename) : p.m.filename)));
    if (!demo && !isPartnerEmail(email)) {
      await logActivity({ actorEmail: email.toLowerCase(), action: "client.drive", listingId: data.listing.id, meta: { email: email.toLowerCase(), count: picks.length } });
    }
    return Response.json({ ok: true, demo, files: picks.map((p, i) => ({ mediaId: p.m.id, variant: p.variant, filename: names[i] })), missing, folderName: folderNameFor(data.listing.address) });
  }

  if (b.step !== "copy") return Response.json({ ok: false, error: "unknown step" }, { status: 400 });
  if (demo) return Response.json({ ok: true, demo: true, folderId: "demo" });
  const token = typeof b.token === "string" ? b.token.trim() : "";
  const m = data.media.find((x) => x.id === String(b.mediaId || ""));
  const variant = b.variant === "mls" ? "mls" : "original";
  if (!token || !m) return Response.json({ ok: false, error: "token and a file of this gallery are required" }, { status: 400 });
  const key = variant === "mls" ? derivativeKey(m.r2Key, "mls") : m.r2Key;
  const filename = String(b.filename || (variant === "mls" ? mlsName(m.filename) : m.filename)).replace(/[\\/]+/g, "-").slice(0, 200) || m.filename;
  const head = await headObject(key);
  if (!head || head.size <= 0) return Response.json({ ok: false, error: `${filename} is not ready yet` }, { status: 404 });

  const api = driveApiWithToken(token);
  try {
    let folderId = typeof b.folderId === "string" && b.folderId ? b.folderId : null;
    if (folderId) {
      const f = await api.getFile(folderId);
      if (!f) folderId = null; // removed meanwhile: make it again
    }
    if (!folderId) folderId = (await api.createFolder("root", folderNameFor(data.listing.address))).id;
    const session = await api.startUpload(folderId, filename, head.size, contentTypeFor(filename, "application/octet-stream"));
    let offset = 0;
    for (let guard = 0; guard < 400 && offset < head.size; guard++) {
      const len = Math.min(DRIVE_CHUNK_BYTES, head.size - offset);
      const r = await api.putChunk(session, offset, await getObjectRange(key, offset, offset + len - 1), head.size);
      if (r.done) {
        offset = head.size;
        break;
      }
      offset = r.next;
    }
    if (offset < head.size) throw new Error("the copy stopped part way");
    await db().insert(schema.downloads).values({ mediaId: m.id, listingId: data.listing.id, clientEmail: email, filename: `${filename} → Google Drive` });
    return Response.json({ ok: true, folderId });
  } catch (e) {
    if (e instanceof DriveError && (e.status === 401 || e.status === 403) && !isDriveNotFound(e)) {
      return Response.json({ ok: false, error: "Google sign-in ran out. Press Save to Google Drive again.", signIn: true }, { status: 401 });
    }
    console.error("[drive-save]", e instanceof Error ? e.message : e);
    return Response.json({ ok: false, error: `${filename} could not be saved. Try again in a minute.` }, { status: 502 });
  }
}
