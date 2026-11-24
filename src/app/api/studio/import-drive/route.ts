// Import from Google Drive (Nov 18 2026), the Dropbox import's twin: the team
// member picks files in Google's Picker (signed in to their own Google
// account, drive.file only: the site sees just the files they pick), and the
// server streams each one from Drive into R2, so nothing passes through the
// phone. A few files per request; the browser loops. The Google token comes
// with each request and is never stored. Admin or creative specialist session.
// POST { shootId?, listingId, token, files: [{ id, name }], kind? }
//   → { shootId, imported: [{ filename, bytes }], failed: [{ filename, error }] }
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireUploaderApi } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { hasR2, safeFilename, streamToR2 } from "@/lib/r2";
import { contentTypeFor } from "@/lib/autohdr-constants";
import { driveApiWithToken, DriveError, FOLDER_MIME } from "@/lib/google-drive";
import { onDrive } from "@/lib/file-store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const MAX_PER_CALL = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const admin = await requireUploaderApi();
  if (admin instanceof Response) return admin;
  // Nov 24 2026: only a business on Google Drive (business.fileStore) imports from it.
  if (!onDrive()) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  if (!hasDb()) return Response.json({ ok: false, demo: true, error: "Demo mode: no database." }, { status: 503 });
  if (!hasR2()) return Response.json({ ok: false, error: "Storage is not connected (R2 env vars missing)." }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const listingId = String(b.listingId || "");
  const token = typeof b.token === "string" ? b.token.trim() : "";
  const kind: "raw" | "display" = b.kind === "display" ? "display" : "raw";
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, MAX_PER_CALL) as { id: string; name: string }[];
  if (!listingId || !token || !files.length) return Response.json({ ok: false, error: "listingId, token and files are required." }, { status: 400 });

  const d = db();
  // Nov 24 2026: the listing must exist before a shoot is made for it.
  const listing = UUID_RE.test(listingId) ? await d.query.listings.findFirst({ where: eq(schema.listings.id, listingId), columns: { id: true } }) : null;
  if (!listing) return Response.json({ ok: false, error: "Listing not found." }, { status: 404 });
  let shootId = typeof b.shootId === "string" && b.shootId ? b.shootId : null;
  if (shootId) {
    const s = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { id: true, status: true, listingId: true } });
    if (!s || s.listingId !== listingId) return Response.json({ ok: false, error: "Shoot not found." }, { status: 404 });
    if (s.status !== "draft") return Response.json({ ok: false, error: "This shoot was already submitted." }, { status: 409 });
  } else {
    const [s] = await d.insert(schema.shoots).values({ listingId, createdBy: admin, status: "draft" }).returning({ id: schema.shoots.id });
    shootId = s.id;
    await logActivity({ actorEmail: admin, action: "shoot.created", shootId, listingId, meta: { source: "google_drive" } });
  }

  const api = driveApiWithToken(token);
  const imported: { filename: string; bytes: number }[] = [];
  const failed: { filename: string; error: string }[] = [];
  for (const f of files) {
    const safe = safeFilename(String(f.name || ""));
    try {
      const id = String(f.id || "");
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new Error("Not a Google Drive file.");
      const meta = await api.getFile(id);
      if (!meta) throw new Error("Google Drive could not find it (or it was not shared with this site).");
      if (meta.mimeType === FOLDER_MIME || meta.mimeType.startsWith("application/vnd.google-apps.")) throw new Error("Pick photo files, not folders or Google documents.");
      const r = await api.download(id);
      if (!r.body) throw new Error("Google Drive sent nothing.");
      const key = `shoots/${shootId}/raw/${safe}`;
      const contentType = contentTypeFor(safe, meta.mimeType || "application/octet-stream");
      const bytes = await streamToR2(key, r.body, contentType);
      const existing = await d.query.shootFiles.findFirst({ where: eq(schema.shootFiles.r2Key, key), columns: { id: true } });
      if (existing) await d.update(schema.shootFiles).set({ bytes, contentType }).where(eq(schema.shootFiles.id, existing.id));
      else await d.insert(schema.shootFiles).values({ shootId, filename: safe, r2Key: key, bytes, contentType, kind });
      imported.push({ filename: safe, bytes });
    } catch (e) {
      const msg = e instanceof DriveError && (e.status === 401 || e.status === 403) ? "Google sign-in ran out. Choose from Google Drive again." : e instanceof Error ? e.message : String(e);
      failed.push({ filename: safe, error: msg.slice(0, 160) });
    }
  }
  const count = await d.query.shootFiles.findMany({ where: eq(schema.shootFiles.shootId, shootId), columns: { id: true } });
  await d.update(schema.shoots).set({ fileCount: count.length, updatedAt: new Date() }).where(eq(schema.shoots.id, shootId));
  return Response.json({ ok: true, shootId, imported, failed });
}
