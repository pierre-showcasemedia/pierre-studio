// Publishing and deleting frames from the shoot page (Oct 28 2026). the owner:
// "Right now, you have to make visible and then publish before making
// visible ... it should be a little bit more streamlined", "really only
// approving and publishing the final frames that are uploaded from the final
// QC pass, and then hiding everything else", and "the ability to delete
// frames in bulk".
//
// Nov 2 2026 (the owner: "ONLY approved photos should be published"): publishFrames
// sends the APPROVED frames among the chosen ones and no other. A rejected
// frame never goes, whatever was selected; an unreviewed (pending) frame
// waits until someone approves it. Both are counted back as skipped so the
// grid can say so. A shoot that was never published becomes published with
// them (that first publish posts the usual "is published, delivery email
// next" line and sets the cover if the listing has none). With hideOthers,
// every other frame of the shoot moves to internal only ("Publish finals
// only"). destination "revised" puts the frames in the client's Revised
// images section (media.revision) instead of the main gallery: swaps, fixes
// and additions after the first delivery (src/lib/publish-plan.ts).
//
// Nov 3 2026 (925 Example Spruce Road): a shoot whose editing stopped (status failed)
// publishes too. The editors deliver the corrected photos by hand through the
// corrected photos box, which a failed shoot already accepts, and approve
// them like any other frame; publishing closes the failure (status published,
// the error cleared). Nothing publishes while the pipeline is still running
// (src/lib/shoot-status.ts canPublishFrom).
//
// deleteFrames: admins only. Removes the media rows (downloads keep their
// history without the link; a cover that pointed at one is cleared). The
// files stay in storage, like a delete on the listing page.
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { enqueueBundleRebuild } from "./bundle-jobs";
import { type Destination, NOTHING_APPROVED } from "./publish-plan";
import { canPublishFrom } from "./shoot-status";
import { hubGalleryPublished } from "./slack";

export const MAX_FRAME_IDS = 2000;

export type PublishOutcome = { listingId: string; live: number; hidden: number; firstPublish: boolean; destination: Destination; skipped: { rejected: number; pending: number } };

