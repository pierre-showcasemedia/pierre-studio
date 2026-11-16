"use server";
// The Video board's actions (Oct 26 2026, src/lib/video-board.ts). Admins and
// video editors move cards, assign them and keep the notes; only an admin
// adds or removes a card by hand. Moving a card keeps its linked video
// revision in step (In editing: In progress; Sent to client or Complete:
// Done). The hub hears about In review (tagging video QC), Sent to client
// and Complete; the other moves are only logged. The move itself lives in
// src/lib/video-board.ts (moveVideoCardTo), shared with the automatic moves
// (footage in, cut uploaded, delivery email, the 3-day auto-complete).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { assertVideo, requireAdmin } from "@/lib/admin";
import { videoAssignees } from "@/lib/admin-allow";
import { logActivity } from "@/lib/activity";
import { currentEnv } from "@/lib/jobs-core";
import { hubVideoLine } from "@/lib/slack";
import { isVideoStage, moveVideoCardTo, videoCardRow } from "@/lib/video-board";

const NOTES_MAX = 4000;
const field = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function refresh(id?: string) {
  revalidatePath("/admin/video");
  if (id) revalidatePath(`/admin/video/${id}`);
}

export async function moveVideoCard(id: string, stage: string): Promise<{ ok: boolean; error?: string }> {
  const staff = await assertVideo();
  if (!hasDb()) return { ok: true };
  if (!isVideoStage(stage)) return { ok: false, error: "Unknown stage." };
  const r = await moveVideoCardTo(id, stage, staff.email);
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return { ok: true };
}

// The card page's stage buttons.
export async function moveVideoCardForm(id: string, stage: string): Promise<void> {
  const r = await moveVideoCard(id, stage);
  redirect(`/admin/video/${id}${r.ok ? "?saved=stage" : `?error=${encodeURIComponent(r.error ?? "That did not save.")}`}`);
}

export async function assignVideoCard(id: string, formData: FormData): Promise<void> {
  const staff = await assertVideo();
  const to = field(formData, "assignee").toLowerCase() || null;
  if (hasDb()) {
    const card = await videoCardRow(id);
    if (!card) redirect("/admin/video?error=That%20card%20is%20gone.");
    if (to && !(await videoAssignees()).includes(to)) redirect(`/admin/video/${id}?error=${encodeURIComponent("Only a video editor or an admin can take a card.")}`);
    if ((card.assignee ?? null) !== to) {
      await db().update(schema.videoProjects).set({ assignee: to, updatedAt: new Date() }).where(eq(schema.videoProjects.id, id));
      await logActivity({ actorEmail: staff.email, action: "video.assigned", listingId: card.listingId, meta: { cardId: id, to } });
      if (to) await hubVideoLine({ cardId: id, listing: { address: card.listing.address, nda: card.listing.nda }, text: `assigned to ${to} by ${staff.email}.` }).catch((e) => console.error("[video] hub", e));
    }
  }
  refresh(id);
  redirect(`/admin/video/${id}?saved=assignee`);
}

export async function saveVideoEditorNotes(id: string, formData: FormData): Promise<void> {
  const staff = await assertVideo();
  const notes = field(formData, "notes").slice(0, NOTES_MAX) || null;
  if (hasDb()) {
    const card = await videoCardRow(id);
    if (!card) redirect("/admin/video?error=That%20card%20is%20gone.");
    await db().update(schema.videoProjects).set({ editorNotes: notes, updatedAt: new Date() }).where(eq(schema.videoProjects.id, id));
    await logActivity({ actorEmail: staff.email, action: "video.notes_saved", listingId: card.listingId, meta: { cardId: id } });
  }
  refresh(id);
  redirect(`/admin/video/${id}?saved=notes`);
}

// The client's standing video notes (clients.video_notes), kept from the card.
export async function saveClientVideoNotes(id: string, formData: FormData): Promise<void> {
  const staff = await assertVideo();
  const notes = field(formData, "videoNotes").slice(0, NOTES_MAX) || null;
  if (hasDb()) {
    const card = await videoCardRow(id);
    if (!card) redirect("/admin/video?error=That%20card%20is%20gone.");
    await db().update(schema.clients).set({ videoNotes: notes }).where(eq(schema.clients.id, card.listing.clientId));
    await logActivity({ actorEmail: staff.email, action: "client.video_notes", listingId: card.listingId, clientId: card.listing.clientId, meta: { cardId: id } });
  }
  refresh(id);
  redirect(`/admin/video/${id}?saved=client`);
}

// Admin only: a card for a listing that has none (a hand-booked shoot before
// its footage is uploaded), and removing a card made by mistake.
export async function addVideoCard(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const listingId = field(formData, "listingId");
  if (!hasDb() || !listingId) redirect("/admin/video");
  const d = db();
  const listing = await d.query.listings.findFirst({ where: eq(schema.listings.id, listingId), columns: { id: true } });
  if (!listing) redirect("/admin/video?error=That%20listing%20is%20gone.");
  const [row] = await d
    .insert(schema.videoProjects)
    .values({ key: `manual:${listingId}:${Date.now()}`, listingId, stage: "queue", env: currentEnv() })
    .returning({ id: schema.videoProjects.id });
  await logActivity({ actorEmail: actor, action: "video.card_created", listingId, meta: { cardId: row.id, via: "admin" } });
  refresh();
  redirect(`/admin/video/${row.id}`);
}

export async function removeVideoCard(id: string): Promise<void> {
  const actor = await requireAdmin();
  if (hasDb()) {
    const card = await videoCardRow(id);
    if (card) {
      await db().delete(schema.videoProjects).where(eq(schema.videoProjects.id, id));
      await logActivity({ actorEmail: actor, action: "video.card_removed", listingId: card.listingId, meta: { cardId: id } });
    }
  }
  refresh();
  redirect("/admin/video?saved=removed");
}
