// The shoot pipeline. Two entry points drive the same state machine:
//
//   - advanceShoot(id, budget): one shoot, as many steps as fit in the budget.
//     Called right after submit (immediate start), from "Run now", "Retry
//     step" and "Run QC again" on the shoot page, and from the status poll.
//   - runPipelineTick(budget): the cron safety net (GET /api/cron/pipeline,
//     every minute on production). Claims a few active shoots and calls
//     advanceShoot on each.
//
//   uploaded → transferring → committing → processing → importing → twilight → qc → ready_for_review
//
// Each step stores its cursor in shoots.progress so it can span several runs.
// A short lease (shoots.lease_until) keeps overlapping runs off the same row,
// whichever entry point they came from. On any error the shoot is marked
// failed with the step it stopped at; the admin retries from the shoot page.
//
// v1.2: frames land with published=false and nothing reaches a client until
// an admin clicks Publish. The qc stage runs every frame through the
// automatic QC pass (src/lib/qc.ts) before ready_for_review.
import { and, asc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { ShootOptions, ShootQcSummary, ShootStatus } from "@/db/schema";
import * as ah from "./autohdr";
import { copyObject, getObjectBuffer, hasR2, putObject } from "./r2";
import { makeDerivatives, makePreview } from "./derivatives";
import { withOriginalSlot } from "./image-gate";
import { derivativeKey } from "./media-keys";
import { frameNamer } from "./frame-names";
import { logActivity, type ActivityAction } from "./activity";
import { hubQcDone, hubShootFailed, hubShootReady, postToHub } from "./slack";
import { twilightPreset } from "./twilight-preset";
import { DeferError, FatalJobError, NotConfiguredError, SkipJobError } from "./jobs-core";
import { TWILIGHT_MAX } from "./autohdr-constants";
import { ACTIVE_STATUSES } from "./shoot-status";
import { editingFilesWhere } from "./shoot-files";
import { classifyQcError, hasQc, qcImage, qcMaxFrames, qcModel, qcSummaryLine, summarizeQc, worstSeverity } from "./qc";
import { pruneQcFixes } from "./qc-fixes";
import { TransferError, transferTick, type TransferIo, type TransferPart, type TransferState, type TransferStats } from "./transfer-engine";
import { brand } from "@/lib/brand";

type ShootRow = typeof schema.shoots.$inferSelect;
type ListingRow = typeof schema.listings.$inferSelect;
type Loaded = ShootRow & { listing: ListingRow };

type TwilightJob = {
  imageUuid: string;
  jobId: string;
  prevVersion: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped" | "done";
  message?: string;
  submittedAt: string;
};

type QcProgress = {
  total: number;
  done: number;
  startedAt: string;
  retries?: number;
  frameErrors?: number;
  twilightCount?: number;
  twilightFailed?: number;
  // "Run QC again" on a published shoot: go back to published, not review.
  returnTo?: "published";
};

type Progress = {
  // Oct 21 2026: the shoot is sent to editing in parts (src/lib/transfer-engine.ts).
  // One part = one upstream photoshoot; a small shoot is one part. `uploads`
  // holds the presigned links of the open part only. Shoots in flight on the
  // previous code have no `parts` and one upstream shoot in the columns;
  // partsOf() reads them as a single part.
  parts?: TransferPart[];
  transfer?: TransferStats;
  uploads?: Record<string, { url: string; content_type: string }>;
  slotsIssuedAt?: string;
  lastStatus?: string;
  partial?: boolean;
  imported?: string[];
  twilight?: {
    phase: "pick" | "submit" | "poll";
    classes: Record<string, string>;
    picks: string[];
    jobs: TwilightJob[];
    startedAt: string;
    describeErrors?: number;
    // Oct 27 2026: when the shoot first waited for the Champagne preset to be set (the hub heard then).
    waitingSince?: string;
  };
  qc?: QcProgress;
  failedFrom?: string;
  notes?: string[];
};

class StepError extends Error {
  resetToUploaded: boolean;
  constructor(message: string, resetToUploaded = false) {
    super(message);
    this.resetToUploaded = resetToUploaded;
  }
}

const TRANSFER_CONCURRENCY = 3;
const IMPORT_BATCH = 4;
const QC_CONCURRENCY = 4;
const QC_MAX_RETRY_TICKS = 8;
const PROCESSING_MAX_MS = 3 * 60 * 60 * 1000;
const TWILIGHT_JOB_MAX_MS = 2 * 60 * 60 * 1000;
const LEASE_MS = 150_000;

export function pipelineParked(): boolean {
  return !ah.hasAutoHdr();
}

const streetSlug = (address: string) =>
  address.split(",")[0].trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "Listing";

async function loadShoot(id: string): Promise<Loaded | null> {
  const s = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, id), with: { listing: true } });
  return (s as Loaded | undefined) ?? null;
}

async function save(id: string, patch: Partial<ShootRow>): Promise<void> {
  await db().update(schema.shoots).set({ ...patch, updatedAt: new Date() }).where(eq(schema.shoots.id, id));
}

async function note(shoot: Loaded, action: ActivityAction, meta?: Record<string, unknown>) {
  await logActivity({ action, shootId: shoot.id, listingId: shoot.listingId, meta });
}

function progressOf(shoot: Loaded): Progress {
  return (shoot.progress as Progress) ?? {};
}

function optionsOf(shoot: Loaded): ShootOptions {
  const o = shoot.options as ShootOptions | null;
  if (!o) throw new StepError("This shoot has no editing options saved.");
  return o;
}

function elapsedMs(shoot: Loaded): number {
  return Date.now() - (shoot.stepStartedAt ?? shoot.updatedAt).getTime();
}

// The upstream photoshoots this shoot was sent as, abandoned parts left out.
// A shoot from before parts existed reads as one part from its columns.
function partsOf(shoot: Pick<ShootRow, "status" | "autohdrPhotoshootId" | "autohdrJobId" | "progress">): TransferPart[] {
  const progress = (shoot.progress as Progress | null) ?? {};
  const parts = (progress.parts ?? []).filter((p) => !p.abandoned);
  if (parts.length) return parts;
  if (!shoot.autohdrPhotoshootId) return [];
  const pastCommit = !["uploaded", "transferring", "committing"].includes(shoot.status);
  return [{ photoshootId: shoot.autohdrPhotoshootId, jobId: shoot.autohdrJobId ?? "", filenames: [], slotsIssuedAt: progress.slotsIssuedAt ?? "", committed: pastCommit }];
}

// Which upstream photoshoot a finished frame came from: the part that listed
// it during import, else every part (newest last) for callers that can try.
export function editingIdsForImage(shoot: Pick<ShootRow, "status" | "autohdrPhotoshootId" | "autohdrJobId" | "progress">, imageUuid: string): number[] {
  const parts = partsOf(shoot);
  const own = parts.filter((p) => p.imageUuids?.includes(imageUuid)).map((p) => p.photoshootId);
  const rest = parts.map((p) => p.photoshootId).filter((id) => !own.includes(id));
  return [...own, ...rest];
}

// A lookup from image uuid to the part it belongs to, for the twilight stage.
function pidResolver(parts: TransferPart[]): (imageUuid: string) => number {
  const map = new Map<string, number>();
  for (const p of parts) for (const u of p.imageUuids ?? []) map.set(u, p.photoshootId);
  const first = parts[0]?.photoshootId;
  return (u) => map.get(u) ?? first;
}

function writeParts(progress: Progress, parts: TransferPart[]): Progress {
  const abandoned = (progress.parts ?? []).filter((p) => p.abandoned);
  return { ...progress, parts: [...parts, ...abandoned] };
}

// ---- Advance one shoot ----------------------------------------------------

export type AdvanceResult =
  | { ok: true; claimed: true; from: ShootStatus; to: ShootStatus; steps: number; failed: boolean }
  | { ok: true; claimed: false; reason: "leased" | "not_active" | "not_found" }
  | { ok: false; parked: true; reason: string };

