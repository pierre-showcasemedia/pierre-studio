// The photos a client asked to change, found on their shoot (Oct 30 2026;
// the owner: when the Photo QC team uploads the revised photos "it still goes
// into that same final area. It gets blended together with all of the other
// QC photos, and then they're hard for us to find. Sort out a way for us to
// very, very easily locate those photos ... do a final check, and then
// deliver on them").
//
// A photo revision request (the gallery's per-photo notes, or a text or
// email the intake filed) names photos: its items (media id, else filename)
// and its filenames list. Those photos, on this shoot, while the request is
// open, are the shoot's revision round. A request that names no photo at all
// (a general "brighten the kitchen ones") counts every frame replaced since
// it came in that is not live yet.
//
// "Fixed" = a corrected file replaced the frame (finals.ts logs
// media.replaced) after the client asked. The replaced file is the "before"
// (download?replaced=<activity>&view=1). Once the request is marked done the
// photos leave the round; a fix that is still not live stays in it until it
// is published, so nothing fixed is ever lost in the grid.
//
// Read only; no schema. Used by the shoot page (the Revision section and its
// banner), the Photo QC board and /admin/revisions (links straight to it).
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { RevisionStatus } from "@/db/schema";

export type RevisionFrame = {
  notes: string[]; // what the client wrote about this photo (may be empty for a general request)
  askedAt: string;
  fixedAt: string | null; // replaced after the ask
  beforeHref: string | null; // the file it replaced, shown inline
  live: boolean;
};

export type RevisionAsk = { id: string; status: RevisionStatus; clientName: string | null; clientEmail: string; askedAt: string; source: string | null; general: boolean };

export type RevisionRound = {
  frames: Record<string, RevisionFrame>;
  asks: RevisionAsk[]; // the open requests behind it, oldest first
  total: number;
  fixed: number; // fixed and not live yet: ready for the final check
  waiting: number; // not fixed yet
  live: number; // fixed and live in the gallery
};

type Frame = { id: string; filename: string; published: boolean };
type Req = {
  id: string;
  status: RevisionStatus;
  clientEmail: string;
  clientName: string | null;
  submittedAt: Date | null;
  source: string | null;
  filenames: string | null;
  items: { mediaId: string | null; filename: string; note: string }[];
};
type Swap = { mediaId: string; at: Date; activityId: string };

const LOOKBACK_DAYS = 120;
const base = (f: string) => f.trim().replace(/\.[^.]+$/, "").toLowerCase();

