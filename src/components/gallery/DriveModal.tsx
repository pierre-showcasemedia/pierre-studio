"use client";
// "Save to Google Drive" (Nov 18 2026), the Dropbox dialog's twin for a
// business on Google Drive (business.fileStore). The client picks what to
// save (photos, MLS photos, films, each named section, revised files, or just
// what they ticked), signs in to Google once (Google Identity Services, the
// drive.file permission only: the site can touch only what it saves), and the
// studio copies each file from storage into a new folder in their Drive, one
// request per file (POST /api/portal/drive-save). Nothing downloads to the
// device, and the Google token lives in this page only.
// Demo mode (no database) runs the whole flow but sends nothing.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EASE, prefersReducedMotion, useFocusTrap, useScrollLock } from "./hooks";
import { CheckIcon, CloseIcon, DriveIcon } from "./icons";
import { plural } from "./types";
import "@/styles/gallery.css";
import { brand } from "@/lib/brand";
import type { DropboxOption } from "./DropboxModal";

export type DriveMode = { mode: "live"; clientId: string } | { mode: "demo" };

type PlanFile = { mediaId: string; variant: "original" | "mls"; filename: string };
type PlanResponse = { ok?: boolean; demo?: boolean; files?: PlanFile[]; missing?: number; folderName?: string; error?: string };

type Phase =
  | { k: "choose" }
  | { k: "busy"; msg: string }
  | { k: "end"; tone: "ok" | "bad" | "quiet"; title: string; msg?: string; folder?: boolean };

const SELECTED = "selected";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

type TokenClient = { requestAccessToken: (o?: { prompt?: string }) => void };
type GoogleOAuth = { accounts: { oauth2: { initTokenClient: (c: { client_id: string; scope: string; callback: (r: { access_token?: string; error?: string }) => void; error_callback?: (e: { type?: string }) => void }) => TokenClient } } };

let gisLoading: Promise<void> | null = null;
export function loadGoogleIdentity(): Promise<void> {
  if ((window as Window & { google?: GoogleOAuth }).google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoading = null;
      s.remove();
      reject(new Error("Google sign-in failed to load"));
    };
    document.body.appendChild(s);
  });
  return gisLoading;
}

// One Google sign-in for the drive.file permission; resolves with the token,
// or null when the person closes the window or says no. Called straight from
// a click so the browser lets the Google window open.
export function googleDriveToken(clientId: string, scope = DRIVE_SCOPE): Promise<string | null> {
  return new Promise((resolve) => {
    const g = (window as Window & { google?: GoogleOAuth }).google;
    if (!g?.accounts?.oauth2) return resolve(null);
    const client = g.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (r) => resolve(r.access_token && !r.error ? r.access_token : null),
      error_callback: () => resolve(null),
    });
    client.requestAccessToken({ prompt: "" });
  });
}