function parkedReason(): string | null {
  if (!hasDb()) return "no database";
  if (!hasR2()) return "storage not configured";
  if (pipelineParked()) return "editing account not connected";
  return null;
}

// Runs one shoot forward for up to budgetMs. Claims the lease first (same
// rule as the cron), so two callers can never work the same shoot at once.
export async function advanceShoot(shootId: string, budgetMs: number): Promise<AdvanceResult> {
  const parked = parkedReason();
  if (parked) return { ok: false, parked: true, reason: parked };
  const d = db();
  const deadline = Date.now() + budgetMs;
  const now = new Date();
  const cand = await loadShoot(shootId);
  if (!cand) return { ok: true, claimed: false, reason: "not_found" };
  if (!ACTIVE_STATUSES.includes(cand.status)) return { ok: true, claimed: false, reason: "not_active" };
  const claimed = await d
    .update(schema.shoots)
    .set({ leaseUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(schema.shoots.id, shootId), inArray(schema.shoots.status, ACTIVE_STATUSES), or(isNull(schema.shoots.leaseUntil), lt(schema.shoots.leaseUntil, now))))
    .returning({ id: schema.shoots.id });
  if (!claimed.length) return { ok: true, claimed: false, reason: "leased" };

  const from = cand.status;
  let shoot: Loaded | null = cand;
  let to: ShootStatus = from;
  let steps = 0;
  let failed = false;
  try {
    // Keep stepping while there is time and the status keeps changing.
    for (let i = 0; i < 8 && shoot && Date.now() < deadline - 3000; i++) {
      const before = shoot.status;
      to = await advance(shoot, deadline);
      steps++;
      if (to === before || !ACTIVE_STATUSES.includes(to)) break;
      shoot = await loadShoot(shoot.id);
    }
  } catch (e) {
    failed = true;
    to = "failed";
    const fresh = (await loadShoot(shootId)) ?? cand;
    await markFailed(fresh, e);
  } finally {
    await d.update(schema.shoots).set({ leaseUntil: null }).where(eq(schema.shoots.id, shootId));
  }
  return { ok: true, claimed: true, from, to, steps, failed };
}

// ---- The tick (cron safety net) ------------------------------------------

export async function runPipelineTick(budgetMs: number): Promise<{ parked: boolean; worked: { id: string; from: string; to: string }[]; failed: string[]; skipped: string | null }> {
  const deadline = Date.now() + budgetMs;
  const worked: { id: string; from: string; to: string }[] = [];
  const failed: string[] = [];
  const parked = parkedReason();
  if (parked) return { parked: true, worked, failed, skipped: parked };

  const d = db();
  const now = new Date();
  const candidates = await d.query.shoots.findMany({
    where: and(inArray(schema.shoots.status, ACTIVE_STATUSES), or(isNull(schema.shoots.leaseUntil), lt(schema.shoots.leaseUntil, now))),
    orderBy: [asc(schema.shoots.updatedAt)],
    limit: 4,
    columns: { id: true },
  });

  for (const cand of candidates) {
    const left = deadline - Date.now();
    if (left < 8000) break;
    const r = await advanceShoot(cand.id, left);
    if (!r.ok || !r.claimed) continue;
    if (r.failed) failed.push(cand.id);
    else if (r.to !== r.from) worked.push({ id: cand.id, from: r.from, to: r.to });
  }
  return { parked: false, worked, failed, skipped: null };
}

async function markFailed(shoot: Loaded, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const progress = progressOf(shoot);
  const failedFrom = shoot.status === "failed" ? progress.failedFrom ?? "uploaded" : shoot.status;
  await save(shoot.id, {
    status: "failed",
    error: message.slice(0, 500),
    progress: { ...progress, failedFrom, resetToUploaded: e instanceof StepError ? e.resetToUploaded : false } as Record<string, unknown>,
  });
  await note(shoot, "shoot.failed", { step: failedFrom, error: message.slice(0, 200) });
  await hubShootFailed({ shootId: shoot.id, listing: shoot.listing, step: failedFrom, error: message });
  console.error(`[pipeline] shoot ${shoot.id} failed at ${failedFrom}:`, message);
}

// Returns the status after this run (same status = still working on it).
async function advance(shoot: Loaded, deadline: number): Promise<ShootStatus> {
  switch (shoot.status) {
    case "uploaded": return stepUploaded(shoot);
    case "transferring": return stepTransferring(shoot, deadline);
    case "committing": return stepCommitting(shoot);
    case "processing": return stepProcessing(shoot);
    case "importing": return stepImporting(shoot, deadline);
    case "twilight": return stepTwilight(shoot, deadline);
    case "qc": return stepQc(shoot, deadline);
    default: return shoot.status;
  }
}

// ---- uploaded → transferring: validate, then the engine sends in parts ------

// Everything the editing service needs to know about this shoot's files.
function editingSpec(shoot: Loaded): { name: string; indoor: number; outdoor: number; kind: "raw" | "display" } {
  const o = optionsOf(shoot);
  const nda = o.nda || shoot.listing.nda;
  // NDA: fixed name, Aura only, never an address upstream.
  const name = nda ? ah.NDA_PHOTOSHOOT_NAME : shoot.listing.address.split(",")[0].trim();
  const indoor = nda ? ah.AURA_MODEL_ID : o.indoorModelId || ah.AURA_MODEL_ID;
  const outdoor = nda ? ah.AURA_MODEL_ID : o.outdoorModelId || ah.AURA_MODEL_ID;
  return { name, indoor, outdoor, kind: o.skipHdr ? "display" : "raw" };
}

async function stepUploaded(shoot: Loaded): Promise<ShootStatus> {
  const d = db();
  // Photos only: raw video (kind raw_video) goes to Dropbox, never to editing.
  const w = editingFilesWhere(shoot.id);
  const files = await d.query.shootFiles.findMany({ where: and(w.shoot, w.kinds), columns: { id: true } });
  if (!files.length) throw new StepError("No photos were uploaded for this shoot (raw video alone does not go to editing).");
  editingSpec(shoot); // options must be there before anything is created upstream
  const progress = progressOf(shoot);
  await save(shoot.id, {
    status: "transferring",
    stepStartedAt: new Date(),
    error: null,
    progress: { ...progress, parts: progress.parts ?? [], uploads: {}, slotsIssuedAt: undefined } as Record<string, unknown>,
  });
  await note(shoot, "shoot.transferring", { fileCount: files.length });
  // advanceShoot steps straight on into stepTransferring, so the first
  // part's links are issued and used inside this same invocation.
  return "transferring";
}

// ---- transferring: R2 → editing, in parts (src/lib/transfer-engine.ts) ----

