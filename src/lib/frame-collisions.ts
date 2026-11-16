// Repair for frames that overwrote each other (Oct 2026, see frame-names.ts).
//
// Two media rows collide when they share an original file (same r2_key: the
// later write replaced the earlier bytes) or only their derived files (thumb,
// preview, MLS, cover are keyed by the file name alone). For each group:
//   - the OLDEST row keeps its key and name (it is usually the published
//     frame: the client's gallery, revision notes, cover and zips point at
//     it). If its original was overwritten, it is fetched again from the
//     editing service (its shoot's photoshoot and image id) and written back;
//     a row with no editing source (a hand upload, a twilight) cannot be
//     restored here and is reported.
//   - every NEWER row moves to a free name on the listing. The newest writer's
//     bytes are what sits at the shared key, so they are copied over; a row in
//     between lost its bytes and is fetched again like the oldest.
//   - derivatives are rebuilt for every row touched, the full-size cover
//     files are rebuilt when the cover is involved, and the zips are rebuilt.
// Dry run by default: returns the plan without touching anything.
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import * as ah from "./autohdr";
import { editingIdsForImage } from "./pipeline";
import { makeCover, makeDerivatives } from "./derivatives";
import { enqueueBundleRebuild } from "./bundle-jobs";
import { derivativeKey } from "./media-keys";
import { getObjectBuffer, putObject } from "./r2";
import { logActivity } from "./activity";

type Row = {
  id: string;
  listingId: string;
  r2Key: string;
  filename: string;
  shootId: string | null;
  editorImageId: string | null;
  published: boolean;
  kind: string;
  createdAt: Date;
};

export type RepairStep = {
  mediaId: string;
  filename: string;
  action: "keep" | "restore" | "move" | "rebuild-derivatives";
  from?: string;
  to?: string;
  source?: "editing service" | "current file" | "own file";
  problem?: string;
};

export type CollisionGroup = { listingId: string; slug: string; address: string; sharedOriginal: boolean; steps: RepairStep[] };

const fileOf = (key: string) => key.split("/").pop() ?? key;
const dirOf = (key: string) => key.split("/").slice(0, -1).join("/");
const pad = (n: number) => String(n).padStart(2, "0");

export async function findCollisions(opts: { listingId?: string } = {}): Promise<CollisionGroup[]> {
  const d = db();
  const rows = (await d.query.media.findMany({
    where: opts.listingId ? eq(schema.media.listingId, opts.listingId) : undefined,
    columns: { id: true, listingId: true, r2Key: true, filename: true, shootId: true, editorImageId: true, published: true, kind: true, createdAt: true },
  })) as Row[];
  const photos = rows.filter((r) => r.kind === "photo");
  // Group by the thumb key: it is shared whenever the original key is shared,
  // and also when only the file name is.
  const groups = new Map<string, Row[]>();
  for (const r of photos) {
    const k = `${r.listingId}|${derivativeKey(r.r2Key, "thumb")}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const clashing = [...groups.values()].filter((g) => g.length > 1);
  if (!clashing.length) return [];

  const listingIds = [...new Set(clashing.map((g) => g[0].listingId))];
  const listings = await d.query.listings.findMany({ where: inArray(schema.listings.id, listingIds), columns: { id: true, slug: true, address: true } });
  const shootIds = [...new Set(clashing.flat().map((r) => r.shootId).filter((x): x is string => Boolean(x)))];
  const shoots = shootIds.length ? await d.query.shoots.findMany({ where: inArray(schema.shoots.id, shootIds), columns: { id: true, autohdrPhotoshootId: true } }) : [];
  const pidOf = new Map(shoots.map((s) => [s.id, s.autohdrPhotoshootId]));
  const keysByListing = new Map<string, Set<string>>();
  for (const r of rows) (keysByListing.get(r.listingId) ?? keysByListing.set(r.listingId, new Set()).get(r.listingId)!).add(derivativeKey(r.r2Key, "thumb"));

  const restorable = (r: Row): string | null => {
    if (!r.shootId || !r.editorImageId) return "it was not made by the editing service (a hand upload): re-upload it by hand";
    if (r.editorImageId.includes(":")) return "it is a twilight frame: re-run or re-upload it by hand";
    if (!pidOf.get(r.shootId)) return "its shoot has no editing photoshoot id";
    return null;
  };

  const out: CollisionGroup[] = [];
  for (const g of clashing) {
    const l = listings.find((x) => x.id === g[0].listingId)!;
    const taken = keysByListing.get(l.id)!;
    const sorted = [...g].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const keeper = sorted[0];
    const sharedOriginal = sorted.some((r) => r !== keeper && r.r2Key === keeper.r2Key);
    const newestOnKey = (key: string) => [...sorted].reverse().find((r) => r.r2Key === key)!;
    const steps: RepairStep[] = [];
    if (sharedOriginal) {
      const why = restorable(keeper);
      steps.push({ mediaId: keeper.id, filename: keeper.filename, action: why ? "keep" : "restore", to: keeper.r2Key, source: why ? undefined : "editing service", problem: why ?? undefined });
    } else {
      steps.push({ mediaId: keeper.id, filename: keeper.filename, action: "rebuild-derivatives", to: keeper.r2Key, source: "own file" });
    }
    // Free names for the rows that move: continue "<stem>-NN" after the
    // highest number on the listing, else add the row's short id.
    const listingRows = rows.filter((r) => r.listingId === l.id);
    for (const r of sorted.slice(1)) {
      const file = fileOf(r.r2Key);
      const m = /^(.*)-(\d+)(\.[a-z0-9]+)$/i.exec(file);
      let next = "";
      if (m) {
        const re = new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)(?:-[a-z0-9]+)?\\.[a-z0-9]+$`, "i");
        let max = listingRows.reduce((acc, x) => {
          const mm = re.exec(fileOf(x.r2Key));
          return mm ? Math.max(acc, Number(mm[1])) : acc;
        }, 0);
        do next = `${dirOf(r.r2Key)}/${m[1]}-${pad(++max)}${m[3].toLowerCase()}`;
        while (taken.has(derivativeKey(next, "thumb")));
      } else {
        next = `${dirOf(r.r2Key)}/${file.replace(/(\.[^.]+)$/, `-${r.id.slice(0, 6)}$1`)}`;
      }
      taken.add(derivativeKey(next, "thumb"));
      const shared = r.r2Key === keeper.r2Key || sorted.some((x) => x !== r && x.r2Key === r.r2Key);
      const ownBytesHere = !shared || newestOnKey(r.r2Key) === r;
      const why = ownBytesHere ? null : restorable(r);
      steps.push({
        mediaId: r.id,
        filename: r.filename,
        action: "move",
        from: r.r2Key,
        to: next,
        source: ownBytesHere ? (shared ? "current file" : "own file") : why ? undefined : "editing service",
        problem: why ?? undefined,
      });
    }
    out.push({ listingId: l.id, slug: l.slug, address: l.address, sharedOriginal, steps });
  }
  return out;
}

