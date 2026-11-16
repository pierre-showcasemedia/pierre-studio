// Upload a delivered shoot into the studio.
//
//   node scripts/upload-listing-media.mjs "/Volumes/.../100 Example Lane" --slug 100-example-lane
//
// Folder layout: photos = ONLY <folder>/edits/<PHOTO_PREFIX>*.jpg|jpeg|png.
// Videos = final files at the TOP LEVEL of <folder>/video (no subfolders, no ._*).
// REVISIONS: revised photos = <folder>/revisions/<PHOTO_PREFIX>*.jpg; revised videos =
// video files at the top level of <folder>/revisions. They upload under
// listings/<slug>/rev/ and register with revision:true (own portal section).
// Uploads to R2 as listings/<slug>/(photos|video)/<filename>, then registers the
// manifest with the admin API. Env from .env.local (never committed):
// R2_*, MIGRATE_TOKEN, NEXT_PUBLIC_SITE_URL (or PORTAL_API), optional PHOTO_PREFIX.
// Idempotent: re-running replaces the media manifest.
//
// NDA listings: never upload NDA media anywhere it could be posted or shared.
// TODO(Phase 1): confirm the business's delivered-file naming and set PHOTO_PREFIX
// (empty = every image in edits/ is uploaded).
import { readFileSync, readdirSync, statSync, createReadStream, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.startsWith("#")) process.env[line.slice(0, i)] ??= line.slice(i + 1).replace(/^["']|["']$/g, "");
  }
} catch {} // no .env.local: rely on the shell environment
for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "MIGRATE_TOKEN"]) {
  if (!process.env[k]) {
    console.error(`Missing ${k}. Set it in .env.local or the shell (see .env.example).`);
    process.exit(1);
  }
}
const PREFIX = process.env.PHOTO_PREFIX || "";
const isDelivered = (f) => f.startsWith(PREFIX) && /\.(jpe?g|png)$/i.test(f);

const argv = process.argv.slice(2);
const folder = argv[0];
const slug = argv[argv.indexOf("--slug") + 1];
// --section "Name": upload THIS folder's images as a named portal section with
// its own zip bundle (bundles/photos-<secslug>.zip). Main gallery untouched
// (server replace is scoped per section). Images read from the folder ROOT.
const secIdx = argv.indexOf("--section");
const SECTION = secIdx >= 0 ? argv[secIdx + 1] : null;
const secSlug = SECTION ? SECTION.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : null;
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "https://portal.example.com").replace(/\/+$/, "");
const API = process.env.PORTAL_API || `${SITE}/api/portal/admin-api`;
if (!folder || !slug) {
  console.error('Usage: node scripts/upload-listing-media.mjs "<property folder>" --slug <listing-slug>');
  process.exit(1);
}

const photosDir = SECTION ? folder : join(folder, "edits");
const videoDir = join(folder, "video");
let photos = [];
try {
  photos = readdirSync(photosDir)
    .filter((f) => !f.startsWith(".") && isDelivered(f) && statSync(join(photosDir, f)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
} catch {} // no edits folder — video-only listing
// --order <file.json>: explicit gallery order (array of filenames). Category-style
// names like X-exterior-1 / -interior-1 don't sort into gallery order on their
// own; an edit manifest can write this. Unlisted files keep name order.
const ordIdx = argv.indexOf("--order");
if (ordIdx >= 0 && photos.length) {
  const want = JSON.parse(readFileSync(argv[ordIdx + 1], "utf8"));
  const rank = new Map(want.map((f, i) => [f, i]));
  photos.sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b, undefined, { numeric: true }));
  const unlisted = photos.filter((f) => !rank.has(f)).length;
  if (unlisted) console.log(`  --order: ${unlisted} file(s) not in the order list, appended in name order`);
}
let videos = [];
try {
  if (!SECTION) videos = readdirSync(videoDir)
    .filter((f) => !f.startsWith("._") && !f.startsWith(".") && /\.(mp4|mov|m4v)$/i.test(f) && statSync(join(videoDir, f)).isFile())
    .sort();
} catch {} // no video folder — photos-only listing