async function stepTransferring(shoot: Loaded, deadline: number): Promise<ShootStatus> {
  const d = db();
  const progress = progressOf(shoot);
  // The editing files only (raw and display); raw video never gets a link.
  const w = editingFilesWhere(shoot.id);
  const rows = await d.query.shootFiles.findMany({ where: and(w.shoot, w.kinds), orderBy: [asc(schema.shootFiles.filename)] });
  if (!rows.length) throw new StepError("No photos were uploaded for this shoot.");
  const spec = editingSpec(shoot);
  const byId = new Map(rows.map((r) => [r.id, r]));

  let parts = progress.parts ?? [];
  if (!parts.length && shoot.autohdrPhotoshootId && shoot.autohdrJobId && progress.uploads) {
    // In flight on the previous code: one upstream shoot holding every file.
    parts = [{
      photoshootId: shoot.autohdrPhotoshootId,
      jobId: shoot.autohdrJobId,
      filenames: rows.map((r) => r.filename),
      slotsIssuedAt: progress.slotsIssuedAt ?? (shoot.stepStartedAt ?? shoot.updatedAt).toISOString(),
    }];
  }
  const state: TransferState = {
    files: rows.map((r) => ({ id: r.id, filename: r.filename, bytes: r.bytes, uploaded: Boolean(r.autohdrUploadedAt) })),
    parts,
    uploads: progress.uploads ?? {},
    transfer: progress.transfer ?? {},
    notes: progress.notes ?? [],
  };
  const io: TransferIo = {
    now: () => Date.now(),
    deadline,
    concurrency: TRANSFER_CONCURRENCY,
    createPart: async (filenames) => {
      const c = await ah.createPhotoshoot({ name: spec.name, files: filenames.map((filename) => ({ filename, kind: spec.kind })), indoorModelId: spec.indoor, outdoorModelId: spec.outdoor });
      const uploads: Record<string, { url: string; content_type: string }> = {};
      for (const u of c.uploads) uploads[u.filename] = { url: u.url, content_type: u.content_type };
      return { photoshootId: c.photoshootId, jobId: c.jobId, uploads };
    },
    put: async (f, slot) => {
      const row = byId.get(f.id);
      if (!row) throw new StepError(`File ${f.filename} is missing from this shoot.`);
      const { body } = await getObjectBuffer(row.r2Key);
      await ah.putToSlot(slot, body);
    },
    commit: (part) => ah.commitPhotoshoot(part.photoshootId, part.jobId),
    markUploaded: (f) => d.update(schema.shootFiles).set({ autohdrUploadedAt: new Date() }).where(eq(schema.shootFiles.id, f.id)).then(() => undefined),
    resetUploaded: (files) => d.update(schema.shootFiles).set({ autohdrUploadedAt: null }).where(inArray(schema.shootFiles.id, files.map((f) => f.id))).then(() => undefined),
    persist: (st) =>
      save(shoot.id, {
        // The first part keeps the columns (the admin page's "Editing ref").
        autohdrPhotoshootId: st.parts.find((p) => !p.abandoned)?.photoshootId ?? shoot.autohdrPhotoshootId,
        autohdrJobId: st.parts.find((p) => !p.abandoned)?.jobId ?? shoot.autohdrJobId,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        progress: { ...progress, parts: st.parts, transfer: st.transfer, uploads: st.uploads, notes: st.notes, slotsIssuedAt: undefined } as Record<string, unknown>,
      }),
    lease: () => d.update(schema.shoots).set({ leaseUntil: new Date(Date.now() + LEASE_MS) }).where(eq(schema.shoots.id, shoot.id)).then(() => undefined),
  };

  let out;
  try {
    out = await transferTick(state, io);
  } catch (e) {
    if (e instanceof TransferError) throw new StepError(e.message, e.resetToUploaded);
    throw e;
  }
  if (!out.done) {
    await save(shoot.id, {});
    return "transferring";
  }
  await save(shoot.id, { status: "committing", stepStartedAt: new Date() });
  return "committing";
}

// ---- committing ---------------------------------------------------------

async function stepCommitting(shoot: Loaded): Promise<ShootStatus> {
  const parts = partsOf(shoot);
  if (!parts.length || parts.some((p) => !p.jobId)) throw new StepError("Editing shoot ids are missing. Retry to start a fresh editing shoot.", true);
  let waiting = false;
  for (const p of parts) {
    if (p.committed) continue;
    const r = await ah.commitPhotoshoot(p.photoshootId, p.jobId);
    if (r === "committed") p.committed = true;
    else waiting = true;
  }
  const progress = writeParts(progressOf(shoot), parts);
  if (waiting) {
    if (elapsedMs(shoot) > 30 * 60 * 1000) throw new StepError("Editing never saw the uploaded files land. Retry to start a fresh editing shoot.", true);
    await save(shoot.id, { progress: progress as Record<string, unknown> });
    return "committing";
  }
  await save(shoot.id, { status: "processing", stepStartedAt: new Date(), progress: { ...progress, uploads: undefined } as Record<string, unknown> });
  await note(shoot, "shoot.committed", parts.length > 1 ? { parts: parts.length } : undefined);
  return "processing";
}

// ---- processing: poll upstream -------------------------------------------

async function stepProcessing(shoot: Loaded): Promise<ShootStatus> {
  const parts = partsOf(shoot);
  if (!parts.length) throw new StepError("Editing shoot id is missing.", true);
  const elapsed = elapsedMs(shoot);
  for (const p of parts) {
    if (p.terminal) continue;
    const st = await ah.photoshootStatus(p.photoshootId);
    p.lastStatus = st.status;
    p.imageCount = st.imageCount;
    if (st.status === "success") p.terminal = "success";
    else if (st.status === "failure") {
      // Early "failure" with no frames is a known blip: keep polling up to 3 hours.
      if (st.imageCount > 0 && elapsed > 20 * 60 * 1000) p.terminal = "partial";
      else if (elapsed > PROCESSING_MAX_MS) throw new StepError("Editing reported a failure and no frames arrived within 3 hours.");
    } else if (elapsed > PROCESSING_MAX_MS) throw new StepError("Editing did not finish within 3 hours.");
  }
  const total = parts.reduce((n, p) => n + (p.imageCount ?? 0), 0);
  const progress = writeParts(progressOf(shoot), parts);
  const lastStatus = parts.every((p) => p.terminal) ? "success" : parts.map((p) => p.lastStatus ?? "in_progress").join(",");
  if (parts.every((p) => p.terminal)) {
    const partial = parts.some((p) => p.terminal === "partial");
    await save(shoot.id, {
      photoCount: total,
      status: "importing",
      stepStartedAt: new Date(),
      progress: { ...progress, lastStatus, partial: partial || undefined, imported: progress.imported ?? [] } as Record<string, unknown>,
    });
    await note(shoot, "shoot.importing", { imageCount: total, ...(partial ? { partial: true } : {}) });
    return "importing";
  }
  await save(shoot.id, { photoCount: total, progress: { ...progress, lastStatus } as Record<string, unknown> });
  if (total !== shoot.photoCount) await note(shoot, "shoot.processing", { imageCount: total });
  return "processing";
}

// ---- importing: finished frames → R2 + media rows (QC pending) -----------

async function putFrame(p: {
  shoot: Loaded;
  key: string;
  filename: string;
  url: string;
  sort: number;
  section: string | null;
  editorImageId: string;
}): Promise<void> {
  const d = db();
  // Idempotent: a crash between the insert and the cursor save must not duplicate.
  const exists = await d.query.media.findFirst({ where: and(eq(schema.media.shootId, p.shoot.id), eq(schema.media.editorImageId, p.editorImageId)), columns: { id: true } });
  if (exists) return;
  // Never write over a file another frame or upload owns (frame-names.ts
  // picks free names; this is the last line of defense).
  const clash = await d.query.media.findFirst({
    where: and(eq(schema.media.r2Key, p.key), or(isNull(schema.media.shootId), ne(schema.media.shootId, p.shoot.id))),
    columns: { id: true },
  });
  if (clash) throw new StepError(`${p.filename} would overwrite a file already on this listing. Retry the step to import it under a new name.`);
  // One of the instance's original slots from the download to the last
  // derivative (src/lib/image-gate.ts): finished frames can be 100 MP.
  const bytes = await withOriginalSlot(async () => {
    const r = await fetch(p.url, { cache: "no-store" });
    if (!r.ok) throw new StepError(`Could not fetch a finished frame (${r.status}).`);
    const original = Buffer.from(await r.arrayBuffer());
    await putObject(p.key, original, "image/jpeg");
    const derivs = await makeDerivatives(original, p.key);
    await Promise.all(derivs.map((x) => putObject(x.key, x.buffer, "image/jpeg")));
    return original.length;
  });
  await d.insert(schema.media).values({
    listingId: p.shoot.listingId,
    kind: "photo",
    r2Key: p.key,
    filename: p.filename,
    bytes,
    section: p.section,
    revision: false,
    sort: p.sort,
    shootId: p.shoot.id,
    qcState: "pending",
    editorImageId: p.editorImageId,
    // Nothing reaches a client until an admin publishes the shoot.
    published: false,
  });
}

