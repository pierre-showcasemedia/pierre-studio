// Slack posts. Three incoming webhooks, each optional:
//   hub       SLACK_WEBHOOK_URL           the team channel (shooters read it): shoots,
//                                         QC, publishing, revisions, job alerts; never
//                                         a dollar amount, never a phone number
//   bookings  SLACK_BOOKINGS_WEBHOOK_URL  #bookings: one card per booking and the
//                                         booking lifecycle lines (time confirmed,
//                                         rescheduled, canceled, pay at close declined);
//                                         never a dollar amount; the client's phone IS
//                                         on the card (the team needs it)
//   payments  SLACK_PAYMENTS_WEBHOOK_URL  private #payments: the one place an
//                                         amount may appear
//   photo editing  SLACK_PHOTO_EDITING_WEBHOOK_URL  #photo-editing: a copy of every
//                                         PHOTO revision request, tagging Dellon
//   video editing  SLACK_VIDEO_EDITING_WEBHOOK_URL  #video-editing: a shoot's raw
//                                         video is all in Dropbox, tagging the video editor
//   photo review   SLACK_PHOTO_REVIEW_WEBHOOK_URL   the PMs' final review channel
//                                         (Nov 3 2026): Send for final review, tagging
//                                         the final review list; unset = the hub
// The hub webhook is a no-op with a console warning when unset. The bookings
// and payments webhooks are used by jobs, so unset = NotConfiguredError (the
// job waits) and a non-2xx throws (the job retries and the hub alert fires).
// The photo editing webhook is like the hub: unset = no copy, never throws.
//
// Rules: nothing from an NDA listing beyond "an NDA listing" anywhere. Callers
// pass the address; this file masks it when nda is true.
import { fmtWhen, BUSINESS_TZ } from "./booking-time";
import { siteUrl } from "./brand";
import { NotConfiguredError, currentEnv } from "./jobs-core";
import { payOtherWay } from "./pay-other";
import { qcMention } from "./slack-qc";
import type { BookingPaymentDetail, BookingPaymentMethod } from "@/db/schema";
import { TZ_ABBR } from "./business";

type Block = Record<string, unknown>;

export function hasSlack(): boolean {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

export async function postToHub(msg: { text: string; blocks?: Block[] }): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.warn("[slack] SLACK_WEBHOOK_URL is not set; skipped:", msg.text);
    return false;
  }
  return postQuietly(url, msg);
}

// One webhook post that never throws: false on a non-2xx or a network error.
async function postQuietly(url: string, msg: { text: string; blocks?: Block[] }): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.blocks ? { text: msg.text, blocks: msg.blocks } : { text: msg.text }),
    });
    if (!r.ok) console.error("[slack] webhook responded", r.status);
    return r.ok;
  } catch (e) {
    console.error("[slack] post failed:", e);
    return false;
  }
}

// The lines nobody may miss (Oct 22 2026): a red exclamation mark and
// the whole line in bold, so client-facing moments (delivery emails, revision
// requests, approvals) and anything that needs a person (a shoot to review, a
// stopped shoot, a failed or waiting job, a payment problem, a deletion, an
// access change) stand out from the routine log (uploads, downloads, covers,
// edits), which stays plain. Asterisks inside the text are dropped so they can
// never end the bold early.
export function flagged(text: string): string {
  return `:exclamation: *${text.replace(/\*/g, "").trim()}*`;
}

// What the hub may call a listing. NDA listings are never named.
export function hubListingName(l: { address: string; nda?: boolean | null }): string {
  return l.nda ? "an NDA listing" : l.address.split(",")[0].trim();
}

export function adminLink(path: string, label: string) {
  return `<${siteUrl()}${path}|${label}>`;
}

// ---- The six posts -------------------------------------------------------

export function hubShootUploaded(p: { shootId: string; listing: { address: string; nda?: boolean | null }; fileCount: number; by: string; parked: boolean; videoCount?: number; mirror?: boolean; mirrorTo?: string }) {
  const name = hubListingName(p.listing);
  const video = p.videoCount ?? 0;
  const photos = p.fileCount - video;
  // "120 photos and 3 films" once raw video can come along (Oct 21 2026).
  const what = video ? [photos ? `${photos} photo${photos === 1 ? "" : "s"}` : null, `${video} film${video === 1 ? "" : "s"}`].filter(Boolean).join(" and ") : `${p.fileCount} files`;
  const tail = !photos
    ? "Video only: nothing goes to editing."
    : p.parked
      ? "Files are safe. Editing starts once the editing account is connected."
      : "Editing has started.";
  const mirror = p.mirror ? ` The raw files are being copied to ${p.mirrorTo ?? "Dropbox"}.` : "";
  return postToHub({
    text: `New shoot uploaded for ${name}: ${what} from ${p.by}. ${tail}${mirror} ${adminLink(`/admin/shoots/${p.shootId}`, "Open the shoot")}`,
  });
}

// Tags photo QC (src/lib/slack-qc.ts) when the group is set in Settings.
// Oct 30 2026: the same line also goes to #photo-editing with Dellon
// tagged, like a PHOTO revision request, so the editor hears the moment a
// gallery is ready to QC without waiting on the hub.
export type ShootReadyLine = { shootId: string; listing: { address: string; nda?: boolean | null }; photoCount: number; twilightCount: number; qcLine?: string | null };

