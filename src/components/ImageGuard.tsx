"use client";
import { useEffect } from "react";

// Site-wide deterrent against casual image saving: blocks right-click,
// drag-out, long-press save, and copy on every image. (A determined user can
// always screenshot — this stops the easy paths.)
export default function ImageGuard() {
  useEffect(() => {
    const isImg = (t: EventTarget | null) =>
      t instanceof HTMLImageElement || (t instanceof HTMLElement && !!t.closest("picture, .proj-gallery"));
    const block = (e: Event) => {
      if (isImg(e.target)) e.preventDefault();
    };
    document.addEventListener("contextmenu", block);
    document.addEventListener("dragstart", block);
    document.addEventListener("copy", block);
    return () => {
      document.removeEventListener("contextmenu", block);
      document.removeEventListener("dragstart", block);
      document.removeEventListener("copy", block);
    };
  }, []);
  return null;
}
