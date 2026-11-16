// The Photo QC board (Oct 26 2026). the owner: a tab for photo quality control,
// "a similar board to the video tab", where the team opens a shoot once its
// photos are back and the automatic QC has run, and reviews it on the shoot
// page that already exists. The Photo QC team (role "qa") sees only this
// board and Revisions.
//
// Unlike the Video board nobody drags these cards: each shoot sits in the
// column its pipeline status says, so the board can never disagree with the
// shoot page.
//   In editing     uploaded through automatic QC (the pipeline is working)
//   Ready for QC   ready_for_review: every frame is in and QC has run
//   Final review   the editors sent corrected photos for the final pass
//                  (Oct 28 2026, src/lib/final-review.ts); stays until the
//                  shoot is published after that send
//   Revisions      open photo revision requests the client has sent
//   Published      published in the last 14 days (a published shoot whose
//                  corrected frames still wait for Publish goes back to
//                  Ready for QC, flagged)
//   Stopped        failed: the pipeline needs a hand (an admin retries)
import { inArray } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { ShootStatus } from "@/db/schema";
import { adminRevisions, adminShoots, publishedWaiting } from "./admin-data";
import { finalReviewOpen, lastFinalReviews } from "./final-review";
import { revisionRounds, revisionShoots } from "./revision-frames";
import { ACTIVE_STATUSES, STEP_LABELS, photoFileCount } from "./shoot-status";

export const PHOTO_QC_COLUMNS = [
  { key: "editing", label: "In editing", hint: "Being edited, then the automatic QC" },
  { key: "review", label: "Ready for QC", hint: "Frames are in, QC has run" },
  { key: "final", label: "Final review", hint: "Corrected by the editors, waiting for the final pass" },
  { key: "revisions", label: "Revisions", hint: "Photo changes a client asked for" },
  { key: "published", label: "Published", hint: "Live in the gallery, last 14 days" },
  { key: "stopped", label: "Stopped", hint: "Needs an admin to retry" },
] as const;
export type PhotoQcColumn = (typeof PHOTO_QC_COLUMNS)[number]["key"];

export type PhotoQcCard = {
  id: string;
  href: string;
  street: string;
  nda: boolean;
  clientName: string | null;
  step: string; // the shoot's own step label, or the revision status
  at: string | null; // when it entered this column
  by: string | null; // who uploaded or published, or the revision's source
  frames: number | null;
  twilight: number;
  qc: { avg: number | null; fix: number; blocked: number; minor: number; checked: number } | null;
  error: string | null;
  photos: number | null; // revisions: how many photos the notes are on
  waiting: number; // a published shoot's frames waiting for Publish
  corrected: number | null; // final review: corrected photos in the send
  // Oct 30 2026: the client's revision round on this shoot (src/lib/revision-frames.ts).
  revision?: { fixed: number; waiting: number; live: number } | null;
  // Nov 2 2026: when the shoot was uploaded (submitted), and "Shoot 1 of 2"
  // when its listing has more than one shoot on the board. Null on revisions.
  uploadedAt: string | null;
  nth: { n: number; of: number } | null;
  // Nov 6 2026: the column menu on every card (cardMenu): its pick key and
  // the shoot it opens (for the log); pick is the column moved to by hand.
  menu?: { key: string; shootId: string | null };
  pick?: { column: PhotoQcColumn; by: string | null; at: string } | null;
};

const PUBLISHED_DAYS = 14;

export function columnFor(status: ShootStatus): PhotoQcColumn | null {
  if (ACTIVE_STATUSES.includes(status)) return "editing";
  if (status === "ready_for_review") return "review";
  if (status === "published") return "published";
  if (status === "failed") return "stopped";
  return null; // draft (still uploading) and video only never show here
}

// Nov 2 2026 (20 Dogwood): a listing shot on two days has two shoots and
// so two cards with the same street and client, which read as a duplicate
// listing. Shoots that share a listing on the board get "Shoot 1 of 2", in
// the order they were uploaded; a lone shoot gets nothing.
export function shootOrdinals(rows: { id: string; listingId: string; uploadedAt: string | null }[]): Map<string, { n: number; of: number }> {
  const byListing = new Map<string, typeof rows>();
  for (const r of rows) byListing.set(r.listingId, [...(byListing.get(r.listingId) ?? []), r]);
  const out = new Map<string, { n: number; of: number }>();
  for (const list of byListing.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.uploadedAt ?? "").localeCompare(b.uploadedAt ?? ""));
    sorted.forEach((r, i) => out.set(r.id, { n: i + 1, of: sorted.length }));
  }
  return out;
}

