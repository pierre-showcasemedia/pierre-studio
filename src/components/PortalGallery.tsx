"use client";
// The client gallery on /portal/<slug>: download bar (Download all, Download
// for MLS, Add to Dropbox, Download selected), approve or request a revision,
// films, a Pixieset-style masonry grid per group (photos, revised, each named
// section) and a lightbox that walks the photos in page order. Every area
// (Films, Revised films, Photos, Revised photos, each named section) has its
// own zip download once the gallery has more than one area, and every photo
// and film has its own download. Films open
// the film review (Oct 26 2026): notes pinned to moments in the film, sent
// to the business as one video revision request.
//
// Locked listings get watermarked derivatives from the server and no download
// controls here; every download still goes through the payment gate on the
// server (/api/portal/download, /bundle, /dropbox-manifest).
import { useCallback, useMemo, useState } from "react";
import MasonryGrid from "@/components/gallery/MasonryGrid";
import Lightbox, { tileHint, type LightboxRevisions, type LightboxStart } from "@/components/gallery/Lightbox";
import RevisionTray from "@/components/gallery/RevisionTray";
import VideoReview from "@/components/gallery/VideoReview";
import DropboxModal, { type DropboxMode, type DropboxOption } from "@/components/gallery/DropboxModal";
import DriveModal, { type DriveMode } from "@/components/gallery/DriveModal";
import DownloadBar from "@/components/gallery/DownloadBar";
import FilmCard from "@/components/gallery/FilmCard";
import Rise from "@/components/gallery/Rise";
import { DownloadIcon, PencilIcon } from "@/components/gallery/icons";
import type { RevisionDraft } from "@/lib/revisions";
import type { VideoNote } from "@/lib/video-review";
import { groupGallery, type GalleryPhoto, type GalleryVideo, type GroupArea, type GroupBundles } from "@/components/gallery/types";
import "@/styles/gallery.css";

export type GPhoto = GalleryPhoto;
export type GVideo = GalleryVideo;

