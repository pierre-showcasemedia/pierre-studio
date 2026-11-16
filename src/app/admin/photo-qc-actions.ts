"use server";
// The Photo QC status bar (Nov 6 2026, src/lib/photo-qc.ts): move a card to
// another column from its menu. A shoot's card is keyed shoot:<id>, a
// revision's own card revision:<id>. Admins and the Photo QC team. Answers
// instead of redirecting, like moveVideoCard, so the board stays put.
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireStaff } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { PHOTO_QC_COLUMNS, isPhotoQcColumn } from "@/lib/photo-qc";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// card: the card's menu (key, and the shoot a revision card opens, which
// only names the shoot in the log).
export async function setPhotoQcStatus(card: { key: string; shootId?: string | null }, column: string): Promise<{ ok: boolean; error?: string }> {
  const staff = await requireStaff();
  const m = /^(shoot|revision):([\w-]{1,64})$/.exec(typeof card?.key === "string" ? card.key : "");
  if (!m) return { ok: false, error: "That card could not be found." };
  if (!isPhotoQcColumn(column)) return { ok: false, error: "Unknown column." };
  // Demo mode: nothing is saved; the card stays moved until the page reloads.
  if (!hasDb()) return { ok: true };
  const [, kind, id] = m;
  if (!UUID.test(id)) return { ok: false, error: "That card could not be found." };
  try {
    const d = db();
    let listingId: string;
    let shootId: string | null = null;
    if (kind === "shoot") {
      const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, id), columns: { id: true, listingId: true } });
      if (!shoot) return { ok: false, error: "That shoot could not be found." };
      listingId = shoot.listingId;
      shootId = shoot.id;
    } else {
      const rev = await d.query.revisionRequests.findFirst({ where: eq(schema.revisionRequests.id, id), columns: { id: true, listingId: true } });
      if (!rev) return { ok: false, error: "That revision could not be found." };
      listingId = rev.listingId;
      // Log against the shoot the card opens, when it is on the same listing.
      const sid = typeof card.shootId === "string" && UUID.test(card.shootId) ? card.shootId : null;
      const shoot = sid ? await d.query.shoots.findFirst({ where: eq(schema.shoots.id, sid), columns: { id: true, listingId: true } }) : null;
      if (shoot && shoot.listingId === listingId) shootId = shoot.id;
    }
    const [prev] = await d.select({ status: schema.photoQcPicks.status }).from(schema.photoQcPicks).where(eq(schema.photoQcPicks.cardKey, card.key));
    // Always written, even to the same column: set_at is what a later send is compared with.
    const now = new Date();
    await d
      .insert(schema.photoQcPicks)
      .values({ cardKey: card.key, shootId: kind === "shoot" ? id : null, revisionId: kind === "revision" ? id : null, status: column, setBy: staff.email, setAt: now })
      .onConflictDoUpdate({ target: schema.photoQcPicks.cardKey, set: { status: column, setBy: staff.email, setAt: now } });
    const label = PHOTO_QC_COLUMNS.find((c) => c.key === column)?.label ?? column;
    await logActivity({ actorEmail: staff.email, action: "shoot.qc_status", shootId, listingId, meta: { to: column, from: prev?.status ?? null, label, ...(kind === "revision" ? { revisionId: id } : {}) } });
  } catch (e) {
    console.error("[photo-qc] move failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: "That did not save. Try again." };
  }
  revalidatePath("/admin/photo-qc");
  return { ok: true };
}
