// The Video board (Oct 26 2026). the owner: a pipeline for the video editor's editing team,
// "in queue", "in editing", "in review", "sent to client", "complete", with a
// card for each shoot. Opening a card shows only what the video needs: the
// booking form's video side (speed, music, notes), the Dropbox Video folder
// with the raw clips, and everything this client has told us about video
// before (pace, music, past revisions) so the next edit avoids a revision.
//
// Cards (video_projects):
//   booking:<id>  made by the video.card job when a booking with a film or
//                 reel comes in (or is revised to include one);
//   shoot:<id>    made when raw video is uploaded for a listing that has no
//                 open card yet (a hand-booked shoot);
//   revision:<id> made when a video revision arrives for a listing with no card.
// Uploading raw video stamps footage_at on the listing's open card. A video
// revision (the film review in the gallery, or a text the intake read as
// video) links itself to the card, bumps the round and puts the card back In
// queue. Moving the card keeps the linked revision in step: In editing marks
// it In progress, Sent to client or Complete marks it Done.
//
// Nov 5 2026: the card moves on its own at each hand-off, so the
// board reads as "where is the work" without anyone dragging:
//   footage in Dropbox (the #video-editing line tagging the video editor) → In editing
//   a cut uploaded from the card                                → In review
//   the delivery email sent while a film is live                → Sent to client
//   3 days after Sent to client, nothing open                   → Complete
// A revision still puts the card back In queue; a card with an open revision
// is never auto-completed. Hand moves keep working (moveVideoCardTo).
//
// Rows carry env like bookings: preview and production share one database,
// production also owns rows written before env existed.
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { VIDEO_STAGES, type VideoStage } from "@/db/schema";
import { logActivity } from "./activity";
import { isVideoBooking, itemById } from "./studio-pricing";
import { brainBriefFor, hasBrain } from "./brain";
import { isDropboxConnected } from "./dropbox";
import { videoFolderUrl } from "./dropbox-mirror";
import { currentEnv, FatalJobError, SkipJobError } from "./jobs-core";
import { signedViewUrl } from "./r2";
import { hubVideoLine, hubVideoReview, scrubMoney, type VideoEditingLine } from "./slack";

export { VIDEO_STAGES };
export type { VideoStage };

export const STAGE_LABELS: Record<VideoStage, string> = {
  queue: "In queue",
  editing: "In editing",
  review: "In review",
  sent: "Sent to client",
  complete: "Complete",
};

export const isVideoStage = (v: unknown): v is VideoStage => typeof v === "string" && (VIDEO_STAGES as readonly string[]).includes(v);

// The video items on a booking (video: true on the price table), by name.
export function videoServiceNames(serviceIds: string[] | null | undefined, addonIds: string[] | null | undefined): { services: string[]; addons: string[] } {
  const services = (serviceIds ?? []).map((id) => itemById(id)).filter((i) => i?.video).map((i) => i!.name);
  const addons = (addonIds ?? []).map((id) => itemById(id)).filter((i) => i?.video).map((i) => i!.name);
  return { services, addons };
}

export { isVideoBooking };

// 0:42, 1:05:09
export function fmtTimecode(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Lines from the client's note in the business brain that are about video, money
// scrubbed (an editor never sees an amount).
const VIDEO_WORDS = /\b(video|videos|film|films|reel|reels|music|song|songs|track|pace|pacing|speed|slow|fast|cut|cuts|edit|editing|drone|vertical|verticals|horizontal|transition|transitions|voice ?over|b-roll|footage|cinematic|lifestyle|agent on camera|on camera|intro|outro|logo|caption|captions|color|grade)\b/i;
export function videoLines(sections: Record<string, string[]> | null | undefined, extra: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...extra, ...Object.values(sections ?? {}).flat()]) {
    const l = scrubMoney(String(line).replace(/^[-*]\s*/, "").trim());
    if (!l || !VIDEO_WORDS.test(l) || seen.has(l.toLowerCase())) continue;
    seen.add(l.toLowerCase());
    out.push(l);
  }
  return out.slice(0, 20);
}

function envWhere() {
  const env = currentEnv();
  return env === "production" ? or(eq(schema.videoProjects.env, env), isNull(schema.videoProjects.env)) : eq(schema.videoProjects.env, env);
}

