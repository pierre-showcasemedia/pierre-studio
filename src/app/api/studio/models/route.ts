// Editing options for the upload wizard: live models when the editing
// account is connected, a static list otherwise. Admins and creative
// specialists. (Oct 27 2026: no twilight looks any more; every twilight is
// the Champagne preset, src/lib/twilight-preset.ts.)
import { requireUploaderApi } from "@/lib/admin";
import { FALLBACK_MODELS, hasAutoHdr, listModels } from "@/lib/autohdr";

export const dynamic = "force-dynamic";

let cache: { at: number; models: typeof FALLBACK_MODELS } | null = null;

export async function GET() {
  const admin = await requireUploaderApi();
  if (admin instanceof Response) return admin;
  const connected = hasAutoHdr();
  if (!connected) return Response.json({ ok: true, connected: false, models: FALLBACK_MODELS.filter((m) => m.id === 37) });
  if (cache && Date.now() - cache.at < 5 * 60_000) return Response.json({ ok: true, connected: true, models: cache.models, cached: true });
  try {
    const models = await listModels();
    cache = { at: Date.now(), models };
    return Response.json({ ok: true, connected: true, models });
  } catch (e) {
    console.error("[studio/models]", e);
    return Response.json({ ok: true, connected: true, models: FALLBACK_MODELS, error: e instanceof Error ? e.message : String(e) });
  }
}
