"use client";
// Upload photos and films onto a listing, from the listing page's media
// section (the "order page"). One drop zone for everything (Oct 2026):
//
//   - a JPG whose name matches a frame from one of the listing's shoots is a
//     corrected final: it goes to that shoot's finals routes and REPLACES the
//     frame in place (src/lib/finals.ts), so a photo fixed in Lightroom or the
//     editing service lands on the right frame without anyone choosing where;
//   - anything else is added straight onto the listing (presigned PUTs to
//     listings/<slug>/photos, video, or under s/<section>/, then the ingest
//     route makes derivatives and media rows). A name that already exists in
//     the same section replaces that file.
//
// "When they land": Internal only (the default: nothing reaches a client by
// accident) or Client visible. Internal loose files are held back; corrected
// frames wait for Publish. Client visible files show right away (a corrected
// frame on a shoot that was never published waits for its first Publish).
// Download zips rebuild on their own. Nothing added here is ever sent to
// editing. Admins and the QA team.
//
// One hub line per drop (Oct 26 2026, src/lib/upload-runs.ts): every ingest
// call carries the run's id, so its batches stay quiet, and the end of the
// run (done, partly failed, or failed) posts one summary through upload-done.
import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { setMediaVisibility } from "@/app/admin/visibility-actions";
import { ingestBatch, postJson as postJsonOnce } from "@/lib/ingest-client";

type Route = { kind: "listing" } | { kind: "finals"; shootId: string };
type Row = { id: string; file: File; name: string; safe: string; size: number; route: Route; state: "queued" | "uploading" | "uploaded" | "done" | "failed"; loaded: number; note?: string };
type IngestItem = { filename: string; mediaId: string };
type IngestOut = { added: IngestItem[]; replaced: IngestItem[]; failed: { filename: string; error: string }[] };
type Existing = { filename: string; section: string | null };
export type ShootFrameName = { shootId: string; filename: string; ready: boolean };
type Totals = { corrected: number; added: number; replaced: number; failed: number; live: number; waiting: number; visError: string | null };

const CONCURRENCY = 3;
// Nov 11 2026: 4, was 6, so a call of 42 MP frames stays well inside its time.
const INGEST_BATCH = 4;
const BACKOFF = [1500, 4000, 9000];
const ACCEPT_RE = /\.(jpe?g|mp4|mov)$/i;
const safeName = (n: string) => (n.split(/[\\/]/).pop() || "file").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "file";
const sectionSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const base = (n: string) => n.replace(/\.[^.]+$/, "").toLowerCase();
const isJpg = (n: string) => /\.jpe?g$/i.test(n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function xhrPut(url: string, file: File, contentType: string, onProgress: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url, true);
    x.setRequestHeader("Content-Type", contentType);
    x.timeout = 30 * 60 * 1000;
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(Object.assign(new Error(`HTTP ${x.status}`), { status: x.status })));
    x.onerror = () => reject(new Error("Network error"));
    x.ontimeout = () => reject(new Error("Timed out"));
    x.send(file);
  });
}

// Upload links and the run's end are safe to repeat, so a dropped call is
// tried again twice before it counts (src/lib/ingest-client.ts).
const postJson = <T,>(url: string, body: unknown) => postJsonOnce<T>(url, body, { retries: 2 });

