"use server";
// "Client visible" / "Internal only" (Oct 2026): the toggle on every frame of
// the listing media grid and the shoot review grid, in bulk too, and the
// upload panel's "Client visible" choice. Admins and the QA team. The gate is
// re-checked here; the work is src/lib/visibility-core.ts. Answers instead of
// redirecting so the grids stay optimistic.
import { revalidatePath } from "next/cache";
import { hasDb } from "@/db";
import { requireStaff } from "@/lib/admin";
import { applyVisibility, MAX_VISIBILITY_IDS, type VisibilityTarget } from "@/lib/visibility-core";

export type VisibilityResult = { ok: true; count: number; live: number; waiting: number } | { ok: false; error: string; demo?: boolean };

export async function setMediaVisibility(input: { listingId?: string | null; shootId?: string | null; ids: string[]; to: VisibilityTarget; via?: "listing" | "shoot" | "upload" }): Promise<VisibilityResult> {
  const staff = await requireStaff();
  if (!hasDb()) return { ok: false, demo: true, error: "Demo mode: nothing is saved." };
  try {
    const ids = Array.isArray(input?.ids) ? input.ids.map(String).slice(0, MAX_VISIBILITY_IDS) : [];
    const to = input?.to === "client" ? "client" : input?.to === "internal" ? "internal" : null;
    if (!to) return { ok: false, error: "Choose client visible or internal only." };
    const listingId = typeof input.listingId === "string" && input.listingId ? input.listingId : null;
    const shootId = typeof input.shootId === "string" && input.shootId ? input.shootId : null;
    const via = input.via === "shoot" || input.via === "upload" ? input.via : "listing";
    const r = await applyVisibility(staff.email, { listingId, shootId }, ids, to, via);
    revalidatePath(`/admin/listings/${r.listingId}`);
    if (shootId) revalidatePath(`/admin/shoots/${shootId}`);
    revalidatePath("/portal");
    return { ok: true, count: r.count, live: r.live, waiting: r.waiting };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 160);
    console.error("[visibility-actions]", msg);
    return { ok: false, error: msg };
  }
}
