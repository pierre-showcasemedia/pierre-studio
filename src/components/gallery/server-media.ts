// Server side of the gallery (imported by the listing and share pages only):
// turns client-visible media rows into what the gallery renders, with signed
// derivative URLs (watermarked while locked), and picks the hero cover.
// Demo mode (no storage) uses the public demo frames on the rows instead.
import { after } from "next/server";
import { derivativeKey } from "@/lib/media-keys";
import { hasR2, objectExists, signedViewUrl } from "@/lib/r2";
import { ensureCoverDerivative } from "@/lib/derivatives";
import type { PortalListing, PortalMedia } from "@/lib/portal-data";
import type { GalleryPhoto, GalleryVideo } from "./types";

export type HeroImage = { src: string; srcSet?: string };

export async function galleryMedia(
  listing: PortalListing,
  media: PortalMedia[],
  opts: { locked: boolean; large: boolean }
): Promise<{ photos: GalleryPhoto[]; videos: GalleryVideo[]; hero: HeroImage | null; demo: boolean }> {
  const { locked } = opts;
  const photoRows = media.filter((m) => m.kind === "photo");
  const videoRows = media.filter((m) => m.kind === "video");
  // The cover must itself be client-visible; otherwise the first main photo.
  const coverRow =
    (listing.coverKey ? photoRows.find((m) => m.r2Key === listing.coverKey) : undefined) ??
    photoRows.find((m) => !m.revision && !m.section) ??
    photoRows[0] ??
    null;

  if (!hasR2()) {
    if (!media.some((m) => m.demo)) return { photos: [], videos: [], hero: null, demo: false };
    return {
      photos: photoRows
        .filter((m) => m.demo)
        .map((m) => ({
          id: m.id,
          thumb: m.demo!.url,
          preview: m.demo!.url,
          large: null,
          filename: m.filename,
          revised: m.revision,
          section: m.section ?? null,
          width: m.demo!.width,
          height: m.demo!.height,
        })),
      // DEMO_FILM_URL (local only) gives the demo film something to play, for the film review.
      videos: videoRows.map((m) => ({ id: m.id, url: process.env.DEMO_FILM_URL || null, filename: m.filename, revised: m.revision, section: m.section ?? null, poster: m.demo?.url ?? null })),
      hero: coverRow?.demo ? { src: coverRow.demo.url } : null,
      demo: true,
    };
  }

  const thumbV = locked ? ("thumb-wm" as const) : ("thumb" as const);
  const previewV = locked ? ("preview-wm" as const) : ("preview" as const);
  const withLarge = opts.large && !locked; // the 2048px file is clean: never while locked
  const [photos, videos, hero] = await Promise.all([
    Promise.all(
      photoRows.map(async (m): Promise<GalleryPhoto> => {
        const [thumb, preview, large] = await Promise.all([
          signedViewUrl(derivativeKey(m.r2Key, thumbV)),
          signedViewUrl(derivativeKey(m.r2Key, previewV)),
          withLarge ? signedViewUrl(derivativeKey(m.r2Key, "mls")) : Promise.resolve(null),
        ]);
        return { id: m.id, thumb, preview, large, filename: m.filename, revised: m.revision, section: m.section ?? null };
      })
    ),
    Promise.all(
      videoRows.map(async (m): Promise<GalleryVideo> => ({
        id: m.id,
        url: locked ? null : await signedViewUrl(m.r2Key),
        filename: m.filename,
        revised: m.revision,
        section: m.section ?? null,
      }))
    ),
    coverRow ? heroImage(coverRow.r2Key, locked) : Promise.resolve(null),
  ]);
  return { photos, videos, hero, demo: false };
}

// The hero always offers the 1600px preview; once the 3200px cover exists it
// is added to the srcset so big and sharp screens get full resolution. When it
// is missing, it is built after this response (src/lib/derivatives.ts), so the
// next view has it.
async function heroImage(key: string, locked: boolean): Promise<HeroImage> {
  const coverKey = derivativeKey(key, locked ? "cover-wm" : "cover");
  const [preview, ready] = await Promise.all([signedViewUrl(derivativeKey(key, locked ? "preview-wm" : "preview")), objectExists(coverKey)]);
  if (ready) return { src: preview, srcSet: `${preview} 1600w, ${await signedViewUrl(coverKey)} 3200w` };
  after(async () => {
    await ensureCoverDerivative(key, locked);
  });
  return { src: preview };
}
