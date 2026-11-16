"use client";
// A board's columns on a phone (Oct 28 2026): the Photo QC and Video boards
// sit side by side on a computer, but a phone showed one and a half columns
// and hid the rest off to the right. Here a phone gets a strip of the
// columns with their counts above the board, and the board shows one column
// at a time; a sideways swipe on the board moves to the next or previous
// column. The choice is remembered for the visit, so coming back from a card
// lands on the same column. A computer never sees the strip.
//
// Each column inside is a .vb-col with data-col set to its key.
import { useRef, useState, useSyncExternalStore } from "react";

export type BoardTab = { key: string; label: string; count: number; hot?: boolean };

const noSubscribe = () => () => {};

export function BoardTabs({ id, tabs, initial, children }: { id: string; tabs: BoardTab[]; initial: string; children: React.ReactNode }) {
  const store = `studio-board:${id}`;
  // Back on this board in the same visit: the column picked last time (read
  // after hydration; the server renders the default column).
  const saved = useSyncExternalStore(
    noSubscribe,
    () => {
      try {
        return window.sessionStorage.getItem(store);
      } catch {
        return null; // private mode: start on the default column
      }
    },
    () => null,
  );
  const [picked, setPicked] = useState<string | null>(null);
  const active = picked ?? (saved && tabs.some((t) => t.key === saved) ? saved : initial);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const pick = (key: string) => {
    setPicked(key);
    try {
      window.sessionStorage.setItem(store, key);
    } catch {
      /* nothing to remember it in */
    }
  };
  const step = (d: number) => {
    const i = tabs.findIndex((t) => t.key === active);
    const next = tabs[i + d];
    if (next) pick(next.key);
  };

  return (
    <div className="bt">
      <div className="bt-tabs adm-seg" role="tablist" aria-label="Columns">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={active === t.key} aria-controls={id} className={`${active === t.key ? "is-active" : ""}${t.hot && t.count ? " is-hot" : ""}`} onClick={() => pick(t.key)}>
            {t.label}
            <span className="bt-n">{t.count}</span>
          </button>
        ))}
      </div>
      {/* Only the picked column shows on a phone. The keys are fixed column names. */}
      <style>{`@media (max-width: 759px) { #${id} .vb-col[data-col]:not([data-col="${active}"]) { display: none; } }`}</style>
      <div
        id={id}
        className="bt-board"
        onTouchStart={(e) => {
          swipe.current = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
        }}
        onTouchEnd={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s || !window.matchMedia("(max-width: 759px)").matches) return;
          const t = e.changedTouches[0];
          const dx = t.clientX - s.x;
          const dy = t.clientY - s.y;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) step(dx < 0 ? 1 : -1);
        }}
      >
        {children}
      </div>
    </div>
  );
}