async function shootReadyText(p: ShootReadyLine): Promise<string> {
  const name = hubListingName(p.listing);
  const tw = p.twilightCount ? ` and ${p.twilightCount} twilight` : "";
  const qc = p.qcLine ? ` QC: ${p.qcLine}.` : "";
  return `${await qcMention("photo")}${flagged(`${name} is ready for review: ${p.photoCount} frames${tw}.${qc} ${adminLink(`/admin/shoots/${p.shootId}`, "Review and publish")}`)}`;
}

export async function hubShootReady(p: ShootReadyLine) {
  const text = await shootReadyText(p);
  const [hub] = await Promise.all([postToHub({ text }), postToPhotoEditing(text)]);
  return hub;
}

// Only the #photo-editing copy of that line, for an operator to send again
// when a shoot became ready while that copy was not yet deployed or the
// webhook was down (admin-api photoEditingReady). false = not configured or
// Slack refused it.
export async function photoEditingShootReady(p: ShootReadyLine): Promise<boolean> {
  return postToPhotoEditing(await shootReadyText(p));
}

// Corrected photos sent for the final pass (Oct 28 2026, src/lib/final-review.ts).
// Tags the final review list (the owner, a manager, the coordinator and the coordinator unless
// Settings says otherwise). A preview or local run says "Test site:" and
// pings nobody, since previews post to the same channel.
// Nov 3 2026: the line also says whether every QC flag is ticked (openFlags)
// and whether QC has seen every revised photo (revisedUnchecked).
export function finalReviewText(p: { shootId: string; listing: { address: string; nda?: boolean | null }; corrected: number; failed: number; by: string; openFlags?: number | null; revisedUnchecked?: number | null }): string {
  const name = hubListingName(p.listing);
  const what = p.corrected ? `${p.corrected} corrected photo${p.corrected === 1 ? "" : "s"} from ${p.by}` : `sent by ${p.by}`;
  const fail = p.failed ? ` ${p.failed} file${p.failed === 1 ? "" : "s"} did not upload.` : "";
  const open = p.openFlags ?? null;
  const flags = open == null ? "" : open ? ` ${open} QC flag${open === 1 ? "" : "s"} not ticked.` : " Every QC flag is ticked.";
  const unchecked = p.revisedUnchecked ? ` ${p.revisedUnchecked} revised photo${p.revisedUnchecked === 1 ? "" : "s"} not through QC again.` : "";
  return `${name} is ready for final review: ${what}.${fail}${flags}${unchecked} Final pass, then publish and send the delivery email. ${adminLink(`/admin/shoots/${p.shootId}`, "Open the shoot")}`;
}

// the coordinator (Nov 3 2026): the Send for final review message goes to the PMs'
// review channel, tagging the four. Its own incoming webhook, optional
// (SLACK_PHOTO_REVIEW_WEBHOOK_URL). Set: the line goes there and NOT to the
// hub (one tagged message, like #bookings). Unset, or Slack refuses it:
// the hub gets it, as before, so a send always reaches someone.
export function hasSlackPhotoReview(): boolean {
  return Boolean((process.env.SLACK_PHOTO_REVIEW_WEBHOOK_URL || "").trim());
}

export type FinalReviewPost = { posted: boolean; channel: "review" | "hub" | null };

export async function hubFinalReview(p: Parameters<typeof finalReviewText>[0]): Promise<FinalReviewPost> {
  const line = finalReviewText(p);
  const text = currentEnv() === "production" ? `${await qcMention("final")}${flagged(line)}` : `Test site: ${line}`;
  const reviewUrl = (process.env.SLACK_PHOTO_REVIEW_WEBHOOK_URL || "").trim();
  if (reviewUrl && (await postQuietly(reviewUrl, { text }))) return { posted: true, channel: "review" };
  if (reviewUrl) console.error("[slack] the photo review webhook refused the final review line; posting it to the hub");
  const hub = await postToHub({ text });
  return { posted: hub, channel: hub ? "hub" : null };
}

// v1.2: the automatic QC pass finished (posted with the ready-for-review note
// when QC runs inside the pipeline; on its own after "Run QC again").
export function hubQcDone(p: { shootId: string; listing: { address: string; nda?: boolean | null }; line: string }) {
  const name = hubListingName(p.listing);
  return postToHub({
    text: `QC done for ${name}: ${p.line}. ${adminLink(`/admin/shoots/${p.shootId}`, "Review")}`,
  });
}

export function hubShootFailed(p: { shootId: string; listing: { address: string; nda?: boolean | null }; step: string; error: string }) {
  const name = hubListingName(p.listing);
  return postToHub({
    text: flagged(`A shoot for ${name} stopped at "${p.step}": ${p.error.slice(0, 200)}. ${adminLink(`/admin/shoots/${p.shootId}`, "Open the shoot to retry")}`),
  });
}

export function hubGalleryPublished(p: { listingId: string; listing: { address: string; nda?: boolean | null }; photoCount: number; by: string; update?: boolean }) {
  const name = hubListingName(p.listing);
  if (p.update) {
    return postToHub({
      text: `${name} gallery updated: ${p.photoCount} corrected frame${p.photoCount === 1 ? "" : "s"} published by ${p.by}. ${adminLink(`/admin/listings/${p.listingId}`, "Open the listing")}`,
    });
  }
  return postToHub({
    text: `${name} is published: ${p.photoCount} frames approved by ${p.by}. Delivery email is next. ${adminLink(`/admin/listings/${p.listingId}/delivery-email`, "Preview the delivery email")}`,
  });
}

