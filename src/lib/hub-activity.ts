// The hub's running log (Oct 2026). the owner: "the studio bot in
// #studio-hub should log most things in the backend, including when a
// delivery is sent." Every logActivity() row whose action is listed below
// also posts one line, after the response (next/server after()), so an admin
// action never waits on Slack and a Slack hiccup never fails one.
//
// Left out on purpose:
//   - actions that already have their own post (shoot uploaded, ready for
//     review, QC done, stopped, published; revision requested; gallery
//     approved; booking cards and time confirmed / rescheduled / canceled;
//     job alerts), so nothing doubles;
//   - payments: amounts live in #payments only;
//   - high-frequency edits: one frame's QC, a field edit on a file, a drag in
//     the gallery order, each corrected final (one summary line instead),
//     view as, zip rebuilds, the previous portal migration.
// Booking lines (shooter, status, booking email, calendar invite) go to the
// bookings channel when it is set, like every other booking line; else here.
//
// Same rules as every hub post: money-free (scrubbed, never thrown), no phone
// numbers, NDA listings stay "an NDA listing" and never show filenames.
// Preview and local lines start "Test site:", since previews post to the same
// channel as production.
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ActivityAction } from "./activity";
import { bookingStatusLabel } from "./booking-status";
import { currentEnv } from "./jobs-core";
import { roleAs, roleWord, roleWordCap } from "./role-words";
import { adminLink, hubListingName, postBookingLine, postToHub, scrubMoney, flagged } from "./slack";
import { brand } from "@/lib/brand";

export type HubActivityRow = {
  actorEmail?: string | null;
  action: ActivityAction;
  listingId?: string | null;
  shootId?: string | null;
  clientId?: string | null;
  meta?: Record<string, unknown>;
};

type Channel = "hub" | "bookings";

const CHANNEL: Partial<Record<ActivityAction, Channel>> = {
  "listing.delivery_email": "hub",
  "listing.created": "hub",
  "listing.updated": "hub",
  "listing.deleted": "hub",
  "listing.cover": "hub",
  "listing.locked": "hub",
  "listing.unlocked": "hub",
  "client.created": "hub",
  "client.updated": "hub",
  "client.deleted": "hub",
  "client.signin_link_sent": "hub",
  "client.downloaded": "hub",
  "client.dropbox": "hub",
  "team.created": "hub",
  "team.updated": "hub",
  "team.deleted": "hub",
  "team.member_added": "hub",
  "team.member_removed": "hub",
  "media.uploaded": "hub",
  "media.finals_uploaded": "hub",
  "media.repaired": "hub",
  "media.deleted": "hub",
  "media.hidden": "hub",
  "media.shown": "hub",
  "media.downloaded": "hub",
  "revision.status": "hub",
  "admin.added": "hub",
  "admin.removed": "hub",
  "admin.role_set": "hub",
  "media.visibility": "hub",
  "shoot.retried": "hub",
  "booking.shooter_assigned": "bookings",
  "booking.status_set": "bookings",
  "booking.client_rescheduled": "bookings",
  "email.booking_sent": "bookings",
  "email.shooter_invite_sent": "bookings",
  // Oct 21 2026: Edit booking and the client's time emails.
  "booking.edited": "bookings",
  "email.time_confirmed_sent": "bookings",
  "email.rescheduled_sent": "bookings",
  // Oct 21 2026: the Dropbox raw mirror. One line when a shoot's last file
  // lands, one when the connection changes; never a line per file.
  "shoot.dropbox_synced": "hub",
  "shoot.dropbox_requeued": "hub",
  // Oct 27 2026: raws leave R2 once Dropbox's copy is verified. One line per
  // shoot when the last one goes, one the first time a check keeps a file.
  "shoot.r2_raws_removed": "hub",
  "shoot.r2_raw_kept": "hub",
  "dropbox.connected": "hub",
  "dropbox.disconnected": "hub",
  "twilight.preset_saved": "hub",
  "shoot.twilight_made": "hub",
  // Oct 26 2026: one line per upload (src/lib/upload-runs.ts).
  "media.upload_finished": "hub",
};

