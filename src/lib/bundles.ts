// "Download all" zips, rebuilt by the bundle.rebuild job (queued whenever a
// change touches what a client can see: uploads, deletions, renames, sections,
// revised flags, visibility, QC calls and publishes, plus the "Rebuild zips"
// button; src/lib/bundle-jobs.ts). Same keys the portal's bundle route serves:
//   listings/<slug>/bundles/photos-full.zip          EVERY photo and film, originals, one folder per area
//   listings/<slug>/bundles/photos-mls.zip           every photo at 2048px, same folders (no films)
//   listings/<slug>/bundles/photos-<section>.zip     one named section's photos and films
//   listings/<slug>/bundles/photos-<section>-mls.zip that section's photos at 2048px
//   listings/<slug>/bundles/group-<area>.zip         one gallery area: photos, revised, films, revised-films
//   listings/<slug>/bundles/group-<area>-mls.zip     a photo area at 2048px (photos, revised)
// Only client-visible media (approved, published, shoot published) goes in.
//
// Oct 27 2026 (1030 Example Magnolia Drive: "Download all" gave the 61 main
// photos and none of the 17 New Images or 12 Revised Images): "Download all"
// is everything the client can see (#48). Rule (Oct 27 2026): every
// photo AND film, and every area of the gallery has its own download too.
// With only main gallery photos the files sit at the top of the zip as
// before; otherwise each area is a folder: "Photos" (the main gallery),
// "Revised" (revision photos without a section), "Films", "Revised films",
// and one folder per named section (its photos and films). The MLS zip has
// the same folders, photos only (MLS specs are for photos). The area zips
// ("Download <area>" buttons) are built only when the gallery has more than
// one area, since otherwise they would repeat "Download all".
//
// Each zip is streamed object by object into a multipart upload: no file is
// ever held in memory whole, films included, and entries are stored, not
// compressed (JPEGs and films do not shrink). Photo-only zips are written
// first and the full zip, the big one, last, so the photo zips are fresh even
// if a rebuild with large films runs long.
//
// Nov 10 2026: a rebuild no longer has to fit in one cron run. It used to be
// one stretch of work, cut off at the platform's 300 s when it started late
// in a run or simply needed longer, and begun again from zero (3330 Cedar
// Road: a rebuild that never ended, fifteen cut-off runs in 75 minutes).
// Now it works in slices:
// - The first run reads the rows once and keeps that list on the job
//   (payload.bundle), so every later run builds the same zips from the same
//   files in the same order, whatever changed in between.
// - The zips are written by src/lib/zip-resume.ts, 16 MB at a time into a
//   multipart upload. A run stops 20 seconds before its drain must return,
//   saves how far it got (which zip, which part, which file) and defers; the
//   next run sends the next part. Nothing already in storage is sent again,
//   so the size of a listing only decides how many runs it takes.
// - A zip lands (replaces the one clients download) only when it is whole.
// - One rebuild per listing at a time, and an older one never lands on top of
//   a newer one: see rebuildTurn in src/lib/bundle-jobs.ts.
// The cron gives these jobs their own pass (src/app/api/cron/pipeline).
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { groupGallery, type GroupArea } from "@/components/gallery/types";
import { logActivity } from "./activity";
import { BUNDLE_LEASE_MS, rebuildOthers, rebuildTurn } from "./bundle-jobs";
import { DeferError, drainDeadline, FatalJobError, SkipJobError } from "./jobs-core";
import { derivativeKey } from "./media-keys";
import { clientVisibleMedia } from "./media-visibility";
import { multipartAbort, multipartComplete, multipartPart, multipartStart, ObjectChangedError, openObject, UploadGoneError } from "./r2";
import { writeZip, ZIP_PART_BYTES, ZipSourceChanged, ZipUploadGone, type ZipCursor, type ZipFile, type ZipOptions, type ZipSource } from "./zip-resume";

const sectionSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

type Media = { r2Key: string; filename: string; kind: string; revision: boolean; section: string | null; sort: number; createdAt: Date };

// Folder names of the gallery areas that are not named sections.
const GROUP_FOLDER: Record<GroupArea, string> = { photos: "Photos", revised: "Revised", films: "Films", "revised-films": "Revised films" };

