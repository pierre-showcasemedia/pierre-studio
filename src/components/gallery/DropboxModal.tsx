"use client";
// "Add to Dropbox": the client picks what to copy (photos, MLS photos, films,
// each named section, revised files, or just what they ticked), then the
// Dropbox Saver copies the files server to server from short-lived signed
// URLs (POST /api/portal/dropbox-manifest). Nothing downloads to the device.
// Saver takes at most 100 files per window, so big sets go in batches, each
// opened by its own click so the browser never blocks the Dropbox window.
// Demo mode (no database) runs the whole flow but sends nothing.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EASE, prefersReducedMotion, useFocusTrap, useScrollLock } from "./hooks";
import { CheckIcon, CloseIcon, DropboxIcon } from "./icons";
import { plural } from "./types";
import "@/styles/gallery.css";
import { brand } from "@/lib/brand";

export type DropboxOption = { key: string; label: string; detail: string; count: number; unit: string };
export type DropboxMode = { mode: "live"; appKey: string } | { mode: "demo" };

type SaverFile = { url: string; filename: string };
type ManifestResponse = { ok?: boolean; demo?: boolean; files?: { url?: string | null; filename: string }[]; missing?: number; error?: string };

type Phase =
  | { k: "choose" }
  | { k: "busy"; msg: string }
  | { k: "next"; msg: string; label: string }
  | { k: "end"; tone: "ok" | "bad" | "quiet"; title: string; msg?: string };

const BATCH = 100;
const SELECTED = "selected";

let dropinsLoading: Promise<void> | null = null;
function loadDropins(appKey: string): Promise<void> {
  type W = Window & { Dropbox?: unknown };
  if ((window as W).Dropbox) return Promise.resolve();
  if (dropinsLoading) return dropinsLoading;
  dropinsLoading = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://www.dropbox.com/static/api/2/dropins.js";
    s.id = "dropboxjs";
    s.setAttribute("data-app-key", appKey);
    s.onload = () => resolve();
    s.onerror = () => {
      dropinsLoading = null;
      s.remove();
      reject(new Error("Dropbox script failed to load"));
    };
    document.body.appendChild(s);
  });
  return dropinsLoading;
}

function saveBatch(files: SaverFile[]): Promise<boolean> {
  return new Promise((resolve) => {
    type Saver = { save: (opts: object) => void };
    const dbx = (window as Window & { Dropbox?: Saver }).Dropbox;
    if (!dbx) return resolve(false);
    dbx.save({
      files: files.map((f) => ({ url: f.url, filename: f.filename })),
      success: () => resolve(true),
      cancel: () => resolve(false),
      error: () => resolve(false),
    });
  });
}

