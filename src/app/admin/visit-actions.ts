"use server";
// Additional shoots on a booking (Oct 27 2026, src/lib/booking-visits.ts):
// "Add second shoot" on the booking page, then Save changes, Mark done and
// Cancel on each one. Full admins only (the same gate as every booking
// action). Each change writes the visit row, an activity row, a calendar job
// (the visit's own event on the hello@ calendar; Google invites the visit's
// shooter) and, for an add, a move, a new shooter or a cancel, one money-free
// line to #bookings. Nothing here emails the client or touches the invoice,
// except "Create new invoice?" (unticked by default) on the add form and
// Create invoice on a visit row: those make the visit its own card invoice and
// email the client its pay link (src/lib/visit-invoice.ts). Cancel voids an
// open visit invoice; a paid one is left alone (refund it in Stripe).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { VisitKind } from "@/db/schema";
import { requireAdmin } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { wallClockToUtc, toHm, toYmd } from "@/lib/booking-time";
import { isVisitKind, visitCancelSpec, visitKindLabel, visitUpsertSpec, visitWhenLabel } from "@/lib/booking-visits";
import { hasCalendarSync } from "@/lib/google-calendar";
import { drainJobs } from "@/lib/jobs";
import { currentEnv, enqueueJobs, type JobSpec } from "@/lib/jobs-core";
import { localYmd } from "@/lib/local-date";
import { isOtherEnv, rowEnv } from "@/lib/payments";
import { hubTextVisit } from "@/lib/slack";
import { createVisitInvoice, parseVisitInvoiceLines, visitInvoiceIsClosed, voidVisitInvoice, type VisitInvoiceLines } from "@/lib/visit-invoice";
import { fmtDollars } from "@/lib/studio-pricing";

type Outcome = { ok: true; message: string } | { ok: false; error: string };
const done = (message: string): Outcome => ({ ok: true, message });
const fail = (error: string): Outcome => ({ ok: false, error });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NOTE_MAX = 1000;

function finish(bookingId: string | null, r: Outcome): never {
  revalidatePath("/admin/bookings");
  if (bookingId) revalidatePath(`/admin/bookings/${bookingId}`);
  const q = r.ok ? `done=${encodeURIComponent(r.message)}` : `error=${encodeURIComponent(r.error)}`;
  redirect(bookingId ? `/admin/bookings/${bookingId}?${q}#visits` : `/admin/bookings?${q}`);
}

function drainLater(bookingId: string) {
  after(() => drainJobs({ budgetMs: 40_000, bookingId }).catch((e) => console.error("[admin/visits] drain", e)));
}

const otherEnv = (env: string | null | undefined): string | null => (isOtherEnv(env) ? `This booking belongs to the ${rowEnv(env)} environment and is handled there.` : null);

type Fields = { date: string; time: string; minutes: number; email: string | null; kind: VisitKind; note: string | null; startsAt: Date; endsAt: Date };

// The form, read and checked. A string is the error for the banner. A past
// date is refused unless it is the one already saved (`keepDate`, on an edit).
function readFields(formData: FormData, keepDate: string | null = null): Fields | string {
  const date = toYmd(String(formData.get("date") || ""));
  const time = toHm(String(formData.get("time") || ""));
  const minutes = Number(formData.get("minutes") || 0);
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const kind = String(formData.get("kind") || "");
  const note = String(formData.get("note") || "").trim().slice(0, NOTE_MAX);
  if (!date || !time) return "Enter a date and a start time.";
  // The listed lengths, or one Google Calendar set (kept when another field is edited).
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 12 * 60) return "Pick how long the shoot runs.";
  if (email && !EMAIL_RE.test(email)) return "That shooter email does not look right.";
  if (!isVisitKind(kind)) return "Pick what kind of shoot this is.";
  if (date < localYmd() && date !== keepDate) return "That date has passed. Pick today or later.";
  const startsAt = wallClockToUtc(date, time);
  if (!startsAt) return "That date and time could not be read.";
  return { date, time, minutes, email: email || null, kind, note: note || null, startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60_000) };
}

const listingName = (b: { listing?: { address: string; nda: boolean } | null; property: Record<string, unknown> | null }) => ({
  address: b.listing?.address ?? String(b.property?.street ?? "a listing"),
  nda: b.listing?.nda ?? false,
});