// ---- Making cards -------------------------------------------------------------

// The video.card job: a booking with a film or reel gets its card (once).
export async function ensureCardForBooking(bookingId: string): Promise<{ id: string; created: boolean }> {
  const d = db();
  const b = await d.query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), columns: { id: true, listingId: true, serviceIds: true, status: true, env: true } });
  if (!b) throw new FatalJobError("that booking no longer exists");
  if (b.status === "canceled") throw new SkipJobError("the booking is canceled");
  if (!isVideoBooking(b.serviceIds)) throw new SkipJobError("no film or reel on this booking");
  const key = `booking:${b.id}`;
  const made = await d
    .insert(schema.videoProjects)
    .values({ key, listingId: b.listingId, bookingId: b.id, stage: "queue", env: b.env ?? currentEnv() })
    .onConflictDoNothing({ target: schema.videoProjects.key })
    .returning({ id: schema.videoProjects.id });
  if (made.length) return { id: made[0].id, created: true };
  const row = await d.query.videoProjects.findFirst({ where: eq(schema.videoProjects.key, key), columns: { id: true } });
  return { id: row!.id, created: false };
}

// The listing's newest card that is not Complete (a booking card first).
async function openCardFor(listingId: string) {
  const rows = await db().query.videoProjects.findMany({
    where: and(eq(schema.videoProjects.listingId, listingId), ne(schema.videoProjects.stage, "complete"), envWhere()),
    orderBy: [desc(schema.videoProjects.createdAt)],
  });
  return rows.find((r) => r.bookingId) ?? rows[0] ?? null;
}

// Raw video was uploaded for this listing (the submit route): stamp the open
// card, or make one for a shoot nobody booked through the form.
export async function attachFootage(p: { listingId: string; shootId: string }): Promise<{ id: string; created: boolean }> {
  const d = db();
  const now = new Date();
  const open = await openCardFor(p.listingId);
  if (open) {
    await d.update(schema.videoProjects).set({ footageAt: now, shootId: open.shootId ?? p.shootId, updatedAt: now }).where(eq(schema.videoProjects.id, open.id));
    return { id: open.id, created: false };
  }
  const key = `shoot:${p.shootId}`;
  const made = await d
    .insert(schema.videoProjects)
    .values({ key, listingId: p.listingId, shootId: p.shootId, stage: "queue", footageAt: now, env: currentEnv() })
    .onConflictDoNothing({ target: schema.videoProjects.key })
    .returning({ id: schema.videoProjects.id });
  if (made.length) return { id: made[0].id, created: true };
  const row = await d.query.videoProjects.findFirst({ where: eq(schema.videoProjects.key, key), columns: { id: true } });
  return { id: row!.id, created: false };
}

// The #video-editing line for a shoot whose clips are all in Dropbox (Nov 1
// 2026: the slack.video_editing job and the operator's videoEditingReady).
// The 24 to 48 hours count from when the last clip landed. The card is the
// one stamped with this shoot, else the listing's open card. null when the
// shoot has no clips or one is not in Dropbox yet.
export async function videoEditingLineFor(shootId: string): Promise<VideoEditingLine | null> {
  const d = db();
  const shoot = await d.query.shoots.findFirst({
    where: eq(schema.shoots.id, shootId),
    columns: { id: true, listingId: true },
    with: { listing: { columns: { address: true, nda: true, dropboxFolder: true, dropboxVideoLink: true } } },
  });
  if (!shoot) return null;
  const clips = await d.query.shootFiles.findMany({ where: and(eq(schema.shootFiles.shootId, shootId), eq(schema.shootFiles.kind, "raw_video")), columns: { bytes: true, dropboxSyncedAt: true } });
  if (!clips.length || clips.some((c) => !c.dropboxSyncedAt)) return null;
  const own = await d.query.videoProjects.findFirst({ where: and(eq(schema.videoProjects.shootId, shootId), envWhere()), orderBy: [desc(schema.videoProjects.createdAt)], columns: { id: true } });
  const card = own ?? (await openCardFor(shoot.listingId));
  return {
    cardId: card?.id ?? null,
    listing: { address: shoot.listing.address, nda: shoot.listing.nda },
    clips: clips.length,
    bytes: clips.reduce((n, c) => n + (c.bytes ?? 0), 0),
    landedAt: new Date(Math.max(...clips.map((c) => c.dropboxSyncedAt!.getTime()))),
    folderUrl: videoFolderUrl(shoot.listing)?.url ?? null,
  };
}

