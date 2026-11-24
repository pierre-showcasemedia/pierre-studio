"use client";
// Upload a shoot: client + listing → files (direct to R2 or from Dropbox) →
// editing options → submit. Built for a phone with an SD reader: the file
// input accepts raws and JPGs, uploads run three at a time with per-file
// progress and retries, and an interrupted upload resumes from localStorage.
//
// Oct 21 2026: two boxes. "Photos (sent for editing)" is the one above;
// "Video (raw footage, to Dropbox only)" takes camera clips, which land under
// shoots/<id>/raw-video/ and are never sent to editing. Every file of the
// shoot, photos and clips, is copied into the business's Dropbox after submit. A
// shoot can be video only: then there are no editing options to set and
// Submit just finishes the upload.
//
// Oct 27 2026: either box also takes a whole folder, dropped or picked with
// "Choose folder" (src/lib/folder-drop.ts): every file inside, subfolders
// too, keeps its folder path, and the Dropbox copy lands in a folder of the
// same name inside the listing folder ("2311 Elm Street - 413 raw",
// "video"). Photos from a folder go to editing exactly like loose ones.
//
// Oct 30 2026: the resume note has Start over. It deletes the unfinished
// upload (its files in storage and any Dropbox copy, src/lib/discard-upload.ts)
// and forgets it here, so a different set of files (JPGs instead of raws) can
// go up without Submit waiting on the old ones.
//
// Nov 1 2026: one click, then walk away. Files and editing options
// are one step: dropping or picking files starts their upload at once (more
// can be added while it runs), the options sit under the file list, and
// "Submit when the upload finishes" arms the submit. The moment the last file
// lands the shoot goes to editing on its own; files that failed are retried
// a few times first. Photos always go up as raws and Submit marks them
// finished JPGs when that switch is on, so it can be changed mid-upload.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readJson } from "@/lib/ingest-client";
import {
  createClientInline,
  createListingInline,
  searchClients,
  type LiteClient,
  type LiteListing,
} from "@/app/admin/actions";
import { pickListings, type PickListing } from "@/app/admin/upload-actions";
import {
  AURA_MODEL_ID,
  MAX_FILES_WARNING,
  MAX_VIDEO_BYTES,
  RAW_ACCEPT,
  TWILIGHT_DEFAULT_COUNT,
  TWILIGHT_MAX,
  TWILIGHT_MIN,
  VIDEO_ACCEPT,
  contentTypeFor,
  isAcceptedFile,
  isVideoFile,
} from "@/lib/autohdr-constants";
import { estimateCredits, fmtBytes } from "@/lib/shoot-status";
import { dirOf, dropEntries, skipName, storedName, walkEntries, type Picked } from "@/lib/folder-drop";
import "@/styles/upload.css";
import { brand } from "@/lib/brand";
import { googleDriveToken, loadGoogleIdentity } from "@/components/gallery/DriveModal";

type Model = { id: number; name: string; description: string | null; variant: "indoor" | "outdoor" | "indoor/outdoor"; type: string; credits: number | null };

type FileKind = "photo" | "video";
// A signed upload link and when it was handed out.
type Slot = { url: string; contentType: string; at: number };

type UFile = {
  id: string;
  file: File | null;
  name: string;
  size: number;
  type: string;
  kind: FileKind;
  // The folder it was dropped in, from the dropped folder down ("" = a loose file).
  dir: string;
  source: "device" | "dropbox" | "drive";
  link?: string;
  driveId?: string; // Nov 18 2026: picked in Google Drive (imported server side)
  state: "queued" | "uploading" | "done" | "failed" | "skipped";
  loaded: number;
  error?: string;
};

type Props = {
  demo: boolean;
  dropboxKey: string | null;
  // Nov 18 2026: Import from Google Drive (the Picker), and which service the
  // copies go to, for the words on this page (business.fileStore).
  drivePicker?: { clientId: string; apiKey: string; appId: string } | null;
  storeName?: string;
  editingConnected: boolean;
  // business.editing "manual": photos are edited outside the studio, so the
  // photo box keeps raws (and their Dropbox copy) and never says "editing".
  editedOutside?: boolean;
  // Admins may make a listing (and a client) from step 1; a creative
  // specialist (Oct 21 2026) picks an existing listing only.
  canCreate?: boolean;
  initialClient: LiteClient | null;
  initialListing: LiteListing | null;
};

const CONCURRENCY = 3;
const URL_BATCH = 50;
// How often finished files are reported so their Dropbox copy starts.
const LANDED_REPORT_MS = 4_000;
// Nov 2 2026 (20 Dogwood): the connection dropped at the end of the run
// and the last four clips burned their three tries inside fifteen seconds.
// A longer tail rides out a Wi-Fi hop; a file that is really unreadable costs
// a minute more and then fails as before.
const BACKOFF = [1500, 4000, 9000, 20000, 40000];
// Upload links are signed for an hour (src/lib/r2.ts presignedPutUrl). A big
// shoot uploads for longer than that, so a link older than this is renewed
// before its file starts.
const LINK_RENEW_MS = 45 * 60 * 1000;
const TWO_GB = 2 * 1024 ** 3;
// Armed submit: rounds of "retry failed" before it gives up and says so, the
// wait between them, and how often it tries Submit itself.
const AUTO_RETRY_ROUNDS = 3;
const AUTO_RETRY_WAIT_MS = 20_000;
const AUTO_SUBMIT_TRIES = 3;
const storageKey = (listingId: string) => `studio-upload:${listingId}`;

// A raw clip can be gigabytes on cellular: no timeout past half a GB (a dead
// connection still ends in onerror); photos keep the ten minutes.
const timeoutFor = (size: number) => (size > 512 * 1024 * 1024 ? 0 : 10 * 60 * 1000);

function xhrPut(url: string, file: File, contentType: string, onProgress: (loaded: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url, true);
    x.setRequestHeader("Content-Type", contentType);
    x.timeout = timeoutFor(file.size);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(x.status) : reject(Object.assign(new Error(`HTTP ${x.status}`), { status: x.status })));
    x.onerror = () => reject(new Error("Network error"));
    x.ontimeout = () => reject(new Error("Timed out"));
    x.send(file);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// "Oct 26" from a calendar date (no zone shift).