// What the banner says about the calendar and the shooter.
function calendarNote(shooter: string | null, previous: string | null = null): string {
  if (!hasCalendarSync()) return " The calendar sync is off on this deployment, so nothing goes on the calendar here.";
  const off = previous && previous !== shooter ? ` Google takes ${previous} off the event.` : "";
  if (!shooter) return ` The hello@ calendar updates next.${off} Add a shooter to send an invite.`;
  return ` The hello@ calendar updates next and Google sends ${shooter} the invite.${off}`;
}

// What Cancel says about the visit's invoice.
function invoiceBanner(r: Awaited<ReturnType<typeof voidVisitInvoice>> | null): string {
  if (!r) return "";
  const amt = r.amount ? ` ${r.amount}` : "";
  switch (r.state) {
    case "voided":
      return ` Its open${amt} invoice was voided${r.closed ? ` (the ${r.closed} is closed at Stripe)` : ""}, so the client can no longer pay it.${r.unclosed ? ` ${r.unclosed}` : ""}`;
    case "paid":
      return ` Its${amt} invoice is already paid and was left alone. Refund it in Stripe if the client should get the money back.`;
    case "settled":
      return ` Stripe shows its${amt} invoice paid, so it was recorded as paid and left alone. Refund it in Stripe if the client should get the money back.`;
    case "in_flight":
      return ` A payment on its${amt} invoice is in progress, so the invoice was left alone. Once it settles, refund it in Stripe if needed.`;
    default:
      return r.unclosed ? ` ${r.unclosed}` : "";
  }
}

export async function addVisit(bookingId: string, formData: FormData) {
  const actor = await requireAdmin();
  if (!hasDb()) finish(bookingId, fail("Demo mode: nothing was saved."));
  let out: Outcome;
  try {
    const f = readFields(formData);
    // "Create new invoice?" starts unticked: no box, no invoice, no client email.
    const wantInvoice = formData.get("invoice") === "on";
    const lines: VisitInvoiceLines | string | null = wantInvoice ? parseVisitInvoiceLines(formData) : null;
    const d = db();
    const b = await d.query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), with: { listing: { columns: { address: true, nda: true } }, client: { columns: { email: true, name: true } }, invoice: { columns: { status: true } } } });
    const envErr = b ? otherEnv(b.env) : null;
    if (typeof f === "string") out = fail(f);
    else if (typeof lines === "string") out = fail(`Nothing was added. ${lines}`);
    else if (!b) out = fail("Booking not found.");
    else if (envErr) out = fail(envErr);
    else if (b.status === "canceled") out = fail("This booking is canceled. Restore it before adding a second shoot.");
    else {
      const [v] = await d
        .insert(schema.bookingVisits)
        .values({ bookingId, listingId: b.listingId, env: currentEnv(), kind: f.kind, note: f.note, desiredDate: f.date, startTime: f.time, startsAt: f.startsAt, endsAt: f.endsAt, photographerEmail: f.email, status: "scheduled", calendarVersion: 1, createdBy: actor })
        .returning();
      const label = visitKindLabel(v.kind);
      const when = visitWhenLabel(v);
      await logActivity({ actorEmail: actor, action: "booking.visit_added", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, visitId: v.id, kind: v.kind, kindLabel: label, when, email: f.email, note: f.note, invoice: Boolean(lines) } });
      // The visit's own invoice, only when the box was ticked. A failure here
      // keeps the visit (it is on its way to the calendar) and says so.
      let invoiceNote = " No invoice was made; the booking's invoice is untouched and the client is not emailed.";
      let invoiced = false;
      if (lines) {
        try {
          const r = await createVisitInvoice({ booking: b, visit: v, kindLabel: label, whenLabel: when, lines, actor });
          invoiced = true;
          invoiceNote = ` A new ${fmtDollars(r.amountCents)} card invoice is being issued and ${r.to ?? "the client"} gets its pay link by email. The booking's own invoice is untouched.`;
        } catch (e) {
          invoiceNote = ` The invoice could not be made (${errText(e)}). Use Create invoice on the shoot below to try again.`;
        }
      }
      await enqueueJobs([
        visitUpsertSpec(v),
        { kind: "slack.issue", idempotencyKey: `slack.issue:visit_added:${v.id}`, bookingId, listingId: b.listingId, payload: { channel: "bookings", note: hubTextVisit({ bookingId, listing: listingName(b), change: "added", kindLabel: label, when, shooter: f.email, by: actor, invoiced }) } },
      ]);
      drainLater(bookingId);
      out = done(`${label} added: ${when}.${calendarNote(f.email)} The shooter gets the shoot brief 30 minutes before it starts.${invoiceNote}`);
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finish(bookingId, out);
}

