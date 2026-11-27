// Folder drops on Upload a shoot (Oct 27 2026). A folder dropped on the
// Photos or Video box (or picked with "Choose folder") is walked, subfolders
// too, and every file keeps its path from the dropped folder down
// ("2311 Example Elm Street - 413 raw", "video/A001"). The upload sends that path
// along and the Dropbox copy recreates it inside the listing folder; editing
// sees the photos exactly as before. Hidden and system files are left out.
// Pure (browser entry objects in, plain objects out) so
// scripts/check-folder-drop.ts can run it on fakes.

export type Picked = { file: File; dir: string };

const SKIP = /^(\..*|__MACOSX|Thumbs\.db|desktop\.ini)$/i;
export const skipName = (name: string): boolean => SKIP.test(name);

// The folder a picked file sat in: "" for a loose file, else the folder part
// of webkitRelativePath (set by a "Choose folder" pick).
export function dirOf(f: { webkitRelativePath?: string }): string {
  const p = f.webkitRelativePath || "";
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

// The dropped items as entries. Call it inside the drop event, before any
// await: the browser empties the DataTransfer once the handler yields.
export function dropEntries(dt: DataTransfer): FileSystemEntry[] {
  const out: FileSystemEntry[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== "file") continue;
    const en = it.webkitGetAsEntry?.();
    if (en) out.push(en);
  }
  return out;
}

const fileOf = (en: FileSystemFileEntry) => new Promise<File>((res, rej) => en.file(res, rej));
const readBatch = (r: FileSystemDirectoryReader) => new Promise<FileSystemEntry[]>((res, rej) => r.readEntries(res, rej));

async function walk(en: FileSystemEntry, dir: string, out: Picked[]): Promise<void> {
  if (skipName(en.name)) return;
  if (en.isFile) {
    out.push({ file: await fileOf(en as FileSystemFileEntry), dir });
    return;
  }
  if (!en.isDirectory) return;
  const sub = dir ? `${dir}/${en.name}` : en.name;
  const reader = (en as FileSystemDirectoryEntry).createReader();
  // readEntries hands a folder over in batches (100 at a time in Chrome)
  // until it returns an empty one.
  for (;;) {
    const batch = await readBatch(reader);
    if (!batch.length) break;
    const files = batch.filter((c) => c.isFile);
    const folders = batch.filter((c) => c.isDirectory);
    const got = await Promise.all(files.filter((c) => !skipName(c.name)).map(async (c) => ({ file: await fileOf(c as FileSystemFileEntry), dir: sub })));
    out.push(...got);
    for (const c of folders) await walk(c, sub, out);
  }
}

// Every file under the dropped entries, a loose file with dir "".
export async function walkEntries(entries: FileSystemEntry[]): Promise<Picked[]> {
  const out: Picked[] = [];
  for (const en of entries) await walk(en, "", out);
  return out;
}

// The name the server stores (src/lib/r2.ts safeFilename), so two files that
// would land on the same name are caught before upload.
export function storedName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "file";
}