export async function publishFrames(actor: string, shootId: string, ids: string[], opts: { hideOthers?: boolean; destination?: Destination } = {}): Promise<PublishOutcome> {
  const d = db();
  const destination: Destination = opts.destination === "revised" ? "revised" : "gallery";
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), with: { listing: true } });
  if (!shoot) throw new Error("Shoot not found.");
  if (!canPublishFrom(shoot.status)) throw new Error("Frames can go to the client once they are in and QC has run.");
  const wanted = [...new Set(ids.map(String).filter(Boolean))].slice(0, MAX_FRAME_IDS);
  if (!wanted.length) throw new Error("Select at least one frame.");
  const rows = await d.query.media.findMany({ where: and(eq(schema.media.shootId, shootId), inArray(schema.media.id, wanted)), columns: { id: true, r2Key: true, section: true, kind: true, sort: true, filename: true, qcState: true } });
  if (!rows.length) throw new Error("Those frames are not on this shoot.");
  // Only approved frames go. The others are counted, never published.
  const approved = rows.filter((r) => r.qcState === "approved");
  const skipped = { rejected: rows.filter((r) => r.qcState === "rejected").length, pending: rows.filter((r) => r.qcState === "pending").length };
  if (!approved.length) throw new Error(NOTHING_APPROVED);
  const safe = approved.map((r) => r.id);

  await d.update(schema.media).set({ published: true, held: false }).where(inArray(schema.media.id, safe));
  // Revised images: frames of the main gallery only; a Twilight (or any named section) frame keeps its section.
  if (destination === "revised") await d.update(schema.media).set({ revision: true }).where(and(inArray(schema.media.id, safe), isNull(schema.media.section)));
  let hidden = 0;
  if (opts.hideOthers) {
    const others = await d
      .update(schema.media)
      .set({ published: false, held: true })
      .where(and(eq(schema.media.shootId, shootId), notInArray(schema.media.id, safe), eq(schema.media.held, false)))
      .returning({ id: schema.media.id });
    hidden = others.length;
  }

  const firstPublish = !shoot.publishedAt;
  if (!shoot.listing.coverKey) {
    const cover = [...approved].sort((a, b) => a.sort - b.sort).find((r) => !r.section && r.kind === "photo") ?? approved[0];
    if (cover) await d.update(schema.listings).set({ coverKey: cover.r2Key }).where(eq(schema.listings.id, shoot.listingId));
  }
  // Like Publish: every publish stamps the shoot (that closes an open final
  // review). updatedAt is left alone so the open grid is not reloaded. A
  // stopped shoot (failed) is over once its photos are live: the error goes.
  const recovered = shoot.status === "failed";
  await d.update(schema.shoots).set({ status: "published", publishedAt: new Date(), publishedBy: actor, ...(recovered ? { error: null } : {}) }).where(eq(schema.shoots.id, shootId));

  const meta = { hidden, destination, skipped, via: opts.hideOthers ? "finals" : "frames", ...(recovered ? { recoveredFrom: "failed" } : {}) };
  if (firstPublish) {
    await logActivity({ actorEmail: actor, action: "shoot.published", shootId, listingId: shoot.listingId, meta: { approved: approved.length, newly: approved.length, ...meta } });
    await hubGalleryPublished({ listingId: shoot.listingId, listing: shoot.listing, photoCount: approved.length, by: actor });
  } else {
    await logActivity({ actorEmail: actor, action: "media.visibility", listingId: shoot.listingId, shootId, meta: { to: "client", count: approved.length, live: approved.length, waiting: 0, ...meta, filenames: approved.map((r) => r.filename).slice(0, 20) } });
  }
  try {
    await enqueueBundleRebuild(shoot.listingId);
  } catch (e) {
    console.error("[frame-publish] bundle rebuild:", e instanceof Error ? e.message : e);
  }
  return { listingId: shoot.listingId, live: approved.length, hidden, firstPublish, destination, skipped };
}

export async function deleteFrames(actor: string, shootId: string, ids: string[]): Promise<{ listingId: string; count: number }> {
  const d = db();
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { id: true, listingId: true }, with: { listing: { columns: { coverKey: true } } } });
  if (!shoot) throw new Error("Shoot not found.");
  const wanted = [...new Set(ids.map(String).filter(Boolean))].slice(0, MAX_FRAME_IDS);
  if (!wanted.length) throw new Error("Select at least one frame.");
  const rows = await d.query.media.findMany({ where: and(eq(schema.media.shootId, shootId), inArray(schema.media.id, wanted)), columns: { id: true, r2Key: true, filename: true } });
  if (!rows.length) throw new Error("Those frames are not on this shoot.");
  const safe = rows.map((r) => r.id);
  await d.update(schema.downloads).set({ mediaId: null }).where(inArray(schema.downloads.mediaId, safe));
  await d.delete(schema.media).where(inArray(schema.media.id, safe));
  if (shoot.listing.coverKey && rows.some((r) => r.r2Key === shoot.listing.coverKey)) {
    await d.update(schema.listings).set({ coverKey: null }).where(eq(schema.listings.id, shoot.listingId));
  }
  await d.update(schema.shoots).set({ updatedAt: new Date() }).where(eq(schema.shoots.id, shootId));
  await logActivity({ actorEmail: actor, action: "media.deleted", listingId: shoot.listingId, shootId, meta: { count: rows.length, filenames: rows.map((r) => r.filename).slice(0, 20), via: "shoot" } });
  try {
    await enqueueBundleRebuild(shoot.listingId);
  } catch (e) {
    console.error("[frame-publish] bundle rebuild after delete:", e instanceof Error ? e.message : e);
  }
  return { listingId: shoot.listingId, count: rows.length };
}