export default function DropboxModal({
  slug,
  dropbox,
  options,
  selectedIds,
  onClose,
}: {
  slug: string;
  dropbox: DropboxMode;
  options: DropboxOption[];
  selectedIds: string[];
  onClose: () => void;
}) {
  const hasSelection = selectedIds.length > 0;
  const [chosen, setChosen] = useState<Set<string>>(() => new Set([options.find((o) => o.key === "photos")?.key ?? options[0]?.key].filter(Boolean) as string[]));
  const [phase, setPhase] = useState<Phase>({ k: "choose" });
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const continueRef = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const closing = useRef(false);

  useScrollLock(true);
  useFocusTrap(panelRef, true, { initial: confirmRef });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Fetch the Dropbox script as soon as the dialog opens, so the Dropbox
  // window can open straight from the confirm click.
  useEffect(() => {
    if (dropbox.mode === "live") loadDropins(dropbox.appKey).catch(() => {});
  }, [dropbox]);

  // Settle in: short fade and rise.
  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    overlayRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: EASE });
    panelRef.current?.animate([{ opacity: 0, transform: "translateY(18px) scale(.985)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: EASE });
  }, []);

  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    continueRef.current = null;
    if (!prefersReducedMotion()) {
      await Promise.all([
        overlayRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE, fill: "forwards" }).finished,
        panelRef.current?.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(10px)" }], { duration: 200, easing: EASE, fill: "forwards" }).finished,
      ]).catch(() => {});
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggle = (key: string) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else {
        // "Only the selected" stands alone; picking a group clears it.
        if (key === SELECTED) n.clear();
        else n.delete(SELECTED);
        n.add(key);
      }
      return n;
    });

  const total = chosen.has(SELECTED)
    ? selectedIds.length
    : options.filter((o) => chosen.has(o.key)).reduce((a, o) => a + o.count, 0);

  const waitForClick = (msg: string, label: string) =>
    new Promise<boolean>((resolve) => {
      continueRef.current = () => resolve(true);
      setPhase({ k: "next", msg, label });
    });

  const run = async () => {
    if (!total) return;
    const clickedAt = performance.now();
    setPhase({ k: "busy", msg: "Preparing your files" });
    const body = chosen.has(SELECTED) ? { slug, ids: selectedIds } : { slug, groups: options.map((o) => o.key).filter((k) => chosen.has(k)) };
    let json: ManifestResponse = {};
    let status = 0;
    try {
      const r = await fetch("/api/portal/dropbox-manifest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      status = r.status;
      json = (await r.json().catch(() => ({}))) as ManifestResponse;
    } catch {
      json = {};
    }
    if (!alive.current) return;
    const files = json.files ?? [];
    if (!json.ok || !files.length) {
      setPhase({
        k: "end",
        tone: "bad",
        title: status === 403 || status === 402 ? "Downloads unlock after payment" : "Dropbox could not be prepared",
        msg: status === 403 || status === 402 ? undefined : "Please try again in a moment, or download the files instead.",
      });
      return;
    }
    const missingNote = json.missing ? ` ${plural(json.missing, "MLS file")} ${json.missing === 1 ? "is" : "are"} still being prepared and ${json.missing === 1 ? "was" : "were"} left out.` : "";
    if (dropbox.mode === "demo" || json.demo) {
      setPhase({ k: "end", tone: "quiet", title: "Demo mode: nothing was sent to Dropbox", msg: `${plural(files.length, "file")} would be added.${missingNote}` });
      return;
    }
    const all = files.filter((f): f is SaverFile => typeof f.url === "string" && f.url.length > 0);
    try {
      await loadDropins(dropbox.appKey);
    } catch {
      if (alive.current) setPhase({ k: "end", tone: "bad", title: "Dropbox did not load", msg: "Please check your connection and try again, or download the files instead." });
      return;
    }
    const batches: SaverFile[][] = [];
    for (let i = 0; i < all.length; i += BATCH) batches.push(all.slice(i, i + BATCH));
    for (let i = 0; i < batches.length; i++) {
      // The Dropbox window must open from a click. The confirm click still
      // counts if the files were ready quickly; otherwise ask for one more.
      if (i > 0) {
        if (!(await waitForClick(`Batch ${i} of ${batches.length} saved. Dropbox takes up to ${BATCH} files at a time.`, `Add batch ${i + 1} of ${batches.length}`))) return;
      } else if (performance.now() - clickedAt > 900) {
        if (!(await waitForClick(`${plural(all.length, "file")} ready for your Dropbox.`, "Open Dropbox"))) return;
      }
      if (!alive.current) return;
      setPhase({ k: "busy", msg: batches.length > 1 ? `Confirm in the Dropbox window (batch ${i + 1} of ${batches.length})` : "Confirm in the Dropbox window" });
      const saved = await saveBatch(batches[i]);
      if (!alive.current) return;
      if (!saved) {
        setPhase({ k: "end", tone: "quiet", title: i > 0 ? "Stopped. Earlier batches were saved to your Dropbox." : "Cancelled. Nothing was added to Dropbox." });
        return;
      }
    }
    setPhase({
      k: "end",
      tone: "ok",
      title: `${plural(all.length, "file")} saved to your Dropbox`,
      msg: `Dropbox copies them into the folder you picked. Films can take a few minutes to appear.${missingNote}`,
    });
  };

  const busy = phase.k === "busy" || phase.k === "next";

  return createPortal(
    <div className="g-modal" role="presentation">
      <div ref={overlayRef} className="g-modal__overlay" onClick={() => void close()} aria-hidden="true" />
      <div ref={panelRef} className="g-modal__panel" role="dialog" aria-modal="true" aria-labelledby="g-dbx-title">
        <button type="button" className="g-modal__x" aria-label="Close" onClick={() => void close()}>
          <CloseIcon />
        </button>
        <div className="kicker" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <DropboxIcon size={14} /> Dropbox
        </div>
        <h2 id="g-dbx-title" className="g-modal__title">What do you want to add to Dropbox?</h2>
        <p className="g-modal__lede">Files go straight from {brand.name} to your Dropbox. Nothing downloads to this device.</p>

        {phase.k === "choose" ? (
          <>
            {hasSelection && (
              <div className="g-opts g-opts--one">
                <Option
                  checked={chosen.has(SELECTED)}
                  onChange={() => toggle(SELECTED)}
                  label={`Only the ${selectedIds.length} selected`}
                  detail="The photos and films you ticked"
                  count={plural(selectedIds.length, "file")}
                />
              </div>
            )}
            {hasSelection && <div className="g-opts__or">Or choose by group</div>}
            <div className="g-opts">
              {options.map((o) => (
                <Option key={o.key} checked={chosen.has(o.key)} onChange={() => toggle(o.key)} label={o.label} detail={o.detail} count={plural(o.count, o.unit)} />
              ))}
            </div>
            <div className="g-modal__foot">
              <span className="g-modal__total">{total ? plural(total, "file") : "Choose at least one"}</span>
              <span className="g-modal__btns">
                <button type="button" className="btn btn-ghost" onClick={() => void close()}>
                  Cancel
                </button>
                <button ref={confirmRef} type="button" className="btn btn-primary" disabled={!total} onClick={() => void run()}>
                  <DropboxIcon />
                  Add to Dropbox
                </button>
              </span>
            </div>
          </>
        ) : (
          <div className="g-modal__status" aria-live="polite">
            {busy && <span className="g-modal__pulse" aria-hidden="true" />}
            {phase.k === "busy" && <p className="g-modal__msg">{phase.msg}</p>}
            {phase.k === "next" && (
              <>
                <p className="g-modal__msg">{phase.msg}</p>
                <button type="button" className="btn btn-primary" onClick={() => continueRef.current?.()}>
                  <DropboxIcon />
                  {phase.label}
                </button>
              </>
            )}
            {phase.k === "end" && (
              <>
                <p className={`g-modal__end g-modal__end--${phase.tone}`}>{phase.title}</p>
                {phase.msg && <p className="g-modal__msg">{phase.msg}</p>}
                <span className="g-modal__btns">
                  {phase.tone === "bad" && (
                    <button type="button" className="btn btn-ghost" onClick={() => setPhase({ k: "choose" })}>
                      Back
                    </button>
                  )}
                  <button type="button" className="btn btn-primary" onClick={() => void close()}>
                    Done
                  </button>
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function Option({ checked, onChange, label, detail, count }: { checked: boolean; onChange: () => void; label: string; detail: string; count: string }) {
  return (
    <label className={`g-opt${checked ? " is-on" : ""}`}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="g-opt__box" aria-hidden="true">
        <CheckIcon size={12} />
      </span>
      <span className="g-opt__text">
        <span className="g-opt__label">{label}</span>
        <span className="g-opt__detail">{detail}</span>
      </span>
      <span className="g-opt__count">{count}</span>
    </label>
  );
}
