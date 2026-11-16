// Admin thumbnail for a frame: redirects to the signed thumb derivative, and
// builds it on first view if the pipeline has not made it yet. Admins and the
// QA team (every frame, internal ones too); never a client route.
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireStaffApi } from "@/lib/admin";
import { derivativeKey } from "@/lib/media-keys";
import { getObjectBuffer, hasR2, objectExists, putObject, signedViewUrl } from "@/lib/r2";
import { makeThumb } from "@/lib/derivatives";
import { withOriginalSlot } from "@/lib/image-gate";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const admin = await requireStaffApi();
  if (admin instanceof Response) return admin;
  if (!hasDb() || !hasR2()) return new Response("not available", { status: 503 });
  const { mediaId } = await params;
  const m = await db().query.media.findFirst({ where: eq(schema.media.id, mediaId), columns: { r2Key: true, kind: true } });
  if (!m || m.kind !== "photo") return new Response("not found", { status: 404 });
  const key = derivativeKey(m.r2Key, "thumb");
  if (!(await objectExists(key))) {
    try {
      // The grid asks for every missing thumb at the same moment: they take
      // turns (src/lib/image-gate.ts), and one that waited may find it made.
      await withOriginalSlot(async () => {
        if (await objectExists(key)) return;
        const { body } = await getObjectBuffer(m.r2Key);
        await putObject(key, await makeThumb(body), "image/jpeg");
      });
    } catch (e) {
      console.error("[studio/thumb]", e);
      return new Response("thumb unavailable", { status: 502 });
    }
  }
  return Response.redirect(await signedViewUrl(key), 302);
}