async function stepImporting(shoot: Loaded, deadline: number): Promise<ShootStatus> {
  const parts = partsOf(shoot);
  if (!parts.length) throw new StepError("Editing shoot id is missing.", true);
  const progress0 = progressOf(shoot);
  // Every part's frames in gallery order, parts in the order they were sent,
  // so numbering runs on across parts exactly as it does inside one.
  const photos: (ah.EditedPhoto & { pid: number })[] = [];
  for (const p of parts) {
    const list = await ah.listPhotos(p.photoshootId);
    p.imageUuids = list.map((x) => x.imageUuid);
    for (const x of list) photos.push({ ...x, pid: p.photoshootId });
  }
  const progress = writeParts(progress0, parts);
  if (!photos.length) {
    if (elapsedMs(shoot) > 60 * 60 * 1000) throw new StepError("Editing finished but listed no frames.");
    await save(shoot.id, {});
    return "importing";
  }
  const imported = new Set(progress.imported ?? []);
  const o = optionsOf(shoot);
  const nda = o.nda || shoot.listing.nda;
  const street = nda ? `${brand.shortName}` : streetSlug(shoot.listing.address);
  const slug = shoot.listing.slug;
  const todo = photos.map((p, i) => ({ p, i })).filter((x) => !imported.has(x.p.imageUuid));
  // Names continue after the frames already on the listing, so a second shoot
  // never overwrites the first one's files (frame-names.ts).
  const names = await frameNamer({ listingId: shoot.listingId, shootId: shoot.id, stem: street, dir: `listings/${slug}/edited` });

  for (let b = 0; b < todo.length && Date.now() < deadline - 12000; ) {
    // One download call per part: a batch never mixes parts.
    const pid = todo[b].p.pid;
    const batch: typeof todo = [];
    while (batch.length < IMPORT_BATCH && b < todo.length && todo[b].p.pid === pid) batch.push(todo[b++]);
    const urls = await ah.downloadUrls(pid, batch.map((x) => ({ imageUuid: x.p.imageUuid })));
    await Promise.all(
      batch.map((x, k) => {
        const { filename, key } = names.at(x.i + 1);
        return putFrame({ shoot, key, filename, url: urls[k], sort: x.i, section: null, editorImageId: x.p.imageUuid });
      })
    );
    for (const x of batch) imported.add(x.p.imageUuid);
    await save(shoot.id, { photoCount: photos.length, progress: { ...progress, imported: [...imported] } as Record<string, unknown>, leaseUntil: new Date(Date.now() + LEASE_MS) });
  }

  if (imported.size < photos.length) {
    await note(shoot, "shoot.importing", { imported: imported.size, of: photos.length });
    return "importing";
  }

  if (o.twilight?.enabled && o.twilight.count > 0) {
    await save(shoot.id, {
      status: "twilight",
      stepStartedAt: new Date(),
      photoCount: photos.length,
      progress: { ...progress, imported: [...imported], twilight: { phase: "pick", classes: {}, picks: [], jobs: [], startedAt: new Date().toISOString() } } as Record<string, unknown>,
    });
    await note(shoot, "shoot.twilight", { count: o.twilight.count, look: o.twilight.look });
    return "twilight";
  }
  // startQc reads this row's progress: keep the parts (with the frames each
  // one listed) and the import cursor it just finished writing.
  shoot.progress = { ...progress, imported: [...imported] } as Record<string, unknown>;
  return startQc(shoot, photos.length, 0, 0);
}

// ---- twilight: pick → submit → poll --------------------------------------

async function stepTwilight(shoot: Loaded, deadline: number): Promise<ShootStatus> {
  const d = db();
  const parts = partsOf(shoot);
  if (!parts.length) throw new StepError("Editing shoot id is missing.", true);
  const pidOf = pidResolver(parts);
  const o = optionsOf(shoot);
  const progress = progressOf(shoot);
  const tw = progress.twilight ?? { phase: "pick" as const, classes: {}, picks: [], jobs: [], startedAt: new Date().toISOString() };
  const saveTw = (extra: Partial<ShootRow> = {}) => save(shoot.id, { ...extra, progress: { ...progress, twilight: tw } as Record<string, unknown>, leaseUntil: new Date(Date.now() + LEASE_MS) });

  const frames = await d.query.media.findMany({
    where: and(eq(schema.media.shootId, shoot.id), isNull(schema.media.section)),
    orderBy: [asc(schema.media.sort)],
  });
  const withIds = frames.filter((f) => f.editorImageId);
  const want = Math.min(Math.max(1, o.twilight.count), TWILIGHT_MAX, withIds.length);

  if (tw.phase === "pick") {
    let n = 0;
    for (const f of withIds) {
      if (tw.classes[f.editorImageId!]) continue;
      if (Date.now() > deadline - 6000) { await saveTw(); return "twilight"; }
      try {
        tw.classes[f.editorImageId!] = ah.snapScene(await ah.describePhoto(pidOf(f.editorImageId!), f.editorImageId!, ah.SCENE_PROMPT));
      } catch {
        tw.classes[f.editorImageId!] = "ERROR";
        tw.describeErrors = (tw.describeErrors ?? 0) + 1;
      }
      if (++n % 5 === 0) await saveTw();
    }
    const ext = withIds.filter((f) => tw.classes[f.editorImageId!] === "EXTERIOR_DAY");
    const aer = withIds.filter((f) => tw.classes[f.editorImageId!] === "AERIAL_DAY");
    let picks = [...ext, ...aer].slice(0, want);
    if (!picks.length && (tw.describeErrors ?? 0) === withIds.length) {
      // Vision was unavailable for every frame: first N by filename.
      picks = [...withIds].sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true })).slice(0, want);
      tw.phase = "submit";
      progress.notes = [...(progress.notes ?? []), "Scene detection was unavailable; twilight ran on the first frames by name."];
    }
    tw.picks = picks.map((f) => f.editorImageId!);
    if (!tw.picks.length) {
      progress.notes = [...(progress.notes ?? []), "No daytime exteriors were found, so no twilight frames were made."];
      await saveTw();
      return startQc(shoot, frames.length, 0, 0, progress.notes);
    }
    tw.phase = "submit";
    await saveTw();
  }

  if (tw.phase === "submit") {
    // Oct 27 2026: every twilight is the Champagne preset saved in the business
    // AutoHDR account (src/lib/twilight-preset.ts), run on each pick's Aura
    // version. Until it is set on /admin/settings the shoot waits here.
    const preset = await twilightPreset();
    if (!preset) {
      if (!tw.waitingSince) {
        tw.waitingSince = new Date().toISOString();
        const name = o.nda || shoot.listing.nda ? "an NDA listing" : shoot.listing.address.split(",")[0];
        await postToHub({ text: `Twilight is waiting: ${name}. Paste the Champagne preset's link in Settings → Virtual twilight and the twilight frames start on their own.` }).catch(() => undefined);
      }
      await saveTw({ error: "Waiting for the Champagne preset: Settings → Virtual twilight." });
      return "twilight";
    }
    if (tw.waitingSince) await saveTw({ error: null });
    const heads = new Map<string, string>();
    for (const p of parts) for (const x of await ah.listPhotos(p.photoshootId)) heads.set(x.imageUuid, x.versionUuid);
    const todo = tw.picks.filter((uuid) => !tw.jobs.some((j) => j.imageUuid === uuid));
    const targets: { photoshootId: number; imageUuid: string; versionUuid: string }[] = [];
    for (const uuid of todo) {
      const head = heads.get(uuid);
      if (!head) tw.jobs.push({ imageUuid: uuid, jobId: "", prevVersion: "", status: "failed", message: "frame missing upstream", submittedAt: new Date().toISOString() });
      else targets.push({ photoshootId: pidOf(uuid), imageUuid: uuid, versionUuid: head });
    }
    if (targets.length) {
      const at = new Date().toISOString();
      try {
        const started = await ah.runPreset(preset.uuid, targets);
        for (const t of targets) {
          const r = started.find((x) => x.imageUuid === t.imageUuid);
          if (r?.workflowUuid) tw.jobs.push({ imageUuid: t.imageUuid, jobId: r.workflowUuid, prevVersion: t.versionUuid, status: "queued", submittedAt: at });
          else tw.jobs.push({ imageUuid: t.imageUuid, jobId: "", prevVersion: t.versionUuid, status: "failed", message: r?.error ?? "the preset did not start", submittedAt: at });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        for (const t of targets) tw.jobs.push({ imageUuid: t.imageUuid, jobId: "", prevVersion: t.versionUuid, status: "failed", message, submittedAt: at });
      }
    }
    tw.phase = "poll";
    await saveTw();
  }

  // poll
  const nda = o.nda || shoot.listing.nda;
  const street = nda ? `${brand.shortName}` : streetSlug(shoot.listing.address);
  const slug = shoot.listing.slug;
  const twNames = await frameNamer({ listingId: shoot.listingId, shootId: shoot.id, stem: `${street}-Twilight`, dir: `listings/${slug}/s/twilight/photos` });
  let k = 0;
  for (const job of tw.jobs) {
    k++;
    if (["done", "failed", "skipped"].includes(job.status)) continue;
    if (Date.now() > deadline - 12000) { await saveTw(); return "twilight"; }
    try {
      const st = await ah.transformJob(job.jobId);
      if (st.status === "succeeded") {
        // The id the run reports is provisional (see landedVersion): the
        // version that actually landed is read from the photo's lineage.
        const landed = await landedVersion(pidOf(job.imageUuid), job.imageUuid, job.prevVersion, job.submittedAt, st.outputVersionUuid);
        if (!landed && !st.outputVersionUuid) {
          job.status = "skipped";
          job.message = "no change";
        } else if (!landed) {
          job.status = "running";
          job.message = "finished; waiting for the version to be listed";
          if (Date.now() - new Date(job.submittedAt).getTime() > TWILIGHT_JOB_MAX_MS) {
            job.status = "failed";
            job.message = "finished, but its version never showed in the photo's history";
          }
        } else {
          const { filename, key } = twNames.at(k);
          // Download downloads the photo's current version: make it the twilight first.
          await ah.setPhotoVersion(pidOf(job.imageUuid), job.imageUuid, landed);
          const [url] = await ah.downloadUrls(pidOf(job.imageUuid), [{ imageUuid: job.imageUuid }]);
          await putFrame({ shoot, key, filename, url, sort: k, section: "Twilight", editorImageId: `${job.imageUuid}:twilight` });
          // The day photo stays the day photo.
          await ah.setPhotoVersion(pidOf(job.imageUuid), job.imageUuid, job.prevVersion);
          job.status = "done";
        }
      } else if (st.status === "failed") {
        job.status = "failed";
        job.message = st.failureMessage ?? "failed";
      } else {
        job.status = st.status === "running" ? "running" : "queued";
        if (Date.now() - new Date(job.submittedAt).getTime() > TWILIGHT_JOB_MAX_MS) {
          job.status = "failed";
          job.message = "timed out after 2 hours";
        }
      }
    } catch (e) {
      job.message = e instanceof Error ? e.message : String(e);
      if (Date.now() - new Date(job.submittedAt).getTime() > TWILIGHT_JOB_MAX_MS) job.status = "failed";
    }
    await saveTw();
  }
  if (tw.jobs.some((j) => !["done", "failed", "skipped"].includes(j.status))) return "twilight";

  const done = tw.jobs.filter((j) => j.status === "done").length;
  const failedN = tw.jobs.filter((j) => j.status === "failed").length;
  return startQc(shoot, frames.length, done, failedN, progress.notes);
}

