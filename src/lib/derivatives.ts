// Derivatives for one finished frame, in process with sharp. Mirrors
// scripts/make-derivatives.py so pipeline uploads and script uploads look the
// same in the portal:
//   thumb 600px q70 · thumb-wm · preview 1600px q78 · preview-wm · mls 2048px q85
// Plus, for the cover photo only: cover 3200px q84 · cover-wm (the gallery
// hero), made on demand by ensureCoverDerivative, never for every frame.
// Watermark: the business mark (public/brand/watermark.png), centered, at
// 30% opacity and WM_WIDTH (default 30%) of the image width.
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type Sharp } from "sharp";
import { derivativeKey } from "./media-keys";
import { siteUrl } from "./brand";
import { getObjectBuffer, headObject, putObject } from "./r2";
import { pixelCost, withOriginalSlot, withPixelBudget } from "./image-gate";

// Every photo here is decoded once and never again, so libvips's operation
// cache only holds memory for nothing.
sharp.cache(false);

// Every decode of a full-size original goes through here (Nov 10 2026,
// src/lib/image-gate.ts): it waits until this instance has room for the
// photo's megapixels. Reading the header for the size costs nothing.
async function decodeGated<T>(original: Buffer, fn: () => Promise<T>): Promise<T> {
  const meta = await sharp(original, { failOn: "none" }).metadata().catch(() => ({}) as { width?: number; height?: number; isProgressive?: boolean });
  return withPixelBudget(pixelCost(meta), fn);
}

// Full-size input, read top to bottom instead of held whole in memory.
const open = (original: Buffer) => sharp(original, { failOn: "none", sequentialRead: true }).rotate(); // honour EXIF orientation

export type Variant = "thumb" | "thumb-wm" | "preview" | "preview-wm" | "mls" | "cover" | "cover-wm";
export type Derivative = { variant: Variant; key: string; buffer: Buffer };

let markCache: Buffer | null = null;
async function markPng(): Promise<Buffer> {
  if (markCache) return markCache;
  try {
    // Literal path so Next's file tracing bundles the asset with the function.
    markCache = await readFile(path.join(process.cwd(), "public", "brand", "watermark.png"));
  } catch {
    const r = await fetch(`${siteUrl()}/brand/watermark.png`);
    if (!r.ok) throw new Error("watermark asset unavailable");
    markCache = Buffer.from(await r.arrayBuffer());
  }
  return markCache;
}

// The mark resized to the target width with its alpha scaled to 30%.
async function markFor(width: number): Promise<Buffer> {
  const wmFrac = Number(process.env.WM_WIDTH || "0.30") || 0.3;
  const lw = Math.max(1, Math.round(width * wmFrac));
  const { data, info } = await sharp(await markPng()).resize({ width: lw }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * 0.3);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function resized(src: Sharp, longEdge: number, quality: number): Promise<{ buffer: Buffer; width: number }> {
  const img = src.clone().resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true });
  const { data, info } = await img.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width };
}

async function watermarked(jpeg: Buffer, width: number, quality: number): Promise<Buffer> {
  const mark = await markFor(width);
  return sharp(jpeg).composite([{ input: mark, gravity: "centre" }]).jpeg({ quality, mozjpeg: true }).toBuffer();
}

// originalKey decides where the derivatives land (listings/<slug>/d/<variant>/<name>.jpg).
// Nov 11 2026 (3330 Example Cedar Road, 100 MP finals): the original is decoded
// once, to the 2048px MLS size (kept as raw pixels, so no extra JPEG
// generation), and the preview and thumb are made from that. It used to be
// three decodes of the full original at once for every photo. That one
// decode is the only heavy step, and it waits its turn (decodeGated).
export async function makeDerivatives(original: Buffer, originalKey: string): Promise<Derivative[]> {
  const { data, info } = await decodeGated(original, () =>
    open(original)
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true })
  );
  const src = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
  const mls = { buffer: await src.clone().jpeg({ quality: 85, mozjpeg: true }).toBuffer() };
  const [preview, thumb] = await Promise.all([resized(src, 1600, 78), resized(src, 600, 70)]);
  const [previewWm, thumbWm] = await Promise.all([watermarked(preview.buffer, preview.width, 78), watermarked(thumb.buffer, thumb.width, 70)]);
  return [
    { variant: "preview", key: derivativeKey(originalKey, "preview"), buffer: preview.buffer },
    { variant: "preview-wm", key: derivativeKey(originalKey, "preview-wm"), buffer: previewWm },
    { variant: "thumb", key: derivativeKey(originalKey, "thumb"), buffer: thumb.buffer },
    { variant: "thumb-wm", key: derivativeKey(originalKey, "thumb-wm"), buffer: thumbWm },
    { variant: "mls", key: derivativeKey(originalKey, "mls"), buffer: mls.buffer },
  ];
}

