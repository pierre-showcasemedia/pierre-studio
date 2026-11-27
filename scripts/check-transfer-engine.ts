// Simulates sending very large shoots to the editing service through
// src/lib/transfer-engine.ts with a fake clock and a fake slot API whose
// presigned links expire 5 minutes after they are issued (as the real one's
// do). No database, no network, no env.
//
//   npx tsx scripts/check-transfer-engine.ts
//
// Ticks run on a minute cron, the clock jumping between them: a 50-second
// budget by default, and in scenario 9 production's timing (a 50-second push
// at submit, then cron runs that work 185 s and hold the shoot's lease, so the
// next run starts on the first minute after one ends). Scenarios:
//   1. 600 raws, slow transfer: finishes, every file sent exactly once, no
//      link expires, every part committed, no part over MAX_BATCH.
//   2. the same with a short first push and the cron silent for seven
//      minutes after it: the open part's links go stale, it is abandoned
//      (never committed) and its files are sent again in a fresh part;
//      nothing else is sent twice.
//   3. a small shoot: one part, one tick.
//   4. a fast link: parts grow with the measured rate.
//   5. a link that dies early (403 mid-part): recovered the same way as 2.
//   6. links that never work: stops with a clear error after MAX_RESLOTS.
//   7. a shoot in flight on the previous code (one upstream shoot, links
//      already issued, some files sent): carries on, nothing re-sent.
//   8. two shoots sharing the cron: 20 s of every tick.
//   9. production timing, 94 raws, ~60 s a PUT (3330 Example Cedar Road, Nov 2026):
//      parts are sized to the run (below 10 files when the link is that slow),
//      no PUT starts on a stale link, and it finishes without stopping. On the
//      engine before Nov 10 2026 it stopped after 5 fresh sets of links.
import { MAX_BATCH, MAX_RESLOTS, SLOT_LIFETIME_MS, TransferError, transferTick, type Slot, type TransferFile, type TransferIo, type TransferPart, type TransferState } from "../src/lib/transfer-engine";

let failures = 0;
let passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
};

const TICK_EVERY_MS = 60_000;

type Upstream = { id: number; jobId: string; names: string[]; issuedAt: number; puts: Set<string>; committed: boolean };

type SimOptions = {
  files: number;
  bytesPerFile?: number;
  msPerFile: number; // wall time one PUT takes
  concurrency?: number;
  // Gaps between ticks, by tick index: a stalled cron.
  gapAfterTick?: Record<number, number>;
  // Make every PUT fail as expired (scenario 6).
  alwaysExpired?: boolean;
  // Kill one part's links early: after this many PUTs into any part, the
  // next PUT into that part answers 403 (scenario 5).
  dieAfterPuts?: number;
  initial?: (files: TransferFile[]) => { parts: TransferPart[]; uploads: Record<string, Slot>; preSent: number };
  maxTicks?: number;
  // The work budget of one tick (50 s by default; less when shoots share it).
  tickBudgetMs?: number;
  // The first tick's budget when it differs (the push at submit).
  firstTickBudgetMs?: number;
};

type SimResult = {
  ticks: number;
  state: TransferState;
  upstream: Upstream[];
  totalPuts: number;
  putLog: { pid: number; filename: string; at: number }[];
  error: unknown;
  persistCount: number;
  leaseCount: number;
  resetCount: number;
};

