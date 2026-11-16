"use client";
// One film. Portal: plays once paid, with a checkbox and a download button;
// while locked it shows "Film unlocks after payment". Share page: plays with
// the download control hidden, never a download. With onReview (the client,
// Oct 26 2026) a Request revision button opens the film review.
import { CheckIcon, DownloadIcon, PencilIcon, PlayIcon } from "./icons";
import type { GalleryVideo } from "./types";
import "@/styles/gallery.css";

export default function FilmCard({
  film,
  locked = false,
  viewOnly = false,
  selected,
  onToggle,
  downloadHref,
  onReview,
  notes = 0,
}: {
  film: GalleryVideo;
  locked?: boolean;
  viewOnly?: boolean; // share page rules: no download control
  selected?: boolean;
  onToggle?: () => void;
  downloadHref?: string | null;
  onReview?: () => void; // the film review (timestamped revision notes)
  notes?: number; // notes the client has on this film
}) {
  const playable = !locked && Boolean(film.url);
  return (
    <article className={`g-film${selected ? " is-selected" : ""}`}>
      <div className="g-film__media">
        {playable ? (
          <video
            className="g-film__video"
            controls
            preload="metadata"
            playsInline
            poster={film.poster ?? undefined}
            src={film.url!}
            {...(viewOnly ? { controlsList: "nodownload noremoteplayback", disablePictureInPicture: true } : {})}
          />
        ) : (
          <div className="g-film__locked">
            {film.poster && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="g-film__poster" src={film.poster} alt="" aria-hidden="true" draggable={false} />
            )}
            <span className="g-film__lockmsg">
              <span className="g-film__play" aria-hidden="true">
                <PlayIcon size={14} />
              </span>
              {locked ? "Film unlocks after payment" : "Film preview unavailable"}
            </span>
          </div>
        )}
      </div>
      <div className="g-film__foot">
        {onToggle && !locked ? (
          <label className="g-film__name g-film__name--check">
            <input type="checkbox" checked={Boolean(selected)} onChange={onToggle} aria-label={`Select ${film.filename}`} />
            <span className="g-check__box g-check__box--inline" aria-hidden="true">
              <CheckIcon size={12} />
            </span>
            <span className="g-film__file">{film.filename}</span>
          </label>
        ) : (
          <span className="g-film__name">
            <span className="g-film__file">{film.filename}</span>
          </span>
        )}
        <span className="g-film__acts">
          {onReview && playable && (
            <button type="button" className="chip g-pill g-pill--sm" onClick={onReview} aria-label={`Request revision on ${film.filename}`}>
              <PencilIcon />
              {notes ? `Revision notes (${notes})` : "Request revision"}
            </button>
          )}
          {downloadHref && !locked && (
            <a href={downloadHref} className="chip g-pill g-pill--sm" aria-label={`Download ${film.filename}`}>
              <DownloadIcon />
              Download
            </a>
          )}
        </span>
      </div>
    </article>
  );
}
