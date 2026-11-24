// GET /api/studio/intake-file?booking=<id>&key=<key>: opens a file the client
// attached to a booking (the plat map), for admins only. The key must be one
// the booking's own payload lists, under its own submission id
// (bookingAttachments in src/lib/intake-files.ts), and still in R2.
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireAdminApi } from "@/lib/admin";
import { INTAKE_MAX_BYTES, bookingAttachments } from "@/lib/intake-files";
import { hasR2, headObject, signedDownloadUrl } from "@/lib/r2";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const admin = await requireAdminApi();
  if (admin instanceof Response) return admin;
  if (!hasDb() || !hasR2()) return new Response("not available", { status: 503 });
  const url = new URL(req.url);
  const bookingId = url.searchParams.get("booking") || "";
  const key = url.searchParams.get("key") || "";
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return new Response("not found", { status: 404 });
  const b = await db().query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), columns: { id: true, raw: true } });
  const file = b ? bookingAttachments(b.raw, b.id).find((a) => a.key === key) : undefined;
  if (!file) return new Response("not found", { status: 404 });
  const head = await headObject(file.key);
  if (!head || head.size > INTAKE_MAX_BYTES) return new Response("That file never finished uploading.", { status: 404 });
  return Response.redirect(await signedDownloadUrl(file.key, file.name, 300), 302);
}
