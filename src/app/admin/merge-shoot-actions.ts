"use server";
// Merge this shoot into another shoot of the same listing (Nov 5 2026;
// src/lib/merge-shoot.ts): the preview on /admin/shoots/<id>/merge, then
// this. Admins only. The client visible photos of both shoots stay on the
// kept shoot, every other frame of both is deleted (files stay in storage),
// and the merged shoot is deleted, in one transaction. Never an email, a
// Slack line or a calendar change.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { hasDb } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { mergeShoot } from "@/lib/merge-shoot";

const enc = (s: string) => encodeURIComponent(s);
const field = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function mergeShootInto(fromId: string, intoId: string, formData: FormData) {
  const actor = await requireAdmin();
  const back = `/admin/shoots/${fromId}/merge?into=${enc(intoId)}`;
  if (!hasDb()) redirect(`${back}&error=${enc("Demo mode: nothing is saved.")}`);
  let to: string;
  try {
    if (field(formData, "confirm").toUpperCase() !== "MERGE") throw new Error("Type MERGE to confirm.");
    const plan = await mergeShoot({
      fromShootId: fromId,
      intoShootId: intoId,
      apply: true,
      allowRevisionLoss: field(formData, "allowRevisionLoss") === "1",
      expect: field(formData, "expect") || null,
      actor,
      reason: field(formData, "reason") || null,
    });
    if (!plan.applied) throw new Error(plan.refused[0] ?? "The merge did not run.");
    if (plan.listing) revalidatePath(`/admin/listings/${plan.listing.id}`);
    revalidatePath(`/admin/shoots/${intoId}`);
    revalidatePath("/admin/photo-qc");
    revalidatePath("/portal");
    to = `/admin/shoots/${intoId}?merged=${plan.result?.kept ?? 0}.${plan.result?.deleted ?? 0}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[merge-shoot-actions]", msg);
    to = `${back}&error=${enc(msg.slice(0, 200))}`;
  }
  redirect(to);
}
