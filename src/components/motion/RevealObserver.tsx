"use client";
// Scroll reveal, the marketing site's way: anything marked data-reveal that
// starts below the fold waits at 22px down and transparent, then settles in as
// it reaches the lower 8% of the viewport. Elements already on screen when a
// page arrives settle in place, staggered by data-reveal-index (75 ms steps,
// capped at 4). One observer for the whole app; new pages are picked up by a
// MutationObserver, so server components only add the attribute.
import { useEffect } from "react";

// data-reveal anywhere, plus the admin's building blocks (so admin pages get
// the same motion without each page opting in). A block inside another
// target is left to its parent, so nothing slides twice.
const TARGETS = "[data-reveal], .adm-page > .adm-head, .adm-tile, .adm-lcard, .adm-section, .adm-page > .adm-table-wrap, .adm-page > .adm-card";

export default function RevealObserver() {
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches) return;
    const seen = new WeakSet<Element>();
    const pending = new Set<HTMLElement>();
    // Once settled, the classes come off so the element's own hover lifts and
    // transitions work as before (a filled animation would pin transform).
    const tidy = (el: HTMLElement) => {
      el.classList.remove("reveal-ready", "is-revealed", "reveal-settle");
      el.style.removeProperty("--reveal-delay");
    };
    const settleLater = (el: HTMLElement, ms: number) => window.setTimeout(() => tidy(el), ms);
    const reveal = (el: HTMLElement) => {
      el.classList.add("is-revealed");
      pending.delete(el);
      io.unobserve(el);
      settleLater(el, 1300);
    };
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && reveal(e.target as HTMLElement)),
      { threshold: 0, rootMargin: "0px 0px -8% 0px" }
    );
    // Fast scrolls and jumps: anything at or above the fold shows next frame.
    let frame = 0;
    const sweep = () => {
      frame = 0;
      const limit = window.innerHeight * 0.96;
      pending.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.top < limit) reveal(el);
      });
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(sweep);
    };
    const scan = () => {
      document.querySelectorAll<HTMLElement>(TARGETS).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        if (el.parentElement?.closest(TARGETS)) return;
        // Siblings in a grid stagger by their place in it, capped at 4 steps.
        const idx = el.dataset.revealIndex ?? (el.parentElement ? String(Array.prototype.indexOf.call(el.parentElement.children, el) % 6) : "0");
        const i = Math.min(Number(idx) || 0, 4);
        el.style.setProperty("--reveal-delay", `${i * 75}ms`);
        if (el.getBoundingClientRect().top >= window.innerHeight - 30) {
          el.classList.add("reveal-ready");
          pending.add(el);
          io.observe(el);
        } else {
          el.classList.add("reveal-settle");
          settleLater(el, 1300);
        }
      });
      queue();
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    return () => {
      io.disconnect();
      mo.disconnect();
      window.removeEventListener("scroll", queue);
      window.removeEventListener("resize", queue);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}
