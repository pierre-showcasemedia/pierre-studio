"use client";
// The admin's phone helpers (Oct 28 2026; the owner: "build the backend to be
// FULLY optimized on mobile ... easy to run/manage on the go from an
// iPhone"). Renders nothing on a computer except the pull to refresh mark,
// which never shows there.
//
//   - Table labels: on a phone every .adm-table reads as cards, one line per
//     cell with its column's name (globals.css). The name comes from the
//     header cell above, copied here into each cell's data-label, again
//     whenever the page's rows change.
//   - Filters: a segmented filter that scrolls sideways keeps its active
//     option in view.
//   - Pull to refresh: opened from the Home Screen the admin runs like an
//     app, with no browser bar and no reload button. Pulling down at the top
//     of a page refreshes it (router.refresh, so nothing typed is lost).
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

const PHONE = "(max-width: 759px)";
const PULL = 72; // px of (damped) pull that arms a refresh

function labelTables(root: ParentNode) {
  for (const table of root.querySelectorAll<HTMLTableElement>("table.adm-table:not(.adm-table--stack):not(.adm-table--custom)")) {
    const heads = table.tHead?.rows[0]?.cells;
    if (!heads?.length) continue;
    const names: string[] = [];
    for (const th of heads) {
      const name = (th.getAttribute("aria-label") ? "" : th.textContent ?? "").trim();
      for (let i = 0; i < Math.max(1, th.colSpan); i++) names.push(name);
    }
    for (const body of table.tBodies) {
      for (const row of body.rows) {
        let col = 0;
        for (const cell of row.cells) {
          const name = names[col] ?? "";
          if (cell.getAttribute("data-label") !== name) cell.setAttribute("data-label", name);
          col += Math.max(1, cell.colSpan);
        }
      }
    }
  }
}

function centerActiveSegments(root: ParentNode) {
  for (const seg of root.querySelectorAll<HTMLElement>(".adm-seg")) {
    if (seg.scrollWidth <= seg.clientWidth + 1) continue;
    const on = seg.querySelector<HTMLElement>(".is-active, [aria-selected='true']");
    if (!on) continue;
    const left = on.offsetLeft - (seg.clientWidth - on.offsetWidth) / 2;
    seg.scrollLeft = Math.max(0, left);
  }
}

export default function PhoneKit() {
  const pathname = usePathname();
  const router = useRouter();
  const [pull, setPull] = useState(0);
  const [refreshing, startRefresh] = useTransition();
  const armed = pull >= PULL;
  const start = useRef<{ x: number; y: number } | null>(null);

  // Labels and filters: on every page, and again when its content changes.
  useEffect(() => {
    if (!window.matchMedia(PHONE).matches) return;
    const main = document.querySelector(".adm-main") ?? document.body;
    labelTables(main);
    centerActiveSegments(main);
    let queued = 0;
    const mo = new MutationObserver(() => {
      if (queued) return;
      queued = window.requestAnimationFrame(() => {
        queued = 0;
        labelTables(main);
      });
    });
    mo.observe(main, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (queued) window.cancelAnimationFrame(queued);
    };
  }, [pathname]);

  // Pull to refresh, only when the admin runs as a Home Screen app.
  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!standalone) return;
    let dist = 0;
    const onStart = (e: TouchEvent) => {
      const t = e.target as HTMLElement | null;
      // Not inside a sheet, a viewer, a sideways scroller or a field.
      if (window.scrollY > 0 || e.touches.length !== 1 || t?.closest("dialog, [role='dialog'], .adm-side, .adm-seg, input, textarea, select, [data-no-pull]")) {
        start.current = null;
        return;
      }
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      dist = 0;
    };
    const onMove = (e: TouchEvent) => {
      const s = start.current;
      if (!s) return;
      const dy = e.touches[0].clientY - s.y;
      const dx = e.touches[0].clientX - s.x;
      if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) {
        if (dist) setPull(0);
        dist = 0;
        if (dy < -6 || Math.abs(dx) > 12) start.current = null;
        return;
      }
      dist = Math.min(120, dy * 0.5);
      setPull(dist);
    };
    const onEnd = () => {
      if (start.current && dist >= PULL) {
        if (navigator.vibrate) navigator.vibrate(8);
        startRefresh(() => router.refresh());
      }
      start.current = null;
      dist = 0;
      setPull(0);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [router]);

  if (!pull && !refreshing) return null;
  const y = refreshing ? PULL * 0.75 : pull;
  return (
    <div className={`adm-ptr${armed || refreshing ? " is-armed" : ""}${refreshing ? " is-busy" : ""}`} style={{ transform: `translate(-50%, ${y - 44}px)`, opacity: refreshing ? 1 : Math.min(1, pull / 40) }} role="status" aria-live="polite">
      <svg viewBox="0 0 24 24" aria-hidden style={{ transform: refreshing ? undefined : `rotate(${Math.round((pull / PULL) * 270)}deg)` }}>
        <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="sr-only">{refreshing ? "Refreshing" : armed ? "Release to refresh" : "Pull to refresh"}</span>
    </div>
  );
}
