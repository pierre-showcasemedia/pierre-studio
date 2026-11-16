"use server";
// The shoot page's frame actions (Oct 28 2026, src/lib/frame-publish.ts):
// publish chosen frames to the client now (admins and the Photo QC team,
// who already publish), optionally hiding every other frame ("Publish finals
// only"), and delete frames (admins only; the Photo QC team moves them to
// internal only instead). Answers instead of redirecting so the grid stays
// optimistic.
import { revalidatePath } from "next/cache";
import { hasDb } from "@/db";
import { requireAdmin, requireStaff } from "@/lib/admin";
import { deleteFrames, MAX_FRAME_IDS, publishFrames } from "@/lib/frame-publish";
import type { Destination } from "@/lib/publish-plan";

export type FrameActionResult =
  | { ok: true; live?: number; hidden?: number; deleted?: number; firstPublish?: boolean; destination?: Destination; skipped?: { rejected: number; pending: number }; listingId: string }
  | { ok: false; error: string; demo?: boolean };

const cleanIds = (ids: unknown): string[] => (Array.isArray(ids) ? ids.map(String).filter(Boolean).slice(0, MAX_FRAME_IDS) : []);
const fail = (e: unknown): FrameActionResult => {
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 160);
  console.error("[frame-actions]", msg);
  return { ok: false, error: msg };
};
const refresh = (shootId: string, listingId: string) => {
  revalidatePath(`/admin/shoots/${shootId}`);
  revalidatePath(`/admin/listings/${listingId}`);
  revalidatePath("/admin/photo-qc");
  revalidatePath("/portal");
};

// Only the approved frames among ids go live (src/lib/frame-publish.ts); the
// rest come back counted in skipped. destination "revised" = the client's
// Revised images section.
export async function publishShootFrames(input: { shootId: string; ids: string[]; hideOthers?: boolean; destination?: Destination }): Promise<FrameActionResult> {
  const staff = await requireStaff();
  if (!hasDb()) return { ok: false, demo: true, error: "Demo mode: nothing is saved." };
  try {
    const shootId = String(input?.shootId ?? "");
    const r = await publishFrames(staff.email, shootId, cleanIds(input?.ids), { hideOthers: Boolean(input?.hideOthers), destination: input?.destination === "revised" ? "revised" : "gallery" });
    refresh(shootId, r.listingId);
    return { ok: true, live: r.live, hidden: r.hidden, firstPublish: r.firstPublish, destination: r.destination, skipped: r.skipped, listingId: r.listingId };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteShootFrames(input: { shootId: string; ids: string[] }): Promise<FrameActionResult> {
  const actor = await requireAdmin();
  if (!hasDb()) return { ok: false, demo: true, error: "Demo mode: nothing is saved." };
  try {
    const shootId = String(input?.shootId ?? "");
    const r = await deleteFrames(actor, shootId, cleanIds(input?.ids));
    refresh(shootId, r.listingId);
    return { ok: true, deleted: r.count, listingId: r.listingId };
  } catch (e) {
    return fail(e);
  }
}
