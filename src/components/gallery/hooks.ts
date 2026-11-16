"use client";
// Small browser hooks shared by the gallery, grid, lightbox and dialogs.
import { useEffect, useSyncExternalStore, type RefObject } from "react";

export const EASE = "cubic-bezier(.2,.8,.2,1)";

const noop = () => () => {};

function mediaStore(query: string) {
  return {
    subscribe(cb: () => void) {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    get: () => window.matchMedia(query).matches,
  };
}

const reduced = mediaStore("(prefers-reduced-motion: reduce)");
export function useReducedMotion(): boolean {
  return useSyncExternalStore(reduced.subscribe, reduced.get, () => false);
}
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Grid columns by width: 2 on phones, 3 on tablets and small laptops, 4 above.
const wide = mediaStore("(min-width: 1100px)");
const mid = mediaStore("(min-width: 640px)");
function subscribeColumns(cb: () => void) {
  const a = wide.subscribe(cb);
  const b = mid.subscribe(cb);
  return () => {
    a();
    b();
  };
}
export function useColumns(): number {
  return useSyncExternalStore(subscribeColumns, () => (wide.get() ? 4 : mid.get() ? 3 : 2), () => 3);
}

// Viewport size as a stable string snapshot ("1440x900").
function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  window.addEventListener("orientationchange", cb);
  return () => {
    window.removeEventListener("resize", cb);
    window.removeEventListener("orientationchange", cb);
  };
}
export function useViewport(): { w: number; h: number } {
  const snap = useSyncExternalStore(
    subscribeResize,
    () => `${window.innerWidth}x${window.innerHeight}`,
    () => "1280x800"
  );
  const [w, h] = snap.split("x").map(Number);
  return { w, h };
}

// True once mounted in the browser (portals need document.body).
export function useMounted(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}

// Lock page scroll while a dialog is open, without the page shifting sideways
// when a scrollbar disappears. The page scrolls on <html> here (globals.css
// sets overflow-x on html and body), so that is the element to lock.
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const html = document.documentElement;
    const body = document.body;
    const gap = window.innerWidth - html.clientWidth;
    const prev = { html: html.style.overflow, body: body.style.overflow, pad: body.style.paddingRight };
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      html.style.overflow = prev.html;
      body.style.overflow = prev.body;
      body.style.paddingRight = prev.pad;
    };
  }, [active]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Keep Tab inside a dialog. Focus moves in on open (to `initial`, else the
// first control) and back to whatever had it on close, unless the dialog
// restores focus itself (restore = false).
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, opts: { initial?: RefObject<HTMLElement | null>; restore?: boolean } = {}) {
  const { initial, restore = true } = opts;
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const before = document.activeElement as HTMLElement | null;
    const first = initial?.current ?? root.querySelector<HTMLElement>(FOCUSABLE) ?? root;
    first.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const a = items[0];
      const z = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === a || !root.contains(document.activeElement))) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && (document.activeElement === z || !root.contains(document.activeElement))) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (restore && before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [ref, active, initial, restore]);
}
