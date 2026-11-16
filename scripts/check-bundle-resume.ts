// Checks for the "Download all" rebuild that carries on across runs (Nov 10
// 2026). No database, no network, no real storage: a fake bucket answers the
// zip writer (multipart uploads, ranged reads, versions), a fake clock ends
// each run, and the cursor goes through JSON between runs as it does on the
// job row. Refuses to run with DATABASE_URL set.
//
//   npx tsx scripts/check-bundle-resume.ts
//
// 1. The bytes: the writer's zip is the same, byte for byte, as the one
//    archiver wrote for these zips before (folders, a UTF-8 name, an empty
//    file, a file missing from storage, no files at all).
// 2. Carrying on: a run that ends after every single part, at every part
//    size from 1 byte up (so a run stops inside a header, a file, a
//    descriptor, the directory), still ends with the same zip, and no part
//    is ever sent twice. A run with no time left changes nothing.
// 3. Things going wrong: a read that fails or ends early is asked for again
//    from where it stopped; one that keeps failing fails the run with its
//    place saved; a part that fails likewise; parts confirmed out of order
//    never leave a gap behind the cursor.
// 4. Starting over instead of landing something wrong: a file replaced or
//    removed under a zip in flight, an upload that is gone, parts that do not
//    add up.
// 5. Never landing when it must not: a run that lost the job (save says no),
//    a newer rebuild that has begun (mayLand says no).
// 6. ZIP64 (sizes and offsets past 4 GB, tried here with the limit lowered),
//    and the zips opened by unzip, Python and ditto where they are installed.
// 7. The plan: which zips, in which order, and the same plan from the list
//    kept on the job whatever order the rows came back in.
// 8. A whole rebuild (several zips) across many runs; stale and lost.
// 9. Whose turn it is: one rebuild per listing at a time, the newer one wins.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { ZipArchive } from "archiver";
import type { BundleProgress, BundleStore } from "../src/lib/bundles";
import type { RebuildRow } from "../src/lib/bundle-jobs";
import type { ZipCursor, ZipFile, ZipIo, ZipOutcome, ZipSource } from "../src/lib/zip-resume";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
  process.exit(2);
}