// A video revision arrived: link it to the listing's card (any stage, the
// newest; one is made when there is none), bump the round, back In queue.
export async function linkVideoRevision(p: { listingId: string; requestId: string; by: string }): Promise<string> {
  const d = db();
  const now = new Date();
  const card =
    (await openCardFor(p.listingId)) ??
    (await d.query.videoProjects.findFirst({ where: and(eq(schema.videoProjects.listingId, p.listingId), envWhere()), orderBy: [desc(schema.videoProjects.createdAt)] })) ??
    null;
  if (card) {
    await d
      .update(schema.videoProjects)
      .set({ revisionRequestId: p.requestId, revisionRound: card.revisionRequestId === p.requestId ? card.revisionRound : card.revisionRound + 1, stage: "queue", stageChangedAt: now, stageChangedBy: p.by, updatedAt: now })
      .where(eq(schema.videoProjects.id, card.id));
    return card.id;
  }
  const [made] = await d
    .insert(schema.videoProjects)
    .values({ key: `revision:${p.requestId}`, listingId: p.listingId, stage: "queue", revisionRequestId: p.requestId, revisionRound: 1, stageChangedBy: p.by, env: currentEnv() })
    .onConflictDoNothing({ target: schema.videoProjects.key })
    .returning({ id: schema.videoProjects.id });
  if (made) return made.id;
  return (await d.query.videoProjects.findFirst({ where: eq(schema.videoProjects.key, `revision:${p.requestId}`), columns: { id: true } }))!.id;
}

// ---- Reading the board -----------------------------------------------------------

export type VideoCard = {
  id: string;
  stage: VideoStage;
  listingId: string;
  address: string;
  street: string;
  nda: boolean;
  clientName: string | null;
  shootDate: string | null;
  startTime: string | null;
  launchDate: string | null;
  services: string[];
  speed: string | null;
  assignee: string | null;
  footage: boolean;
  films: number;
  filmsLive: number;
  revision: { id: string; status: string; round: number; comments: number } | null;
  stageChangedAt: string;
  createdAt: string;
};

