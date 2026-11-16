"use server";
// Settings → Virtual twilight (Oct 27 2026, src/lib/twilight-preset.ts): the
// Champagne preset every twilight runs. The pasted link or id is checked
// against the AutoHDR account before it is saved. Admin only.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireAdmin, requireStaff } from "@/lib/admin";
import { drainJobs } from "@/lib/jobs";
import { enqueueJobs, jobKey } from "@/lib/jobs-core";
import { MAKE_TWILIGHT_STATUSES } from "@/lib/pipeline";
import { logActivity } from "@/lib/activity";
import { AutoHdrError, getPreset, hasAutoHdr, type PresetInfo } from "@/lib/autohdr";
import { presetUuidFrom, saveTwilightPreset, twilightPreset } from "@/lib/twilight-preset";
import { brand } from "@/lib/brand";

const back = (q: string) => redirect(`/admin/settings?${q}#twilight`);
const bad = (msg: string) => back(`error=${encodeURIComponent(msg)}`);

export async function saveTwilightPresetAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const uuid = presetUuidFrom(String(formData.get("preset") ?? ""));
  if (!uuid) bad(`Paste the AutoHDR editor's address with Champagne picked (it ends in ?preset=…), signed in as the ${brand.shortName} account.`);
  if (!hasDb()) bad("Demo mode: nothing is saved.");
  if (!hasAutoHdr()) bad(`The ${brand.shortName} AutoHDR account is not connected on this deployment.`);
  let info: PresetInfo | null = null;
  try {
    info = await getPreset(uuid!);
  } catch (e) {
    const status = e instanceof AutoHdrError ? e.status : 0;
    if (status === 404) bad(`The ${brand.shortName} AutoHDR account can't open that preset. Check you copied it while signed in as the ${brand.shortName} account (not your own), with Champagne picked in the editor.`);
    if (status === 403) bad(`The ${brand.shortName} AutoHDR connection isn't allowed to use presets (presets:read and presets:run). Ask AutoHDR to turn them on for this API client.`);
    bad(`AutoHDR didn't answer about that preset: ${e instanceof Error ? e.message.slice(0, 140) : "unknown error"}.`);
  }
  if (info!.makesClip) bad(`"${info!.name}" makes a video, not a photo. Pick the Champagne photo preset.`);
  if (info!.extraPorts) bad(`"${info!.name}" asks for extra photos beyond the one it edits, so it can't run on its own. Pick the Champagne preset.`);
  await saveTwilightPreset({ uuid: info!.uuid, name: info!.name, creditCost: info!.creditCost, savedBy: actor });
  await logActivity({ actorEmail: actor, action: "twilight.preset_saved", meta: { name: info!.name, credits: info!.creditCost } });
  revalidatePath("/admin/settings");
  back("saved=twilight");
}

// "Make twilight" on one opened frame (shoot page): queue the Champagne run
// (twilight.frame, src/lib/pipeline.ts) and start it now. Admins and the
// Photo QC team (Oct 28 2026): it spends editing credits, so no
// other role. Answers instead of redirecting, for the viewer.
export async function makeFrameTwilight(mediaId: string): Promise<{ ok: boolean; text: string }> {
  const actor = (await requireStaff()).email;
  if (!hasDb()) return { ok: false, text: "Demo mode: nothing runs." };
  if (!hasAutoHdr()) return { ok: false, text: `The ${brand.shortName} AutoHDR account is not connected on this deployment.` };
  const preset = await twilightPreset();
  if (!preset) return { ok: false, text: "Set the Champagne preset in Settings → Virtual twilight first." };
  const d = db();
  const m = await d.query.media.findFirst({ where: eq(schema.media.id, mediaId), columns: { id: true, shootId: true, editorImageId: true, filename: true } });
  if (!m || !m.shootId || !m.editorImageId) return { ok: false, text: "Only photos that came back from editing can be made into a twilight." };
  if (m.editorImageId.includes(":")) return { ok: false, text: "That one is already a twilight." };
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, m.shootId), columns: { id: true, status: true, listingId: true } });
  if (!shoot || !(MAKE_TWILIGHT_STATUSES as readonly string[]).includes(shoot.status)) return { ok: false, text: "Wait until editing has finished pulling this shoot in, then try again." };
  const running = await d.query.jobs.findFirst({
    where: and(eq(schema.jobs.kind, "twilight.frame"), inArray(schema.jobs.status, ["queued", "running"]), sql`${schema.jobs.payload}->>'mediaId' = ${m.id}`),
    columns: { id: true },
  });
  if (running) return { ok: true, text: `Champagne is already running on ${m.filename}.` };
  await enqueueJobs([{ kind: "twilight.frame", idempotencyKey: jobKey("twilight.frame", `${m.id}:${Date.now()}`, 1), payload: { version: 1, mediaId: m.id, requestedBy: actor }, listingId: shoot.listingId }]);
  after(() => drainJobs({ budgetMs: 50_000 }).then(() => undefined).catch((e) => console.error("[make-twilight] drain", e)));
  return { ok: true, text: `Champagne is running on ${m.filename}${preset.creditCost != null ? ` (${preset.creditCost} credits)` : ""}. The twilight lands in this shoot's Twilight section in a minute or two, internal until you approve it.` };
}