async function simulate(o: SimOptions): Promise<SimResult> {
  let now = 1_700_000_000_000;
  const concurrency = o.concurrency ?? 3;
  const files: TransferFile[] = Array.from({ length: o.files }, (_, i) => ({ id: `f${i}`, filename: `DSC_${String(i + 1).padStart(4, "0")}.ARW`, bytes: o.bytesPerFile ?? 28_000_000, uploaded: false }));
  const init = o.initial?.(files);
  const state: TransferState = { files, parts: init?.parts ?? [], uploads: init?.uploads ?? {}, transfer: {}, notes: [] };
  // A part handed in by the scenario (a shoot in flight on the previous code)
  // exists upstream already, with the files already sent to it.
  const upstream: Upstream[] = (init?.parts ?? []).map((p) => ({
    id: p.photoshootId,
    jobId: p.jobId,
    names: [...p.filenames],
    issuedAt: Date.parse(p.slotsIssuedAt),
    puts: new Set(files.filter((f) => f.uploaded && p.filenames.includes(f.filename)).map((f) => f.filename)),
    committed: false,
  }));
  const putLog: SimResult["putLog"] = [];
  let nextId = 5_000_001;
  let totalPuts = init?.preSent ?? 0;
  let persistCount = 0;
  let leaseCount = 0;
  let resetCount = 0;
  let deadline = 0;
  const dieCounter = new Map<number, number>();
  // A virtual clock: a PUT waits until its own end time, and the clock jumps
  // to the next PUT to finish once every worker is waiting, so PUTs overlap
  // and a tick runs past its deadline by the PUTs still in flight, as in
  // production.
  const timers: { at: number; done: () => void }[] = [];
  let pumping = false;
  const pump = () => {
    pumping = false;
    timers.sort((x, y) => x.at - y.at);
    const t = timers.shift();
    if (!t) return;
    now = Math.max(now, t.at);
    t.done();
    if (timers.length) {
      pumping = true;
      setImmediate(pump);
    }
  };
  const sleepUntil = (at: number) =>
    new Promise<void>((done) => {
      timers.push({ at, done });
      if (!pumping) {
        pumping = true;
        setImmediate(pump);
      }
    });

  const io: TransferIo = {
    now: () => now,
    get deadline() {
      return deadline;
    },
    concurrency,
    createPart: async (names) => {
      const u: Upstream = { id: nextId++, jobId: `job-${nextId}`, names: [...names], issuedAt: now, puts: new Set(), committed: false };
      upstream.push(u);
      const uploads: Record<string, Slot> = {};
      for (const n of names) uploads[n] = { url: `fake://${u.id}/${n}`, content_type: "image/x-sony-arw" };
      return { photoshootId: u.id, jobId: u.jobId, uploads };
    },
    put: async (file, slot) => {
      const pid = Number(slot.url.split("/")[2]);
      const u = upstream.find((x) => x.id === pid);
      if (!u) throw new Error(`unknown upstream ${pid}`);
      // The real link: 403 once the 5-minute window is over.
      const expired = o.alwaysExpired || now - u.issuedAt > SLOT_LIFETIME_MS;
      if (o.dieAfterPuts !== undefined && pid === upstream[0]?.id) {
        const n = dieCounter.get(pid) ?? 0;
        if (n >= o.dieAfterPuts && !u.committed) throw Object.assign(new Error("Upload link expired before the transfer finished."), { code: "slot_expired", status: 403 });
        dieCounter.set(pid, n + 1);
      }
      if (expired) throw Object.assign(new Error("Upload link expired before the transfer finished."), { code: "slot_expired", status: 403 });
      await sleepUntil(now + o.msPerFile);
      u.puts.add(file.filename);
      putLog.push({ pid, filename: file.filename, at: now });
      totalPuts++;
    },
    commit: async (part) => {
      const u = upstream.find((x) => x.id === part.photoshootId);
      if (!u) throw new Error(`commit of unknown upstream ${part.photoshootId}`);
      const missing = u.names.filter((n) => !u.puts.has(n));
      if (missing.length) throw new Error(`commit with ${missing.length} file(s) not PUT: the engine must never do this`);
      u.committed = true;
      return "committed";
    },
    markUploaded: async () => undefined,
    resetUploaded: async (fs) => {
      resetCount += fs.length;
    },
    persist: async () => {
      persistCount++;
    },
    lease: async () => {
      leaseCount++;
    },
  };

  const start = now;
  let ticks = 0;
  let error: unknown = null;
  const maxTicks = o.maxTicks ?? 400;
  try {
    while (ticks < maxTicks) {
      deadline = now + ((ticks === 0 ? o.firstTickBudgetMs : undefined) ?? o.tickBudgetMs ?? 50_000);
      const tickStart = now;
      const r = await transferTick(state, io);
      ticks++;
      if (r.done) break;
      // The next tick: a minute after this one began, or, when this one ran
      // longer, the first cron minute after it ended (a cron that fires while
      // the lease is still held skips the shoot), plus any stall.
      const next = now < tickStart + TICK_EVERY_MS ? tickStart + TICK_EVERY_MS : start + (Math.floor((now - start) / TICK_EVERY_MS) + 1) * TICK_EVERY_MS;
      now = next + (o.gapAfterTick?.[ticks] ?? 0);
    }
  } catch (e) {
    error = e;
  }
  return { ticks, state, upstream, totalPuts, putLog, error, persistCount, leaseCount, resetCount };
}

