"use client";
// Pixieset-style masonry. Natural aspect ratios (verticals never cropped),
// each photo dropped into the currently shortest column so reading across the
// rows stays close to the true order. Tiles fade and rise in as they scroll
// into view, once their image has loaded, with a small stagger.
//
// Aspect ratios come from width/height when the server knows them, otherwise
// from the loaded image. A tile that has been revealed keeps its column, so a
// late-loading vertical above it can never make it jump sideways.
import { useEffect, useReducer, useState, type Dispatch } from "react";
import { brand } from "@/lib/brand";
import { useColumns } from "./hooks";
import { CheckIcon, DownloadIcon, PencilIcon } from "./icons";
import type { GalleryPhoto } from "./types";
import "@/styles/gallery.css";

const FALLBACK_ASPECT = 1.5; // 3:2, the usual listing frame, until the real one is known
const GAP_UNITS = 0.035; // the gap, in column-widths, for balancing columns
const STAGGER_MS = 75;
const STAGGER_STEPS = 4;

const SIZES = "(min-width: 1400px) 330px, (min-width: 1100px) 25vw, (min-width: 640px) 33vw, 50vw";

type State = {
  aspects: Record<string, number>;
  locks: Record<string, number>; // id → column, for revealed tiles
  lockCols: number; // the column count the locks were taken at
  revealed: Record<string, number>; // id → reveal delay (ms)
};
type Action =
  | { type: "aspects"; values: Record<string, number> }
  | { type: "reveal"; entries: { id: string; delay: number }[]; items: GalleryPhoto[]; cols: number };

const knownAspect = (p: GalleryPhoto) => (p.width && p.height ? p.width / p.height : null);

function computeLayout(items: GalleryPhoto[], cols: number, s: State) {
  const locks = s.lockCols === cols ? s.locks : {};
  const heights = new Array<number>(cols).fill(0);
  const columns: GalleryPhoto[][] = Array.from({ length: cols }, () => []);
  const colOf: Record<string, number> = {};
  for (const p of items) {
    const a = s.aspects[p.id] ?? knownAspect(p) ?? FALLBACK_ASPECT;
    let c = locks[p.id];
    if (c === undefined || c >= cols) {
      c = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[c] - 1e-6) c = k;
    }
    columns[c].push(p);
    colOf[p.id] = c;
    heights[c] += 1 / a + GAP_UNITS;
  }
  return { columns, colOf };
}

function reducer(s: State, a: Action): State {
  if (a.type === "aspects") {
    let changed = false;
    const aspects = { ...s.aspects };
    for (const [id, v] of Object.entries(a.values)) {
      if (!aspects[id] || Math.abs(aspects[id] - v) > 0.01) {
        aspects[id] = v;
        changed = true;
      }
    }
    return changed ? { ...s, aspects } : s;
  }
  const fresh = a.entries.filter((e) => s.revealed[e.id] === undefined);
  if (!fresh.length) return s;
  const { colOf } = computeLayout(a.items, a.cols, s);
  const locks = s.lockCols === a.cols ? { ...s.locks } : {};
  const revealed = { ...s.revealed };
  for (const e of fresh) {
    revealed[e.id] = e.delay;
    if (colOf[e.id] !== undefined) locks[e.id] = colOf[e.id];
  }
  return { ...s, locks, lockCols: a.cols, revealed };
}