// Every revision is tagged PHOTO or VIDEO (Oct 26 2026) and pings that QC
// group. A video one counts timestamped notes and links its Video card.
export async function hubRevisionRequested(p: { listingId: string; listing: { address: string; nda?: boolean | null }; clientEmail: string; notes: string; fileCount: number; kind?: "photo" | "video"; videoCardId?: string | null }) {
  const name = hubListingName(p.listing);
  const video = p.kind === "video";
  const files = p.fileCount ? (video ? ` with ${p.fileCount} timestamped note${p.fileCount === 1 ? "" : "s"}` : ` on ${p.fileCount} photo${p.fileCount === 1 ? "" : "s"}`) : "";
  const notes = p.listing.nda ? "" : ` "${p.notes.slice(0, 160).replace(/\s+/g, " ")}"`;
  const link = video && p.videoCardId ? adminLink(`/admin/video/${p.videoCardId}`, "Open the Video card") : adminLink(`/admin/revisions?kind=${video ? "video" : "photo"}`, "Open revisions");
  const text = `${await qcMention(video ? "video" : "photo")}${flagged(`${video ? "VIDEO" : "PHOTO"} revision requested for ${name}${files} by ${p.clientEmail}.${notes} ${link}`)}`;
  const [hub] = await Promise.all([postToHub({ text }), video ? false : postToPhotoEditing(text)]);
  return hub;
}

// #photo-editing (Oct 29 2026). the coordinator: a duplicate of every PHOTO revision
// request post, and (Oct 30) of every gallery ready for review, with Dellon tagged. Its own incoming webhook
// (SLACK_PHOTO_EDITING_WEBHOOK_URL), optional: unset = no copy. Never throws,
// so the hub line and the request itself never depend on it. A preview or
// local run says "Test site:" and does not tag Dellon, like the final review line.
// "<@U123ABC>" from a pasted member id, or "" when there is none.
function slackTag(raw: string | undefined): string {
  const id = (raw ?? "").trim().replace(/^<@|>$/g, "");
  return /^[UW][A-Z0-9]{6,}$/.test(id) ? `<@${id}>` : "";
}
// The photo editor tagged on photo editing lines: a Slack member id (U...)
// in SLACK_PHOTO_EDITING_TAG. Unset = nobody is tagged.
export const PHOTO_EDITING_TAG = slackTag(process.env.SLACK_PHOTO_EDITING_TAG);

export function hasSlackPhotoEditing(): boolean {
  return Boolean((process.env.SLACK_PHOTO_EDITING_WEBHOOK_URL || "").trim());
}

export function photoEditingText(hubText: string): string {
  return currentEnv() === "production" ? `${PHOTO_EDITING_TAG} ${hubText}` : `Test site: ${hubText}`;
}

async function postToPhotoEditing(hubText: string): Promise<boolean> {
  const url = (process.env.SLACK_PHOTO_EDITING_WEBHOOK_URL || "").trim();
  return url ? postQuietly(url, { text: photoEditingText(hubText) }) : false;
}

// #video-editing (Nov 1 2026). the owner: "when a video is uploaded to Dropbox
// FULLY and all files are in the video folder", one line in #video-editing
// tagging the video editor (VIDEO_EDITING_TAG; same day: "each one
// should just tag the video editor for now", not the @video group) with the Video
// folder, the delivery deadline ("always 24-48 hours",
// counted from when the last clip landed) and the shoot's card on the Video
// board. The slack.video_editing job posts it, once per shoot
// (queueVideoEditingLine in src/lib/dropbox-mirror.ts). Its own webhook
// (SLACK_VIDEO_EDITING_WEBHOOK_URL), optional: unset = the job is skipped,
// so nothing waits to go out late. A preview or local run says "Test site:"
// and tags nobody. An NDA listing is "an NDA listing" with no folder link
// (the Dropbox path carries the address); the editors open it from the card.
export const VIDEO_DELIVERY_HOURS = { from: 24, to: 48 } as const;
// The video editor tagged on #video-editing lines (SLACK_VIDEO_EDITING_TAG, U...).
export const VIDEO_EDITING_TAG = slackTag(process.env.SLACK_VIDEO_EDITING_TAG);

export type VideoEditingLine = {
  cardId: string | null;
  listing: { address: string; nda?: boolean | null };
  clips: number;
  bytes: number;
  landedAt: Date;
  folderUrl: string | null;
};

export function hasSlackVideoEditing(): boolean {
  return Boolean((process.env.SLACK_VIDEO_EDITING_WEBHOOK_URL || "").trim());
}

const PT_WHEN = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Slack shows <!date^…> in each reader's own time zone; the text after the
// pipe (local) is for a client that cannot.
export function slackDate(at: Date): string {
  return `<!date^${Math.floor(at.getTime() / 1000)}^{date_short_pretty} at {time}|${PT_WHEN.format(at)} ${TZ_ABBR}>`;
}