// Revisions (optional folder)
const revDir = join(folder, "revisions");
let revPhotos = [], revVideos = [];
try {
  if (SECTION) throw new Error("skip");
  const entries = readdirSync(revDir).filter((f) => !f.startsWith(".") && statSync(join(revDir, f)).isFile());
  revPhotos = entries.filter((f) => isDelivered(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  revVideos = entries.filter((f) => /\.(mp4|mov|m4v)$/i.test(f)).sort();
} catch {} // no revisions folder

if (!photos.length && !videos.length && !revPhotos.length && !revVideos.length) {
  console.error(`No edits/${PREFIX}* photos and no final videos found in ${folder}`);
  process.exit(1);
}
console.log(`${photos.length} photos (edits/${PREFIX}*) + ${videos.length} final videos` +
  (revPhotos.length || revVideos.length ? ` + ${revPhotos.length} revised photos + ${revVideos.length} revised videos` : "") +
  ` → listings/${slug}/`);

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const BUCKET = process.env.R2_BUCKET;

async function exists(Key, size) {
  try {
    const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
    return h.ContentLength === size;
  } catch {
    return false;
  }
}

const files = [];
const TOTAL = () => photos.length + videos.length + revPhotos.length + revVideos.length;
let done = 0;
async function put(dir, name, sub, kind, contentType, revision = false) {
  const path = join(dir, name);
  const size = statSync(path).size;
  const Key = SECTION ? `listings/${slug}/s/${secSlug}/${sub}/${name}` : `listings/${slug}/${sub}/${name}`;
  if (!(await exists(Key, size))) {
    if (size > 50_000_000) {
      // multipart for the big video files
      // ContentLength from statSync: lib-storage otherwise lstats Body.path,
      // which reports the link size (not the file) when staging via symlinks.
      await new Upload({
        client: s3,
        params: { Bucket: BUCKET, Key, Body: createReadStream(path), ContentType: contentType, ContentLength: size },
        // UPLOAD_PART_MB / UPLOAD_QUEUE: smaller parts on a slow uplink so a
        // dropped connection retries a few MB instead of timing out 50 MB parts.
        queueSize: Number(process.env.UPLOAD_QUEUE) || 4,
        partSize: (Number(process.env.UPLOAD_PART_MB) || 50) * 1024 * 1024,
      }).done();
    } else {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: readFileSync(path), ContentType: contentType }));
    }
  }
  files.push({ r2Key: Key, filename: name, bytes: size, kind, sort: files.length, revision, section: SECTION });
  done++;
  if (done % 20 === 0 || kind === "video") console.log(`  ${done}/${TOTAL()} uploaded (${name})`);
}

// Derivatives (thumb/preview, clean + the business-watermarked), generated with PIL,
// uploaded next to the originals under listings/<slug>/d/<variant>/.
const LOGO = join(ROOT, "public/brand/watermark.png");
const VARIANTS = ["thumb", "thumb-wm", "preview", "preview-wm", "mls"];
// dPrefix: "d" for finals, "rev/d" for revisions — must mirror the photo's own
// prefix so the server's derivativeKey() convention keeps working.
async function putDerivatives(dir, name, dPrefix = "d") {
  const base = name.replace(/\.[^.]+$/, "") + ".jpg";
  const need = [];
  for (const v of VARIANTS) {
    const Key = `listings/${slug}/${dPrefix}/${v}/${base}`;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
    } catch {
      need.push(v);
    }
  }
  if (!need.length) return;
  const tmp = mkdtempSync(join(tmpdir(), "studio-deriv-"));
  try {
    execFileSync("python3", [join(ROOT, "scripts/make-derivatives.py"), join(dir, name), tmp, LOGO], { stdio: "ignore" });
    for (const v of need) {
      const body = readFileSync(join(tmp, v, base));
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `listings/${slug}/${dPrefix}/${v}/${base}`, Body: body, ContentType: "image/jpeg" }));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

