// How the admin listing page groups a listing's files (Nov 5 2026): the
// photos of the main gallery, then each named section (Film, Twilight, Floor
// Plans, ...) in name order, then the revised files. MediaGrid draws the
// groups and the sticky section nav links to each one by its anchor, so
// nobody scrolls past hundreds of photos to reach the film or the revised
// set (the owner). Shared here because MediaGrid is a client component and the
// page builds the nav on the server.
export type MediaGroupRow = { section: string | null; revision: boolean; kind: string; sort: number; createdAt: string };
export type MediaGroup<R extends MediaGroupRow> = { key: string; title: string; rows: R[] };

// A film that was never given a section sits with the other films, not
// between the photos.
export const FILM_SECTION = "Film";

const bySort = <R extends MediaGroupRow>(a: R, b: R) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt);

export function groupMedia<R extends MediaGroupRow>(rows: R[]): MediaGroup<R>[] {
  const sectionOf = (m: R): string | null => m.section || (m.kind === "video" ? FILM_SECTION : null);
  const main = rows.filter((m) => !m.revision && !sectionOf(m)).sort(bySort);
  const sections = new Map<string, R[]>();
  for (const m of rows) {
    const s = sectionOf(m);
    if (m.revision || !s) continue;
    if (!sections.has(s)) sections.set(s, []);
    sections.get(s)!.push(m);
  }
  const revised = rows.filter((m) => m.revision).sort(bySort);
  const out: MediaGroup<R>[] = [];
  if (main.length) out.push({ key: "main", title: "Photos", rows: main });
  for (const [name, list] of [...sections.entries()].sort((a, b) => a[0].localeCompare(b[0]))) out.push({ key: `section:${name}`, title: name, rows: list.sort(bySort) });
  if (revised.length) out.push({ key: "revised", title: "Revised", rows: revised });
  return out;
}

// The element id of a group's section on the page ("media-photos", "media-film", "media-revised").
export function groupAnchor(key: string): string {
  const slug = (key === "main" ? "photos" : key.replace(/^section:/, "")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `media-${slug || "files"}`;
}

// The sticky nav's items for the media groups: one per group, with its count.
export function mediaGroupLinks<R extends MediaGroupRow>(rows: R[]): { id: string; label: string; count: number }[] {
  return groupMedia(rows).map((g) => ({ id: groupAnchor(g.key), label: g.title, count: g.rows.length }));
}