// ---- Make twilight: Champagne on one frame (Oct 27 2026) -------------------
//
// the owner: "on each photo once we've opened it, add a setting that says make
// twilight". The shoot page's button queues one twilight.frame job; this runs
// it: the Champagne preset on the photo's current (Aura) version upstream,
// then, once the run is done, the result is pulled into the shoot's Twilight
// section as a new frame (internal until approved) and the photo upstream is
// pointed back at its day version. Allowed once editing is done (QC, review,
// published), so the name never meets the twilight step's own frames.

export const MAKE_TWILIGHT_STATUSES: readonly ShootStatus[] = ["qc", "ready_for_review", "published"];
const FRAME_TWILIGHT_MAX_MS = 2 * 60 * 60 * 1000;

type JobRow = typeof schema.jobs.$inferSelect;

type FrameRow = { id: string; shootId: string; editorImageId: string; filename: string };

export async function runFrameTwilight(job: JobRow): Promise<void> {
  const p = job.payload ?? {};
  if (!p.mediaId) throw new FatalJobError("twilight.frame needs payload.mediaId");
  const m = await db().query.media.findFirst({ where: eq(schema.media.id, p.mediaId), columns: { id: true, shootId: true, editorImageId: true, filename: true, section: true } });
  if (!m || !m.shootId || !m.editorImageId || m.editorImageId.includes(":")) throw new SkipJobError("that frame is gone, or it is not a photo from editing");
  try {
    await frameTwilight(job, { id: m.id, shootId: m.shootId, editorImageId: m.editorImageId, filename: m.filename });
  } catch (e) {
    // Oct 28 2026: alerts name the step and the frame. Several frames can be
    // converted back to back, and a bare upstream "not found" said neither.
    if (e instanceof Error) e.message = `Make twilight, ${m.filename}: ${e.message}`;
    throw e;
  }
}

async function frameTwilight(job: JobRow, m: FrameRow): Promise<void> {
  const p = job.payload ?? {};
  const d = db();
  const shoot = await loadShoot(m.shootId);
  if (!shoot) throw new SkipJobError("that shoot is gone");
  const parts = partsOf(shoot);
  if (!parts.length) throw new FatalJobError("this shoot has no editing shoot id");
  const imageUuid = m.editorImageId;
  const pid = pidResolver(parts)(imageUuid);
  const savePayload = (extra: Record<string, unknown>) => d.update(schema.jobs).set({ payload: { ...p, ...extra }, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));

  if (!p.workflowUuid) {
    const preset = await twilightPreset();
    if (!preset) throw new NotConfiguredError("the Champagne preset (Settings → Virtual twilight)");
    const head = (await ah.listPhotos(pid)).find((x) => x.imageUuid === imageUuid)?.versionUuid;
    if (!head) throw new FatalJobError("Editing no longer lists this photo. AutoHDR keeps a shoot for 7 days.");
    const [r] = await ah.runPreset(preset.uuid, [{ photoshootId: pid, imageUuid, versionUuid: head }]);
    if (!r?.workflowUuid) throw new FatalJobError(`Champagne did not start: ${r?.error ?? "no run id"}`);
    await savePayload({ workflowUuid: r.workflowUuid, prevVersion: head, runStartedAt: new Date().toISOString() });
    throw new DeferError("Champagne is running", 20_000);
  }

  const overdue = Date.now() - new Date(p.runStartedAt ?? job.createdAt).getTime() > FRAME_TWILIGHT_MAX_MS;
  let st: Awaited<ReturnType<typeof ah.transformJob>>;
  try {
    st = await ah.transformJob(p.workflowUuid);
  } catch (e) {
    // Oct 28 2026 (1656 Pine): with several frames converted back to
    // back, AutoHDR answers 404 for a run it has not listed yet (queued behind
    // another frame's run). Keep polling quietly for the run's 2 hours, like
    // the shoot's twilight step: no attempt counted, no alert. Nothing was
    // pulled yet, so the photo's version is left alone (see below).
    if (e instanceof ah.AutoHdrError && e.status === 404 && !overdue) throw new DeferError("Champagne is queued upstream (the run is not listed yet)", 30_000);
    throw named("reading the run", e);
  }
  if (st.status === "failed") throw new FatalJobError(`Champagne failed: ${st.failureMessage ?? "no reason given"}`);
  if (st.status !== "succeeded") {
    if (overdue) throw new FatalJobError("Champagne did not finish in 2 hours");
    throw new DeferError("Champagne is still running", 15_000);
  }
  // The id the run reports is provisional (see landedVersion): find the
  // version that actually landed before touching the photo.
  const landed = await landedVersion(pid, imageUuid, String(p.prevVersion ?? ""), String(p.runStartedAt ?? job.createdAt.toISOString()), st.outputVersionUuid).catch((e) => { throw named("reading the photo's history", e); });
  if (!landed) {
    if (!st.outputVersionUuid) throw new SkipJobError("Champagne ran and changed nothing on this photo");
    if (overdue) throw new FatalJobError("Champagne finished but its version never showed in the photo's history");
    throw new DeferError("Champagne finished; waiting for the version to be listed", 15_000);
  }

  const nda = optionsOf(shoot).nda || shoot.listing.nda;
  const street = nda ? `${brand.shortName}` : streetSlug(shoot.listing.address);
  const existing = await d.query.media.findMany({ where: and(eq(schema.media.shootId, shoot.id), eq(schema.media.section, "Twilight")), columns: { id: true, sort: true } });
  const n = existing.length + 1;
  const { filename, key } = (await frameNamer({ listingId: shoot.listingId, shootId: shoot.id, stem: `${street}-Twilight`, dir: `listings/${shoot.listing.slug}/s/twilight/photos` })).at(n);
  // Download hands out the photo's current version: the twilight for this
  // pull, then the day version again whatever happens. The polls above never
  // set a version, so a deferred poll has nothing to reset (and resetting
  // while the run is in flight would race it).
  await ah.setPhotoVersion(pid, imageUuid, landed).catch((e) => { throw named(`setting the twilight version on shoot ${pid}`, e); });
  try {
    const [url] = await ah.downloadUrls(pid, [{ imageUuid }]).catch((e) => { throw named(`downloading from shoot ${pid}`, e); });
    await putFrame({ shoot, key, filename, url, sort: existing.reduce((a, x) => Math.max(a, x.sort), 0) + 1, section: "Twilight", editorImageId: `${imageUuid}:twilight:${p.workflowUuid.slice(0, 8)}` });
  } finally {
    if (p.prevVersion) await ah.setPhotoVersion(pid, imageUuid, p.prevVersion).catch((e) => console.error("[twilight.frame] reset version", e));
  }
  await logActivity({ actorEmail: p.requestedBy ?? null, action: "shoot.twilight_made", shootId: shoot.id, listingId: shoot.listingId, meta: { from: m.filename, file: filename } });
}