let failures = 0;
let passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && sha(a) === sha(b);
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// Bytes that are not all alike, different per seed.
function bytes(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

// ---- A fake bucket -----------------------------------------------------------------

type Knobs = {
  chunk: number; // bytes per read chunk
  readFails: Map<string, { after: number; times: number; quiet?: boolean }>; // a read of this key breaks at byte `after` of the file (quiet: it just ends)
  tailFails: Set<string>; // a read of this key delivers every byte, then errors (storage's whole-file check failed)
  partFails: Map<number, number>; // part number → how many times it fails
  latency: boolean; // parts take a random moment, so they confirm out of order
};
class FakeBucket {
  objects = new Map<string, { bytes: Buffer; etag: string }>();
  uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  counts = { begin: 0, parts: 0, partBytes: 0, finish: 0, abort: 0, open: 0, rangedOpens: 0 };
  sent: number[] = [];
  knobs: Knobs = { chunk: 1000, readFails: new Map(), tailFails: new Set(), partFails: new Map(), latency: false };
  onPart: (() => void) | null = null;
  private seq = 0;
  private gone: { new (m?: string): Error };
  private changed: { new (m?: string): Error };
  constructor(errors: { gone: { new (m?: string): Error }; changed: { new (m?: string): Error } }) {
    this.gone = errors.gone;
    this.changed = errors.changed;
  }
  put(key: string, b: Buffer) {
    this.objects.set(key, { bytes: b, etag: `"v${++this.seq}"` });
  }
  store(): BundleStore {
    return {
      begin: async (key) => {
        this.counts.begin++;
        const id = `up-${++this.seq}`;
        this.uploads.set(id, { key, parts: new Map() });
        return id;
      },
      putPart: async (key, uploadId, n, body) => {
        if (this.knobs.latency) await new Promise((r) => setTimeout(r, Math.random() * 4));
        const up = this.uploads.get(uploadId);
        if (!up || up.key !== key) throw new this.gone();
        const left = this.knobs.partFails.get(n) ?? 0;
        if (left > 0) {
          this.knobs.partFails.set(n, left - 1);
          throw new Error(`storage refused part ${n}`);
        }
        up.parts.set(n, Buffer.from(body)); // a copy: the writer uses its buffers again
        this.counts.parts++;
        this.counts.partBytes += body.length;
        this.sent.push(n);
        this.onPart?.();
      },
      finish: async (key, uploadId, parts, total) => {
        const up = this.uploads.get(uploadId);
        if (!up || up.key !== key) throw new this.gone();
        const list: Buffer[] = [];
        for (let n = 1; n <= parts; n++) {
          const p = up.parts.get(n);
          if (!p) throw new this.gone(`part ${n} is missing`);
          list.push(p);
        }
        // R2's rule: every part but the last has the same size.
        if (list.slice(0, -1).some((p) => p.length !== list[0].length)) throw new Error("fake bucket: parts of different sizes");
        const whole = Buffer.concat(list);
        if (whole.length !== total) throw new this.gone("the parts do not add up");
        this.counts.finish++;
        this.uploads.delete(uploadId);
        this.put(key, whole);
      },
      abort: async (_key, uploadId) => {
        this.counts.abort++;
        this.uploads.delete(uploadId);
      },
      open: async (key, from, etag) => {
        this.counts.open++;
        if (from > 0) this.counts.rangedOpens++;
        const o = this.objects.get(key);
        if (!o) return null;
        if (etag && etag !== o.etag) throw new this.changed();
        const knobs = this.knobs;
        const fail = knobs.readFails.get(key);
        let closed = false;
        async function* read(): AsyncGenerator<Uint8Array> {
          for (let at = from; at < o!.bytes.length; at += knobs.chunk) {
            if (closed) return;
            if (fail && fail.times > 0 && at >= fail.after) {
              fail.times--;
              if (fail.quiet) return;
              throw new Error("connection reset");
            }
            yield o!.bytes.subarray(at, Math.min(o!.bytes.length, at + knobs.chunk));
          }
          if (knobs.tailFails.has(key)) throw new Error("checksum mismatch");
        }
        const src: ZipSource = { body: read(), size: o.bytes.length, etag: o.etag, close: () => void (closed = true) };
        return src;
      },
    };
  }
}

// ---- A zip reader, for the checks -------------------------------------------------

function readZip(z: Buffer): { names: string[]; files: Map<string, Buffer>; zip64: boolean } {
  let e = z.length - 22;
  while (e >= 0 && z.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("no end record");
  let count = z.readUInt16LE(e + 10);
  let cdOffset = z.readUInt32LE(e + 16);
  let zip64 = false;
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = e - 20;
    if (z.readUInt32LE(loc) !== 0x07064b50) throw new Error("no zip64 locator");
    const rec = Number(z.readBigUInt64LE(loc + 8));
    if (z.readUInt32LE(rec) !== 0x06064b50) throw new Error("no zip64 end record");
    count = Number(z.readBigUInt64LE(rec + 32));
    cdOffset = Number(z.readBigUInt64LE(rec + 48));
    zip64 = true;
  }
  const names: string[] = [];
  const files = new Map<string, Buffer>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (z.readUInt32LE(p) !== 0x02014b50) throw new Error(`entry ${i}: no central header`);
    const crc = z.readUInt32LE(p + 16);
    let size = z.readUInt32LE(p + 24);
    const nameLen = z.readUInt16LE(p + 28);
    const extraLen = z.readUInt16LE(p + 30);
    let offset = z.readUInt32LE(p + 42);
    const name = z.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (size === 0xffffffff || offset === 0xffffffff) {
      const x = p + 46 + nameLen;
      if (z.readUInt16LE(x) !== 1) throw new Error(`${name}: no zip64 field`);
      size = Number(z.readBigUInt64LE(x + 4));
      offset = Number(z.readBigUInt64LE(x + 20));
      zip64 = true;
    }
    if (z.readUInt32LE(offset) !== 0x04034b50) throw new Error(`${name}: no local header at ${offset}`);
    const dataAt = offset + 30 + z.readUInt16LE(offset + 26) + z.readUInt16LE(offset + 28);
    const data = z.subarray(dataAt, dataAt + size);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC does not match`);
    names.push(name);
    files.set(name, Buffer.from(data));
    p += 46 + nameLen + extraLen + z.readUInt16LE(p + 32);
  }
  return { names, files, zip64 };
}

// The zip archiver made for the same files: streams appended to a store-only archive, as the rebuild did before.
async function archiverZip(files: { name: string; bytes: Buffer }[], date: Date): Promise<Buffer> {
  const zip = new ZipArchive({ store: true });
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  const ended = new Promise<void>((resolve, reject) => {
    out.on("end", () => resolve());
    zip.on("error", reject);
  });
  zip.pipe(out);
  for (const f of files) zip.append(Readable.from(f.bytes.length ? [f.bytes] : []), { name: f.name, date });
  await zip.finalize();
  await ended;
  return Buffer.concat(chunks);
}

async function main() {
  const { writeZip, ZipUploadGone, ZipSourceChanged, ZIP_PART_BYTES } = await import("../src/lib/zip-resume");
  const { planBundles, freezeMedia, thawMedia, buildZips } = await import("../src/lib/bundles");
  const { rebuildTurn } = await import("../src/lib/bundle-jobs");
  const errors = { gone: ZipUploadGone, changed: ZipSourceChanged };
  const date = new Date("2026-11-10T18:30:44Z");
  const KEY = "listings/demo/bundles/photos-full.zip";

  // The writer's io on a fake bucket, with a clock that moves one tick per part sent.
  type Rig = { bucket: FakeBucket; io: ZipIo; clock: { t: number }; saves: ZipCursor[]; allow: { save: boolean; land: boolean } };
  const rig = (bucket = new FakeBucket(errors)): Rig => {
    const clock = { t: 0 };
    const saves: ZipCursor[] = [];
    const allow = { save: true, land: true };
    const s = bucket.store();
    bucket.onPart = () => void clock.t++;
    const io: ZipIo = {
      begin: () => s.begin(KEY),
      putPart: (id, n, body) => s.putPart(KEY, id, n, body),
      finish: (id, parts, total) => s.finish(KEY, id, parts, total),
      open: s.open,
      now: () => clock.t,
      save: async (c) => {
        if (!allow.save) return false;
        saves.push(viaJson(c));
        return true;
      },
      mayLand: async () => allow.land,
    };
    return { bucket, io, clock, saves, allow };
  };
  const load = (bucket: FakeBucket, files: { name: string; bytes: Buffer | null }[]): ZipFile[] =>
    files.map((f, i) => {
      const key = `listings/demo/originals/${i}-${f.name.replace(/[^a-z0-9.]+/gi, "_")}`;
      if (f.bytes) bucket.put(key, f.bytes);
      return { key, name: f.name };
    });
  // Run after run until the zip is done, each run allowed `partsPerRun` parts.
  const runs = async (r: Rig, files: ZipFile[], opts: { partBytes: number; partsPerRun: number; uploads?: number; zip64At?: number; max?: number }): Promise<{ out: ZipOutcome; n: number }> => {
    let cursor: ZipCursor | null = null;
    for (let n = 1; n <= (opts.max ?? 100_000); n++) {
      const out = await writeZip(r.io, files, { cursor, stopAt: r.clock.t + opts.partsPerRun, date, partBytes: opts.partBytes, uploads: opts.uploads ?? 1, saveEveryMs: 0, zip64At: opts.zip64At });
      if (out.state !== "paused") return { out, n };
      cursor = viaJson(out.cursor);
    }
    throw new Error("the zip never finished");
  };

  // ---- 1. the bytes -----------------------------------------------------------------
  {
    const sets: { what: string; files: { name: string; bytes: Buffer | null }[] }[] = [
      { what: "photos at the top level", files: [{ name: "01-front.jpg", bytes: bytes(5000, 1) }, { name: "02-kitchen.jpg", bytes: bytes(12345, 2) }, { name: "03-yard.jpg", bytes: bytes(1, 3) }] },
      { what: "folders, a film, a UTF-8 name, an empty file", files: [{ name: "Photos/01.jpg", bytes: bytes(3000, 4) }, { name: "Floor Plans/Plan – été.jpg", bytes: bytes(2222, 5) }, { name: "Films/film.mp4", bytes: bytes(70_000, 6) }, { name: "Photos/empty.jpg", bytes: Buffer.alloc(0) }] },
      { what: "a file missing from storage is left out", files: [{ name: "a.jpg", bytes: bytes(400, 7) }, { name: "gone.jpg", bytes: null }, { name: "b.jpg", bytes: bytes(600, 8) }] },
      { what: "no files at all", files: [] },
    ];
    for (const set of sets) {
      const r = rig();
      const files = load(r.bucket, set.files);
      const out = await writeZip(r.io, files, { cursor: null, stopAt: Infinity, date });
      const mine = r.bucket.objects.get(KEY)?.bytes ?? Buffer.alloc(0);
      const theirs = await archiverZip(set.files.filter((f): f is { name: string; bytes: Buffer } => f.bytes !== null), date);
      ok(out.state === "done", `${set.what}: the zip is written`);
      ok(same(mine, theirs), `${set.what}: byte for byte the zip archiver wrote (${mine.length} vs ${theirs.length} bytes)`);
      const present = set.files.filter((f) => f.bytes !== null);
      ok(out.state === "done" && out.files === present.length && out.bytes === mine.length, `${set.what}: the counts are right`);
      const z = readZip(mine);
      ok(z.names.join("|") === present.map((f) => f.name).join("|") && present.every((f) => same(z.files.get(f.name)!, f.bytes!)), `${set.what}: every file reads back intact, in order`);
      ok(r.bucket.uploads.size === 0, `${set.what}: no upload left open`);
    }
    ok(ZIP_PART_BYTES === 16 * 1024 * 1024, "parts are 16 MB");
  }
  console.log("1. the bytes: ok");

  // ---- 2. carrying on ---------------------------------------------------------------
  {
    const small = [{ name: "Photos/a.jpg", bytes: bytes(41, 11) }, { name: "Photos/é.jpg", bytes: Buffer.alloc(0) }, { name: "Films/b.mp4", bytes: bytes(97, 12) }, { name: "missing.jpg", bytes: null }, { name: "c.jpg", bytes: bytes(3, 13) }];
    const want = await archiverZip(small.filter((f): f is { name: string; bytes: Buffer } => f.bytes !== null), date);
    for (const partBytes of [1, 2, 3, 5, 7, 16, 30, 46, 64, 1000]) {
      const r = rig();
      r.bucket.knobs.chunk = 10;
      const files = load(r.bucket, small);
      const { out, n } = await runs(r, files, { partBytes, partsPerRun: 1 });
      const got = r.bucket.objects.get(KEY)?.bytes ?? Buffer.alloc(0);
      const parts = Math.ceil(want.length / partBytes);
      ok(out.state === "done" && same(got, want), `parts of ${partBytes} B, one part a run: the same zip after ${n} runs`);
      ok(r.bucket.counts.parts === parts && r.bucket.counts.partBytes === want.length, `parts of ${partBytes} B: every part sent exactly once (${r.bucket.counts.parts} of ${parts})`);
      ok(partBytes >= want.length || n >= parts - 1, `parts of ${partBytes} B: it really did stop after every part (${n} runs)`);
      ok(r.bucket.counts.begin === 1 && r.bucket.counts.finish === 1, `parts of ${partBytes} B: one upload, landed once`);
    }
    // A bigger set, a few parts a run, parts in flight three at a time.
    const big = [{ name: "01.jpg", bytes: bytes(50_000, 21) }, { name: "02.jpg", bytes: bytes(1, 22) }, { name: "Film/film.mp4", bytes: bytes(300_000, 23) }, { name: "03.jpg", bytes: bytes(77_777, 24) }];
    const wantBig = await archiverZip(big as { name: string; bytes: Buffer }[], date);
    const r = rig();
    r.bucket.knobs.chunk = 4096;
    r.bucket.knobs.latency = true;
    const files = load(r.bucket, big);
    let cursor: ZipCursor | null = null;
    let gaps = 0;
    let n = 0;
    for (;;) {
      n++;
      const out = await writeZip(r.io, files, { cursor, stopAt: r.clock.t + 5, date, partBytes: 8192, uploads: 3, saveEveryMs: 0 });
      if (out.state !== "paused") {
        ok(out.state === "done", "three parts in flight: the zip is written");
        break;
      }
      cursor = viaJson(out.cursor);
      const up = r.bucket.uploads.get(cursor.uploadId);
      for (let p = 1; p <= cursor.parts; p++) if (!up?.parts.has(p)) gaps++;
      if (n > 1000) throw new Error("never finished");
    }
    ok(gaps === 0, "three parts in flight: every part up to the cursor is in storage at each stop");
    ok(same(r.bucket.objects.get(KEY)!.bytes, wantBig), `three parts in flight: the same zip after ${n} runs`);
    ok(r.saves.every((c, i) => i === 0 || c.parts >= r.saves[i - 1].parts || c.uploadId !== r.saves[i - 1].uploadId), "the saved cursor never goes backwards");

    // No time left: nothing is sent, the cursor is unchanged.
    const idle = rig();
    const idleFiles = load(idle.bucket, big);
    const first = await writeZip(idle.io, idleFiles, { cursor: null, stopAt: idle.clock.t + 2, date, partBytes: 8192, uploads: 1 });
    const before = idle.bucket.counts.parts;
    const again = first.state === "paused" ? await writeZip(idle.io, idleFiles, { cursor: viaJson(first.cursor), stopAt: idle.clock.t, date, partBytes: 8192, uploads: 1 }) : null;
    ok(first.state === "paused" && again?.state === "paused" && idle.bucket.counts.parts === before && JSON.stringify(again.cursor) === JSON.stringify(first.cursor), "a run with no time left sends nothing and keeps its place");
    ok(idle.bucket.objects.get(KEY) === undefined, "nothing lands before the zip is whole");
  }
  console.log("2. carrying on: ok");

  // ---- 3. things going wrong ---------------------------------------------------------
  {
    const set = [{ name: "a.jpg", bytes: bytes(20_000, 31) }, { name: "b.jpg", bytes: bytes(30_000, 32) }, { name: "c.jpg", bytes: bytes(10_000, 33) }];
    const want = await archiverZip(set, date);
    for (const quiet of [false, true]) {
      const r = rig();
      const files = load(r.bucket, set);
      r.bucket.knobs.readFails.set(files[1].key, { after: 7000, times: 2, quiet });
      const { out } = await runs(r, files, { partBytes: 4096, partsPerRun: 1000 });
      ok(out.state === "done" && same(r.bucket.objects.get(KEY)!.bytes, want), `a read that ${quiet ? "ends early" : "breaks"} twice: the zip is still right`);
      ok(r.bucket.counts.rangedOpens >= 2, `a read that ${quiet ? "ends early" : "breaks"}: asked for again from where it stopped, not from the start`);
    }
    // A read that keeps failing fails the run, with its place saved; a later run finishes.
    const r = rig();
    const files = load(r.bucket, set);
    r.bucket.knobs.readFails.set(files[1].key, { after: 9000, times: 99 });
    let threw: unknown = null;
    try {
      await writeZip(r.io, files, { cursor: null, stopAt: Infinity, date, partBytes: 4096, uploads: 1, saveEveryMs: 1e9 });
    } catch (e) {
      threw = e;
    }
    const kept = r.saves[r.saves.length - 1];
    ok(threw instanceof Error && /reset/.test(threw.message), "a read that keeps failing fails the run (the job retries with backoff)");
    ok(kept && kept.parts === 7 && kept.i === 1 && kept.at > 0, `its place is saved on the way out (${kept?.parts} parts, inside the second file)`);
    ok(r.bucket.counts.open <= 3 + 4 + 4, `after four tries that brought nothing (${r.bucket.counts.open} reads asked for in all)`);
    r.bucket.knobs.readFails.clear();
    const sentBefore = r.bucket.counts.parts;
    const resumed = await writeZip(r.io, files, { cursor: viaJson(kept), stopAt: Infinity, date, partBytes: 4096, uploads: 1 });
    ok(resumed.state === "done" && same(r.bucket.objects.get(KEY)!.bytes, want), "the next run carries on from there to the same zip");
    ok(r.bucket.counts.parts - sentBefore === Math.ceil(want.length / 4096) - kept.parts, "and sends only the parts that were missing");

    // A part that storage refuses.
    const p = rig();
    const pFiles = load(p.bucket, set);
    p.bucket.knobs.partFails.set(4, 1);
    let partErr: unknown = null;
    try {
      await writeZip(p.io, pFiles, { cursor: null, stopAt: Infinity, date, partBytes: 4096, uploads: 1, saveEveryMs: 1e9 });
    } catch (e) {
      partErr = e;
    }
    const pKept = p.saves[p.saves.length - 1];
    ok(partErr instanceof Error && /refused part 4/.test(partErr.message) && pKept?.parts === 3, "a part storage refuses fails the run with the three parts before it on record");
    const pDone = await writeZip(p.io, pFiles, { cursor: viaJson(pKept), stopAt: Infinity, date, partBytes: 4096, uploads: 1 });
    ok(pDone.state === "done" && same(p.bucket.objects.get(KEY)!.bytes, want), "and the next run finishes the same zip");
  }
  console.log("3. things going wrong: ok");

  // ---- 4. starting over ---------------------------------------------------------------
  {
    const set = [{ name: "a.jpg", bytes: bytes(20_000, 41) }, { name: "b.jpg", bytes: bytes(30_000, 42) }, { name: "c.jpg", bytes: bytes(10_000, 43) }];
    const stopInB = async () => {
      const r = rig();
      const files = load(r.bucket, set);
      const first = await writeZip(r.io, files, { cursor: null, stopAt: r.clock.t + 7, date, partBytes: 4096, uploads: 1 });
      if (first.state !== "paused" || first.cursor.i !== 1 || first.cursor.at === 0) throw new Error("the fixture did not stop inside the second file");
      return { r, files, cursor: viaJson(first.cursor) };
    };
    // The file being written is replaced: never half of one and half of the other.
    {
      const { r, files, cursor } = await stopInB();
      const replacement = bytes(30_000, 99);
      r.bucket.put(files[1].key, replacement);
      const out = await writeZip(r.io, files, { cursor, stopAt: Infinity, date, partBytes: 4096, uploads: 1 });
      ok(out.state === "restart", "a file replaced under a zip in flight: that zip starts over");
      ok(r.bucket.objects.get(KEY) === undefined, "and nothing lands from the half-written one");
      const fresh = await writeZip(r.io, files, { cursor: null, stopAt: Infinity, date, partBytes: 4096, uploads: 1 });
      const z = readZip(r.bucket.objects.get(KEY)!.bytes);
      ok(fresh.state === "done" && same(z.files.get("b.jpg")!, replacement), "the fresh zip has the new file, whole");
    }
    // The file being written leaves storage.
    {
      const { r, files, cursor } = await stopInB();
      r.bucket.objects.delete(files[1].key);
      const out = await writeZip(r.io, files, { cursor, stopAt: Infinity, date, partBytes: 4096, uploads: 1 });
      ok(out.state === "restart" && r.bucket.objects.get(KEY) === undefined, "a file removed under a zip in flight: that zip starts over");
    }
    // Every byte of a file arrives, then storage says the whole file failed its check.
    {
      const r = rig();
      const files = load(r.bucket, set);
      r.bucket.knobs.tailFails.add(files[2].key);
      const out = await writeZip(r.io, files, { cursor: null, stopAt: Infinity, date, partBytes: 4096, uploads: 1 });
      ok(out.state === "restart" && r.bucket.objects.get(KEY) === undefined, "a file that does not read back clean: nothing lands, that zip starts over");
    }
    // The upload is gone.
    {
      const { r, files, cursor } = await stopInB();
      r.bucket.uploads.delete(cursor.uploadId);
      const out = await writeZip(r.io, files, { cursor, stopAt: Infinity, date, partBytes: 4096, uploads: 1 });
      ok(out.state === "restart" && out.uploadId === cursor.uploadId, "an upload that is gone: that zip starts over");
    }
    // A part is missing when the zip would land.
    {
      const { r, files, cursor } = await stopInB();
      r.bucket.uploads.get(cursor.uploadId)!.parts.delete(2);
      const out = await writeZip(r.io, files, { cursor, stopAt: Infinity, date, partBytes: 4096, uploads: 1 });
      ok(out.state === "restart" && r.bucket.objects.get(KEY) === undefined, "parts that do not add up: nothing lands, that zip starts over");
    }
  }
  console.log("4. starting over: ok");

  // ---- 5. never landing when it must not -----------------------------------------------
  {
    const set = [{ name: "a.jpg", bytes: bytes(20_000, 51) }, { name: "b.jpg", bytes: bytes(9_000, 52) }];
    const previous = Buffer.from("the zip a newer rebuild landed");
    // Lost at the first save: not a byte is sent.
    {
      const r = rig();
      r.bucket.put(KEY, previous);
      r.allow.save = false;
      const out = await writeZip(r.io, load(r.bucket, set), { cursor: null, stopAt: Infinity, date, partBytes: 4096, uploads: 1 });
      ok(out.state === "lost" && r.bucket.counts.parts === 0 && r.bucket.counts.finish === 0, "a run that does not hold the job sends nothing");
    }
    // Lost on the way: stops, never lands.
    {
      const r = rig();
      r.bucket.put(KEY, previous);
      const files = load(r.bucket, set);
      r.bucket.onPart = () => {
        r.clock.t++;
        if (r.bucket.counts.parts === 3) r.allow.save = false;
      };
      const out = await writeZip(r.io, files, { cursor: null, stopAt: Infinity, date, partBytes: 4096, uploads: 1, saveEveryMs: 0 });
      ok(out.state === "lost" && r.bucket.counts.finish === 0 && same(r.bucket.objects.get(KEY)!.bytes, previous), "a run that loses the job midway stops and lands nothing");
      ok(r.bucket.counts.parts <= 4, `it stops at the next checkpoint (${r.bucket.counts.parts} parts sent)`);
    }
    // A newer rebuild has begun: every part is there, and still it does not land.
    {
      const r = rig();
      r.bucket.put(KEY, previous);
      r.allow.land = false;
      const out = await writeZip(r.io, load(r.bucket, set), { cursor: null, stopAt: Infinity, date, partBytes: 4096, uploads: 1 });
      ok(out.state === "stale" && r.bucket.counts.finish === 0 && same(r.bucket.objects.get(KEY)!.bytes, previous), "an older rebuild never lands on top of a newer one");
    }
  }
  console.log("5. never landing when it must not: ok");

  // ---- 6. ZIP64 and other readers --------------------------------------------------------
  {
    const set = [{ name: "Photos/a.jpg", bytes: bytes(900, 61) }, { name: "Films/film one.mp4", bytes: bytes(50_000, 62) }, { name: "Photos/b.jpg", bytes: bytes(2_000, 63) }, { name: "Photos/é.jpg", bytes: bytes(10, 64) }];
    const r = rig();
    const files = load(r.bucket, set);
    // The limit lowered to 1000 bytes: the film, b.jpg and every offset past the first file need the wide fields.
    const { out } = await runs(r, files, { partBytes: 777, partsPerRun: 3, zip64At: 1000 });
    const wide = r.bucket.objects.get(KEY)!.bytes;
    const z = readZip(wide);
    ok(out.state === "done" && z.zip64, "past the limit the zip uses the ZIP64 records");
    ok(set.every((f) => same(z.files.get(f.name)!, f.bytes)), "and every file reads back intact through them");

    const plain = rig();
    await writeZip(plain.io, load(plain.bucket, set), { cursor: null, stopAt: Infinity, date });
    const dir = mkdtempSync(join(tmpdir(), "studio-zip-check-"));
    try {
      const paths = { plain: join(dir, "plain.zip"), wide: join(dir, "wide.zip") };
      writeFileSync(paths.plain, plain.bucket.objects.get(KEY)!.bytes);
      writeFileSync(paths.wide, wide);
      const tool = (cmd: string, args: string[]): string | null => {
        try {
          return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
          const err = e as { code?: string; stdout?: string; stderr?: string };
          if (err.code === "ENOENT") return null;
          return `FAILED ${err.stdout ?? ""} ${err.stderr ?? ""}`;
        }
      };
      for (const [which, path] of Object.entries(paths)) {
        const u = tool("unzip", ["-tq", path]);
        if (u === null) console.log("   (unzip is not installed: skipped)");
        else ok(/No errors detected/.test(u), `unzip tests the ${which} zip clean`);
        const py = tool("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); print('bad' if bad else 'fine', len(z.namelist()))", path]);
        if (py === null) console.log("   (python3 is not installed: skipped)");
        else ok(py.trim() === `fine ${set.length}`, `Python opens the ${which} zip and every CRC holds`);
      }
      const outDir = join(dir, "out");
      const d = tool("ditto", ["-x", "-k", paths.plain, outDir]);
      if (d === null) console.log("   (ditto is not installed: skipped)");
      else ok(!d.startsWith("FAILED") && set.every((f) => same(readFileSync(join(outDir, f.name)), f.bytes)), "ditto (what Finder uses) unpacks the zip, folders and names intact");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log("6. ZIP64 and other readers: ok");

  // ---- 7. the plan ------------------------------------------------------------------------
  type Row = { r2Key: string; filename: string; kind: string; revision: boolean; section: string | null; sort: number; createdAt: Date };
  const row = (i: number, over: Partial<Row> = {}): Row => ({ r2Key: `listings/demo/originals/${i}.jpg`, filename: `${String(i).padStart(2, "0")}.jpg`, kind: "photo", revision: false, section: null, sort: i, createdAt: new Date(2026, 10, 1, 0, 0, i), ...over });
  const mixed: Row[] = [row(1), row(2), row(3, { revision: true }), row(4, { section: "Floor Plans" }), row(5, { section: "Twilight" }), row(6, { kind: "video", filename: "film.mp4", r2Key: "listings/demo/originals/film.mp4", section: "Film" }), row(7, { kind: "video", filename: "reel.mp4", r2Key: "listings/demo/originals/reel.mp4" })];
  {
    const only = planBundles("demo", [row(2), row(1)]);
    ok(only.zips.map((z) => z.key.split("/").pop()).join(",") === "photos-mls.zip,photos-full.zip", "main photos only: the MLS zip, then the full zip");
    ok(only.zips[1].files.map((f) => f.name).join(",") === "01.jpg,02.jpg" && only.zips[0].files[0].key !== only.zips[1].files[0].key, "at the top level, in gallery order, the MLS zip from the 2048px files");

    const plan = planBundles("demo", mixed);
    const order = plan.zips.map((z) => z.key.split("/").pop()!);
    ok(order[order.length - 1] === "photos-full.zip" && plan.fullAt === order.length - 1, "the full zip is built last");
    ok(order[plan.mlsAt] === "photos-mls.zip", "the MLS zip is where the plan says");
    const withFilm = (z: { files: ZipFile[] }) => z.files.some((f) => f.name.endsWith(".mp4"));
    ok(plan.zips.slice(0, plan.mlsAt).every((z) => !withFilm(z)) && plan.zips.slice(plan.mlsAt + 1, plan.fullAt).every(withFilm), "photo-only zips first, then the zips that carry films");
    ok(["group-photos.zip", "group-photos-mls.zip", "group-revised.zip", "photos-floor-plans.zip", "photos-floor-plans-mls.zip", "photos-twilight.zip", "photos-film.zip", "group-films.zip"].every((k) => order.includes(k)), "every area has its zip");
    ok(plan.zips.every((z) => z.key.startsWith("listings/demo/bundles/")), "all under the listing's bundles");
    ok(plan.zips[plan.fullAt].files.length === mixed.length && plan.folders["Photos"] === 2 && plan.folders["Films"] === 1, "the full zip has every photo and film, in folders");

    // The list kept on the job gives the same plan, whatever order the rows came back in.
    const frozen = viaJson(freezeMedia([...mixed].reverse()));
    const thawed = planBundles("demo", thawMedia(frozen, date));
    ok(JSON.stringify(thawed) === JSON.stringify(plan), "the list kept on the job rebuilds the very same plan");
    ok(JSON.stringify(frozen).length < mixed.length * 120, `and it is small (${JSON.stringify(frozen).length} bytes for ${mixed.length} files)`);
  }
  console.log("7. the plan: ok");

  // ---- 8. a whole rebuild across runs --------------------------------------------------------
  {
    const fill = (bucket: FakeBucket) => {
      for (const z of planBundles("demo", mixed).zips) for (const f of z.files) if (!bucket.objects.has(f.key)) bucket.put(f.key, bytes(f.name.endsWith(".mp4") ? 60_000 : 9_000 + f.key.length, f.key.length));
    };
    const newJob = (): BundleProgress => ({ v: 1, at: date.toISOString(), slug: "demo", media: freezeMedia(mixed), z: 0, n: [], bytes: 0, runs: 0, ms: 0 });
    const plan = planBundles("demo", mixed);

    const bucket = new FakeBucket(errors);
    bucket.knobs.chunk = 2048;
    fill(bucket);
    const clock = { t: 0 };
    bucket.onPart = () => void clock.t++;
    let b = newJob();
    let saved = 0;
    let runsTaken = 0;
    let state = "paused";
    while (state === "paused") {
      runsTaken++;
      b.runs++;
      const out = await buildZips(b, { store: bucket.store(), now: () => clock.t, stopAt: clock.t + 6, save: async () => (saved++, true), mayLand: async () => true, zip: { partBytes: 5000, uploads: 1, saveEveryMs: 0 } });
      state = out.state;
      b = viaJson(b); // what the next run reads from the job row
      if (runsTaken > 500) throw new Error("the rebuild never finished");
    }
    ok(state === "done" && runsTaken > 5, `a rebuild of ${plan.zips.length} zips finishes over ${runsTaken} runs`);
    ok(b.z === plan.zips.length && b.zip === undefined, "its place says every zip is done");
    let allRight = true;
    let total = 0;
    for (const [i, z] of plan.zips.entries()) {
      const landed = bucket.objects.get(z.key);
      if (!landed) {
        allRight = false;
        continue;
      }
      total += landed.bytes.length;
      const read = readZip(landed.bytes);
      if (read.names.join("|") !== z.files.map((f) => f.name).join("|") || b.n[i] !== z.files.length) allRight = false;
      for (const f of z.files) if (!same(read.files.get(f.name)!, bucket.objects.get(f.key)!.bytes)) allRight = false;
    }
    ok(allRight, "every zip of the plan landed with its files, names and bytes right");
    ok(bucket.counts.finish === plan.zips.length && bucket.counts.begin === plan.zips.length, "each zip was one upload, landed once");
    ok(bucket.counts.partBytes === total && b.bytes === total, `nothing was sent twice (${total} bytes in the zips, ${bucket.counts.partBytes} sent)`);
    ok(saved >= runsTaken, "its place was saved along the way");
    ok(b.n[plan.fullAt] === mixed.length && b.n[plan.mlsAt] === mixed.filter((m) => m.kind === "photo").length, "the counts the activity line shows are right");

    // A newer rebuild begins while this one is on its third zip.
    const s = new FakeBucket(errors);
    fill(s);
    const sClock = { t: 0 };
    s.onPart = () => void sClock.t++;
    const sb = newJob();
    const stale = await buildZips(sb, { store: s.store(), now: () => sClock.t, stopAt: Infinity, save: async () => true, mayLand: async () => sb.z < 2, zip: { partBytes: 5000, uploads: 1 } });
    ok(stale.state === "stale" && s.counts.finish === 2 && !s.objects.has(plan.zips[2].key), "once a newer rebuild has begun, this one lands nothing more");
    ok(s.uploads.size === 0 && sb.zip === undefined, "and drops the upload it had open");

    // A run that no longer holds the job.
    const l = new FakeBucket(errors);
    fill(l);
    const lost = await buildZips(newJob(), { store: l.store(), now: () => 0, stopAt: Infinity, save: async () => false, mayLand: async () => true, zip: { partBytes: 5000, uploads: 1 } });
    ok(lost.state === "lost" && l.counts.parts === 0 && l.counts.finish === 0, "a run that does not hold the job writes nothing");

    // A zip that keeps starting over becomes a failure, not a loop.
    const g = new FakeBucket(errors);
    fill(g);
    const gStore = g.store();
    let looped: unknown = null;
    try {
      await buildZips(newJob(), { store: { ...gStore, putPart: async () => Promise.reject(new ZipUploadGone()) }, now: () => 0, stopAt: Infinity, save: async () => true, mayLand: async () => true, zip: { partBytes: 5000, uploads: 1 } });
    } catch (e) {
      looped = e;
    }
    ok(looped instanceof Error && /kept starting over/.test(looped.message) && g.counts.begin === 4, "a zip that keeps starting over fails after four tries");
  }
  console.log("8. a whole rebuild across runs: ok");

  // ---- 9. whose turn it is ---------------------------------------------------------------------
  {
    const t0 = new Date("2026-11-10T20:00:00Z");
    const at = (s: number) => new Date(t0.getTime() + s * 1000);
    const me = { id: "me", createdAt: at(0) };
    const other = (over: Partial<RebuildRow>): RebuildRow => ({ id: "other", status: "queued", createdAt: at(-60), leaseUntil: null, begun: false, ...over });
    const now = at(100);
    ok(rebuildTurn(me, [], now) === "go", "alone: go");
    ok(rebuildTurn(me, [other({ status: "running", leaseUntil: at(200) })], now) === "wait", "an older one is being run: wait");
    ok(rebuildTurn(me, [other({ status: "running", leaseUntil: at(50) })], now) === "go", "an older one whose run died (lease over): go, it will stand down");
    ok(rebuildTurn(me, [other({ status: "queued", begun: true })], now) === "go", "an older one between two runs: the newer one goes ahead");
    ok(rebuildTurn(me, [other({ createdAt: at(30), status: "queued", begun: false })], now) === "go", "a newer one still waiting in the queue (an upload settling) stops nobody");
    ok(rebuildTurn(me, [other({ createdAt: at(30), status: "queued", begun: true })], now) === "yield", "a newer one that has begun: stand down");
    ok(rebuildTurn(me, [other({ createdAt: at(30), status: "running", leaseUntil: at(200) })], now) === "yield", "a newer one being run: stand down");
    ok(rebuildTurn(me, [other({ createdAt: at(30), status: "done", begun: true })], now) === "yield", "a newer one already finished: stand down");
    ok(rebuildTurn(me, [other({ createdAt: at(30), status: "dead", begun: true })], now) === "yield", "a newer one that began and died: stand down (its zips are newer)");
    ok(rebuildTurn(me, [other({ id: "me", createdAt: at(30), status: "running", leaseUntil: at(200) })], now) === "go", "its own row never counts");
    // Two picked up in the same moment: they can never both go.
    const older = { id: "a", createdAt: at(0) };
    const newer = { id: "b", createdAt: at(10) };
    const rowOf = (j: { id: string; createdAt: Date }): RebuildRow => ({ ...j, status: "running", leaseUntil: at(400), begun: false });
    const turns = [rebuildTurn(older, [rowOf(newer)], now), rebuildTurn(newer, [rowOf(older)], now)];
    ok(turns.filter((t) => t === "go").length === 0 && turns[0] === "yield" && turns[1] === "wait", "two picked up at once: the older stands down, the newer waits a moment, neither overlaps");
  }
  console.log("9. whose turn it is: ok");

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
