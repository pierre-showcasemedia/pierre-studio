// The opened photo in final review (FrameViewer): redirects to the signed
// 2048px derivative (?size=large; built on first view when the pipeline did
// not make one, like the thumb route) or to the signed original (?size=full,
// the Z zoom at one image pixel per screen pixel). Admins and the QA team,
// every frame, internal ones too; never a client route.
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireStaffApi } from "@/lib/admin";
import { derivativeKey } from "@/lib/media-keys";
import { getObjectBuffer, hasR2, objectExists, putObject, signedViewUrl } from "@/lib/r2";
import { makeMls } from "@/lib/derivatives";
import { withOriginalSlot } from "@/lib/image-gate";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const admin = await requireStaffApi();
  if (admin instanceof Response) return admin;
  if (!hasDb() || !hasR2()) return new Response("not available", { status: 503 });
  const { mediaId } = await params;
  const full = new URL(req.url).searchParams.get("size") === "full";
  const m = await db().query.media.findFirst({ where: eq(schema.media.id, mediaId), columns: { r2Key: true, kind: true } });
  if (!m || m.kind !== "photo") return new Response("not found", { status: 404 });
  if (full) return Response.redirect(await signedViewUrl(m.r2Key), 302);
  const key = derivativeKey(m.r2Key, "mls");
  if (!(await objectExists(key))) {
    try {
      // One original in memory per slot (src/lib/image-gate.ts); a request that waited may find it made.
      await withOriginalSlot(async () => {
        if (await objectExists(key)) return;
        const { body } = await getObjectBuffer(m.r2Key);
        await putObject(key, await makeMls(body), "image/jpeg");
      });
    } catch (e) {
      console.error("[studio/frame]", e);
      return new Response("photo unavailable", { status: 502 });
    }
  }
  return Response.redirect(await signedViewUrl(key), 302);
}