// Oct 28 2026 (1656 Pine): the run's output_image_version_uuid is minted
// when the run is SUBMITTED (same millisecond as the run id), and the version
// that lands when the run finishes carries a different id; the reported one is
// never in the photo's lineage. Setting the photo to the reported id answered
// 404 unless the poll happened to land within seconds of the finish, so most
// twilights (shoot step and Make twilight alike) never came in, while the
// credits were spent and the twilight sat upstream as the photo's head. The
// version that landed is the lineage step that grew out of the version the run
// was submitted on, minted after the run started. Null while the lineage has
// not listed it yet (poll again).
export async function landedVersion(pid: number, imageUuid: string, submittedOn: string, startedAt: string, reported: string | null): Promise<string | null> {
  const steps = await ah.photoHistory(pid, imageUuid);
  if (reported && steps.some((s) => s.versionUuid === reported)) return reported;
  const since = new Date(startedAt).getTime() - 5_000;
  const grown = steps.filter((s) => s.parentUuid === submittedOn && (uuidTime(s.versionUuid) ?? 0) >= since);
  return grown.at(-1)?.versionUuid ?? null;
}

// The millisecond a time-ordered (v7) uuid was minted; null for other ids.
export function uuidTime(uuid: string): number | null {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || hex[12] !== "7") return null;
  const ms = parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(ms) ? ms : null;
}

// Oct 28 2026: the alert says which upstream call failed, not just "not found".
function named(step: string, e: unknown): unknown {
  if (e instanceof Error) e.message = `${step}: ${e.message}`;
  return e;
}

// Read-only look at one Make twilight job from the editing account's side
// (operator diagnostics, Oct 28 2026): which part the frame resolves to, what
// the shoot lists for it, its lineage, the run's state, and whether a download
// from that part works. Nothing is changed upstream; no credits are spent.
export async function probeFrameTwilight(jobId: string): Promise<Record<string, unknown>> {
  const d = db();
  const job = await d.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job) throw new Error("Job not found.");
  const p = job.payload ?? {};
  const m = p.mediaId ? await d.query.media.findFirst({ where: eq(schema.media.id, p.mediaId), columns: { id: true, shootId: true, editorImageId: true, filename: true } }) : null;
  const out: Record<string, unknown> = { job: { id: job.id, kind: job.kind, status: job.status, attempts: job.attempts, lastError: job.lastError, payload: p }, media: m };
  if (!m?.shootId || !m.editorImageId) return out;
  const shoot = await loadShoot(m.shootId);
  if (!shoot) return { ...out, shoot: null };
  const imageUuid = m.editorImageId;
  const parts = partsOf(shoot);
  const pid = pidResolver(parts)(imageUuid);
  out.parts = parts.map((x) => ({ photoshootId: x.photoshootId, imageUuids: x.imageUuids?.length ?? 0, hasThisImage: x.imageUuids?.includes(imageUuid) ?? false }));
  out.pid = pid;
  const attempt = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { error: e instanceof Error ? e.message : String(e), status: e instanceof ah.AutoHdrError ? e.status : null };
    }
  };
  await attempt("listed", async () => (await ah.listPhotos(pid)).find((x) => x.imageUuid === imageUuid) ?? "not in that shoot's list");
  await attempt("history", () => ah.photoHistory(pid, imageUuid));
  if (typeof p.workflowUuid === "string") await attempt("run", () => ah.transformJob(p.workflowUuid as string));
  await attempt("download", async () => (await ah.downloadUrls(pid, [{ imageUuid }])).length);
  return out;
}

// ---- Restore a frame's day version (Oct 27 2026) ----------------------------
//
// 1656 Pine: a day frame came in as its Champagne twilight, because the
// photo's current version upstream was a Champagne run when the import pulled
// it. editingHistory lists every frame's lineage (the operator finds the
// frame whose head is not the plain edit); restoreFrameVersion points the
// photo upstream back at the version asked for, downloads it and replaces the
// frame's file in place (the previous file kept under shoots/<id>/replaced/,
// derivatives rebuilt), like a corrected final, minus the "corrected" badge.