export function videoEditingText(p: VideoEditingLine & { mention: string; production: boolean }): string {
  const name = hubListingName(p.listing);
  const due = (h: number) => slackDate(new Date(p.landedAt.getTime() + h * 3_600_000));
  const size = p.bytes >= 1e9 ? ` (${(p.bytes / 1e9).toFixed(1)} GB)` : p.bytes > 0 ? ` (${Math.max(1, Math.round(p.bytes / 1e6))} MB)` : "";
  const clips = `${p.clips} clip${p.clips === 1 ? "" : "s"}${size}`;
  const folder = p.listing.nda ? "The Dropbox folder is on the card." : p.folderUrl ? `<${p.folderUrl}|Open the Video folder>` : "The Dropbox folder is on the card.";
  const card = p.cardId ? adminLink(`/admin/video/${p.cardId}`, "Open the Video card") : adminLink("/admin/video", "Open the Video board");
  const line = `Raw video for ${name} is in Dropbox: ${clips} in the Video folder. Due in ${VIDEO_DELIVERY_HOURS.from} to ${VIDEO_DELIVERY_HOURS.to} hours, between ${due(VIDEO_DELIVERY_HOURS.from)} and ${due(VIDEO_DELIVERY_HOURS.to)}. ${folder} ${card}`;
  return p.production ? `${p.mention}${flagged(line)}` : `Test site: ${line}`;
}

// Throws when the webhook is unset or Slack refuses the post (the job retries).
export async function videoEditingShootReady(p: VideoEditingLine): Promise<boolean> {
  const url = (process.env.SLACK_VIDEO_EDITING_WEBHOOK_URL || "").trim();
  if (!url) throw new NotConfiguredError("the video editing channel (SLACK_VIDEO_EDITING_WEBHOOK_URL)");
  const production = currentEnv() === "production";
  const text = videoEditingText({ ...p, mention: production ? `${VIDEO_EDITING_TAG} ` : "", production });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error(`video editing webhook responded ${r.status}`);
  return true;
}

// A cut uploaded from the Video card (Nov 1 2026). the owner: "when they upload
// a video back up, it should also tag me, the coordinator, the coordinator, and a manager and
// tell us that it's ready for review. In the video editing channel." Tags
// the final review list (Settings; the owner, a manager, the coordinator and the coordinator unless
// it says otherwise). Posted by the upload-done route once per drop. Never
// throws: unset webhook = no line. A preview says "Test site:" and tags
// nobody. An NDA listing's file names are left off (they often hold the address).
export function videoCutReadyText(p: { cardId: string; listing: { address: string; nda?: boolean | null }; count: number; names: string[]; by: string; mention: string; production: boolean }): string {
  const names = !p.listing.nda && p.names.length ? ` (${p.names.slice(0, 3).join(", ")}${p.names.length > 3 ? `, ${p.names.length - 3} more` : ""})` : "";
  const line = `Video for ${hubListingName(p.listing)} is ready for review: ${p.count} cut${p.count === 1 ? "" : "s"} uploaded by ${p.by}${names}. ${adminLink(`/admin/video/${p.cardId}`, "Review it on the Video card")}`;
  return p.production ? `${p.mention}${flagged(line)}` : `Test site: ${line}`;
}

export async function videoEditingCutReady(p: Omit<Parameters<typeof videoCutReadyText>[0], "mention" | "production">): Promise<boolean> {
  const url = (process.env.SLACK_VIDEO_EDITING_WEBHOOK_URL || "").trim();
  if (!url) return false;
  const production = currentEnv() === "production";
  return postQuietly(url, { text: videoCutReadyText({ ...p, mention: production ? await qcMention("final") : "", production }) });
}

// The Video board (Oct 26 2026). A cut moved to In review pings video QC.
export async function hubVideoReview(p: { cardId: string; listing: { address: string; nda?: boolean | null }; by: string }) {
  return postToHub({
    text: `${await qcMention("video")}${flagged(`Video for ${hubListingName(p.listing)} is ready for review, moved by ${p.by}. ${adminLink(`/admin/video/${p.cardId}`, "Open the Video card")}`)}`,
  });
}

// Plain log lines for the rest of the board: a new card, a stage change, an assignment.
export function hubVideoLine(p: { cardId: string; listing: { address: string; nda?: boolean | null }; text: string }) {
  return postToHub({ text: `Video · ${hubListingName(p.listing)}: ${p.text} ${adminLink(`/admin/video/${p.cardId}`, "Open the card")}` });
}

export function hubGalleryApproved(p: { listingId: string; listing: { address: string; nda?: boolean | null }; clientEmail: string }) {
  const name = hubListingName(p.listing);
  return postToHub({
    text: flagged(`${p.clientEmail} approved the gallery for ${name}. The shoot is complete. ${adminLink(`/admin/listings/${p.listingId}`, "Open the listing")}`),
  });
}

// ---- Booking intake (step one) --------------------------------------------
// Slack, calendar text and anything a shooter sees never carry a dollar
// amount. Every booking post goes through moneyFree() first; a slip throws
// before anything is sent (the job retries and the alert names the text).

export const MONEY_RE = /\$\s?\d/;
const MONEY_ALL_RE = /\$\s?\d[\d,]*(?:\.\d+)?/g;

export function moneyFree(text: string): string {
  if (MONEY_RE.test(text)) throw new Error(`money in shooter-visible text: ${text.slice(0, 80)}`);
  return text;
}

// Text quoted INTO a hub line from somewhere else (a provider's error message
// such as "Amount must be at least $0.50"): every dollar amount is replaced,
// never thrown on, so a job alert can never stop the queue.
export function scrubMoney(text: string): string {
  return text.replace(MONEY_ALL_RE, "an amount");
}

export type HubBooking = {
  bookingId: string;
  listing: { address: string; nda?: boolean | null };
  clientName: string | null;
  clientEmail: string;
  servicesLabel: string | null;
  when: string | null; // "Mon Oct 20, 9:00 AM" or "date to be confirmed"
  paymentMethod: BookingPaymentMethod | null;
  paymentDetail?: BookingPaymentDetail | null; // with "other": check | ach | cash
  needsQuote: boolean;
  updated?: boolean;
};