export default function UploadToListing({ listingId, demo, existing, shootFrames = [] }: { listingId: string; demo: boolean; existing: Existing[]; shootFrames?: ShootFrameName[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Totals | null>(null);
  const [section, setSection] = useState("");
  const [landAs, setLandAs] = useState<"internal" | "client">("internal");
  const [dragOver, setDragOver] = useState(false);

  // A frame name from a shoot wins over a loose file of the same name: the
  // newest shoot first (the list arrives newest first).
  const frameByBase = useMemo(() => {
    const m = new Map<string, ShootFrameName>();
    for (const f of shootFrames) if (!m.has(base(f.filename))) m.set(base(f.filename), f);
    return m;
  }, [shootFrames]);
  // Same name in the same section replaces that loose file. A hint only: the
  // ingest route has the last word.
  const known = new Set(existing.map((e) => `${sectionSlug(e.section ?? "")}/${e.filename.toLowerCase()}`));
  const willReplace = (safe: string) => known.has(`${sectionSlug(section)}/${safe.toLowerCase()}`);
  const routeFor = useCallback((safe: string): Route => {
    const hit = isJpg(safe) ? frameByBase.get(base(safe)) : undefined;
    return hit ? { kind: "finals", shootId: hit.shootId } : { kind: "listing" };
  }, [frameByBase]);

  const commit = useCallback((next: Row[]) => { rowsRef.current = next; setRows([...next]); }, []);
  const patch = useCallback((id: string, p: Partial<Row>) => {
    const i = rowsRef.current.findIndex((r) => r.id === id);
    if (i < 0) return;
    rowsRef.current[i] = { ...rowsRef.current[i], ...p };
    setRows([...rowsRef.current]);
  }, []);

  const add = (list: FileList | null) => {
    if (!list) return;
    const have = new Set(rowsRef.current.map((r) => r.safe));
    const next: Row[] = [];
    let skipped = 0;
    for (const f of Array.from(list)) {
      if (!ACCEPT_RE.test(f.name)) { skipped++; continue; }
      const safe = safeName(f.name);
      if (have.has(safe)) continue;
      have.add(safe);
      next.push({ id: `${f.name}:${f.size}:${f.lastModified}`, file: f, name: f.name, safe, size: f.size, route: routeFor(safe), state: "queued", loaded: 0 });
    }
    setErr(skipped ? `${skipped} file${skipped === 1 ? "" : "s"} skipped: only JPG photos and MP4 or MOV films can be added.` : null);
    setResult(null);
    commit([...rowsRef.current, ...next]);
  };

  const describe = (r: Row) => {
    if (r.route.kind === "finals") {
      const f = frameByBase.get(base(r.safe));
      return f && !f.ready ? "shoot still in editing" : "replaces a shoot frame";
    }
    return willReplace(r.safe) ? "replaces a file" : "new";
  };

  const run = async () => {
    // Routes are re-read at upload time; failed rows start over.
    for (const r of rowsRef.current) if (r.state === "queued" || r.state === "failed") patch(r.id, { route: routeFor(r.safe), state: "queued", loaded: 0, note: undefined });
    const pending = rowsRef.current.filter((r) => r.state === "queued" || r.state === "failed");
    if (!pending.length) return;
    setBusy(true); setErr(null); setResult(null);
    const totals: Totals = { corrected: 0, added: 0, replaced: 0, failed: 0, live: 0, waiting: 0, visError: null };
    const runId = crypto.randomUUID();
    // The run's one hub line. Never blocks or fails the upload itself.
    const finish = (fatal?: string) => {
      const ids = new Set(pending.map((p) => p.id));
      const failed = rowsRef.current
        .filter((r) => ids.has(r.id) && (r.state === "failed" || (fatal && r.state !== "done")))
        .map((r) => ({ name: r.safe, error: r.note || fatal || "failed" }));
      return postJson(`/api/studio/listings/${listingId}/upload-done`, { run: runId, total: pending.length, failed, published: landAs === "client", section: section.trim() || undefined }).catch(() => null);
    };

    if (demo) {
      for (const r of pending) {
        patch(r.id, { state: "uploading" });
        for (let s = 1; s <= 5; s++) { await sleep(70); patch(r.id, { loaded: Math.round((r.size * s) / 5) }); }
        const note = r.route.kind === "finals" ? "corrected" : willReplace(r.safe) ? "replaced" : "added";
        patch(r.id, { state: "done", loaded: r.size, note });
        if (note === "corrected") totals.corrected++; else if (note === "replaced") totals.replaced++; else totals.added++;
      }
      setResult(totals);
      setBusy(false);
      return;
    }

    try {
      // 1. presigned URLs: loose files on the listing, corrected frames per shoot
      const slots = new Map<string, { url: string; contentType: string }>(); // row id → slot
      const loose = pending.filter((p) => p.route.kind === "listing");
      const byShoot = new Map<string, Row[]>();
      for (const p of pending) {
        if (p.route.kind !== "finals") continue;
        const f = frameByBase.get(base(p.safe));
        if (f && !f.ready) { patch(p.id, { state: "failed", note: "the shoot is still in editing" }); continue; }
        if (!byShoot.has(p.route.shootId)) byShoot.set(p.route.shootId, []);
        byShoot.get(p.route.shootId)!.push(p);
      }
      const take = (list: Row[], files: { safeFilename: string; url: string; contentType: string }[]) => {
        const bySafe = new Map(files.map((f) => [f.safeFilename, f]));
        for (const p of list) { const f = bySafe.get(p.safe); if (f) slots.set(p.id, { url: f.url, contentType: f.contentType }); }
      };
      for (let b = 0; b < loose.length; b += 60) {
        const chunk = loose.slice(b, b + 60);
        const j = await postJson<{ files: { safeFilename: string; url: string; contentType: string }[] }>(`/api/studio/listings/${listingId}/upload-urls`, { files: chunk.map((p) => ({ filename: p.name, size: p.size, contentType: p.file.type })), section: section.trim() || undefined });
        if (!j.ok) throw new Error(j.error || "Could not get upload links.");
        take(chunk, j.files);
      }
      for (const [shootId, list] of byShoot) {
        for (let b = 0; b < list.length; b += 60) {
          const chunk = list.slice(b, b + 60);
          const j = await postJson<{ files: { safeFilename: string; url: string; contentType: string }[] }>(`/api/studio/shoots/${shootId}/finals/upload-urls`, { files: chunk.map((p) => ({ filename: p.name, size: p.size, contentType: p.file.type })) });
          if (!j.ok) { chunk.forEach((p) => patch(p.id, { state: "failed", note: j.error || "no upload link" })); continue; }
          take(chunk, j.files);
        }
      }

      // 2. PUT straight to storage, three at a time, with retries
      const toSend = pending.filter((p) => rowsRef.current.find((r) => r.id === p.id)?.state !== "failed");
      let i = 0;
      const worker = async () => {
        while (i < toSend.length) {
          const p = toSend[i++];
          const slot = slots.get(p.id);
          if (!slot) { patch(p.id, { state: "failed", note: "not accepted" }); continue; }
          patch(p.id, { state: "uploading", loaded: 0, note: undefined });
          let ok = false;
          for (let attempt = 0; attempt <= BACKOFF.length && !ok; attempt++) {
            try {
              await xhrPut(slot.url, p.file, slot.contentType, (loaded) => patch(p.id, { loaded }));
              ok = true;
            } catch (e) {
              if (attempt === BACKOFF.length) patch(p.id, { state: "failed", loaded: 0, note: e instanceof Error ? e.message : "failed" });
              else await sleep(BACKOFF[attempt]);
            }
          }
          if (ok) patch(p.id, { state: "uploaded", loaded: p.size });
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toSend.length) }, worker));

      // 3. ingest in small batches
      const uploaded = rowsRef.current.filter((x) => x.state === "uploaded");
      const settle = (batch: Row[], ij: IngestOut & { ok: boolean; error?: string }, kind: "listing" | "finals") => {
        if (!ij.ok) { batch.forEach((x) => patch(x.id, { state: "failed", note: ij.error || "ingest failed" })); return; }
        const key = (n: string) => (kind === "finals" ? base(n) : n.toLowerCase());
        const rep = new Set(ij.replaced.map((x) => key(x.filename)));
        const addN = new Set(ij.added.map((x) => key(x.filename)));
        const bad = new Map(ij.failed.map((x) => [key(x.filename), x.error]));
        for (const x of batch) {
          const k = key(x.safe);
          if (rep.has(k)) patch(x.id, { state: "done", note: kind === "finals" ? "corrected" : "replaced" });
          else if (addN.has(k) || (kind === "finals" && [...addN].some((a) => a.startsWith(k)))) patch(x.id, { state: "done", note: kind === "finals" ? "corrected" : "added" });
          else patch(x.id, { state: "failed", note: bad.get(k) || "not ingested" });
        }
      };
      const looseUp = uploaded.filter((x) => x.route.kind === "listing");
      for (let b = 0; b < looseUp.length; b += INGEST_BATCH) {
        const batch = looseUp.slice(b, b + INGEST_BATCH);
        // A call that gets no answer is tried again one file at a time (src/lib/ingest-client.ts).
        const ij = await ingestBatch(`/api/studio/listings/${listingId}/ingest`, batch.map((x) => x.safe), { section: section.trim() || undefined, published: landAs === "client", run: runId });
        settle(batch, ij, "listing");
        if (ij.ok) { totals.added += ij.added.length; totals.replaced += ij.replaced.length; totals.failed += ij.failed.length; }
      }
      const correctedIds: string[] = [];
      const shootUp = new Map<string, Row[]>();
      for (const x of uploaded) if (x.route.kind === "finals") { if (!shootUp.has(x.route.shootId)) shootUp.set(x.route.shootId, []); shootUp.get(x.route.shootId)!.push(x); }
      for (const [shootId, list] of shootUp) {
        for (let b = 0; b < list.length; b += INGEST_BATCH) {
          const batch = list.slice(b, b + INGEST_BATCH);
          const ij = await ingestBatch(`/api/studio/shoots/${shootId}/finals/ingest`, batch.map((x) => x.safe), { run: runId });
          settle(batch, ij, "finals");
          if (ij.ok) {
            totals.corrected += ij.replaced.length + ij.added.length;
            totals.failed += ij.failed.length;
            correctedIds.push(...ij.replaced.map((x) => x.mediaId), ...ij.added.map((x) => x.mediaId));
          }
        }
      }

      // 4. "Client visible": corrected frames go live now (loose files were
      // born visible by the ingest call above).
      if (landAs === "client" && correctedIds.length) {
        const v = await setMediaVisibility({ listingId, ids: correctedIds, to: "client", via: "upload" });
        if (v.ok) { totals.live = v.live; totals.waiting = v.waiting; } else totals.visError = v.error;
      }
      totals.failed = rowsRef.current.filter((r) => r.state === "failed").length;
      await finish();
      setResult(totals);
      router.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await finish(msg);
      setErr(msg);
    }
    setBusy(false);
  };

  const queued = rows.filter((r) => r.state === "queued" || r.state === "failed").length;
  const totalBytes = rows.reduce((a, r) => a + r.size, 0);
  const doneBytes = rows.reduce((a, r) => a + (r.state === "done" || r.state === "uploaded" ? r.size : r.loaded), 0);
  const pct = totalBytes ? Math.round((doneBytes / totalBytes) * 100) : 0;
  const corrected = rows.filter((r) => r.route.kind === "finals").length;
  const replacing = rows.filter((r) => r.route.kind === "listing" && willReplace(r.safe)).length;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="flex flex-wrap items-end" style={{ gap: 14 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <span className="muted" style={{ fontSize: 12.5 }}>When they land</span>
          <div className="vis-choice" role="radiogroup" aria-label="When they land">
            <label><input type="radio" name={`upload-vis-${listingId}`} checked={landAs === "internal"} onChange={() => setLandAs("internal")} disabled={busy} />Internal only</label>
            <label><input type="radio" name={`upload-vis-${listingId}`} checked={landAs === "client"} onChange={() => setLandAs("client")} disabled={busy} />Client visible</label>
          </div>
        </div>
        <div className="field" style={{ margin: 0, flex: "1 1 220px" }}>
          <label htmlFor="upload-section">Section for new files</label>
          <input id="upload-section" value={section} onChange={(e) => setSection(e.target.value)} placeholder="Leave empty for the main gallery" autoComplete="off" disabled={busy} />
        </div>
      </div>
      <label
        className={`adm-drop${dragOver ? " is-over" : ""}`}
        style={{ cursor: "pointer", padding: "20px 16px" }}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!busy) add(e.dataTransfer.files); }}
      >
        <input type="file" multiple accept=".jpg,.jpeg,.mp4,.mov,image/jpeg,video/mp4,video/quicktime" style={{ display: "none" }} onChange={(e) => { add(e.target.files); e.target.value = ""; }} disabled={busy} />
        <div style={{ fontSize: 14.5, fontWeight: 500 }}>Drop photos or films here, or choose them</div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
          Corrected a frame in Lightroom or the editing service? Keep its filename: it replaces that frame on its shoot. Other JPGs and MP4 or MOV films are added to this listing; the same name in the same section replaces that file.{" "}
          {landAs === "internal" ? "Everything lands Internal only: the client sees nothing until you make it client visible or publish." : "Everything shows in the client gallery once uploaded."}
        </div>
      </label>
      {rows.length > 0 && (
        <>
          <div className="adm-filelist" style={{ maxHeight: 260 }}>
            {rows.map((r) => (
              <div key={r.id} className="adm-filerow">
                <span className="adm-filerow__name" title={r.name}>{r.name}</span>
                <span className="adm-filerow__state">
                  {r.state === "done" ? (r.note === "corrected" ? "replaced the frame" : r.note === "replaced" ? "replaced" : "added") : r.state === "failed" ? `failed${r.note ? `: ${r.note}` : ""}` : r.state === "uploading" ? `${Math.round((r.loaded / Math.max(1, r.size)) * 100)}%` : r.state === "uploaded" ? "saving" : `${fmt(r.size)} · ${describe(r)}`}
                </span>
                {r.state === "uploading" && <div className="adm-progress adm-progress--thin"><span style={{ width: `${Math.round((r.loaded / Math.max(1, r.size)) * 100)}%` }} /></div>}
              </div>
            ))}
          </div>
          {busy && <div className="adm-progress"><span style={{ width: `${pct}%` }} /></div>}
          <div className="adm-actions" style={{ alignItems: "center" }}>
            <button type="button" className="btn btn-primary" onClick={run} disabled={busy || !queued}>{busy ? "Uploading..." : `Upload ${plural(queued, "file")}`}</button>
            {!busy && <button type="button" className="btn btn-ghost" onClick={() => { commit([]); setResult(null); setErr(null); }}>Clear</button>}
            <span className="muted" style={{ fontSize: 12.5 }}>
              {corrected} replace shoot frames · {replacing} replace files · {rows.length - corrected - replacing} new{section.trim() ? ` in "${section.trim()}"` : ""} · {landAs === "internal" ? "internal only" : "client visible"}
            </span>
          </div>
        </>
      )}
      {err && <p className="adm-banner adm-banner--bad" style={{ margin: 0 }}>{err}</p>}
      {result && (
        <p className={`adm-banner ${result.failed || result.visError ? "adm-banner--warn" : "adm-banner--ok"}`} style={{ margin: 0 }}>
          {[result.corrected ? `${plural(result.corrected, "shoot frame")} replaced with the corrected file` : null, result.added ? `${plural(result.added, "file")} added` : null, result.replaced ? `${plural(result.replaced, "file")} replaced` : null, result.failed ? `${result.failed} failed` : null].filter(Boolean).join(", ") || "Nothing uploaded"}.
          {demo
            ? " Demo mode: nothing was stored."
            : landAs === "internal"
              ? " They are Internal only. Make them client visible in the grid, or publish the shoot, when they are ready."
              : result.visError
                ? ` The corrected frames stay internal: ${result.visError}`
                : result.waiting
                  ? ` Client visible; ${result.waiting} corrected frame${result.waiting === 1 ? " goes" : "s go"} live when the shoot is published.`
                  : " They are client visible now."}
          {!demo && (result.added || result.replaced || result.corrected) ? " Download zips rebuild on their own." : ""}
        </p>
      )}
    </div>
  );
}
