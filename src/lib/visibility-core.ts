// Move frames between "Client visible" and "Internal only" (Oct 2026). The
// one write path behind the listing media grid, the shoot review grid, the
// upload panel's "Client visible" choice and the grid's older Hide / Show.
//
//   internal  published=false, held=true. Publish never flips a held frame.
//   client    qc_state='approved', published=true, held=false. A person's
//             explicit choice overrides QC. On a shoot that has never been
//             published the frame waits for Publish (counted as "waiting");
//             everywhere else it is live at once.
//
// What the client sees is still decided only by src/lib/media-visibility.ts.
// Every call logs one media.visibility row (actor, counts) and queues a zip
// rebuild, so "Download all" never carries a frame that went internal.
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { enqueueBundleRebuild } from "./bundle-jobs";
import { isClientVisibleRow } from "./visibility";

export type VisibilityTarget = "client" | "internal";
export type VisibilityOutcome = { listingId: string; count: number; live: number; waiting: number };

export const MAX_VISIBILITY_IDS = 2000;

// scope: the listing or the shoot the ids must belong to (at least one).
export async function applyVisibility(
  actor: string,
  scope: { listingId?: string | null; shootId?: string | null },
  ids: string[],
  to: VisibilityTarget,
  via: "listing" | "shoot" | "upload"
): Promise<VisibilityOutcome> {
  if (to !== "client" && to !== "internal") throw new Error("Choose client visible or internal only.");
  const wanted = [...new Set(ids.map(String).filter(Boolean))].slice(0, MAX_VISIBILITY_IDS);
  if (!wanted.length) throw new Error("Select at least one file.");
  if (!scope.listingId && !scope.shootId) throw new Error("Missing the listing or the shoot.");
  const d = db();
  const where = and(
    inArray(schema.media.id, wanted),
    scope.listingId ? eq(schema.media.listingId, scope.listingId) : undefined,
    scope.shootId ? eq(schema.media.shootId, scope.shootId) : undefined
  );
  const rows = await d.query.media.findMany({ where, columns: { id: true, listingId: true, shootId: true, filename: true } });
  if (!rows.length) throw new Error(scope.shootId ? "Those frames are not on this shoot." : "Those files are not on this listing.");
  const listingIds = [...new Set(rows.map((r) => r.listingId))];
  if (listingIds.length !== 1) throw new Error("Files from more than one listing.");
  const listingId = listingIds[0];
  const safe = rows.map((r) => r.id);

  if (to === "internal") {
    await d.update(schema.media).set({ published: false, held: true }).where(inArray(schema.media.id, safe));
  } else {
    await d.update(schema.media).set({ qcState: "approved", published: true, held: false }).where(inArray(schema.media.id, safe));
  }

  // How many the client sees now, and how many wait for their shoot's Publish.
  const shootIds = [...new Set(rows.map((r) => r.shootId).filter((x): x is string => Boolean(x)))];
  const shoots = shootIds.length ? await d.query.shoots.findMany({ where: inArray(schema.shoots.id, shootIds), columns: { id: true, publishedAt: true } }) : [];
  const shootLive = new Set(shoots.filter((s) => s.publishedAt).map((s) => s.id));
  const live = to === "client" ? rows.filter((r) => isClientVisibleRow({ qcState: "approved", published: true, shootId: r.shootId }, Boolean(r.shootId && shootLive.has(r.shootId)))).length : 0;
  const waiting = to === "client" ? rows.length - live : 0;

  await logActivity({
    actorEmail: actor,
    action: "media.visibility",
    listingId,
    shootId: scope.shootId ?? (shootIds.length === 1 ? shootIds[0] : null),
    meta: { to, count: rows.length, live, waiting, via, filenames: rows.map((r) => r.filename).slice(0, 20) },
  });
  try {
    await enqueueBundleRebuild(listingId);
  } catch (e) {
    // The change is saved; "Rebuild zips" on the listing catches a missed one.
    console.error("[visibility] bundle rebuild:", e instanceof Error ? e.message : e);
  }
  return { listingId, count: rows.length, live, waiting };
}
