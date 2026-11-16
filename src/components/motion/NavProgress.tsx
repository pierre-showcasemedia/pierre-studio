"use client";
// A hairline progress bar across the top while a page is on its way. Server
// pages here are dynamic, so a click can take a moment before the new page
// cross-fades in; the bar answers the click at once. It starts on any
// same-origin link click (or back/forward) and finishes when the URL changes.
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export default function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const timers = useRef<number[]>([]);
  const first = useRef(true);

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  // The URL changed: finish the bar (skip the very first render).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    clear();
    setState((s) => (s === "loading" ? "done" : s));
    timers.current.push(window.setTimeout(() => setState("idle"), 420));
  }, [pathname, search]);

  useEffect(() => {
    const start = () => {
      clear();
      setState("loading");
      // Never hang: a navigation that goes nowhere (same URL, a refused
      // action) lets the bar fade on its own.
      timers.current.push(window.setTimeout(() => setState("idle"), 12_000));
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      start();
    };
    const onPop = () => start();
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
      clear();
    };
  }, []);

  return <div aria-hidden className={`nav-progress is-${state}`} />;
}