// How a booking pays, for the hub line and the #bookings card. Never an
// amount. "Pay another way: check" (or ACH transfer, cash) is collected by
// hand: no pay link ever goes out for it.
export function bookingPayLabel(method: BookingPaymentMethod | null | undefined, detail?: BookingPaymentDetail | null): string {
  if (method === "pay_at_close") return "Pay at close";
  if (method === "card") return "Card invoice";
  if (method === "other") return `Pay another way: ${payOtherWay(detail)}`;
  return "Payment not chosen";
}
// The same in a sentence ("pay another way: ACH transfer", acronym kept).
const payLabelLower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
const quoteNote = (method: BookingPaymentMethod | null | undefined) =>
  method === "other" ? "Needs a quote before the amount goes to the client" : "Needs a quote before the pay link goes out";

export function hubBookingReceived(p: HubBooking) {
  const name = hubListingName(p.listing);
  const who = p.clientName ? `${p.clientName} (${p.clientEmail})` : p.clientEmail;
  const pay = payLabelLower(bookingPayLabel(p.paymentMethod, p.paymentDetail));
  const quote = p.needsQuote ? ` ${quoteNote(p.paymentMethod)}.` : "";
  const head = p.updated ? "Booking updated" : "New booking";
  return postToHub({
    text: moneyFree(`${head}: ${name} for ${who}. ${p.servicesLabel || "services to confirm"}. ${p.when ?? "date to be confirmed"}. ${pay}.${quote} ${adminLink(`/admin/bookings/${p.bookingId}`, "Open the booking")}`),
  });
}

// One alert per job, on its first failure (and again when it dies).
export function hubJobIssue(p: { kind: string; error: string; dead: boolean; bookingId?: string | null; listingId?: string | null; attempts: number }) {
  const where = p.bookingId ? adminLink(`/admin/bookings/${p.bookingId}`, "Open the booking") : p.listingId ? adminLink(`/admin/listings/${p.listingId}`, "Open the listing") : adminLink("/admin", "Open admin");
  const head = p.dead ? `Gave up on ${p.kind} after ${p.attempts} attempt${p.attempts === 1 ? "" : "s"}` : `${p.kind} failed (attempt ${p.attempts}, retrying)`;
  return postToHub({ text: flagged(moneyFree(`${head}: ${scrubMoney(p.error).slice(0, 200).replace(/\s+/g, " ")}. ${where}`)) });
}

// A side effect whose provider is not configured in this environment yet
// (no Stripe key, no calendar account): the job waits, the team hears once.
export function hubJobWaiting(p: { kind: string; reason: string; bookingId?: string | null }) {
  const where = p.bookingId ? adminLink(`/admin/bookings/${p.bookingId}`, "Open the booking") : adminLink("/admin", "Open admin");
  return postToHub({ text: flagged(moneyFree(`${p.kind} is waiting: ${scrubMoney(p.reason)}. It runs on its own once that is set. ${where}`)) });
}

// Step two, admin actions on /admin/bookings. Both lines are money-free: the
// shooter reads this channel, the amount lives in the payments channel. They
// travel as slack.issue jobs with channel "bookings" (postBookingLine below:
// #bookings when that webhook is set, else the hub), so a Slack hiccup
// retries on its own instead of failing the admin's action.
export function hubTextTimeConfirmed(p: { bookingId: string; listing: { address: string; nda?: boolean | null }; when: string; rescheduled: boolean; shooter: string | null; by: string }): string {
  const name = hubListingName(p.listing);
  const head = p.rescheduled ? "Rescheduled" : "Time confirmed";
  const shooter = p.shooter ? ` Shooter: ${p.shooter}.` : "";
  return moneyFree(`${head}: ${name}, ${p.when}.${shooter} Set by ${p.by}. ${adminLink(`/admin/bookings/${p.bookingId}`, "Open the booking")}`);
}

export function hubTextBookingCanceled(p: { bookingId: string; listing: { address: string; nda?: boolean | null }; when: string | null; by: string }): string {
  const name = hubListingName(p.listing);
  return moneyFree(`Booking canceled: ${name}${p.when ? ` (${p.when})` : ""}, by ${p.by}. The calendar hold is being released. ${adminLink(`/admin/bookings/${p.bookingId}`, "Open the booking")}`);
}

// Additional shoots on a booking (Oct 27 2026, src/lib/booking-visits.ts):
// "Second shoot added: 7702 Birch Lane, Return trip, Tue, Oct 28, 5:30 PM to
// 7:30 PM. Shooter: alex@example.com." and the same for a move, a
// change, a cancel. The note stays off Slack (Oct 21: no paragraphs).
// `invoiced`: the add went with "Create new invoice?" (the bookings channel
// hears that an invoice went to the client, never the amount).
export function hubTextVisit(p: { bookingId: string; listing: { address: string; nda?: boolean | null }; change: "added" | "moved" | "updated" | "canceled"; kindLabel: string; when: string; shooter: string | null; by: string; invoiced?: boolean }): string {
  const name = hubListingName(p.listing);
  const head = { added: "Second shoot added", moved: "Second shoot moved", updated: "Second shoot updated", canceled: "Second shoot canceled" }[p.change];
  const shooter = p.change === "canceled" ? "" : p.shooter ? ` Shooter: ${p.shooter}.` : " No shooter yet.";
  const invoice = p.invoiced ? " A separate card invoice goes to the client." : "";
  return moneyFree(`${head}: ${name}, ${scrubMoney(p.kindLabel)}, ${p.when}.${shooter}${invoice} By ${p.by}. ${adminLink(`/admin/bookings/${p.bookingId}`, "Open the booking")}`);
}

