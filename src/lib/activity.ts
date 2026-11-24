// Activity log writes. Never throws and never blocks the caller's work:
// a failed log line is a console error, not a failed action. Most rows also
// post one line to the team's Slack hub after the response (hub-activity.ts
// lists which).
import { db, hasDb, schema } from "@/db";
import { dropboxCounts, hubActivity } from "./hub-activity";
import { payOtherWay } from "./pay-other";
import { fmtLa } from "./booking-time";
import { roleAs, roleWord } from "./role-words";

export type ActivityAction =
  | "shoot.created"
  | "shoot.submitted"
  | "shoot.discarded"
  | "shoot.transferring"
  | "shoot.committed"
  | "shoot.processing"
  | "shoot.importing"
  | "shoot.twilight"
  | "shoot.qc"
  | "shoot.qc_done"
  | "shoot.qc_rerun"
  | "shoot.run_now"
  | "shoot.ready"
  | "shoot.failed"
  | "shoot.retried"
  | "shoot.published"
  | "shoot.republished"
  | "media.qc"
  // Nov 2 2026: a Photo QC tick on one automatic QC flag (src/lib/qc-fixes.ts)
  | "media.qc_fix"
  | "media.replaced"
  | "media.added"
  | "media.downloaded"
  | "listing.locked"
  | "listing.unlocked"
  | "listing.cover"
  | "listing.created"
  | "listing.updated"
  | "listing.delivery_email"
  | "dropbox.video_link"
  | "listing.migrated"
  | "listing.deleted"
  // Oct 30 2026: one listing merged into another (src/lib/merge-listing.ts)
  | "listing.merged"
  // Nov 5 2026: one shoot merged into another of the same listing (src/lib/merge-shoot.ts).
  // Written inside the merge's own batch, never through logActivity, so the hub never posts it.
  | "shoot.merged"
  | "client.created"
  | "client.deleted"
  | "client.signin_link_sent"
  | "team.created"
  | "team.updated"
  | "team.deleted"
  | "team.member_added"
  | "team.member_removed"
  | "media.updated"
  | "media.hidden"
  | "media.shown"
  | "media.deleted"
  | "media.reordered"
  | "media.uploaded"
  | "media.finals_uploaded"
  | "media.repaired"
  | "bundles.rebuilt"
  | "admin.added"
  | "admin.removed"
  // Oct 2026: the QA team and client visibility
  | "admin.role_set"
  | "media.visibility"
  | "client.updated"
  | "client.approved"
  | "client.revision_requested"
  | "client.downloaded"
  | "client.dropbox"
  | "revision.status"
  | "admin.view_as"
  // Step one: booking intake (docs/booking-to-payment.md)
  | "booking.created"
  | "booking.revised"
  | "booking.duplicate"
  | "invoice.created"
  | "invoice.issued"
  | "invoice.needs_quote"
  | "invoice.revised_after_issue"
  | "email.booking_sent"
  | "job.failed"
  | "job.dead"
  // Step two: payments (docs/booking-to-payment.md sections 5 to 10)
  | "invoice.paid"
  | "invoice.paid_manual"
  | "invoice.payment_failed"
  | "invoice.voided"
  | "invoice.uncollectible"
  | "invoice.refunded"
  | "invoice.partially_refunded"
  | "invoice.processing"
  | "invoice.canceled"
  | "invoice.loan_review"
  | "invoice.loan_approved"
  | "invoice.loan_denied"
  | "payment.webhook_rejected"
  | "payment.duplicate_funding"
  | "payment.titus_after_switch"
  | "email.pay_link_sent"
  // Step two: admin actions on /admin/bookings (the actor is always an admin)
  | "booking.time_confirmed"
  | "booking.rescheduled"
  | "booking.shooter_assigned"
  | "booking.canceled"
  | "booking.status_set"
  | "booking.note_saved"
  | "booking.client_rescheduled"
  | "booking.calendar_moved"
  | "booking.calendar_shooter"
  | "calendar.event_merged"
  | "email.shooter_invite_sent"
  | "email.shoot_brief_sent"
  | "invoice.amount_set"
  | "invoice.switched_to_card"
  | "email.pay_link_requested"
  | "job.run_now"
  // Oct 21 2026: Edit booking and the client's time emails
  | "booking.edited"
  | "invoice.addon_created"
  | "invoice.refund_by_hand"
  | "email.time_confirmed_sent"
  | "email.rescheduled_sent"
  | "email.reminder_sent"
  // Oct 21 2026: the Dropbox raw mirror (src/lib/dropbox-mirror.ts)
  | "dropbox.connected"
  // Nov 18 2026: the Google Drive mirror (src/lib/drive-mirror.ts)
  | "drive.connected"
  | "drive.disconnected"
  | "shoot.drive_synced"
  | "shoot.drive_requeued"
  | "client.drive"
  | "dropbox.disconnected"
  // Oct 27 2026: the Champagne preset every virtual twilight runs (src/lib/twilight-preset.ts)
  | "twilight.preset_saved"
  | "shoot.twilight_made"
  | "shoot.dropbox_synced"
  | "shoot.dropbox_requeued"
  // Oct 27 2026: raws leave R2 once Dropbox's copy is verified (src/lib/r2-raw-cleanup.ts)
  | "shoot.r2_raws_removed"
  | "shoot.r2_raw_kept"
  | "shoot.r2_raw_kept_again"
  // Oct 26 2026: the Video board (src/lib/video-board.ts) and the PHOTO / VIDEO tag
  | "video.card_created"
  | "video.card_removed"
  | "video.stage"
  | "video.assigned"
  | "video.notes_saved"
  | "client.video_notes"
  | "revision.kind"
  // Oct 26 2026: one line per upload run (src/lib/upload-runs.ts)
  | "media.upload_finished"
  // Oct 27 2026: additional shoots on a booking (src/lib/booking-visits.ts)
  | "booking.visit_added"
  | "booking.visit_updated"
  | "booking.visit_canceled"
  | "booking.visit_done"
  | "booking.visit_calendar_moved"
  | "booking.visit_calendar_shooter"
  // Oct 27 2026: a second shoot's own invoice (src/lib/visit-invoice.ts)
  | "invoice.visit_created"
  // Oct 28 2026: corrected photos sent for the final pass (src/lib/final-review.ts)
  | "shoot.final_review"
  // Nov 6 2026: the Photo QC status bar (src/lib/photo-qc-status.ts)
  | "shoot.qc_status";

