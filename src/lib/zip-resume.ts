// A store-only zip written straight into a multipart upload, one fixed-size
// part at a time, in a form that can stop at any part boundary and carry on
// in a later run (Nov 10 2026).
//
// Why: "Download all" was built in one go inside a cron run. A rebuild that
// started late in a run, or needed longer than a run has, was cut off at the
// platform's 300 s and began again from zero (3330 Example Cedar Road, Nov 10
// 2026: fifteen cut-off runs in 75 minutes and a rebuild that never ended).
// Now the bytes already in storage stay there. A run that is out of time
// saves where it is (the cursor below) and the next run sends the next part.
//
// The cursor is small because the zip is fully determined by its inputs: the
// file list, each file's bytes and one fixed date. Any byte position can be
// produced again from "which file, how far into its record, the CRC so far",
// so nothing that was not yet uploaded has to be kept.
//
// The byte layout is the one archiver wrote for these zips before (files
// stored, sizes and CRC in a data descriptor after each file, ZIP64 only
// where a size or offset needs it), so the zips clients download are the
// same as before. scripts/check-bundle-resume.ts compares the two byte for
// byte.
//
// No database and no storage client in here: both come in through ZipIo, so
// the check script runs the whole engine against a fake store and a fake
// clock.
import { crc32 } from "node:zlib";

// Every part but the last has exactly this size (R2 refuses anything else).
export const ZIP_PART_BYTES = 16 * 1024 * 1024;
const U32 = 0xffffffff;

export type ZipFile = { key: string; name: string };

// One finished file: what the central directory needs. 0: the object was not
// in storage, so the zip leaves it out.
export type ZipDone = readonly [crc: number, size: number] | 0;

// Where a zip stands. Everything before `parts` full parts is in storage; the
// rest of the fields say what the next byte is.
export type ZipCursor = {
  uploadId: string;
  parts: number; // parts in storage, each ZIP_PART_BYTES (the last one of a finished zip may be shorter)
  i: number; // the file the next byte belongs to (files.length: the central directory)
  at: number; // bytes of that file's record (header, data, descriptor) already in those parts
  crc: number; // CRC of that file's data bytes in those parts
  size: number | null; // that file's size, known once it was opened
  etag: string | null; // the version of the object those bytes came from
  done: ZipDone[]; // one per file before i
};

export type ZipSource = { body: AsyncIterable<Uint8Array>; size: number; etag: string | null; close(): void };

// Thrown by ZipIo: the multipart upload is no longer there (aborted, expired,
// or already completed by a run that died before saying so).
export class ZipUploadGone extends Error {
  constructor(message = "the upload is gone") {
    super(message);
    this.name = "ZipUploadGone";
  }
}
// Thrown by ZipIo.open: the object was replaced after this zip began reading it.
export class ZipSourceChanged extends Error {
  constructor(message = "a file changed while it was being zipped") {
    super(message);
    this.name = "ZipSourceChanged";
  }
}

export type ZipIo = {
  begin(): Promise<string>; // start the upload, answer its id
  putPart(uploadId: string, n: number, body: Uint8Array): Promise<void>; // part n, from 1
  finish(uploadId: string, parts: number, bytes: number): Promise<void>; // check the parts add up, then land the zip
  // The object from byte `from` on, with its whole size. null: not in storage.
  // With an etag, only that version (ZipSourceChanged otherwise).
  open(key: string, from: number, etag: string | null): Promise<ZipSource | null>;
  now(): number;
  // Checkpoint. false: this run no longer holds the work; write nothing more.
  save(cursor: ZipCursor): Promise<boolean>;
  // Asked once, right before the zip lands. false: leave it unlanded.
  mayLand(): Promise<boolean>;
};