// Step two: pay at close was declined. The line is money-free (the amount
// goes to the payments channel); it travels as a slack.issue job's note
// (channel "bookings") so the webhook that saw the decline returns at once.
export function hubTextPayAtCloseDeclined(p: { listing: { address: string; nda?: boolean | null }; bookingId?: string | null; listingId?: string | null }): string {
  const name = hubListingName(p.listing);
  const where = p.bookingId ? adminLink(`/admin/bookings/${p.bookingId}`, "Open the booking") : p.listingId ? adminLink(`/admin/listings/${p.listingId}`, "Open the listing") : adminLink("/admin", "Open admin");
  return moneyFree(`Pay at close was declined for ${name}; switch to card from the admin. ${where}`);
}

// ---- Bookings channel (#bookings) -------------------------------------
// One card per booking (new or updated) and the booking lifecycle lines. The
// team runs the day from here, so the card carries the client's phone and
// email as tappable links, the address, the requested date and time, the
// services, the payment method, the access notes and the admin link. Never a
// dollar amount (those live in the payments channel): every card goes through
// moneyFree() before it is posted, and free text the client typed is scrubbed
// first so one stray "$5" in an access note can never stall the job. NDA
// listings keep the hub masking ("an NDA listing", no address).
//
// Used by jobs only (slack.booking, slack.issue with channel "bookings"), so
// unset = NotConfiguredError (the job waits) and a non-2xx throws (the job
// retries with backoff and the hub alert fires on the first failure).

export function hasSlackBookings(): boolean {
  return Boolean((process.env.SLACK_BOOKINGS_WEBHOOK_URL || "").trim());
}

export async function postToBookings(msg: { text: string; blocks?: Block[] }): Promise<boolean> {
  const url = (process.env.SLACK_BOOKINGS_WEBHOOK_URL || "").trim();
  if (!url) throw new NotConfiguredError("the bookings channel (SLACK_BOOKINGS_WEBHOOK_URL)");
  const body = moneyFree(JSON.stringify(msg.blocks ? { text: msg.text, blocks: msg.blocks } : { text: msg.text }));
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  if (!r.ok) throw new Error(`bookings webhook responded ${r.status}`);
  return true;
}

// A booking lifecycle line: the bookings channel when it is set (and NOT the
// hub, so a hub webhook pointed at the same channel never doubles it), else
// today's hub line. Throws only on the bookings path; the hub path keeps its
// never-throw contract.
export async function postBookingLine(text: string): Promise<boolean> {
  if (hasSlackBookings()) return postToBookings({ text: moneyFree(text) });
  return postToHub({ text: moneyFree(text) });
}

// Slack mrkdwn needs these three escaped in any text we did not write ourselves.
function mrk(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// "(555) 010-0100" as a tel: link. Ten digits (or eleven with a leading 1) are
// formatted; anything else is shown as typed.
function phoneLink(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const d = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (d.length !== 10) return mrk(raw);
  return `<tel:+1${d}|(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}>`;
}

export type BookingCard = {
  bookingId: string;
  updated: boolean;
  listing: { address: string; nda?: boolean | null };
  client: { name: string | null; email: string; phone: string | null; company: string | null };
  propertyLine: string | null; // "Vacant / Staged · For Sale"
  desiredDate: string | null; // YYYY-MM-DD
  startTime: string | null; // HH:MM
  timeConfirmed: boolean; // the booking status is confirmed or shot
  servicesLabel: string | null;
  paymentMethod: BookingPaymentMethod | null;
  paymentDetail?: BookingPaymentDetail | null; // with "other": check | ach | cash
  needsQuote: boolean;
  accessNotes: string | null;
  homeownerHome: boolean;
  listingAgreement: string | null; // Yes / No as the form sent it; null = not answered
  customRequest: string | null;
  additionalDetails?: string | null; // the form's "Additional details" (bookings.client_notes)
};

// What the card says about the date: the requested day and time with "to
// confirm" until an admin confirms it; "date to be confirmed" when none.
export function bookingWhenLine(p: { desiredDate: string | null; startTime: string | null; timeConfirmed: boolean }): string {
  const when = fmtWhen({ desiredDate: p.desiredDate, startTime: p.startTime });
  if (!when) return "date to be confirmed";
  if (p.timeConfirmed) return when;
  return p.startTime ? `${when}, to confirm` : `${when}, time to confirm`;
}

export function bookingCard(p: BookingCard): { text: string; blocks: Block[] } {
  const name = hubListingName(p.listing);
  const nda = Boolean(p.listing.nda);
  const head = p.updated ? "Booking updated" : "New booking";
  const clientName = scrubMoney(p.client.name ?? p.client.email);
  const company = p.client.company ? scrubMoney(p.client.company) : null;
  const contact = [p.client.phone ? phoneLink(p.client.phone) : "no phone given", `<mailto:${p.client.email}|${mrk(p.client.email)}>`].join("\n");
  const property = nda ? "an NDA listing" : [mrk(p.listing.address), p.propertyLine ? mrk(scrubMoney(p.propertyLine)) : null].filter(Boolean).join("\n");
  const when = bookingWhenLine(p);
  const pay = bookingPayLabel(p.paymentMethod, p.paymentDetail);
  const payment = p.needsQuote ? `${pay}\n${quoteNote(p.paymentMethod)}` : pay;
  const access = [p.accessNotes ? mrk(scrubMoney(p.accessNotes)) : "none given", p.homeownerHome ? "Homeowner will be home" : null].filter(Boolean).join("\n");
  const field = (label: string, value: string) => ({ type: "mrkdwn", text: `*${label}*\n${value}` });
  const fields = [
    field("Client", [`*${mrk(clientName)}*`, company ? mrk(company) : null].filter(Boolean).join("\n")),
    field("Contact", contact),
    field("Property", property),
    field("When", mrk(when)),
    field("Services", mrk(p.servicesLabel || "services to confirm")),
    field("Payment", payment),
    field("Listing agreement", /^yes$/i.test(p.listingAgreement ?? "") ? "Yes" : /^no$/i.test(p.listingAgreement ?? "") ? "No" : "not answered"),
    field("Access", access),
    ...(p.customRequest && !nda ? [field("Notes", mrk(scrubMoney(p.customRequest)).slice(0, 1500))] : []),
    ...(p.additionalDetails && !nda ? [field("Details", mrk(scrubMoney(p.additionalDetails)).slice(0, 1500))] : []),
  ];
  const link = adminLink(`/admin/bookings/${p.bookingId}`, "Open the booking");
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: `${head}: ${name}`.slice(0, 150), emoji: false } },
    { type: "section", fields },
    { type: "context", elements: [{ type: "mrkdwn", text: link }] },
  ];
  const who = p.client.name ? `${clientName} (${p.client.email})` : p.client.email;
  const text = moneyFree(`${head}: ${name} for ${who}. ${p.servicesLabel || "services to confirm"}. ${when}. ${payLabelLower(pay)}.${p.needsQuote ? ` ${quoteNote(p.paymentMethod)}.` : ""} ${link}`);
  return { text, blocks };
}

