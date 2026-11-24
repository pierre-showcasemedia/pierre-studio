// The signed-in client's headshot and logo for the portal's Account tab
// (src/lib/profile-images.ts): short-lived signed addresses, or null.
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { hasR2, signedViewUrl } from "./r2";

export type ProfileImages = { found: boolean; headshotUrl: string | null; logoUrl: string | null };

export async function profileImagesFor(email: string): Promise<ProfileImages> {
  if (!hasDb()) return { found: true, headshotUrl: null, logoUrl: null };
  const c = await db().query.clients.findFirst({ where: eq(schema.clients.email, email.trim().toLowerCase()), columns: { headshotKey: true, logoKey: true } });
  if (!c) return { found: false, headshotUrl: null, logoUrl: null };
  const url = (k: string | null) => (k && hasR2() ? signedViewUrl(k).catch(() => null) : Promise.resolve(null));
  const [headshotUrl, logoUrl] = await Promise.all([url(c.headshotKey), url(c.logoKey)]);
  return { found: true, headshotUrl, logoUrl };
}
