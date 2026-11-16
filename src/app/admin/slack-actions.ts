"use server";
// Settings → Slack QC tags (Oct 26 2026, src/lib/slack-qc.ts): who the hub
// pings for photo QC, for video QC and for a final review. Admin only.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { hasDb } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { qcIds, saveQcTags } from "@/lib/slack-qc";

export async function saveSlackQcTags(formData: FormData): Promise<void> {
  await requireAdmin();
  const photo = String(formData.get("photo") ?? "");
  const video = String(formData.get("video") ?? "");
  const final = String(formData.get("final") ?? "");
  const bad = [photo, video, final].some((v) => v.trim() && !qcIds(v).length);
  if (bad) redirect(`/admin/settings?error=${encodeURIComponent("Paste a Slack group ID (starts with S) or member IDs (start with U).")}#slack`);
  if (hasDb()) await saveQcTags({ photo, video, final });
  revalidatePath("/admin/settings");
  redirect("/admin/settings?saved=slack#slack");
}
