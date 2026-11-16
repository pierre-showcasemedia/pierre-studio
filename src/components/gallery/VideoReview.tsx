"use client";
// The film review (Oct 26 2026): the client watches a film, pauses where
// something should change, and writes a note at that moment. Notes sit on
// the timeline as markers (tap one to jump there) and in the list beside the
// player, saved as they are written (src/lib/video-review.ts). Send revision
// request sends every unsent note on this gallery's films to the business as one
// request; sent notes stay listed and can no longer change.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EASE, prefersReducedMotion, useFocusTrap, useScrollLock } from "./hooks";
import { CheckIcon, CloseIcon, PencilIcon } from "./icons";
import { plural, type GalleryVideo } from "./types";
import type { VideoNote } from "@/lib/video-review";
import "@/styles/gallery.css";
import "@/styles/video-review.css";
import { brand } from "@/lib/brand";

const tc = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

type Post = { ok?: boolean; demo?: boolean; error?: string; notes?: VideoNote[] };

async function post(url: string, body: unknown): Promise<Post> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json().catch(() => ({}))) as Post;
  } catch {
    return { ok: false, error: "That did not save. Please check your connection and try again." };
  }
}

export default function VideoReview({
  film,
  slug,
  notes,
  onNotes,
  onClose,
}: {
  film: GalleryVideo;
  slug: string;
  notes: VideoNote[]; // every note this client has on the gallery's films
  onNotes: (n: VideoNote[]) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const closing = useRef(false);
  const [duration, setDuration] = useState(0);
  const [now, setNow] = useState(0);
  const [at, setAt] = useState<number | null>(null); // where the note being written goes, ms
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [general, setGeneral] = useState("");
  const [sent, setSent] = useState(false);

  useScrollLock(true);
  useFocusTrap(panelRef, true, { initial: closeRef });

  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    panelRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: EASE });
  }, []);

  const close = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    videoRef.current?.pause();
    if (!prefersReducedMotion()) await panelRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: EASE, fill: "forwards" }).finished.catch(() => {});
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) el.blur();
      else void close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const mine = useMemo(() => notes.filter((n) => n.mediaId === film.id).sort((a, b) => a.atMs - b.atMs), [notes, film.id]);
  const unsentAll = notes.filter((n) => !n.sent).length;
  const unsentOther = notes.filter((n) => !n.sent && n.mediaId !== film.id).length;

  const seek = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    v.pause();
    setNow(ms);
  };

  // Writing a note pauses the film and pins the note to that moment.
  const pin = () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    setAt(Math.round(v.currentTime * 1000));
  };

  const save = async () => {
    const note = text.trim();
    if (!note || at === null) return;
    setBusy(true);
    setErr(null);
    const j = await post("/api/portal/video-notes", { slug, op: "add", mediaId: film.id, atMs: at, note });
    setBusy(false);
    if (!j.ok) return setErr(j.error || "That did not save. Please try again.");
    if (j.notes) onNotes(j.notes);
    else if (j.demo) onNotes([...notes, { id: `demo-${Date.now()}`, mediaId: film.id, filename: film.filename, atMs: at, note, sent: false, updatedAt: new Date().toISOString() }]);
    setText("");
    setAt(null);
    setSent(false);
  };

  const edit = async (id: string, note: string) => {
    setBusy(true);
    setErr(null);
    const j = await post("/api/portal/video-notes", { slug, op: "edit", id, note });
    setBusy(false);
    if (!j.ok) return setErr(j.error || "That did not save. Please try again.");
    if (j.notes) onNotes(j.notes);
    else if (j.demo) onNotes(note.trim() ? notes.map((n) => (n.id === id ? { ...n, note: note.trim() } : n)) : notes.filter((n) => n.id !== id));
    setEditing(null);
  };

  const send = async () => {
    setBusy(true);
    setErr(null);
    const j = await post("/api/portal/video-revision", { slug, notes: general });
    setBusy(false);
    if (!j.ok) return setErr(j.error || "That did not send. Please try again.");
    if (j.notes) onNotes(j.notes);
    else if (j.demo) onNotes(notes.map((n) => ({ ...n, sent: true })));
    setGeneral("");
    setSent(true);
  };

  const pct = (ms: number) => (duration > 0 ? Math.min(100, Math.max(0, (ms / (duration * 1000)) * 100)) : 0);

  return createPortal(
    <div ref={panelRef} className="g-vr" role="dialog" aria-modal="true" aria-label={`Notes on ${film.filename}`}>
      <header className="g-vr__top">
        <div className="g-vr__title">
          <span className="g-vr__eyebrow">
            <PencilIcon size={12} /> Film notes
          </span>
          <span className="g-vr__file">{film.filename}</span>
        </div>
        <button ref={closeRef} type="button" className="g-lb__btn" aria-label="Close" onClick={() => void close()}>
          <CloseIcon />
        </button>
      </header>

      <div className="g-vr__body">
        <div className="g-vr__stage">
          <div className="g-vr__player">
            <video
              ref={videoRef}
              className="g-vr__video"
              src={film.url ?? undefined}
              poster={film.poster ?? undefined}
              controls
              playsInline
              preload="metadata"
              // A film without a duration in its header reports Infinity until
              // it is known; markers wait for a real number.
              onLoadedMetadata={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
              onDurationChange={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
              onTimeUpdate={(e) => setNow(Math.round(e.currentTarget.currentTime * 1000))}
            />
          </div>

          {/* The timeline: one marker per note, the playhead, tap to jump. */}
          <div className="g-vr__track" aria-label="Notes on the timeline">
            <span className="g-vr__rail" />
            <span className="g-vr__head" style={{ left: `${pct(now)}%` }} aria-hidden="true" />
            {duration > 0 &&
              mine.map((n) => (
                <button key={n.id} type="button" className={`g-vr__mark${n.sent ? " is-sent" : ""}`} style={{ left: `${pct(n.atMs)}%` }} onClick={() => seek(n.atMs)} title={`${tc(n.atMs)} ${n.note}`} aria-label={`Note at ${tc(n.atMs)}`} />
              ))}
            {at !== null && duration > 0 && <span className="g-vr__mark is-new" style={{ left: `${pct(at)}%` }} aria-hidden="true" />}
          </div>

          <div className="g-vr__compose">
            <div className="g-vr__composehead">
              <span className="g-vr__at">{at === null ? `Note at ${tc(now)}` : `Note at ${tc(at)}`}</span>
              {at !== null && Math.abs(at - now) > 900 && (
                <button type="button" className="g-rev__link" onClick={pin}>
                  Use {tc(now)} instead
                </button>
              )}
            </div>
            <textarea
              ref={boxRef}
              className="g-rev__box"
              rows={2}
              value={text}
              maxLength={1000}
              placeholder="Pause where something should change and write it here"
              onFocus={() => {
                if (at === null) pin();
              }}
              onChange={(e) => {
                if (at === null) pin();
                setText(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <div className="g-rev__btns">
              <span className="g-rev__hint">The film pauses while you write. Each note saves on its own.</span>
              {at !== null && (
                <button
                  type="button"
                  className="g-rev__link"
                  onClick={() => {
                    setAt(null);
                    setText("");
                  }}
                >
                  Cancel
                </button>
              )}
              <button type="button" className="g-rev__save" disabled={busy || !text.trim() || at === null} onClick={() => void save()}>
                {busy ? "Saving" : "Save note"}
              </button>
            </div>
          </div>
        </div>

        <aside className="g-vr__side">
          <div className="g-vr__sidehead">
            <span>Notes on this film</span>
            <span className="g-vr__count">{mine.length}</span>
          </div>
          {mine.length === 0 ? (
            <p className="g-vr__empty">No notes yet. Play the film, pause where you would like a change, and write a note. It lands at that moment on the timeline.</p>
          ) : (
            <ol className="g-vr__list">
              {mine.map((n) => (
                <li key={n.id} className={`g-vr__item${n.sent ? " is-sent" : ""}`}>
                  <button type="button" className="g-vr__tc" onClick={() => seek(n.atMs)} aria-label={`Jump to ${tc(n.atMs)}`}>
                    {tc(n.atMs)}
                  </button>
                  <div className="g-vr__itembody">
                    {editing?.id === n.id ? (
                      <>
                        <textarea className="g-rev__box g-vr__editbox" rows={2} value={editing.text} maxLength={1000} onChange={(e) => setEditing({ id: n.id, text: e.target.value })} autoFocus />
                        <span className="g-vr__acts">
                          <button type="button" className="g-rev__link" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button type="button" className="g-rev__save g-vr__small" disabled={busy} onClick={() => void edit(n.id, editing.text)}>
                            Save
                          </button>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="g-vr__note">{n.note}</span>
                        {n.sent ? (
                          <span className="g-vr__sent">
                            <CheckIcon size={11} /> Sent
                          </span>
                        ) : (
                          <span className="g-vr__acts">
                            <button type="button" className="g-rev__link" onClick={() => setEditing({ id: n.id, text: n.note })}>
                              Edit
                            </button>
                            <button type="button" className="g-rev__link" disabled={busy} onClick={() => void edit(n.id, "")}>
                              Remove
                            </button>
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}

          <div className="g-vr__send">
            {sent && unsentAll === 0 ? (
              <p className="g-vr__done" aria-live="polite">
                Sent to {brand.shortName}. Thank you. We will follow up shortly, and the revised film will appear in this gallery when it is ready.
              </p>
            ) : (
              <>
                {unsentOther > 0 && <p className="g-vr__other">{plural(unsentOther, "note")} on your other films will go too.</p>}
                <label className="g-vr__generallabel" htmlFor="g-vr-general">
                  Anything else? Optional
                </label>
                <textarea id="g-vr-general" className="g-rev__box g-vr__general" rows={2} value={general} maxLength={2000} onChange={(e) => setGeneral(e.target.value)} placeholder="Music, pace, or a note for the whole film" />
                <button type="button" className="g-vr__sendbtn" disabled={busy || (unsentAll === 0 && !general.trim())} onClick={() => void send()}>
                  {busy ? "Sending" : unsentAll ? `Send revision request (${plural(unsentAll, "note")})` : "Send revision request"}
                </button>
                <p className="g-vr__fine">Your notes are saved as you go. {brand.shortName} sees them when you send.</p>
              </>
            )}
            {err && (
              <p className="g-rev__err" role="alert">
                {err}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>,
    document.body
  );
}