type CardRow = typeof schema.videoProjects.$inferSelect & {
  listing: { id: string; address: string; slug: string; nda: boolean; shootDate: Date | null; clientId: string; client: { id: string; name: string | null; email: string; team: string | null } | null; media: { id: string; published: boolean; held: boolean }[] };
  booking: { id: string; status: string; desiredDate: string | null; startTime: string | null; launchDate: string | null; serviceIds: string[] | null; addonIds: string[] | null; property: Record<string, unknown> | null } | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function toCard(r: CardRow, revs: Map<string, { status: string; comments: number }>): VideoCard {
  const v = videoServiceNames(r.booking?.serviceIds, r.booking?.addonIds);
  const rev = r.revisionRequestId ? revs.get(r.revisionRequestId) : undefined;
  return {
    id: r.id,
    stage: isVideoStage(r.stage) ? r.stage : "queue",
    listingId: r.listingId,
    address: r.listing.address,
    street: r.listing.address.split(",")[0].trim(),
    nda: r.listing.nda,
    clientName: r.listing.client?.name ?? r.listing.client?.email ?? null,
    // listings.shoot_date is a timestamp: the card carries the day, like the
    // portal does. A card without a booking date crashed the board (Oct 28 2026).
    shootDate: r.booking?.desiredDate ?? r.listing.shootDate?.toISOString().slice(0, 10) ?? null,
    startTime: r.booking?.startTime ?? null,
    launchDate: r.booking?.launchDate ?? null,
    services: [...v.services, ...v.addons],
    speed: str(r.booking?.property?.videoStyle),
    assignee: r.assignee,
    footage: Boolean(r.footageAt),
    films: r.listing.media.length,
    filmsLive: r.listing.media.filter((m) => m.published).length,
    revision: r.revisionRequestId && rev ? { id: r.revisionRequestId, status: rev.status, round: r.revisionRound, comments: rev.comments } : null,
    stageChangedAt: r.stageChangedAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

const CARD_WITH = {
  listing: {
    columns: { id: true, address: true, slug: true, nda: true, shootDate: true, clientId: true, dropboxFolder: true, dropboxVideoLink: true },
    with: { client: { columns: { id: true, name: true, email: true, team: true, videoNotes: true } }, media: { where: eq(schema.media.kind, "video"), columns: { id: true, published: true, held: true } } },
  },
  booking: { columns: { id: true, status: true, desiredDate: true, startTime: true, launchDate: true, serviceIds: true, addonIds: true, property: true, clientNotes: true, customRequest: true } },
} as const;

async function revisionState(ids: string[]): Promise<Map<string, { status: string; comments: number }>> {
  const out = new Map<string, { status: string; comments: number }>();
  if (!ids.length) return out;
  const rows = await db().query.revisionRequests.findMany({ where: inArray(schema.revisionRequests.id, ids), columns: { id: true, status: true }, with: { videoComments: { columns: { id: true } } } });
  for (const r of rows) out.set(r.id, { status: r.status, comments: r.videoComments.length });
  return out;
}

// Every card of this environment, oldest move first within a stage. Cards
// of canceled bookings and Complete cards older than 30 days drop off.
export async function videoBoard(): Promise<VideoCard[]> {
  if (!hasDb()) return DEMO_VIDEO_CARDS;
  const rows = (await db().query.videoProjects.findMany({ where: envWhere(), with: CARD_WITH, orderBy: [asc(schema.videoProjects.stageChangedAt)] })) as unknown as CardRow[];
  const cutoff = Date.now() - 30 * 86_400_000;
  const live = rows.filter((r) => r.booking?.status !== "canceled" && !(r.stage === "complete" && r.stageChangedAt.getTime() < cutoff));
  const revs = await revisionState(live.map((r) => r.revisionRequestId).filter((x): x is string => Boolean(x)));
  return live.map((r) => toCard(r, revs));
}

export type VideoComment = { atMs: number; filename: string; note: string };
export type VideoRevisionEntry = { id: string; listingId: string; street: string; createdAt: string; status: string; notes: string; source: string | null; comments: VideoComment[] };

export type VideoCardDetail = VideoCard & {
  booking: { id: string; status: string; music: string | null; formNotes: string | null; customRequest: string | null } | null;
  dropbox: { url: string | null; shared: boolean; folder: string | null; connected: boolean };
  clips: { count: number; inDropbox: number };
  filmFiles: { id: string; filename: string; published: boolean; held: boolean; url: string | null; createdAt: string }[];
  editorNotes: string | null;
  client: { id: string; name: string | null; team: string | null; videoNotes: string | null } | null;
  history: {
    pastBookings: { date: string | null; street: string; services: string[]; speed: string | null; music: string | null }[];
    revisions: VideoRevisionEntry[];
    brainLines: string[];
  };
};

const toComments = (rows: { atMs: number; filename: string; note: string }[]): VideoComment[] =>
  [...rows].sort((a, b) => a.filename.localeCompare(b.filename) || a.atMs - b.atMs).map((c) => ({ atMs: c.atMs, filename: c.filename, note: c.note }));

export async function videoCardDetail(id: string): Promise<VideoCardDetail | null> {
  if (!hasDb()) return demoVideoDetail(id);
  const d = db();
  const r = (await d.query.videoProjects.findFirst({ where: and(eq(schema.videoProjects.id, id), envWhere()), with: CARD_WITH })) as unknown as
    | (CardRow & { listing: CardRow["listing"] & { dropboxFolder: string | null; dropboxVideoLink: string | null; client: (NonNullable<CardRow["listing"]["client"]> & { videoNotes: string | null }) | null }; booking: (NonNullable<CardRow["booking"]> & { clientNotes: string | null; customRequest: string | null }) | null })
    | undefined;
  if (!r) return null;
  const revs = await revisionState(r.revisionRequestId ? [r.revisionRequestId] : []);
  const card = toCard(r, revs);
  const client = r.listing.client;

  // The client and their team: every listing, for the video history.
  const teamClientIds = client?.team
    ? (await d.query.clients.findMany({ where: eq(schema.clients.team, client.team), columns: { id: true } })).map((c) => c.id)
    : client
      ? [client.id]
      : [];
  const listings = teamClientIds.length
    ? await d.query.listings.findMany({ where: inArray(schema.listings.clientId, teamClientIds), columns: { id: true, address: true } })
    : [];
  const listingIds = listings.map((l) => l.id);
  const streetOf = new Map(listings.map((l) => [l.id, l.address.split(",")[0].trim()]));

  const [videoRevs, bookings, films, clips, connected] = await Promise.all([
    listingIds.length
      ? d.query.revisionRequests.findMany({ where: and(inArray(schema.revisionRequests.listingId, listingIds), eq(schema.revisionRequests.mediaKind, "video")), with: { videoComments: true }, orderBy: [desc(schema.revisionRequests.createdAt)], limit: 25 })
      : Promise.resolve([]),
    listingIds.length
      ? d.query.bookings.findMany({ where: and(inArray(schema.bookings.listingId, listingIds), ne(schema.bookings.status, "canceled")), columns: { id: true, listingId: true, desiredDate: true, serviceIds: true, addonIds: true, property: true }, orderBy: [desc(schema.bookings.createdAt)], limit: 40 })
      : Promise.resolve([]),
    d.query.media.findMany({ where: and(eq(schema.media.listingId, r.listingId), eq(schema.media.kind, "video")), columns: { id: true, filename: true, published: true, held: true, r2Key: true, createdAt: true }, orderBy: [asc(schema.media.sort), asc(schema.media.createdAt)] }),
    d.query.shoots.findMany({ where: eq(schema.shoots.listingId, r.listingId), columns: { id: true }, with: { files: { where: eq(schema.shootFiles.kind, "raw_video"), columns: { id: true, dropboxSyncedAt: true } } } }),
    isDropboxConnected().catch(() => false),
  ]);

  let brainLines: string[] = [];
  if (client && hasBrain()) {
    try {
      const brief = await brainBriefFor({ email: client.email, name: client.name });
      if (brief) brainLines = videoLines(brief.note.sections, brief.beforeEveryShoot);
    } catch (e) {
      console.error("[video-board] brain", e);
    }
  }

  const rawFiles = clips.flatMap((s) => s.files);
  const folder = videoFolderUrl({ dropboxFolder: r.listing.dropboxFolder, dropboxVideoLink: r.listing.dropboxVideoLink });
  const filmRows = await Promise.all(
    films.map(async (f) => ({ id: f.id, filename: f.filename, published: f.published, held: f.held, createdAt: f.createdAt.toISOString(), url: await signedViewUrl(f.r2Key).catch(() => null) }))
  );
  const booking = r.booking;
  return {
    ...card,
    booking: booking
      ? { id: booking.id, status: booking.status, music: str(booking.property?.musicLink), formNotes: scrubOrNull(booking.clientNotes), customRequest: scrubOrNull(booking.customRequest) }
      : null,
    dropbox: { url: folder?.url ?? null, shared: folder?.shared ?? false, folder: r.listing.dropboxFolder ? `${r.listing.dropboxFolder}/Video` : null, connected },
    clips: { count: rawFiles.length, inDropbox: rawFiles.filter((f) => f.dropboxSyncedAt).length },
    filmFiles: filmRows,
    editorNotes: r.editorNotes,
    client: client ? { id: client.id, name: client.name ?? client.email, team: client.team, videoNotes: client.videoNotes } : null,
    history: {
      pastBookings: bookings
        .filter((b) => b.id !== booking?.id && isVideoBooking(b.serviceIds))
        .slice(0, 10)
        .map((b) => {
          const v = videoServiceNames(b.serviceIds, b.addonIds);
          return { date: b.desiredDate, street: streetOf.get(b.listingId) ?? "", services: [...v.services, ...v.addons], speed: str(b.property?.videoStyle), music: str(b.property?.musicLink) };
        }),
      revisions: videoRevs.map((v) => ({
        id: v.id,
        listingId: v.listingId,
        street: streetOf.get(v.listingId) ?? "",
        createdAt: v.createdAt.toISOString(),
        status: v.status,
        notes: scrubMoney(v.notes),
        source: v.source,
        comments: toComments(v.videoComments),
      })),
      brainLines,
    },
  };
}

function scrubOrNull(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t ? scrubMoney(t) : null;
}

// ---- Moving cards --------------------------------------------------------------

// Sent to client → Complete after this long with nothing open (Nov 5 2026).
export const AUTO_COMPLETE_DAYS = 3;

export type MoveResult = { ok: boolean; moved: boolean; error?: string };

// One move, by a person or by the system: the stage, the linked revision in
// step (In editing: In progress; Sent to client or Complete: Done), one
// activity row and one hub line. `from` limits an automatic move to the
// stages it may leave, so it never undoes a hand move; `line` is the hub's
// wording for an automatic move (a hand move to In review tags video QC).
export async function moveVideoCardTo(id: string, stage: VideoStage, by: string, opts: { from?: VideoStage[]; line?: string; via?: string } = {}): Promise<MoveResult> {
  const card = await videoCardRow(id);
  if (!card) return { ok: false, moved: false, error: "That card is gone." };
  const current = isVideoStage(card.stage) ? card.stage : "queue";
  if (current === stage) return { ok: true, moved: false };
  if (opts.from && !opts.from.includes(current)) return { ok: true, moved: false };
  const d = db();
  const now = new Date();
  await d.update(schema.videoProjects).set({ stage, stageChangedAt: now, stageChangedBy: by, updatedAt: now }).where(eq(schema.videoProjects.id, id));
  if (card.revisionRequestId) {
    const rid = card.revisionRequestId;
    if (stage === "editing") {
      await d.update(schema.revisionRequests).set({ status: "in_progress" }).where(and(eq(schema.revisionRequests.id, rid), eq(schema.revisionRequests.status, "new")));
    } else if (stage === "sent" || stage === "complete") {
      await d.update(schema.revisionRequests).set({ status: "done", resolvedAt: now, resolvedBy: by }).where(and(eq(schema.revisionRequests.id, rid), ne(schema.revisionRequests.status, "done")));
    }
  }
  await logActivity({ actorEmail: by, action: "video.stage", listingId: card.listingId, meta: { cardId: id, from: current, to: stage, label: STAGE_LABELS[stage], ...(opts.via ? { via: opts.via } : {}) } });
  const listing = { address: card.listing.address, nda: card.listing.nda };
  try {
    if (opts.line) await hubVideoLine({ cardId: id, listing, text: opts.line });
    else if (stage === "review") await hubVideoReview({ cardId: id, listing, by });
    else if (stage === "sent") await hubVideoLine({ cardId: id, listing, text: `sent to the client by ${by}.` });
    else if (stage === "complete") await hubVideoLine({ cardId: id, listing, text: `complete. Moved by ${by}.` });
  } catch (e) {
    console.error("[video] hub", e);
  }
  return { ok: true, moved: true };
}

// Raw video landed in Dropbox and #video-editing was told: the card is being
// worked on. Only out of In queue, so a card someone put back is left alone.
export async function videoFootageInEditing(cardId: string): Promise<MoveResult> {
  return moveVideoCardTo(cardId, "editing", "studio", { from: ["queue"], via: "footage", line: "in editing: the raw video is in Dropbox and the editors were told." });
}

// A cut was uploaded from the card: a cut to check.
export async function videoCutInReview(cardId: string, by: string, count: number): Promise<MoveResult> {
  return moveVideoCardTo(cardId, "review", by, { from: ["queue", "editing"], via: "cut", line: `in review: ${count} cut${count === 1 ? "" : "s"} uploaded by ${by}.` });
}

// The delivery email went out with a film live in the gallery: the listing's
// open cards are with the agent. A listing with no live film (photos
// delivered first, film still being cut) keeps its card where it is.
export async function videoCardsDelivered(listingId: string, by: string): Promise<string[]> {
  if (!hasDb()) return [];
  const d = db();
  const live = await d.query.media.findFirst({ where: and(eq(schema.media.listingId, listingId), eq(schema.media.kind, "video"), eq(schema.media.published, true)), columns: { id: true } });
  if (!live) return [];
  const cards = await d.query.videoProjects.findMany({ where: and(eq(schema.videoProjects.listingId, listingId), ne(schema.videoProjects.stage, "complete"), envWhere()), columns: { id: true } });
  const moved: string[] = [];
  for (const c of cards) {
    const r = await moveVideoCardTo(c.id, "sent", by, { from: ["queue", "editing", "review"], via: "delivery", line: `sent to the client with the delivery email by ${by}.` });
    if (r.moved) moved.push(c.id);
  }
  return moved;
}

// A card is "outstanding" while a video revision on its listing is open (the
// linked one or any other), so it is never completed under the team's feet.
async function openVideoRevision(listingId: string, linked: string | null): Promise<boolean> {
  const d = db();
  const where = linked
    ? or(eq(schema.revisionRequests.id, linked), and(eq(schema.revisionRequests.listingId, listingId), eq(schema.revisionRequests.mediaKind, "video")))
    : and(eq(schema.revisionRequests.listingId, listingId), eq(schema.revisionRequests.mediaKind, "video"));
  const open = await d.query.revisionRequests.findFirst({ where: and(where, ne(schema.revisionRequests.status, "done")), columns: { id: true } });
  return Boolean(open);
}

// The cron's sweep, every tick, cheap when nothing is due:
//   Sent to client for AUTO_COMPLETE_DAYS with no open revision → Complete;
//   In queue with footage that landed after the card was last moved → In
//   editing (a card the hand-off missed, or one made before this rule).
export async function sweepVideoStages(now = new Date()): Promise<{ completed: string[]; editing: string[] }> {
  const out = { completed: [] as string[], editing: [] as string[] };
  if (!hasDb()) return out;
  const d = db();
  const due = new Date(now.getTime() - AUTO_COMPLETE_DAYS * 86_400_000);
  const sent = await d.query.videoProjects.findMany({ where: and(eq(schema.videoProjects.stage, "sent"), lt(schema.videoProjects.stageChangedAt, due), envWhere()), columns: { id: true, listingId: true, revisionRequestId: true }, limit: 50 });
  for (const c of sent) {
    if (await openVideoRevision(c.listingId, c.revisionRequestId)) continue;
    const r = await moveVideoCardTo(c.id, "complete", "studio", { from: ["sent"], via: "auto", line: `complete: ${AUTO_COMPLETE_DAYS} days with the client and nothing open.` });
    if (r.moved) out.completed.push(c.id);
  }
  const queued = await d.query.videoProjects.findMany({ where: and(eq(schema.videoProjects.stage, "queue"), envWhere(), gt(schema.videoProjects.footageAt, schema.videoProjects.stageChangedAt)), columns: { id: true, listingId: true, revisionRequestId: true }, limit: 50 });
  for (const c of queued) {
    if (await openVideoRevision(c.listingId, c.revisionRequestId)) continue;
    const r = await videoFootageInEditing(c.id);
    if (r.moved) out.editing.push(c.id);
  }
  return out;
}

// Whether a listing has a card here (the cut upload is open to video
// editors only on those listings).
export async function listingHasVideoCard(listingId: string): Promise<boolean> {
  if (!hasDb()) return false;
  const r = await db().query.videoProjects.findFirst({ where: and(eq(schema.videoProjects.listingId, listingId), envWhere()), columns: { id: true } });
  return Boolean(r);
}

// The card row itself (this environment), for the actions.
export async function videoCardRow(id: string) {
  return db().query.videoProjects.findFirst({ where: and(eq(schema.videoProjects.id, id), envWhere()), with: { listing: { columns: { id: true, address: true, nda: true, clientId: true } } } });
}

// ---- Demo mode (no database, local review only) -------------------------------------

const demoCard = (o: Partial<VideoCard> & Pick<VideoCard, "id" | "stage" | "address">): VideoCard => ({
  listingId: `demo-${o.id}`,
  street: o.address.split(",")[0],
  nda: false,
  clientName: "Avery Chen",
  shootDate: "2026-10-22",
  startTime: "10:00",
  launchDate: null,
  services: ["Cinematic listing film"],
  speed: "Medium",
  assignee: null,
  footage: true,
  films: 0,
  filmsLive: 0,
  revision: null,
  stageChangedAt: "2026-10-24T17:00:00.000Z",
  createdAt: "2026-10-20T17:00:00.000Z",
  ...o,
});

export const DEMO_VIDEO_CARDS: VideoCard[] = [
  demoCard({ id: "v1", stage: "queue", address: "2305 Example Hazel Road, Springfield, CA 90000", services: ["Cinematic listing film", "Vertical reel crop"], speed: "Slow / Cinematic", launchDate: "2026-10-30" }),
  demoCard({ id: "v2", stage: "queue", address: "1550 Example Rowan Road, Springfield, CA 90000", shootDate: "2026-10-28", footage: false, services: ["Luxury social reel", "Agent on camera"], speed: "Faster" }),
  demoCard({ id: "v3", stage: "editing", address: "88 Example Maple Road, Springfield, CA 90000", clientName: "Taylor Brooks", assignee: "editor@example.com", services: ["Property video", "Twilight video"] }),
  demoCard({ id: "v4", stage: "review", address: "610 Example Beech Road, Springfield, CA 90000", clientName: "Taylor Brooks", assignee: "editor@example.com", films: 1 }),
  demoCard({ id: "v5", stage: "queue", address: "1420 Example Alder Drive, Springfield, CA 90000", assignee: "editor@example.com", films: 1, filmsLive: 1, revision: { id: "demo-r-video", status: "new", round: 1, comments: 3 }, services: ["Cinematic listing film"], speed: "Slower" }),
  demoCard({ id: "v6", stage: "sent", address: "2121 Example Juniper Drive, Springfield, CA 90000", clientName: "Taylor Brooks", films: 2, filmsLive: 2, services: ["Social reel"] }),
  demoCard({ id: "v7", stage: "complete", address: "1127 Example Yew Road, Springfield, CA 90000", clientName: "Taylor Brooks", films: 1, filmsLive: 1 }),
];

function demoVideoDetail(id: string): VideoCardDetail | null {
  const c = DEMO_VIDEO_CARDS.find((x) => x.id === id);
  if (!c) return null;
  const folder = `/Listings/${c.address}`;
  return {
    ...c,
    booking: { id: "demo-b", status: "confirmed", music: c.id === "v5" ? "https://open.spotify.com/track/demo" : null, formNotes: "Please feature the ocean view from the primary suite. Gate code is on the booking.", customRequest: null },
    dropbox: { url: `https://www.dropbox.com/home/Listings/${encodeURIComponent(c.address)}/Video`, shared: false, folder: `${folder}/Video`, connected: false },
    clips: { count: c.footage ? 14 : 0, inDropbox: 0 },
    filmFiles: c.films ? [{ id: "demo-film-1", filename: `${c.street.replace(/\s+/g, "-")}-Film.mp4`, published: c.filmsLive > 0, held: c.filmsLive === 0, url: null, createdAt: "2026-10-24T17:00:00.000Z" }] : [],
    editorNotes: c.id === "v5" ? "Song: Golden Hour instrumental. Selects in the Video folder under Selects." : null,
    client: { id: "demo-c1", name: c.clientName, team: null, videoNotes: "Likes slow, cinematic pacing. No drone in the first 5 seconds. Always a vertical with no music." },
    history: {
      pastBookings: [{ date: "2026-09-14", street: "75 Example Aspen Road", services: ["Cinematic listing film", "Vertical reel crop"], speed: "Slow / Cinematic", music: null }],
      revisions: [
        ...(c.revision
          ? [{ id: "demo-r-video", listingId: c.listingId, street: c.street, createdAt: "2026-10-25T18:12:00.000Z", status: "new", notes: "Overall the pacing feels a little fast for this house.", source: null, comments: [{ atMs: 12_000, filename: "1420-Alder-Film.mp4", note: "Hold the ocean view shot longer, it cuts away too soon." }, { atMs: 47_500, filename: "1420-Alder-Film.mp4", note: "The kitchen looks too blue here, warm it up to match the rest." }, { atMs: 83_000, filename: "1420-Alder-Film.mp4", note: "Swap this song section, the beat drop feels off for the twilight." }] }]
          : []),
        { id: "demo-r-old", listingId: "demo-other", street: "75 Example Aspen Road", createdAt: "2026-09-20T18:00:00.000Z", status: "done", notes: "", source: "quo", comments: [{ atMs: 5_000, filename: "75-Aspen-Film.mp4", note: "Start on the front door, not the drone." }] },
      ],
      brainLines: ["Always deliver a horizontal film, a vertical reel, and a vertical with no music."],
    },
  };
}
