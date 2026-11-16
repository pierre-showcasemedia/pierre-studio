// Push local files straight onto an the studio listing, no browser.
//
//   node scripts/push-to-listing.mjs <slug> <file|folder>... [--section "Name"] [--visible] [--dry] [--nda-ok]
//
// The same two routes the admin "Add files" panel uses
// (src/components/admin/UploadToListing.tsx, src/lib/listing-uploads.ts):
//   1. POST /api/studio/listings/<id>/upload-urls  presigned R2 PUT URLs, up to 60 per call
//   2. PUT each file straight to R2, streamed from disk, 3 at a time, with retries
//      (a fresh URL after a 403)
//   3. POST /api/studio/listings/<id>/ingest       derivatives + media rows, 5 per call, in order
//   4. POST /api/studio/listings/<id>/upload-done  the run's ONE hub line (Oct 26 2026: the
//      ingest calls carry the run id and stay quiet; src/lib/upload-runs.ts)
// Auth is the x-migrate-token header (MIGRATE_TOKEN); the routes log the actor as
// "claude-token". The listing id, NDA flag and media_count come from the admin API's
// read-only listListings op. This script never creates a listing, never sends email,
// and never touches the cover, the lock or invoices.
//
// Folders are read one level deep (no recursion; dotfiles skipped). JPG photos and
// MP4 / MOV / M4V films only. Everything is sorted in natural order by filename
// (Aerial-2 before Aerial-10) and ingested in that order, so new files land at the
// end of the section in that order. A filename that already exists in the same
// section is replaced in place (it keeps its spot). Rows land Internal only (the
// client sees nothing) unless --visible: the gallery is reviewed in the admin
// before anything reaches a client (Oct 20 2026).
//
//   --section "Name"  upload into a named section (listings/<slug>/s/<name>/...)
//   --visible         add the rows client visible right away (only for a gallery
//                     that is already reviewed and final); --hidden is the default
//                     and still accepted
//   --dry             print the plan only: nothing is uploaded or written
//   --nda-ok          allow a listing flagged NDA (refused otherwise)
//
// Env (.env.local or the shell, the shell wins): MIGRATE_TOKEN (required);
// STUDIO_PORTAL_URL (default https://the portal). A *.vercel.app
// preview also gets x-vercel-protection-bypass from VERCEL_AUTOMATION_BYPASS_SECRET.
// Previews share the production database: a non-dry run there writes real rows.
//
// Supersedes scripts/upload-listing-media.mjs for adding files (that one needs R2
// keys on this machine, which only Vercel has).
import { readFileSync, readdirSync, statSync, createReadStream } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  for (const raw of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
    const line = raw.replace(/^export\s+/, "");
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
} catch {} // no .env.local: rely on the shell environment

const USAGE = 'Usage: node scripts/push-to-listing.mjs <slug> <file|folder>... [--section "Name"] [--visible] [--dry] [--nda-ok]';
const URL_BATCH = 60; // upload-urls MAX_BATCH
const INGEST_BATCH = 5; // ingest allows 8; 5 keeps 25 MB frames inside its 120 s budget
const PUT_CONCURRENCY = 3;
const PUT_BACKOFF = [2000, 5000, 12000];
const PUT_IDLE_MS = 120_000; // abort a PUT that moves no bytes for this long
const INGEST_TIMEOUT_MS = 180_000; // longer than the route's maxDuration (120 s)
const INGEST_SETTLE_MS = 130_000; // after a lost response, let the server call finish before retrying
const ACCEPT_RE = /\.(jpe?g|mp4|mov|m4v)$/i;
const isVideo = (n) => /\.(mp4|mov|m4v)$/i.test(n);

// Mirrors src/lib/r2.ts safeFilename and src/lib/listing-uploads.ts.
const safeFilename = (name) => (name.split(/[\\/]/).pop() || "file").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "file";
const sectionSlug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const uploadKey = (slug, section, safe) => `listings/${slug}/${section ? `s/${sectionSlug(section)}/` : ""}${isVideo(safe) ? "video" : "photos"}/${safe}`;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

