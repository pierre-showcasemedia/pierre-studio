"use client";
// Full-screen photo viewer. Opens from the clicked tile: the photo lifts out of
// the grid and settles in the centre (FLIP, ~420ms) while the page dims to
// near-black, and closes back into its tile (scrolling the tile into view
// first). Arrows, keyboard, swipe left/right, swipe down to close on touch,
// a "12 / 48" counter, neighbours preloaded. Order is the page order passed
// in, so forward and back follow exactly what the client sees.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { brand } from "@/lib/brand";
import { EASE, prefersReducedMotion, useFocusTrap, useScrollLock, useViewport } from "./hooks";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, DownloadIcon, PencilIcon } from "./icons";
import type { GalleryPhoto } from "./types";
import "@/styles/gallery.css";

export type LightboxStart = { index: number; hint: TileHint; revise?: boolean };

// Per-photo revision notes (the client portal). notes: the client's note per
// photo id; save(photo, "") removes one. save resolves to an error message, or
// null when it saved. count: photos in the client's revision list.
export type LightboxRevisions = {
  notes: Record<string, string>;
  save: (photo: GalleryPhoto, note: string) => Promise<string | null>;
  count: number;
};

const NOTE_MAX = 2000;
export type TileHint = { src: string | null; aspect: number | null };

const OPEN_MS = 420;
const CLOSE_MS = 380;

// What the grid already shows for a photo: its loaded image (for an instant
// first frame) and its true shape.
export function tileHint(id: string): TileHint {
  const img = findTile(id)?.querySelector<HTMLImageElement>("img.g-tile__img");
  if (img && img.complete && img.naturalWidth) return { src: img.currentSrc || img.src, aspect: img.naturalWidth / img.naturalHeight };
  return { src: null, aspect: null };
}

function findTile(id: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(id)}"]`);
}

type Box = { left: number; top: number; width: number; height: number };

// Where the photo sits on screen: as large as fits between the bars and arrows.
function frameBox(aspect: number, vw: number, vh: number): Box {
  const phone = vw < 640;
  const padX = phone ? 0 : vw < 1100 ? 76 : 104;
  const padTop = phone ? 60 : 72;
  const padBottom = phone ? 64 : 72;
  const aw = Math.max(1, vw - padX * 2);
  const ah = Math.max(1, vh - padTop - padBottom);
  let width = aw;
  let height = width / aspect;
  if (height > ah) {
    height = ah;
    width = height * aspect;
  }
  return { left: (vw - width) / 2, top: padTop + (ah - height) / 2, width, height };
}

