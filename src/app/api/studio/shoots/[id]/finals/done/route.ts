// "Upload finals", step 3 (Oct 28 2026): the uploader is done.
//   review: true   Send for final review: the corrected photos go to the
//                  final pass, one tagged hub line (src/lib/final-review.ts).
//                  Without a run it sends the shoot on its own (the shoot
//                  page's Send for final review panel). While a send is
//                  open (not published since) it sends again only with
//                  again: true (Nov 3 2026).
//   review: false  Upload only: the run posts its usual one "Upload
//                  finished" line (src/lib/upload-runs.ts).
// Calling it twice posts once. Admins and the QA team.
// POST { run?, total?, failed?: [{ name, error }], review?, again?, published? }
//   → { ok, sent?, posted?, corrected?, failed? }
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireStaffApi } from "@/lib/admin";
import { sendForFinalReview } from "@/lib/final-review";
import { cleanRun, finishUploadRun, type RunFailure } from "@/lib/upload-runs";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi();
  if (staff instanceof Response) return staff;
  if (!hasDb()) return Response.json({ ok: true, demo: true, sent: false });
  const { id } = await params;
  const shoot = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, id), columns: { id: true, listingId: true } });
  if (!shoot) return Response.json({ ok: false, error: "Shoot not found." }, { status: 404 });
  const b = await request.json().catch(() => ({}));
  const run = cleanRun(b.run);
  const failed: RunFailure[] = (Array.isArray(b.failed) ? b.failed : [])
    .slice(0, 500)
    .map((f: { name?: unknown; error?: unknown }) => ({ name: String(f?.name ?? "").slice(0, 200), error: String(f?.error ?? "failed").slice(0, 300) }))
    .filter((f: RunFailure) => f.name);
  const total = Number.isFinite(Number(b.total)) ? Math.max(0, Math.min(5000, Math.round(Number(b.total)))) : null;
  try {
    if (b.review === true) {
      const r = await sendForFinalReview({ shootId: shoot.id, actor: staff.email, run, total, failed, again: b.again === true });
      return Response.json(r, { status: r.ok ? 200 : 409 });
    }
    if (!run) return Response.json({ ok: false, error: "run is required." }, { status: 400 });
    const r = await finishUploadRun({ run, listingId: shoot.listingId, actor: staff.email, total, failed, published: typeof b.published === "boolean" ? b.published : null });
    return Response.json({ ok: true, posted: r.posted, corrected: r.totals.corrected });
  } catch (e) {
    console.error("[finals/done]", e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