export type ZipOptions = {
  cursor: ZipCursor | null; // where an earlier run stopped
  stopAt: number; // on io.now(): no new part and no new file after this
  date: Date; // every file's date inside the zip; fixed for the whole rebuild so a resumed zip is the same bytes
  partBytes?: number;
  uploads?: number; // parts in flight at once
  readAhead?: number; // files asked for ahead of the one being written
  saveEveryMs?: number;
  stallMs?: number; // a read with no bytes for this long is dropped and asked for again
  readTries?: number;
  zip64At?: number; // sizes and offsets from here on use the ZIP64 fields (the check script lowers it)
};

export type ZipOutcome =
  | { state: "done"; files: number; bytes: number; parts: number }
  | { state: "paused"; cursor: ZipCursor } // out of time: saved, the next run carries on
  | { state: "restart"; uploadId: string; why: string } // this zip has to start over (upload gone, a file replaced)
  | { state: "lost"; uploadId: string } // save() said no
  | { state: "stale"; uploadId: string }; // mayLand() said no

// ---- The byte layout -----------------------------------------------------------

// MS-DOS date and time, from UTC (as archiver does unless told otherwise).
export function dosTime(d: Date): number {
  const year = d.getUTCFullYear();
  if (year < 1980) return 2162688; // 1980-01-01 00:00:00
  if (year >= 2044) return 2141175677; // 2043-12-31 23:59:58
  return (((year - 1980) << 25) | ((d.getUTCMonth() + 1) << 21) | (d.getUTCDate() << 16) | (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2)) >>> 0;
}

type Name = { bytes: Buffer; flags: number };
function encodeName(name: string): Name {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length > 0xffff) throw new Error(`a name in the zip is too long: ${name.slice(0, 60)}`);
  // Bit 3: sizes and CRC follow the data. Bit 11: the name is UTF-8.
  return { bytes, flags: 0x0008 | (bytes.length !== name.length ? 0x0800 : 0) };
}

const HEADER_BYTES = 30;
function localHeader(n: Name, dos: number): Buffer {
  const b = Buffer.alloc(HEADER_BYTES + n.bytes.length);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4); // version needed: a data descriptor
  b.writeUInt16LE(n.flags, 6);
  b.writeUInt16LE(0, 8); // stored
  b.writeUInt32LE(dos, 10);
  // CRC and both sizes stay zero here; the descriptor after the data has them.
  b.writeUInt16LE(n.bytes.length, 26);
  b.writeUInt16LE(0, 28);
  n.bytes.copy(b, HEADER_BYTES);
  return b;
}