async function fromEditing(r: { shootId: string | null; editorImageId: string | null }): Promise<Buffer> {
  const s = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, r.shootId!), columns: { status: true, autohdrPhotoshootId: true, autohdrJobId: true, progress: true } });
  // A large shoot was sent to editing in parts (src/lib/transfer-engine.ts):
  // the frame's own part first, then the others.
  const ids = s ? editingIdsForImage(s, r.editorImageId!) : [];
  if (!ids.length) throw new Error("its shoot has no editing photoshoot id");
  let last: unknown = null;
  for (const pid of ids) {
    try {
      const [url] = await ah.downloadUrls(pid, [{ imageUuid: r.editorImageId! }]);
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`the editing service would not hand the file back (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function writeWithDerivatives(key: string, body: Buffer): Promise<void> {
  await putObject(key, body, "image/jpeg");
  const derivs = await makeDerivatives(body, key);
  await Promise.all(derivs.map((x) => putObject(x.key, x.buffer, "image/jpeg")));
}

// Applies the plan for one listing. Order matters: every "move" whose bytes
// are the current file is copied away BEFORE the keeper is restored over the
// shared key.
export async function repairCollisions(listingId: string, actor: string): Promise<{ groups: CollisionGroup[]; done: string[]; problems: string[] }> {
  const d = db();
  const groups = await findCollisions({ listingId });
  const done: string[] = [];
  const problems: string[] = [];
  const cover = (await d.query.listings.findFirst({ where: eq(schema.listings.id, listingId), columns: { coverKey: true } }))?.coverKey ?? null;
  for (const g of groups) {
    const byId = new Map((await d.query.media.findMany({ where: inArray(schema.media.id, g.steps.map((s) => s.mediaId)) })).map((m) => [m.id, m]));
    // 1. Moves that carry the bytes currently on disk.
    for (const s of g.steps.filter((x) => x.action === "move" && (x.source === "current file" || x.source === "own file"))) {
      const { body } = await getObjectBuffer(s.from!);
      await writeWithDerivatives(s.to!, body);
      await d.update(schema.media).set({ r2Key: s.to!, filename: fileOf(s.to!), bytes: body.length }).where(eq(schema.media.id, s.mediaId));
      done.push(`${s.filename} → ${fileOf(s.to!)} (${s.source})`);
    }
    // 2. Moves whose bytes were lost: fetched again from the editing service.
    for (const s of g.steps.filter((x) => x.action === "move" && x.source === "editing service")) {
      const body = await fromEditing(byId.get(s.mediaId)!);
      await writeWithDerivatives(s.to!, body);
      await d.update(schema.media).set({ r2Key: s.to!, filename: fileOf(s.to!), bytes: body.length }).where(eq(schema.media.id, s.mediaId));
      done.push(`${s.filename} → ${fileOf(s.to!)} (fetched again)`);
    }
    // 3. The keeper.
    const k = g.steps[0];
    if (k.action === "restore") {
      const body = await fromEditing(byId.get(k.mediaId)!);
      await writeWithDerivatives(k.to!, body);
      await d.update(schema.media).set({ bytes: body.length }).where(eq(schema.media.id, k.mediaId));
      done.push(`${k.filename} restored from the editing service`);
    } else if (k.action === "rebuild-derivatives") {
      const { body } = await getObjectBuffer(k.to!);
      const derivs = await makeDerivatives(body, k.to!);
      await Promise.all(derivs.map((x) => putObject(x.key, x.buffer, "image/jpeg")));
      done.push(`${k.filename} thumbnails rebuilt`);
    }
    for (const s of g.steps) if (s.problem && !(s.action === "move" && s.source)) problems.push(`${s.filename}: ${s.problem}`);
    // 4. The full-size cover files (the gallery hero) come from the cover's
    // original, which may have just changed.
    if (cover && g.steps.some((s) => s.to === cover || s.from === cover)) {
      const { body } = await getObjectBuffer(cover);
      const made = await makeCover(body);
      await Promise.all([putObject(derivativeKey(cover, "cover"), made.clean, "image/jpeg"), putObject(derivativeKey(cover, "cover-wm"), made.watermarked, "image/jpeg")]);
      done.push("cover rebuilt");
    }
  }
  if (groups.length) {
    await enqueueBundleRebuild(listingId);
    await logActivity({ actorEmail: actor, action: "media.repaired", listingId, meta: { groups: groups.length, done, problems } });
  }
  return { groups, done, problems };
}
