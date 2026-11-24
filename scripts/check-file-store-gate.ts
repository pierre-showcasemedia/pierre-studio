// Google Drive only for a business on Google Drive (Nov 24 2026).
//
//   npx tsx scripts/check-file-store-gate.ts
//
// 1. The copy (src/lib/file-store-copy.ts) names the business's own file
//    store: the wizard's photo box, its clip lines, the Video board header.
// 2. Static: Save to Google Drive (src/app/api/portal/drive-save) and Import
//    from Google Drive (src/app/api/studio/import-drive) answer 404 unless
//    business.fileStore is "google_drive"; the import checks the listing
//    before it makes a shoot; the wizard and the Video board use the copy
//    and never hard-code Dropbox where the file store is meant.
// 3. This business's file store against the wizard text it gets.
// No database, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { videoBoardLede, wizardClipCost, wizardClipsLanded, wizardPhotoText } from "../src/lib/file-store-copy";
import { business } from "../src/lib/business";
import { fileStoreName, onDrive } from "../src/lib/file-store";

const ROOT = path.resolve(__dirname, "..");
let fails = 0;
let passes = 0;
const ok = (c: unknown, n: string) => {
  if (c) passes++;
  else {
    fails++;
    console.error(`FAIL ${n}`);
  }
};
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// ---- 1. the copy -------------------------------------------------------------------
for (const store of ["Dropbox", "Google Drive"] as const) {
  const other = store === "Dropbox" ? "Google Drive" : "Dropbox";
  for (const outside of [false, true]) {
    const t = wizardPhotoText(store, outside);
    ok(t.includes(store) && !t.includes(other), `wizard photo text names ${store} only (edited outside: ${outside})`);
    ok(!/—|--|!/.test(t), `wizard photo text: no em dash, double hyphen or exclamation (${store}, ${outside})`);
  }
  ok(wizardClipCost(store, 1) === ` The 1 clip cost nothing: it goes to ${store} only.`, `one clip line (${store})`);
  ok(wizardClipCost(store, 3) === ` The 3 clips cost nothing: they go to ${store} only.`, `several clips line (${store})`);
  ok(wizardClipsLanded(store) === `, and the video team hears once the clips are in ${store}`, `clips landed line (${store})`);
  const lede = videoBoardLede(store, 4, 1);
  ok((lede.match(new RegExp(store, "g")) ?? []).length === 2 && !lede.includes(other), `the Video board header names ${store} twice and never ${other}`);
  ok(lede.endsWith("4 open, 1 with a revision.") && videoBoardLede(store, 2, 0).endsWith("2 open."), `the Video board counts (${store})`);
  ok(!/—|--|!/.test(lede), `the Video board header: no em dash, double hyphen or exclamation (${store})`);
}

// ---- 2. static -------------------------------------------------------------------------
const save = code(read("src/app/api/portal/drive-save/route.ts"));
const savePost = save.slice(save.indexOf("export async function POST("));
ok(/if \(!onDrive\(\)\) return Response\.json\(\{ ok: false, error: "not found" \}, \{ status: 404 \}\)/.test(savePost), "drive-save is a 404 off Google Drive");
ok(savePost.indexOf("onDrive()") < savePost.indexOf("sessionEmail(") && savePost.indexOf("onDrive()") < savePost.indexOf("request.json("), "drive-save checks the file store before anything else");
const imp = code(read("src/app/api/studio/import-drive/route.ts"));
const impPost = imp.slice(imp.indexOf("export async function POST("));
ok(/if \(!onDrive\(\)\) return Response\.json\(\{ ok: false, error: "not found" \}, \{ status: 404 \}\)/.test(impPost), "import-drive is a 404 off Google Drive");
ok(impPost.indexOf("requireUploaderApi(") < impPost.indexOf("onDrive()") && impPost.indexOf("onDrive()") < impPost.indexOf("request.json("), "import-drive: the gate, then the file store, then the body");
ok(/listings\.findFirst\(\{ where: eq\(schema\.listings\.id, listingId\)/.test(impPost), "import-drive looks the listing up");
ok(/if \(!listing\) return Response\.json\(\{ ok: false, error: "Listing not found\." \}, \{ status: 404 \}\)/.test(impPost), "import-drive answers 404 for a listing that does not exist");
ok(impPost.indexOf("listings.findFirst(") < impPost.indexOf("insert(schema.shoots)"), "the listing check comes before a shoot is inserted");
ok(/UUID_RE\.test\(listingId\)/.test(impPost), "a listing id that is not a uuid never reaches the database");
const fs = code(read("src/lib/file-store.ts"));
ok(/onDrive = \(\): boolean => business\.fileStore === "google_drive"/.test(fs), "onDrive is business.fileStore === \"google_drive\"");
const wiz = code(read("src/components/admin/UploadWizard.tsx"));
ok(/wizardPhotoText\(storeName, editedOutside\)/.test(wiz) && /wizardClipCost\(storeName, videoCount\)/.test(wiz) && /wizardClipsLanded\(storeName\)/.test(wiz), "the wizard uses the copy with its storeName");
const wizText = wiz.replace(/chooseDropbox|Dropbox\?:|w\.Dropbox|"Dropbox did not load"|storeName = "Dropbox"|dropboxKey|Choose photos from Dropbox/g, "");
ok(!/Dropbox/.test(wizText), "the wizard says Dropbox only on the Dropbox Chooser button and its default");
ok(/storeName=\{fileStoreName\(\)\}/.test(code(read("src/app/admin/upload/page.tsx"))), "the upload page passes fileStoreName()");
const video = code(read("src/app/admin/video/page.tsx"));
ok(/lede=\{videoBoardLede\(fileStoreName\(\), open, revisions\)\}/.test(video), "the Video board header follows the file store");
ok(!/Dropbox/.test(video), "the Video board page never hard-codes Dropbox");

// ---- 3. this business --------------------------------------------------------------------
ok(onDrive() === (business.fileStore === "google_drive"), "onDrive follows business.fileStore");
ok(fileStoreName() === (onDrive() ? "Google Drive" : "Dropbox"), `this business's file store reads ${fileStoreName()}`);
ok(wizardPhotoText(fileStoreName(), false).includes(fileStoreName()), "this business's wizard names its own file store");

console.log(`check-file-store-gate: ${passes} passed, ${fails} failed (${business.fileStore})`);
process.exit(fails ? 1 : 0);
