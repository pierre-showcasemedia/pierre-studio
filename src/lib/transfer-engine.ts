// Sending a shoot's raws to the editing service in parts (Oct 21 2026).
//
// The editing API hands out one presigned PUT per file when a photoshoot is
// created, and those links expire 5 minutes later. There is no call that
// adds files or fresh links to an existing photoshoot (checked against the
// API's OpenAPI document on Oct 21 2026), so a shoot that cannot be sent
// inside one 5-minute window is sent as PARTS: each part is an upstream
// photoshoot created with just the next batch of unsent files, PUT in the
// same invocation its links were issued in, and committed on its own. A
// small shoot is exactly one part, as before.
//
// Rules the engine keeps:
//   - a file is sent once: a sent file is marked and never picked again;
//   - no PUT starts on a link older than SLOT_FRESH_MS (4 of the 5 minutes);
//   - a part whose links went stale with files still unsent is abandoned
//     (never committed, so nothing is processed or billed for it) and every
//     one of its files is sent again in a fresh part, since an uncommitted
//     part holds nothing that can be used; that is counted and noted, and
//     more than MAX_RESLOTS of it stops the shoot with a clear error;
//   - batch size follows the measured transfer rate, kept in the shoot's
//     progress, so the next part is sized to finish inside the run that
//     opens it (the time left before this run's deadline, capped at the
//     fresh window), down to a single file on a very slow link;
//   - every tick resumes at the next unsent file, refreshes the lease after
//     every file, and stops issuing PUTs TAIL_MS before its deadline.
//
// Why one run (Nov 10 2026): a cron run works for PIPELINE_STEP_SECONDS
// (200 s since Oct 27, was 50 s) and holds the shoot's lease throughout, so
// the next run starts up to a minute after it ends. A part left open at the
// end of a run is about 4 minutes old by then, and its links are stale.
// Planning against the deadline follows whatever the run length is.
//
// No database, storage or network here: pipeline.ts injects them through
// TransferIo, and scripts/check-transfer-engine.ts drives it with fakes.

export const SLOT_LIFETIME_MS = 5 * 60 * 1000;
export const SLOT_FRESH_MS = 4 * 60 * 1000;
// The first part, before any rate is known: a normal shoot is one part.
export const FIRST_BATCH = 40;
export const MAX_BATCH = 150;
const SAFETY = 0.75;
// Do not open a part when this little of the tick is left: its links would
// mostly go unused before the deadline.
export const MIN_TIME_TO_OPEN_PART_MS = 20_000;
export const TAIL_MS = 8_000;
export const MAX_RESLOTS = 4;

export type Slot = { url: string; content_type: string };

export type TransferPart = {
  photoshootId: number;
  jobId: string;
  filenames: string[]; // the files this part was created with, in order
  slotsIssuedAt: string; // ISO; the 5-minute clock starts here
  committed?: boolean; // commit accepted upstream
  abandoned?: boolean; // links went stale with files unsent; never committed
  // Filled by later stages (processing, importing); the engine leaves them alone.
  lastStatus?: string;
  terminal?: "success" | "partial";
  imageCount?: number;
  imageUuids?: string[];
};

export type TransferStats = {
  filesPerSec?: number;
  bytesPerSec?: number;
  samples?: number;
  reslots?: number; // parts abandoned for stale links
  resent?: number; // files sent again because their part was abandoned
};

export type TransferFile = { id: string; filename: string; bytes: number | null; uploaded: boolean };

export type TransferState = {
  files: TransferFile[]; // every file of the shoot, sorted by filename
  parts: TransferPart[];
  uploads: Record<string, Slot>; // links of the open part only
  transfer: TransferStats;
  notes: string[];
};

export type TransferIo = {
  now(): number;
  deadline: number;
  concurrency?: number;
  createPart(filenames: string[]): Promise<{ photoshootId: number; jobId: string; uploads: Record<string, Slot> }>;
  put(file: TransferFile, slot: Slot & { filename: string }): Promise<void>;
  commit(part: TransferPart): Promise<"committed" | "not_landed">;
  markUploaded(file: TransferFile): Promise<void>;
  resetUploaded(files: TransferFile[]): Promise<void>;
  persist(state: TransferState): Promise<void>;
  lease(): Promise<void>;
};

