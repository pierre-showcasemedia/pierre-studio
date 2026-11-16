// Checks for the raw cleanup (Oct 27 2026, src/lib/r2-raw-cleanup.ts): the
// Dropbox content hash it compares against, computed in one go and in ranges
// the way a long file is hashed across ticks; which keys may ever be deleted;
// and when a raw must stay in R2.
//
//   npx tsx scripts/check-r2-raw-cleanup.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
  process.exit(2);
}
import { createHash, randomBytes } from "node:crypto";

let failures = 0;
let passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
};

// Dropbox's published algorithm, written out independently: SHA-256 of every
// 4 MiB block, concatenated as bytes, then SHA-256 of that.
function reference(buf: Buffer): string {
  const B = 4 * 1024 * 1024;
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += B) parts.push(createHash("sha256").update(buf.subarray(i, i + B)).digest());
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}

async function main() {
  const { blockDigests, contentHashFromDigests, dropboxContentHash, isRawUploadKey, cleanupBlocker, EDITING_DONE } = await import("../src/lib/r2-raw-cleanup");
  const MiB = 1024 * 1024;

  // ---- the content hash ----
  for (const size of [0, 1, 4 * MiB - 1, 4 * MiB, 4 * MiB + 1, 32 * MiB, 33 * MiB + 5]) {
    const buf = randomBytes(size);
    ok(dropboxContentHash(buf) === reference(buf), `content hash matches Dropbox's algorithm at ${size} bytes`);
  }
  ok(dropboxContentHash(Buffer.alloc(0)) === createHash("sha256").update(Buffer.alloc(0)).digest("hex"), "an empty file: SHA-256 of no digests");

  // Resumed across ticks: ranges of 32 MiB (whole blocks), then the tail.
  const big = randomBytes(75 * MiB + 123);
  let digests = "";
  for (let off = 0; off < big.length; off += 32 * MiB) digests += blockDigests(big.subarray(off, Math.min(off + 32 * MiB, big.length)));
  ok(digests.length === Math.ceil(big.length / (4 * MiB)) * 64, "one 64-character digest per block");
  ok(contentHashFromDigests(digests) === reference(big), "hashing in ranges gives the same hash as in one go");
  const flipped = Buffer.from(big);
  flipped[50 * MiB] ^= 1;
  ok(dropboxContentHash(flipped) !== reference(big), "one changed byte changes the hash");

  // ---- which keys may be deleted ----
  const s = "0b6a1c2e-1111-2222-3333-444455556666";
  ok(isRawUploadKey(s, `shoots/${s}/raw/DSC00001.ARW`), "a raw photo key");
  ok(isRawUploadKey(s, `shoots/${s}/raw-video/C0001.MP4`), "a raw clip key");
  ok(!isRawUploadKey(s, `shoots/${s}/finals/DSC00001.jpg`), "never a delivered final");
  ok(!isRawUploadKey(s, `shoots/${s}/replaced/2026/DSC00001.jpg`), "never a replaced original");
  ok(!isRawUploadKey(s, `shoots/other-shoot/raw/DSC00001.ARW`), "never another shoot's key");
  ok(!isRawUploadKey(s, `shoots/${s}/raw/sub/DSC00001.ARW`), "only directly under raw/");
  ok(!isRawUploadKey(s, `listings/x/DSC00001.jpg`), "never a gallery key");

  // ---- when a raw stays ----
  const base = { shootId: s, kind: "raw", r2Key: `shoots/${s}/raw/DSC00001.ARW`, dropboxPath: "/Listings/1 A St/1 A St - 2 raw/DSC00001.ARW", dropboxSyncedAt: new Date(), r2DeletedAt: null };
  ok(cleanupBlocker(base, "published") === null, "a published shoot's photo in Dropbox: check it");
  ok(cleanupBlocker(base, "ready_for_review") === null, "ready for review: check it");
  for (const st of ["uploaded", "transferring", "committing", "processing", "importing", "twilight", "qc", "failed"]) ok(cleanupBlocker(base, st) === "editing may still need it", `a photo stays while the shoot is ${st}`);
  ok(cleanupBlocker({ ...base, kind: "display" }, "processing") === "editing may still need it", "finished JPGs are editing input too");
  ok(cleanupBlocker({ ...base, kind: "raw_video", r2Key: `shoots/${s}/raw-video/C0001.MP4` }, "processing") === null, "a clip never goes to editing: check it once in Dropbox");
  ok(cleanupBlocker({ ...base, kind: "raw_video", r2Key: `shoots/${s}/raw-video/C0001.MP4` }, "draft") === "the upload isn't submitted yet", "a clip copied during the upload stays until Submit");
  ok(cleanupBlocker({ ...base, dropboxSyncedAt: null }, "published") === "not in Dropbox yet", "not copied yet: stays");
  ok(cleanupBlocker({ ...base, dropboxPath: null }, "published") === "not in Dropbox yet", "no Dropbox path: stays");
  ok(cleanupBlocker({ ...base, r2DeletedAt: new Date() }, "published") === "already removed from R2", "already removed");
  ok(cleanupBlocker({ ...base, r2Key: `shoots/${s}/finals/DSC00001.jpg` }, "published") === "not a raw upload", "a final under shoots/ is never a candidate");
  ok(EDITING_DONE.includes("published") && !EDITING_DONE.includes("failed"), "a stopped shoot keeps its raws (a retry sends them again)");

  console.log(`${passes} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
