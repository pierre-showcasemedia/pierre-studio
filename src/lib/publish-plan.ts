// What a Publish sends, and the words around it (Nov 2 2026). Pure: no
// database, shared by the shoot page's grid (client) and the server action.
//
// the owner's rule: ONLY approved photos ever reach the client. Rejected photos
// never go, whatever button is pressed; unreviewed photos stay internal until
// someone approves them. Every Publish says how many approved photos it sends
// and, afterwards, how many are now visible to the client, so nobody has to
// guess what the client can see.
//
// Destination: the first delivery goes to the main gallery. After that, swaps
// (corrected photos the client already saw), fixes from a revision round and
// late additions go to "Revised images", a section of its own at the top of
// the client's gallery (media.revision = true, groupGallery), so the client
// and the team can tell what changed. The team can pick the main gallery
// instead for a photo that simply belongs there.
import type { QcState } from "@/db/schema";

export type PlanFrame = { id: string; qcState: QcState; published: boolean; held?: boolean | null; section?: string | null };
export type Destination = "gallery" | "revised";
export const DESTINATION_LABEL: Record<Destination, string> = { gallery: "Main gallery", revised: "Revised images" };

export type PublishPlan = {
  ids: string[]; // approved and not live: what goes
  approved: number; // ids.length
  rejected: number; // left out, never go
  pending: number; // left out until approved
  held: number; // approved, moved to internal by hand; left alone unless includeHeld
  live: number; // already client visible, nothing to do
};

// pick: only these frames (a selection); otherwise every frame. includeHeld:
// a Publish pressed on the photo itself or on a selection means it, so a
// photo held back by hand goes too; the bulk Publish leaves held photos alone.
// shootPublished: whether the frames' shoot has been published. A frame
// marked published on a shoot that never was is not live (src/lib/visibility.ts
// "waiting", e.g. set Client visible on the listing page before the first
// Publish): it goes like any other approved frame. Nov 7 2026, the business-4585 Via
// Maria: 83 such revised photos read "0 approved to publish".
export function publishPlan(frames: PlanFrame[], opts: { pick?: Iterable<string> | null; includeHeld?: boolean; shootPublished?: boolean } = {}): PublishPlan {
  const pick = opts.pick ? new Set(opts.pick) : null;
  const shootLive = opts.shootPublished !== false;
  const plan: PublishPlan = { ids: [], approved: 0, rejected: 0, pending: 0, held: 0, live: 0 };
  for (const f of frames) {
    if (pick && !pick.has(f.id)) continue;
    if (f.qcState === "rejected") plan.rejected++;
    else if (f.qcState === "pending") plan.pending++;
    else if (f.published && !f.held && shootLive) plan.live++;
    else if (f.held && !opts.includeHeld) plan.held++;
    else plan.ids.push(f.id);
  }
  plan.approved = plan.ids.length;
  return plan;
}

// New photos after the first delivery are revisions, swaps or additions: they
// go to Revised images unless the team says otherwise.
export const defaultDestination = (shootPublished: boolean): Destination => (shootPublished ? "revised" : "gallery");

export const photoWord = (n: number) => (n === 1 ? "photo" : "photos");

// The button. finals: "Publish finals only" (everything else moves to
// internal). fixed: the revision round's fixed photos.
export function publishLabel(n: number, dest: Destination, opts: { finals?: boolean; fixed?: boolean } = {}): string {
  const where = dest === "revised" ? "as Revised images" : "to the listing";
  if (opts.fixed) return `Publish ${n} fixed ${where} →`;
  if (opts.finals) return `Publish ${n} approved final${n === 1 ? "" : "s"} only →`;
  return `Publish ${n} approved ${photoWord(n)} ${where} →`;
}

// After a Publish: exactly what the client can see now, and what stays back.
export function publishedBanner(p: { live: number; dest: Destination; hidden?: number; skipped?: { rejected: number; pending: number } | null }): string {
  const where = p.dest === "revised" ? "in Revised images on the listing page" : "on the listing page";
  const parts = [`${p.live} approved ${photoWord(p.live)} ${p.live === 1 ? "is" : "are"} now visible to the client ${where}.`];
  const back: string[] = [];
  if (p.skipped?.rejected) back.push(`${p.skipped.rejected} rejected`);
  if (p.skipped?.pending) back.push(`${p.skipped.pending} unreviewed`);
  if (back.length) parts.push(`${back.join(" and ")} ${photoWord((p.skipped?.rejected ?? 0) + (p.skipped?.pending ?? 0))} stay internal only.`);
  if (p.hidden) parts.push(`The other ${p.hidden} ${photoWord(p.hidden)} of this shoot moved to internal only.`);
  return parts.join(" ");
}

export const NOTHING_APPROVED = "Nothing published: none of these photos are approved. Approve them first. Rejected and unreviewed photos never reach the client.";
