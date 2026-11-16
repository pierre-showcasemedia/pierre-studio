"use client";
// Upload a cut from the Video card (Oct 26 2026): MP4 or MOV films onto the
// card's listing, always internal only, so the team reviews the cut in the
// admin before an admin makes it client visible. Nov 5 2026: every
// cut lands, a vertical, a revision, a second export of the same file. A name
// already on the listing is saved as "-v2", "-v3" and so on (the upload-urls
// route), so nothing a client is watching is ever written over and nothing is
// refused. One film at a time: films are big.
// Nov 1 2026: when the drop is done, #video-editing tells the owner, a manager,
// the coordinator and the coordinator the cut is ready for review (the upload-done route).
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postJson as postJsonOnce } from "@/lib/ingest-client";

type Row = { name: string; size: number; loaded: number; state: "queued" | "uploading" | "saving" | "done" | "failed"; note?: string; storedAs?: string };
const isFilm = (n: string) => /\.(mp4|mov|m4v)$/i.test(n);
const fmt = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

function put(url: string, file: File, type: string, onProgress: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url, true);
    x.setRequestHeader("Content-Type", type);
    x.timeout = 2 * 3600 * 1000;
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`HTTP ${x.status}`)));
    x.onerror = () => reject(new Error("Network error"));
    x.ontimeout = () => reject(new Error("Timed out"));
    x.send(file);
  });
}

// Links, ingest (a film is registered by name) and the run's end are all safe
// to repeat: a dropped call is tried again twice (src/lib/ingest-client.ts).
const postJson = <T,>(url: string, body: unknown) => postJsonOnce<T>(url, body, { retries: 2 });

export function VideoCutUpload({ listingId, cardId }: { listingId: string; cardId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const patch = (name: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.name === name ? { ...r, ...p } : r)));

  const run = async (files: File[]) => {
    const films = files.filter((f) => isFilm(f.name));
    // One hub line for the whole drop (src/lib/upload-runs.ts).
    const runId = crypto.randomUUID();
    const failedNames: { name: string; error: string }[] = [];
    const doneNames: string[] = [];
    const skipped = files.filter((f) => !isFilm(f.name));
    setRows((rs) => [...rs, ...films.map((f) => ({ name: f.name, size: f.size, loaded: 0, state: "queued" as const })), ...skipped.map((f) => ({ name: f.name, size: f.size, loaded: 0, state: "failed" as const, note: "MP4 or MOV films only" }))]);
    if (!films.length) return;
    setBusy(true);
    let any = false;
    for (const f of films) {
      try {
        patch(f.name, { state: "uploading" });
        const u = await postJson<{ files: { safeFilename: string; url: string; contentType: string; renamed?: boolean }[]; rejected: string[] }>(`/api/studio/listings/${listingId}/upload-urls`, { files: [{ filename: f.name, size: f.size, contentType: f.type }] });
        if (!u.ok) throw new Error(u.error || "could not start the upload");
        if (!u.files.length) throw new Error(u.rejected?.length ? "MP4 or MOV films only" : "refused");
        const slot = u.files[0];
        await put(slot.url, f, slot.contentType, (n) => patch(f.name, { loaded: n }));
        patch(f.name, { state: "saving", loaded: f.size });
        const ing = await postJson<{ added: unknown[]; replaced: unknown[]; failed: { filename: string; error: string }[] }>(`/api/studio/listings/${listingId}/ingest`, { files: [slot.safeFilename], run: runId });
        if (!ing.ok) throw new Error(ing.error || "could not save the film");
        if (ing.failed?.length) throw new Error(ing.failed[0].error);
        patch(f.name, { state: "done", storedAs: slot.renamed ? slot.safeFilename : undefined });
        doneNames.push(slot.safeFilename);
        any = true;
      } catch (e) {
        const note = e instanceof Error ? e.message : String(e);
        failedNames.push({ name: f.name, error: note });
        patch(f.name, { state: "failed", note });
      }
    }
    await postJson(`/api/studio/listings/${listingId}/upload-done`, { run: runId, total: films.length, failed: failedNames, source: "video-card", cardId, done: doneNames }).catch(() => null);
    setBusy(false);
    if (any) router.refresh();
  };

  return (
    <div className="vc-upload">
      <button
        type="button"
        className={`vc-upload__drop${over ? " is-over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!busy) void run([...e.dataTransfer.files]);
        }}
        disabled={busy}
      >
        <strong style={{ fontWeight: 500 }}>{busy ? "Uploading" : "Drop a cut here, or choose a file"}</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>MP4 or MOV. Every cut lands internal only, a vertical or a revision too: the client sees it once an admin makes it client visible. A name already on the listing is saved as v2, v3 and so on, never written over.</span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".mp4,.mov,.m4v,video/mp4,video/quicktime"
        multiple
        hidden
        onChange={(e) => {
          const fs = [...(e.target.files ?? [])];
          e.target.value = "";
          if (fs.length) void run(fs);
        }}
      />
      {rows.map((r) => (
        <div key={r.name} style={{ display: "grid", gap: 6 }}>
          <div className="vc-upload__row">
            <span className="adm-mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
            <span className={r.state === "failed" ? "" : "muted"} style={r.state === "failed" ? { color: "var(--color-live)" } : undefined}>
              {r.state === "done" ? (r.storedAs ? `Added as ${r.storedAs}, internal only` : "Added, internal only") : r.state === "failed" ? r.note ?? "Failed" : r.state === "saving" ? "Saving" : r.state === "uploading" ? `${fmt(r.loaded)} of ${fmt(r.size)}` : "Waiting"}
            </span>
          </div>
          {(r.state === "uploading" || r.state === "saving") && (
            <div className="vc-upload__bar">
              <span style={{ width: `${r.size ? Math.round((r.loaded / r.size) * 100) : 0}%` }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