export function hubChannelFor(a: HubActivityRow): Channel | null {
  // A team created with members logs one member_added per person; the
  // team.created line already counts them.
  if (a.action === "team.member_added" && a.meta?.onCreate) return null;
  // Reschedule on the booking page posts its own line; a move made by
  // editing the listing's shoot date is logged here.
  if (a.action === "booking.rescheduled") return a.meta?.via === "listing" ? "bookings" : null;
  // An upload's batches (meta.run) stay quiet: the run posts one
  // media.upload_finished line when it ends (src/lib/upload-runs.ts). Making
  // the corrected frames of an upload client visible is part of that line too.
  if (a.meta?.run && (a.action === "media.uploaded" || a.action === "media.finals_uploaded")) return null;
  // An upload sent for final review posts the tagged final review line instead (src/lib/final-review.ts).
  if (a.action === "media.upload_finished" && a.meta?.review) return null;
  if (a.action === "media.visibility" && a.meta?.via === "upload") return null;
  return CHANNEL[a.action] ?? null;
}

// Where the line points and what it calls the listing.
export type HubPlace = {
  listing: { address: string; nda: boolean } | null;
  clientEmail: string | null; // the listing's client, or the client row's email
  link: string;
};

async function placeFor(a: HubActivityRow): Promise<HubPlace> {
  const d = db();
  const m = a.meta ?? {};
  let listingId = a.listingId ?? null;
  if (!listingId && a.shootId) {
    const s = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, a.shootId), columns: { listingId: true } });
    listingId = s?.listingId ?? null;
  }
  const l = listingId
    ? await d.query.listings.findFirst({ where: eq(schema.listings.id, listingId), columns: { id: true, address: true, nda: true }, with: { client: { columns: { email: true } } } })
    : null;
  const c = !l && a.clientId ? await d.query.clients.findFirst({ where: eq(schema.clients.id, a.clientId), columns: { email: true } }) : null;
  const bookingId = typeof m.bookingId === "string" ? m.bookingId : null;
  const slug = typeof m.slug === "string" ? m.slug : null;
  const link = bookingId
    ? adminLink(`/admin/bookings/${bookingId}`, "Open the booking")
    : a.shootId && a.action.startsWith("shoot.")
      ? adminLink(`/admin/shoots/${a.shootId}`, "Open the shoot")
      : l
        ? adminLink(`/admin/listings/${l.id}`, "Open the listing")
        : a.action.startsWith("team.") && slug && a.action !== "team.deleted"
          ? adminLink(`/admin/teams/${slug}`, "Open the team")
          : a.clientId && a.action !== "client.deleted"
            ? adminLink(`/admin/clients/${a.clientId}`, "Open the client")
            : a.action.startsWith("admin.")
              ? adminLink("/admin/settings", "Open settings")
              : adminLink("/admin", "Open admin");
  return { listing: l ? { address: l.address, nda: Boolean(l.nda) } : null, clientEmail: l?.client?.email ?? c?.email ?? null, link };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const files = (n: number | null, word = "file") => `${n ?? 1} ${word}${n === 1 || n == null ? "" : "s"}`;

// "14 photos and 3 films": the Dropbox lines, here and in the activity feed.
export function dropboxCounts(photos: number, video: number): string {
  const parts: string[] = [];
  if (photos) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  if (video) parts.push(`${video} film${video === 1 ? "" : "s"}`);
  return parts.join(" and ") || "no files";
}