// A section title as a folder name every OS accepts: no path separators or
// reserved characters, no leading or trailing dots and spaces, not too long.
export function zipFolderName(title: string): string {
  const clean = title
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80)
    .trim();
  return clean || "Section";
}

// Entry names, unique inside their folder (case-insensitively, as Finder and
// Explorer compare them): a repeat becomes "name (2).jpg", "name (3).jpg". A
// folder keeps its first spelling, so a section called "films" shares "Films".
function uniqueNamer() {
  const taken = new Set<string>();
  const spelled = new Map<string, string>();
  return (rawFolder: string | null, filename: string): string => {
    const folder = rawFolder === null ? null : (spelled.get(rawFolder.toLowerCase()) ?? (spelled.set(rawFolder.toLowerCase(), rawFolder), rawFolder));
    const base = filename.split(/[\\/]/).pop() || "file";
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${stem} (${n})${ext}`;
      const path = folder ? `${folder}/${name}` : name;
      if (!taken.has(path.toLowerCase())) {
        taken.add(path.toLowerCase());
        return path;
      }
    }
  };
}

export type ZipArea<T> = { group: GroupArea | null; section: string | null; folder: string; photos: T[]; videos: T[] };

// The gallery's areas, grouped exactly as the client gallery groups them
// (groupGallery), empty ones left out. Zip order: main photos, revised,
// named sections, then films.
export function zipAreas<T extends Media>(media: T[]): ZipArea<T>[] {
  const rows = [...media].sort((a, b) => a.sort - b.sort || a.createdAt.getTime() - b.createdAt.getTime()).map((m) => ({ m, revised: m.revision, section: m.section }));
  const g = groupGallery(rows.filter((r) => r.m.kind === "photo"), rows.filter((r) => r.m.kind === "video"));
  const un = (list: { m: T }[]) => list.map((r) => r.m);
  const group = (id: GroupArea, photos: { m: T }[], videos: { m: T }[]): ZipArea<T> => ({ group: id, section: null, folder: GROUP_FOLDER[id], photos: un(photos), videos: un(videos) });
  return [
    group("photos", g.photos, []),
    group("revised", g.revisedPhotos, []),
    ...g.sections.map((s) => ({ group: null, section: s.name, folder: zipFolderName(s.name), photos: un(s.photos), videos: un(s.videos) })),
    group("films", [], g.films),
    group("revised-films", [], g.revisedFilms),
  ].filter((a) => a.photos.length + a.videos.length > 0);
}

const mlsName = (name: string) => name.replace(/\.[^.]+$/, "") + ".jpg";

// One zip of photos and films: originals (films included) or the 2048px set (photos only).
function entries(areas: { folder: string | null; photos: Media[]; videos: Media[] }[], mls: boolean): ZipFile[] {
  const name = uniqueNamer();
  const out: ZipFile[] = [];
  for (const a of areas) {
    for (const m of a.photos) out.push(mls ? { key: derivativeKey(m.r2Key, "mls"), name: name(a.folder, mlsName(m.filename)) } : { key: m.r2Key, name: name(a.folder, m.filename) });
    if (!mls) for (const m of a.videos) out.push({ key: m.r2Key, name: name(a.folder, m.filename) });
  }
  return out;
}

// ---- The plan --------------------------------------------------------------------

export type BundleSummary = { full: number; mls: number; sections: string[]; groups: GroupArea[]; folders: Record<string, number> };
// Every zip a listing gets, in the order they are built.
export type BundlePlan = { zips: { key: string; files: ZipFile[] }[]; mlsAt: number; fullAt: number; sections: string[]; groups: GroupArea[]; folders: Record<string, number> };

export function planBundles(slug: string, visible: Media[]): BundlePlan {
  const areas = zipAreas(visible);
  const foldered = areas.length > 1 || (areas.length === 1 && areas[0].group !== "photos");
  const inFolders = areas.map((a) => ({ ...a, folder: foldered ? a.folder : null }));
  const base = `listings/${slug}/bundles`;

  // The area zips, then the two "Download all" zips.
  const zips: { key: string; files: ZipFile[]; films: boolean }[] = [];
  const sections: string[] = [];
  const groups: GroupArea[] = [];
  for (const a of areas) {
    const flat = [{ folder: null, photos: a.photos, videos: a.videos }];
    let stem: string | null = null;
    if (a.section !== null) {
      const s = sectionSlug(a.section);
      if (s) {
        stem = `photos-${s}`;
        sections.push(a.section);
      }
    } else if (a.group && areas.length > 1) {
      stem = `group-${a.group}`;
      groups.push(a.group);
    }
    if (!stem) continue;
    zips.push({ key: `${base}/${stem}.zip`, files: entries(flat, false), films: a.videos.length > 0 });
    if (a.photos.length) zips.push({ key: `${base}/${stem}-mls.zip`, files: entries(flat, true), films: false });
  }
  const mlsFiles = entries(inFolders, true);
  const fullFiles = entries(inFolders, false);

  // Photo-only zips first, then the area zips that carry films, the full zip last.
  const light = zips.filter((z) => !z.films).map(({ key, files }) => ({ key, files }));
  const heavy = zips.filter((z) => z.films).map(({ key, files }) => ({ key, files }));
  const order = [...light, { key: `${base}/photos-mls.zip`, files: mlsFiles }, ...heavy, { key: `${base}/photos-full.zip`, files: fullFiles }];

  // Files per folder of the full zip (a section named like an area shares its folder).
  const folders: Record<string, number> = {};
  for (const f of fullFiles) {
    const dir = f.name.includes("/") ? f.name.slice(0, f.name.indexOf("/")) : "(top level)";
    folders[dir] = (folders[dir] ?? 0) + 1;
  }
  return { zips: order, mlsAt: light.length, fullAt: order.length - 1, sections, groups, folders };
}

// What a rebuild read from the rows, kept on the job so every run of it
// builds from the same list: the client-visible photos and films in gallery
// order, as short as it can be (it is saved again at every checkpoint).
export type BundleMedia = { k: string; f: string; v?: 1; r?: 1; s?: string };

export function freezeMedia(visible: Media[]): BundleMedia[] {
  return [...visible]
    .sort((a, b) => a.sort - b.sort || a.createdAt.getTime() - b.createdAt.getTime())
    .map((m) => ({ k: m.r2Key, f: m.filename, ...(m.kind === "video" ? { v: 1 as const } : {}), ...(m.revision ? { r: 1 as const } : {}), ...(m.section ? { s: m.section } : {}) }));
}

export function thawMedia(media: BundleMedia[], at: Date): Media[] {
  return media.map((m, i) => ({ r2Key: m.k, filename: m.f, kind: m.v ? "video" : "photo", revision: Boolean(m.r), section: m.s ?? null, sort: i, createdAt: at }));
}

// ---- A rebuild, in slices ----------------------------------------------------------

// payload.bundle of a bundle.rebuild job: where the rebuild stands. Its
// presence is what "this rebuild has begun" means (src/lib/bundle-jobs.ts).
export type BundleProgress = {
  v: 1;
  at: string; // when the rows were read; also every file's date inside the zips
  slug: string;
  media?: BundleMedia[]; // dropped once the rebuild is done
  z: number; // zips finished
  n: number[]; // files in each finished zip
  zip?: ZipCursor; // the zip in flight
  bytes: number; // bytes of the finished zips
  runs: number; // runs that worked on it
  ms: number; // time spent working, all runs together
  restarts?: number; // zips that had to start over (a file replaced under them, an upload gone)
  done?: true;
  zips?: number;
  built?: BundleSummary;
};

// Storage as the rebuild sees it; the check script swaps in a fake.
export type BundleStore = {
  begin(key: string): Promise<string>;
  putPart(key: string, uploadId: string, n: number, body: Uint8Array): Promise<void>;
  finish(key: string, uploadId: string, parts: number, bytes: number): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  open(key: string, from: number, etag: string | null): Promise<ZipSource | null>;
};

const goneAsZip = (e: unknown): never => {
  throw e instanceof UploadGoneError ? new ZipUploadGone(e.message) : e;
};
const r2Store: BundleStore = {
  begin: (key) => multipartStart(key, "application/zip"),
  putPart: (key, uploadId, n, body) => multipartPart(key, uploadId, n, body).catch(goneAsZip),
  finish: (key, uploadId, parts, bytes) => multipartComplete(key, uploadId, { parts, bytes }).catch(goneAsZip),
  abort: multipartAbort,
  open: async (key, from, etag) => {
    try {
      const r = await openObject(key, from, etag);
      return r && { body: r.body as AsyncIterable<Uint8Array>, size: r.size, etag: r.etag, close: () => void r.body.destroy() };
    } catch (e) {
      throw e instanceof ObjectChangedError ? new ZipSourceChanged(e.message) : e;
    }
  },
};

export type BuildControl = {
  store: BundleStore;
  now(): number;
  stopAt: number; // on now(): nothing new is started after this
  save(b: BundleProgress): Promise<boolean>; // false: this run no longer holds the job
  mayLand(): Promise<boolean>; // false: a newer rebuild has begun
  zip?: Partial<ZipOptions>; // the check script uses small parts
};
export type BuildOutcome = { state: "done"; plan: BundlePlan } | { state: "paused" } | { state: "lost" } | { state: "stale" };

// A zip that keeps starting over (its files replaced again and again under
// it) becomes a normal failure after this many tries, with the usual backoff.
const MAX_RESTARTS = 3;

// Works on the rebuild until it is done or the time is up. `b` is updated in
// place and saved through ctl.save at every checkpoint and after every zip.
export async function buildZips(b: BundleProgress, ctl: BuildControl): Promise<BuildOutcome> {
  if (!b.media) throw new Error("zip rebuild: the list of files is missing from the job");
  const date = new Date(b.at);
  const plan = planBundles(b.slug, thawMedia(b.media, date));
  while (b.z < plan.zips.length) {
    if (ctl.now() >= ctl.stopAt) return (await ctl.save(b)) ? { state: "paused" } : { state: "lost" };
    const zip = plan.zips[b.z];
    const out = await writeZip(
      {
        begin: () => ctl.store.begin(zip.key),
        putPart: (uploadId, n, body) => ctl.store.putPart(zip.key, uploadId, n, body),
        finish: (uploadId, parts, bytes) => ctl.store.finish(zip.key, uploadId, parts, bytes),
        open: ctl.store.open,
        now: ctl.now,
        save: (cursor) => {
          b.zip = cursor;
          return ctl.save(b);
        },
        mayLand: ctl.mayLand,
      },
      zip.files,
      { ...ctl.zip, cursor: b.zip ?? null, stopAt: ctl.stopAt, date }
    );
    if (out.state === "paused") {
      b.zip = out.cursor;
      return { state: "paused" };
    }
    if (out.state === "lost") return { state: "lost" };
    if (out.state === "stale") {
      await ctl.store.abort(zip.key, out.uploadId).catch((e) => console.error("[bundles] dropping a zip a newer rebuild replaced", zip.key, e));
      delete b.zip;
      return { state: "stale" };
    }
    if (out.state === "restart") {
      console.warn(`[bundles] ${zip.key} starts over: ${out.why}`);
      await ctl.store.abort(zip.key, out.uploadId).catch((e) => console.error("[bundles] dropping a zip that starts over", zip.key, e));
      delete b.zip;
      b.restarts = (b.restarts ?? 0) + 1;
      if (!(await ctl.save(b))) return { state: "lost" };
      if (b.restarts > MAX_RESTARTS) throw new Error(`${zip.key.split("/").pop()} kept starting over: ${out.why}`);
      continue;
    }
    b.n[b.z] = out.files;
    b.bytes += out.bytes;
    b.z++;
    delete b.zip;
    if (!(await ctl.save(b))) return { state: "lost" };
  }
  return { state: "done", plan };
}

// ---- The job -----------------------------------------------------------------------

type JobRow = typeof schema.jobs.$inferSelect;

// A run never works longer than this in one go, even where no drain sets a
// deadline, and stops this long before the drain must return: the parts in
// flight finish (45 s at the very worst, usually one or two) and the cursor
// is saved, with the platform's limit still far off.
const SLICE_MAX_MS = 240_000;
const TAIL_MS = 20_000;
// With less than this left, the rebuild waits for the next run instead.
const MIN_SLICE_MS = 15_000;

const TOOK_OVER = "a newer rebuild of this listing took over";
const HELD = "another run holds this rebuild";
const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

// Every write to the job row from inside a run goes through here. It only
// lands while this run is still the one that claimed the job (the claim
// counts attempts up, so a run that outlived its lease and was claimed again
// no longer matches), and each one renews the lease.
async function saveProgress(job: JobRow, bundle: BundleProgress): Promise<boolean> {
  const rows = await db()
    .update(schema.jobs)
    .set({ payload: { ...(job.payload ?? {}), bundle }, leaseUntil: new Date(Date.now() + BUNDLE_LEASE_MS), updatedAt: new Date() })
    .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, "running"), eq(schema.jobs.attempts, job.attempts)))
    .returning({ id: schema.jobs.id });
  return rows.length > 0;
}

// The upload a rebuild leaves open when it stops for good.
async function dropOpenZip(b: BundleProgress | undefined): Promise<void> {
  if (!b?.zip || !b.media) return;
  const key = planBundles(b.slug, thawMedia(b.media, new Date(b.at))).zips[b.z]?.key;
  if (key) await r2Store.abort(key, b.zip.uploadId).catch((e) => console.error("[bundles] dropping an open zip", key, e));
}

export async function runBundleRebuild(job: JobRow): Promise<void> {
  const p = job.payload ?? {};
  if (!p.listingId) throw new FatalJobError("bundle.rebuild needs payload.listingId");
  const listingId = p.listingId;
  const me = { id: job.id, createdAt: job.createdAt };
  const turn = async () => rebuildTurn(me, await rebuildOthers(listingId, me), new Date());
  const now = await turn();
  if (now === "yield") {
    await dropOpenZip(p.bundle);
    throw new SkipJobError(TOOK_OVER);
  }
  // One rebuild per listing at a time: this one waits its turn.
  if (now === "wait") throw new DeferError("another zip rebuild of this listing is running", 30_000);

  const started = Date.now();
  const end = Math.min(drainDeadline(), started + SLICE_MAX_MS);
  const stopAt = end - TAIL_MS;
  // Not worth beginning: come back once this drain is over, so it is not asked again inside it.
  if (stopAt - started < MIN_SLICE_MS) throw new DeferError("waiting for a run with time left", Math.max(5_000, end - started + 1_000));

  let b: BundleProgress | null = p.bundle && !p.bundle.done && p.bundle.media ? p.bundle : null;
  if (!b) {
    const l = await db().query.listings.findFirst({
      where: eq(schema.listings.id, listingId),
      with: { media: true, shoots: { columns: { id: true, publishedAt: true } } },
    });
    if (!l) throw new SkipJobError("the listing is gone");
    const visible = clientVisibleMedia(l.media, l.shoots).filter((m) => m.kind === "photo" || m.kind === "video");
    b = { v: 1, at: new Date().toISOString(), slug: l.slug, media: freezeMedia(visible), z: 0, n: [], bytes: 0, runs: 0, ms: 0 };
  }
  const spent = b.ms;
  b.runs++;
  const save = (next: BundleProgress) => {
    next.ms = spent + (Date.now() - started);
    return saveProgress(job, next);
  };
  // On record before a byte moves: from here on this rebuild counts as begun.
  if (!(await save(b))) throw new DeferError(HELD, 30_000);

  const out = await buildZips(b, { store: r2Store, now: () => Date.now(), stopAt, save, mayLand: async () => (await turn()) !== "yield" });
  if (out.state === "lost") throw new DeferError(HELD, 30_000);
  if (out.state === "stale") throw new SkipJobError(TOOK_OVER);
  if (out.state === "paused") {
    const total = planBundles(b.slug, thawMedia(b.media ?? [], new Date(b.at))).zips.length;
    const sent = b.bytes + (b.zip?.parts ?? 0) * ZIP_PART_BYTES;
    throw new DeferError(`continuing: zip ${Math.min(b.z + 1, total)} of ${total}, ${mb(sent)} written so far`, 1_000);
  }

  const { plan } = out;
  const built: BundleSummary = { full: b.n[plan.fullAt] ?? 0, mls: b.n[plan.mlsAt] ?? 0, sections: plan.sections, groups: plan.groups, folders: plan.folders };
  const seconds = Math.round((spent + (Date.now() - started)) / 1000);
  await logActivity({ action: "bundles.rebuilt", listingId, meta: { ...built, zips: plan.zips.length, bytes: b.bytes, runs: b.runs, seconds } });
  // The list of files has done its work; what stays on the row is the result.
  await save({ v: 1, at: b.at, slug: b.slug, z: b.z, n: b.n, bytes: b.bytes, runs: b.runs, ms: b.ms, ...(b.restarts ? { restarts: b.restarts } : {}), done: true, zips: plan.zips.length, built });
}