export async function editingHistory(shootId: string): Promise<{ mediaId: string; filename: string; sort: number; imageUuid: string; steps: ah.HistoryStep[] | null; error?: string }[]> {
  const d = db();
  const shoot = await loadShoot(shootId);
  if (!shoot) throw new Error("Shoot not found.");
  const pidOf = pidResolver(partsOf(shoot));
  const frames = await d.query.media.findMany({ where: and(eq(schema.media.shootId, shootId), isNull(schema.media.section)), orderBy: [asc(schema.media.sort)], columns: { id: true, filename: true, sort: true, editorImageId: true } });
  const out: { mediaId: string; filename: string; sort: number; imageUuid: string; steps: ah.HistoryStep[] | null; error?: string }[] = [];
  for (const f of frames) {
    if (!f.editorImageId || f.editorImageId.includes(":")) continue;
    try {
      out.push({ mediaId: f.id, filename: f.filename, sort: f.sort, imageUuid: f.editorImageId, steps: await ah.photoHistory(pidOf(f.editorImageId), f.editorImageId) });
    } catch (e) {
      out.push({ mediaId: f.id, filename: f.filename, sort: f.sort, imageUuid: f.editorImageId, steps: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export async function restoreFrameVersion(mediaId: string, versionUuid: string, actor: string): Promise<{ filename: string; bytes: number; previous: string }> {
  const d = db();
  const m = await d.query.media.findFirst({ where: eq(schema.media.id, mediaId) });
  if (!m || !m.shootId || !m.editorImageId || m.editorImageId.includes(":")) throw new Error("That frame is not a photo from editing.");
  const shoot = await loadShoot(m.shootId);
  if (!shoot) throw new Error("Shoot not found.");
  const pid = pidResolver(partsOf(shoot))(m.editorImageId);
  const steps = await ah.photoHistory(pid, m.editorImageId);
  if (!steps.some((s) => s.versionUuid === versionUuid)) throw new Error("That version is not in this photo's history.");
  await ah.setPhotoVersion(pid, m.editorImageId, versionUuid);
  const [url] = await ah.downloadUrls(pid, [{ imageUuid: m.editorImageId }]);
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Could not fetch that version (${r.status}).`);
  const body = Buffer.from(await r.arrayBuffer());
  const previous = `shoots/${shoot.id}/replaced/${new Date().toISOString().replace(/[:.]/g, "-")}/${m.filename}`;
  await copyObject(m.r2Key, previous).catch((e) => console.warn("[restore-frame] could not keep the previous file", m.r2Key, e));
  await putObject(m.r2Key, body, "image/jpeg");
  const derivs = await makeDerivatives(body, m.r2Key);
  await Promise.all(derivs.map((x) => putObject(x.key, x.buffer, "image/jpeg")));
  await d.update(schema.media).set({ bytes: body.length, qcScore: null, qcIssues: null, qcSuggestions: null, qcSummary: null, qcCheckedAt: null }).where(eq(schema.media.id, m.id));
  await logActivity({ actorEmail: actor, action: "media.replaced", shootId: shoot.id, listingId: shoot.listingId, meta: { mediaId: m.id, filename: m.filename, previous, bytes: body.length, reason: "restored the day version from editing" } });
  return { filename: m.filename, bytes: body.length, previous };
}

// ---- qc: automatic QC pass on every frame ---------------------------------

export const QC_SKIPPED_NO_KEY = "QC pass skipped: key not set";

// Frames the pass should look at: this shoot's frames that are not already
// checked and not rejected by a person. Since Nov 3 2026 that includes the
// editors' corrected uploads (the Revised section): the coordinator's flow is
// upload the revised photos, then Run QC again on them and tick each flag.
function qcCandidatesWhere(shootId: string) {
  return and(
    eq(schema.media.shootId, shootId),
    isNull(schema.media.qcCheckedAt),
    ne(schema.media.qcState, "rejected")
  );
}

// Enter the qc stage, or skip straight to review when the key is not set.
async function startQc(shoot: Loaded, photoCount: number, twilightCount: number, twilightFailed: number, notes?: string[]): Promise<ShootStatus> {
  const progress = progressOf(shoot);
  if (!hasQc()) {
    const n = [...(notes ?? progress.notes ?? [])];
    if (!n.includes(QC_SKIPPED_NO_KEY)) n.push(QC_SKIPPED_NO_KEY);
    return finishToReview(shoot, photoCount, twilightCount, twilightFailed, n, null);
  }
  const d = db();
  const todo = await d.query.media.findMany({ where: qcCandidatesWhere(shoot.id), columns: { id: true } });
  const qc: QcProgress = { total: Math.min(todo.length, qcMaxFrames()), done: 0, startedAt: new Date().toISOString(), twilightCount, twilightFailed };
  await save(shoot.id, {
    status: "qc",
    stepStartedAt: new Date(),
    photoCount,
    progress: { ...progress, notes, qc } as Record<string, unknown>,
  });
  await note(shoot, "shoot.qc", { total: qc.total });
  return "qc";
}

// Preview bytes for one frame: the stored 1600px derivative, else a fresh one.
async function previewFor(r2Key: string): Promise<Buffer> {
  try {
    return (await getObjectBuffer(derivativeKey(r2Key, "preview"))).body;
  } catch {
    return withOriginalSlot(async () => makePreview((await getObjectBuffer(r2Key)).body));
  }
}

async function stepQc(shoot: Loaded, deadline: number): Promise<ShootStatus> {
  const d = db();
  const progress = progressOf(shoot);
  const qc: QcProgress = progress.qc ?? { total: 0, done: 0, startedAt: new Date().toISOString() };
  const saveQc = () => save(shoot.id, { progress: { ...progress, qc } as Record<string, unknown>, leaseUntil: new Date(Date.now() + LEASE_MS) });

  if (!hasQc()) return finishQc(shoot, qc, [QC_SKIPPED_NO_KEY]);

  const max = qcMaxFrames();
  const checkedSoFar = await d.query.media.findMany({ where: eq(schema.media.shootId, shoot.id), columns: { id: true, qcCheckedAt: true } });
  const alreadyChecked = checkedSoFar.filter((m) => m.qcCheckedAt).length;
  const room = Math.max(0, max - alreadyChecked);
  const todo = room
    ? await d.query.media.findMany({ where: qcCandidatesWhere(shoot.id), orderBy: [asc(schema.media.section), asc(schema.media.sort)], limit: room })
    : [];
  qc.total = Math.min(alreadyChecked + todo.length, max);
  qc.done = alreadyChecked;

  const notes: string[] = [];
  if (!todo.length) {
    const leftOver = await d.query.media.findMany({ where: qcCandidatesWhere(shoot.id), columns: { id: true } });
    if (leftOver.length) notes.push(`QC budget reached: ${leftOver.length} frame${leftOver.length === 1 ? "" : "s"} not checked (STUDIO_QC_MAX_FRAMES).`);
    return finishQc(shoot, qc, notes);
  }

  let i = 0;
  let fatal: string | null = null;
  let retry: string | null = null;
  const worker = async () => {
    while (i < todo.length && !fatal && !retry && Date.now() < deadline - 10_000) {
      const m = todo[i++];
      try {
        const preview = await previewFor(m.r2Key);
        const r = await qcImage(preview, { filename: m.filename, section: m.section });
        // Nov 3 2026 (the coordinator: "ALL photos should be marked as Internal Only
        // at this point, no photos should be blocked or not visible on the
        // dashboard"): a block issue no longer rejects the frame. It stays
        // unreviewed and Internal only, in its section, with the flag as a
        // checkbox; Approve all leaves it for a person (qc-labels.ts).
        await d
          .update(schema.media)
          .set({
            qcScore: r.score,
            qcIssues: r.issues,
            qcSuggestions: r.suggestions,
            qcSummary: r.summary,
            qcCheckedAt: new Date(),
          })
          .where(eq(schema.media.id, m.id));
        qc.done++;
      } catch (e) {
        const c = classifyQcError(e);
        if (c.kind === "fatal") { fatal = c.message; return; }
        if (c.kind === "retry") { retry = c.message; return; }
        qc.frameErrors = (qc.frameErrors ?? 0) + 1;
        await d.update(schema.media).set({ qcSummary: `QC could not check this frame: ${c.message}`, qcCheckedAt: new Date() }).where(eq(schema.media.id, m.id));
        qc.done++;
      }
      await saveQc();
    }
  };
  await Promise.all(Array.from({ length: Math.min(QC_CONCURRENCY, todo.length) }, worker));

  if (fatal) return finishQc(shoot, qc, [fatal]);
  if (retry) {
    qc.retries = (qc.retries ?? 0) + 1;
    await saveQc();
    if (qc.retries > QC_MAX_RETRY_TICKS) return finishQc(shoot, qc, [`QC incomplete: the QC service kept failing (${retry}).`]);
    await note(shoot, "shoot.qc", { done: qc.done, total: qc.total, retry });
    return "qc";
  }
  const remaining = await d.query.media.findMany({ where: qcCandidatesWhere(shoot.id), columns: { id: true } });
  if (remaining.length && qc.done < max) {
    await saveQc();
    await note(shoot, "shoot.qc", { done: qc.done, total: qc.total });
    return "qc";
  }
  if (remaining.length) notes.push(`QC budget reached: ${remaining.length} frame${remaining.length === 1 ? "" : "s"} not checked (STUDIO_QC_MAX_FRAMES).`);
  return finishQc(shoot, qc, notes);
}

// Roll the per-frame results up onto the shoot and move on to review.
async function finishQc(shoot: Loaded, qc: QcProgress, qcNotes: string[]): Promise<ShootStatus> {
  const d = db();
  const progress = progressOf(shoot);
  const frames = await d.query.media.findMany({
    where: eq(schema.media.shootId, shoot.id),
    columns: { id: true, filename: true, qcScore: true, qcIssues: true, qcSummary: true, qcCheckedAt: true },
  });
  const summary = summarizeQc(frames, { notes: qcNotes, model: hasQc() ? qcModel() : null });
  // Photo QC's fix ticks (src/lib/qc-fixes.ts): a flag found again word for
  // word keeps its tick; ticks on flags this pass did not find are dropped.
  await pruneQcFixes(frames);
  const line = qcSummaryLine(summary);
  const photoCount = (await d.query.media.findMany({ where: and(eq(schema.media.shootId, shoot.id), isNull(schema.media.section)), columns: { id: true } })).length;
  await save(shoot.id, { qcSummary: summary, qcCheckedAt: new Date(), progress: { ...progress, qc } as Record<string, unknown> });
  await note(shoot, "shoot.qc_done", { line, blocked: summary.blocked, fix: summary.fix, minor: summary.minor, checked: summary.checked });
  const notes = [...(progress.notes ?? [])];
  for (const n of qcNotes) if (!notes.includes(n)) notes.push(n);
  if (qc.returnTo === "published") {
    await save(shoot.id, { status: "published", stepStartedAt: new Date(), progress: { ...progress, notes, qc } as Record<string, unknown> });
    await hubQcDone({ shootId: shoot.id, listing: shoot.listing, line: line || "finished" });
    return "published";
  }
  return finishToReview(shoot, photoCount || shoot.photoCount, qc.twilightCount ?? 0, qc.twilightFailed ?? 0, notes, summary);
}

async function finishToReview(shoot: Loaded, photoCount: number, twilightCount: number, twilightFailed: number, notes: string[] | undefined, qc: ShootQcSummary | null): Promise<ShootStatus> {
  const progress = progressOf(shoot);
  const rerun = Boolean(progress.qc && shoot.readyAt);
  await save(shoot.id, {
    status: "ready_for_review",
    readyAt: shoot.readyAt ?? new Date(),
    stepStartedAt: new Date(),
    photoCount,
    error: twilightFailed ? `${twilightFailed} twilight frame${twilightFailed === 1 ? "" : "s"} did not finish.` : null,
    progress: { ...progress, notes } as Record<string, unknown>,
  });
  const qcLine = qc ? qcSummaryLine(qc) : notes?.find((n) => n.startsWith("QC pass skipped")) ?? null;
  if (rerun) {
    // "Run QC again": the shoot was already announced as ready; just post the QC result.
    await hubQcDone({ shootId: shoot.id, listing: shoot.listing, line: qcLine ?? "finished" });
  } else {
    await note(shoot, "shoot.ready", { photoCount, twilightCount });
    await hubShootReady({ shootId: shoot.id, listing: shoot.listing, photoCount, twilightCount, qcLine });
  }
  return "ready_for_review";
}

// ---- Run QC again (admins and Photo QC) -------------------------------------

// Clears the automatic QC results on the shoot's frames (the revised uploads
// included, Nov 3 2026) and puts the shoot back into the qc stage. Approve
// and reject decisions are kept, and no flag changes them. The caller then
// runs advanceShoot.
export async function requeueQcRow(shootId: string, actor: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = db();
  const shoot = await loadShoot(shootId);
  if (!shoot) return { ok: false, error: "Shoot not found." };
  const failedAtQc = shoot.status === "failed" && progressOf(shoot).failedFrom === "qc";
  if (shoot.status !== "ready_for_review" && shoot.status !== "published" && !failedAtQc) {
    return { ok: false, error: "QC can run again once the frames are in." };
  }
  if (!hasQc()) return { ok: false, error: QC_SKIPPED_NO_KEY };
  await d
    .update(schema.media)
    .set({ qcScore: null, qcIssues: null, qcSuggestions: null, qcSummary: null, qcCheckedAt: null })
    .where(eq(schema.media.shootId, shootId));
  const progress = progressOf(shoot);
  const todo = await d.query.media.findMany({ where: qcCandidatesWhere(shootId), columns: { id: true } });
  const notes = (progress.notes ?? []).filter((n) => !n.startsWith("QC "));
  await save(shootId, {
    status: "qc",
    error: null,
    leaseUntil: null,
    stepStartedAt: new Date(),
    qcSummary: null,
    qcCheckedAt: null,
    progress: {
      ...progress,
      notes,
      failedFrom: undefined,
      qc: { total: Math.min(todo.length, qcMaxFrames()), done: 0, startedAt: new Date().toISOString(), ...(shoot.status === "published" ? { returnTo: "published" } : {}) },
    } as Record<string, unknown>,
  });
  await logActivity({ actorEmail: actor, action: "shoot.qc_rerun", shootId, listingId: shoot.listingId, meta: { frames: todo.length, from: shoot.status } });
  return { ok: true };
}

// Which frames the admin should look at first.
export function qcFlagged(issues: { severity: string }[] | null | undefined): boolean {
  return worstSeverity((issues ?? []) as Parameters<typeof worstSeverity>[0]) !== null;
}

// ---- Retry (admin) -------------------------------------------------------

export async function retryShootRow(shootId: string, actor: string): Promise<{ ok: true; status: ShootStatus } | { ok: false; error: string }> {
  const d = db();
  const shoot = await loadShoot(shootId);
  if (!shoot) return { ok: false, error: "Shoot not found." };
  if (shoot.status !== "failed") return { ok: false, error: "Only a stopped shoot can be retried." };
  const progress = progressOf(shoot);
  const from = (progress.failedFrom as ShootStatus) ?? "uploaded";
  const reset = Boolean((progress as { resetToUploaded?: boolean }).resetToUploaded) || from === "uploaded" || from === "transferring";
  const next: ShootStatus = reset ? "uploaded" : ACTIVE_STATUSES.includes(from) ? from : "uploaded";
  // A reset drops the parts that never committed and sends their files
  // again; a part the editing service already accepted is kept (its frames
  // are coming, and sending them twice would process them twice).
  const kept = reset ? (progress.parts ?? []).filter((p) => p.committed && !p.abandoned) : (progress.parts ?? []);
  if (reset) {
    const keptNames = new Set(kept.flatMap((p) => p.filenames));
    const w = editingFilesWhere(shoot.id);
    const files = await d.query.shootFiles.findMany({ where: and(w.shoot, w.kinds), columns: { id: true, filename: true } });
    const resend = files.filter((f) => !keptNames.has(f.filename)).map((f) => f.id);
    if (resend.length) await d.update(schema.shootFiles).set({ autohdrUploadedAt: null }).where(inArray(schema.shootFiles.id, resend));
  }
  const fresh = reset && !kept.length;
  await save(shoot.id, {
    status: next,
    error: null,
    leaseUntil: null,
    stepStartedAt: new Date(),
    ...(fresh ? { autohdrPhotoshootId: null, autohdrJobId: null } : {}),
    // A reset also clears the count of abandoned parts, or a retried shoot
    // stops on its first stale part; the measured rate is kept.
    progress: {
      ...progress,
      parts: reset ? kept : progress.parts,
      uploads: reset ? undefined : progress.uploads,
      transfer: reset && progress.transfer ? { ...progress.transfer, reslots: undefined, resent: undefined } : progress.transfer,
      slotsIssuedAt: undefined,
      failedFrom: undefined,
      resetToUploaded: undefined,
    } as Record<string, unknown>,
  });
  await logActivity({ actorEmail: actor, action: "shoot.retried", shootId: shoot.id, listingId: shoot.listingId, meta: { from, to: next } });
  return { ok: true, status: next };
}