// Just the thumb, for lazy generation on first view.
export async function makeThumb(original: Buffer): Promise<Buffer> {
  return (await decodeGated(original, () => resized(open(original), 600, 70))).buffer;
}

// A 1600px preview (no watermark), for the automatic QC pass when the stored
// preview derivative is missing.
export async function makePreview(original: Buffer): Promise<Buffer> {
  return (await decodeGated(original, () => resized(open(original), 1600, 78))).buffer;
}

// The 2048px MLS size (no watermark), for the opened photo in final review
// when the stored derivative is missing (uploads from before the pipeline
// made one).
export async function makeMls(original: Buffer): Promise<Buffer> {
  return (await decodeGated(original, () => resized(open(original), 2048, 85))).buffer;
}

// Bake the business mark into a finished JPEG derivative. The previous portal move
// copies the clean preview and thumb and makes the "-wm" pair here, because the
// the previous portal "-wm" objects carry the JG mark and are never copied.
export async function watermarkJpeg(jpeg: Buffer, quality = 78): Promise<Buffer> {
  const meta = await sharp(jpeg).metadata();
  return watermarked(jpeg, meta.width ?? 1600, quality);
}

// ---- Cover (gallery hero) ---------------------------------------------------

const COVER_EDGE = 3200;
const COVER_Q = 84;

// The 3200px cover pair from an original: clean, and with the business mark baked
// in exactly like the other "-wm" variants.
export async function makeCover(original: Buffer): Promise<{ clean: Buffer; watermarked: Buffer }> {
  const cover = await decodeGated(original, () => resized(open(original), COVER_EDGE, COVER_Q));
  return { clean: cover.buffer, watermarked: await watermarked(cover.buffer, cover.width, COVER_Q) };
}

// One build per cover key at a time in this instance (two gallery views in the
// same second should not both resize a 40 MB original).
const coverInflight = new Map<string, Promise<string | null>>();

// Make sure the cover derivatives exist for a listing's cover photo, and return
// the R2 key of the one the gallery should show (cover-wm while downloads are
// locked, cover once paid), or null when it could not be made.
//
// coverKey is the cover's ORIGINAL key (listings.cover_key). Missing variants
// are built from the original (download, resize to 3200px, upload); variants
// already in R2 are left alone. Both are made together so an unlock later
// needs no rebuild. Never throws.
//
// Called from the gallery page inside after() when the cover is missing, and
// meant to be called by the admin "Set as cover" action too, so the very first
// client view is already full resolution.
export async function ensureCoverDerivative(coverKey: string, locked: boolean): Promise<string | null> {
  const wantKey = derivativeKey(coverKey, locked ? "cover-wm" : "cover");
  let job = coverInflight.get(coverKey);
  if (!job) {
    job = buildCover(coverKey).finally(() => coverInflight.delete(coverKey));
    coverInflight.set(coverKey, job);
  }
  const ok = await job;
  return ok ? wantKey : null;
}

async function buildCover(coverKey: string): Promise<string | null> {
  try {
    const cleanKey = derivativeKey(coverKey, "cover");
    const wmKey = derivativeKey(coverKey, "cover-wm");
    const [clean, wm] = await Promise.all([headObject(cleanKey), headObject(wmKey)]);
    if (clean && wm) return cleanKey;
    const made = await withOriginalSlot(async () => makeCover((await getObjectBuffer(coverKey)).body));
    await Promise.all([
      clean ? null : putObject(cleanKey, made.clean, "image/jpeg"),
      wm ? null : putObject(wmKey, made.watermarked, "image/jpeg"),
    ]);
    return cleanKey;
  } catch (e) {
    console.error(`cover derivative failed for ${coverKey}:`, e);
    return null;
  }
}