// The line itself, without the link. Pure (no database), so it can be checked
// on its own. null = nothing to post.
export function hubActivityText(a: HubActivityRow, place: Omit<HubPlace, "link">): string | null {
  const m = a.meta ?? {};
  const who = a.actorEmail || `${brand.name}`;
  const nda = Boolean(place.listing?.nda);
  const name = place.listing ? hubListingName(place.listing) : "a listing";
  const client = place.clientEmail;
  switch (a.action) {
    case "listing.delivery_email": {
      const cc = Array.isArray(m.cc) ? m.cc.map(String).filter(Boolean) : [];
      return `Delivery email sent: ${name}, to ${str(m.to) ?? client ?? "the client"}${cc.length ? ` (cc ${cc.join(", ")})` : ""}. Sent by ${who}.`;
    }
    case "listing.created":
      return `New listing: ${name}${client ? ` for ${client}` : ""}. Created by ${who}.`;
    case "listing.updated": {
      const changed = Array.isArray(m.changed) ? m.changed.map(String).filter(Boolean) : [];
      return `Listing edited: ${name}${changed.length ? ` (${changed.join(", ")})` : ""}. By ${who}.`;
    }
    case "listing.deleted": {
      const gone = m.nda ? "an NDA listing" : (str(m.address) ?? "a listing").split(",")[0].trim();
      const n = num(m.files);
      return `Listing deleted: ${gone}${n ? `, ${files(n)} removed` : ""}. By ${who}.`;
    }
    case "listing.cover":
      return `Cover photo changed: ${name}. By ${who}.`;
    case "listing.locked":
      return m.reason === "refund" ? `Downloads locked again after a refund: ${name}.` : `Downloads locked: ${name}. By ${who}.`;
    case "listing.unlocked":
      return m.via === "payment" ? `Downloads unlocked: ${name}, paid${str(m.provider) ? ` through ${str(m.provider)}` : ""}.` : `Downloads unlocked: ${name}. By ${who}.`;
    case "client.created":
      return `New client: ${str(m.email) ?? client ?? "a client"}. Added by ${who}.`;
    case "client.updated": {
      const changed = Array.isArray(m.changed) ? m.changed.map(String).filter(Boolean) : [];
      return `Client edited: ${str(m.to) ?? client ?? "a client"}${changed.length ? ` (${changed.join(", ")})` : ""}. By ${who}.`;
    }
    case "client.deleted":
      return `Client deleted: ${str(m.email) ?? "a client"}. By ${who}.`;
    case "client.signin_link_sent":
      return `Sign-in link sent to ${str(m.to) ?? client ?? "the client"}. By ${who}.`;
    case "client.downloaded":
      return `Downloaded: ${name}, ${str(m.what) ?? "a zip"}. By ${str(m.email) ?? "the client"}.`;
    case "client.dropbox":
      return `Added to Dropbox: ${name}, ${files(num(m.count))}. By ${str(m.email) ?? "the client"}.`;
    case "team.created":
      return `New team: ${str(m.slug) ?? "a team"}${num(m.members) ? ` with ${files(num(m.members), "member")}` : ""}. Created by ${who}.`;
    case "team.updated":
      return `Team edited: ${str(m.slug) ?? "a team"}${str(m.from) ? ` (was ${str(m.from)})` : ""}. By ${who}.`;
    case "team.deleted":
      return `Team removed: ${str(m.slug) ?? "a team"}. By ${who}.`;
    case "team.member_added":
      return `${str(m.email) ?? "A client"} joined the team ${str(m.slug) ?? ""}. Added by ${who}.`;
    case "team.member_removed":
      return `${str(m.email) ?? "A client"} left the team ${str(m.slug) ?? ""}. Removed by ${who}.`;
    case "media.uploaded": {
      const section = !nda && str(m.section) ? ` to ${str(m.section)}` : "";
      const hidden = m.published === false ? ", hidden from the client" : "";
      return `Files uploaded: ${name}, ${files(num(m.count))}${section}${hidden}. By ${who}.`;
    }
    case "media.upload_finished": {
      const landed = num(m.landed) ?? 0;
      const failed = num(m.failed) ?? 0;
      const total = num(m.total) ?? landed + failed;
      const parts = [num(m.added) ? `${num(m.added)} new` : null, num(m.replaced) ? `${num(m.replaced)} replaced` : null, num(m.corrected) ? `${num(m.corrected)} corrected frame${num(m.corrected) === 1 ? "" : "s"}` : null].filter(Boolean);
      const detail = parts.length > 1 || (parts.length === 1 && !num(m.added)) ? ` (${parts.join(", ")})` : "";
      const section = !nda && str(m.section) ? ` to ${str(m.section)}` : "";
      const how = m.published === true ? ", client visible" : m.published === false ? ", internal only" : "";
      const names = !nda && Array.isArray(m.failedNames) && m.failedNames.length ? `: ${m.failedNames.map(String).join(", ")}${failed > m.failedNames.length ? ` and ${failed - m.failedNames.length} more` : ""}` : "";
      if (m.stopped) return `Upload stopped before it finished: ${name}, ${files(landed)} went in${detail}. Upload the rest again. By ${who}.`;
      if (!landed) return `Upload failed: ${name}, none of ${files(total)} went in${str(m.firstError) && !nda ? ` (${str(m.firstError)})` : ""}. By ${who}.`;
      if (failed) return `Upload finished with problems: ${name}, ${landed} of ${files(total)} went in${section}${how}; ${failed} failed${names}. By ${who}.`;
      return `Upload finished: ${name}, ${files(landed)}${detail}${section}${how}. By ${who}.`;
    }
    case "media.finals_uploaded": {
      const parts = [num(m.replaced) ? `${num(m.replaced)} replaced` : null, num(m.added) ? `${num(m.added)} new` : null].filter(Boolean);
      if (!parts.length) return null;
      return `Corrected finals uploaded: ${name}, ${parts.join(" and ")}. By ${who}. They reach the client when the shoot is published again.`;
    }
    case "media.repaired": {
      const probs = Array.isArray(m.problems) ? m.problems.length : 0;
      return `Frames repaired: ${name}, ${files(num(m.groups), "frame")} that had overwritten each other${probs ? `; ${probs} still need a hand upload` : ""}. By ${who}.`;
    }
    case "media.deleted":
      return `Files removed: ${name}, ${files(num(m.count))}. By ${who}.`;
    case "media.hidden":
      return `Hidden from the client: ${name}, ${files(num(m.count))}. By ${who}.`;
    case "media.shown":
      return `Shown to the client: ${name}, ${files(num(m.count))}. By ${who}.`;
    case "media.downloaded":
      return `${who} downloaded ${files(num(m.count), "frame")} of ${name} for editing.`;
    case "revision.status": {
      const s = str(m.status) ?? "updated";
      return `Revision marked ${s === "in_progress" ? "in progress" : s}: ${name}${client ? ` (${client})` : ""}. By ${who}.`;
    }
    case "admin.added":
      return `${roleWordCap(m.role)} access given to ${str(m.email) ?? "someone"}. By ${who}.`;
    case "admin.role_set":
      return `${str(m.email) ?? "Someone"} is now ${m.role === "qa" ? "on photo QC" : roleAs(m.role)}${m.from ? ` (was ${roleWord(m.from)})` : ""}. By ${who}.`;
    case "media.visibility": {
      if (m.to === "internal") return `Moved to internal only: ${name}, ${files(num(m.count))}. By ${who}.`;
      const waiting = num(m.waiting) ?? 0;
      const hidden = num(m.hidden) ?? 0;
      return `Made client visible: ${name}, ${files(num(m.count))}${waiting ? ` (${waiting} go live when the shoot is published)` : ""}${hidden ? `; the other ${files(hidden, "frame")} moved to internal only` : ""}. By ${who}.`;
    }
    case "admin.removed":
      return `Admin access removed from ${str(m.email) ?? "someone"}. By ${who}.`;
    case "shoot.retried":
      return `Shoot retried: ${name}${str(m.to) ? ` (from ${str(m.to)})` : ""}. By ${who}.`;
    case "booking.shooter_assigned":
      return str(m.email) ? `Shooter assigned: ${name}, ${str(m.email)}. Set by ${who}.` : `Shooter cleared: ${name}. By ${who}.`;
    case "booking.status_set": {
      const to = bookingStatusLabel(str(m.to) ?? "");
      const from = str(m.from) ? bookingStatusLabel(str(m.from)!) : null;
      return `Booking set to ${to}: ${name}${from ? ` (was ${from})` : ""}. By ${who}.`;
    }
    case "booking.rescheduled":
      return `Rescheduled: ${name}, ${str(m.when) ?? "a new date"}. Moved from the listing page by ${who}.`;
    case "booking.client_rescheduled":
      return `Client rescheduled: ${name}${str(m.from) ? `, from ${str(m.from)}` : ""} to ${str(m.when) ?? "a new time"}. By ${str(m.email) ?? who}. Confirm the new time in the admin.`;
    case "email.booking_sent":
      return `Booking email sent: ${name}, to ${str(m.to) ?? client ?? "the client"}${m.updated ? " (updated)" : ""}.`;
    case "email.shooter_invite_sent":
      return m.method === "CANCEL" ? `Calendar cancel sent: ${name}, to ${str(m.to) ?? "the shooter"}.` : `Calendar invite sent: ${name}, to ${str(m.to) ?? "the shooter"}.`;
    case "booking.edited": {
      // "Booking edited: 1420 Alder Drive (services, access notes). By the owner."
      const changed = str(m.changed);
      return `Booking edited: ${name}${changed ? ` (${changed})` : ""}. By ${who}.`;
    }
    case "email.time_confirmed_sent":
      return `${m.variant === "reconfirmed" ? "New time confirmation" : m.variant === "moved" ? "Shoot moved email" : "Time confirmation"} sent: ${name}, to ${str(m.to) ?? client ?? "the client"}.`;
    case "email.rescheduled_sent":
      return `Reschedule email sent: ${name}, to ${str(m.to) ?? client ?? "the client"}.`;
    // The Dropbox raw mirror (Oct 21 2026). Money-free by nature; an NDA
    // listing stays "an NDA listing" and no folder path is shown for it.
    case "shoot.dropbox_synced":
      return `Raw files copied to Dropbox: ${name}, ${dropboxCounts(num(m.photos) ?? 0, num(m.video) ?? 0)}.`;
    case "shoot.dropbox_requeued":
      return `Copying ${files(num(m.count))} to Dropbox again: ${name}. By ${who}.`;
    case "shoot.r2_raws_removed":
      return `Raws removed from R2 after the Dropbox check: ${name}, ${files(num(m.files))}${num(m.bytes) ? ` (${(num(m.bytes)! / 1e9).toFixed(1)} GB)` : ""}. Dropbox keeps them.`;
    case "shoot.r2_raw_kept":
      return `Raw kept in R2: ${name}, ${str(m.file) ?? "a file"}. ${str(m.reason) ?? "The Dropbox check failed."} Nothing was deleted.`;
    case "dropbox.connected":
      return `Dropbox connected${str(m.name) ? `: ${str(m.name)}` : ""}${str(m.email) ? ` (${str(m.email)})` : ""}. Raw uploads now copy to ${str(m.root) ?? "/Listings"}. By ${who}.`;
    case "shoot.twilight_made":
      return `Twilight made: ${name}, ${str(m.from) ?? "a frame"} → ${str(m.file) ?? "the Twilight section"}. Internal until approved.`;
    case "twilight.preset_saved":
      return `Virtual twilight preset set: ${str(m.name) ?? "a preset"}${num(m.credits) != null ? ` (${num(m.credits)} credits a photo)` : ""}. Every twilight runs it from now on. By ${who}.`;
    case "dropbox.disconnected":
      return `Dropbox disconnected. Raw uploads wait until it is connected again. By ${who}.`;
    default:
      return null;
  }
}

