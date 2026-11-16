"use client";
// The client's revision list: every photo note they wrote in the lightbox
// ("Request revision"), an optional general note, and Send to the business. Notes are
// already saved as they are written; sending tells the team, once, with
// everything new since the last send. Edit reopens the photo with its note.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EASE, prefersReducedMotion, useFocusTrap, useScrollLock } from "./hooks";
import { CheckIcon, CloseIcon, PencilIcon } from "./icons";
import { plural, type GalleryPhoto } from "./types";
import type { RevisionDraft } from "@/lib/revisions";
import "@/styles/gallery.css";
import { brand } from "@/lib/brand";

export default function RevisionTray({
  draft,
  photos,
  onClose,
  onEdit,
  onRemove,
  onSend,
}: {
  draft: RevisionDraft;
  photos: GalleryPhoto[];
  onClose: () => void;
  onEdit: (mediaId: string) => void;
  onRemove: (mediaId: string) => Promise<string | null>;
  onSend: (general: string) => Promise<string | null>;
}) {
  const [general, setGeneral] = useState("");
  const [phase, setPhase] = useState<{ k: "list" } | { k: "sending" } | { k: "sent" } | { k: "error"; msg: string }>({ k: "list" });
  const [removing, setRemoving] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);

  useScrollLock(true);
  useFocusTrap(panelRef, true, { initial: closeRef });

  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    overlayRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: EASE });
    panelRef.current?.animate([{ opacity: 0, transform: "translateY(18px) scale(.985)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: EASE });
  }, []);

  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    if (!prefersReducedMotion()) {
      await Promise.all([
        overlayRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE, fill: "forwards" }).finished,
        panelRef.current?.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(10px)" }], { duration: 200, easing: EASE, fill: "forwards" }).finished,
      ]).catch(() => {});
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const byId = new Map(photos.map((p) => [p.id, p]));
  const unsent = draft.items.filter((i) => !i.sent).length;
  const canSend = unsent > 0 || general.trim().length > 0;

  const send = async () => {
    setPhase({ k: "sending" });
    const err = await onSend(general);
    if (err) setPhase({ k: "error", msg: err });
    else {
      setGeneral("");
      setPhase({ k: "sent" });
    }
  };

  const remove = async (mediaId: string) => {
    setRemoving(mediaId);
    await onRemove(mediaId);
    setRemoving(null);
  };

  return createPortal(
    <div className="g-modal" role="presentation">
      <div ref={overlayRef} className="g-modal__overlay" onClick={() => void close()} aria-hidden="true" />
      <div ref={panelRef} className="g-modal__panel g-tray" role="dialog" aria-modal="true" aria-labelledby="g-tray-title">
        <button ref={closeRef} type="button" className="g-modal__x" aria-label="Close" onClick={() => void close()}>
          <CloseIcon />
        </button>
        <div className="kicker" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <PencilIcon size={13} /> Revisions
        </div>
        <h2 id="g-tray-title" className="g-modal__title">Your revision list.</h2>

        {phase.k === "sent" ? (
          <div className="g-modal__status" aria-live="polite">
            <p className="g-modal__end g-modal__end--ok">Sent to {brand.shortName}</p>
            <p className="g-modal__msg">Thank you. We will follow up shortly, and revised files will appear in a &ldquo;Revised&rdquo; section of this gallery when they are ready. You can add more notes any time.</p>
            <span className="g-modal__btns">
              <button type="button" className="btn btn-primary" onClick={() => void close()}>
                Done
              </button>
            </span>
          </div>
        ) : (
          <>
            <p className="g-modal__lede">
              {draft.items.length
                ? `A note on each photo, saved as you go. Send them to ${brand.shortName} together when you are ready.`
                : "Open any photo and tap Request revision to add a note for that photo, or write to us below."}
            </p>

            {draft.items.length > 0 && (
              <ul className="g-tray__list">
                {draft.items.map((it) => {
                  const p = it.mediaId ? byId.get(it.mediaId) : undefined;
                  return (
                    <li key={it.id} className="g-tray__item">
                      <span className="g-tray__thumb">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {p ? <img src={p.thumb} alt="" draggable={false} /> : null}
                      </span>
                      <span className="g-tray__body">
                        <span className="g-tray__file">
                          {it.filename}
                          {it.sent && (
                            <span className="g-tray__sent">
                              <CheckIcon size={11} /> Sent
                            </span>
                          )}
                        </span>
                        <span className="g-tray__note">{it.note}</span>
                        <span className="g-tray__acts">
                          {p && (
                            <button type="button" className="g-tray__link" onClick={() => it.mediaId && onEdit(it.mediaId)}>
                              Edit
                            </button>
                          )}
                          <button type="button" className="g-tray__link" disabled={removing === it.mediaId} onClick={() => it.mediaId && void remove(it.mediaId)}>
                            {removing === it.mediaId ? "Removing" : "Remove"}
                          </button>
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            <label className="g-tray__general">
              <span className="g-tray__label">Anything else? Optional</span>
              <textarea className="g-textarea" rows={3} value={general} onChange={(e) => setGeneral(e.target.value)} placeholder="A note for the whole gallery" maxLength={4000} />
            </label>

            {phase.k === "error" && (
              <p className="g-rev__err g-rev__err--light" role="alert">
                {phase.msg}
              </p>
            )}

            <div className="g-modal__foot">
              <span className="g-modal__total">{unsent ? `${plural(unsent, "photo note")} ready to send` : draft.items.length ? "Everything is sent" : ""}</span>
              <span className="g-modal__btns">
                <button type="button" className="btn btn-ghost" onClick={() => void close()}>
                  Close
                </button>
                <button type="button" className="btn btn-primary" disabled={!canSend || phase.k === "sending"} onClick={() => void send()}>
                  {phase.k === "sending" ? "Sending" : `Send to ${brand.shortName}`}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
