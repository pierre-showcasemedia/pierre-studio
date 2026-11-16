// Dropbox Chooser import: the server fetches each direct link and streams it
// into R2, so nothing passes through the phone. A few files per request; the
// client loops. Admin or creative specialist session.
// POST { shootId?, listingId, files: [{ link, name, bytes? }], kind? }
//   → { shootId, imported: [{ filename, bytes }], failed: [{ filename, error }] }
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireUploaderApi } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { hasR2, safeFilename, streamToR2 } from "@/lib/r2";
import { contentTypeFor } from "@/lib/autohdr-constants";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const MAX_PER_CALL = 5;

export async function POST(request: Request) {
  const admin = await requireUploaderApi();
  if (admin instanceof Response) return admin;
  if (!hasDb()) return Response.json({ ok: false, demo: true, error: "Demo mode: no database." }, { status: 503 });
  if (!hasR2()) return Response.json({ ok: false, error: "Storage is not connected (R2 env vars missing)." }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const listingId = String(b.listingId || "");
  const kind: "raw" | "display" = b.kind === "display" ? "display" : "raw";
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, MAX_PER_CALL) as { link: string; name: string; bytes?: number }[];
  if (!listingId || !files.length) return Response.json({ ok: false, error: "listingId and files are required." }, { status: 400 });

  const d = db();
  let shootId = typeof b.shootId === "string" && b.shootId ? b.shootId : null;
  if (shootId) {
    const s = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { id: true, status: true, listingId: true } });
    if (!s || s.listingId !== listingId) return Response.json({ ok: false, error: "Shoot not found." }, { status: 404 });
    if (s.status !== "draft") return Response.json({ ok: false, error: "This shoot was already submitted." }, { status: 409 });
  } else {
    const [s] = await d.insert(schema.shoots).values({ listingId, createdBy: admin, status: "draft" }).returning({ id: schema.shoots.id });
    shootId = s.id;
    await logActivity({ actorEmail: admin, action: "shoot.created", shootId, listingId, meta: { source: "dropbox" } });
  }

  const imported: { filename: string; bytes: number }[] = [];
  const failed: { filename: string; error: string }[] = [];
  for (const f of files) {
    const safe = safeFilename(String(f.name || ""));
    try {
      const u = new URL(String(f.link));
      if (!/(^|\.)dropbox(usercontent)?\.com$/.test(u.hostname)) throw new Error("Only Dropbox links are accepted.");
      const r = await fetch(u.toString(), { cache: "no-store" });
      if (!r.ok || !r.body) throw new Error(`Dropbox responded ${r.status}`);
      const key = `shoots/${shootId}/raw/${safe}`;
      const contentType = contentTypeFor(safe, r.headers.get("content-type") || "application/octet-stream");
      const bytes = await streamToR2(key, r.body, contentType);
      const existing = await d.query.shootFiles.findFirst({ where: eq(schema.shootFiles.r2Key, key), columns: { id: true } });
      if (existing) await d.update(schema.shootFiles).set({ bytes, contentType }).where(eq(schema.shootFiles.id, existing.id));
      else await d.insert(schema.shootFiles).values({ shootId, filename: safe, r2Key: key, bytes, contentType, kind });
      imported.push({ filename: safe, bytes });
    } catch (e) {
      failed.push({ filename: safe, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const count = await d.query.shootFiles.findMany({ where: eq(schema.shootFiles.shootId, shootId), columns: { id: true } });
  await d.update(schema.shoots).set({ fileCount: count.length, updatedAt: new Date() }).where(eq(schema.shoots.id, shootId));
  return Response.json({ ok: true, shootId, imported, failed });
}
