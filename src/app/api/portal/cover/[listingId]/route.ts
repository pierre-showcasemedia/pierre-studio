// Public cover image for a listing, used by the delivery email, where a
// 1-hour signed URL would break after the first hour. Serves the preview
// derivative of the cover (or first photo). Listing IDs are UUIDs, so the
// URL is unguessable; only the watermark-free preview is ever exposed for
// unlocked listings, the watermarked one while locked.
import { eq, asc } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { derivativeKey } from "@/lib/media-keys";
import { hasR2, signedViewUrl } from "@/lib/r2";
import { clientMediaWhere, clientVisibleMedia } from "@/lib/media-visibility";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  if (!hasDb() || !hasR2()) return new Response("not available", { status: 503 });
  const l = await db().query.listings.findFirst({
    where: eq(schema.listings.id, listingId),
    with: { media: { orderBy: [asc(schema.media.sort)], where: clientMediaWhere() }, shoots: { columns: { id: true, publishedAt: true } } },
  });
  if (!l) return new Response("not found", { status: 404 });
  const visible = clientVisibleMedia(l.media, l.shoots);
  // The cover must itself be client-visible: a cover set from an unpublished frame falls back.
  const coverOk = l.coverKey ? visible.some((m) => m.r2Key === l.coverKey) : false;
  const key = (coverOk ? l.coverKey : null) ?? visible.find((m) => m.kind === "photo")?.r2Key;
  if (!key) return new Response("no cover", { status: 404 });
  const variant = l.downloadLocked ? "preview-wm" : "preview";
  const url = await signedViewUrl(derivativeKey(key, variant));
  const r2 = await fetch(url);
  if (!r2.ok) return new Response("cover unavailable", { status: 502 });
  return new Response(r2.body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  });
}
