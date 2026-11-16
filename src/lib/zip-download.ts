// A store-only zip of R2 objects, streamed straight to the browser (JPEGs do
// not compress), one object open at a time. Used by the admin and QA team
// downloads for editing (shoot and listing routes). Never a client route:
// client zips are the prebuilt bundles behind /api/portal/bundle.
import { ZipArchive } from "archiver";
import { PassThrough, Readable } from "node:stream";
import { getObjectStream } from "./r2";
import { brand } from "@/lib/brand";

export type ZipEntry = { key: string; name: string };

// Unique names inside the zip (sections can repeat a base name). The first
// keeps its exact filename so a corrected file matches its frame by name.
export function zipEntries(rows: { r2Key: string; filename: string }[]): ZipEntry[] {
  const seen = new Map<string, number>();
  return rows.map((f) => {
    let name = f.filename;
    const n = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), n + 1);
    if (n) name = name.replace(/(\.[^.]+)?$/, (ext) => `-${n + 1}${ext}`);
    return { key: f.r2Key, name };
  });
}

export function zipResponse(entries: ZipEntry[], zipName: string, tag = "studio/download"): Response {
  const archive = new ZipArchive({ store: true });
  const out = new PassThrough();
  archive.pipe(out);
  let i = 0;
  const fail = (e: unknown) => {
    console.error(`[${tag}] zip failed`, e);
    archive.abort();
    out.destroy(e instanceof Error ? e : new Error(String(e)));
  };
  // Append one object at a time so only one R2 stream is open.
  const next = async () => {
    if (i >= entries.length) { await archive.finalize(); return; }
    const e = entries[i++];
    const { body } = await getObjectStream(e.key);
    archive.append(body, { name: e.name });
  };
  archive.on("entry", () => { next().catch(fail); });
  archive.on("error", fail);
  next().catch(fail);
  return new Response(Readable.toWeb(out) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
    },
  });
}

// "1420 Alder Drive" (or "the business" for an NDA listing) for zip names.
export const zipStreet = (address: string, nda: boolean) => (nda ? `${brand.shortName}` : address.split(",")[0].trim().replace(/[^A-Za-z0-9 ]+/g, "").trim() || `${brand.shortName}`);
