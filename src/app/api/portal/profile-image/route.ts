// The agent's headshot and brokerage logo (src/lib/profile-images.ts). A plain
// form post from the portal's Account tab (multipart: kind, file, or
// op=remove), answered with a 303 back to the tab and a short note. The
// signed-in client only (view as works for an admin helping them); a partner
// login is refused. Same origin only, and the client is looked up by the
// lower case email. A 404 while business.profileImages is off.
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { logActivity } from "@/lib/activity";
import { isPartnerEmail } from "@/lib/partner";
import { realSessionEmail, sessionEmail } from "@/lib/portal-auth";
import { business } from "@/lib/business";
import { deleteObject, hasR2, putObject } from "@/lib/r2";
import { siteUrl } from "@/lib/brand";
import { isProfileKey, isProfileKind, PROFILE_IMAGE_MAX_BYTES, PROFILE_IMAGE_MAX_PIXELS, PROFILE_OUTPUT, profileImageKey, profileImageRefusal, profileLookupEmail, sameOriginPost, type ProfileKind } from "@/lib/profile-images";

export const runtime = "nodejs";

const back = (request: Request, key: "saved" | "error", text: string) => Response.redirect(new URL(`/portal?tab=account&${key}=${encodeURIComponent(text)}`, request.url), 303);

const LABEL: Record<ProfileKind, string> = { headshot: "headshot", logo: "logo" };

export async function POST(request: Request) {
  if (!business.profileImages) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  // A post from another site is refused before anything is read.
  if (!sameOriginPost(request.headers.get("origin"), [siteUrl(), new URL(request.url).origin])) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const email = await sessionEmail();
  if (!email) return Response.redirect(new URL("/portal/login", request.url), 303);
  if (isPartnerEmail(email)) return back(request, "error", "This account cannot change a profile.");
  // A request bigger than the image limit plus the form's own few bytes is refused before it is read.
  const length = Number(request.headers.get("content-length") || 0);
  if (length > PROFILE_IMAGE_MAX_BYTES + 256 * 1024) return back(request, "error", "That image is larger than 4 MB. Please choose a smaller one.");
  const form = await request.formData().catch(() => null);
  if (!form) return back(request, "error", "That upload did not come through. Please try again.");
  const kind = form.get("kind");
  if (!isProfileKind(kind)) return back(request, "error", "That upload did not come through. Please try again.");
  if (!hasDb()) return back(request, "saved", "Demo mode: nothing was saved.");
  const d = db();
  const client = await d.query.clients.findFirst({ where: eq(schema.clients.email, profileLookupEmail(email)), columns: { id: true, headshotKey: true, logoKey: true } });
  if (!client) return back(request, "error", "We could not find your account. Please contact us.");
  const column = kind === "headshot" ? "headshotKey" : "logoKey";
  const old = client[column];
  const actor = (await realSessionEmail()) ?? email;

  if (form.get("op") === "remove") {
    await d.update(schema.clients).set({ [column]: null }).where(eq(schema.clients.id, client.id));
    if (hasR2() && isProfileKey(old, client.id)) await deleteObject(old!).catch((e) => console.error("[profile-image] remove", e));
    await logActivity({ actorEmail: actor, action: "client.updated", clientId: client.id, meta: { email, profile: kind, removed: true } });
    return back(request, "saved", `Your ${LABEL[kind]} was removed.`);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return back(request, "error", "Choose an image to upload.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const refusal = profileImageRefusal({ size: bytes.length, head: bytes.slice(0, 16) });
  if (refusal) return back(request, "error", refusal);
  if (!hasR2()) return back(request, "error", "Uploads are not available right now. Please try again later.");

  // Decode and re-encode: proves it is an image, drops the metadata (location
  // and the rest), turns it upright and bounds its size.
  const out = PROFILE_OUTPUT[kind];
  let body: Buffer;
  try {
    const img = sharp(bytes, { limitInputPixels: PROFILE_IMAGE_MAX_PIXELS, failOn: "error" }).rotate().resize({ width: out.width, height: out.height, fit: "inside", withoutEnlargement: true });
    body = out.format === "jpeg" ? await img.flatten({ background: "#ffffff" }).jpeg({ quality: 86, mozjpeg: true }).toBuffer() : await img.png({ compressionLevel: 9 }).toBuffer();
  } catch {
    return back(request, "error", "That image could not be read. Please try a different file.");
  }

  const key = profileImageKey(client.id, kind, randomBytes(8).toString("hex"));
  await putObject(key, body, out.contentType);
  await d.update(schema.clients).set({ [column]: key }).where(eq(schema.clients.id, client.id));
  if (old && old !== key && isProfileKey(old, client.id)) await deleteObject(old).catch((e) => console.error("[profile-image] old", e));
  await logActivity({ actorEmail: actor, action: "client.updated", clientId: client.id, meta: { email, profile: kind } });
  return back(request, "saved", `Your ${LABEL[kind]} is saved. It shows on your property pages.`);
}
