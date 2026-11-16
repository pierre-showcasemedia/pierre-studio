// Every virtual twilight is the owner's "Champagne" preset (Oct 27 2026).
//
// the owner saves Champagne in the AutoHDR account (Luxe, edit-to-edit on
// the Aura edit) and pastes its link on /admin/settings. The twilight step
// (src/lib/pipeline.ts) runs that preset by uuid on the chosen exteriors'
// Aura versions; there is no look picker any more. Until it is set, a shoot
// that asked for twilight waits in the twilight step and the hub hears once.
// Stored in the settings table under TWILIGHT_PRESET_KEY; a uuid is not a
// secret.
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";

export const TWILIGHT_PRESET_KEY = "twilight.preset";
// What shoots record as their twilight look from now on.
export const TWILIGHT_LOOK_ID = "champagne";

export type TwilightPreset = { uuid: string; name: string; creditCost: number | null; savedBy: string; savedAt: string };

// The preset id in what was pasted: a bare id, or the AutoHDR editor's
// address with the preset picked (new.autohdr.com/edit?preset=<id>, which
// may also carry ?enh=<another id>). A private preset has no share link, so
// the editor's address is what the owner copies.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function presetUuidFrom(raw: string): string | null {
  const s = (raw || "").toLowerCase();
  const named = s.match(new RegExp(`preset[_=/:-]+(${UUID})`));
  if (named) return named[1];
  const m = s.match(new RegExp(UUID));
  return m ? m[0] : null;
}

let cache: { at: number; preset: TwilightPreset | null } | null = null;

export async function twilightPreset(): Promise<TwilightPreset | null> {
  if (!hasDb()) return null;
  if (cache && Date.now() - cache.at < 60_000) return cache.preset;
  let preset: TwilightPreset | null = null;
  try {
    const row = await db().query.settings.findFirst({ where: eq(schema.settings.key, TWILIGHT_PRESET_KEY) });
    const v = (row?.value ?? null) as Partial<TwilightPreset> | null;
    if (v && typeof v.uuid === "string" && presetUuidFrom(v.uuid)) {
      preset = { uuid: v.uuid, name: typeof v.name === "string" ? v.name : "Champagne", creditCost: typeof v.creditCost === "number" ? v.creditCost : null, savedBy: typeof v.savedBy === "string" ? v.savedBy : "", savedAt: typeof v.savedAt === "string" ? v.savedAt : "" };
    }
  } catch (e) {
    console.error("[twilight-preset] read", e);
  }
  cache = { at: Date.now(), preset };
  return preset;
}

export async function saveTwilightPreset(p: Omit<TwilightPreset, "savedAt">): Promise<void> {
  const value = { ...p, savedAt: new Date().toISOString() };
  await db()
    .insert(schema.settings)
    .values({ key: TWILIGHT_PRESET_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  cache = null;
}

// A shoot's twilight look as a name: Champagne now, the old looks by name.
export function twilightLookName(look: string | null | undefined, oldLooks: { id: string; name: string }[]): string | null {
  if (!look) return null;
  if (look === TWILIGHT_LOOK_ID) return "Champagne";
  return oldLooks.find((l) => l.id === look)?.name ?? look;
}
