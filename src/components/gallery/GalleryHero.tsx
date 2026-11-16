"use client";
// Full-bleed cover hero for the listing and share pages. The cover settles in
// slowly (scale 1.04 to 1 over 1.4s) once it has loaded, and the address and
// location fade up after it, staggered like the marketing site hero.
import { useCallback, useState } from "react";
import "@/styles/gallery.css";

export default function GalleryHero({
  src,
  srcSet,
  alt,
  title,
  subtitle,
}: {
  src: string;
  srcSet?: string;
  alt: string;
  title: string;
  subtitle?: string;
}) {
  const [phase, setPhase] = useState<"init" | "loading" | "loaded">("init");
  const settle = useCallback((img: HTMLImageElement | null) => {
    if (!img) return;
    // Cached covers finish before hydration: settle at once. Otherwise fade
    // the cover in when it arrives.
    if (img.complete && img.naturalWidth) setPhase("loaded");
    else setPhase((p) => (p === "init" ? "loading" : p));
  }, []);
  return (
    <section className={`g-hero${phase === "loaded" ? " is-loaded" : phase === "loading" ? " is-loading" : ""}`}>
      <div className="g-hero__media">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={settle}
          className="g-hero__img"
          src={src}
          srcSet={srcSet}
          // object-fit: cover on a full-height hero: on a portrait screen the
          // photo is drawn about 1.5 screen-heights wide, so ask for that.
          sizes={srcSet ? "(max-aspect-ratio: 3/2) 150vh, 100vw" : undefined}
          alt={alt}
          fetchPriority="high"
          decoding="async"
          draggable={false}
          onLoad={() => setPhase("loaded")}
          onError={() => setPhase("loaded")}
        />
      </div>
      <div className="g-hero__shade" aria-hidden="true" />
      <div className="wrap g-hero__text">
        <h1 className="h1 g-hero__title">{title}</h1>
        {subtitle && <p className="g-hero__sub">{subtitle}</p>}
      </div>
    </section>
  );
}