// The round for one shoot, from rows already read. Pure, so the board can
// run it for many shoots off one batch of reads.
export function computeRound(shootId: string, frames: Frame[], requests: Req[], swaps: Swap[]): RevisionRound | null {
  if (!frames.length || !requests.length) return null;
  const byId = new Map(frames.map((f) => [f.id, f]));
  const byBase = new Map(frames.map((f) => [base(f.filename), f]));
  const lastSwap = new Map<string, Swap>();
  for (const s of swaps) {
    const was = lastSwap.get(s.mediaId);
    if (!was || s.at > was.at) lastSwap.set(s.mediaId, s);
  }
  const find = (mediaId: string | null, filename: string) => (mediaId && byId.get(mediaId)) || byBase.get(base(filename)) || null;

  const out: Record<string, RevisionFrame> = {};
  const asks: RevisionAsk[] = [];
  const add = (f: Frame, askedAt: Date, note: string | null, open: boolean) => {
    const swap = lastSwap.get(f.id);
    const fixedAt = swap && swap.at > askedAt ? swap.at : null;
    // A closed request keeps a photo here only while its fix is not live yet.
    if (!open && !(fixedAt && !f.published)) return false;
    const cur = out[f.id];
    const notes = cur ? cur.notes : [];
    if (note && !notes.includes(note)) notes.push(note);
    if (!cur || askedAt.toISOString() < cur.askedAt) {
      out[f.id] = { notes, askedAt: askedAt.toISOString(), fixedAt: fixedAt?.toISOString() ?? null, beforeHref: fixedAt && swap ? `/api/studio/shoots/${shootId}/download?replaced=${swap.activityId}&view=1` : null, live: f.published };
    } else {
      cur.notes = notes;
    }
    return true;
  };

  for (const r of [...requests].sort((a, b) => (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0))) {
    if (!r.submittedAt) continue; // the client is still writing it
    const open = r.status !== "done";
    const named: { frame: Frame; note: string | null }[] = [];
    for (const it of r.items) {
      const f = find(it.mediaId, it.filename);
      if (f) named.push({ frame: f, note: it.note?.trim() || null });
    }
    for (const fn of (r.filenames ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const f = find(null, fn);
      if (f && !named.some((n) => n.frame.id === f.id)) named.push({ frame: f, note: null });
    }
    const general = r.items.length === 0 && !(r.filenames ?? "").trim();
    let touched = false;
    if (named.length) {
      for (const n of named) touched = add(n.frame, r.submittedAt, n.note, open) || touched;
    } else if (general) {
      // No photo named: every frame replaced since it came in and not live yet.
      for (const f of frames) {
        const swap = lastSwap.get(f.id);
        if (swap && swap.at > r.submittedAt && !f.published) touched = add(f, r.submittedAt, null, open) || touched;
      }
    }
    if (open && touched) {
      asks.push({ id: r.id, status: r.status, clientName: r.clientName, clientEmail: r.clientEmail, askedAt: r.submittedAt.toISOString(), source: r.source, general });
    }
  }
  const list = Object.values(out);
  if (!list.length) return null;
  return {
    frames: out,
    asks,
    total: list.length,
    fixed: list.filter((x) => x.fixedAt && !x.live).length,
    waiting: list.filter((x) => !x.fixedAt).length,
    live: list.filter((x) => x.fixedAt && x.live).length,
  };
}

async function readRequests(listingIds: string[]): Promise<Map<string, Req[]>> {
  const out = new Map<string, Req[]>();
  if (!listingIds.length) return out;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const rows = await db().query.revisionRequests.findMany({
    where: and(inArray(schema.revisionRequests.listingId, listingIds), eq(schema.revisionRequests.mediaKind, "photo"), gte(schema.revisionRequests.createdAt, since)),
    with: { items: { columns: { mediaId: true, filename: true, note: true } }, listing: { columns: { id: true }, with: { client: { columns: { name: true } } } } },
    orderBy: [desc(schema.revisionRequests.createdAt)],
  });
  for (const r of rows) {
    const list = out.get(r.listingId) ?? [];
    list.push({ id: r.id, status: r.status, clientEmail: r.clientEmail, clientName: r.listing.client?.name ?? null, submittedAt: r.submittedAt, source: r.source, filenames: r.filenames, items: r.items });
    out.set(r.listingId, list);
  }
  return out;
}

async function readSwaps(shootIds: string[]): Promise<Map<string, Swap[]>> {
  const out = new Map<string, Swap[]>();
  if (!shootIds.length) return out;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const rows = await db().query.activity.findMany({
    where: and(eq(schema.activity.action, "media.replaced"), inArray(schema.activity.shootId, shootIds), gte(schema.activity.createdAt, since)),
    columns: { id: true, shootId: true, meta: true, createdAt: true },
  });
  for (const a of rows) {
    const mediaId = typeof a.meta?.mediaId === "string" ? a.meta.mediaId : null;
    if (!a.shootId || !mediaId) continue;
    const list = out.get(a.shootId) ?? [];
    list.push({ mediaId, at: a.createdAt, activityId: a.id });
    out.set(a.shootId, list);
  }
  return out;
}

// The shoot page: one shoot and its frames.
export async function revisionRound(shoot: { id: string; listingId: string }, frames: Frame[]): Promise<RevisionRound | null> {
  if (!hasDb()) return demoRound(shoot.id, frames);
  const [reqs, swaps] = await Promise.all([readRequests([shoot.listingId]), readSwaps([shoot.id])]);
  return computeRound(shoot.id, frames, reqs.get(shoot.listingId) ?? [], swaps.get(shoot.id) ?? []);
}

// The Photo QC board: rounds for several shoots at once.
export async function revisionRounds(shoots: { id: string; listingId: string }[]): Promise<Map<string, RevisionRound>> {
  const out = new Map<string, RevisionRound>();
  if (!shoots.length || !hasDb()) return out;
  const reqs = await readRequests([...new Set(shoots.map((s) => s.listingId))]);
  const withAsks = shoots.filter((s) => reqs.get(s.listingId)?.some((r) => r.submittedAt));
  if (!withAsks.length) return out;
  const [frames, swaps] = await Promise.all([
    db().query.media.findMany({ where: inArray(schema.media.shootId, withAsks.map((s) => s.id)), columns: { id: true, shootId: true, filename: true, published: true } }),
    readSwaps(withAsks.map((s) => s.id)),
  ]);
  for (const s of withAsks) {
    const round = computeRound(s.id, frames.filter((f) => f.shootId === s.id), reqs.get(s.listingId) ?? [], swaps.get(s.id) ?? []);
    if (round) out.set(s.id, round);
  }
  return out;
}

// Which shoot holds the photos a request names, for "Open the revised photos"
// links from /admin/revisions and the board's Revisions column.
export async function revisionShoots(requests: { id: string; listingId: string; items: { mediaId: string | null; filename: string }[]; filenames: string[] }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!requests.length || !hasDb()) return out;
  const media = await db().query.media.findMany({
    where: and(inArray(schema.media.listingId, [...new Set(requests.map((r) => r.listingId))])),
    columns: { id: true, listingId: true, shootId: true, filename: true },
  });
  for (const r of requests) {
    const mine = media.filter((m) => m.listingId === r.listingId && m.shootId);
    const votes = new Map<string, number>();
    const vote = (m: (typeof mine)[number] | undefined) => {
      if (m?.shootId) votes.set(m.shootId, (votes.get(m.shootId) ?? 0) + 1);
    };
    for (const it of r.items) vote(mine.find((m) => m.id === it.mediaId) ?? mine.find((m) => base(m.filename) === base(it.filename)));
    for (const fn of r.filenames) vote(mine.find((m) => base(m.filename) === base(fn)));
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) out.set(r.id, best[0]);
  }
  return out;
}

// Demo mode: one photo fixed and one waiting on the shoot with frames, so the
// Revision section can be reviewed without a database.
function demoRound(shootId: string, frames: Frame[]): RevisionRound | null {
  if (frames.length < 8) return null;
  const now = Date.now();
  const askedAt = new Date(now - 26 * 3_600_000).toISOString();
  const a = frames[5];
  const b = frames[9];
  return {
    frames: {
      [a.id]: { notes: ["Could the kitchen come up a touch brighter? The island reads a little dark on my screen."], askedAt, fixedAt: new Date(now - 2 * 3_600_000).toISOString(), beforeHref: null, live: false },
      [b.id]: { notes: ["Please remove the garden hose on the left."], askedAt, fixedAt: null, beforeHref: null, live: false },
    },
    asks: [{ id: `demo-rev-${shootId}`, status: "in_progress", clientName: "Taylor Brooks", clientEmail: "taylor@example.com", askedAt, source: null, general: false }],
    total: 2,
    fixed: 1,
    waiting: 1,
    live: 0,
  };
}
