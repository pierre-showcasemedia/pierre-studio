"use client";
// Upload finals: corrected JPGs go straight to R2 with presigned PUTs
// (shoots/<id>/finals/<name>), then the ingest route swaps them into the
// shoot by filename. Matching names replace the frame; new names are added.
// Everything lands approved but UNPUBLISHED ("Internal only, waiting to
// publish"), so the client sees nothing until someone presses Publish, unless
// the uploader picked "Client visible" (Oct 2026), which makes the uploaded
// frames client visible right after (setMediaVisibility; on a shoot that has
// never been published they still wait for Publish). Admins and the QA team.
// Nothing uploaded here is ever sent to editing.
//
// Oct 28 2026: the editors download every frame, fix them, then drag
// the corrected JPGs (or the folder they are in) onto the box with the same
// filenames, and press Send for final review: it uploads them and tags the
// final review team in Slack (src/lib/final-review.ts), who do the final
// pass and publish; the coordinator sends the delivery email. The list shows the files
// in filename order, which is the order they replace frames in, and calls out
// any name that matches no frame (it would be added as a new frame instead).
// Upload only stays for a quiet fix; Client visible never goes to review.
// Nov 3 2026 (the coordinator's flow: upload the revised photos, Run QC again on
// them, tick every flag, then send): Upload to Revised is the primary button
// and Upload and send is the shortcut beside it. The send on its own lives
// in the Final review panel at the top of the shoot page (FinalReviewPanel).
// Every upload is one run (src/lib/upload-runs.ts): one hub line, not one per batch.
// Adding them to the shoot (about 4 s a photo on the server) starts as soon as
// the first files are up, and the bar and button count it ("Adding 18 of 31"),
// so a long set never sits at a full bar looking stuck (Oct 28 2026).
// Nov 2 2026 (20 Dogwood): a drop where NO name matches a frame is almost
// always the editors' export renamed, or the right files on the wrong shoot.
// It gets a red box that says so, names the shoot of this listing the files
// do match (src/lib/finals-names.ts), and keeps both buttons off until "add
// them as new photos anyway" is ticked. A drop where only some names miss
// keeps the one confirm it always had.
import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { setMediaVisibility } from "@/app/admin/visibility-actions";
import { frameBase, siblingMatches, type SiblingShoot } from "@/lib/finals-names";
import { dropEntries, walkEntries } from "@/lib/folder-drop";
import { ingestBatch, postJson } from "@/lib/ingest-client";

type Row = { id: string; file: File; name: string; safe: string; size: number; state: "queued" | "uploading" | "uploaded" | "adding" | "done" | "failed"; loaded: number; note?: string };
type IngestOut = { replaced: { filename: string; mediaId: string }[]; added: { filename: string; mediaId: string }[]; failed: { filename: string; error: string }[] };
type Sent = { sent: boolean; corrected: number; reason?: string };

const CONCURRENCY = 3;
// Files per ingest call; the server works on two at a time (src/lib/finals.ts).
// Nov 11 2026: 4, was 6, so a call of 42 MP frames stays well inside its time.
const INGEST_BATCH = 4;
// Upload links per call: the upload-urls route hands out at most 60 and
// drops the rest (MAX_BATCH). Nov 1 2026: an 85 photo drop on 195 Oakleaf asked
// for all 85 at once, got 60 links, and the last 25 failed with "no upload
// link". Asked for in chunks, like UploadToListing and push-to-listing.
const URL_BATCH = 60;
const BACKOFF = [1500, 4000, 9000];
const safeName = (n: string) => (n.split(/[\\/]/).pop() || "file").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "file";
const base = frameBase;
const byName = (a: Row, b: Row) => a.safe.localeCompare(b.safe, undefined, { numeric: true, sensitivity: "base" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const newRun = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

function xhrPut(url: string, file: File, contentType: string, onProgress: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url, true);
    x.setRequestHeader("Content-Type", contentType);
    x.timeout = 10 * 60 * 1000;
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(Object.assign(new Error(`HTTP ${x.status}`), { status: x.status })));
    x.onerror = () => reject(new Error("Network error"));
    x.ontimeout = () => reject(new Error("Timed out"));
    x.send(file);
  });
}