// ---- Payments channel (step two) -----------------------------------------
// A second, private webhook (SLACK_PAYMENTS_WEBHOOK_URL, #payments) that
// MAY carry dollar amounts: invoice issued, paid, failed, pay at close in
// review / approved / denied, refunded, voided, marked paid by hand. Posts run
// as slack.paid / slack.payment jobs, so an unset webhook makes the job wait
// (NotConfiguredError) instead of losing the line. Never post client phone
// numbers here either; NDA listings stay "an NDA listing".

export function hasSlackPayments(): boolean {
  return Boolean((process.env.SLACK_PAYMENTS_WEBHOOK_URL || "").trim());
}

export async function postToPayments(text: string): Promise<boolean> {
  const url = (process.env.SLACK_PAYMENTS_WEBHOOK_URL || "").trim();
  if (!url) throw new NotConfiguredError("the payments channel (SLACK_PAYMENTS_WEBHOOK_URL)");
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`payments webhook responded ${r.status}`);
  return true;
}

export type PayLine = {
  listing: { address: string; nda?: boolean | null };
  listingId?: string | null;
  bookingId?: string | null;
  client: string | null; // "Jane Agent (jane@example.com)"
  amount: string | null; // "$2,400"
  method: string | null; // card | bank transfer | pay at close
  provider?: string | null; // stripe | titus
  // Not the booking's own invoice: "second shoot invoice" | "added items invoice".
  what?: string | null;
  // false = paying it moves no gallery (add-on, second shoot, exclusivity).
  unlocks?: boolean;
};

function payWhere(p: PayLine): string {
  return p.bookingId ? adminLink(`/admin/bookings/${p.bookingId}`, "Open the booking") : p.listingId ? adminLink(`/admin/listings/${p.listingId}`, "Open the listing") : adminLink("/admin", "Open admin");
}

function payHead(p: PayLine): string {
  const amt = p.amount ? ` ${p.amount}` : "";
  const who = p.client ? ` for ${p.client}` : "";
  return `${p.what ? `${p.what[0].toUpperCase()}${p.what.slice(1)}, ` : ""}${hubListingName(p.listing)}${who}${amt}`;
}

