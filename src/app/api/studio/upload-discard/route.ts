// Start over on an upload that never reached Submit (Oct 30 2026): the draft
// shoot, every file of it in storage and any Dropbox copy are removed
// (src/lib/discard-upload.ts). Admin or creative specialist; a creative
// specialist only for an upload they started.
// POST { shootId, listingId } → { ok, removed }
import { hasDb } from "@/db";
import { currentStaff, requireUploaderApi } from "@/lib/admin";
import { discardDraftShoot } from "@/lib/discard-upload";
import { hasR2 } from "@/lib/r2";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const who = await requireUploaderApi();
  if (who instanceof Response) return who;
  if (!hasDb() || !hasR2()) return Response.json({ ok: true, demo: true });

  const b = await request.json().catch(() => ({}));
  const shootId = typeof b.shootId === "string" ? b.shootId : "";
  const listingId = typeof b.listingId === "string" ? b.listingId : "";
  if (!shootId || !listingId) return Response.json({ ok: false, error: "shootId and listingId are required." }, { status: 400 });

  const staff = await currentStaff();
  if (staff?.role !== "admin") {
    const plan = await discardDraftShoot({ shootId, listingId, actor: who, apply: false });
    if (plan.ok && plan.plan.createdBy.toLowerCase() !== who.toLowerCase()) return Response.json({ ok: false, error: "Only the person who started this upload, or an admin, can start it over." }, { status: 403 });
  }
  const r = await discardDraftShoot({ shootId, listingId, actor: who, apply: true });
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: r.status });
  return Response.json({ ok: true, removed: r.removed });
}