export default function UploadFinals({ shootId, listingId, demo, frameNames, enabled, compact = false, reviewers = "the final review team", siblings = [] }: { shootId: string; listingId?: string; demo: boolean; frameNames: string[]; enabled: boolean; compact?: boolean; reviewers?: string; siblings?: SiblingShoot[] }) {
  const router = useRouter();
  const [landAs, setLandAs] = useState<"internal" | "client">("internal");
  const [visNote, setVisNote] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<{ uploaded: number; added: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<IngestOut | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [lastReview, setLastReview] = useState(false);
  const [open, setOpen] = useState(!compact);
  // "Add them as new photos anyway": the one way past a drop where nothing matches.
  const [forceNew, setForceNew] = useState(false);
  const known = new Set(frameNames.map(base));

  const commit = useCallback((next: Row[]) => { rowsRef.current = next; setRows([...next]); }, []);
  const patch = useCallback((id: string, p: Partial<Row>) => {
    const i = rowsRef.current.findIndex((r) => r.id === id);
    if (i < 0) return;
    rowsRef.current[i] = { ...rowsRef.current[i], ...p };
    setRows([...rowsRef.current]);
  }, []);

  const add = (list: File[]) => {
    if (!list.length) return;
    const have = new Set(rowsRef.current.map((r) => r.safe));
    const next: Row[] = [];
    let skipped = 0;
    let twice = 0;
    for (const f of list) {
      if (!/\.jpe?g$/i.test(f.name)) { skipped++; continue; }
      const safe = safeName(f.name);
      if (have.has(safe)) { twice++; continue; }
      have.add(safe);
      next.push({ id: `${f.name}:${f.size}:${f.lastModified}`, file: f, name: f.name, safe, size: f.size, state: "queued", loaded: 0 });
    }
    const notes = [skipped ? `${plural(skipped, "file")} skipped: finals must be JPGs.` : null, twice ? `${plural(twice, "file")} left out: the same filename is already in the list.` : null].filter(Boolean);
    setErr(notes.length ? notes.join(" ") : null);
    setResult(null);
    setSent(null);
    setForceNew(false);
    // Filename order: the order the frames are replaced in, and easy to check against the gallery.
    commit([...rowsRef.current, ...next].sort(byName));
  };

  // A drop can be loose JPGs or the folder they sit in (subfolders too).
  const drop = async (dt: DataTransfer) => {
    if (busy) return;
    const entries = dropEntries(dt); // before any await: the browser empties the drop after
    if (!entries.length) { add(Array.from(dt.files ?? [])); return; }
    try {
      add((await walkEntries(entries)).map((p) => p.file));
    } catch {
      add(Array.from(dt.files ?? []));
    }
  };

  const run = async (review: boolean) => {
    const pending = rowsRef.current.filter((r) => r.state === "queued" || r.state === "failed");
    if (!pending.length) return;
    const toClient = !review && landAs === "client";
    // Names that match no frame become new frames: say so before anything is stored.
    // None at all: the red box above the buttons already explains it, and the
    // buttons stay off until "add them as new photos anyway" is ticked.
    const strays = pending.filter((p) => !known.has(base(p.safe)));
    if (strays.length && frameNames.length && strays.length === pending.length && !forceNew) {
      setErr("None of these names match a frame here. Tick \"Add them as new photos anyway\" first, or drop them on the shoot they belong to.");
      return;
    }
    if (strays.length && frameNames.length && strays.length < pending.length) {
      const like = frameNames.find((n) => !/twilight/i.test(n)) ?? frameNames[0];
      if (!window.confirm(`${plural(strays.length, "name")} of ${pending.length} ${strays.length === 1 ? "matches" : "match"} no frame in this shoot (frames are named like ${like}), so ${strays.length === 1 ? "it is" : "they are"} added as ${plural(strays.length, "new frame")} instead of replacing any.\n\nAdd ${strays.length === 1 ? "it" : "them"} as new frames?`)) return;
    }
    setBusy(true); setErr(null); setResult(null); setVisNote(null); setSent(null); setLastReview(review);
    if (demo) {
      for (const r of pending) {
        patch(r.id, { state: "uploading" });
        for (let s = 1; s <= 5; s++) { await sleep(90); patch(r.id, { loaded: Math.round((r.size * s) / 5) }); }
        patch(r.id, { state: "done", loaded: r.size, note: known.has(base(r.safe)) ? "replaced" : "added" });
      }
      setResult({ replaced: pending.filter((r) => known.has(base(r.safe))).map((r) => ({ filename: r.safe, mediaId: "" })), added: pending.filter((r) => !known.has(base(r.safe))).map((r) => ({ filename: r.safe, mediaId: "" })), failed: [] });
      if (review) setSent({ sent: true, corrected: pending.length });
      setBusy(false);
      return;
    }
    const runId = newRun();
    try {
      // 1. presigned URLs, URL_BATCH files per call
      const slots = new Map<string, { url: string; contentType: string }>();
      for (let b = 0; b < pending.length; b += URL_BATCH) {
        const chunk = pending.slice(b, b + URL_BATCH);
        // Links are safe to ask for again: a dropped call is retried (src/lib/ingest-client.ts).
        const j = await postJson<{ files: { safeFilename: string; url: string; contentType: string }[] }>(`/api/studio/shoots/${shootId}/finals/upload-urls`, { files: chunk.map((p) => ({ filename: p.name, size: p.size, contentType: p.file.type })) }, { retries: 2 });
        if (!j.ok) throw new Error(j.error || "Could not get upload links.");
        for (const f of j.files) slots.set(f.safeFilename, { url: f.url, contentType: f.contentType });
      }

      // 2. PUT straight to storage, three at a time, with retries
      const runRows = new Set(pending.map((p) => p.id));
      const mine = () => rowsRef.current.filter((x) => runRows.has(x.id));
      let added = 0; // files the server has finished with (in or failed)
      const progress = () => setPhase({ uploaded: mine().filter((x) => x.state !== "queued" && x.state !== "uploading").length, added, total: pending.length });
      setPhase({ uploaded: 0, added: 0, total: pending.length });
      let i = 0;
      const worker = async () => {
        while (i < pending.length) {
          const p = pending[i++];
          const slot = slots.get(p.safe);
          if (!slot) { patch(p.id, { state: "failed", note: "no upload link" }); continue; }
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
          progress();
        }
      };

      const uploads = Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

      // 3. add them to the shoot in filename order, a batch as soon as its files are up:
      // replace matching frames, add the rest. Runs while the later files still upload.
      const order = [...pending].sort(byName);
      const total: IngestOut = { replaced: [], added: [], failed: [] };
      const stateOf = (id: string) => rowsRef.current.find((x) => x.id === id)?.state;
      const ingestAll = async () => {
        for (let b = 0; b < order.length; b += INGEST_BATCH) {
          const slice = order.slice(b, b + INGEST_BATCH);
          while (slice.some((x) => stateOf(x.id) === "queued" || stateOf(x.id) === "uploading")) await sleep(300);
          const batch = slice.filter((x) => stateOf(x.id) === "uploaded");
          if (!batch.length) continue;
          batch.forEach((x) => patch(x.id, { state: "adding" }));
          progress();
          // A call that gets no answer is tried again one file at a time (src/lib/ingest-client.ts).
          const ij = await ingestBatch(`/api/studio/shoots/${shootId}/finals/ingest`, batch.map((x) => x.safe), { run: runId });
          added += batch.length;
          if (!ij.ok) { batch.forEach((x) => patch(x.id, { state: "failed", note: ij.error || "ingest failed" })); progress(); continue; }
          total.replaced.push(...ij.replaced); total.added.push(...ij.added); total.failed.push(...ij.failed);
          const rep = new Set(ij.replaced.map((x) => base(x.filename)));
          const addN = new Set(ij.added.map((x) => base(x.filename)));
          const bad = new Map(ij.failed.map((x) => [base(x.filename), x.error]));
          for (const x of batch) {
            const k = base(x.safe);
            if (rep.has(k)) patch(x.id, { state: "done", note: "replaced" });
            else if ([...addN].some((a) => a.startsWith(k))) patch(x.id, { state: "done", note: "added" });
            else patch(x.id, { state: "failed", note: bad.get(k) || "not ingested" });
          }
          progress();
        }
      };
      await Promise.all([uploads, ingestAll()]);
      setResult(total);
      // "Client visible": the frames just uploaded go live now (or wait for
      // the first Publish of a shoot that was never published).
      const ids = [...total.replaced, ...total.added].map((x) => x.mediaId).filter(Boolean);
      if (toClient && ids.length) {
        const v = await setMediaVisibility({ shootId, listingId, ids, to: "client", via: "upload" });
        setVisNote(v.ok ? (v.waiting ? `${v.waiting} of them go live when the shoot is published.` : "They are client visible now.") : `They stay internal: ${v.error}`);
      }
      setPhase(null);
      // 4. the end of the run: one hub line, the tagged final review line when sent for review
      const failedRows = pending.map((p) => rowsRef.current.find((x) => x.id === p.id)).filter((x): x is Row => Boolean(x && x.state === "failed"));
      // Posting twice posts once (the run claims its one line), so this is retried too.
      const done = await postJson<{ sent?: boolean; corrected?: number; reason?: string }>(`/api/studio/shoots/${shootId}/finals/done`, { run: runId, total: pending.length, failed: failedRows.map((x) => ({ name: x.name, error: x.note || "failed" })), review, published: toClient }, { retries: 2 });
      if (review) {
        if (done?.ok) setSent({ sent: Boolean(done.sent), corrected: done.corrected ?? 0, reason: done.reason });
        else setErr(`Uploaded, but the final review team was not notified${done?.error ? `: ${done.error}` : ""}. Press Send for final review at the top of the page.`);
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setPhase(null);
    setBusy(false);
  };

  const queued = rows.filter((r) => r.state === "queued" || r.state === "failed").length;
  const queuedRows = rows.filter((r) => r.state === "queued" || r.state === "failed");
  const unmatched = queuedRows.filter((r) => !known.has(base(r.safe)));
  // Nothing matches at all (Nov 2 2026): the red box, and the shoot of this
  // listing these names do belong to, if any.
  const noneMatch = queuedRows.length > 0 && frameNames.length > 0 && unmatched.length === queuedRows.length;
  const elsewhere = noneMatch ? siblingMatches(queuedRows.map((r) => r.safe), siblings) : [];
  const like = frameNames.find((n) => !/twilight/i.test(n)) ?? frameNames[0] ?? "";
  const held = noneMatch && !forceNew;
  const totalBytes = rows.reduce((a, r) => a + r.size, 0);
  const doneBytes = rows.reduce((a, r) => a + (r.state === "done" || r.state === "uploaded" || r.state === "adding" ? r.size : r.loaded), 0);
  // While a run is going, half the bar is the upload and half is adding them to the shoot.
  const pct = phase && phase.total ? Math.round(50 * (totalBytes ? doneBytes / totalBytes : 0) + 50 * (phase.added / phase.total)) : totalBytes ? Math.round((doneBytes / totalBytes) * 100) : 0;
  const busyLabel = !phase ? (lastReview ? "Sending for final review..." : "Finishing...") : phase.uploaded < phase.total ? `Uploading ${phase.uploaded} of ${phase.total}...` : `Adding ${phase.added} of ${phase.total}...`;

  if (!enabled) {
    return <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>Finals can be uploaded once the frames are in.</p>;
  }

  return (
    <div className="adm-finals">
      {compact && (
        <button type="button" className="adm-chip" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Hide" : "Upload finals"}</button>
      )}
      {open && (
        <div style={{ display: "grid", gap: 12, marginTop: compact ? 12 : 0 }}>
          <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>When they land</span>
            <div className="vis-choice" role="radiogroup" aria-label="When they land">
              <label><input type="radio" name={`finals-vis-${shootId}`} checked={landAs === "internal"} onChange={() => setLandAs("internal")} disabled={busy} />Internal only</label>
              <label><input type="radio" name={`finals-vis-${shootId}`} checked={landAs === "client"} onChange={() => setLandAs("client")} disabled={busy} />Client visible</label>
            </div>
          </div>
          <label
            className={`adm-drop${dragOver ? " is-over" : ""}`}
            style={{ cursor: busy ? "default" : "pointer", padding: "20px 16px" }}
            onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void drop(e.dataTransfer); }}
          >
            <input type="file" multiple accept=".jpg,.jpeg,image/jpeg" style={{ display: "none" }} onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ""; }} disabled={busy} />
            <div style={{ fontSize: 14.5, fontWeight: 500 }}>{dragOver ? "Drop to add them" : <><span className="amg-hint-mouse">Drop corrected JPGs or their folder here, or click to choose</span><span className="amg-hint-touch">Tap to choose the corrected JPGs</span></>}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
              Keep the filename: the same name as a frame replaces that frame in its spot, a new name is added as a new frame at the end. {landAs === "internal" ? "They stay Internal only until the final pass publishes them." : "They show in the client gallery once uploaded (after the first Publish of a new shoot), with no final review."}
            </div>
          </label>
          {rows.length > 0 && (
            <>
              <div className="adm-filelist" style={{ maxHeight: 260 }}>
                {rows.map((r) => {
                  const willReplace = known.has(base(r.safe));
                  return (
                    <div key={r.id} className="adm-filerow">
                      <span className="adm-filerow__name" title={r.name}>{r.name}</span>
                      <span className="adm-filerow__state">
                        {r.state === "done" ? (r.note === "replaced" ? "replaced" : "added") : r.state === "failed" ? `failed${r.note ? `: ${r.note}` : ""}` : r.state === "uploading" ? `${Math.round((r.loaded / Math.max(1, r.size)) * 100)}%` : r.state === "adding" ? (willReplace ? "replacing the frame..." : "adding to the shoot...") : r.state === "uploaded" ? "uploaded, next in line" : `${fmt(r.size)} · ${willReplace ? "replaces frame" : "new frame"}`}
                      </span>
                      {r.state === "uploading" && <div className="adm-progress adm-progress--thin"><span style={{ width: `${Math.round((r.loaded / Math.max(1, r.size)) * 100)}%` }} /></div>}
                    </div>
                  );
                })}
              </div>
              {noneMatch && !busy && (
                <div className="adm-banner adm-banner--bad" role="alert" style={{ margin: 0, display: "grid", gap: 8 }}>
                  <span>
                    <strong>None of these {queuedRows.length} filenames match a frame on this shoot, so nothing would be replaced.</strong> They would land as {plural(queuedRows.length, "new photo")} next to the {frameNames.length} already here. Frames here are named like {like}; a corrected photo keeps its frame&apos;s filename.
                  </span>
                  {elsewhere.length > 0 && (
                    <span>
                      {elsewhere[0].matched === queuedRows.length ? "All of them" : `${elsewhere[0].matched} of them`} match frames on <Link href={`/admin/shoots/${elsewhere[0].shootId}#finals`} className="adm-link">{elsewhere[0].label}</Link> of this listing. Drop them there to replace those frames.
                    </span>
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={forceNew} onChange={(e) => { setForceNew(e.target.checked); setErr(null); }} style={{ width: 16, height: 16, flex: "none" }} />
                    Add them as new photos anyway. They are not corrections of the frames here.
                  </label>
                </div>
              )}
              {unmatched.length > 0 && !noneMatch && frameNames.length > 0 && !busy && (
                <p className="adm-banner adm-banner--warn" style={{ margin: 0 }}>
                  {unmatched.length === queuedRows.length ? "None of these names match" : `${plural(unmatched.length, "name")} ${unmatched.length === 1 ? "matches" : "match"}`} no frame, so {unmatched.length === 1 ? "it is" : "they are"} added as new frames: {unmatched.slice(0, 3).map((r) => r.name).join(", ")}{unmatched.length > 3 ? ` and ${unmatched.length - 3} more` : ""}. To replace a frame, use its exact filename.
                </p>
              )}
              {busy && <div className="adm-progress"><span style={{ width: `${pct}%` }} /></div>}
              <div className="adm-actions" style={{ alignItems: "center" }}>
                {landAs === "internal" ? (
                  <>
                    <button type="button" className="btn btn-primary" onClick={() => run(false)} disabled={busy || !queued || held} title={held ? "Nothing here matches a frame. Tick the box above first." : "Uploads them into the Revised section without notifying anyone. Run QC again on them next."}>{busy ? busyLabel : `Upload ${queued} to Revised`}</button>
                    {!busy && queued > 0 && <button type="button" className="btn btn-ghost" onClick={() => run(true)} disabled={held} title={held ? "Nothing here matches a frame. Tick the box above first." : `Uploads them and tags ${reviewers} in Slack for the final pass at once, without running QC again.`}>Upload and send for final review</button>}
                  </>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={() => run(false)} disabled={busy || !queued || held}>{busy ? busyLabel : `Upload ${queued}, client visible`}</button>
                )}
                {!busy && <button type="button" className="btn btn-ghost" onClick={() => { commit([]); setResult(null); setErr(null); setSent(null); setForceNew(false); }}>Clear</button>}
                <span className="muted" style={{ fontSize: 12.5 }}>{phase ? `Uploaded ${phase.uploaded} of ${phase.total} · in the shoot ${phase.added} of ${phase.total}. Keep this tab open.` : `${rows.filter((r) => known.has(base(r.safe))).length} replace · ${rows.filter((r) => !known.has(base(r.safe))).length} new`}</span>
              </div>
              {landAs === "internal" && queued > 0 && !busy && <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>They land in Revised, Internal only. Then Run QC again, tick each flag, and Send for final review at the top: it tags {reviewers} in Slack.</p>}
            </>
          )}
          {err && <p className="adm-banner adm-banner--bad" style={{ margin: 0 }}>{err}</p>}
          {result && (
            <p className={`adm-banner ${result.failed.length ? "adm-banner--warn" : "adm-banner--ok"}`} style={{ margin: 0 }}>
              {result.replaced.length} frame{result.replaced.length === 1 ? "" : "s"} replaced, {result.added.length} added{result.failed.length ? `, ${result.failed.length} failed` : ""}.
              {demo
                ? sent?.sent ? ` Demo mode: nothing was stored, nobody was tagged.` : " Demo mode: nothing was stored."
                : lastReview
                  ? sent?.sent ? ` Sent for final review: ${reviewers} ${reviewers.includes(" and ") ? "are" : "is"} tagged in Slack. Everything stays Internal only until the final pass publishes it.` : sent?.reason === "already sent" ? " It was already sent for final review." : sent ? " Nothing went in, so nobody was tagged." : " Sending for final review..."
                  : landAs === "client" ? ` ${visNote ?? "Making them client visible..."}` : " They are in Revised, Internal only. Next: Run QC again, tick each flag, then Send for final review at the top."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