// The reveal bookkeeping for one grid: which tiles are in view, which images
// have loaded, and a once-per-frame flush that reveals the tiles that are
// both, top to bottom, left to right, 75ms apart (capped at 4 steps).
function createRevealEngine(dispatch: Dispatch<Action>) {
  let io: IntersectionObserver | null = null;
  const els = new Map<string, HTMLElement>();
  const visible = new Set<string>();
  const loadedIds = new Set<string>();
  const revealed = new Set<string>();
  let pendingAspects: Record<string, number> = {};
  let raf = 0;
  let items: GalleryPhoto[] = [];
  let cols = 3;

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(flush);
  };

  function flush() {
    raf = 0;
    if (Object.keys(pendingAspects).length) {
      // Let the new shapes lay out first and reveal on the next frame, so a
      // tile fades in where it will stay.
      dispatch({ type: "aspects", values: pendingAspects });
      pendingAspects = {};
      raf = requestAnimationFrame(flush);
      return;
    }
    const ready = [...visible].filter((id) => loadedIds.has(id) && !revealed.has(id) && els.has(id));
    if (!ready.length) return;
    const rects = new Map(ready.map((id) => [id, els.get(id)!.getBoundingClientRect()]));
    ready.sort((a, b) => {
      const ra = rects.get(a)!;
      const rb = rects.get(b)!;
      return Math.abs(ra.top - rb.top) > 24 ? ra.top - rb.top : ra.left - rb.left;
    });
    for (const id of ready) {
      revealed.add(id);
      const el = els.get(id);
      if (el) io?.unobserve(el);
    }
    const entries = ready.map((id, i) => ({ id, delay: Math.min(i, STAGGER_STEPS) * STAGGER_MS }));
    dispatch({ type: "reveal", entries, items, cols });
  }

  return {
    setContext(nextItems: GalleryPhoto[], nextCols: number) {
      items = nextItems;
      cols = nextCols;
    },
    // One observer per grid: threshold 0, bottom margin -8%, like the website.
    connect() {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.tileId;
            if (!id) continue;
            if (e.isIntersecting) visible.add(id);
            else visible.delete(id);
          }
          schedule();
        },
        { threshold: 0, rootMargin: "0px 0px -8% 0px" }
      );
      for (const [id, el] of els) if (!revealed.has(id)) io.observe(el);
      return () => {
        io?.disconnect();
        io = null;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      };
    },
    loaded(id: string, img: HTMLImageElement | null) {
      if (img && img.naturalWidth && img.naturalHeight) pendingAspects[id] = img.naturalWidth / img.naturalHeight;
      loadedIds.add(id);
      schedule();
    },
    // Stable ref callback for every tile (the id rides on data-tile-id).
    register(el: HTMLDivElement | null) {
      if (!el) return;
      const id = el.dataset.tileId!;
      els.set(id, el);
      if (!revealed.has(id)) io?.observe(el);
      const img = el.querySelector("img");
      if (img?.complete && img.naturalWidth) {
        pendingAspects[id] = img.naturalWidth / img.naturalHeight;
        loadedIds.add(id);
        schedule();
      }
      return () => {
        io?.unobserve(el);
        if (els.get(id) === el) {
          els.delete(id);
          visible.delete(id);
        }
      };
    },
  };
}

export default function MasonryGrid({
  items,
  onOpen,
  selected,
  onToggle,
  downloadHref,
  watermark = false,
  noted,
}: {
  items: GalleryPhoto[];
  onOpen: (id: string) => void;
  selected?: Set<string>; // present = tiles are selectable
  onToggle?: (id: string) => void;
  downloadHref?: (p: GalleryPhoto) => string | null;
  watermark?: boolean; // share page: the small the business mark on every tile
  noted?: Set<string>; // photos with a revision note from this client
}) {
  const cols = useColumns();
  const [state, dispatch] = useReducer(reducer, { aspects: {}, locks: {}, lockCols: 0, revealed: {} });
  const { columns } = computeLayout(items, cols, state);

  // Observers and load events live outside render (see createRevealEngine).
  const [engine] = useState(() => createRevealEngine(dispatch));
  useEffect(() => engine.setContext(items, cols), [engine, items, cols]);
  useEffect(() => engine.connect(), [engine]);

  const selecting = Boolean(selected && selected.size > 0);

  return (
    <div className={`g-grid${selecting ? " is-selecting" : ""}`}>
      {columns.map((col, c) => (
        <div className="g-col" key={c}>
          {col.map((p) => {
            const aspect = state.aspects[p.id] ?? knownAspect(p) ?? FALLBACK_ASPECT;
            const delay = state.revealed[p.id];
            const isIn = delay !== undefined;
            const isSel = Boolean(selected?.has(p.id));
            const dl = downloadHref?.(p) ?? null;
            return (
              <div
                key={p.id}
                ref={engine.register}
                data-tile-id={p.id}
                className={`g-tile${isIn ? " is-in" : ""}${isSel ? " is-selected" : ""}`}
                style={{ aspectRatio: String(aspect), transitionDelay: isIn && delay ? `${delay}ms` : undefined }}
              >
                <button type="button" className="g-tile__open" onClick={() => onOpen(p.id)} aria-label={`View ${p.filename}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="g-tile__img"
                    src={p.thumb}
                    srcSet={p.preview && p.preview !== p.thumb ? `${p.thumb} 600w, ${p.preview} 1600w` : undefined}
                    sizes={SIZES}
                    alt={p.filename}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    onLoad={(e) => engine.loaded(p.id, e.currentTarget)}
                    onError={() => engine.loaded(p.id, null)}
                  />
                </button>
                <span className="g-tile__shade" aria-hidden="true" />
                {watermark && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="g-tile__wm" src={brand.watermark} alt="" aria-hidden="true" draggable={false} />
                )}
                {selected && onToggle && (
                  <label className="g-check" title={isSel ? "Selected" : "Select"}>
                    <input type="checkbox" checked={isSel} onChange={() => onToggle(p.id)} aria-label={`Select ${p.filename}`} />
                    <span className="g-check__box" aria-hidden="true">
                      <CheckIcon size={12} />
                    </span>
                  </label>
                )}
                {noted?.has(p.id) && (
                  <span className="g-tile__noted" title="Revision noted">
                    <PencilIcon size={12} />
                    <span className="g-tile__noted-label">Revision noted</span>
                  </span>
                )}
                {dl && (
                  <a className="g-tile__dl" href={dl} aria-label={`Download ${p.filename}`} title="Download full resolution">
                    <DownloadIcon />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