export default function PortalGallery({
  photos,
  videos,
  locked,
  bundles,
  sectionBundles = {},
  groupBundles = {},
  listingId,
  slug,
  approvedAt,
  readOnly = false,
  dropbox = null,
  drive = null,
  revisionDraft = null,
  videoNotes = null,
}: {
  photos: GPhoto[];
  videos: GVideo[];
  locked: boolean;
  bundles: { full: boolean; mls: boolean };
  sectionBundles?: Record<string, { slug: string; mls: boolean }>; // section name → bundle info
  groupBundles?: GroupBundles; // gallery area → its zip (only when the gallery has more than one area)
  listingId: string;
  slug: string;
  approvedAt: string | null;
  readOnly?: boolean; // partners: downloads only, no approve / revision
  dropbox?: DropboxMode | null; // null hides Add to Dropbox (no app key on this deployment)
  drive?: DriveMode | null; // null hides Save to Google Drive (Nov 18 2026; business.fileStore google_drive with the client id set)
  revisionDraft?: RevisionDraft | null; // the client's saved revision notes (null for partners)
  videoNotes?: VideoNote[] | null; // the client's film notes (null for partners)
}) {
  const [lightbox, setLightbox] = useState<LightboxStart | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dbxOpen, setDbxOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  // Approve state, and the client's revision list (per-photo notes from the
  // lightbox, saved as they are written, sent to the business together).
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"approved" | null>(null);
  const [draft, setDraft] = useState<RevisionDraft>(revisionDraft ?? { requestId: null, items: [], notes: "", sentAt: null });
  const [trayOpen, setTrayOpen] = useState(false);
  const canRevise = !readOnly && revisionDraft !== null;
  // The film review: the client's timestamped notes on this gallery's films.
  const [filmNotes, setFilmNotes] = useState<VideoNote[]>(videoNotes ?? []);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const canReviewFilms = !readOnly && videoNotes !== null && !locked;
  const filmUnsent = filmNotes.filter((n) => !n.sent).length;
  const [downloading, setDownloading] = useState(false);

  const g = useMemo(() => groupGallery(photos, videos), [photos, videos]);

  const notes = useMemo(() => {
    const out: Record<string, string> = {};
    for (const it of draft.items) if (it.mediaId) out[it.mediaId] = it.note;
    return out;
  }, [draft.items]);
  const noted = useMemo(() => new Set(Object.keys(notes)), [notes]);
  const unsent = draft.items.filter((i) => !i.sent).length;

  // Save (or, empty, remove) one photo's note. Returns an error, or null.
  const saveNote = useCallback(
    async (photo: GPhoto, note: string): Promise<string | null> => {
      let json: { ok?: boolean; demo?: boolean; error?: string; draft?: RevisionDraft } = {};
      try {
        const r = await fetch("/api/portal/revision/item", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, mediaId: photo.id, note }),
        });
        json = await r.json().catch(() => ({}));
      } catch {
        return "That did not save. Please check your connection and try again.";
      }
      if (!json.ok) return json.error || "That did not save. Please try again.";
      if (json.draft) setDraft(json.draft);
      else if (json.demo) {
        // Demo mode: keep the list in the page.
        setDraft((d) => {
          const rest = d.items.filter((i) => i.mediaId !== photo.id);
          const items = note.trim() ? [...rest, { id: `demo-${photo.id}`, mediaId: photo.id, filename: photo.filename, note: note.trim(), updatedAt: new Date().toISOString(), sent: false }] : rest;
          return { ...d, items };
        });
      }
      // The photo is picked in the grid too, as if the client had ticked it.
      if (note.trim()) setSelected((s) => (s.has(photo.id) ? s : new Set(s).add(photo.id)));
      return null;
    },
    [slug]
  );

  const sendRevisions = useCallback(
    async (general: string): Promise<string | null> => {
      let json: { ok?: boolean; demo?: boolean; error?: string; draft?: RevisionDraft } = {};
      try {
        const r = await fetch("/api/portal/revision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, notes: general }),
        });
        json = await r.json().catch(() => ({}));
      } catch {
        return "That did not send. Please check your connection and try again.";
      }
      if (!json.ok) return json.error || "That did not send. Please try again.";
      if (json.draft) setDraft(json.draft);
      else setDraft((d) => ({ ...d, sentAt: new Date().toISOString(), items: d.items.map((i) => ({ ...i, sent: true })) }));
      return null;
    },
    [slug]
  );

  const revisions: LightboxRevisions | undefined = canRevise ? { notes, save: saveNote, count: draft.items.length } : undefined;

  const toggle = useCallback(
    (id: string) =>
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    []
  );

  const openPhoto = useCallback(
    (id: string, revise = false) => {
      const index = g.order.findIndex((p) => p.id === id);
      if (index >= 0) setLightbox({ index, hint: tileHint(id), revise });
    },
    [g.order]
  );
  const closeLightbox = useCallback(() => setLightbox(null), []);

  const fileHref = (id: string) => `/api/portal/download/${id}`;
  const photoHref = locked ? undefined : (p: GPhoto) => fileHref(p.id);

  // Sequential downloads keep the browser from blocking a burst of them.
  const downloadSelected = async () => {
    setDownloading(true);
    for (const id of selected) {
      const a = document.createElement("a");
      a.href = fileHref(id);
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 700));
    }
    setDownloading(false);
  };

  const approve = async () => {
    if (!window.confirm("Approve this gallery? This marks the project as completed.")) return;
    setBusy(true);
    const r = await fetch("/api/portal/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    setBusy(false);
    if (r.ok) setDone("approved");
  };


  // What the Dropbox dialog offers, with counts.
  const dropboxOptions: DropboxOption[] = useMemo(() => {
    const out: DropboxOption[] = [];
    if (g.photos.length) {
      out.push({ key: "photos", label: "Photos", detail: "Full resolution", count: g.photos.length, unit: "photo" });
      out.push({ key: "mls", label: "MLS photos", detail: "2048px, sized for the MLS", count: g.photos.length, unit: "photo" });
    }
    if (g.films.length) out.push({ key: "films", label: "Films", detail: "Full quality", count: g.films.length, unit: "film" });
    for (const s of g.sections) {
      const detail = s.photos.length && s.videos.length ? "Photos and films" : s.videos.length ? "Films" : "Photos, full resolution";
      out.push({ key: `section:${s.name}`, label: s.name, detail, count: s.photos.length + s.videos.length, unit: "file" });
    }
    const revised = g.revisedPhotos.length + g.revisedFilms.length;
    if (revised) out.push({ key: "revised", label: "Revised files", detail: "Your latest revisions", count: revised, unit: "file" });
    return out;
  }, [g]);

  const canDropbox = !locked && Boolean(dropbox) && dropboxOptions.length > 0;
  const canDrive = !locked && Boolean(drive) && dropboxOptions.length > 0;
  const hasMedia = photos.length > 0 || videos.length > 0;

  // One area's zip buttons, in its section heading. Hidden while locked; the
  // bundle route gates every zip on payment too.
  const areaCount = [g.photos, g.revisedPhotos, g.films, g.revisedFilms].filter((l) => l.length > 0).length + g.sections.length;
  const areaActs = (name: string, href: string | null, mlsHref: string | null) =>
    !locked &&
    href && (
      <span className="g-sec__acts">
        <a href={href} className="chip g-pill g-pill--sm">
          <DownloadIcon />
          Download &ldquo;{name}&rdquo;
        </a>
        {mlsHref && (
          <a href={mlsHref} className="chip g-pill g-pill--sm">
            <DownloadIcon />
            &ldquo;{name}&rdquo; for MLS
          </a>
        )}
      </span>
    );
  const groupActs = (area: GroupArea, name: string) => {
    const b = areaCount > 1 ? groupBundles[area] : undefined;
    return b ? areaActs(name, `/api/portal/bundle/${listingId}/grp-${area}`, b.mls ? `/api/portal/bundle/${listingId}/grpmls-${area}` : null) : null;
  };

  const film = (m: GVideo) => (
    <FilmCard
      key={m.id}
      film={m}
      locked={locked}
      selected={selected.has(m.id)}
      onToggle={locked ? undefined : () => toggle(m.id)}
      downloadHref={locked ? null : fileHref(m.id)}
      onReview={canReviewFilms ? () => setReviewing(m.id) : undefined}
      notes={filmNotes.filter((n) => n.mediaId === m.id).length}
    />
  );
  const reviewFilm = reviewing ? videos.find((v) => v.id === reviewing) ?? null : null;

  const films = (list: GVideo[], label: string, area: GroupArea) =>
    list.length > 0 && (
      <section className="g-sec">
        <Rise className="g-sec__head">
          <div className="kicker">
            {label} · {list.length}
          </div>
          {groupActs(area, label)}
        </Rise>
        <div className="g-films">
          {list.map((m, i) => (
            <Rise key={m.id} step={i}>
              {film(m)}
            </Rise>
          ))}
        </div>
      </section>
    );

  const grid = (items: GPhoto[]) => (
    <MasonryGrid items={items} onOpen={openPhoto} selected={locked ? undefined : selected} onToggle={toggle} downloadHref={photoHref} noted={canRevise ? noted : undefined} />
  );

  return (
    <>
      {/* Download bar: pinned under the hero once scrolled past */}
      {!locked && hasMedia && (
        <DownloadBar
          fullHref={bundles.full ? `/api/portal/bundle/${listingId}/full` : null}
          mlsHref={bundles.mls ? `/api/portal/bundle/${listingId}/mls` : null}
          onDropbox={canDropbox ? () => setDbxOpen(true) : null}
          onDrive={canDrive ? () => setDriveOpen(true) : null}
          selectedCount={selected.size}
          onDownloadSelected={() => void downloadSelected()}
          onClearSelection={() => setSelected(new Set())}
          downloadingSelected={downloading}
        />
      )}

      {/* Approve / request revision: once delivered, until approved */}
      {!locked && !readOnly && hasMedia && (
        <Rise className="g-approve">
          {approvedAt || done === "approved" ? (
            <p style={{ margin: 0, fontSize: 14, color: "var(--color-success)" }}>
              Gallery approved{approvedAt ? ` on ${approvedAt}` : ""}. This project is complete. Thank you.
            </p>
          ) : (
            <div className="g-approve__row">
              <div>
                <div className="kicker" style={{ marginBottom: 8 }}>Happy with everything?</div>
                <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>
                  {g.films.length + g.revisedFilms.length > 0 || g.sections.some((s) => s.videos.length > 0)
                    ? "Approve the gallery to mark this project completed, or open any photo and tap Request revision to note what you would like changed. On a film, tap Request revision and leave a note at the exact moment."
                    : "Approve the gallery to mark this project completed, or open any photo and tap Request revision to note what you would like changed."}
                </p>
                {draft.sentAt && unsent === 0 && (
                  <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "var(--color-blue)" }}>
                    Revision request sent. We will follow up shortly, and revised files will appear here in a &ldquo;Revised images&rdquo; section.
                  </p>
                )}
              </div>
              <div className="g-approve__btns">
                <button type="button" disabled={busy} onClick={approve} className="chip g-pill g-pill--ok">
                  Approve gallery
                </button>
                <button type="button" disabled={busy} onClick={() => setTrayOpen(true)} className="chip g-pill">
                  <PencilIcon />
                  {draft.items.length ? `Revision list (${draft.items.length})` : "Request a revision"}
                </button>
              </div>
            </div>
          )}
        </Rise>
      )}

      {/* Films */}
      {films(g.films, "Films", "films")}

      {/* Revised films: only when revisions exist */}
      {films(g.revisedFilms, "Revised films", "revised-films")}

      {/* Photo grid */}
      {g.photos.length > 0 && (
        <section className="g-sec">
          <Rise className="g-sec__head">
            <div className="kicker">Photos · {g.photos.length}</div>
            {groupActs("photos", "Photos")}
          </Rise>
          {grid(g.photos)}
        </section>
      )}

      {/* Revised photos: only when revisions exist */}
      {g.revisedPhotos.length > 0 && (
        <section className="g-sec">
          <Rise className="g-sec__head">
            <div className="kicker">Revised images · {g.revisedPhotos.length}</div>
            {groupActs("revised", "Revised images")}
          </Rise>
          {grid(g.revisedPhotos)}
        </section>
      )}

      {/* Named sections, each with its own zip so nobody re-downloads the full gallery */}
      {g.sections.map((s) => {
        const bundle = sectionBundles[s.name];
        return (
          <section key={s.name} className="g-sec g-sec--named">
            <Rise className="g-sec__head">
              <div className="kicker">
                {s.name} · {s.photos.length + s.videos.length}
              </div>
              {bundle && areaActs(s.name, `/api/portal/bundle/${listingId}/sec-${bundle.slug}`, bundle.mls ? `/api/portal/bundle/${listingId}/secmls-${bundle.slug}` : null)}
            </Rise>
            {s.videos.length > 0 && (
              <div className="g-films" style={{ marginBottom: s.photos.length ? "var(--g-gap)" : 0 }}>
                {s.videos.map((m, i) => (
                  <Rise key={m.id} step={i}>
                    {film(m)}
                  </Rise>
                ))}
              </div>
            )}
            {s.photos.length > 0 && grid(s.photos)}
          </section>
        );
      })}

      {lightbox && <Lightbox photos={g.order} start={lightbox} onClose={closeLightbox} downloadHref={photoHref} revisions={revisions} />}

      {/* The revision list: a quiet pill while notes wait to be sent. */}
      {canRevise && unsent > 0 && !trayOpen && !lightbox && (
        <button type="button" className="g-revpill" onClick={() => setTrayOpen(true)}>
          <PencilIcon />
          <span>
            {unsent} revision note{unsent === 1 ? "" : "s"} ready
          </span>
          <span className="g-revpill__go">Review and send</span>
        </button>
      )}

      {/* Film notes waiting to be sent: the same quiet pill, above the photo one. */}
      {canReviewFilms && filmUnsent > 0 && !reviewing && !trayOpen && !lightbox && (
        <button
          type="button"
          className={`g-revpill${canRevise && unsent > 0 ? " g-revpill--up" : ""}`}
          onClick={() => setReviewing(filmNotes.find((n) => !n.sent && videos.some((v) => v.id === n.mediaId))?.mediaId ?? videos[0]?.id ?? null)}
        >
          <PencilIcon />
          <span>
            {filmUnsent} film note{filmUnsent === 1 ? "" : "s"} ready
          </span>
          <span className="g-revpill__go">Review and send</span>
        </button>
      )}

      {reviewFilm && canReviewFilms && <VideoReview film={reviewFilm} slug={slug} notes={filmNotes} onNotes={setFilmNotes} onClose={() => setReviewing(null)} />}

      {trayOpen && canRevise && (
        <RevisionTray
          draft={draft}
          photos={g.order}
          onClose={() => setTrayOpen(false)}
          onEdit={(id) => {
            setTrayOpen(false);
            openPhoto(id, true);
          }}
          onRemove={(id) => {
            const p = g.order.find((x) => x.id === id);
            return p ? saveNote(p, "") : Promise.resolve(null);
          }}
          onSend={sendRevisions}
        />
      )}

      {driveOpen && drive && (
        <DriveModal slug={slug} drive={drive} options={dropboxOptions} selectedIds={[...selected]} onClose={() => setDriveOpen(false)} />
      )}
      {dbxOpen && dropbox && (
        <DropboxModal slug={slug} dropbox={dropbox} options={dropboxOptions} selectedIds={[...selected]} onClose={() => setDbxOpen(false)} />
      )}
    </>
  );
}