async function loadVisit(visitId: string) {
  const d = db();
  const v = await d.query.bookingVisits.findFirst({ where: eq(schema.bookingVisits.id, visitId) });
  if (!v) return { v: null, b: null };
  const b = await d.query.bookings.findFirst({ where: eq(schema.bookings.id, v.bookingId), with: { listing: { columns: { address: true, nda: true } } } });
  return { v, b: b ?? null };
}

export async function updateVisit(visitId: string, bookingId: string, formData: FormData) {
  const actor = await requireAdmin();
  if (!hasDb()) finish(bookingId, fail("Demo mode: nothing was saved."));
  let out: Outcome;
  try {
    const { v, b } = await loadVisit(visitId);
    const f = readFields(formData, v?.desiredDate ?? null);
    const envErr = b ? otherEnv(b.env) : null;
    if (typeof f === "string") out = fail(f);
    else if (!v || !b || v.bookingId !== bookingId) out = fail("That second shoot was not found on this booking.");
    else if (envErr) out = fail(envErr);
    else if (b.status === "canceled") out = fail("This booking is canceled. Nothing was changed.");
    else if (v.status !== "scheduled") out = fail(`This ${visitKindLabel(v.kind).toLowerCase()} is ${v.status === "done" ? "marked done" : "canceled"}. Add a new one instead.`);
    else {
      const previous = v.photographerEmail?.trim().toLowerCase() || null;
      const moved = v.startsAt.getTime() !== f.startsAt.getTime() || v.endsAt.getTime() !== f.endsAt.getTime();
      const shooterChanged = previous !== f.email;
      const changed = [moved ? "time" : null, shooterChanged ? "shooter" : null, v.kind !== f.kind ? "kind" : null, (v.note ?? null) !== f.note ? "note" : null].filter(Boolean) as string[];
      if (!changed.length) out = done("Nothing changed.");
      else {
        const version = v.calendarVersion + 1;
        const now = new Date();
        await db()
          .update(schema.bookingVisits)
          .set({ kind: f.kind, note: f.note, desiredDate: f.date, startTime: f.time, startsAt: f.startsAt, endsAt: f.endsAt, photographerEmail: f.email, calendarVersion: version, updatedAt: now })
          .where(eq(schema.bookingVisits.id, visitId));
        const label = visitKindLabel(f.kind);
        const when = visitWhenLabel({ desiredDate: f.date, startTime: f.time, endsAt: f.endsAt });
        await logActivity({ actorEmail: actor, action: "booking.visit_updated", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, visitId, kind: f.kind, kindLabel: label, when, email: f.email, previous, changed: changed.join(", "), version } });
        const jobs: JobSpec[] = [visitUpsertSpec({ ...v, calendarVersion: version })];
        // #bookings hears about a move or a new shooter; a note or a kind on its own stays quiet.
        if (moved || shooterChanged) {
          jobs.push({ kind: "slack.issue", idempotencyKey: `slack.issue:visit_updated:${visitId}:v${version}`, bookingId, listingId: b.listingId, payload: { channel: "bookings", note: hubTextVisit({ bookingId, listing: listingName(b), change: moved ? "moved" : "updated", kindLabel: label, when, shooter: f.email, by: actor }) } });
        }
        await enqueueJobs(jobs);
        drainLater(bookingId);
        out = done(`${label} saved (${changed.join(", ")} changed): ${when}.${calendarNote(f.email, previous)}`);
      }
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finish(bookingId, out);
}

// Done: the trip happened. The event stays on the calendar as a record.
export async function markVisitDone(visitId: string, bookingId: string) {
  const actor = await requireAdmin();
  if (!hasDb()) finish(bookingId, fail("Demo mode: nothing was saved."));
  let out: Outcome;
  try {
    const { v, b } = await loadVisit(visitId);
    const envErr = b ? otherEnv(b.env) : null;
    if (!v || !b || v.bookingId !== bookingId) out = fail("That second shoot was not found on this booking.");
    else if (envErr) out = fail(envErr);
    else if (v.status !== "scheduled") out = fail(`This one is already ${v.status}.`);
    else {
      await db().update(schema.bookingVisits).set({ status: "done", updatedAt: new Date() }).where(eq(schema.bookingVisits.id, visitId));
      const label = visitKindLabel(v.kind);
      await logActivity({ actorEmail: actor, action: "booking.visit_done", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, visitId, kind: v.kind, kindLabel: label, when: visitWhenLabel(v) } });
      out = done(`${label} marked done. Its calendar event stays as a record.`);
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finish(bookingId, out);
}

// Cancel: the event comes off the calendar and Google tells the shooter.
export async function cancelVisit(visitId: string, bookingId: string) {
  const actor = await requireAdmin();
  if (!hasDb()) finish(bookingId, fail("Demo mode: nothing was saved."));
  let out: Outcome;
  try {
    const { v, b } = await loadVisit(visitId);
    const envErr = b ? otherEnv(b.env) : null;
    if (!v || !b || v.bookingId !== bookingId) out = fail("That second shoot was not found on this booking.");
    else if (envErr) out = fail(envErr);
    else if (v.status !== "scheduled") out = fail(`This one is already ${v.status}.`);
    else {
      // Its open invoice is voided first (a throw here stops the cancel, so
      // the visit and its invoice never disagree); a paid one stays.
      const inv = v.invoiceId ? await voidVisitInvoice(v.invoiceId, actor, "second shoot canceled") : null;
      const version = v.calendarVersion + 1;
      await db().update(schema.bookingVisits).set({ status: "canceled", calendarVersion: version, updatedAt: new Date() }).where(eq(schema.bookingVisits.id, visitId));
      const label = visitKindLabel(v.kind);
      const when = visitWhenLabel(v);
      await logActivity({ actorEmail: actor, action: "booking.visit_canceled", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, visitId, kind: v.kind, kindLabel: label, when } });
      await enqueueJobs([
        visitCancelSpec({ ...v, calendarVersion: version }),
        { kind: "slack.issue", idempotencyKey: `slack.issue:visit_canceled:${visitId}:v${version}`, bookingId, listingId: b.listingId, payload: { channel: "bookings", note: hubTextVisit({ bookingId, listing: listingName(b), change: "canceled", kindLabel: label, when, shooter: null, by: actor }) } },
      ]);
      drainLater(bookingId);
      const shooter = v.photographerEmail?.trim().toLowerCase() || null;
      out = done(`${label} on ${when} canceled.${hasCalendarSync() ? ` Its calendar event is deleted next${shooter ? ` and Google tells ${shooter}` : ""}.` : ""}${invoiceBanner(inv)}`);
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finish(bookingId, out);
}

// "Create invoice" on a visit row: the same invoice the add form's "Create new
// invoice?" makes, for a visit that has none yet (or whose invoice was voided).
// Scheduled and done visits both take one; a canceled visit or booking does not.
export async function createVisitInvoiceForVisit(visitId: string, bookingId: string, formData: FormData) {
  const actor = await requireAdmin();
  if (!hasDb()) finish(bookingId, fail("Demo mode: nothing was saved."));
  let out: Outcome;
  try {
    const d = db();
    const v = await d.query.bookingVisits.findFirst({ where: eq(schema.bookingVisits.id, visitId) });
    const b = v ? await d.query.bookings.findFirst({ where: eq(schema.bookings.id, v.bookingId), with: { listing: { columns: { address: true, nda: true } }, client: { columns: { email: true, name: true } }, invoice: { columns: { status: true } } } }) : null;
    const current = v?.invoiceId ? await d.query.invoices.findFirst({ where: eq(schema.invoices.id, v.invoiceId), columns: { status: true } }) : null;
    const lines = parseVisitInvoiceLines(formData);
    const envErr = b ? otherEnv(b.env) : null;
    if (!v || !b || v.bookingId !== bookingId) out = fail("That second shoot was not found on this booking.");
    else if (envErr) out = fail(envErr);
    else if (b.status === "canceled") out = fail("This booking is canceled. Restore it before invoicing a second shoot.");
    else if (v.status === "canceled") out = fail("This second shoot is canceled, so it takes no invoice.");
    else if (current && !visitInvoiceIsClosed(current.status)) out = fail(`This second shoot already has an invoice (${current.status.replace(/_/g, " ")}).`);
    else if (typeof lines === "string") out = fail(lines);
    else {
      const label = visitKindLabel(v.kind);
      const r = await createVisitInvoice({ booking: b, visit: v, kindLabel: label, whenLabel: visitWhenLabel(v), lines, actor });
      drainLater(bookingId);
      out = done(`Invoice made for the ${label.toLowerCase()}: ${fmtDollars(r.amountCents)}, card. The Stripe invoice is being issued and ${r.to ?? "the client"} gets its pay link by email. The booking's own invoice is untouched.`);
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finish(bookingId, out);
}
