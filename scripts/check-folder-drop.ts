// Checks for folder drops on Upload a shoot (Oct 27 2026, src/lib/folder-drop.ts
// and the Dropbox paths in src/lib/dropbox.ts): a dropped folder is walked with
// its subfolders, every file keeps its folder path, hidden files are left out,
// and the Dropbox copy lands in a folder of the same name.
//
//   npx tsx scripts/check-folder-drop.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
  process.exit(2);
}
export {};

let failures = 0;
let passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
};

// Fake browser entries: a folder hands its children over in batches of `per`
// (Chrome gives 100), then an empty batch.
type Fake = { name: string; isFile: boolean; isDirectory: boolean; file?: (res: (f: File) => void, rej: (e: unknown) => void) => void; createReader?: () => { readEntries: (res: (b: Fake[]) => void, rej: (e: unknown) => void) => void } };
const fileEntry = (name: string, size = 10): Fake => ({ name, isFile: true, isDirectory: false, file: (res) => res(new File([new Uint8Array(size)], name)) });
const dirEntry = (name: string, children: Fake[], per = 100): Fake => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader: () => {
    let i = 0;
    return { readEntries: (res) => { const b = children.slice(i, i + per); i += per; res(b); } };
  },
});

async function main() {
  const { dirOf, skipName, storedName, walkEntries } = await import("../src/lib/folder-drop");
  const { cleanDropboxDir, mirrorTargetPath } = await import("../src/lib/dropbox");
  type Entries = Parameters<typeof walkEntries>[0];

  // ---- the shoot skill's two folders ----
  const raws = Array.from({ length: 413 }, (_, i) => fileEntry(`DSC0${String(i + 1).padStart(4, "0")}.ARW`));
  const rawDir = dirEntry("2311 Elm Street - 413 raw", [...raws, fileEntry(".DS_Store"), fileEntry("._DSC00001.ARW")]);
  const got = await walkEntries([rawDir] as unknown as Entries);
  ok(got.length === 413, `raw folder: all 413 raws, batches of 100 read to the end (got ${got.length})`);
  ok(got.every((p) => p.dir === "2311 Elm Street - 413 raw"), "raw folder: every file keeps the folder name");
  ok(!got.some((p) => p.file.name.startsWith(".")), "raw folder: .DS_Store and ._ files left out");

  const video = dirEntry("video", [fileEntry("C0001.MP4"), dirEntry("A001", [fileEntry("DJI_0001.MP4")]), dirEntry("__MACOSX", [fileEntry("x.MP4")])]);
  const v = await walkEntries([video] as unknown as Entries);
  ok(v.length === 2, `video folder: two clips, __MACOSX skipped (got ${v.length})`);
  ok(v.some((p) => p.file.name === "C0001.MP4" && p.dir === "video"), "video folder: top clip in video");
  ok(v.some((p) => p.file.name === "DJI_0001.MP4" && p.dir === "video/A001"), "video folder: subfolder kept");

  const mixed = await walkEntries([fileEntry("loose.ARW"), dirEntry("Twilight", [fileEntry("T1.ARW")])] as unknown as Entries);
  ok(mixed.find((p) => p.file.name === "loose.ARW")?.dir === "", "a loose file beside a folder has no folder");
  ok(mixed.find((p) => p.file.name === "T1.ARW")?.dir === "Twilight", "the folder beside it keeps its name");

  // ---- Choose folder (webkitRelativePath) ----
  ok(dirOf({ webkitRelativePath: "2311 Elm Street - 413 raw/DSC00001.ARW" }) === "2311 Elm Street - 413 raw", "picked folder: the folder part");
  ok(dirOf({ webkitRelativePath: "video/A001/C0001.MP4" }) === "video/A001", "picked folder: nested");
  ok(dirOf({ webkitRelativePath: "" }) === "" && dirOf({}) === "", "a loose pick has no folder");
  ok(skipName(".DS_Store") && skipName("Thumbs.db") && !skipName("DSC00001.ARW"), "system files by name");
  const { safeFilename } = await import("../src/lib/r2");
  for (const n of ["My Photo (1).jpg", "DSC00001.ARW", "--x--.jpg", "ünïcode bild.JPG", "a/b\\c.ARW", ""]) ok(storedName(n) === safeFilename(n), `stored name matches the server's safe name: ${JSON.stringify(n)}`);
  ok(storedName("DSC00001.ARW") === "DSC00001.ARW", "camera names unchanged");

  // ---- the server side: the folder path stored, the Dropbox copy ----
  ok(cleanDropboxDir("2311 Elm Street - 413 raw") === "2311 Elm Street - 413 raw", "the raw folder name kept as is");
  ok(cleanDropboxDir("video/A001") === "video/A001", "nested kept");
  ok(cleanDropboxDir("../../etc") === "etc", "no climbing out of the listing folder");
  ok(cleanDropboxDir("a/./b//c") === "a/b/c", "empty and . parts dropped");
  ok(cleanDropboxDir("raw. ") === "raw", "trailing dots and spaces trimmed");
  ok(cleanDropboxDir("a\u0000b") === "ab", "control characters removed");
  ok(cleanDropboxDir("1/2/3/4/5/6/7/8") === "1/2/3/4/5/6", "at most 6 deep");
  ok(cleanDropboxDir("") === null && cleanDropboxDir(undefined) === null && cleanDropboxDir(42) === null && cleanDropboxDir("/./") === null, "nothing left = a loose file");

  const folder = "/Listings/2311 Elm Street, Springfield, CA";
  ok(mirrorTargetPath(folder, "raw", "DSC00001.ARW", "2311 Elm Street - 413 raw") === `${folder}/2311 Elm Street - 413 raw/DSC00001.ARW`, "a dropped raw lands in the same-named folder");
  ok(mirrorTargetPath(folder, "raw_video", "C0001.MP4", "video") === `${folder}/video/C0001.MP4`, "a dropped clip lands in video (the Video folder)");
  ok(mirrorTargetPath(folder, "raw", "DSC00001.ARW", null) === `${folder}/Photo/DSC00001.ARW`, "a loose photo still lands in Photo");
  ok(mirrorTargetPath(folder, "raw_video", "C0001.MP4") === `${folder}/Video/C0001.MP4`, "a loose clip still lands in Video");

  console.log(`${passes} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
