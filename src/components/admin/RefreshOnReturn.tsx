"use client";
// Fresh server data when a page comes back into view (Nov 5 2026). the owner had
// the 925 Example Spruce listing open on his phone when the video editor uploaded the second
// cut; the page still showed one film until it was reloaded by hand. Now a
// page that is shown again (the tab or the Home Screen app comes to the
// front, or the browser restores it from its back-forward cache) refreshes
// its server components. Throttled so a flurry of focus events costs one
// fetch. MediaGrid swaps in fresh rows only while nothing is in flight, so a
// drag or a save in progress is never disturbed.
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export default function RefreshOnReturn({ minGapMs = 4000 }: { minGapMs?: number }) {
  const router = useRouter();
  const last = useRef(0);
  useEffect(() => {
    last.current = Date.now();
    const go = () => {
      const now = Date.now();
      if (now - last.current < minGapMs) return;
      last.current = now;
      router.refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") go();
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) go();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("focus", go);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("focus", go);
    };
  }, [router, minGapMs]);
  return null;
}
