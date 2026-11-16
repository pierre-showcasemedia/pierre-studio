// Corrected finals (v1.2). An admin downloads a shoot's frames, fixes them
// locally and uploads the corrected JPGs. Each uploaded file is matched to a
// frame of the shoot by filename:
//   - a match REPLACES that frame's file in place (same key, same media row,
//     the previous object is kept under shoots/<id>/replaced/<stamp>/ and the
//     swap is logged to activity), derivatives are rebuilt;
//   - a new filename becomes a new frame in the main gallery.
// Either way the frame ends up qc_state='approved', published=false and
// corrected=true: it shows with a "corrected" badge, reads "Internal only,
// waiting to publish", and reaches the client only when someone publishes the
// shoot or makes it client visible. A replaced frame that had been held back
// (moved to internal by hand) is released (held=false): the corrected file is
// the fix, so the next Publish sends it. Nothing here is ever sent to editing.
//
// Nov 3 2026: these are the shoot page's Revised section. A
// replaced file starts with no automatic QC flags and no ticks (the flags
// described the old file); the editor runs QC again on the revised photos
// and ticks what the new pass finds.
import { and, asc, eq } from "drizzle-orm";
import sharp from "sharp";
import { db, schema } from "@/db";
import { copyObject, getObjectBuffer, headObject, putObject, safeFilename } from "./r2";
import { makeDerivatives } from "./derivatives";
import { logActivity } from "./activity";
import { clearQcFixes } from "./qc-fixes";
import { withOriginalSlot } from "./image-gate";

export const finalsKey = (shootId: string, safe: string) => `shoots/${shootId}/finals/${safe}`;

export type IngestResult = {
  replaced: { filename: string; mediaId: string }[];
  added: { filename: string; mediaId: string }[];
  failed: { filename: string; error: string }[];
};

const baseName = (f: string) => f.replace(/\.[^.]+$/, "").toLowerCase();
// Photos worked on at once inside one ingest call. Nov 11 2026: 2, was 3.
// Each one holds its whole original in memory (20 to 40 MB for a big frame)
// while it is fetched, stored and resized. Three at once, three decodes
// each, is what ran the instance out of memory on 3330 Cedar Road (the
// hosting logs say so). The real ceiling is per instance, across every call
// in it: src/lib/image-gate.ts.
const FILE_PARALLEL = 2;

// Put the staged file at its final key: a copy inside storage, and if storage
// refuses the copy for any reason, the bytes sent from here as before. The
// photo lands either way; the warning says which way it went.
async function place(stagedKey: string, toKey: string, body: Buffer): Promise<void> {
  try {
    await copyObject(stagedKey, toKey, "image/jpeg");
  } catch (e) {
    console.warn("[finals] storage copy refused, sending the bytes instead", toKey, e instanceof Error ? e.message : e);
    await putObject(toKey, body, "image/jpeg");
  }
}