const descriptorBytes = (size: number, big: number) => (size >= big ? 24 : 16);
function descriptor(crc: number, size: number, big: number): Buffer {
  const wide = size >= big;
  const b = Buffer.alloc(wide ? 24 : 16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(crc >>> 0, 4);
  if (wide) {
    b.writeBigUInt64LE(BigInt(size), 8);
    b.writeBigUInt64LE(BigInt(size), 16);
  } else {
    b.writeUInt32LE(size, 8);
    b.writeUInt32LE(size, 12);
  }
  return b;
}

// The central directory and the end records, from the finished files alone.
function centralDirectory(names: Name[], done: ZipDone[], dos: number, big: number): { bytes: Buffer; files: number; offset: number } {
  const out: Buffer[] = [];
  let offset = 0;
  let files = 0;
  for (let j = 0; j < names.length; j++) {
    const d = done[j];
    if (!d) continue;
    const [crc, size] = d;
    const n = names[j];
    const wide = size >= big || offset >= big;
    const b = Buffer.alloc(46 + n.bytes.length + (wide ? 28 : 0));
    b.writeUInt32LE(0x02014b50, 0);
    b.writeUInt16LE((3 << 8) | 45, 4); // made on unix, zip 4.5
    b.writeUInt16LE(wide ? 45 : 20, 6);
    b.writeUInt16LE(n.flags, 8);
    b.writeUInt16LE(0, 10); // stored
    b.writeUInt32LE(dos, 12);
    b.writeUInt32LE(crc >>> 0, 16);
    b.writeUInt32LE(wide ? U32 : size, 20);
    b.writeUInt32LE(wide ? U32 : size, 24);
    b.writeUInt16LE(n.bytes.length, 28);
    b.writeUInt16LE(wide ? 28 : 0, 30);
    // comment length, disk number, internal attributes: zero
    b.writeUInt32LE(0x81a40020, 38); // a regular file, rw-r--r--
    b.writeUInt32LE(wide ? U32 : offset, 42);
    n.bytes.copy(b, 46);
    if (wide) {
      const o = 46 + n.bytes.length;
      b.writeUInt16LE(0x0001, o);
      b.writeUInt16LE(24, o + 2);
      b.writeBigUInt64LE(BigInt(size), o + 4);
      b.writeBigUInt64LE(BigInt(size), o + 12);
      b.writeBigUInt64LE(BigInt(offset), o + 20);
    }
    out.push(b);
    files++;
    offset += HEADER_BYTES + n.bytes.length + size + descriptorBytes(size, big);
  }
  const length = out.reduce((a, b) => a + b.length, 0);
  const wide = files > 0xffff || length >= big || offset >= big;
  if (wide) {
    const b = Buffer.alloc(56 + 20);
    b.writeUInt32LE(0x06064b50, 0);
    b.writeBigUInt64LE(BigInt(44), 4);
    b.writeUInt16LE(45, 12);
    b.writeUInt16LE(45, 14);
    // both disk numbers: zero
    b.writeBigUInt64LE(BigInt(files), 24);
    b.writeBigUInt64LE(BigInt(files), 32);
    b.writeBigUInt64LE(BigInt(length), 40);
    b.writeBigUInt64LE(BigInt(offset), 48);
    b.writeUInt32LE(0x07064b50, 56);
    b.writeBigUInt64LE(BigInt(offset + length), 64);
    b.writeUInt32LE(1, 72);
    out.push(b);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(wide ? 0xffff : files, 8);
  end.writeUInt16LE(wide ? 0xffff : files, 10);
  end.writeUInt32LE(wide ? U32 : length, 12);
  end.writeUInt32LE(wide ? U32 : offset, 16);
  out.push(end);
  return { bytes: Buffer.concat(out), files, offset };
}

// ---- The writer ----------------------------------------------------------------

type Mark = { parts: number; i: number; at: number; crc: number; size: number | null; etag: string | null };
type Early = { ok: true; src: ZipSource | null } | { ok: false };

class Halt extends Error {
  constructor(readonly why: "pause" | "lost" | "restart", readonly detail = "") {
    super(why);
  }
}

export async function writeZip(io: ZipIo, files: ZipFile[], o: ZipOptions): Promise<ZipOutcome> {
  const PART = o.partBytes ?? ZIP_PART_BYTES;
  const UPLOADS = Math.max(1, o.uploads ?? 3);
  const AHEAD = Math.max(0, o.readAhead ?? 4);
  const SAVE_EVERY = o.saveEveryMs ?? 10_000;
  const STALL = o.stallMs ?? 20_000;
  const READ_TRIES = o.readTries ?? 4;
  const big = o.zip64At ?? U32;
  const names = files.map((f) => encodeName(f.name));
  const dos = dosTime(o.date);

  let begun = o.cursor;
  if (!begun) {
    begun = { uploadId: await io.begin(), parts: 0, i: 0, at: 0, crc: 0, size: null, etag: null, done: [] };
    // The upload id is on record before any part is sent, so no run ever loses track of it.
    if (!(await io.save(begun))) return { state: "lost", uploadId: begun.uploadId };
  }
  const uploadId = begun.uploadId;

  // Where the next byte goes. done.length === i at all times.
  let i = begun.i;
  let at = begun.at;
  let crc = begun.crc;
  let size = begun.size;
  let etag = begun.etag;
  const done: ZipDone[] = begun.done.slice(0, i);

  // What is safely in storage: every part up to confirmed.parts has landed.
  let confirmed: Mark = { parts: begun.parts, i, at, crc, size, etag };
  const cursorOf = (m: Mark): ZipCursor => ({ uploadId, ...m, done: done.slice(0, m.i) });
  let savedParts = begun.parts;
  let savedAt = io.now();
  const checkpoint = async () => {
    const c = cursorOf(confirmed);
    savedParts = c.parts;
    savedAt = io.now();
    if (!(await io.save(c))) throw new Halt("lost");
    return c;
  };

  // Parts: filled in order, sent a few at a time, confirmed in order.
  const pool: Buffer[] = [];
  let buf: Buffer = Buffer.allocUnsafe(PART);
  let fill = 0;
  let partNo = begun.parts;
  const marks = new Map<number, Mark>();
  const landed = new Set<number>();
  const flying = new Set<Promise<void>>();
  let failure: unknown = null;
  const send = async (last: boolean) => {
    const n = ++partNo;
    const whole = buf;
    const body = last ? whole.subarray(0, fill) : whole;
    marks.set(n, { parts: n, i, at, crc, size, etag });
    fill = 0;
    if (!last) buf = pool.pop() ?? Buffer.allocUnsafe(PART);
    const p: Promise<void> = io
      .putPart(uploadId, n, body)
      .then(
        () => {
          landed.add(n);
          for (let m = confirmed.parts + 1; landed.has(m); m++) {
            confirmed = marks.get(m)!;
            marks.delete(m);
            landed.delete(m);
          }
        },
        (e) => {
          failure ??= e ?? new Error("a part failed to upload");
        }
      )
      .finally(() => {
        flying.delete(p);
        if (!last) pool.push(whole);
      });
    flying.add(p);
    while (flying.size >= UPLOADS && !failure) await Promise.race(flying);
    if (failure) throw failure;
    if (confirmed.parts > savedParts && io.now() - savedAt >= SAVE_EVERY) await checkpoint();
  };
  // Bytes into the current part. A full part goes out first, and that is the
  // only place a run stops mid-file: exactly on a part boundary, where the
  // state above says what the next byte is.
  const emit = async (src: Uint8Array, data: boolean) => {
    let off = 0;
    while (off < src.length) {
      if (fill === PART) {
        await send(false);
        if (io.now() >= o.stopAt) throw new Halt("pause");
      }
      const n = Math.min(PART - fill, src.length - off);
      const piece = src.subarray(off, off + n);
      buf.set(piece, fill);
      if (data) crc = crc32(piece, crc);
      fill += n;
      off += n;
      at += n;
    }
  };

  // Reads: the next few files are asked for while this one is written (most
  // of a rebuild was waiting for one answer at a time), and a read that goes
  // silent is dropped and asked for again from where it stopped.
  const ahead = new Map<number, Promise<Early>>();
  const askAhead = (from: number) => {
    for (let j = from; j < Math.min(files.length, from + AHEAD); j++) {
      if (!ahead.has(j)) ahead.set(j, io.open(files[j].key, 0, null).then((src): Early => ({ ok: true, src }), (): Early => ({ ok: false })));
    }
  };
  const first = async (j: number): Promise<ZipSource | null> => {
    const early = ahead.get(j);
    if (early) {
      ahead.delete(j);
      const r = await early;
      if (r.ok) return r.src;
    }
    return io.open(files[j].key, 0, null);
  };
  let reading: ZipSource | null = null;
  let lastBytesAt = Date.now();
  const watchdog = setInterval(() => {
    if (reading && Date.now() - lastBytesAt > STALL) reading.close();
  }, Math.min(5_000, STALL));
  watchdog.unref?.();

  try {
    while (i < files.length) {
      if (io.now() >= o.stopAt) throw new Halt("pause");
      const head = localHeader(names[i], dos);
      let src: ZipSource | null = null;
      if (at === 0) {
        // A file not begun yet (also where a run stopped exactly between two files).
        src = await first(i);
        if (!src) {
          done.push(0);
          i++;
          continue;
        }
        size = src.size;
        etag = src.etag;
        crc = 0;
      }
      if (size === null) throw new Error("zip cursor: a file in flight has no size");
      const total = size;
      askAhead(i + 1);
      if (at < head.length) await emit(head.subarray(at), false);
      let tries = 0;
      while (at - head.length < total) {
        const from = at - head.length;
        if (!src) {
          src = await io.open(files[i].key, from, etag);
          if (!src) throw new Halt("restart", `${files[i].name} left storage while it was being zipped`);
        }
        reading = src;
        lastBytesAt = Date.now();
        const before = at;
        let failed: unknown = null;
        try {
          const it = src.body[Symbol.asyncIterator]();
          for (;;) {
            let r: IteratorResult<Uint8Array>;
            try {
              r = await it.next();
            } catch (e) {
              failed = e ?? new Error("read failed");
              break;
            }
            if (r.done) break;
            lastBytesAt = Date.now();
            if (!r.value.length) continue;
            if (at - head.length + r.value.length > total) throw new Halt("restart", `${files[i].name} is longer than storage said`);
            await emit(r.value, true);
          }
        } finally {
          reading = null;
          src.close();
          src = null;
        }
        // Every byte arrived and the read still ended in an error (storage's
        // own check of the whole file failed): those bytes cannot be trusted.
        if (failed && at - head.length >= total) throw new Halt("restart", `${files[i].name} did not read back clean (${failed instanceof Error ? failed.message : String(failed)})`);
        if (at - head.length < total) {
          // Cut short (an error, a stall, an early end): ask again from here.
          // Only tries that brought no bytes at all count against the file.
          if (at > before) tries = 0;
          if (++tries >= READ_TRIES) throw failed ?? new Error(`${files[i].name}: storage kept ending the file early`);
        }
      }
      const desc = descriptor(crc, total, big);
      await emit(desc.subarray(at - head.length - total), false);
      done.push([crc >>> 0, total]);
      i++;
      at = 0;
      crc = 0;
      size = null;
      etag = null;
    }

    const cd = centralDirectory(names, done, dos, big);
    if (at < cd.bytes.length) await emit(cd.bytes.subarray(at), false);
    if (fill > 0) await send(true);
    await Promise.all([...flying]);
    if (failure) throw failure;
    if (confirmed.parts !== partNo) throw new Error("zip: parts went missing on the way");
    await checkpoint();
    if (!(await io.mayLand())) return { state: "stale", uploadId };
    const bytes = cd.offset + cd.bytes.length;
    await io.finish(uploadId, partNo, bytes);
    return { state: "done", files: cd.files, bytes, parts: partNo };
  } catch (thrown) {
    await Promise.allSettled([...flying]);
    const e = failure ?? thrown;
    if (e instanceof Halt && e.why === "lost") return { state: "lost", uploadId };
    if (e instanceof Halt && e.why === "restart") return { state: "restart", uploadId, why: e.detail };
    if (e instanceof ZipUploadGone || e instanceof ZipSourceChanged) return { state: "restart", uploadId, why: e.message };
    if (e instanceof Halt) {
      // Out of time. Everything confirmed is saved; the bytes after it are made again next run.
      const c = cursorOf(confirmed);
      if (!(await io.save(c))) return { state: "lost", uploadId };
      return { state: "paused", cursor: c };
    }
    // A real failure: keep what is in storage on record, then let the job fail and retry from there.
    if (confirmed.parts > savedParts) await io.save(cursorOf(confirmed)).catch(() => false);
    throw e;
  } finally {
    clearInterval(watchdog);
    for (const p of ahead.values()) void p.then((r) => (r.ok ? r.src?.close() : undefined));
    ahead.clear();
  }
}
