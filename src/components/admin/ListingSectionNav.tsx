"use client";
// Sticky in-page nav for the admin listing page: Media, Details, Shoots,
// Orders and downloads, Activity. Highlights the section in view as the page
// scrolls (a sliding local underline), smooth-scrolls on click, and keeps
// the URL hash in step without a jump. Plain anchor links, so it works before
// the script loads. Styles live in src/styles/admin-media.css (.lsn*).
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type SectionLink = { id: string; label: string; count?: number | null };

// A little air under this bar. The bar's own bottom edge is measured, so it
// holds with the sidebar (no header on a computer) and the phone's top bar.
const AIR = 24;

export default function ListingSectionNav({ items }: { items: SectionLink[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  const track = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const lockUntil = useRef(0);

  // Scroll spy: the last section whose top has passed under the bar; the
  // final one once the page bottoms out.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      if (performance.now() < lockUntil.current) return;
      let cur = items[0]?.id ?? "";
      const offset = (track.current?.closest(".lsn")?.getBoundingClientRect().bottom ?? 116) + AIR;
      for (const it of items) {
        const el = document.getElementById(it.id);
        if (el && el.getBoundingClientRect().top - offset <= 1) cur = it.id;
      }
      const doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4 && items.length) cur = items[items.length - 1].id;
      setActive((a) => (a === cur ? a : cur));
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(measure);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [items]);

  // Slide the underline under the active item and keep it in view on phones.
  useLayoutEffect(() => {
    const t = track.current;
    const b = bar.current;
    const btn = t?.querySelector<HTMLElement>(`[data-id="${active}"]`);
    if (!t || !b || !btn) return;
    b.style.width = `${btn.offsetWidth - 24}px`;
    b.style.transform = `translateX(${btn.offsetLeft + 12}px)`;
    b.style.opacity = "1";
    const left = btn.offsetLeft;
    const right = left + btn.offsetWidth;
    if (left < t.scrollLeft || right > t.scrollLeft + t.clientWidth) {
      t.scrollTo({ left: Math.max(0, left - 16), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
  }, [active]);

  const go = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    lockUntil.current = e.timeStamp + 900; // same clock as performance.now()
    setActive(id);
    el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    window.history.replaceState(window.history.state, "", `#${id}`);
  };

  return (
    <nav className="lsn" aria-label="Listing sections">
      <div className="lsn__track" ref={track}>
        {items.map((it) => (
          <a
            key={it.id}
            href={`#${it.id}`}
            data-id={it.id}
            className={`lsn__item${active === it.id ? " is-active" : ""}`}
            aria-current={active === it.id ? "true" : undefined}
            onClick={(e) => go(e, it.id)}
          >
            {it.label}
            {it.count != null && <span className="lsn__count">{it.count}</span>}
          </a>
        ))}
        <span className="lsn__bar" ref={bar} style={{ width: 0, opacity: 0 }} aria-hidden />
      </div>
    </nav>
  );
}