export async function logActivity(a: {
  actorEmail?: string | null;
  action: ActivityAction;
  listingId?: string | null;
  shootId?: string | null;
  clientId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  if (!hasDb()) return;
  try {
    await db().insert(schema.activity).values({
      actorEmail: a.actorEmail ?? null,
      action: a.action,
      listingId: a.listingId ?? null,
      shootId: a.shootId ?? null,
      clientId: a.clientId ?? null,
      meta: a.meta ?? null,
    });
  } catch (e) {
    console.error("[activity] write failed:", a.action, e);
  }
  await hubActivity(a);
}

// Booking status words as the admin reads them ("requested" is "Unconfirmed").
const statusWord = (s: unknown): string => {
  const v = String(s ?? "");
  return v === "requested" ? "Unconfirmed" : v ? v.charAt(0).toUpperCase() + v.slice(1) : "a status";
};

// Plain-English line for the dashboard feed.
export function describeActivity(a: { action: string; actorEmail: string | null; meta: Record<string, unknown> | null }): string {
  const who = a.actorEmail ?? "The pipeline";
  const m = a.meta ?? {};
  const n = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : null);
  switch (a.action) {
    case "shoot.created": return `${who} started an upload`;
    case "shoot.submitted": return `${who} submitted a shoot (${n("fileCount") ?? "?"} files)`;
    case "shoot.discarded": return m.partial ? `${who} removed ${n("fileCount") ?? "?"} files from an unfinished upload` : `${who} discarded an unfinished upload (${n("fileCount") ?? "?"} files)`;
    case "shoot.transferring": return "Files are moving to editing";
    case "shoot.committed": return "Editing started";
    case "shoot.processing": return `Editing in progress${n("imageCount") != null ? ` (${n("imageCount")} frames so far)` : ""}`;
    case "shoot.importing": return `Pulling finished frames${n("imported") != null ? ` (${n("imported")} so far)` : ""}`;
    case "shoot.twilight": return `Virtual twilight${n("count") != null ? ` on ${n("count")} frames` : ""}`;
    case "shoot.qc": return `Automatic QC${n("done") != null && n("total") != null ? ` (${n("done")} of ${n("total")} frames)` : " started"}`;
    case "shoot.qc_done": return `Automatic QC finished${m.line ? `: ${String(m.line)}` : ""}`;
    case "shoot.qc_rerun": return `${who} ran QC again`;
    case "shoot.run_now": return `${who} pushed the pipeline forward${m.to ? ` (${String(m.from ?? "")} to ${String(m.to)})` : ""}`;
    case "shoot.ready": return `Shoot ready for review (${n("photoCount") ?? "?"} frames)`;
    case "shoot.failed": return `Shoot stopped: ${String(m.error ?? "").slice(0, 80)}`;
    case "shoot.retried": return `${who} retried the shoot`;
    case "shoot.published": return `${who} published ${n("approved") ?? "?"} frames to the gallery`;
    case "shoot.republished": return `${who} published ${n("newly") ?? "?"} corrected frame${n("newly") === 1 ? "" : "s"} to the gallery`;
    case "media.replaced": return `${who} replaced ${String(m.filename ?? "a frame")} with a corrected final`;
    case "media.added": return `${who} added ${n("count") ?? 1} corrected frame${n("count") === 1 ? "" : "s"}`;
    case "media.downloaded": return `${who} downloaded ${n("count") ?? 1} frame${n("count") === 1 ? "" : "s"} for editing`;
    case "media.qc_fix": return `${who} ${m.done ? "marked a QC fix done" : "reopened a QC fix"}${m.label ? ` (${String(m.label)})` : ""} on ${String(m.filename ?? "a frame")}`;
    case "media.qc": return `${who} marked ${n("count") ?? 1} frame${n("count") === 1 ? "" : "s"} ${String(m.state ?? "")}`;
    case "listing.locked": return m.reason === "refund" ? "Downloads locked again after a refund" : `${who} locked downloads`;
    case "listing.unlocked": return m.via === "payment" ? `Downloads unlocked by payment${m.provider ? ` (${String(m.provider)})` : ""}` : `${who} unlocked downloads`;
    case "listing.cover": return `${who} changed the cover photo`;
    case "listing.created": return `${who} created a listing`;
    case "listing.updated": return `${who} edited a listing`;
    case "dropbox.video_link": return "Dropbox share link made for the Video folder";
    case "listing.delivery_email": return `${who} sent the delivery email${m.to ? ` to ${String(m.to)}` : ""}`;
    case "listing.migrated": return `Moved in from the previous portal${n("files") != null ? ` (${n("files")} files)` : ""}${m.locked ? ", downloads locked" : ""}`;
    case "listing.deleted": return `${who} deleted the listing${m.address ? ` ${String(m.address).split(",")[0]}` : ""}`;
    case "listing.merged": {
      const f = (m.from ?? {}) as { address?: unknown; slug?: unknown };
      const c = (m.counts ?? {}) as Record<string, unknown>;
      const k = (key: string) => (typeof c[key] === "number" ? (c[key] as number) : 0);
      const parts = [k("bookings") ? `${k("bookings")} booking${k("bookings") === 1 ? "" : "s"}` : null, k("invoices") ? `${k("invoices")} invoice${k("invoices") === 1 ? "" : "s"}` : null, k("media") ? `${k("media")} file${k("media") === 1 ? "" : "s"}` : null].filter(Boolean);
      return `${who} merged ${f.address ? String(f.address).split(",")[0] : String(f.slug ?? "a listing")} into this listing${parts.length ? ` (${parts.join(", ")})` : ""}`;
    }
    case "shoot.merged": {
      const f = (m.from ?? {}) as { label?: unknown };
      const k = (key: string) => (typeof m[key] === "number" ? (m[key] as number) : 0);
      return `${who} merged ${typeof f.label === "string" ? f.label : "a shoot"} into this shoot (${k("kept")} client visible photo${k("kept") === 1 ? "" : "s"} kept, ${k("deleted")} internal frame${k("deleted") === 1 ? "" : "s"} deleted)`;
    }
    case "client.created": return `${who} added a client`;
    case "client.deleted": return `${who} deleted the client ${String(m.email ?? "")}`;
    case "client.signin_link_sent": return `${who} sent a sign-in link to ${String(m.to ?? "the client")}`;
    case "team.created": return `${who} created the team ${String(m.slug ?? "")}`;
    case "team.updated": return `${who} edited the team ${String(m.slug ?? "")}`;
    case "team.deleted": return `${who} removed the team ${String(m.slug ?? "")}`;
    case "team.member_added": return `${who} added ${String(m.email ?? "a client")} to the team ${String(m.slug ?? "")}`;
    case "team.member_removed": return `${who} removed ${String(m.email ?? "a client")} from the team ${String(m.slug ?? "")}`;
    case "media.updated": return `${who} edited ${String(m.filename ?? "a file")}`;
    case "media.hidden": return `${who} hid ${n("count") ?? 1} file${n("count") === 1 ? "" : "s"} from the client`;
    case "media.shown": return `${who} showed ${n("count") ?? 1} file${n("count") === 1 ? "" : "s"} to the client`;
    case "media.deleted": return `${who} removed ${n("count") ?? 1} file${n("count") === 1 ? "" : "s"} from the gallery`;
    case "media.reordered": return `${who} reordered the gallery`;
    case "media.repaired": return `${who} repaired ${n("groups") ?? 1} frame${n("groups") === 1 ? "" : "s"} that had overwritten each other`;
    case "media.finals_uploaded": return `${who} uploaded corrected finals (${n("replaced") ?? 0} replaced, ${n("added") ?? 0} new)`;
    case "media.uploaded": return `${who} uploaded ${n("count") ?? 1} file${n("count") === 1 ? "" : "s"}${m.section ? ` to ${String(m.section)}` : ""}`;
    case "bundles.rebuilt": return `Download zips rebuilt${n("full") != null ? ` (${n("full")} photos)` : ""}`;
    case "admin.added": return `${who} gave ${String(m.email ?? "someone")} ${roleWord(m.role)} access`;
    case "admin.role_set": return `${who} made ${String(m.email ?? "someone")} ${roleAs(m.role)}${m.from ? ` (was ${roleWord(m.from)})` : ""}`;
    case "media.visibility": {
      const count = n("count") ?? 1;
      const files = `${count} file${count === 1 ? "" : "s"}`;
      if (m.to === "internal") return `${who} moved ${files} to internal only`;
      const waiting = n("waiting") ?? 0;
      const hidden = n("hidden") ?? 0;
      return `${who} made ${files} client visible${waiting ? ` (${waiting} go live when the shoot is published)` : ""}${hidden ? ` and moved the other ${hidden} to internal only` : ""}`;
    }
    case "admin.removed": return `${who} removed admin access from ${String(m.email ?? "someone")}`;
    case "client.updated": return `${who} edited a client`;
    case "client.approved": return `${who} approved the gallery`;
    case "client.revision_requested": return `${who} requested a ${m.kind === "video" ? "video" : "photo"} revision`;
    case "video.card_created": return `${who} added a Video card`;
    case "video.card_removed": return `${who} removed a Video card`;
    case "video.stage": return `${who} moved the Video card to ${String(m.label ?? m.to ?? "a new stage")}`;
    case "video.assigned": return m.to ? `${who} assigned the video to ${String(m.to)}` : `${who} unassigned the video`;
    case "video.notes_saved": return `${who} saved the editing notes`;
    case "client.video_notes": return `${who} updated the client's video notes`;
    case "revision.kind": return `${who} tagged a revision ${String(m.to ?? "").toUpperCase()}`;
    case "media.upload_finished": {
      const landed = n("landed") ?? 0;
      if (m.stopped) return `${who}'s upload stopped before it finished (${landed} file${landed === 1 ? "" : "s"} went in)`;
      const failed = n("failed") ?? 0;
      return failed ? `${who} uploaded ${landed} of ${n("total") ?? landed} files (${failed} failed)` : `${who} uploaded ${landed} file${landed === 1 ? "" : "s"}`;
    }
    case "client.downloaded": return `${String(m.email ?? who)} downloaded ${String(m.what ?? "a zip")}`;
    case "client.dropbox": return `${String(m.email ?? who)} added ${n("count") ?? 1} file${n("count") === 1 ? "" : "s"} to Dropbox`;
    case "revision.status": return `${who} marked a revision request ${String(m.status ?? "").replace("_", " ")}`;
    case "admin.view_as": return `${who} viewed the portal as ${String(m.as ?? "a client")}`;
    case "booking.created": return `Booking request received${m.services ? `: ${String(m.services)}` : ""}${m.paymentMethod === "other" ? ` (pay another way: ${payOtherWay(typeof m.paymentDetail === "string" ? m.paymentDetail : null)})` : m.paymentMethod ? ` (${String(m.paymentMethod).replace("_", " ")})` : ""}`;
    case "booking.revised": return `Booking request updated by the client${m.changed ? `: ${String(m.changed)}` : ""}`;
    case "booking.duplicate": return "Duplicate booking submission ignored";
    case "invoice.created": return `Invoice created${m.provider ? ` (${String(m.provider)})` : ""}`;
    case "invoice.issued": return `Invoice issued${m.provider ? ` through ${String(m.provider)}` : ""}${m.number ? `: ${String(m.number)}` : ""}`;
    case "invoice.needs_quote": return `Invoice waiting for a quote${m.reason ? `: ${String(m.reason)}` : ""}`;
    case "invoice.revised_after_issue": return "Booking changed after the invoice was issued; review the amount";
    case "email.booking_sent": return `Booking email sent${m.to ? ` to ${String(m.to)}` : ""}${m.version && Number(m.version) > 1 ? " (updated)" : ""}`;
    case "job.failed": return `A side effect failed${m.kind ? ` (${String(m.kind)})` : ""}: ${String(m.error ?? "").slice(0, 80)}`;
    case "job.dead": return `A side effect gave up${m.kind ? ` (${String(m.kind)})` : ""}: ${String(m.error ?? "").slice(0, 80)}`;
    case "invoice.paid": return `Invoice paid${m.provider ? ` through ${String(m.provider)}` : ""}${m.method ? ` (${String(m.method).replace("_", " ")})` : ""}`;
    case "invoice.paid_manual": return `${who} marked the invoice paid${m.note ? `: ${String(m.note).slice(0, 80)}` : ""}`;
    case "invoice.payment_failed": return `A payment attempt failed${m.reason ? `: ${String(m.reason).slice(0, 80)}` : ""}`;
    case "invoice.voided": return `Invoice voided${m.provider ? ` (${String(m.provider)})` : ""}`;
    case "invoice.uncollectible": return "Invoice marked uncollectible in Stripe; it can still be paid";
    case "invoice.refunded": return "Payment refunded in full; downloads locked again";
    case "invoice.partially_refunded": return `Partial refund recorded${n("refundedCents") != null ? ` ($${((n("refundedCents") as number) / 100).toLocaleString()})` : ""}`;
    case "invoice.processing": return `Payment in progress${m.provider ? ` (${String(m.provider)})` : ""}`;
    case "invoice.canceled": return "Pay at close checkout canceled; a fresh one opens on the next attempt";
    case "invoice.loan_review": return "Pay at close application under review";
    case "invoice.loan_approved": return "Pay at close application approved";
    case "invoice.loan_denied": return "Pay at close application denied; switch to card";
    case "payment.webhook_rejected": return `A ${String(m.provider ?? "payment")} webhook was rejected${m.reason ? ` (${String(m.reason)})` : ""}`;
    case "payment.duplicate_funding": return `Titus funded a second pay at close checkout for this invoice${m.checkoutId ? ` (${String(m.checkoutId)})` : ""}; refund the duplicate in Titus`;
    case "payment.titus_after_switch": return `Titus reported ${m.what === "refunded" ? "a refund on" : "funding for"} pay at close checkout${m.checkoutId ? ` ${String(m.checkoutId)}` : ""} after this invoice was switched to card; nothing was changed here, a human reconciles`;
    case "email.pay_link_sent": return `Pay link emailed${m.to ? ` to ${String(m.to)}` : ""}`;
    // Step two admin actions. No amounts in any of these lines.
    case "booking.time_confirmed": return `${who} confirmed the shoot time${m.when ? `: ${String(m.when)}` : ""}`;
    case "booking.rescheduled": return `${who} rescheduled the shoot${m.when ? ` to ${String(m.when)}` : ""}`;
    case "booking.shooter_assigned": return m.email ? `${who} assigned ${String(m.email)} as the shooter` : `${who} cleared the shooter`;
    case "booking.canceled": return `${who} canceled the booking${m.note ? `: ${String(m.note).slice(0, 80)}` : ""}`;
    case "booking.calendar_moved": return `The shoot time was moved in Google Calendar${m.to ? ` to ${fmtLa(String(m.to))}` : ""}; the booking follows`;
    case "booking.calendar_shooter": return m.email ? `${String(m.email)} was added as the shooter in Google Calendar` : "The shooter was removed in Google Calendar";
    case "calendar.event_merged": return `A hand-made calendar event${m.title ? ` ("${String(m.title).slice(0, 60)}")` : ""} was merged into this booking's event and removed`;
    case "booking.client_rescheduled": return `${String(m.email ?? who)} moved the shoot${m.from ? ` from ${String(m.from)}` : ""}${m.when ? ` to ${String(m.when)}` : ""}; confirm the new time`;
    case "booking.status_set": return `${who} set the booking ${m.restored ? "back " : ""}to ${statusWord(m.to)}${m.from ? ` (was ${statusWord(m.from)})` : ""}${m.note ? `: ${String(m.note).slice(0, 80)}` : ""}`;
    case "booking.note_saved": return m.note ? `${who} saved a note: ${String(m.note).slice(0, 80)}` : `${who} cleared the note`;
    case "email.shooter_invite_sent": return m.method === "CANCEL" ? `Calendar cancel sent to ${String(m.to ?? "the shooter")}` : `Calendar invite sent to ${String(m.to ?? "the shooter")}${m.sequence != null ? ` (v${String(m.sequence)})` : ""}`;
    case "email.shoot_brief_sent": return `Shoot brief sent to ${String(m.to ?? "the shooter")}${Array.isArray(m.cc) && m.cc.length ? ` (cc ${m.cc.join(", ")})` : ""}`;
    case "invoice.amount_set": return m.reissued ? `${who} reissued the invoice at a new amount${m.provider ? ` (${String(m.provider)})` : ""}; the pay link goes out next` : `${who} set the invoice amount${m.provider ? ` (${String(m.provider)})` : ""}; the pay link goes out next`;
    case "invoice.switched_to_card": return `${who} switched the invoice to card${m.canceledCheckout ? "; the pay at close checkout was closed" : m.fromMethod === "other" ? " (it was going to be paid another way)" : ""}`;
    case "email.pay_link_requested": return `${who} re-sent the pay link${m.to ? ` to ${String(m.to)}` : ""}`;
    case "job.run_now": return `${who} ran ${String(m.kind ?? "a side effect")} again`;
    // Edit booking (Oct 21 2026). No amounts in the feed lines.
    case "booking.visit_added": return `${who} added a second shoot (${String(m.kindLabel ?? "other")})${m.when ? `: ${String(m.when)}` : ""}${m.email ? `, shooter ${String(m.email)}` : ""}`;
    case "booking.visit_updated": return `${who} changed the second shoot (${String(m.kindLabel ?? "other")})${m.when ? `: ${String(m.when)}` : ""}${m.changed ? ` (${String(m.changed)})` : ""}`;
    case "booking.visit_canceled": return m.reason === "booking canceled" ? `The second shoot (${String(m.kindLabel ?? "other")})${m.when ? ` on ${String(m.when)}` : ""} was canceled with the booking` : `${who} canceled the second shoot (${String(m.kindLabel ?? "other")})${m.when ? ` on ${String(m.when)}` : ""}`;
    case "booking.visit_done": return `${who} marked the second shoot (${String(m.kindLabel ?? "other")}) done`;
    case "booking.visit_calendar_moved": return `The second shoot (${String(m.kindLabel ?? "other")}) was moved in Google Calendar${m.to ? ` to ${fmtLa(String(m.to))}` : ""}; Studio follows`;
    case "booking.visit_calendar_shooter": return m.email ? `${String(m.email)} was set as the second shoot's shooter in Google Calendar` : "The second shoot's shooter was removed in Google Calendar";
    case "invoice.visit_created": return `${who} made an invoice for the second shoot (${String(m.kindLabel ?? "other")})${m.items ? `: ${String(m.items)}` : ""}; the pay link goes out next`;
    case "booking.edited": return `${who} edited the booking${m.changed ? `: ${String(m.changed)}` : ""}`;
    case "invoice.addon_created": return `${who} added an invoice for the added items${m.items ? ` (${String(m.items)})` : ""}${m.needsQuote ? "; it waits for an amount" : "; the pay link goes out next"}`;
    case "invoice.refund_by_hand": return `${who} removed items from a paid booking${m.items ? ` (${String(m.items)})` : ""}; refund the difference by hand`;
    case "email.time_confirmed_sent": return `${m.variant === "reconfirmed" ? "New time confirmation" : m.variant === "moved" ? "Shoot moved email" : "Time confirmation"} sent${m.to ? ` to ${String(m.to)}` : ""}`;
    case "email.reminder_sent": return `Reminder before the shoot sent${m.to ? ` to ${String(m.to)}` : ""}`;
    case "email.rescheduled_sent": return `Reschedule email sent${m.to ? ` to ${String(m.to)}` : ""}`;
    // The Dropbox raw mirror (Oct 21 2026). Never a token; the account's name and email only.
    case "dropbox.connected": return `${who} connected Dropbox${m.email ? ` (${String(m.email)})` : ""}`;
    case "dropbox.disconnected": return `${who} disconnected Dropbox`;
    case "drive.connected": return `${who} connected Google Drive${m.email ? ` (${String(m.email)})` : ""}`;
    case "drive.disconnected": return `${who} disconnected Google Drive`;
    case "shoot.drive_synced": return `Raw files copied to Google Drive${n("photos") != null ? ` (${dropboxCounts(n("photos") ?? 0, n("video") ?? 0)})` : ""}`;
    case "shoot.drive_requeued": return `${who} asked for ${n("count") ?? "the"} file${n("count") === 1 ? "" : "s"} to be copied to Google Drive again`;
    case "client.drive": return `${String(m.email ?? who)} added ${n("count") ?? 1} file${n("count") === 1 ? "" : "s"} to Google Drive`;
    case "shoot.twilight_made": return `${who} made a Champagne twilight of ${m.from ? String(m.from) : "a frame"}`;
    case "shoot.final_review": return `${who} sent ${n("corrected") ? `${n("corrected")} corrected photo${n("corrected") === 1 ? "" : "s"}` : "the shoot"} for final review`;
    case "shoot.qc_status": return `${who} moved the Photo QC card to ${m.label ? String(m.label) : "another column"}`;
    case "twilight.preset_saved": return `${who} set the virtual twilight preset to ${m.name ? String(m.name) : "a preset"}`;
    case "shoot.dropbox_synced": return `Raw files copied to Dropbox${n("photos") != null ? ` (${dropboxCounts(n("photos") ?? 0, n("video") ?? 0)})` : ""}`;
    case "shoot.dropbox_requeued": return `${who} asked for ${n("count") ?? "the"} file${n("count") === 1 ? "" : "s"} to be copied to Dropbox again`;
    case "shoot.r2_raws_removed": return `Raws removed from R2 after the Dropbox check (${n("files") ?? "all"} file${n("files") === 1 ? "" : "s"}); Dropbox keeps them`;
    case "shoot.r2_raw_kept":
    case "shoot.r2_raw_kept_again": return `Raw kept in R2: ${m.file ? String(m.file) : "a file"}. ${m.reason ? String(m.reason) : "The Dropbox check failed."}`;
    default: return `${who}: ${a.action}`;
  }
}

// What the QA team may read in an activity feed (an allowlist, so a new
// action stays admin-only until it is added here): the shoot and media work
// and the client's gallery feedback. Never payments, bookings, client or team
// admin, admin access or view as.
const QA_ACTIONS = new Set<string>([
  "listing.cover",
  "revision.status",
  "client.approved",
  "client.revision_requested",
  "bundles.rebuilt",
]);

export function qaMaySee(action: string): boolean {
  return action.startsWith("shoot.") || action.startsWith("media.") || QA_ACTIONS.has(action);
}