// The activity lines that are flagged (red exclamation mark, whole line bold;
// Oct 22 2026): client-facing moments and anything someone must act on
// or know about. Uploads, downloads, covers, edits and the rest stay plain.
export const FLAGGED_ACTIONS: ReadonlySet<ActivityAction> = new Set<ActivityAction>([
  "listing.delivery_email",
  "listing.deleted",
  "client.deleted",
  "admin.added",
  "admin.removed",
  "admin.role_set",
  "media.repaired",
  "booking.client_rescheduled",
  "dropbox.disconnected",
]);

// Finished text: test-site prefix, the link, every dollar amount scrubbed,
// and the flag on the lines that matter.
export function hubActivityLine(a: HubActivityRow, place: HubPlace, env = currentEnv()): string | null {
  const text = hubActivityText(a, place);
  if (!text) return null;
  const line = scrubMoney(`${env === "production" ? "" : "Test site: "}${text} ${place.link}`);
  // An upload that failed or stopped partway is flagged; a clean one stays plain.
  const uploadTrouble = a.action === "media.upload_finished" && (Boolean(a.meta?.stopped) || Number(a.meta?.failed ?? 0) > 0);
  return FLAGGED_ACTIONS.has(a.action) || uploadTrouble ? flagged(line) : line;
}

async function post(a: HubActivityRow, channel: Channel): Promise<void> {
  const line = hubActivityLine(a, await placeFor(a));
  if (!line) return;
  if (channel === "bookings") await postBookingLine(line);
  else await postToHub({ text: line });
}

// Called by logActivity for every row it writes. Never throws.
export async function hubActivity(a: HubActivityRow): Promise<void> {
  const channel = hubChannelFor(a);
  if (!channel) return;
  const run = () => post(a, channel).catch((e) => console.error("[hub] activity post failed:", a.action, e));
  try {
    after(run);
  } catch {
    // Outside a request (a script): post now.
    await run();
  }
}
