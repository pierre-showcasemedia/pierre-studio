"use client";
// Scroll reveal for gallery blocks, matching the marketing site: content fades
// in and rises as it scrolls into view (.85s, cubic-bezier(.2,.8,.2,1)), with
// a small stagger of 75ms per step, capped at 4 steps. Reduced motion shows
// everything at rest (see src/styles/gallery.css).
import { useEffect, useRef, type CSSProperties, type ElementType, type ReactNode } from "react";
import "@/styles/gallery.css";

export default function Rise({
  children,
  step = 0,
  as: Tag = "div",
  className = "",
  style,
}: {
  children: ReactNode;
  step?: number;
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          el.classList.add("is-in");
          io.disconnect();
        }
      },
      { threshold: 0, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const delay = Math.min(Math.max(step, 0), 4) * 75;
  return (
    <Tag ref={ref} className={`g-rise ${className}`} style={delay ? { ...style, transitionDelay: `${delay}ms` } : style}>
      {children}
    </Tag>
  );
}
