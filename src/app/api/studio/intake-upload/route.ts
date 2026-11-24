// POST /api/studio/intake-upload: a short-lived upload address for a file the
// client attaches on the website's booking form (the plat or lot map). Only
// the website asks (x-intake-secret = BOOKING_INTAKE_SECRET); 404 until that
// is set. The browser then PUTs the file straight to R2, so the bucket's
// CORS policy must allow the website's address (HANDOFF.md, "Plat map upload").
// See src/lib/intake-files.ts.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { checkUpload, intakeKey } from "@/lib/intake-files";
import { hasR2, presignedPutUrl } from "@/lib/r2";

export const dynamic = "force-dynamic";

function same(given: string, secret: string): boolean {
  return Boolean(secret) && Boolean(given) && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

export async function POST(request: Request) {
  if (!same((request.headers.get("x-intake-secret") || "").trim(), (process.env.BOOKING_INTAKE_SECRET || "").trim())) {
    return Response.json({ ok: false }, { status: 404 });
  }
  if (!hasR2()) return Response.json({ ok: false, error: "Uploads aren't switched on yet. Please send a link instead." }, { status: 503 });
  let b: Record<string, unknown>;
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "send JSON" }, { status: 400 });
  }
  const submissionId = String(b.submission_id ?? "").trim().toLowerCase();
  const contentType = String(b.content_type ?? "").trim().toLowerCase();
  const size = Number(b.size);
  const name = String(b.filename ?? "").slice(0, 200);
  const bad = checkUpload({ submissionId, contentType, size });
  if (bad) return Response.json({ ok: false, error: bad }, { status: 400 });
  const key = intakeKey(submissionId, name, contentType, randomBytes(5).toString("hex"));
  if (!key) return Response.json({ ok: false, error: "submission_id" }, { status: 400 });
  const url = await presignedPutUrl(key, contentType, 600);
  return Response.json({ ok: true, key, url, contentType });
}