const flip = (to: DOMRect | Box, from: Box) =>
  `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;

const layoutBox = (el: HTMLElement): Box => ({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });

function preload(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    img.decode().then(
      () => resolve(true),
      () => resolve(img.complete && img.naturalWidth > 0)
    );
  });
}

type Mode = "open" | "next" | "prev" | "none";

export default function Lightbox({
  photos,
  start,
  onClose,
  downloadHref,
  watermark = false,
  revisions,
}: {
  photos: GalleryPhoto[];
  start: LightboxStart;
  onClose: () => void;
  downloadHref?: (p: GalleryPhoto) => string | null;
  watermark?: boolean;
  revisions?: LightboxRevisions;
}) {
  const n = photos.length;
  const [view, setView] = useState<{ index: number; mode: Mode; hint: TileHint }>({ index: start.index, mode: "open", hint: start.hint });
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const { w: vw, h: vh } = useViewport();

  const rootRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const busy = useRef(false); // a slide-out is running
  const moved = useRef(false);
  const drag = useRef<{ id: number; x0: number; y0: number; t0: number; axis: "x" | "y" | null; dx: number; dy: number } | null>(null);

  useScrollLock(true);
  useFocusTrap(rootRef, true, { initial: closeRef, restore: false });

  const photo = photos[Math.min(view.index, n - 1)];
  // The revision note panel for the photo on screen.
  const [panel, setPanel] = useState<{ id: string; text: string; saving: boolean; error: string | null } | null>(() =>
    start.revise && revisions ? { id: photos[start.index].id, text: revisions.notes[photos[start.index].id] ?? "", saving: false, error: null } : null
  );
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const existingNote = revisions?.notes[photo.id] ?? "";
  const viewId = photo.id;
  const aspect = aspects[photo.id] ?? view.hint.aspect ?? (photo.width && photo.height ? photo.width / photo.height : 1.5);
  const box = frameBox(aspect, vw, vh);
  const dl = downloadHref?.(photo) ?? null;

  const step = useCallback(
    (d: number) => {
      if (closing.current || n < 2) return;
      const index = (view.index + d + n) % n;
      setPanel(null); // a note belongs to one photo
      setView({ index, mode: d > 0 ? "next" : "prev", hint: tileHint(photos[index].id) });
    },
    [view.index, n, photos]
  );

  const openPanel = () => {
    if (!revisions) return;
    setPanel({ id: photo.id, text: revisions.notes[photo.id] ?? "", saving: false, error: null });
  };
  const flash = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);
  const savePanel = async (text: string) => {
    if (!revisions || !panel) return;
    const target = photos.find((p) => p.id === panel.id) ?? photo;
    setPanel({ ...panel, text, saving: true, error: null });
    const err = await revisions.save(target, text);
    if (err) {
      setPanel((p) => (p ? { ...p, saving: false, error: err } : p));
      return;
    }
    setPanel(null);
    flash(text.trim() ? "Saved to your revision list" : "Note removed");
  };

  // The panel settles up from the bottom and puts the cursor in the box.
  useLayoutEffect(() => {
    if (!panel) return;
    const el = panelRef.current;
    if (el && !prefersReducedMotion()) el.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }], { duration: 280, easing: EASE });
    const box = noteRef.current;
    if (box) {
      box.focus({ preventScroll: true });
      box.setSelectionRange(box.value.length, box.value.length);
    }
    // Only when a panel opens for a photo, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel?.id]);

  const close = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    const frame = frameRef.current;
    const backdrop = backdropRef.current;
    const root = rootRef.current;
    const tile = findTile(photo.id);
    const reduced = prefersReducedMotion();
    const tileImg = tile?.querySelector<HTMLImageElement>("img.g-tile__img") ?? null;
    if (frame && backdrop && root && tile && !reduced) {
      // Bring the tile on screen under the overlay, then fly back into it.
      let r = tile.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        window.scrollTo({ top: window.scrollY + r.top - (window.innerHeight - r.height) / 2, behavior: "instant" });
        r = tile.getBoundingClientRect();
      }
      if (tileImg) tileImg.style.opacity = "0";
      const from = frame.style.transform || "none";
      const fade = getComputedStyle(backdrop).opacity;
      frame.style.transform = "";
      const anims = [
        frame.animate([{ transform: from }, { transform: flip(r, layoutBox(frame)) }], { duration: CLOSE_MS, easing: EASE, fill: "forwards" }),
        backdrop.animate([{ opacity: fade }, { opacity: 0 }], { duration: CLOSE_MS, easing: EASE, fill: "forwards" }),
        ...[...root.querySelectorAll<HTMLElement>(".g-lb__chrome")].map((el) =>
          el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: EASE, fill: "forwards" })
        ),
      ];
      await Promise.all(anims.map((a) => a.finished)).catch(() => {});
    } else if (root && !reduced) {
      await root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE, fill: "forwards" }).finished.catch(() => {});
    }
    if (tileImg) tileImg.style.opacity = "";
    onClose();
    tile?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [photo.id, onClose]);

  // Keyboard: arrows step, Escape closes (the note panel first). Typing in
  // the note never moves the photo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (e.key === "Escape") {
        e.preventDefault();
        if (panel) setPanel(null);
        else void close();
      } else if (typing || panel) return;
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, step, panel]);

  // Enter animations: from the tile on open, a short slide between photos.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const backdrop = backdropRef.current;
    const root = rootRef.current;
    if (!frame || !backdrop || !root || prefersReducedMotion()) return;
    busy.current = false;
    if (view.mode === "open") {
      backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: EASE });
      for (const el of root.querySelectorAll<HTMLElement>(".g-lb__chrome")) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 160, easing: EASE, fill: "backwards" });
      }
      const tile = findTile(viewId);
      if (tile) {
        const tileImg = tile.querySelector<HTMLImageElement>("img.g-tile__img");
        if (tileImg) tileImg.style.opacity = "0";
        const anim = frame.animate([{ transform: flip(tile.getBoundingClientRect(), layoutBox(frame)) }, { transform: "none" }], { duration: OPEN_MS, easing: EASE });
        const reveal = () => {
          if (tileImg && !closing.current) tileImg.style.opacity = "";
        };
        anim.finished.then(reveal, reveal);
      } else {
        frame.animate([{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
      }
    } else if (view.mode === "next" || view.mode === "prev") {
      const dir = view.mode === "next" ? 1 : -1;
      frame.animate([{ opacity: 0, transform: `translateX(${dir * 44}px)` }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
    }
  }, [view, viewId]); // only when the photo changes, never on resize

  // Preload the neighbours so stepping is instant.
  useEffect(() => {
    if (n < 2) return;
    for (const d of [1, -1]) {
      const p = photos[(view.index + d + n) % n];
      void preload(p.preview);
    }
  }, [view.index, n, photos]);

  // ---- Touch: swipe left/right to step, down to close --------------------
  const setDragStyle = (dx: number, dy: number, axis: "x" | "y") => {
    const frame = frameRef.current;
    const backdrop = backdropRef.current;
    if (!frame || !backdrop) return;
    if (axis === "x") {
      frame.style.transform = `translateX(${dx}px)`;
      return;
    }
    const down = Math.max(0, dy);
    const s = 1 - Math.min(down / Math.max(vh, 1), 0.35) * 0.5;
    const w = frame.offsetWidth;
    const h = frame.offsetHeight;
    frame.style.transform = `translate(${dx * 0.6 + ((1 - s) * w) / 2}px, ${dy + ((1 - s) * h) / 2}px) scale(${s})`;
    backdrop.style.opacity = String(1 - Math.min(down / 320, 1) * 0.75);
  };

  const snapBack = () => {
    const frame = frameRef.current;
    const backdrop = backdropRef.current;
    if (!frame || !backdrop) return;
    const from = frame.style.transform || "none";
    const fade = backdrop.style.opacity || "1";
    frame.style.transform = "";
    backdrop.style.opacity = "";
    if (prefersReducedMotion()) return;
    frame.animate([{ transform: from }, { transform: "none" }], { duration: 240, easing: EASE });
    backdrop.animate([{ opacity: fade }, { opacity: 1 }], { duration: 240, easing: EASE });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch" || closing.current || busy.current) return;
    if (drag.current) {
      // A second finger: hand the gesture back.
      drag.current = null;
      snapBack();
      return;
    }
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), axis: null, dx: 0, dy: 0 };
    moved.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    d.dx = e.clientX - d.x0;
    d.dy = e.clientY - d.y0;
    if (!d.axis) {
      if (Math.hypot(d.dx, d.dy) < 8) return;
      d.axis = Math.abs(d.dx) > Math.abs(d.dy) ? "x" : "y";
      moved.current = true;
    }
    if (d.axis === "x" && n < 2) return;
    setDragStyle(d.dx, d.dy, d.axis);
  };
  const onPointerUp = async (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (!d.axis) return;
    const dt = Math.max(1, performance.now() - d.t0);
    if (d.axis === "y" && (d.dy > 96 || (d.dy > 24 && d.dy / dt > 0.5))) {
      void close();
      return;
    }
    if (d.axis === "x" && n > 1 && (Math.abs(d.dx) > 64 || (Math.abs(d.dx) > 16 && Math.abs(d.dx) / dt > 0.45))) {
      const dir = d.dx < 0 ? 1 : -1;
      const frame = frameRef.current;
      if (frame && !prefersReducedMotion()) {
        busy.current = true;
        const from = frame.style.transform || "none";
        await frame
          .animate([{ transform: from, opacity: 1 }, { transform: `translateX(${-dir * Math.min(vw * 0.5, 240)}px)`, opacity: 0 }], { duration: 170, easing: EASE, fill: "forwards" })
          .finished.catch(() => {});
      }
      if (frame) frame.style.transform = "";
      step(dir);
      return;
    }
    snapBack();
  };
  const onPointerCancel = () => {
    if (!drag.current) return;
    drag.current = null;
    snapBack();
  };

  const onStageClick = () => {
    if (moved.current) {
      moved.current = false;
      return;
    }
    void close();
  };

  return createPortal(
    <div ref={rootRef} className="g-lb" role="dialog" aria-modal="true" aria-label="Photo viewer">
      <div ref={backdropRef} className="g-lb__backdrop" aria-hidden="true" />
      <div
        className="g-lb__stage"
        onClick={onStageClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <Frame
          key={photo.id}
          frameRef={frameRef}
          photo={photo}
          hint={view.hint.src}
          box={box}
          watermark={watermark}
          onAspect={(a) => setAspects((s) => (s[photo.id] && Math.abs(s[photo.id] - a) < 0.01 ? s : { ...s, [photo.id]: a }))}
        />
      </div>

      <div className="g-lb__bar g-lb__chrome">
        <span className="g-lb__count" aria-live="polite">
          {view.index + 1} / {n}
        </span>
        <span className="g-lb__name">{photo.filename}</span>
        <span className="g-lb__acts">
          {revisions && (
            <button
              type="button"
              className={`g-lb__btn g-lb__btn--text g-lb__btn--rev${existingNote ? " is-noted" : ""}${panel ? " is-open" : ""}`}
              aria-expanded={Boolean(panel)}
              onClick={() => (panel ? setPanel(null) : openPanel())}
            >
              {existingNote ? <CheckIcon /> : <PencilIcon />}
              <span>{existingNote ? "Revision noted" : "Request revision"}</span>
            </button>
          )}
          {dl && (
            <a className="g-lb__btn g-lb__btn--text" href={dl} aria-label={`Download ${photo.filename}`}>
              <DownloadIcon />
              <span>Download</span>
            </a>
          )}
          <button ref={closeRef} type="button" className="g-lb__btn" aria-label="Close" onClick={() => void close()}>
            <CloseIcon />
          </button>
        </span>
      </div>

      {panel && revisions && (
        <div ref={panelRef} className="g-rev" role="group" aria-label={`Revision for ${photo.filename}`}>
          <div className="g-rev__head">
            <span className="g-rev__eyebrow">{existingNote ? "Your revision for this photo" : "Request a revision on this photo"}</span>
            <span className="g-rev__file">{photo.filename}</span>
          </div>
          <textarea
            ref={noteRef}
            className="g-rev__box"
            rows={3}
            maxLength={NOTE_MAX}
            value={panel.text}
            placeholder="What should we change in this photo?"
            aria-label="What should we change in this photo?"
            onChange={(e) => setPanel({ ...panel, text: e.target.value, error: null })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && panel.text.trim()) void savePanel(panel.text);
            }}
          />
          {panel.error && <p className="g-rev__err" role="alert">{panel.error}</p>}
          <div className="g-rev__btns">
            {existingNote && (
              <button type="button" className="g-rev__link" disabled={panel.saving} onClick={() => void savePanel("")}>
                Remove note
              </button>
            )}
            <span className="g-rev__hint">{revisions.count ? `${revisions.count} in your revision list` : "Notes are saved to your revision list"}</span>
            <button type="button" className="g-lb__btn" disabled={panel.saving} onClick={() => setPanel(null)}>
              Cancel
            </button>
            <button type="button" className="g-rev__save" disabled={panel.saving || !panel.text.trim() || panel.text.trim() === existingNote.trim()} onClick={() => void savePanel(panel.text)}>
              {panel.saving ? "Saving" : existingNote ? "Update note" : "Save note"}
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="g-rev__toast" role="status">
          <CheckIcon size={14} />
          {toast}
        </div>
      )}

      {n > 1 && !panel && (
        <>
          <button type="button" className="g-lb__nav g-lb__nav--prev g-lb__chrome" aria-label="Previous photo" onClick={() => step(-1)}>
            <ChevronLeftIcon size={20} />
          </button>
          <button type="button" className="g-lb__nav g-lb__nav--next g-lb__chrome" aria-label="Next photo" onClick={() => step(1)}>
            <ChevronRightIcon size={20} />
          </button>
        </>
      )}
    </div>,
    document.body
  );
}

// One photo on screen. Starts from whatever the grid already loaded (so the
// open animation has a picture at once), then steps up to the 1600px preview
// and, on sharp screens when allowed, the 2048px file.
function Frame({
  photo,
  hint,
  box,
  watermark,
  onAspect,
  frameRef,
}: {
  photo: GalleryPhoto;
  hint: string | null;
  box: Box;
  watermark: boolean;
  onAspect: (a: number) => void;
  frameRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [initial] = useState(() => hint ?? photo.preview);
  const [src, setSrc] = useState(initial);

  useEffect(() => {
    let alive = true;
    const wantLarge = Boolean(photo.large) && box.width * (window.devicePixelRatio || 1) > 1700;
    const chain = [photo.preview, ...(wantLarge && photo.large ? [photo.large] : [])];
    const rank = (u: string) => chain.indexOf(u);
    (async () => {
      for (const url of chain) {
        if (url === initial) continue;
        const ok = await preload(url);
        if (!alive) return;
        if (ok) setSrc((cur) => (rank(url) > rank(cur) ? url : cur));
      }
    })();
    return () => {
      alive = false;
    };
  }, [photo.preview, photo.large, box.width, initial]);

  return (
    <div
      ref={frameRef}
      className="g-lb__frame"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="g-lb__img"
        src={src}
        alt={photo.filename}
        draggable={false}
        onLoad={(e) => {
          const im = e.currentTarget;
          if (im.naturalWidth && im.naturalHeight) onAspect(im.naturalWidth / im.naturalHeight);
        }}
      />
      {watermark && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="g-lb__wm" src={brand.watermark} alt="" aria-hidden="true" draggable={false} />
      )}
    </div>
  );
}