export type TransferOutcome = { done: boolean; sent: number; created: number; resent: number; reslots: number };

export class TransferError extends Error {
  resetToUploaded: boolean;
  constructor(message: string, resetToUploaded = false) {
    super(message);
    this.resetToUploaded = resetToUploaded;
  }
}

const isSlotExpired = (e: unknown): boolean => Boolean(e && typeof e === "object" && (e as { code?: unknown }).code === "slot_expired");

export function slotsFresh(issuedAtIso: string, now: number): boolean {
  const t = Date.parse(issuedAtIso);
  return Number.isFinite(t) && now - t < SLOT_FRESH_MS;
}

// How many files the next part should hold: the first one a fixed size,
// then the measured rate over the time this run has left (never more than
// the fresh window), with a safety margin. At least one file, so a very
// slow link still moves.
export function planBatchSize(stats: TransferStats, pending: number, windowMs: number): number {
  if (!stats.filesPerSec || stats.filesPerSec <= 0) return Math.max(1, Math.min(pending, FIRST_BATCH));
  const windowS = Math.min(SLOT_FRESH_MS, Math.max(0, windowMs)) / 1000;
  const n = Math.floor(stats.filesPerSec * windowS * SAFETY);
  return Math.max(1, Math.min(pending, MAX_BATCH, n));
}

// Blend one tick's throughput into the running rate (half old, half new).
// A single file counts too: it reads low (one PUT's time, not three in
// parallel), which is the safe side, and without it a shoot on one-file
// parts would never learn that the link got faster.
export function updateRate(stats: TransferStats, files: number, bytes: number, elapsedMs: number): TransferStats {
  if (files < 1 || elapsedMs <= 0) return stats;
  const fps = (files / elapsedMs) * 1000;
  const bps = (bytes / elapsedMs) * 1000;
  const samples = (stats.samples ?? 0) + 1;
  return {
    ...stats,
    filesPerSec: stats.filesPerSec ? stats.filesPerSec * 0.5 + fps * 0.5 : fps,
    bytesPerSec: stats.bytesPerSec ? stats.bytesPerSec * 0.5 + bps * 0.5 : bps,
    samples,
  };
}

// The part still holding unsent files, if any.
export function openPart(parts: TransferPart[], uploaded: Set<string>): TransferPart | null {
  return parts.find((p) => !p.abandoned && p.filenames.some((fn) => !uploaded.has(fn))) ?? null;
}

const uploadedNames = (files: TransferFile[]) => new Set(files.filter((f) => f.uploaded).map((f) => f.filename));