function check(name: string, r: SimResult, expect: { resends: number; abandoned: number; allowLarge?: boolean }) {
  const { state, upstream } = r;
  ok(!r.error, `${name}: no error (${r.error instanceof Error ? r.error.message : ""})`);
  ok(state.files.every((f) => f.uploaded), `${name}: every file sent`);
  const live = state.parts.filter((p) => !p.abandoned);
  const abandoned = state.parts.filter((p) => p.abandoned);
  ok(abandoned.length === expect.abandoned, `${name}: ${abandoned.length} abandoned part(s), expected ${expect.abandoned}`);
  ok(live.every((p) => p.committed), `${name}: every live part committed (${live.filter((p) => !p.committed).length} not)`);
  ok(abandoned.every((p) => !upstream.find((u) => u.id === p.photoshootId)?.committed), `${name}: no abandoned part was committed upstream`);
  ok(expect.allowLarge || live.every((p) => p.filenames.length <= MAX_BATCH), `${name}: no part over ${MAX_BATCH} files`);
  const names = live.flatMap((p) => p.filenames);
  ok(new Set(names).size === names.length && names.length === state.files.length, `${name}: every file is in exactly one live part`);
  for (const p of live) {
    const u = upstream.find((x) => x.id === p.photoshootId);
    ok(u && p.filenames.every((n) => u.puts.has(n)), `${name}: part ${p.photoshootId} has every one of its files upstream`);
  }
  ok(r.totalPuts === state.files.length + expect.resends, `${name}: ${r.totalPuts} PUTs for ${state.files.length} files (${expect.resends} re-sent expected)`);
  ok((state.transfer.resent ?? 0) === expect.resends && r.resetCount === expect.resends, `${name}: ${state.transfer.resent ?? 0} files counted as re-sent, ${r.resetCount} reset`);
  // Every PUT landed inside its part's 5-minute window.
  const late = r.putLog.filter((x) => {
    const u = upstream.find((y) => y.id === x.pid)!;
    return x.at - u.issuedAt > SLOT_LIFETIME_MS;
  });
  ok(late.length === 0, `${name}: no PUT after its links expired (${late.length})`);
  ok(r.leaseCount >= r.putLog.length, `${name}: lease refreshed after every file`);
}