// ---- arguments ----
const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) die(USAGE, argv.length ? 0 : 2);
const opts = { section: null, hidden: true, dry: false, ndaOk: false };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--section") {
    const v = argv[++i];
    if (!v || v.startsWith("--")) die('--section needs a name, e.g. --section "Twilight"');
    opts.section = v.trim() || null;
  } else if (a === "--hidden") opts.hidden = true;
  else if (a === "--visible") opts.hidden = false;
  else if (a === "--dry") opts.dry = true;
  else if (a === "--nda-ok") opts.ndaOk = true;
  else if (a.startsWith("--")) die(`Unknown option ${a}\n${USAGE}`);
  else positional.push(a);
}
const [slug, ...paths] = positional;
if (!slug || !paths.length) die(USAGE);

const TOKEN = process.env.MIGRATE_TOKEN;
if (!TOKEN) die("Missing MIGRATE_TOKEN. Set it in .env.local or the shell.");
const BASE = (process.env.STUDIO_PORTAL_URL || "https://portal.example.com").replace(/\/+$/, "");
const baseHost = new URL(BASE).hostname;
const headers = { "Content-Type": "application/json", "x-migrate-token": TOKEN };
if (baseHost.endsWith(".vercel.app") && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

// ---- local files ----
const files = [];
const skipped = [];
for (const p of paths) {
  const abs = resolve(p);
  let st;
  try { st = statSync(abs); } catch { die(`Not found: ${p}`); }
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) {
      if (name.startsWith(".")) continue;
      const full = join(abs, name);
      const s = statSync(full);
      if (!s.isFile()) continue;
      if (!ACCEPT_RE.test(name)) { skipped.push(name); continue; }
      files.push({ path: full, name, size: s.size });
    }
  } else if (st.isFile()) {
    if (!ACCEPT_RE.test(abs)) die(`Not a JPG, MP4, MOV or M4V: ${p}`);
    files.push({ path: abs, name: basename(abs), size: st.size });
  }
}
if (!files.length) die(`No JPG or MP4 / MOV / M4V files found in: ${paths.join(", ")}`);
files.sort((a, b) => natural(a.name, b.name));
const bySafe = new Map();
for (const f of files) {
  f.safe = safeFilename(f.name);
  f.kind = isVideo(f.safe) ? "video" : "photo";
  if (f.size === 0) die(`Empty file: ${f.path}`);
  if (bySafe.has(f.safe)) die(`Two files would land under the same name "${f.safe}":\n  ${bySafe.get(f.safe).path}\n  ${f.path}`);
  bySafe.set(f.safe, f);
}

// ---- portal calls ----
async function postJson(path, body, timeoutMs = 60_000) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

async function listListings() {
  const r = await postJson("/api/portal/admin-api", { op: "listListings" }).catch((e) => die(`Could not reach ${BASE}: ${e.message}`));
  if (r.status === 404 && !r.json?.error) die(`The admin API refused the token at ${BASE} (404). Check MIGRATE_TOKEN.`);
  if (!r.json?.ok) die(`listListings failed (HTTP ${r.status}): ${r.json?.error ?? r.text.slice(0, 200)}`);
  return r.json.listings;
}

async function uploadUrls(listingId, batch) {
  const r = await postJson(`/api/studio/listings/${listingId}/upload-urls`, {
    files: batch.map((f) => ({ filename: f.name, size: f.size })),
    section: opts.section ?? undefined,
  });
  if (r.status === 401) die(`upload-urls answered 401 at ${BASE}: this deployment does not accept the token yet (the push-to-listing PR is not deployed there).`);
  if (!r.json?.ok) throw new Error(`upload-urls failed (HTTP ${r.status}): ${r.json?.error ?? r.text.slice(0, 200)}`);
  const slots = new Map();
  for (const s of r.json.files) slots.set(s.safeFilename, { url: s.url, contentType: s.contentType, key: s.key });
  return slots;
}