// Nov 6 2026: "The status for Photo QC should mimic the column
// names, and move the card to the column selected." Admins and the Photo QC
// team move any card from the menu at its foot, like a Video card
// (src/app/admin/photo-qc-actions.ts); "There should still be a dropdown on
// the cards listed under revisions as well." Each card has its own pick: a
// shoot's own card under shoot:<id>, a revision's own card under
// revision:<id>, so moving one never moves (or doubles) the other. A pick
// wins over the column the pipeline says until the client sends after it
// (overridePicks): an open photo revision on that shoot, or that request
// sent again with more notes. Then the card goes back to its own column.
export const isPhotoQcColumn = (k: unknown): k is PhotoQcColumn => PHOTO_QC_COLUMNS.some((c) => c.key === k);

export type PhotoQcPick = { column: PhotoQcColumn; by: string | null; at: string };

// The picks by card key. Never throws: a missing table (the migration not
// run yet) or a failed read leaves every card where the pipeline puts it.
export async function loadPicks(keys: string[]): Promise<Map<string, PhotoQcPick>> {
  const out = new Map<string, PhotoQcPick>();
  if (!hasDb() || !keys.length) return out;
  try {
    const rows = await db().select().from(schema.photoQcPicks).where(inArray(schema.photoQcPicks.cardKey, keys));
    for (const r of rows) if (isPhotoQcColumn(r.status)) out.set(r.cardKey, { column: r.status, by: r.setBy, at: r.setAt.toISOString() });
  } catch (e) {
    console.error("[photo-qc] pick read failed:", e instanceof Error ? e.message : e);
  }
  return out;
}

