"use client";
// The download bar under the hero: Download all · Download for MLS · Add to
// Dropbox · Download selected (N). Once it scrolls past the top it pins as a
// compact glass bar until the end of the gallery, so the actions are always
// one tap away.
//
// Pinned with position: fixed (measured from the holder), so it can float over
// the full-bleed hero area with its own top offset under any visible header.
import { useEffect, useRef, useState } from "react";
import { DownloadIcon, DriveIcon, DropboxIcon } from "./icons";
import "@/styles/gallery.css";

type Pin = { stuck: boolean; top: number; left: number; maxWidth: number; height: number };

export default function DownloadBar({
  fullHref,
  mlsHref,
  onDropbox,
  onDrive = null,
  selectedCount,
  onDownloadSelected,
  onClearSelection,
  downloadingSelected = false,
}: {
  fullHref: string | null;
  mlsHref: string | null;
  onDropbox: (() => void) | null;
  onDrive?: (() => void) | null; // Save to Google Drive (business.fileStore google_drive)
  selectedCount: number;
  onDownloadSelected: () => void;
  onClearSelection: () => void;
  downloadingSelected?: boolean;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [pin, setPin] = useState<Pin>({ stuck: false, top: 12, left: 0, maxWidth: 0, height: 0 });

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    let raf = 0;
    let lastHeight = 0;
    const check = () => {
      raf = 0;
      // Pin under whatever header is still on screen (none over a hero).
      const header = document.querySelector("header");
      const top = Math.max(0, header ? header.getBoundingClientRect().bottom : 0) + 12;
      const r = el.getBoundingClientRect();
      const end = el.parentElement?.getBoundingClientRect().bottom ?? Infinity;
      const stuck = el.offsetParent !== null && r.top < top && end > top + 140;
      if (!stuck) lastHeight = el.offsetHeight;
      const next = { stuck, top, left: r.left, maxWidth: Math.max(0, r.width), height: lastHeight };
      setPin((p) =>
        p.stuck === next.stuck && p.top === next.top && p.left === next.left && p.maxWidth === next.maxWidth && p.height === next.height ? p : next
      );
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Nothing to offer yet (no zips, no Dropbox, nothing ticked): keep the
  // element so pinning works the moment something appears.
  if (!fullHref && !mlsHref && !onDropbox && !onDrive && selectedCount === 0) return <div ref={holder} className="g-bar g-bar--empty" aria-hidden="true" />;

  return (
    <div ref={holder} className={`g-bar${pin.stuck ? " is-stuck" : ""}`} style={pin.stuck ? { height: pin.height } : undefined}>
      <div
        className="g-bar__inner"
        role="toolbar"
        aria-label="Downloads"
        style={pin.stuck ? { position: "fixed", top: pin.top, left: pin.left, maxWidth: pin.maxWidth } : undefined}
      >
        {fullHref && (
          <a href={fullHref} className="chip g-pill" title="Every photo and film at full resolution, in one zip">
            <DownloadIcon />
            <span>Download all</span>
          </a>
        )}
        {mlsHref && (
          <a href={mlsHref} className="chip g-pill" title="Every photo at 2048px, sized for the MLS, in one zip">
            <DownloadIcon />
            <span className="g-lbl-long">Download for MLS</span>
            <span className="g-lbl-short">For MLS</span>
          </a>
        )}
        {onDropbox && (
          <button type="button" className="chip g-pill g-pill--dropbox" onClick={onDropbox} title="Copy files straight into your Dropbox, no downloading">
            <DropboxIcon />
            <span className="g-lbl-long">Add to Dropbox</span>
            <span className="g-lbl-short">Dropbox</span>
          </button>
        )}
        {onDrive && (
          <button type="button" className="chip g-pill g-pill--dropbox" onClick={onDrive} title="Copy files straight into your Google Drive, no downloading">
            <DriveIcon />
            <span className="g-lbl-long">Save to Google Drive</span>
            <span className="g-lbl-short">Drive</span>
          </button>
        )}
        {selectedCount > 0 && (
          <>
            <button type="button" className="chip g-pill g-pill--ink" onClick={onDownloadSelected} disabled={downloadingSelected}>
              <DownloadIcon />
              <span className="g-lbl-long">Download selected ({selectedCount})</span>
              <span className="g-lbl-short">Selected ({selectedCount})</span>
            </button>
            <button type="button" className="g-bar__clear" onClick={onClearSelection}>
              Clear
            </button>
          </>
        )}
      </div>
    </div>
  );
}