// Stream one file to a presigned URL with an explicit Content-Length (R2 refuses
// chunked PUTs). Rejects with .status on a non-2xx answer.
function putFile(url, file, contentType) {
  return new Promise((resolvePut, rejectPut) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(u, { method: "PUT", headers: { "Content-Type": contentType, "Content-Length": file.size } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { if (body.length < 2000) body += c; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolvePut();
        else rejectPut(Object.assign(new Error(`HTTP ${res.statusCode}${body.includes("<Code>") ? ` ${body.match(/<Code>([^<]+)/)?.[1] ?? ""}` : ""}`), { status: res.statusCode }));
      });
    });
    req.setTimeout(PUT_IDLE_MS, () => req.destroy(new Error(`no progress for ${PUT_IDLE_MS / 1000} s`)));
    req.on("error", rejectPut);
    const stream = createReadStream(file.path);
    let sent = 0;
    const beat = file.size > 200e6 ? setInterval(() => console.log(`  ...  ${file.name}  ${Math.round((sent / file.size) * 100)}% of ${fmt(file.size)}`), 30_000) : null;
    stream.on("data", (c) => { sent += c.length; });
    stream.on("error", (e) => req.destroy(e));
    req.on("close", () => { stream.destroy(); clearInterval(beat); });
    stream.pipe(req);
  });
}

async function putWithRetries(listingId, file, slot, log) {
  let current = slot;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    try {
      await putFile(current.url, file, current.contentType);
      const secs = (Date.now() - t0) / 1000;
      log(`  put  ${file.name}  ${fmt(file.size)}  ${secs.toFixed(1)} s${secs > 0 ? `  ${fmt(file.size / secs)}/s` : ""}`);
      return true;
    } catch (e) {
      if (attempt >= PUT_BACKOFF.length) {
        log(`  FAIL ${file.name}: ${e.message}`);
        file.error = `upload: ${e.message}`;
        return false;
      }
      log(`  retry ${file.name} (${e.message}), attempt ${attempt + 2} of ${PUT_BACKOFF.length + 1}`);
      await sleep(PUT_BACKOFF[attempt]);
      if (e.status === 403) {
        try { current = (await uploadUrls(listingId, [file])).get(file.safe) ?? current; } catch {}
      }
    }
  }
}

// One ingest call. Retries are safe (same name in the same section replaces in
// place), but never while an earlier call may still be writing: after a lost
// response wait until the server's budget has run out.
async function ingestOnce(listingId, names) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    try {
      const r = await postJson(`/api/studio/listings/${listingId}/ingest`, { files: names, section: opts.section ?? undefined, published: !opts.hidden, run: RUN }, INGEST_TIMEOUT_MS);
      if (r.json?.ok) return r.json;
      if (r.status === 401) die(`ingest answered 401 at ${BASE}: this deployment does not accept the token yet.`);
      if (r.status < 500) return { error: `HTTP ${r.status}: ${r.json?.error ?? r.text.slice(0, 200)}`, retryable: false };
      console.log(`  ingest HTTP ${r.status} for ${names.join(", ")}, retrying`);
      await sleep(3000);
    } catch (e) {
      const wait = Math.max(0, INGEST_SETTLE_MS - (Date.now() - t0));
      console.log(`  ingest lost its answer (${e.name === "TimeoutError" ? "timeout" : e.message}); waiting ${Math.round(wait / 1000)} s before retrying`);
      await sleep(wait);
    }
  }
  return { error: "ingest failed after 3 attempts", retryable: true };
}

