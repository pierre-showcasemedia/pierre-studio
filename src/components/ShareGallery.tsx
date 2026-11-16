"use client";
// Public preview-only gallery for the /share/<token> page (homeowners, sellers).
// Same masonry grid and lightbox as the client portal, with the share rules:
// no selection, no downloads, a small the business mark bottom-right on every photo,
// and films that play inline with the download control hidden.
import { useCallback, useMemo, useState } from "react";
import MasonryGrid from "@/components/gallery/MasonryGrid";
import Lightbox, { tileHint, type LightboxStart } from "@/components/gallery/Lightbox";
import FilmCard from "@/components/gallery/FilmCard";
import Rise from "@/components/gallery/Rise";
import { groupGallery, type GalleryPhoto, type GalleryVideo } from "@/components/gallery/types";
import "@/styles/gallery.css";

export type SPhoto = GalleryPhoto;
export type SVideo = GalleryVideo;

export default function ShareGallery({ photos, videos, locked }: { photos: SPhoto[]; videos: SVideo[]; locked: boolean }) {
  const [lightbox, setLightbox] = useState<LightboxStart | null>(null);
  const g = useMemo(() => groupGallery(photos, videos), [photos, videos]);

  const openPhoto = useCallback(
    (id: string) => {
      const index = g.order.findIndex((p) => p.id === id);
      if (index >= 0) setLightbox({ index, hint: tileHint(id) });
    },
    [g.order]
  );
  const closeLightbox = useCallback(() => setLightbox(null), []);

  const noMenu = (e: React.SyntheticEvent) => e.preventDefault();

  // Films: playable, never downloadable from this page.
  const films = (list: SVideo[], label: string) =>
    list.length > 0 && (
      <section className="g-sec">
        <Rise className="g-sec__head">
          <div className="kicker">
            {label} · {list.length}
          </div>
        </Rise>
        <div className="g-films">
          {list.map((m, i) => (
            <Rise key={m.id} step={i}>
              <FilmCard film={m} viewOnly />
            </Rise>
          ))}
        </div>
      </section>
    );

  const grid = (items: SPhoto[]) => <MasonryGrid items={items} onOpen={openPhoto} watermark />;

  return (
    <div onContextMenu={noMenu}>
      {films(g.films, "Films")}
      {films(g.revisedFilms, "Revised films")}

      {/* Photo grid: watermarked, view-only */}
      {g.photos.length > 0 && (
        <section className="g-sec">
          <Rise className="g-sec__head">
            <div className="kicker">Photos · {g.photos.length}</div>
          </Rise>
          {grid(g.photos)}
        </section>
      )}

      {g.revisedPhotos.length > 0 && (
        <section className="g-sec">
          <Rise className="g-sec__head">
            <div className="kicker">Revised photos · {g.revisedPhotos.length}</div>
          </Rise>
          {grid(g.revisedPhotos)}
        </section>
      )}

      {/* Named sections */}
      {g.sections.map((s) => (
        <section key={s.name} className="g-sec g-sec--named">
          <Rise className="g-sec__head">
            <div className="kicker">
              {s.name} · {s.photos.length + s.videos.length}
            </div>
          </Rise>
          {s.videos.length > 0 && (
            <div className="g-films" style={{ marginBottom: s.photos.length ? "var(--g-gap)" : 0 }}>
              {s.videos.map((m, i) => (
                <Rise key={m.id} step={i}>
                  <FilmCard film={m} viewOnly />
                </Rise>
              ))}
            </div>
          )}
          {s.photos.length > 0 && grid(s.photos)}
        </section>
      ))}

      {locked && (
        <p className="muted" style={{ marginTop: 26, fontSize: 13.5 }}>
          Full-resolution files and films are available through the listing agent.
        </p>
      )}

      {lightbox && <Lightbox photos={g.order} start={lightbox} onClose={closeLightbox} watermark />}
    </div>
  );
}