export async function transferTick(state: TransferState, io: TransferIo): Promise<TransferOutcome> {
  const out: TransferOutcome = { done: false, sent: 0, created: 0, resent: 0, reslots: 0 };
  const byName = new Map(state.files.map((f) => [f.filename, f]));
  const concurrency = Math.max(1, io.concurrency ?? 3);

  const abandon = async (part: TransferPart, why: string, said?: string) => {
    part.abandoned = true;
    const lost = part.filenames.map((fn) => byName.get(fn)).filter((f): f is TransferFile => Boolean(f && f.uploaded));
    for (const f of lost) f.uploaded = false;
    if (lost.length) await io.resetUploaded(lost);
    state.uploads = {};
    state.transfer.reslots = (state.transfer.reslots ?? 0) + 1;
    state.transfer.resent = (state.transfer.resent ?? 0) + lost.length;
    out.reslots++;
    out.resent += lost.length;
    const n = part.filenames.length;
    state.notes = [...state.notes, `Editing upload links ${why} for ${n} file${n === 1 ? "" : "s"}; they were sent again with fresh links.${said ? ` (${said})` : ""}`];
    if (state.transfer.reslots > MAX_RESLOTS) {
      await io.persist(state);
      throw new TransferError(`Upload links kept expiring before the files could be sent (${state.transfer.reslots} fresh sets). Check the editing service, then retry.`, true);
    }
    await io.persist(state);
  };

  // PUT the open part's unsent files, concurrently, until the tail of the
  // tick or until the part's links are no longer fresh.
  let expiredSaid: string | undefined;
  const send = async (part: TransferPart): Promise<"sent" | "expired" | "stale" | "out_of_time"> => {
    const uploaded = uploadedNames(state.files);
    const todo = part.filenames.filter((fn) => !uploaded.has(fn)).map((fn) => byName.get(fn)).filter((f): f is TransferFile => Boolean(f));
    let i = 0;
    let expired = false;
    expiredSaid = undefined;
    let failure: unknown = null;
    let files = 0;
    let bytes = 0;
    const started = io.now();
    const worker = async () => {
      while (i < todo.length && !expired && !failure && io.now() < io.deadline - TAIL_MS && slotsFresh(part.slotsIssuedAt, io.now())) {
        const f = todo[i++];
        const slot = state.uploads[f.filename];
        if (!slot) {
          expired = true; // the links for this part are gone from the cursor
          return;
        }
        try {
          await io.put(f, { ...slot, filename: f.filename });
        } catch (e) {
          if (isSlotExpired(e)) {
            expired = true;
            expiredSaid = e instanceof Error ? e.message : undefined;
          } else failure = e;
          return;
        }
        f.uploaded = true;
        await io.markUploaded(f);
        files++;
        bytes += f.bytes ?? 0;
        out.sent++;
        await io.lease();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length || 1) }, worker));
    state.transfer = updateRate(state.transfer, files, bytes, io.now() - started);
    if (failure) throw failure;
    if (expired) return "expired";
    const left = part.filenames.some((fn) => !uploadedNames(state.files).has(fn));
    if (!left) return "sent";
    return slotsFresh(part.slotsIssuedAt, io.now()) ? "out_of_time" : "stale";
  };

  for (let guard = 0; guard < 50; guard++) {
    const pending = state.files.filter((f) => !f.uploaded);
    if (!pending.length) break;
    if (io.now() >= io.deadline - TAIL_MS) break;
    const open = openPart(state.parts, uploadedNames(state.files));
    if (open) {
      if (!slotsFresh(open.slotsIssuedAt, io.now())) {
        await abandon(open, "expired");
        continue;
      }
      const r = await send(open);
      if (r === "expired") {
        await abandon(open, "expired early", expiredSaid);
        continue;
      }
      if (r === "stale") continue; // abandoned at the top of the loop
      if (r === "sent") {
        // Commit this part now so processing starts while the rest is sent.
        if (!open.committed) {
          const c = await io.commit(open);
          if (c === "committed") open.committed = true;
        }
        state.uploads = {};
      }
      await io.persist(state);
      if (r === "out_of_time") break;
      continue;
    }
    // No open part: plan the next one, if the tick has room to use it.
    if (io.deadline - io.now() < MIN_TIME_TO_OPEN_PART_MS) break;
    const names = pending.slice(0, planBatchSize(state.transfer, pending.length, io.deadline - TAIL_MS - io.now())).map((f) => f.filename);
    const created = await io.createPart(names);
    const missing = names.filter((n) => !created.uploads[n]);
    if (missing.length) throw new TransferError(`Editing did not return upload links for ${missing.length} file(s): ${missing.slice(0, 3).join(", ")}`, true);
    state.parts = [...state.parts, { photoshootId: created.photoshootId, jobId: created.jobId, filenames: names, slotsIssuedAt: new Date(io.now()).toISOString() }];
    state.uploads = created.uploads;
    out.created++;
    await io.persist(state);
  }

  out.done = state.files.every((f) => f.uploaded);
  if (out.done) {
    // Every part that holds files gets its commit here when it can; a part
    // whose files have not landed yet is retried by the committing step.
    for (const p of state.parts) {
      if (p.abandoned || p.committed) continue;
      const c = await io.commit(p);
      if (c === "committed") p.committed = true;
    }
    state.uploads = {};
    await io.persist(state);
  }
  return out;
}