async function ingest(listingId, batch, totals) {
  let r = await ingestOnce(listingId, batch.map((f) => f.safe));
  if (r.error && r.retryable && batch.length > 1) {
    console.log(`  ingest batch failed (${r.error}); retrying one file at a time`);
    for (const f of batch) await ingest(listingId, [f], totals);
    return;
  }
  if (r.error) r = { added: [], replaced: [], failed: batch.map((f) => ({ filename: f.safe, error: r.error })) };
  const seen = new Set();
  for (const x of r.added) { totals.added.push(x.filename); seen.add(x.filename); console.log(`  add  ${x.filename}`); }
  for (const x of r.replaced) { totals.replaced.push(x.filename); seen.add(x.filename); console.log(`  repl ${x.filename}`); }
  for (const x of r.failed) { totals.failed.push({ filename: x.filename, error: `ingest: ${x.error}` }); seen.add(x.filename); console.log(`  FAIL ${x.filename}: ${x.error}`); }
  for (const f of batch) if (!seen.has(f.safe)) totals.failed.push({ filename: f.safe, error: "ingest: not in the answer" });
}

// Read the client-facing order back from the listing's share page (ordered by
// media.sort, client-visible rows only) and check the new files sit in order.
async function checkOrder(listing, addedNames) {
  if (opts.hidden) return "skipped (rows are hidden, the share page only shows live rows)";
  if (!listing.share_token) return "skipped (the listing has no share link)";
  if (!addedNames.length) return "nothing new to place";
  const h = { ...headers };
  delete h["Content-Type"];
  delete h["x-migrate-token"];
  const r = await fetch(`${BASE}/share/${encodeURIComponent(listing.share_token)}`, { headers: h, signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!r?.ok) return `skipped (share page answered ${r ? r.status : "nothing"})`;
  const html = await r.text();
  const want = new Set(addedNames);
  const got = [];
  for (const m of html.matchAll(/\\?"filename\\?"\s*:\s*\\?"([^"\\]*)\\?"/g)) if (want.has(m[1]) && !got.includes(m[1])) got.push(m[1]);
  const problems = [];
  for (const kind of ["photo", "video"]) {
    const exp = addedNames.filter((n) => (kind === "video") === isVideo(n));
    const act = got.filter((n) => (kind === "video") === isVideo(n));
    if (!exp.length) continue;
    const missing = exp.filter((n) => !act.includes(n));
    if (missing.length) problems.push(`${missing.length} new ${kind}${missing.length === 1 ? "" : "s"} not on the share page yet: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`);
    else if (exp.join("\n") !== act.join("\n")) problems.push(`new ${kind}s out of order. Expected ${exp.join(", ")}; page shows ${act.join(", ")}`);
  }
  return problems.length ? `CHECK: ${problems.join("; ")}` : `ok (${addedNames.length} new file${addedNames.length === 1 ? "" : "s"} in order on the share page)`;
}

// ---- run ----
const listings = await listListings();
const listing = listings.find((l) => l.slug === slug);
if (!listing) {
  const words = slug.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 || /^\d+$/.test(w));
  const near = listings.filter((l) => words.some((w) => `${l.slug} ${l.address}`.toLowerCase().includes(w))).slice(0, 8);
  die(`No listing with slug "${slug}" at ${BASE}. This script never creates one.${near.length ? `\nClose matches:\n${near.map((l) => `  ${l.slug}  (${l.address})`).join("\n")}` : ""}`);
}

const photos = files.filter((f) => f.kind === "photo");
const videos = files.filter((f) => f.kind === "video");
const total = files.reduce((a, f) => a + f.size, 0);
const ndaLabel = listing.nda === true ? "YES" : listing.nda === false ? "no" : "unknown (this deployment's listListings has no nda field yet)";
console.log(`Portal     ${BASE}`);
console.log(`Listing    ${listing.address}  (slug ${listing.slug}, id ${listing.id})`);
console.log(`Client     ${listing.client_name ?? ""}${listing.client_email ? ` <${listing.client_email}>` : ""}`);
console.log(`State      NDA ${ndaLabel} · downloads ${listing.download_locked ? "locked" : "unlocked"} · cover ${listing.cover_key ? listing.cover_key : "none"} · media_count ${listing.media_count}`);
console.log(`Target     ${opts.section ? `section "${opts.section}"` : "main gallery"} · ${opts.hidden ? "Internal only (review, then make visible in the admin)" : "client visible (published: true)"}`);
console.log(`Files      ${files.length} (${photos.length} photo${photos.length === 1 ? "" : "s"}, ${videos.length} film${videos.length === 1 ? "" : "s"}), ${fmt(total)}${skipped.length ? `; skipped ${skipped.length} other file${skipped.length === 1 ? "" : "s"} (${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", ..." : ""})` : ""}`);
files.forEach((f, i) => console.log(`  ${String(i + 1).padStart(3)}. ${f.name}${f.safe !== f.name ? ` -> ${f.safe}` : ""}  ${fmt(f.size)}  ${uploadKey(listing.slug, opts.section, f.safe)}`));
console.log("Same name in the same section replaces in place; new names are added at the end in this order.");