// The finished lines. Each is a plain string, so a webhook handler can hand it
// to a slack.payment job and return at once.
export const paymentsText = {
  issued: (p: PayLine & { link?: string | null }) =>
    `Invoice sent: ${payHead(p)}${p.method ? `, ${p.method}` : ""}${p.provider ? ` via ${p.provider}` : ""}.${p.link ? ` <${p.link}|Provider link>` : ""} ${payWhere(p)}`,
  // unlocks false = an exclusivity_monthly invoice: paid, but no gallery moved.
  paid: (p: PayLine & { unlocks?: boolean }) => `Paid: ${payHead(p)}${p.method ? ` by ${p.method}` : ""}${p.provider ? ` via ${p.provider}` : ""}.${p.unlocks === false ? "" : " Downloads are unlocked."} ${payWhere(p)}`,
  paidManual: (p: PayLine & { by: string; note?: string | null; unlocks?: boolean }) =>
    `Marked paid by ${p.by}: ${payHead(p)}${p.note ? ` (${p.note.slice(0, 160)})` : ""}.${p.unlocks === false ? "" : " Downloads are unlocked."} ${payWhere(p)}`,
  failed: (p: PayLine & { reason?: string | null }) => `Payment failed: ${payHead(p)}${p.reason ? `: ${p.reason.slice(0, 160)}` : ""}. The invoice stays open. ${payWhere(p)}`,
  review: (p: PayLine) => `Pay at close in review: ${payHead(p)}. Downloads open when it clears. ${payWhere(p)}`,
  approved: (p: PayLine) => `Pay at close approved: ${payHead(p)}. Waiting for the funding event to unlock. ${payWhere(p)}`,
  denied: (p: PayLine) => `Pay at close declined: ${payHead(p)}. Switch the booking to card from the admin. ${payWhere(p)}`,
  refunded: (p: PayLine & { refunded: string; full: boolean }) =>
    `${p.full ? "Refunded in full" : "Partial refund"}: ${payHead(p)}, ${p.refunded} back${p.provider ? ` via ${p.provider}` : ""}.${p.full && p.unlocks !== false ? " Downloads are locked again." : ""} ${payWhere(p)}`,
  voided: (p: PayLine) => `Invoice voided: ${payHead(p)}${p.provider ? ` (${p.provider})` : ""}. ${payWhere(p)}`,
  uncollectible: (p: PayLine) => `Invoice marked uncollectible: ${payHead(p)} (stripe). The hosted invoice still takes a payment, so it stays payable here. ${payWhere(p)}`,
  canceled: (p: PayLine) => `Pay at close checkout canceled for ${hubListingName(p.listing)}; a fresh one opens on the next attempt. ${payWhere(p)}`,
  // Admin actions (step two): the quote is in, the booking moved to card, the booking is off.
  amountSet: (p: PayLine & { by: string }) => `Amount set by ${p.by}: ${payHead(p)}${p.provider ? `, ${p.provider}` : ""}. The invoice is being issued and the pay link goes out next. ${payWhere(p)}`,
  // Pay another way (check, ACH transfer or cash): no provider, no pay link.
  amountSetOther: (p: PayLine & { by: string }) => `Amount set by ${p.by}: ${payHead(p)}, to be paid ${p.method ? `by ${p.method}` : "another way"}. No pay link goes out; mark it paid when the payment arrives. ${payWhere(p)}`,
  switchedToCard: (p: PayLine & { by: string; fromOther?: boolean }) =>
    p.fromOther
      ? `Switched to card by ${p.by}: ${payHead(p)}. It was going to be paid another way; a Stripe invoice is on its way. ${payWhere(p)}`
      : `Switched to card by ${p.by}: ${payHead(p)}. The pay at close checkout is closed and a Stripe invoice is on its way. ${payWhere(p)}`,
  bookingCanceled: (p: PayLine & { by: string; closed: string | null }) =>
    `Booking canceled by ${p.by}: ${payHead(p)}.${p.closed ? ` The open ${p.closed} was closed.` : ""} ${payWhere(p)}`,
  // Edit booking (Oct 21 2026): the invoice follows the services and add-ons.
  editedReissued: (p: PayLine & { by: string; closed: string | null; previous: string | null }) =>
    `Invoice reissued after a booking edit by ${p.by}: ${payHead(p)}${p.previous ? ` (was ${p.previous})` : ""}${p.provider ? `, ${p.provider}` : ""}.${p.closed ? ` The previous ${p.closed} was closed.` : ""} The new one is being issued and the updated booking email goes out next. ${payWhere(p)}`,
  editedAmount: (p: PayLine & { by: string; previous: string | null }) =>
    `Amount updated after a booking edit by ${p.by}: ${payHead(p)}${p.previous ? ` (was ${p.previous})` : ""}, to be paid ${p.method ? `by ${p.method}` : "another way"}. No pay link goes out; the client gets the updated booking email. ${payWhere(p)}`,
  editedToQuote: (p: PayLine & { by: string; closed: string | null }) =>
    `Invoice needs a quote after a booking edit by ${p.by}: ${payHead(p)}.${p.closed ? ` The previous ${p.closed} was closed.` : ""} Set the amount from the admin to issue it. ${payWhere(p)}`,
  addonInvoice: (p: PayLine & { by: string; items: string; paidAmount: string | null; needsQuote: boolean }) =>
    `Added items invoiced by ${p.by}: ${payHead(p)} for ${p.items}.${p.paidAmount ? ` The paid ${p.paidAmount} invoice stands.` : ""} ${p.needsQuote ? "It waits for an amount (Set amount from the admin)." : "The new invoice is being issued and the pay link goes out next."} ${payWhere(p)}`,
  // Additional shoots (Oct 27 2026): "Create new invoice?" on a second shoot.
  visitInvoice: (p: PayLine & { by: string; kindLabel: string; items: string; mainStatus: string | null }) =>
    `Second shoot invoiced by ${p.by}: ${payHead({ ...p, what: null })} for the ${p.kindLabel.toLowerCase()} (${p.items}), card via stripe. The booking's own invoice${p.mainStatus ? ` (${p.mainStatus.replace(/_/g, " ")})` : ""} is untouched and downloads do not depend on this one. The Stripe invoice is being issued and the pay link goes out next. ${payWhere(p)}`,
  visitInvoiceVoided: (p: PayLine & { by: string; kindLabel: string; closed: string | null }) =>
    `Second shoot canceled by ${p.by}, so its invoice was voided: ${payHead({ ...p, what: null })}.${p.closed ? ` The open ${p.closed} was closed.` : ""} ${payWhere(p)}`,
  refundByHand: (p: PayLine & { by: string; items: string }) =>
    `Refund the difference by hand: ${payHead(p)} for ${p.items}, removed by ${p.by}. The paid invoice is untouched; nothing was refunded. ${payWhere(p)}`,
};
