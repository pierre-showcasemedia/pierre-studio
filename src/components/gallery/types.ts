// Shared gallery shapes and the one place that decides page order.

export type GalleryPhoto = {
  id: string;
  thumb: string; // 600px derivative (watermarked while locked)
  preview: string; // 1600px derivative (watermarked while locked)
  large?: string | null; // 2048px MLS derivative, unlocked only: sharper lightbox
  filename: string;
  revised?: boolean;
  section?: string | null;
  width?: number | null; // pixel size when known, so the grid lays out before load
  height?: number | null;
};

export type GalleryVideo = {
  id: string;
  url: string | null;
  filename: string;
  revised?: boolean;
  section?: string | null;
  poster?: string | null;
};

export type GallerySection<P, V> = { name: string; photos: P[]; videos: V[] };

export type GalleryGroups<P, V> = {
  films: V[]; // main gallery films
  revisedFilms: V[];
  photos: P[]; // main gallery photos
  revisedPhotos: P[];
  sections: GallerySection<P, V>[]; // named sections, in order of first appearance
  order: P[]; // every photo in the order it appears on the page (lightbox order)
};

type Item = { revised?: boolean; section?: string | null };

// Page order: films, revised films, photos, revised photos, then each named
// section (its films, then its photos). The lightbox walks `order`, so arrows
// and swipes follow exactly what the client sees, not the raw array.
export function groupGallery<P extends Item, V extends Item>(photos: P[], videos: V[]): GalleryGroups<P, V> {
  const isMain = (m: Item) => !m.revised && !m.section;
  const names: string[] = [];
  for (const m of [...photos, ...videos]) {
    if (m.section && !names.includes(m.section)) names.push(m.section);
  }
  const sections = names.map((name) => ({
    name,
    photos: photos.filter((p) => p.section === name),
    videos: videos.filter((v) => v.section === name),
  }));
  const main = photos.filter(isMain);
  const revisedPhotos = photos.filter((p) => p.revised && !p.section);
  return {
    films: videos.filter(isMain),
    revisedFilms: videos.filter((v) => v.revised && !v.section),
    photos: main,
    revisedPhotos,
    sections,
    order: [...main, ...revisedPhotos, ...sections.flatMap((s) => s.photos)],
  };
}

// The gallery areas that are not named sections, each with its own zip
// (bundles/group-<area>.zip, src/lib/bundles.ts) once the gallery has more
// than one area. MLS zips exist for the photo areas only.
export const GROUP_AREAS = ["photos", "revised", "films", "revised-films"] as const;
export type GroupArea = (typeof GROUP_AREAS)[number];
export type GroupBundles = Partial<Record<GroupArea, { mls: boolean }>>;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