const fmtShort = (ymd: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${ymd.slice(0, 10)}T12:00:00Z`));

// A toggle on the editing options. It lives out here, not inside the wizard
// (Nov 1 2026, the owner: Virtual twilight on and off "takes like 10 tries"):
// defined inside, it was a new component on every render, and while files
// upload the wizard renders many times a second, so React swapped the button
// for a fresh one between the press and the release and the click was lost.
function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`adm-switch${on ? " is-on" : ""}`} disabled={disabled} onClick={() => onChange(!on)} />;
}

export default function UploadWizard({ demo, dropboxKey, drivePicker = null, storeName = "Dropbox", editingConnected, editedOutside = false, canCreate = true, initialClient, initialListing }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(initialListing ? 2 : 1);

  // ---- Step 1: the listing (by address; the client comes with it) ----
  const [client, setClient] = useState<LiteClient | null>(initialClient);
  const [listing, setListing] = useState<LiteListing | null>(initialListing);
  const [lq, setLq] = useState("");
  const [picks, setPicks] = useState<PickListing[]>([]);
  const [loadingPicks, setLoadingPicks] = useState(true);
  const [newListingOpen, setNewListingOpen] = useState(false);
  const [newListing, setNewListing] = useState({ address: "", city: "", shootDate: "" });
  // The new listing's client: searched inline, or added on the spot.
  const [newClientFor, setNewClientFor] = useState<LiteClient | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LiteClient[]>([]);
  const [searching, setSearching] = useState(false);
  const [newClientOpen, setNewClientOpen] = useState(false);
  const [newClient, setNewClient] = useState({ email: "", name: "", company: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Recent listings, newest first; typing searches every listing.
  useEffect(() => {
    if (step !== 1 || newListingOpen) return;
    let live = true;
    const t = setTimeout(async () => {
      setLoadingPicks(true);
      try { const r = await pickListings(lq); if (live) setPicks(r); } catch { if (live) setPicks([]); }
      if (live) setLoadingPicks(false);
    }, lq ? 220 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [lq, step, newListingOpen]);

  useEffect(() => {
    if (!newListingOpen || newClientFor) return;
    const t = setTimeout(async () => {
      setSearching(true);
      try { setResults(await searchClients(q)); } catch { setResults([]); }
      setSearching(false);
    }, q ? 220 : 0);
    return () => clearTimeout(t);
  }, [q, newListingOpen, newClientFor]);

  const choose = (p: PickListing) => {
    if (p.id !== listing?.id) forgetUpload();
    setListing({ id: p.id, address: p.address, slug: p.slug, shootDate: p.shootDate, nda: p.nda });
    setClient(p.client);
    setErr(null);
  };

  const addClient = async () => {
    setBusy(true); setErr(null);
    const r = await createClientInline(newClient);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setNewClientFor(r.client);
    setNewClientOpen(false);
  };

  const addListing = async () => {
    if (!newClientFor) return setErr("Pick the client this listing belongs to.");
    setBusy(true); setErr(null);
    const r = await createListingInline({ clientId: newClientFor.id, address: newListing.address, city: newListing.city, shootDate: newListing.shootDate, nda: options.nda });
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    forgetUpload();
    setListing(r.listing);
    setClient(newClientFor);
    setNewListingOpen(false);
    setNewListing({ address: "", city: "", shootDate: "" });
    setStep(2);
  };

  // ---- Step 2: files ----
  const [files, setFiles] = useState<UFile[]>([]);
  const filesRef = useRef<UFile[]>([]);
  const [, setShootId] = useState<string | null>(null);
  const shootIdRef = useRef<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // One upload run at a time; files added while it runs join it.
  const runningRef = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  const [dragOverVideo, setDragOverVideo] = useState(false);
  const [skippedCount, setSkippedCount] = useState(0);
  const [resume, setResume] = useState<{ shootId: string; landed: string[]; fileCount: number } | null>(null);
  const resumeRef = useRef<{ landed: Set<string> }>({ landed: new Set() });
  // Files a submit said never landed that are not in this list (an earlier try).
  const [leftover, setLeftover] = useState<string[]>([]);
  const speed = useRef<{ t: number; b: number; ema: number }>({ t: 0, b: 0, ema: 0 });
  const [tick, setTick] = useState(0);

  const commit = useCallback((next: UFile[]) => { filesRef.current = next; setFiles([...next]); }, []);
  const patch = useCallback((id: string, p: Partial<UFile>) => {
    const i = filesRef.current.findIndex((f) => f.id === id);
    if (i < 0) return;
    filesRef.current[i] = { ...filesRef.current[i], ...p };
    setFiles([...filesRef.current]);
  }, []);

  // Nov 10 2026 (3330 Cedar Road): picking another listing ("Change") kept
  // the last listing's shoot, files and resume, so every link for the new
  // listing came back "Shoot not found." Now a different listing starts clean.
  // The earlier upload is not deleted: it stays saved for its own listing.
  const resetDraft = () => {
    shootIdRef.current = null;
    setShootId(null);
    setResume(null);
    resumeRef.current.landed = new Set();
    landedQueue.current.clear();
    setLeftover([]);
  };
  const forgetUpload = () => {
    resetDraft();
    commit([]);
    setArmed(false);
  };

  // Resume: an earlier upload for this listing? Only when this page has no
  // upload of its own yet: files dropped before this answered already made
  // one, and switching to the old one then split the files across two shoots.
  useEffect(() => {
    if (!listing || demo) return;
    let live = true;
    try {
      const raw = localStorage.getItem(storageKey(listing.id));
      if (!raw) return;
      const saved = JSON.parse(raw) as { shootId: string; files: { name: string; size: number }[] };
      if (!saved.shootId) return;
      fetch("/api/studio/upload-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shootId: saved.shootId }) })
        .then((r) => r.json())
        .then((j) => {
          if (!live || (shootIdRef.current && shootIdRef.current !== saved.shootId)) return;
          if (!j.ok) { localStorage.removeItem(storageKey(listing.id)); return; }
          if (j.fileCount === 0) return;
          resumeRef.current.landed = new Set(j.landed);
          shootIdRef.current = saved.shootId;
          setShootId(saved.shootId);
          setResume({ shootId: saved.shootId, landed: j.landed, fileCount: j.fileCount });
        })
        .catch(() => {});
    } catch {}
    return () => { live = false; };
  }, [listing, demo]);

  // Start over: the earlier upload is deleted on the server and forgotten here.
  const [discarding, setDiscarding] = useState(false);
  const startOver = async () => {
    if (!listing || !resume || uploading) return;
    const n = resume.landed.length;
    const listed = filesRef.current.some((f) => f.file);
    if (!window.confirm(listed
      ? "Start this upload over? Everything uploaded so far for this listing is deleted, and the files in this list upload again from this device into a fresh upload."
      : `Start this upload over? The ${n} file${n === 1 ? "" : "s"} already uploaded for this listing ${n === 1 ? "is" : "are"} deleted, and nothing goes to editing. Your files on this device are not touched.`)) return;
    setDiscarding(true);
    setErr(null);
    try {
      const r = await fetch("/api/studio/upload-discard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shootId: resume.shootId, listingId: listing.id }) });
      const j = await r.json().catch(() => ({}));
      // 404: it was gone already, which is what Start over wants.
      if (!j.ok && r.status !== 404) throw new Error(j.error || "Could not start over.");
      try { localStorage.removeItem(storageKey(listing.id)); } catch {}
      resetDraft();
      // What is listed went into the deleted upload: it goes up again. A
      // Dropbox pick has no file here to send, so it is picked again instead.
      const again = filesRef.current.filter((f) => f.file).map((f) => ({ ...f, state: "queued" as const, loaded: 0, error: undefined }));
      commit(again);
      if (again.length) setTimeout(() => void runUploads(), 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscarding(false);
    }
  };

  const persist = useCallback(() => {
    if (!listing || demo) return;
    try {
      localStorage.setItem(storageKey(listing.id), JSON.stringify({ shootId: shootIdRef.current, files: filesRef.current.map((f) => ({ name: f.name, size: f.size })) }));
    } catch {}
  }, [listing, demo]);

  // Which box a file was dropped in decides what it is: the photo box takes
  // raws and JPGs, the video box takes camera clips (by extension and size,
  // never MIME). A video dropped on the photo box, or the other way round,
  // is skipped with a note that says which box it belongs in.
  const [skippedVideo, setSkippedVideo] = useState(0);
  const [wrongBox, setWrongBox] = useState<{ photos: number; video: number }>({ photos: 0, video: 0 });
  const [tooBig, setTooBig] = useState<string[]>([]);
  const [sameName, setSameName] = useState<string[]>([]);
  const [readingFolder, setReadingFolder] = useState(false);
  const addFiles = (list: FileList | File[] | Picked[], kind: FileKind = "photo") => {
    const arr: Picked[] = Array.from(list as ArrayLike<File | Picked>)
      .map((x) => (x instanceof File ? { file: x, dir: dirOf(x) } : x))
      .filter((p) => !skipName(p.file.name));
    const have = new Set(filesRef.current.map((f) => `${f.name}:${f.size}`));
    // Every file is stored under its name alone, so two different files with
    // one name (from two folders) would overwrite each other: the second is
    // left out with a note.
    const taken = new Set(filesRef.current.map((f) => storedName(f.name)));
    let skipped = 0;
    let other = 0;
    const big: string[] = [];
    const clash: string[] = [];
    const next: UFile[] = [];
    for (const { file: f, dir } of arr) {
      if (kind === "photo") {
        if (!isAcceptedFile(f.name)) { if (isVideoFile(f.name)) other++; else skipped++; continue; }
      } else {
        if (!isVideoFile(f.name)) { if (isAcceptedFile(f.name)) other++; else skipped++; continue; }
        if (f.size > MAX_VIDEO_BYTES) { big.push(f.name); continue; }
      }
      if (have.has(`${f.name}:${f.size}`)) continue;
      if (taken.has(storedName(f.name))) { clash.push(dir ? `${dir}/${f.name}` : f.name); continue; }
      have.add(`${f.name}:${f.size}`);
      taken.add(storedName(f.name));
      const landed = resumeRef.current.landed.has(f.name.replace(/[^A-Za-z0-9._-]+/g, "-"));
      next.push({ id: `${f.name}:${f.size}:${f.lastModified}`, file: f, name: f.name, size: f.size, type: f.type || contentTypeFor(f.name), kind, dir, source: "device", state: landed ? "skipped" : "queued", loaded: landed ? f.size : 0 });
    }
    if (clash.length) setSameName((c) => [...c, ...clash]);
    if (kind === "photo") setSkippedCount((n) => n + skipped);
    else setSkippedVideo((n) => n + skipped);
    if (other) setWrongBox((w) => (kind === "photo" ? { ...w, video: w.video + other } : { ...w, photos: w.photos + other }));
    if (big.length) setTooBig((t) => [...t, ...big]);
    commit([...filesRef.current, ...next]);
    setTimeout(persist, 0);
    // Dropping is starting: the upload begins now (or joins the run going).
    if (next.some((f) => f.state === "queued")) setTimeout(() => void runUploads(), 0);
  };

  // A drop with a folder in it is walked first; a drop of loose files goes
  // straight in as before. The entries are read before the first await.
  const dropInto = async (dt: DataTransfer, kind: FileKind) => {
    const entries = dropEntries(dt);
    const loose = Array.from(dt.files);
    if (!entries.some((en) => en.isDirectory)) { addFiles(loose, kind); return; }
    setReadingFolder(true);
    try {
      addFiles(await walkEntries(entries), kind);
    } catch {
      setErr("Could not read that folder. Open it and drag the files in instead.");
    } finally {
      setReadingFolder(false);
    }
  };

  const totalBytes = useMemo(() => files.reduce((a, f) => a + f.size, 0), [files]);
  const doneBytes = files.reduce((a, f) => a + (f.state === "done" || f.state === "skipped" ? f.size : f.loaded), 0);
  const doneCount = files.filter((f) => f.state === "done" || f.state === "skipped").length;
  const failedCount = files.filter((f) => f.state === "failed").length;
  // Waiting with no run going (an error stopped it): the armed retry takes these too.
  const stuckCount = uploading ? 0 : files.filter((f) => f.state === "queued").length;
  // What Submit without leaves out, an earlier upload's missing files included.
  const leaveOut = failedCount + stuckCount + leftover.length;
  const allLanded = files.length > 0 && doneCount === files.length;
  const photoCount = files.filter((f) => f.kind === "photo").length;
  const videoCount = files.length - photoCount;
  const videoOnly = files.length > 0 && photoCount === 0;
  // Photos and clips counted apart (Nov 1 2026, the owner: "422 of 584 files" next
  // to "8%" read as wrong). Photos are small and go first, clips are most of
  // the data and go last, so the file count races ahead of the bar, which
  // (like the time left) follows the data.
  const photosDone = files.filter((f) => f.kind === "photo" && (f.state === "done" || f.state === "skipped")).length;
  const clipsDone = doneCount - photosDone;
  const pct = totalBytes ? Math.round((doneBytes / totalBytes) * 100) : 0;
  const eta = useMemo(() => {
    const s = speed.current.ema;
    if (!uploading || !s) return null;
    const secs = (totalBytes - doneBytes) / s;
    if (!Number.isFinite(secs)) return null;
    return secs < 60 ? `${Math.max(1, Math.round(secs))} s` : secs < 3600 ? `${Math.round(secs / 60)} min` : `${(secs / 3600).toFixed(1)} h`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneBytes, totalBytes, uploading, tick]);

  const noteProgress = (bytesNow: number) => {
    const now = Date.now();
    const s = speed.current;
    if (s.t) {
      const dt = (now - s.t) / 1000;
      if (dt >= 0.8) {
        const inst = (bytesNow - s.b) / dt;
        s.ema = s.ema ? s.ema * 0.7 + inst * 0.3 : inst;
        s.t = now; s.b = bytesNow;
        setTick((x) => x + 1);
      }
    } else { s.t = now; s.b = bytesNow; }
  };

  // One batch of links, for one kind: photos (raw, or display when the
  // finished-JPGs switch is on) or raw video. A file the server refuses
  // (over the size limit, not a video) is marked failed with its reason.
  async function fetchUrls(batch: UFile[], kind: FileKind): Promise<Map<string, Slot>> {
    if (!listing) throw new Error("Pick a listing first.");
    const r = await fetch("/api/studio/upload-urls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shootId: shootIdRef.current, listingId: listing.id, kind: kind === "video" ? "raw_video" : "raw", files: batch.map((f) => ({ filename: f.name, size: f.size, contentType: f.type, ...(f.dir ? { dir: f.dir } : {}) })) }),
    });
    // A dropped call reads in plain words, not as a JSON parse error (src/lib/ingest-client.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await readJson(r);
    if (!j.ok) throw new Error(j.error || "Could not get upload links.");
    if (j.shootId && j.shootId !== shootIdRef.current) { shootIdRef.current = j.shootId; setShootId(j.shootId); }
    persist();
    const m = new Map<string, Slot>();
    const at = Date.now();
    for (const u of j.files as { filename: string; url: string; contentType: string }[]) m.set(u.filename, { url: u.url, contentType: u.contentType, at });
    for (const x of (j.refused ?? []) as { filename: string; error: string }[]) {
      const f = batch.find((b) => b.name === x.filename);
      if (f) patch(f.id, { state: "failed", loaded: 0, error: x.error });
    }
    return m;
  }

  const runDemoUploads = async () => {
    setUploading(true);
    for (let pass = 0; ; pass++) {
    const pending = filesRef.current.filter((f) => f.state === "queued" || (pass === 0 && f.state === "failed"));
    if (!pending.length) break;
    let i = 0;
    const worker = async () => {
      while (i < pending.length) {
        const f = pending[i++];
        patch(f.id, { state: "uploading", loaded: 0 });
        const steps = 6;
        for (let s = 1; s <= steps; s++) {
          await sleep(120 + Math.random() * 160);
          patch(f.id, { loaded: Math.round((f.size * s) / steps) });
          noteProgress(filesRef.current.reduce((a, x) => a + (x.state === "done" || x.state === "skipped" ? x.size : x.loaded), 0));
        }
        patch(f.id, { state: "done", loaded: f.size });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    }
    shootIdRef.current = "demo-s1";
    setShootId("demo-s1");
    setUploading(false);
  };

  // Oct 27 2026: files that finished are reported every few seconds
  // (/api/studio/upload-landed), so their Dropbox copy runs while the rest of
  // the shoot uploads instead of starting at Submit. Best effort: Submit
  // queues anything a report missed.
  const landedQueue = useRef<Set<string>>(new Set());
  const reportLanded = useCallback(async () => {
    const sid = shootIdRef.current;
    if (!sid || !landedQueue.current.size) return;
    const filenames = [...landedQueue.current].slice(0, 200);
    for (const n of filenames) landedQueue.current.delete(n);
    try {
      await fetch("/api/studio/upload-landed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shootId: sid, filenames }), keepalive: true });
    } catch {
      for (const n of filenames) landedQueue.current.add(n);
    }
  }, []);

  const runUploads = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    if (demo) {
      await runDemoUploads();
      runningRef.current = false;
      return;
    }
    setErr(null);
    setUploading(true);
    speed.current = { t: 0, b: 0, ema: 0 };
    const reporter = setInterval(() => { void reportLanded(); }, LANDED_REPORT_MS);
    try {
      // Passes until nothing is left: files added during one go in the next.
      // Failed files are retried in the first pass only.
      for (let pass = 0; ; pass++) {
      const wanted = filesRef.current.filter((f) => (f.state === "queued" || (pass === 0 && f.state === "failed")) && f.file);
      if (!wanted.length) break;
      const urls = new Map<string, Slot>();
      // Links come per kind (photos and clips are different keys and rows).
      for (const kind of ["photo", "video"] as FileKind[]) {
        const ofKind = wanted.filter((f) => f.kind === kind);
        for (let b = 0; b < ofKind.length; b += URL_BATCH) {
          for (const [k, v] of await fetchUrls(ofKind.slice(b, b + URL_BATCH), kind)) urls.set(k, v);
        }
      }
      // A file the server gave no link and did not refuse would come round
      // in every pass: it is failed here instead.
      for (const f of wanted) if (!urls.has(f.name) && filesRef.current.find((x) => x.id === f.id)?.state === "queued") patch(f.id, { state: "failed", loaded: 0, error: "No upload link" });
      // Photos first (they start editing), then the clips.
      const pending = wanted.filter((f) => urls.has(f.name)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "photo" ? -1 : 1));
      let i = 0;
      const worker = async () => {
        while (i < pending.length) {
          const f = pending[i++];
          let slot = urls.get(f.name);
          patch(f.id, { state: "uploading", loaded: 0, error: undefined });
          let ok = false;
          for (let attempt = 0; attempt <= BACKOFF.length && !ok; attempt++) {
            try {
              // Nov 1 2026 (3330 Cedar Road, 43 GB): every link came at
              // Start, so the 59 files that began after the hour all failed.
              if (!slot || Date.now() - slot.at > LINK_RENEW_MS) slot = (await fetchUrls([f], f.kind)).get(f.name);
              if (!slot) throw new Error("No upload link");
              await xhrPut(slot.url, f.file!, slot.contentType, (loaded) => {
                patch(f.id, { loaded });
                noteProgress(filesRef.current.reduce((a, x) => a + (x.state === "done" || x.state === "skipped" ? x.size : x.loaded), 0));
              });
              ok = true;
            } catch (e) {
              if (attempt === BACKOFF.length) { patch(f.id, { state: "failed", loaded: 0, error: e instanceof Error ? e.message : "failed" }); break; }
              await sleep(BACKOFF[attempt]);
              // A fresh link for the next try, whatever the error. This used
              // to happen on a 403 only, and on 3330 Cedar it never did:
              // the browser saw no 403 for the expired links.
              slot = undefined;
            }
          }
          if (ok) {
            patch(f.id, { state: "done", loaded: f.size });
            landedQueue.current.add(storedName(f.name));
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    clearInterval(reporter);
    // The last ones: a few tries, then Submit picks up whatever is left.
    for (let r = 0; r < 3 && landedQueue.current.size; r++) await reportLanded();
    setUploading(false);
    runningRef.current = false;
    persist();
  };

  // Dropbox Chooser → server-side import (nothing passes through the phone).
  const chooseDropbox = async () => {
    if (!dropboxKey) return;
    type Dbx = { choose: (o: object) => void };
    const w = window as Window & { Dropbox?: Dbx };
    if (!w.Dropbox) {
      await new Promise<void>((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://www.dropbox.com/static/api/2/dropins.js";
        s.id = "dropboxjs";
        s.setAttribute("data-app-key", dropboxKey);
        s.onload = () => res();
        s.onerror = () => rej(new Error("Dropbox did not load"));
        document.body.appendChild(s);
      }).catch((e) => setErr(String(e.message)));
    }
    w.Dropbox?.choose({
      linkType: "direct",
      multiselect: true,
      folderselect: false,
      extensions: [".jpg", ".jpeg", ".dng", ".arw", ".cr2", ".cr3", ".nef", ".raf"],
      success: async (picked: { link: string; name: string; bytes: number }[]) => {
        const next: UFile[] = picked.map((p) => ({ id: `dbx:${p.link}`, file: null, name: p.name, size: p.bytes, type: contentTypeFor(p.name), kind: "photo", dir: "", source: "dropbox", link: p.link, state: "queued", loaded: 0 }));
        commit([...filesRef.current, ...next]);
        if (demo) { await runUploads(); return; }
        if (!listing || runningRef.current) return;
        runningRef.current = true;
        setUploading(true);
        for (let b = 0; b < next.length; b += 5) {
          const batch = next.slice(b, b + 5);
          batch.forEach((f) => patch(f.id, { state: "uploading" }));
          try {
            const r = await fetch("/api/studio/import-dropbox", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ shootId: shootIdRef.current, listingId: listing.id, kind: "raw", files: batch.map((f) => ({ link: f.link, name: f.name, bytes: f.size })) }),
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const j: any = await readJson(r);
            if (!j.ok) throw new Error(j.error || "Import failed");
            if (j.shootId && j.shootId !== shootIdRef.current) { shootIdRef.current = j.shootId; setShootId(j.shootId); }
            const okNames = new Set((j.imported as { filename: string }[]).map((x) => x.filename));
            const bad = new Map((j.failed as { filename: string; error: string }[]).map((x) => [x.filename, x.error]));
            for (const f of batch) {
              const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, "-");
              if (okNames.has(safe)) patch(f.id, { state: "done", loaded: f.size });
              else patch(f.id, { state: "failed", error: bad.get(safe) || "not imported" });
            }
          } catch (e) {
            batch.forEach((f) => patch(f.id, { state: "failed", error: e instanceof Error ? e.message : "failed" }));
          }
        }
        setUploading(false);
        runningRef.current = false;
        persist();
        if (filesRef.current.some((f) => f.state === "queued" && f.file)) void runUploads();
      },
    });
  };

  // Google Drive Picker → server-side import (Nov 18 2026). Sign in to Google
  // straight from the click (drive.file: the site sees only the picked files),
  // pick in Google's own window, then the server streams each file from Drive
  // into storage, a few per request, like the Dropbox import.
  const chooseDrive = async () => {
    if (!drivePicker) return;
    setErr(null);
    try {
      await loadGoogleIdentity();
    } catch {
      setErr("Google did not load. Check the connection and try again.");
      return;
    }
    const token = await googleDriveToken(drivePicker.clientId);
    if (!token) return; // closed or declined
    type Doc = { id: string; name: string; sizeBytes?: number | string; mimeType?: string };
    type PickerNs = {
      Action: { PICKED: string; CANCEL: string };
      Response: { ACTION: string; DOCUMENTS: string };
      DocsView: new (v?: unknown) => { setIncludeFolders: (b: boolean) => unknown; setSelectFolderEnabled: (b: boolean) => unknown; setMimeTypes: (m: string) => unknown };
      ViewId: { DOCS: unknown };
      Feature: { MULTISELECT_ENABLED: unknown };
      PickerBuilder: new () => {
        addView: (v: unknown) => PickerB; setOAuthToken: (t: string) => PickerB; setDeveloperKey: (k: string) => PickerB; setAppId: (a: string) => PickerB;
        enableFeature: (f: unknown) => PickerB; setCallback: (cb: (d: Record<string, unknown>) => void) => PickerB; setTitle: (t: string) => PickerB; build: () => { setVisible: (v: boolean) => void };
      };
    };
    type PickerB = InstanceType<PickerNs["PickerBuilder"]>;
    type Gapi = { load: (lib: string, cb: () => void) => void };
    const w = window as Window & { gapi?: Gapi; google?: { picker?: PickerNs } };
    try {
      if (!w.gapi) {
        await new Promise<void>((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://apis.google.com/js/api.js";
          s.onload = () => res();
          s.onerror = () => rej(new Error("Google Drive did not load"));
          document.body.appendChild(s);
        });
      }
      if (!w.google?.picker) await new Promise<void>((res) => w.gapi!.load("picker", () => res()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Google Drive did not load");
      return;
    }
    const P = w.google?.picker;
    if (!P) {
      setErr("Google Drive did not load. Try again.");
      return;
    }
    const view = new P.DocsView(P.ViewId.DOCS);
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(false);
    view.setMimeTypes("image/jpeg,image/png,image/tiff,image/x-adobe-dng,image/x-canon-cr2,image/x-canon-cr3,image/x-nikon-nef,image/x-sony-arw,image/x-fuji-raf,application/octet-stream");
    const picked = await new Promise<Doc[]>((resolve) => {
      new P.PickerBuilder()
        .addView(view)
        .enableFeature(P.Feature.MULTISELECT_ENABLED)
        .setOAuthToken(token)
        .setDeveloperKey(drivePicker.apiKey)
        .setAppId(drivePicker.appId)
        .setTitle("Choose the photos for this shoot")
        .setCallback((d) => {
          const action = d[P.Response.ACTION];
          if (action === P.Action.PICKED) resolve(((d[P.Response.DOCUMENTS] as Doc[]) ?? []).filter((x) => x && x.id));
          else if (action === P.Action.CANCEL) resolve([]);
        })
        .build()
        .setVisible(true);
    });
    if (!picked.length) return;
    const next: UFile[] = picked.map((p) => ({ id: `drive:${p.id}`, file: null, name: p.name, size: Number(p.sizeBytes ?? 0) || 0, type: contentTypeFor(p.name), kind: "photo", dir: "", source: "drive", driveId: p.id, state: "queued", loaded: 0 }));
    commit([...filesRef.current, ...next]);
    if (demo) { await runUploads(); return; }
    if (!listing || runningRef.current) return;
    runningRef.current = true;
    setUploading(true);
    for (let b = 0; b < next.length; b += 5) {
      const batch = next.slice(b, b + 5);
      batch.forEach((f) => patch(f.id, { state: "uploading" }));
      try {
        const r = await fetch("/api/studio/import-drive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shootId: shootIdRef.current, listingId: listing.id, kind: "raw", token, files: batch.map((f) => ({ id: f.driveId, name: f.name })) }),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const j: any = await readJson(r);
        if (!j.ok) throw new Error(j.error || "Import failed");
        if (j.shootId && j.shootId !== shootIdRef.current) { shootIdRef.current = j.shootId; setShootId(j.shootId); }
        const okNames = new Map((j.imported as { filename: string; bytes: number }[]).map((x) => [x.filename, x.bytes]));
        const bad = new Map((j.failed as { filename: string; error: string }[]).map((x) => [x.filename, x.error]));
        for (const f of batch) {
          const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, "-");
          if (okNames.has(safe)) patch(f.id, { state: "done", size: okNames.get(safe) || f.size, loaded: okNames.get(safe) || f.size });
          else patch(f.id, { state: "failed", error: bad.get(safe) || "not imported" });
        }
      } catch (e) {
        batch.forEach((f) => patch(f.id, { state: "failed", error: e instanceof Error ? e.message : "failed" }));
      }
    }
    setUploading(false);
    runningRef.current = false;
    persist();
    if (filesRef.current.some((f) => f.state === "queued" && f.file)) void runUploads();
  };

  const cellularish = useMemo(() => {
    if (typeof navigator === "undefined") return true;
    const c = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }).connection;
    if (!c) return true; // iPhone Safari does not say: assume it could be cellular
    return c.type === "cellular" || /2g|3g/.test(c.effectiveType || "");
  }, []);

  // ---- Step 3: options ----
  const [models, setModels] = useState<Model[]>([]);
  const [connected, setConnected] = useState(editingConnected);
  const [options, setOptions] = useState({
    indoorModelId: AURA_MODEL_ID,
    outdoorModelId: AURA_MODEL_ID,
    split: false,
    skipHdr: false,
    twilight: { enabled: true, count: TWILIGHT_DEFAULT_COUNT, look: "champagne" },
    nda: Boolean(initialListing?.nda),
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/studio/models")
      .then((r) => r.json())
      .then((j) => { if (j.ok) { setModels(j.models); setConnected(Boolean(j.connected)); } })
      .catch(() => {});
  }, []);

  useEffect(() => { if (listing?.nda) setOptions((o) => ({ ...o, nda: true })); }, [listing]);

  const modelById = (id: number) => models.find((m) => m.id === id);
  const indoorModels = models.filter((m) => m.variant !== "outdoor");
  const outdoorModels = models.filter((m) => m.variant !== "indoor");
  const effIndoor = options.nda ? AURA_MODEL_ID : options.indoorModelId;
  const effOutdoor = options.nda ? AURA_MODEL_ID : options.split ? options.outdoorModelId : options.indoorModelId;
  const mainModel = modelById(effIndoor);
  const credits = estimateCredits(
    { indoorModelId: effIndoor, outdoorModelId: effOutdoor, modelCredits: mainModel?.credits ?? 3, skipHdr: options.skipHdr, twilight: options.twilight, nda: options.nda },
    photoCount,
    0
  );

  // dropMissing (Nov 2 2026): submit without the files that never landed.
  // The server drops their rows (after checking storage once more) and the
  // rest goes to editing. Only from the confirm under "Submit without".
  const submit = async (opts: { dropMissing?: boolean } = {}) => {
    if (!shootIdRef.current && !demo) return setErr("Upload the files first.");
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch(`/api/studio/shoots/${shootIdRef.current ?? "demo"}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(opts.dropMissing ? { dropMissing: true } : {}),
          options: {
            indoorModelId: effIndoor,
            outdoorModelId: effOutdoor,
            modelName: options.nda ? "Aura" : mainModel?.name,
            modelCredits: mainModel?.credits ?? undefined,
            skipHdr: options.skipHdr,
            twilight: options.twilight,
            nda: options.nda,
            notes: options.notes,
            source: files.some((f) => f.source !== "device") ? (files.every((f) => f.source === "dropbox") ? "dropbox" : files.every((f) => f.source === "drive") ? "google_drive" : "mixed") : "device",
          },
        }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j: any = await readJson(r);
      if (!j.ok) {
        setSubmitting(false);
        if (j.missing?.length) {
          const missing = j.missing as string[];
          const miss = new Set(missing);
          for (const f of filesRef.current) if (miss.has(storedName(f.name))) patch(f.id, { state: "failed", loaded: 0, error: "did not land" });
          setStep(2);
          // Nov 10 2026 (3330 Cedar Road): files from an earlier try on
          // this listing that never landed and are not in this list. Retry
          // cannot send them, so every submit failed with nothing to press.
          const listed = new Set(filesRef.current.map((f) => storedName(f.name)));
          const earlier = missing.filter((n) => !listed.has(n));
          setLeftover(earlier);
          if (earlier.length) {
            setArmed(false);
            const n = earlier.length;
            return setErr(`${n} file${n === 1 ? "" : "s"} from an earlier upload on this listing never landed and ${n === 1 ? "is" : "are"} not in this list, so this cannot submit yet. Submit without ${n === 1 ? "it" : "them"} to go ahead with what landed${resume ? ", or Start over to clear the earlier upload" : ""}.`);
          }
        }
        return setErr(j.error || "Could not submit.");
      }
      if (listing) { try { localStorage.removeItem(storageKey(listing.id)); } catch {} }
      router.push(`/admin/shoots/${j.shootId}`);
    } catch (e) {
      setSubmitting(false);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  // Submit without the files that failed or never started (Nov 2 2026, 20
  // Camino Verde: four clips out of 426 kept failing and held the photos
  // back). A confirm names them; the server drops their rows and the rest
  // goes to editing. The left-out files are not deleted from this device.
  // Nov 10 2026: plus the earlier upload's files that are not in this list.
  const submitWithout = () => {
    const names = [...filesRef.current.filter((f) => f.state === "failed" || f.state === "queued").map((f) => f.name), ...leftover];
    if (!names.length) return;
    const shown = names.slice(0, 12).join("\n") + (names.length > 12 ? `\n… and ${names.length - 12} more` : "");
    const what = names.length === 1 ? "this file" : `these ${names.length} files`;
    if (!window.confirm(`Submit without ${what}?\n\n${shown}\n\n${names.length === 1 ? "It stays" : "They stay"} out of this shoot. Everything that landed goes ahead now.`)) return;
    setArmed(false);
    void submit({ dropMissing: true });
  };

  // ---- One click (Nov 1 2026) ----
  const [armed, setArmed] = useState(false);
  const autoRef = useRef({ retries: 0, submits: 0 });
  const [gaveUp, setGaveUp] = useState(false);
  const arm = () => {
    autoRef.current = { retries: 0, submits: 0 };
    setGaveUp(false);
    setArmed(true);
    if (filesRef.current.some((f) => f.state === "queued" || f.state === "failed")) void runUploads();
  };

  // Armed: submit the moment everything has landed (and the last landed
  // reports went out, which is when uploading turns false).
  useEffect(() => {
    if (!armed || !allLanded || uploading || submitting || autoRef.current.submits >= AUTO_SUBMIT_TRIES) return;
    autoRef.current.submits++;
    void submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, allLanded, uploading, submitting]);

  // Armed and a run ended with failures: try them again after a pause, a
  // few rounds, then say so (Retry failed starts the rounds over).
  useEffect(() => {
    if (!armed || uploading || submitting || !(failedCount + stuckCount)) return;
    if (autoRef.current.retries >= AUTO_RETRY_ROUNDS) { setGaveUp(true); return; }
    const t = setTimeout(() => { autoRef.current.retries++; void runUploads(); }, AUTO_RETRY_WAIT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, uploading, submitting, failedCount, stuckCount]);

  // The files upload from this browser, so leaving stops them: ask first.
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  // ---- Render ----
  const Steps = (
    <div className="adm-steps" aria-label="Steps">
      {[
        [1, "The listing"],
        [2, "Files and editing"],
      ].map(([n, l], i) => (
        <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {i > 0 && <span aria-hidden>·</span>}
          <span className={step === n ? "is-on" : step > (n as number) ? "is-done" : ""}>{n}. {l}</span>
        </span>
      ))}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 22 }}>
      {Steps}
      {err && <p className="adm-banner adm-banner--bad" role="alert">{err}</p>}

      {step === 1 && (
        <div className="adm-card adm-card--lg upl-step" style={{ display: "grid", gap: 16 }}>
          {!newListingOpen ? (
            <>
              <div className="flex flex-wrap items-end justify-between" style={{ gap: 10 }}>
                <div>
                  <div className="kicker" style={{ marginBottom: 6 }}>The listing</div>
                  <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Pick the property you shot. The newest listings are first.</p>
                </div>
                {canCreate && <button type="button" className="adm-chip" onClick={() => { setNewListingOpen(true); setErr(null); }}>New listing</button>}
              </div>
              <div className="field">
                <input value={lq} onChange={(e) => setLq(e.target.value)} placeholder="Search by address or client" aria-label="Search listings" autoFocus={!listing} />
              </div>
              <div className="upl-picks" role="listbox" aria-label="Listings" aria-busy={loadingPicks}>
                {picks.map((p, i) => {
                  const on = listing?.id === p.id;
                  return (
                    <button key={p.id} type="button" role="option" aria-selected={on} className={`upl-pick${on ? " is-on" : ""}`} style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }} onClick={() => choose(p)} onDoubleClick={() => { choose(p); setStep(2); }}>
                      <span className="upl-pick__thumb" aria-hidden>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {p.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" /></svg>}
                      </span>
                      <span className="upl-pick__text">
                        <span className="upl-pick__street">{p.address.split(",")[0]}{p.nda ? <span className="adm-pill" style={{ marginLeft: 8, background: "rgba(11,12,15,.08)", padding: "4px 8px" }}>NDA</span> : null}</span>
                        <small>{[p.address.split(",").slice(1).join(",").trim(), p.client.name ?? p.client.email].filter(Boolean).join(" · ")}</small>
                      </span>
                      <span className="upl-pick__meta">
                        {p.shootDate ? <span>Shoot {fmtShort(p.shootDate)}</span> : <span className="faint">No shoot date</span>}
                        <small>{p.mediaCount ? `${p.mediaCount} files` : "No files yet"}</small>
                      </span>
                      <span className="upl-pick__check" aria-hidden>{on ? "✓" : ""}</span>
                    </button>
                  );
                })}
                {!loadingPicks && picks.length === 0 && <p className="muted" style={{ fontSize: 13.5, margin: "6px 2px" }}>{lq ? "No listing matches. Add it as a new listing." : "No listings yet. Add the first one."}</p>}
                {loadingPicks && picks.length === 0 && Array.from({ length: 4 }, (_, i) => <span key={i} className="upl-pick upl-pick--ghost" aria-hidden />)}
              </div>
            </>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              <div className="flex flex-wrap items-center justify-between" style={{ gap: 10 }}>
                <div className="kicker">New listing</div>
                <button type="button" className="adm-chip adm-chip--quiet" onClick={() => setNewListingOpen(false)}>Back to the list</button>
              </div>
              <div className="field"><label htmlFor="nl-addr">Street address</label><input id="nl-addr" value={newListing.address} onChange={(e) => setNewListing({ ...newListing, address: e.target.value })} placeholder="3201 Willow Drive" autoFocus /></div>
              <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 10 }}>
                <div className="field"><label htmlFor="nl-city">City and state</label><input id="nl-city" value={newListing.city} onChange={(e) => setNewListing({ ...newListing, city: e.target.value })} placeholder="Springfield, CA 90000" /></div>
                <div className="field"><label htmlFor="nl-date">Shoot date</label><input id="nl-date" type="date" value={newListing.shootDate} onChange={(e) => setNewListing({ ...newListing, shootDate: e.target.value })} /></div>
              </div>

              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                <div className="kicker" style={{ marginBottom: 8 }}>Client</div>
                {newClientFor ? (
                  <div className="flex flex-wrap items-center justify-between" style={{ gap: 10 }}>
                    <div>
                      <div style={{ fontWeight: 500 }}>{newClientFor.name ?? newClientFor.email}</div>
                      <div className="muted" style={{ fontSize: 13 }}>{newClientFor.email}{newClientFor.company ? ` · ${newClientFor.company}` : ""}</div>
                    </div>
                    <button type="button" className="adm-chip adm-chip--quiet" onClick={() => setNewClientFor(null)}>Change</button>
                  </div>
                ) : newClientOpen ? (
                  <div style={{ display: "grid", gap: 10 }}>
                    <div className="field"><label htmlFor="nc-email">Email</label><input id="nc-email" type="email" inputMode="email" autoCapitalize="off" value={newClient.email} onChange={(e) => setNewClient({ ...newClient, email: e.target.value })} placeholder="agent@brokerage.com" /></div>
                    <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 10 }}>
                      <div className="field"><label htmlFor="nc-name">Name</label><input id="nc-name" value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} placeholder="First Last" /></div>
                      <div className="field"><label htmlFor="nc-co">Company</label><input id="nc-co" value={newClient.company} onChange={(e) => setNewClient({ ...newClient, company: e.target.value })} placeholder="Brokerage" /></div>
                    </div>
                    <div className="adm-actions">
                      <button type="button" className="btn btn-primary" disabled={busy || !newClient.email} onClick={addClient}>{busy ? "Saving…" : "Add client →"}</button>
                      <button type="button" className="btn btn-ghost" onClick={() => setNewClientOpen(false)}>Back to search</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    <div className="field">
                      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or company" aria-label="Search clients" />
                    </div>
                    <div className="adm-choice" style={{ maxHeight: 260, overflow: "auto" }}>
                      {results.map((c) => (
                        <button key={c.id} type="button" onClick={() => setNewClientFor(c)}>
                          <span><span style={{ fontWeight: 500 }}>{c.name ?? c.email}</span><small>{c.email}{c.company ? ` · ${c.company}` : ""}</small></span>
                          <span aria-hidden>→</span>
                        </button>
                      ))}
                      {!searching && results.length === 0 && <p className="muted" style={{ fontSize: 13.5, margin: "4px 0" }}>{q ? "No client matches." : "Start typing, or add a new client."}</p>}
                    </div>
                    <button type="button" className="adm-chip" style={{ justifySelf: "start" }} onClick={() => { setNewClientOpen(true); setNewClient({ email: q.includes("@") ? q : "", name: q.includes("@") ? "" : q, company: "" }); }}>New client</button>
                  </div>
                )}
              </div>

              <div className="adm-actions" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                <button type="button" className="btn btn-primary" disabled={busy || newListing.address.trim().length < 4 || !newClientFor} onClick={addListing}>{busy ? "Saving…" : "Create listing and continue →"}</button>
              </div>
            </div>
          )}

          {!newListingOpen && (
            <div className="adm-actions" style={{ borderTop: "1px solid var(--line)", paddingTop: 16, alignItems: "center" }}>
              <button type="button" className="btn btn-primary" disabled={!listing} onClick={() => setStep(2)}>Next: files →</button>
              {listing && <span className="muted" style={{ fontSize: 13 }}>{listing.address.split(",")[0]}{client ? ` · ${client.name ?? client.email}` : ""}</span>}
            </div>
          )}
        </div>
      )}

      {step === 2 && listing && (
        <div className="adm-card adm-card--lg" style={{ display: "grid", gap: 16 }}>
          <div className="flex flex-wrap items-center justify-between" style={{ gap: 10 }}>
            <div>
              <div style={{ fontWeight: 500 }}>{listing.address.split(",")[0]}</div>
              <div className="muted" style={{ fontSize: 13 }}>{client?.name ?? client?.email}</div>
            </div>
            {!uploading && <button type="button" className="adm-chip adm-chip--quiet" onClick={() => setStep(1)}>Change</button>}
          </div>

          {resume && (
            <div className="adm-banner adm-banner--info upl-resume">
              <p style={{ margin: 0 }}>
                {files.length === 0
                  ? `An earlier upload for this listing has ${resume.landed.length} of ${resume.fileCount} files landed. Choose the same files again and the ones already here will be skipped, or start over to upload different files.`
                  : "These files are joining an earlier upload for this listing. If that one had other files, start over to upload only these."}
              </p>
              <button type="button" className="btn btn-ghost upl-resume__btn" onClick={() => void startOver()} disabled={discarding || uploading}>{discarding ? "Starting over…" : "Start over"}</button>
            </div>
          )}

          <div className="upl-boxes">
            <label
              className={`adm-drop upl-box${dragOver ? " is-over" : ""}`}
              data-box="photos"
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); void dropInto(e.dataTransfer, "photo"); }}
            >
              <input type="file" multiple accept={RAW_ACCEPT} style={{ display: "none" }} onChange={(e) => { if (e.target.files) addFiles(e.target.files, "photo"); e.target.value = ""; }} aria-label={editedOutside ? "Raw photos (kept, not edited)" : "Photos (sent for editing)"} />
              <div className="upl-box__kicker">Photos</div>
              <div style={{ fontSize: 15, fontWeight: 500 }}>{editedOutside ? "Raw photos (kept, not edited)" : "Photos (sent for editing)"}</div>
              <div className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>{editedOutside ? `Optional: raws kept on the shoot and copied to ${storeName}, never sent to editing. Finished photos go on the listing page.` : "Raws and JPGs from Files, your camera roll or an SD card reader, or drop the whole raw folder. These go to editing, and a copy goes to Dropbox (a dropped folder keeps its name there). Tap again to add more."}</div>
              <span className="btn btn-ghost" style={{ marginTop: 14, pointerEvents: "none" }}>Browse photos</span>
            </label>
            <label
              className={`adm-drop upl-box${dragOverVideo ? " is-over" : ""}`}
              data-box="video"
              onDragOver={(e) => { e.preventDefault(); setDragOverVideo(true); }}
              onDragLeave={() => setDragOverVideo(false)}
              onDrop={(e) => { e.preventDefault(); setDragOverVideo(false); void dropInto(e.dataTransfer, "video"); }}
            >
              <input type="file" multiple accept={VIDEO_ACCEPT} style={{ display: "none" }} onChange={(e) => { if (e.target.files) addFiles(e.target.files, "video"); e.target.value = ""; }} aria-label={`Video (raw footage, to ${storeName} only)`} />
              <div className="upl-box__kicker">Video</div>
              <div style={{ fontSize: 15, fontWeight: 500 }}>Video (raw footage, to {storeName} only)</div>
              <div className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>Camera clips: MP4, MOV, MXF, BRAW, R3D, MTS and the like, up to 5 GB each, or drop the whole video folder. They go to the listing&rsquo;s {storeName} folder (a dropped folder keeps its name) and never to editing.</div>
              <span className="btn btn-ghost" style={{ marginTop: 14, pointerEvents: "none" }}>Browse clips</span>
            </label>
          </div>

          {/* "Choose folder": the picker in folder mode (webkitdirectory, set on the element; React has no prop for it). */}
          <div className="flex flex-wrap items-center" style={{ gap: 8, fontSize: 13 }}>
            <span className="muted">Or pick a whole folder:</span>
            <label className="adm-chip adm-chip--quiet" style={{ cursor: "pointer" }}>
              <input type="file" multiple ref={(el) => { el?.setAttribute("webkitdirectory", ""); }} style={{ display: "none" }} onChange={(e) => { if (e.target.files) addFiles(e.target.files, "photo"); e.target.value = ""; }} aria-label="Choose a photo folder" />
              Photo folder
            </label>
            <label className="adm-chip adm-chip--quiet" style={{ cursor: "pointer" }}>
              <input type="file" multiple ref={(el) => { el?.setAttribute("webkitdirectory", ""); }} style={{ display: "none" }} onChange={(e) => { if (e.target.files) addFiles(e.target.files, "video"); e.target.value = ""; }} aria-label="Choose a video folder" />
              Video folder
            </label>
          </div>
          {readingFolder && <p className="muted" style={{ fontSize: 13 }}>Reading the folder…</p>}

          {dropboxKey && (
            <button type="button" className="btn btn-ghost" style={{ justifySelf: "start" }} onClick={chooseDropbox} disabled={uploading}>Choose photos from Dropbox →</button>
          )}
          {drivePicker && (
            <button type="button" className="btn btn-ghost" style={{ justifySelf: "start" }} onClick={() => void chooseDrive()} disabled={uploading}>Choose photos from Google Drive →</button>
          )}

          {skippedCount > 0 && <p className="muted" style={{ fontSize: 13 }}>{skippedCount} file{skippedCount === 1 ? "" : "s"} skipped (not a photo format we take).</p>}
          {skippedVideo > 0 && <p className="muted" style={{ fontSize: 13 }}>{skippedVideo} file{skippedVideo === 1 ? "" : "s"} skipped (not a video format we take).</p>}
          {wrongBox.video > 0 && <p className="muted" style={{ fontSize: 13 }}>{wrongBox.video} video clip{wrongBox.video === 1 ? "" : "s"} skipped from the photo box: add {wrongBox.video === 1 ? "it" : "them"} in the Video box instead.</p>}
          {wrongBox.photos > 0 && <p className="muted" style={{ fontSize: 13 }}>{wrongBox.photos} photo{wrongBox.photos === 1 ? "" : "s"} skipped from the video box: add {wrongBox.photos === 1 ? "it" : "them"} in the Photos box instead.</p>}
          {sameName.length > 0 && <p className="adm-banner adm-banner--warn">{sameName.length === 1 ? `${sameName[0]} was left out:` : `${sameName.length} files were left out (${sameName.slice(0, 3).join(", ")}${sameName.length > 3 ? ", …" : ""}):`} another file in this shoot already has that name. Rename {sameName.length === 1 ? "it" : "them"} and add {sameName.length === 1 ? "it" : "them"} again.</p>}
          {tooBig.length > 0 && <p className="adm-banner adm-banner--warn">{tooBig.length === 1 ? `${tooBig[0]} is over 5 GB.` : `${tooBig.length} clips are over 5 GB.`} One upload tops out at 5 GB: split the clip, or add it to the listing&rsquo;s Dropbox folder by hand.</p>}
          {photoCount > MAX_FILES_WARNING && <p className="adm-banner adm-banner--warn">{photoCount} photos is a very large shoot. Editing can hit its ceiling above about 400 files; consider two shoots.</p>}
          {totalBytes > TWO_GB && cellularish && !uploading && <p className="adm-banner adm-banner--warn">That is {fmtBytes(totalBytes)}. On cellular this takes a while and uses your data plan. Wi-Fi is better if you have it.</p>}

          {files.length > 0 && (
            <>
              <div className="flex flex-wrap items-center justify-between" style={{ gap: 8, fontSize: 13.5 }}>
                <span>{videoCount && photoCount ? (<>Photos <strong>{photosDone}</strong> of {photoCount} · Clips <strong>{clipsDone}</strong> of {videoCount}</>) : (<><strong>{doneCount}</strong> of {files.length} {videoOnly ? "clips" : "files"}</>)} · {fmtBytes(doneBytes)} of {fmtBytes(totalBytes)}</span>
                <span className="muted adm-mono">{uploading ? `${pct}% of the data${eta ? ` · about ${eta} left` : ""}` : allLanded ? "All files landed" : failedCount ? `${failedCount} failed` : "Ready to upload"}</span>
              </div>
              <div className="adm-progress"><span style={{ width: `${pct}%` }} /></div>
              <div className="adm-filelist">
                {files.map((f) => (
                  <div key={f.id} className="adm-filerow">
                    <span className="adm-filerow__name">{f.kind === "video" ? <span className="upl-tag">clip</span> : null}{f.dir ? <span className="muted">{f.dir}/</span> : null}{f.name}</span>
                    <span className="adm-filerow__state">
                      {f.state === "done" ? "Uploaded" : f.state === "skipped" ? "Already here" : f.state === "failed" ? `Failed${f.error ? ` · ${f.error}` : ""}` : f.state === "uploading" ? (f.source === "dropbox" ? "Importing…" : `${Math.round((f.loaded / Math.max(1, f.size)) * 100)}%`) : fmtBytes(f.size)}
                    </span>
                    {f.state === "uploading" && f.source === "device" && <div className="adm-progress adm-progress--thin"><span style={{ width: `${Math.round((f.loaded / Math.max(1, f.size)) * 100)}%` }} /></div>}
                  </div>
                ))}
              </div>
            </>
          )}

          {files.length > 0 && (
            <div className="upl-options" style={{ display: "grid", gap: 4, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
              <div className="kicker" style={{ marginBottom: 8 }}>Editing options</div>
            {videoOnly && (
              <p className="adm-banner adm-banner--info" style={{ marginBottom: 10 }}>Video only: no photos were added, so there is nothing to edit. The clips go to the listing&rsquo;s {storeName} folder under Video. Finish the upload below.</p>
            )}
            {!connected && !videoOnly && (
              <p className="adm-banner adm-banner--warn" style={{ marginBottom: 10 }}>Editing account not connected yet. Aura is the only option shown; the shoot will wait safely until the account is connected.</p>
            )}

            {!videoOnly && (<>
            <div className="adm-toggle" style={{ flexDirection: "column", gap: 10, alignItems: "stretch" }}>
              <div className="flex items-start justify-between" style={{ gap: 16 }}>
                <div><div className="adm-toggle__t">Editing model</div><div className="adm-toggle__d">Aura is {brand.shortName}&rsquo;s default. Pick another look if the agent asked for it.</div></div>
                {!options.nda && connected && models.length > 1 && (
                  <label className="flex items-center" style={{ gap: 8, fontSize: 13, whiteSpace: "nowrap" }}>
                    <input type="checkbox" checked={options.split} onChange={(e) => { const v = e.target.checked; setOptions((o) => ({ ...o, split: v })); }} /> Indoor and outdoor separately
                  </label>
                )}
              </div>
              {options.nda ? (
                <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>NDA shoots always run on Aura.</p>
              ) : options.split ? (
                <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 10 }}>
                  <div className="field"><label htmlFor="m-in">Indoor</label>
                    <select id="m-in" value={options.indoorModelId} onChange={(e) => { const v = Number(e.target.value); setOptions((o) => ({ ...o, indoorModelId: v })); }}>
                      {indoorModels.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.variant}{m.credits != null ? ` · ${m.credits} cr` : ""}</option>)}
                    </select></div>
                  <div className="field"><label htmlFor="m-out">Outdoor</label>
                    <select id="m-out" value={options.outdoorModelId} onChange={(e) => { const v = Number(e.target.value); setOptions((o) => ({ ...o, outdoorModelId: v })); }}>
                      {outdoorModels.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.variant}{m.credits != null ? ` · ${m.credits} cr` : ""}</option>)}
                    </select></div>
                </div>
              ) : (
                <div className="adm-choice" style={{ maxHeight: 280, overflow: "auto" }}>
                  {(models.length ? models.filter((m) => m.variant === "indoor/outdoor") : [{ id: AURA_MODEL_ID, name: "Aura", description: "Handcrafted, flash composite look", variant: "indoor/outdoor", type: "custom", credits: 3 } as Model]).map((m) => (
                    <button key={m.id} type="button" className={options.indoorModelId === m.id ? "is-on" : ""} onClick={() => setOptions((o) => ({ ...o, indoorModelId: m.id, outdoorModelId: m.id }))}>
                      <span><span style={{ fontWeight: 500 }}>{m.name}</span><small>{m.description ?? m.variant}</small></span>
                      <span className="adm-mono muted">{m.credits != null ? `${m.credits} cr` : ""}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="adm-toggle">
              <div><div className="adm-toggle__t">These are finished JPGs, skip HDR</div><div className="adm-toggle__d">Uploads as display files: no bracket merge, ready for twilight and QC straight away.</div></div>
              <Switch on={options.skipHdr} onChange={(v) => setOptions((o) => ({ ...o, skipHdr: v }))} label="Skip HDR" />
            </div>

            <div className="adm-toggle" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
              <div className="flex items-start justify-between" style={{ gap: 16 }}>
                <div><div className="adm-toggle__t">Virtual twilight</div><div className="adm-toggle__d">The best daytime exteriors get a Champagne twilight version in their own section.</div></div>
                <Switch on={options.twilight.enabled} onChange={(v) => setOptions((o) => ({ ...o, twilight: { ...o.twilight, enabled: v } }))} label="Virtual twilight" />
              </div>
              {options.twilight.enabled && (
                <div style={{ maxWidth: 420 }}>
                  <label htmlFor="tw-count" className="flex justify-between" style={{ fontSize: 12.5, marginBottom: 6 }}><span>How many</span><strong className="adm-mono">{options.twilight.count}</strong></label>
                  <input id="tw-count" className="adm-range" type="range" min={TWILIGHT_MIN} max={TWILIGHT_MAX} value={options.twilight.count} onChange={(e) => { const v = Number(e.target.value); setOptions((o) => ({ ...o, twilight: { ...o.twilight, count: v } })); }} />
                  <div className="flex justify-between muted adm-mono" style={{ fontSize: 11, marginTop: 4 }}><span>{TWILIGHT_MIN}</span><span>{TWILIGHT_MAX}</span></div>
                </div>
              )}
            </div>

            </>)}

            <div className="adm-toggle">
              <div><div className="adm-toggle__t">NDA listing</div><div className="adm-toggle__d">{videoOnly ? `Hidden from partners. The clips still go to ${storeName} under the listing's folder.` : "Runs on Aura under the NDA name, never with an address. Hidden from partners."}</div></div>
              <Switch on={options.nda} onChange={(v) => setOptions((o) => ({ ...o, nda: v }))} label="NDA" disabled={Boolean(listing.nda)} />
            </div>

            <div className="adm-toggle" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <div className="adm-toggle__t">Notes for the editor</div>
              <div className="field"><textarea rows={3} value={options.notes} onChange={(e) => { const v = e.target.value; setOptions((o) => ({ ...o, notes: v })); }} placeholder="Anything the person doing QC should know." style={{ minHeight: 80 }} /></div>
            </div>

            {!videoOnly && (
              <div className="adm-card adm-card--fog" style={{ marginTop: 8, fontSize: 13.5, lineHeight: 1.6 }}>
                <strong>Estimate:</strong> about {credits.photos} finished frames × {mainModel?.credits ?? 3} credits{options.twilight.enabled ? ` + ${Math.min(options.twilight.count, credits.photos)} twilight × 5` : ""} = <strong className="adm-mono">{credits.total} credits</strong>. Credits are at the editing account&apos;s rates. Raws are counted in brackets of three; the shoot page shows the real number once editing starts.{videoCount ? ` The ${videoCount} clip${videoCount === 1 ? "" : "s"} cost nothing: ${videoCount === 1 ? "it goes" : "they go"} to Dropbox only.` : ""}
              </div>
            )}
            </div>
          )}

          <div className="adm-actions" style={{ borderTop: "1px solid var(--line)", paddingTop: 16, alignItems: "center" }}>
            {allLanded || !armed ? (
              <button type="button" className="btn btn-primary" disabled={submitting || files.length === 0} onClick={() => (allLanded ? void submit() : arm())}>
                {submitting ? "Submitting…" : allLanded ? (videoOnly ? "Finish upload →" : "Submit for editing →") : videoOnly ? "Finish when the upload is done →" : "Save and submit when the upload is done →"}
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={() => setArmed(false)}>Cancel auto submit</button>
            )}
            {failedCount + stuckCount > 0 && !uploading && <button type="button" className="btn btn-ghost" onClick={() => { autoRef.current.retries = 0; setGaveUp(false); void runUploads(); }}>Retry failed →</button>}
            {leaveOut > 0 && !uploading && !submitting && doneCount > 0 && (shootIdRef.current || demo) && (
              <button type="button" className="btn btn-ghost" onClick={submitWithout}>Submit without the {leaveOut} {leaveOut === 1 ? "file" : "files"} →</button>
            )}
            {!allLanded && files.length > 0 && !armed && <span className="muted" style={{ fontSize: 13 }}>{uploading ? `Uploading ${doneCount} of ${files.length}…` : failedCount ? `${failedCount} failed.` : `${files.length - doneCount} file${files.length - doneCount === 1 ? "" : "s"} still need to upload.`}</span>}
          </div>
          {armed && !allLanded && (
            gaveUp ? (
              <p className="adm-banner adm-banner--warn" role="status">{files.length - doneCount} file{files.length - doneCount === 1 ? "" : "s"} did not upload after several tries, so this has not gone to editing yet. Check the connection and press Retry failed, or submit without them; it still submits on its own once everything is in.</p>
            ) : (
              <p className="adm-banner adm-banner--ok" role="status">Saved. The moment the last file lands ({doneCount} of {files.length} so far), this {videoOnly ? "finishes" : "goes to editing"} on its own{videoCount ? ", and the video team hears once the clips are in Dropbox" : ""}. Nothing else to click. Keep this page open until then, since the files upload from this computer. Changes to the options still count until it submits.</p>
            )
          )}
        </div>
      )}

    </div>
  );
}