for (const f of photos) {
  await put(photosDir, f, "photos", "photo", "image/jpeg");
  await putDerivatives(photosDir, f, SECTION ? `s/${secSlug}/d` : "d");
}
for (const f of videos) await put(videoDir, f, "video", "video", "video/quicktime");
for (const f of revPhotos) {
  await put(revDir, f, "rev/photos", "photo", "image/jpeg", true);
  await putDerivatives(revDir, f, "rev/d");
}
for (const f of revVideos) await put(revDir, f, "rev/video", "video", "video/quicktime", true);

// "Download all" bundles: full-res originals + MLS 2048px set (ZIP_STORED —
// JPEGs don't recompress). Built locally, multipart-uploaded, downloaded via
// /api/portal/bundle/. Skipped if already present with the same size.
if (photos.length) {
console.log("building bundles…");
const bundleTmp = mkdtempSync(join(tmpdir(), "studio-bundles-"));
try {
  const fullZip = join(bundleTmp, "photos-full.zip");
  const mlsDir = join(bundleTmp, "mls");
  const mlsZip = join(bundleTmp, "photos-mls.zip");
  execFileSync("python3", ["-c", `
import sys, zipfile, os
mode, out, srcdir, names = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    for n in names:
        z.write(os.path.join(srcdir, n), n)
`, "full", fullZip, photosDir, ...photos]);
  // regenerate MLS files locally for the zip (fast, avoids R2 round-trips)
  execFileSync("python3", ["-c", `
import sys, os
sys.path.insert(0, ${JSON.stringify(join(ROOT, "scripts"))})
from PIL import Image
srcdir, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)
for n in sys.argv[3:]:
    im = Image.open(os.path.join(srcdir, n)).convert("RGB")
    w, h = im.size
    s = 2048 / max(w, h)
    if s < 1:
        im = im.resize((round(w*s), round(h*s)), Image.LANCZOS)
    im.save(os.path.join(outdir, os.path.splitext(n)[0] + ".jpg"), "JPEG", quality=85, optimize=True)
`, photosDir, mlsDir, ...photos]);
  execFileSync("python3", ["-c", `
import sys, zipfile, os
out, srcdir = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    for n in sorted(os.listdir(srcdir)):
        z.write(os.path.join(srcdir, n), n)
`, mlsZip, mlsDir]);
  for (const [local, key] of SECTION
    ? [[fullZip, `photos-${secSlug}.zip`], [mlsZip, `photos-${secSlug}-mls.zip`]]
    : [[fullZip, "photos-full.zip"], [mlsZip, "photos-mls.zip"]]) {
    const size = statSync(local).size;
    const Key = `listings/${slug}/bundles/${key}`;
    if (!(await exists(Key, size))) {
      await new Upload({
        client: s3,
        params: { Bucket: BUCKET, Key, Body: createReadStream(local), ContentType: "application/zip" },
        queueSize: 4,
        partSize: 50 * 1024 * 1024,
      }).done();
    }
    console.log(`  bundle ${key}: ${(size / 1e6).toFixed(0)} MB ✓`);
  }
} finally {
  rmSync(bundleTmp, { recursive: true, force: true });
}
}

const resp = await fetch(API, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-migrate-token": process.env.MIGRATE_TOKEN },
  body: JSON.stringify({ op: "addMedia", slug, files, coverKey: SECTION ? undefined : files[0]?.r2Key, replace: true }),
});
const json = await resp.json();
if (!json.ok) {
  console.error("manifest registration FAILED:", JSON.stringify(json));
  process.exit(1);
}
console.log(`✓ ${slug}: ${json.totalMedia} media rows registered, live in the portal`);
if (json.listingId) {
  console.log(`→ Send delivery email (preview & confirm): ${SITE}/admin/listings/${json.listingId}/delivery-email`);
}
