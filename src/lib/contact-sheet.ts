// Numbered contact sheets of a listing's photos, for the revision intake
// (src/lib/revision-intake.ts): the model sees every photo at once with its
// number in a black box at the top left, and answers with numbers. Built from
// the small "thumb" derivatives in R2 (the original when a thumb is missing).
import sharp from "sharp";
import { getObjectBuffer } from "./r2";
import { derivativeKey } from "./media-keys";

const COLS = 5;
const ROWS = 6;
const CELL_W = 300;
const CELL_H = 200;
export const SHEET_SIZE = COLS * ROWS;

async function thumb(r2Key: string): Promise<Buffer | null> {
  for (const key of [derivativeKey(r2Key, "thumb"), r2Key]) {
    try {
      const { body } = await getObjectBuffer(key);
      return await sharp(body, { failOn: "none" }).rotate().resize({ width: CELL_W - 8, height: CELL_H - 8, fit: "inside" }).jpeg({ quality: 78 }).toBuffer();
    } catch {}
  }
  return null;
}

const label = (n: number) =>
  Buffer.from(`<svg width="54" height="30" xmlns="http://www.w3.org/2000/svg"><rect width="54" height="30" fill="#000"/><text x="27" y="22" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="700" fill="#ffd400" text-anchor="middle">${n}</text></svg>`);

// photos: in gallery order; numbering starts at 1. Returns JPEG sheets of up to 30.
export async function contactSheets(photos: { r2Key: string }[], concurrency = 12): Promise<Buffer[]> {
  const thumbs: (Buffer | null)[] = new Array(photos.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, photos.length) }, async () => {
      while (next < photos.length) {
        const i = next++;
        thumbs[i] = await thumb(photos[i].r2Key);
      }
    }),
  );
  const sheets: Buffer[] = [];
  for (let start = 0; start < photos.length; start += SHEET_SIZE) {
    const chunk = thumbs.slice(start, start + SHEET_SIZE);
    const rows = Math.ceil(chunk.length / COLS);
    const layers: sharp.OverlayOptions[] = [];
    for (let k = 0; k < chunk.length; k++) {
      const x = (k % COLS) * CELL_W;
      const y = Math.floor(k / COLS) * CELL_H;
      const img = chunk[k];
      if (img) {
        const meta = await sharp(img).metadata();
        layers.push({ input: img, left: x + Math.round((CELL_W - (meta.width ?? CELL_W)) / 2), top: y + Math.round((CELL_H - (meta.height ?? CELL_H)) / 2) });
      }
      layers.push({ input: label(start + k + 1), left: x + 4, top: y + 4 });
    }
    sheets.push(await sharp({ create: { width: COLS * CELL_W, height: rows * CELL_H, channels: 3, background: "#ebebeb" } }).composite(layers).jpeg({ quality: 80 }).toBuffer());
  }
  return sheets;
}

// A client's photo, ready for the model: upright, at most 1280px, JPEG.
export async function modelImage(bytes: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(bytes, { failOn: "none" }).rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  } catch {
    return null;
  }
}