export default function DriveModal({
  slug,
  drive,
  options,
  selectedIds,
  onClose,
}: {
  slug: string;
  drive: DriveMode;
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

  // Fetch Google's sign-in script as soon as the dialog opens, so the Google
  // window can open straight from the confirm click.
  useEffect(() => {
    if (drive.mode === "live") loadGoogleIdentity().catch(() => {});
  }, [drive]);

  // Settle in: short fade and rise.
  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    overlayRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: EASE });
    panelRef.current?.animate([{ opacity: 0, transform: "translateY(18px) scale(.985)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: EASE });
  }, []);

  const close = async () => {
    if (closing.current) return;
    closing.current = true;
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

  const run = async () => {
    if (!total) return;
    // The Google window first, straight from this click (browsers block it later).
    let token: string | null = null;
    if (drive.mode === "live") {
      setPhase({ k: "busy", msg: "Sign in to Google in the window that opened" });
      try {
        await loadGoogleIdentity();
      } catch {
        if (alive.current) setPhase({ k: "end", tone: "bad", title: "Google did not load", msg: "Please check your connection and try again, or download the files instead." });
        return;
      }
      token = await googleDriveToken(drive.clientId);
      if (!alive.current) return;
      if (!token) {
        setPhase({ k: "end", tone: "quiet", title: "Cancelled. Nothing was added to Google Drive." });
        return;
      }
    }
    setPhase({ k: "busy", msg: "Preparing your files" });
    const body = chosen.has(SELECTED) ? { slug, step: "plan", ids: selectedIds } : { slug, step: "plan", groups: options.map((o) => o.key).filter((k) => chosen.has(k)) };
    let json: PlanResponse = {};
    let status = 0;
    try {
      const r = await fetch("/api/portal/drive-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      status = r.status;
      json = (await r.json().catch(() => ({}))) as PlanResponse;
    } catch {
      json = {};
    }
    if (!alive.current) return;
    const files = json.files ?? [];
    if (!json.ok || !files.length) {
      setPhase({
        k: "end",
        tone: "bad",
        title: status === 403 || status === 402 ? "Downloads unlock after payment" : "Google Drive could not be prepared",
        msg: status === 403 || status === 402 ? undefined : "Please try again in a moment, or download the files instead.",
      });
      return;
    }
    const missingNote = json.missing ? ` ${plural(json.missing, "MLS file")} ${json.missing === 1 ? "is" : "are"} still being prepared and ${json.missing === 1 ? "was" : "were"} left out.` : "";
    if (drive.mode === "demo" || json.demo) {
      setPhase({ k: "end", tone: "quiet", title: "Demo mode: nothing was sent to Google Drive", msg: `${plural(files.length, "file")} would be added.${missingNote}` });
      return;
    }
    let folderId: string | null = null;
    let saved = 0;
    const failed: string[] = [];
    for (let i = 0; i < files.length; i++) {
      if (!alive.current) return;
      setPhase({ k: "busy", msg: `Saving ${i + 1} of ${files.length} to your Google Drive` });
      const f = files[i];
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const r = await fetch("/api/portal/drive-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, step: "copy", token, folderId, ...f }) });
          const j = (await r.json().catch(() => ({}))) as { ok?: boolean; folderId?: string; signIn?: boolean };
          if (j.ok) {
            ok = true;
            folderId = j.folderId ?? folderId;
          } else if (j.signIn || r.status === 403) {
            if (alive.current) setPhase({ k: "end", tone: "bad", title: saved ? `${plural(saved, "file")} saved, then Google asked to sign in again` : "Google sign-in ran out", msg: "Press Save to Google Drive again to carry on." });
            return;
          }
        } catch {
          // a dropped connection: one more try
        }
      }
      if (ok) saved++;
      else failed.push(f.filename);
    }
    if (!alive.current) return;
    setPhase({
      k: "end",
      tone: failed.length ? "bad" : "ok",
      title: failed.length ? `${plural(saved, "file")} saved, ${plural(failed.length, "file")} not` : `${plural(saved, "file")} saved to your Google Drive`,
      msg: `They are in a folder called "${json.folderName ?? "your listing"}" in My Drive.${failed.length ? ` Not saved: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? " and more" : ""}. Try again in a minute, or download them instead.` : ""}${missingNote}`,
    });
  };

  const busy = phase.k === "busy";

  return createPortal(
    <div className="g-modal" role="presentation">
      <div ref={overlayRef} className="g-modal__overlay" onClick={() => void close()} aria-hidden="true" />
      <div ref={panelRef} className="g-modal__panel" role="dialog" aria-modal="true" aria-labelledby="g-drive-title">
        <button type="button" className="g-modal__x" aria-label="Close" onClick={() => void close()}>
          <CloseIcon />
        </button>
        <div className="kicker" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <DriveIcon size={14} /> Google Drive
        </div>
        <h2 id="g-drive-title" className="g-modal__title">What do you want to save to Google Drive?</h2>
        <p className="g-modal__lede">Files go straight from {brand.name} to your Google Drive. Nothing downloads to this device.</p>

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
                  <DriveIcon />
                  Save to Google Drive
                </button>
              </span>
            </div>
          </>
        ) : (
          <div className="g-modal__status" aria-live="polite">
            {busy && <span className="g-modal__pulse" aria-hidden="true" />}
            {phase.k === "busy" && <p className="g-modal__msg">{phase.msg}</p>}
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
