"use server";
// Upload a shoot, step 1: the shooter picks THE LISTING, by address. The most
// recently created listings come first; typing searches address, client name,
// email and company across every listing. Admins and creative specialists
// (the only server action a creative specialist may call, Oct 21 2026).
import { assertUploader } from "@/lib/admin";
import { adminListings } from "@/lib/admin-data";
import { derivativeKey } from "@/lib/media-keys";
import { hasR2, signedViewUrl } from "@/lib/r2";
import type { LiteClient, LiteListing } from "./actions";

export type PickListing = LiteListing & {
  client: LiteClient;
  createdAt: string;
  mediaCount: number;
  thumb: string | null;
};

export async function pickListings(q: string): Promise<PickListing[]> {
  await assertUploader();
  const rows = await adminListings({ q: q.trim() || undefined, sort: "updated" });
  const recent = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, q.trim() ? 20 : 12);
  return Promise.all(
    recent.map(async (l) => ({
      id: l.id,
      address: l.address,
      slug: l.slug,
      shootDate: l.shootDate,
      nda: l.nda,
      createdAt: l.createdAt,
      mediaCount: l.mediaCount,
      client: { id: l.clientId, email: l.clientEmail, name: l.clientName, company: l.clientCompany },
      thumb: l.coverKey && hasR2() ? await signedViewUrl(derivativeKey(l.coverKey, "thumb")).catch(() => null) : null,
    }))
  );
}
