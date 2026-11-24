// What a client may save from a gallery, by group (Nov 18 2026: shared by
// Save to Dropbox, src/app/api/portal/dropbox-manifest, and Save to Google
// Drive, src/app/api/portal/drive-save). Pure: the routes do the gating.
import type { PortalMedia } from "./portal-data";

export type Pick = { m: PortalMedia; variant: "original" | "mls" };

const isMain = (m: PortalMedia) => !m.revision && !m.section;
export const mlsName = (filename: string) => filename.replace(/\.[^.]+$/, "") + "-MLS.jpg";

export function picksFor(group: string, media: PortalMedia[]): Pick[] | null {
  if (group === "photos") return media.filter((m) => m.kind === "photo" && isMain(m)).map((m) => ({ m, variant: "original" }));
  if (group === "mls") return media.filter((m) => m.kind === "photo" && isMain(m)).map((m) => ({ m, variant: "mls" }));
  if (group === "films") return media.filter((m) => m.kind === "video" && isMain(m)).map((m) => ({ m, variant: "original" }));
  if (group === "revised") return media.filter((m) => m.revision && !m.section).map((m) => ({ m, variant: "original" }));
  if (group.startsWith("section:")) {
    const name = group.slice("section:".length);
    if (!name) return null;
    return media.filter((m) => m.section === name).map((m) => ({ m, variant: "original" }));
  }
  return null;
}

// Two files with the same name would overwrite each other in one Dropbox
// folder: number the repeats ("name (2).jpg").
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const k = name.toLowerCase();
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  });
}

// The picks for a request body: { groups?, ids? } (no groups = every file, originals).
// null + error text when a group is unknown.
export function picksForBody(b: { groups?: unknown; ids?: unknown }, media: PortalMedia[]): { picks: Pick[] } | { error: string } {
  const wanted = Array.isArray(b.ids) && b.ids.length ? new Set<string>(b.ids.map(String)) : null;
  if (Array.isArray(b.groups) && b.groups.length) {
    const groups = [...new Set<string>(b.groups.map(String))].slice(0, 50);
    const seen = new Set<string>();
    const picks: Pick[] = [];
    for (const g of groups) {
      const got = picksFor(g, media);
      if (!got) return { error: `unknown group: ${g.slice(0, 60)}` };
      for (const p of got) {
        const k = `${p.m.id}:${p.variant}`;
        if (seen.has(k) || (wanted && !wanted.has(p.m.id))) continue;
        seen.add(k);
        picks.push(p);
      }
    }
    return { picks };
  }
  return { picks: media.filter((m) => !wanted || wanted.has(m.id)).map((m) => ({ m, variant: "original" as const })) };
}
