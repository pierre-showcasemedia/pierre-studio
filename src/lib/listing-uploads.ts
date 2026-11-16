// Direct uploads onto a listing from the admin UI, without an editing shoot
// (finished JPGs and films an admin already has). The browser PUTs each file
// straight to storage with a presigned URL (listings/<slug>/photos/<name>,
// listings/<slug>/video/<name>, or under s/<section>/ for a named section),
// then the ingest route makes the derivatives and the media rows. A file with
// the same name as an existing row replaces it in place; new names are added.
// Rows are born approved and client visible unless the uploader chose
// "Internal only" (published=false, held=true: src/lib/visibility.ts).
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { makeDerivatives } from "./derivatives";
import { getObjectBuffer, headObject, putObject, safeFilename } from "./r2";
import { withOriginalSlot } from "./image-gate";

export const sectionSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export const isPhotoName = (n: string) => /\.jpe?g$/i.test(n);
export const isVideoName = (n: string) => /\.(mp4|mov|m4v)$/i.test(n);
export const uploadContentType = (n: string) => (isPhotoName(n) ? "image/jpeg" : /\.mov$/i.test(n) ? "video/quicktime" : "video/mp4");

export function listingUploadKey(slug: string, section: string | null, safe: string): string {
  const sec = section ? `s/${sectionSlug(section)}/` : "";
  return `listings/${slug}/${sec}${isVideoName(safe) ? "video" : "photos"}/${safe}`;
}

export type ListingIngestResult = {
  added: { filename: string; mediaId: string }[];
  replaced: { filename: string; mediaId: string }[];
  failed: { filename: string; error: string }[];
};

export async function ingestListingUploads(listingId: string, actor: string, names: string[], opts: { section?: string | null; published?: boolean; run?: string | null } = {}): Promise<ListingIngestResult> {
  const d = db();
  const listing = await d.query.listings.findFirst({ where: eq(schema.listings.id, listingId), columns: { id: true, slug: true } });
  if (!listing) throw new Error("Listing not found.");
  const section = opts.section?.trim() || null;
  // Internal only unless the caller says otherwise (Oct 20 2026: the
  // gallery is finalized and reviewed BEFORE a client sees anything, so an
  // editing mistake or an unchecked photo can never slip out on upload).
  const published = opts.published === true;
  const existing = await d.query.media.findMany({ where: eq(schema.media.listingId, listingId), columns: { id: true, r2Key: true, section: true, sort: true, revision: true } });
  const byKey = new Map(existing.map((m) => [m.r2Key, m]));
  let nextSort = existing.filter((m) => (m.section ?? null) === section && !m.revision).reduce((a, m) => Math.max(a, m.sort), -1) + 1;
  const out: ListingIngestResult = { added: [], replaced: [], failed: [] };
  for (const raw of names) {
    const safe = safeFilename(String(raw));
    const key = listingUploadKey(listing.slug, section, safe);
    try {
      if (!isPhotoName(safe) && !isVideoName(safe)) throw new Error("only JPG photos and MP4 or MOV films");
      const head = await headObject(key);
      if (!head || head.size === 0) throw new Error("did not land");
      const kind: "photo" | "video" = isVideoName(safe) ? "video" : "photo";
      if (kind === "photo") {
        // One of the instance's original slots for as long as the bytes are held (src/lib/image-gate.ts).
        await withOriginalSlot(async () => {
          const { body } = await getObjectBuffer(key);
          const meta = await sharp(body, { failOn: "none" }).metadata();
          if (meta.format !== "jpeg") throw new Error(`not a JPEG (${meta.format ?? "unknown"})`);
          const derivs = await makeDerivatives(body, key);
          await Promise.all(derivs.map((x) => putObject(x.key, x.buffer, "image/jpeg")));
        });
      }
      const match = byKey.get(key);
      if (match) {
        await d.update(schema.media).set({ bytes: head.size, published, held: !published, qcState: "approved", corrected: false }).where(eq(schema.media.id, match.id));
        out.replaced.push({ filename: safe, mediaId: match.id });
      } else {
        const [row] = await d
          .insert(schema.media)
          .values({ listingId, kind, r2Key: key, filename: safe, bytes: head.size, section, revision: false, sort: nextSort++, qcState: "approved", published, held: !published })
          .returning({ id: schema.media.id });
        byKey.set(key, { id: row.id, r2Key: key, section, sort: nextSort - 1, revision: false });
        out.added.push({ filename: safe, mediaId: row.id });
      }
    } catch (e) {
      out.failed.push({ filename: safe, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (out.added.length || out.replaced.length) {
    // With a run (src/lib/upload-runs.ts) the line waits for the run's one summary.
    await logActivity({ actorEmail: actor, action: "media.uploaded", listingId, meta: { count: out.added.length + out.replaced.length, added: out.added.length, replaced: out.replaced.length, section, published, ...(opts.run ? { run: opts.run } : {}) } });
  }
  return out;
}