export async function ingestFinals(shootId: string, actor: string, names: string[], run: string | null = null): Promise<IngestResult> {
  const d = db();
  const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), with: { listing: { columns: { id: true, slug: true } } } });
  if (!shoot) throw new Error("Shoot not found.");
  const frames = await d.query.media.findMany({ where: eq(schema.media.shootId, shootId), orderBy: [asc(schema.media.sort)] });
  const byBase = new Map(frames.map((f) => [baseName(f.filename), f]));
  const listingMedia = await d.query.media.findMany({ where: eq(schema.media.listingId, shoot.listingId), columns: { r2Key: true, shootId: true } });
  const takenKeys = new Set(listingMedia.filter((m) => m.shootId !== shootId).map((m) => m.r2Key));
  let nextSort = frames.filter((f) => !f.section).reduce((a, f) => Math.max(a, f.sort), -1) + 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Oct 28 2026: the storage work (fetch, check, archive, put, derivatives:
  // about 4 s a photo) runs FILE_PARALLEL at a time; the database writes
  // then go in the order the names came in, so new frames keep that order.
  type Ready =
    | { kind: "replace"; match: (typeof frames)[number]; bytes: number; archiveKey: string }
    | { kind: "add"; filename: string; key: string; bytes: number }
    | { kind: "fail"; filename: string; error: string };
  const safes = [...new Set(names.map((raw) => safeFilename(String(raw))))];
  const claimed = new Set<string>();
  const claimedFrames = new Set<string>();
  // Each photo holds its original in memory from the download to the last
  // derivative, so it takes one of the instance's original slots
  // (src/lib/image-gate.ts): two uploads at once, or the grid asking for
  // thumbnails, queue behind each other instead of adding up.
  const prepare = (safe: string): Promise<Ready> => withOriginalSlot(() => prepareOne(safe));
  const prepareOne = async (safe: string): Promise<Ready> => {
    const stagedKey = finalsKey(shootId, safe);
    try {
      const head = await headObject(stagedKey);
      if (!head || head.size === 0) throw new Error("did not land");
      const { body } = await getObjectBuffer(stagedKey);
      const meta = await sharp(body, { failOn: "none" }).metadata();
      if (meta.format !== "jpeg") throw new Error(`not a JPEG (${meta.format ?? "unknown"})`);
      const match = byBase.get(baseName(safe));
      if (match) {
        // Two files for one frame (a.jpg and a.jpeg) would race on the same key: the first one wins.
        if (claimedFrames.has(match.id)) throw new Error(`another file in this upload already replaces ${match.filename}`);
        claimedFrames.add(match.id);
        // Keep the previous version, then overwrite in place and rebuild derivatives.
        const archiveKey = `shoots/${shootId}/replaced/${stamp}/${match.filename}`;
        try { await copyObject(match.r2Key, archiveKey); } catch (e) { console.warn("[finals] could not archive previous version", match.r2Key, e); }
        // Nov 11 2026: copied inside storage from the staged file, not sent
        // again from here (tens of MB a photo, the slow part of a call).
        await place(stagedKey, match.r2Key, body);
        const derivs = await makeDerivatives(body, match.r2Key);
        await Promise.all(derivs.map((x) => putObject(x.key, x.buffer, "image/jpeg")));
        return { kind: "replace", match, bytes: body.length, archiveKey };
      }
      // New frame in the main gallery. Avoid clobbering another shoot's object on this listing.
      let key = `listings/${shoot.listing.slug}/edited/${safe}`;
      let filename = safe;
      // Taken means a media row owns the key. An object with no row is what
      // a dropped call left behind (it stored the file and died before the
      // row), so the retry writes over it and the photo keeps its name
      // instead of coming back as "-c001402" (Nov 10 2026).
      const owned = takenKeys.has(key) || claimed.has(key) || Boolean(await d.query.media.findFirst({ where: eq(schema.media.r2Key, key), columns: { id: true } }));
      if (owned) {
        filename = safe.replace(/(\.[^.]+)$/, `-c${stamp.slice(11, 19).replace(/-/g, "")}$1`);
        key = `listings/${shoot.listing.slug}/edited/${filename}`;
      }
      claimed.add(key);
      await place(stagedKey, key, body);
      const derivs = await makeDerivatives(body, key);
      await Promise.all(derivs.map((x) => putObject(x.key, x.buffer, "image/jpeg")));
      return { kind: "add", filename, key, bytes: body.length };
    } catch (e) {
      return { kind: "fail", filename: safe, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const ready: Ready[] = new Array(safes.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FILE_PARALLEL, safes.length) }, async () => {
      while (next < safes.length) {
        const i = next++;
        ready[i] = await prepare(safes[i]);
      }
    })
  );

  const out: IngestResult = { replaced: [], added: [], failed: [] };
  for (const r of ready) {
    try {
      if (r.kind === "fail") {
        out.failed.push({ filename: r.filename, error: r.error });
      } else if (r.kind === "replace") {
        const { match, bytes, archiveKey } = r;
        await d
          .update(schema.media)
          .set({
            bytes,
            corrected: true,
            qcState: "approved",
            published: false,
            held: false,
            qcScore: null,
            qcIssues: null,
            qcSuggestions: null,
            qcSummary: `Corrected final uploaded by ${actor}.`,
            qcCheckedAt: null,
          })
          .where(eq(schema.media.id, match.id));
        await clearQcFixes(match.id);
        await logActivity({ actorEmail: actor, action: "media.replaced", shootId, listingId: shoot.listingId, meta: { mediaId: match.id, filename: match.filename, previous: archiveKey, bytes } });
        out.replaced.push({ filename: match.filename, mediaId: match.id });
      } else {
        const [row] = await d
          .insert(schema.media)
          .values({
            listingId: shoot.listingId,
            kind: "photo",
            r2Key: r.key,
            filename: r.filename,
            bytes: r.bytes,
            section: null,
            revision: false,
            sort: nextSort++,
            shootId,
            qcState: "approved",
            published: false,
            corrected: true,
            qcSummary: `Corrected final uploaded by ${actor}.`,
          })
          .returning({ id: schema.media.id });
        out.added.push({ filename: r.filename, mediaId: row.id });
      }
    } catch (e) {
      out.failed.push({ filename: r.kind === "replace" ? r.match.filename : r.filename, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (out.added.length) {
    await logActivity({ actorEmail: actor, action: "media.added", shootId, listingId: shoot.listingId, meta: { count: out.added.length, filenames: out.added.map((a) => a.filename).slice(0, 20) } });
  }
  if (out.replaced.length || out.added.length) {
    // With a run (src/lib/upload-runs.ts) the line waits for the run's one summary.
    await logActivity({ actorEmail: actor, action: "media.finals_uploaded", shootId, listingId: shoot.listingId, meta: { replaced: out.replaced.length, added: out.added.length, failed: out.failed.length, ...(run ? { run } : {}) } });
    await d.update(schema.shoots).set({ updatedAt: new Date() }).where(eq(schema.shoots.id, shootId));
  }
  return out;
}

// Frames of a shoot that are approved but not yet published (what "Publish"
// would push; held frames stay where they are).
export async function unpublishedApprovedCount(shootId: string): Promise<number> {
  const rows = await db().query.media.findMany({
    where: and(eq(schema.media.shootId, shootId), eq(schema.media.qcState, "approved"), eq(schema.media.published, false), eq(schema.media.held, false)),
    columns: { id: true },
  });
  return rows.length;
}