const ndaBlocked = listing.nda === true || (listing.nda !== false && !opts.dry);
if (ndaBlocked && !opts.ndaOk) {
  die(listing.nda === true
    ? `\nRefusing: ${listing.address} is flagged NDA. Its media must never be posted, shared or demoed. Pass --nda-ok only if the owner said so for this listing.`
    : `\nRefusing: this deployment does not report the NDA flag, so NDA cannot be ruled out. Deploy the push-to-listing PR first, or pass --nda-ok if the owner confirmed it is not NDA.`);
}
if (opts.dry) {
  console.log("\nDry run: nothing uploaded, nothing written.");
  process.exit(0);
}

const totals = { added: [], replaced: [], failed: [] };
const RUN = randomUUID();
const t0 = Date.now();
for (let b = 0; b < files.length; b += URL_BATCH) {
  const batch = files.slice(b, b + URL_BATCH);
  console.log(`\nBatch ${b / URL_BATCH + 1} of ${Math.ceil(files.length / URL_BATCH)}: ${batch.length} file${batch.length === 1 ? "" : "s"}`);
  let slots;
  try { slots = await uploadUrls(listing.id, batch); } catch (e) {
    console.log(`  ${e.message}`);
    for (const f of batch) totals.failed.push({ filename: f.safe, error: e.message });
    continue;
  }
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const f = batch[next++];
      const slot = slots.get(f.safe);
      if (!slot) { f.error = "upload: not accepted by the server"; console.log(`  FAIL ${f.name}: not accepted by the server`); continue; }
      f.uploaded = await putWithRetries(listing.id, f, slot, (line) => console.log(line));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PUT_CONCURRENCY, batch.length) }, worker));
  for (const f of batch) if (!f.uploaded) totals.failed.push({ filename: f.safe, error: f.error ?? "upload failed" });
  const landed = batch.filter((f) => f.uploaded); // still in natural order
  for (let i = 0; i < landed.length; i += INGEST_BATCH) await ingest(listing.id, landed.slice(i, i + INGEST_BATCH), totals);
}

// One hub line for the whole push.
await postJson(`/api/studio/listings/${listing.id}/upload-done`, { run: RUN, total: files.length, failed: totals.failed.map((f) => ({ name: f.filename, error: f.error })), published: !opts.hidden, section: opts.section ?? undefined }).catch((e) => console.log(`  (the hub summary did not post: ${e.message})`));

const after = (await listListings()).find((l) => l.id === listing.id);
const order = await checkOrder(listing, files.map((f) => f.safe).filter((n) => totals.added.includes(n)));
const delta = after ? after.media_count - listing.media_count : null;
console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)} s`);
console.log(`Added      ${totals.added.length}`);
console.log(`Replaced   ${totals.replaced.length}`);
console.log(`Failed     ${totals.failed.length}`);
for (const f of totals.failed) console.log(`  ${f.filename}: ${f.error}`);
console.log(`media_count ${listing.media_count} -> ${after ? after.media_count : "?"}${delta !== null ? ` (${delta >= 0 ? "+" : ""}${delta})` : ""}`);
if (delta !== null && delta !== totals.added.length) console.log(`  CHECK: media_count moved by ${delta} but ${totals.added.length} were added (someone else editing, or a duplicate row).`);
console.log(`Order      ${order}`);
console.log(`Cover, lock, invoices and email untouched.`);
process.exit(totals.failed.length ? 1 : 0);