// A card that opens /admin/shoots/<its own id> is the shoot's card; every
// other card is a revision's own card (its id is the request's).
const opensShoot = (href: string) => /^\/admin\/shoots\/([^/#?]+)/.exec(href)?.[1] ?? null;
export function cardMenu(c: { id: string; href: string }): { key: string; shootId: string | null } {
  const sid = opensShoot(c.href);
  return sid === c.id ? { key: `shoot:${c.id}`, shootId: c.id } : { key: `revision:${c.id}`, shootId: sid };
}

// Moves each picked card to its column, unless the client sent after the
// pick (sentAt: card key to ms).
export function overridePicks(board: Record<PhotoQcColumn, PhotoQcCard[]>, sentAt: Map<string, number>): void {
  for (const col of PHOTO_QC_COLUMNS.map((c) => c.key)) {
    for (const c of [...board[col]]) {
      const p = c.pick;
      if (!p || !c.menu || p.column === col) continue;
      if ((sentAt.get(c.menu.key) ?? 0) > new Date(p.at).getTime()) continue;
      board[col] = board[col].filter((x) => x !== c);
      board[p.column].push(c);
    }
  }
}

export async function photoQcBoard(now = Date.now()): Promise<Record<PhotoQcColumn, PhotoQcCard[]>> {
  const board: Record<PhotoQcColumn, PhotoQcCard[]> = { editing: [], review: [], final: [], revisions: [], published: [], stopped: [] };
  const [shoots, revisions] = await Promise.all([adminShoots({ statuses: [...ACTIVE_STATUSES, "ready_for_review", "published", "failed"], limit: 300 }), adminRevisions()]);
  const cutoff = now - PUBLISHED_DAYS * 86_400_000;
  const reviewable = shoots.filter((s) => s.status === "ready_for_review" || s.status === "published");
  const openPhotoRevisions = revisions.filter((r) => r.status !== "done" && (r.mediaKind ?? "photo") === "photo" && r.submittedAt);
  const [waiting, finals, rounds, revShoot] = await Promise.all([
    publishedWaiting(shoots.filter((s) => s.status === "published").slice(0, 80)),
    lastFinalReviews(reviewable.map((s) => s.id)),
    revisionRounds(reviewable.slice(0, 120).map((s) => ({ id: s.id, listingId: s.listingId }))),
    revisionShoots(openPhotoRevisions),
  ]);
  for (const s of shoots) {
    let col = columnFor(s.status);
    if (!col) continue;
    const w = waiting.get(s.id)?.waiting ?? 0;
    if (w) col = "review";
    else if (col === "published" && (!s.publishedAt || new Date(s.publishedAt).getTime() < cutoff)) continue;
    // Sent for final review and not published since: the final pass is next.
    const fr = finals.get(s.id);
    const final = col === "review" && finalReviewOpen(fr, s.publishedAt);
    if (final) col = "final";
    const q = s.qcSummary;
    const tw = s.options?.twilight?.enabled ? s.options.twilight.count : 0;
    const round = rounds.get(s.id) ?? null;
    board[col].push({
      id: s.id,
      // A revision round opens straight at its photos.
      href: round && (round.fixed || round.waiting) ? `/admin/shoots/${s.id}#revision` : `/admin/shoots/${s.id}`,
      street: s.address.split(",")[0].trim(),
      nda: s.nda,
      clientName: s.clientName,
      step: STEP_LABELS[s.status],
      at: final && fr ? fr.at.toISOString() : col === "review" ? (w ? s.updatedAt : s.readyAt ?? s.updatedAt) : col === "published" ? s.publishedAt : col === "editing" ? s.submittedAt ?? s.createdAt : s.updatedAt,
      by: final && fr ? fr.by : col === "published" ? s.publishedBy : s.createdBy,
      frames: col === "editing" ? photoFileCount(s) : s.photoCount,
      twilight: tw,
      qc: q ? { avg: q.avgScore, fix: q.fix, blocked: q.blocked, minor: q.minor, checked: q.checked } : null,
      error: col === "stopped" ? s.error : null,
      photos: null,
      waiting: w,
      corrected: final && fr ? fr.corrected : null,
      revision: round ? { fixed: round.fixed, waiting: round.waiting, live: round.live } : null,
      uploadedAt: s.submittedAt ?? s.createdAt,
      nth: null,
    });
  }
  // "Shoot 1 of 2" across the shoot cards on the board, whatever column each sits in.
  const placed = (["editing", "review", "final", "published", "stopped"] as const).flatMap((k) => board[k]);
  const listingOf = new Map(shoots.map((s) => [s.id, s.listingId]));
  const ordinals = shootOrdinals(placed.map((c) => ({ id: c.id, listingId: listingOf.get(c.id) ?? c.id, uploadedAt: c.uploadedAt })));
  for (const c of placed) c.nth = ordinals.get(c.id) ?? null;
  // Nov 5 2026: a revision card opens the shoot itself, like every other
  // card. A request whose notes name no photo (a text, a general ask) used to
  // open the Revisions list instead; now it opens the listing's latest shoot.
  const latestShoot = new Map<string, string>();
  for (const s of [...shoots].sort((a, b) => String(b.publishedAt ?? b.readyAt ?? b.updatedAt).localeCompare(String(a.publishedAt ?? a.readyAt ?? a.updatedAt)))) {
    if (!latestShoot.has(s.listingId) && (s.status === "published" || s.status === "ready_for_review")) latestShoot.set(s.listingId, s.id);
  }
  for (const r of revisions) {
    if (r.status === "done" || (r.mediaKind ?? "photo") !== "photo" || !r.submittedAt) continue;
    const onShoot = revShoot.get(r.id) ?? latestShoot.get(r.listingId);
    board.revisions.push({
      id: r.id,
      // The request's photos on their shoot (notes beside them), else the ticket.
      href: onShoot ? `/admin/shoots/${onShoot}#revision` : `/admin/revisions#rev-${r.id}`,
      street: r.address.split(",")[0].trim(),
      nda: false,
      clientName: r.clientName ?? null,
      step: r.status === "in_progress" ? "In progress" : "New",
      at: r.submittedAt ?? r.createdAt,
      by: r.source === "quo" ? "by text" : r.source === "email" ? "by email" : "from the gallery",
      frames: null,
      twilight: 0,
      qc: null,
      error: null,
      photos: r.items.length || r.filenames.length || null,
      waiting: 0,
      corrected: null,
      uploadedAt: null,
      nth: null,
    });
  }
  // Nov 6 2026: columns picked by hand (see overridePicks).
  const cards = PHOTO_QC_COLUMNS.flatMap((col) => board[col.key]);
  for (const c of cards) c.menu = cardMenu(c);
  const picks = await loadPicks(cards.map((c) => c.menu!.key));
  for (const c of cards) c.pick = picks.get(c.menu!.key) ?? null;
  // When the client last sent: per request, and per shoot (its latest request).
  const sentAt = new Map<string, number>();
  const later = (k: string, at: number) => {
    if (at > (sentAt.get(k) ?? 0)) sentAt.set(k, at);
  };
  for (const r of openPhotoRevisions) {
    const at = new Date(r.submittedAt ?? r.createdAt).getTime();
    later(`revision:${r.id}`, at);
    const sid = revShoot.get(r.id) ?? latestShoot.get(r.listingId);
    if (sid) later(`shoot:${sid}`, at);
  }
  overridePicks(board, sentAt);
  const t = (c: PhotoQcCard) => (c.at ? new Date(c.at).getTime() : 0);
  // Work queues oldest first (first in, first reviewed); history newest first.
  for (const k of ["editing", "review", "final", "revisions"] as const) board[k].sort((a, b) => t(a) - t(b));
  for (const k of ["published", "stopped"] as const) board[k].sort((a, b) => t(b) - t(a));
  return board;
}