async function main() {
  // 1. 600 raws, slow link: ~1.8 s a file end to end.
  const a = await simulate({ files: 600, msPerFile: 1800 });
  check("600 slow", a, { resends: 0, abandoned: 0 });
  ok(a.ticks > 3 && a.ticks < 60, `600 slow: ${a.ticks} ticks`);
  console.log(`1. 600 raws, slow: ${a.ticks} ticks, ${a.state.parts.length} parts (${a.state.parts.map((p) => p.filenames.length).join(", ")}), rate ${(a.state.transfer.filesPerSec ?? 0).toFixed(2)} files/s`);

  // 2. a short first push (20 s) ends with the first part open, then the cron
  //    goes quiet for seven minutes.
  const b = await simulate({ files: 600, msPerFile: 1800, firstTickBudgetMs: 20_000, gapAfterTick: { 1: 7 * 60_000 } });
  const lost = b.state.parts.find((p) => p.abandoned);
  const lostSent = lost ? b.putLog.filter((x) => x.pid === lost.photoshootId).length : 0;
  check("600 stalled", b, { resends: lostSent, abandoned: 1 });
  ok(lost && lostSent > 0 && lostSent < lost.filenames.length, `600 stalled: the abandoned part had ${lostSent} of ${lost?.filenames.length ?? 0} files sent`);
  ok(b.state.notes.some((n) => n.includes("sent again with fresh links")), "600 stalled: the shoot carries a note about the re-send");
  console.log(`2. 600 raws, cron stalled 7 min: ${b.ticks} ticks, ${b.state.parts.length} parts, ${lostSent} files re-sent once, note: "${b.state.notes[0]}"`);

  // 3. a small shoot is one part in one tick.
  const c = await simulate({ files: 40, msPerFile: 300 });
  check("40 small", c, { resends: 0, abandoned: 0 });
  ok(c.state.parts.length === 1 && c.ticks === 1, `40 small: one part (${c.state.parts.length}) in one tick (${c.ticks})`);
  console.log(`3. 40 raws: ${c.state.parts.length} part, ${c.ticks} tick`);

  // 4. a fast link: later parts are larger than the first.
  const d = await simulate({ files: 600, msPerFile: 450 });
  check("600 fast", d, { resends: 0, abandoned: 0 });
  const sizes = d.state.parts.map((p) => p.filenames.length);
  ok(Math.max(...sizes.slice(1)) > sizes[0], `600 fast: parts grow with the measured rate (${sizes.join(", ")})`);
  console.log(`4. 600 raws, fast: ${d.ticks} ticks, parts ${sizes.join(", ")}`);

  // 5. links that die early: 403 after 12 PUTs into a part.
  const e = await simulate({ files: 120, msPerFile: 1200, dieAfterPuts: 12 });
  const dead = e.state.parts.filter((p) => p.abandoned);
  const resent = dead.reduce((n, p) => n + e.putLog.filter((x) => x.pid === p.photoshootId).length, 0);
  check("120 dying links", e, { resends: resent, abandoned: dead.length });
  ok(dead.length >= 1 && dead.length <= MAX_RESLOTS, `120 dying links: ${dead.length} part(s) abandoned and recovered`);
  console.log(`5. 120 raws, a link dies after 12 PUTs: ${e.ticks} ticks, ${dead.length} abandoned, ${resent} re-sent, done`);

  // 6. links that never work: a clear stop, never a silent loop.
  const f = await simulate({ files: 60, msPerFile: 1000, alwaysExpired: true });
  ok(f.error instanceof TransferError && (f.error as TransferError).resetToUploaded, `never works: stops with TransferError (${f.error instanceof Error ? f.error.message : "none"})`);
  ok(f.state.parts.filter((p) => p.abandoned).length === MAX_RESLOTS + 1, `never works: gave up after ${MAX_RESLOTS + 1} sets of links`);
  ok(!f.state.parts.some((p) => p.committed), "never works: nothing committed");
  console.log(`6. links never work: "${f.error instanceof Error ? f.error.message : ""}"`);

  // 7. in flight on the previous code: one upstream shoot, links issued 30 s
  //    ago, 50 of 120 files already sent. It carries on and re-sends nothing.
  const g = await simulate({
    files: 120,
    msPerFile: 600,
    initial: (files) => {
      for (const x of files.slice(0, 50)) x.uploaded = true;
      const uploads: Record<string, Slot> = {};
      for (const x of files) uploads[x.filename] = { url: `fake://4000001/${x.filename}`, content_type: "image/x-sony-arw" };
      return { parts: [{ photoshootId: 4000001, jobId: "legacy-job", filenames: files.map((x) => x.filename), slotsIssuedAt: new Date(1_700_000_000_000 - 30_000).toISOString() }], uploads, preSent: 50 };
    },
  });
  check("legacy in flight", g, { resends: 0, abandoned: 0, allowLarge: true });
  ok(g.state.parts.length === 1 && g.ticks === 1 && g.totalPuts === 120, `legacy in flight: the one upstream shoot carried on in one tick (${g.state.parts.length} part, ${g.ticks} tick, ${g.totalPuts} PUTs in all)`);
  console.log(`7. legacy shoot in flight: carried on, ${g.totalPuts - 50} files sent in ${g.ticks} tick, nothing re-sent`);

  // 8. two shoots sharing the cron: this one gets 20 s of every tick.
  const h = await simulate({ files: 600, msPerFile: 1800, tickBudgetMs: 20_000 });
  check("600 shared tick", h, { resends: 0, abandoned: 0 });
  console.log(`8. 600 raws with 20 s ticks: ${h.ticks} ticks, parts ${h.state.parts.map((p) => p.filenames.length).join(", ")}`);

  // 9. production timing: a 50 s push at submit, then 185 s cron runs, 94 raws
  //    on a slow link (~60 s a PUT, 3 at a time). Only the first part, sized
  //    before any rate is known, may be abandoned; every later part is sized
  //    to finish inside the run that opens it.
  const k = await simulate({ files: 94, msPerFile: 60_000, firstTickBudgetMs: 50_000, tickBudgetMs: 185_000 });
  const kDead = k.state.parts.filter((p) => p.abandoned);
  const kResent = kDead.reduce((n, p) => n + k.putLog.filter((x) => x.pid === p.photoshootId).length, 0);
  check("94 slow, production timing", k, { resends: kResent, abandoned: kDead.length, allowLarge: false });
  ok(kDead.length <= 1 && kDead.every((p) => p === k.state.parts[0]), `94 slow, production timing: only the first part may be abandoned (${kDead.length})`);
  const kLive = k.state.parts.filter((p) => !p.abandoned).map((p) => p.filenames.length);
  ok(Math.min(...kLive) < 10, `94 slow, production timing: parts go below 10 files on a slow link (${kLive.join(", ")})`);
  const kMinutes = Math.round(((k.putLog.at(-1)?.at ?? 1_700_000_000_000) - 1_700_000_000_000) / 60_000);
  console.log(`9. 94 raws, ~60 s a PUT, 185 s runs: ${k.error ? "stopped" : "done"} after ${k.ticks} runs (~${kMinutes} min), parts ${k.state.parts.map((p) => `${p.filenames.length}${p.abandoned ? "x" : ""}`).join(", ")}, ${kResent} re-sent`);

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
