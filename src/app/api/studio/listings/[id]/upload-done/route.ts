// The end of an upload run (Oct 26 2026, src/lib/upload-runs.ts): the
// uploader says it is done, and the hub gets ONE line for the whole drag and
// drop: finished, finished with problems (which files failed), or failed.
// The counts that went in come from the run's own activity rows; the files
// that did not are the uploader's list (a file can fail before the server
// ever sees it). Calling it twice posts once.
// Same people as the ingest route: admins, the QA team, a video editor (on a
// listing with a Video card) and x-migrate-token for scripts/push-to-listing.mjs.
// POST { run, total?, failed?: [{ name, error }], published?, section?, source?: "video-card", cardId?, done?: [name] } → { ok, posted, totals }
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireListingUploaderApi } from "@/lib/admin";
import { cleanRun, finishUploadRun, type RunFailure } from "@/lib/upload-runs";
import { listingHasVideoCard, videoCutInReview } from "@/lib/video-board";
import { videoEditingCutReady } from "@/lib/slack";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await requireListingUploaderApi(request);
  if (who instanceof Response) return who;
  if (!hasDb()) return Response.json({ ok: true, demo: true, posted: false });
  const { id } = await params;
  const listing = await db().query.listings.findFirst({ where: eq(schema.listings.id, id), columns: { id: true } });
  if (!listing) return Response.json({ ok: false, error: "Listing not found." }, { status: 404 });
  if (who.video && !(await listingHasVideoCard(listing.id))) return Response.json({ ok: false, error: "This listing has no Video card." }, { status: 403 });
  const b = await request.json().catch(() => ({}));
  const run = cleanRun(b.run);
  if (!run) return Response.json({ ok: false, error: "run is required." }, { status: 400 });
  const failed: RunFailure[] = (Array.isArray(b.failed) ? b.failed : [])
    .slice(0, 500)
    .map((f: { name?: unknown; error?: unknown }) => ({ name: String(f?.name ?? "").slice(0, 200), error: String(f?.error ?? "failed").slice(0, 300) }))
    .filter((f: RunFailure) => f.name);
  const total = Number.isFinite(Number(b.total)) ? Math.max(0, Math.min(5000, Math.round(Number(b.total)))) : null;
  const r = await finishUploadRun({
    run,
    listingId: listing.id,
    actor: who.actor,
    total,
    failed,
    published: who.video ? false : typeof b.published === "boolean" ? b.published : null,
    section: !who.video && typeof b.section === "string" && b.section.trim() ? b.section.trim().slice(0, 80) : null,
  });
  // A cut from the Video card (Nov 1 2026): #video-editing tells the
  // reviewers it is ready, once per drop (r.posted is the run's one claim).
  if (b.source === "video-card" && r.posted && r.totals.landed > 0 && typeof b.cardId === "string") {
    const card = await db().query.videoProjects.findFirst({ where: eq(schema.videoProjects.id, b.cardId), columns: { id: true, listingId: true }, with: { listing: { columns: { address: true, nda: true } } } }).catch(() => null);
    if (card && card.listingId === listing.id) {
      const names = (Array.isArray(b.done) ? b.done : []).map((n: unknown) => String(n ?? "").slice(0, 120)).filter(Boolean).slice(0, 20);
      await videoEditingCutReady({ cardId: card.id, listing: card.listing, count: r.totals.landed, names, by: who.actor ?? "the video team" }).catch((e) => console.error("[upload-done] video editing", e));
      // Nov 5 2026: a cut uploaded = a cut to check. The card moves to In review on its own.
      await videoCutInReview(card.id, who.actor ?? "the video team", r.totals.landed).catch((e) => console.error("[upload-done] video card to review", e));
    }
  }
  return Response.json({ ok: true, posted: r.posted, totals: r.totals });
}
