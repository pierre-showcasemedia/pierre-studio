// The job queue (docs/booking-to-payment.md). Every side effect of a
// booking (Stripe invoice, email, Slack, calendar) is a row in `jobs`, written
// in the same batch as the booking and run from here: right away in the
// route's after(), then by the minute cron as the safety net.
//
// Rules: one lease per job so two drains never run the same row; retries back
// off 2^attempts minutes; the team hears about the FIRST failure (with the
// admin link) and again when a job dies at max_attempts (8). A provider that
// is not configured keeps the job queued (not dead) and alerts once. Rows carry
// `env`, so the production cron never executes preview rows (one database).
// A row of a kind this code no longer has (email.receipt, removed Oct 16 2026:
// Stripe and Titus send their own receipts) is marked done with the note
// "kind removed": terminal, no retry, no alert.
import { and, asc, eq, inArray, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { JobKind, JobPayload } from "@/db/schema";
import { logActivity } from "./activity";
import { sendBookingEmail, sendPayLinkEmail } from "./booking-email";
import { fmtWhen } from "./booking-time";
import { currentEnv, DeferError, FatalJobError, NotConfiguredError, runWithDrainDeadline, SkipJobError } from "./jobs-core";
import { paidLineText, reconcileInvoices } from "./payments";
import { bookingCard, hasSlackBookings, hasSlackVideoEditing, hubBookingReceived, hubJobIssue, hubJobWaiting, moneyFree, postBookingLine, postToBookings, postToHub, postToPayments, flagged, videoEditingShootReady } from "./slack";
import { createStripeInvoiceForInvoice } from "./stripe-invoice";
import { runBundleRebuild } from "./bundles";
import { BUNDLE_KINDS, BUNDLE_LEASE_MS } from "./bundle-jobs";
import { isTimeConfirmed } from "./booking-status";
import { sendShooterInvite } from "./shooter-invite";
import { sendShootBrief } from "./shoot-brief";
import { sendRescheduledEmail, sendTimeConfirmedEmail } from "./booking-time-email";
import { cancelBookingEvent, cancelVisitEvent, hasCalendarSync, refreshBookingWeather, refreshHandMadeWeather, refreshVisitWeather, upsertBookingEvent, upsertVisitEvent } from "./google-calendar";
import { runRevisionIntake } from "./revision-intake";
import { createCheckoutForInvoice } from "./titus";
import { MIRROR_KINDS, runDropboxFinal, runDropboxFolder, runDropboxMirror, runFinalSweep } from "./dropbox-mirror";
import { runRawCleanup, runRawSweep } from "./r2-raw-cleanup";
import { ensureCardForBooking, videoEditingLineFor, videoFootageInEditing } from "./video-board";
import { runUploadCheck } from "./upload-runs";

const LEASE_MS = 120_000;
// A "Download all" rebuild works for up to four minutes of a run: longer than
// LEASE_MS. BUNDLE_LEASE_MS (src/lib/bundle-jobs.ts) covers that, and the
// rebuild renews it at every checkpoint.
const WAIT_NOT_CONFIGURED_MS = 30 * 60_000;
const MAX_BACKOFF_MIN = 24 * 60;
// The calendar jobs wait quietly where the booking calendar sync is off
// (previews, unless GOOGLE_CALENDAR_SYNC=on). The payments channel is
// optional, so its two posts wait quietly too when SLACK_PAYMENTS_WEBHOOK_URL
// is unset (health shows slackPayments: false) instead of one hub line per
// invoice.
// The Dropbox mirror waits the same way until the app is connected on
// Settings (one job per raw file, so a hub line each would flood it).
const QUIET_WAITING_KINDS = new Set<string>(["calendar.upsert", "calendar.cancel", "calendar.visit_upsert", "calendar.visit_cancel", "slack.paid", "slack.payment", "dropbox.mirror", "dropbox.folder", "dropbox.final_sweep", "dropbox.final", "r2.raw_sweep", "r2.raw_cleanup"]);
// Kinds that once existed. A leftover queued row is finished, never run.
const REMOVED_KINDS = new Set<string>(["email.receipt"]);
// The forecast refresh (calendar.weather, every 3 hours per upcoming booking)
// runs in the cron's second pass too: a burst of ten forecasts never holds a
// booking email or an invoice.
export const WEATHER_KINDS: readonly JobKind[] = ["calendar.weather"];
// Kinds a plain drain leaves alone: the migration (operator-driven), the
// Dropbox mirror (bulk, one row per raw file; the cron drains it in its own
// pass after everything else, so a shoot of 200 raws never holds a booking
// email behind it), the weather refresh, and since Nov 10 2026 the "Download
// all" rebuilds (minutes of zip writing; the cron's zip pass runs them).
export const BACKGROUND_KINDS: readonly string[] = [...MIRROR_KINDS, ...WEATHER_KINDS, ...BUNDLE_KINDS];

type JobRow = typeof schema.jobs.$inferSelect;

export type JobOutcome = { id: string; kind: string; outcome: "done" | "skipped" | "failed" | "dead" | "waiting" | "deferred"; error?: string };

// ---- Handlers ------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// The slack.booking job. With SLACK_BOOKINGS_WEBHOOK_URL set, the booking is a
// card in #bookings (and NOT a hub line, so a hub webhook pointed at the
// same channel never doubles it); without it, today's one-line hub post. The
// phone and brokerage come from what THIS submission said (bookings.raw, the
// form's client block or top-level fields), falling back to the client row,
// which keeps the first values it ever learned; access notes and the
// requested time live on the booking row itself.
async function postBookingToSlack(bookingId: string, updated: boolean): Promise<void> {
  const b = await db().query.bookings.findFirst({
    where: eq(schema.bookings.id, bookingId),
    with: { listing: { columns: { address: true, nda: true } }, client: { columns: { name: true, email: true, phone: true, company: true } }, invoice: { columns: { status: true } } },
  });
  if (!b) throw new Error(`booking ${bookingId} not found`);
  const listing = { address: b.listing?.address ?? String(b.property?.street ?? "a listing"), nda: b.listing?.nda ?? false };
  if (!hasSlackBookings()) {
    await hubBookingReceived({
      bookingId: b.id,
      listing,
      clientName: b.client?.name ?? null,
      clientEmail: b.client?.email ?? "",
      servicesLabel: b.servicesLabel,
      when: fmtWhen({ desiredDate: b.desiredDate, startTime: b.startTime }),
      paymentMethod: b.paymentMethod,
      paymentDetail: b.paymentDetail,
      needsQuote: b.invoice?.status === "needs_quote",
      updated,
    });
    return;
  }
  const payload = rec(b.raw?.payload);
  const formClient = rec(payload.client);
  const prop = rec(b.property);
  const card = bookingCard({
    bookingId: b.id,
    updated,
    listing,
    client: {
      name: b.client?.name ?? str(formClient.name) ?? null,
      email: b.client?.email ?? str(formClient.email) ?? "",
      phone: str(formClient.phone) ?? str(payload.phone) ?? b.client?.phone ?? null,
      company: str(formClient.company) ?? str(payload.company) ?? str(payload.brokerage) ?? b.client?.company ?? null,
    },
    propertyLine: [str(prop.status), str(prop.listingType)].filter(Boolean).join(" · ") || null,
    desiredDate: b.desiredDate,
    startTime: b.startTime,
    timeConfirmed: isTimeConfirmed(b.status),
    servicesLabel: b.servicesLabel,
    paymentMethod: b.paymentMethod,
    paymentDetail: b.paymentDetail,
    needsQuote: b.invoice?.status === "needs_quote",
    accessNotes: b.accessNotes,
    homeownerHome: /^yes$/i.test(str(prop.homeownerHome) ?? ""),
    listingAgreement: str(prop.listingAgreement),
    customRequest: b.customRequest,
    additionalDetails: b.clientNotes,
  });
  await postToBookings(card);
}

async function dispatch(job: JobRow): Promise<void> {
  const p: JobPayload = job.payload ?? {};
  switch (job.kind) {
    case "stripe.invoice.create": {
      if (!job.invoiceId) throw new Error("job has no invoiceId");
      await createStripeInvoiceForInvoice(job.invoiceId);
      return;
    }
    case "titus.checkout.create": {
      // Pay at close: the Titus checkout for the invoice (payNowEnabled false).
      // Skips a row that already has a provider_id; waits while TITUS_API_KEY is unset.
      if (!job.invoiceId) throw new Error("job has no invoiceId");
      await createCheckoutForInvoice(job.invoiceId);
      return;
    }
    case "email.booking": {
      if (!job.bookingId) throw new Error("job has no bookingId");
      await sendBookingEmail(job.bookingId, { version: p.version ?? 1, updated: Boolean(p.updated), idempotencyKey: job.idempotencyKey });
      return;
    }
    case "slack.booking": {
      if (!job.bookingId) throw new Error("job has no bookingId");
      await postBookingToSlack(job.bookingId, Boolean(p.updated));
      return;
    }
    case "slack.issue": {
      // A finished money-free line. channel "bookings" (the lifecycle lines:
      // time confirmed, rescheduled, canceled, pay at close declined) goes to
      // #bookings when that webhook is set, else the hub; everything else
      // (a payment the row could not take, a revision after issue) is the hub's.
      const text = moneyFree(p.note || "A booking needs a look.");
      if (p.channel === "bookings") await postBookingLine(text);
      else await postToHub({ text: flagged(text) });
      return;
    }
    // ---- step two: payments ----
    case "slack.paid": {
      // One line with the amount in the private payments channel, once paid.
      if (!job.invoiceId) throw new Error("job has no invoiceId");
      const text = await paidLineText(job.invoiceId);
      if (!text) throw new Error(`invoice ${job.invoiceId} not found`);
      await postToPayments(text);
      return;
    }
    case "slack.payment": {
      // A finished line (issued, failed, review, refund, …) handed over by the
      // webhook or job that saw it, so that caller could return at once.
      if (!p.text) throw new Error("slack.payment job has no text");
      await postToPayments(p.text);
      return;
    }
    case "payments.reconcile": {
      const r = await reconcileInvoices(50);
      if (r.errors) console.warn("[jobs] payments.reconcile:", r);
      return;
    }
    case "email.pay_link": {
      // The pay page link on its own: first time (the booking email went out
      // before the checkout existed) or "here is your link again" (a resend).
      // The row's invoiceId names the invoice: the booking's own, or an add-on
      // invoice from Edit booking (then the email bills the added items alone).
      if (!job.bookingId) throw new Error("job has no bookingId");
      await sendPayLinkEmail(job.bookingId, { idempotencyKey: job.idempotencyKey, again: p.again === true, invoiceId: job.invoiceId });
      return;
    }
    case "email.time_confirmed": {
      // An admin confirmed or moved the time: the client's confirmation, with shoot.ics (src/lib/booking-time-email.ts).
      await sendTimeConfirmedEmail(job);
      return;
    }
    case "email.rescheduled": {
      // The client moved the shoot from the portal: "the business will confirm your new time shortly" (no .ics).
      await sendRescheduledEmail(job);
      return;
    }
    case "bundle.rebuild":
      // The "Download all" zips, a slice per run: out of time it saves its
      // place and defers, and the next run carries on (src/lib/bundles.ts).
      await runBundleRebuild(job);
      return;
    case "email.shooter_invite": {
      // The shooter's iCalendar invite (REQUEST or CANCEL). Re-reads the
      // booking; a superseded or no longer relevant invite is skipped.
      if (!job.bookingId && !p.bookingId) throw new FatalJobError("email.shooter_invite needs a bookingId");
      // One invite path: with the booking calendar on, Google invites the
      // shooter (they are the event's guest), so this email never goes too.
      if (hasCalendarSync()) throw new SkipJobError("Google Calendar sends the shooter's invite");
      await sendShooterInvite(job);
      return;
    }
    case "email.shoot_brief": {
      // Queued by the cron 30 minutes before the start; skips a moved, canceled or started shoot.
      await sendShootBrief(job);
      return;
    }
    // Step three (calendar) builds these. Until then the rows wait (never die).
    // PINNED (Oct 20 2026): before building, ask the owner which ONE path
    // invites the shooter. Studio already emails the shooter an .ics invite
    // (email.shooter_invite, src/lib/shooter-invite.ts); adding the shooter as
    // a Google Calendar guest here would send a second invite for the same
    // shoot. Keep one, switch the other off. See STUDIO.md "What's left".
    case "calendar.upsert":
      // The booking's latest state onto hello@'s calendar (src/lib/google-calendar.ts).
      await upsertBookingEvent(job);
      return;
    case "calendar.cancel":
      await cancelBookingEvent(job);
      return;
    case "calendar.visit_upsert":
      // An additional shoot (return trip, pickups, reshoot, twilight) as its own event (src/lib/booking-visits.ts).
      await upsertVisitEvent(job);
      return;
    case "calendar.visit_cancel":
      await cancelVisitEvent(job);
      return;
    case "calendar.weather":
      // The forecast for the shoot's address onto its event (src/lib/weather.ts). Never retries: the next refresh is 3 hours away.
      // payload.visitId: an additional shoot's event. With no booking: the hand-made shoot events of the coming week.
      if (p.visitId) await refreshVisitWeather(p.visitId);
      else if (job.bookingId) await refreshBookingWeather(job);
      else await refreshHandMadeWeather();
      return;
    case "dropbox.mirror":
      // One raw file from R2 into the business's Dropbox (src/lib/dropbox-mirror.ts).
      // Long copies save a cursor and defer; the next tick resumes.
      await runDropboxMirror(job);
      return;
    case "dropbox.folder":
      // The listing's folder in Dropbox at booking, Photo and Video at upload (src/lib/dropbox-mirror.ts).
      await runDropboxFolder(job);
      return;
    case "dropbox.final_sweep":
      // Delivered files whose copy in <listing>/FINAL DELIVERY is missing or old: one dropbox.final each.
      await runFinalSweep(job);
      return;
    case "dropbox.final":
      // One delivered file into <listing>/FINAL DELIVERY/<section> (src/lib/dropbox-mirror.ts).
      await runDropboxFinal(job);
      return;
    case "r2.raw_sweep":
      // Raws Dropbox has a copy of and editing is done with: one check each (src/lib/r2-raw-cleanup.ts).
      await runRawSweep();
      return;
    case "twilight.frame": {
      // Make twilight on one frame: Champagne upstream, the result into the Twilight section (src/lib/pipeline.ts).
      const { runFrameTwilight } = await import("./pipeline");
      await runFrameTwilight(job);
      return;
    }
    case "r2.raw_cleanup":
      // Verify Dropbox's copy against the R2 bytes (size + content hash), then delete the raw from R2.
      await runRawCleanup(job);
      return;
    case "video.card":
      // A booking with a film or reel gets its card on the Video board (src/lib/video-board.ts).
      if (!job.bookingId) throw new FatalJobError("video.card needs a booking");
      await ensureCardForBooking(job.bookingId);
      return;
    case "slack.video_editing": {
      // A shoot's raw video is all in Dropbox: one line in #video-editing tagging the video editors (src/lib/slack.ts).
      if (!hasSlackVideoEditing()) throw new SkipJobError("SLACK_VIDEO_EDITING_WEBHOOK_URL is not set");
      if (!p.shootId) throw new FatalJobError("slack.video_editing needs payload.shootId");
      const line = await videoEditingLineFor(p.shootId);
      if (!line) throw new SkipJobError("no clips of this shoot are waiting in Dropbox");
      await videoEditingShootReady(line);
      // Nov 5 2026: the editors were told, so the card is In editing (out of In queue only).
      if (line.cardId) await videoFootageInEditing(line.cardId).catch((e) => console.error("[jobs] video card to editing", e));
      return;
    }
    case "slack.upload_check":
      // An upload that never said it was done: one "stopped" line once it goes quiet (src/lib/upload-runs.ts).
      await runUploadCheck(job);
      return;
    case "inbound.revision":
      // A client's texts → a revision request when they ask for one (src/lib/revision-intake.ts).
      // Waits (defers) until the conversation is quiet, then files or ignores the whole burst.
      await runRevisionIntake(job);
      return;
    default:
      throw new Error(`unknown job kind ${String(job.kind)}`);
  }
}

// ---- The drainer ---------------------------------------------------------

// A hub alert is a courtesy, never part of the work: if Slack is down or the
// text trips a rule, the queue keeps moving and the job's own status stands.
async function alertQuietly(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[jobs] ${what} alert failed:`, e instanceof Error ? e.message : e);
  }
}

async function runJob(job: JobRow): Promise<JobOutcome> {
  const d = db();
  const base = { id: job.id, kind: job.kind };
  if (REMOVED_KINDS.has(job.kind)) {
    await d.update(schema.jobs).set({ status: "done", doneAt: new Date(), leaseUntil: null, lastError: "kind removed", updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
    return { ...base, outcome: "skipped", error: "kind removed" };
  }
  try {
    await dispatch(job);
    await d.update(schema.jobs).set({ status: "done", doneAt: new Date(), leaseUntil: null, lastError: null, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
    return { ...base, outcome: "done" };
  } catch (e) {
    if (e instanceof SkipJobError) {
      // Nothing left to do (a canceled booking's email): done, with the reason
      // where the admin page shows a job's last note.
      await d
        .update(schema.jobs)
        .set({ status: "done", doneAt: new Date(), leaseUntil: null, lastError: `skipped: ${e.message}`.slice(0, 1000), updatedAt: new Date() })
        .where(eq(schema.jobs.id, job.id));
      return { ...base, outcome: "skipped", error: e.message };
    }
    if (e instanceof NotConfiguredError) {
      await d
        .update(schema.jobs)
        .set({ status: "queued", attempts: Math.max(0, job.attempts - 1), runAt: new Date(Date.now() + WAIT_NOT_CONFIGURED_MS), leaseUntil: null, lastError: e.message, updatedAt: new Date() })
        .where(eq(schema.jobs.id, job.id));
      // Kinds whose handler ships in step two or three wait quietly; a missing
      // provider key for a built handler is worth one line in the hub.
      if (!job.alertedAt && !QUIET_WAITING_KINDS.has(job.kind)) {
        await alertQuietly("waiting", async () => {
          await hubJobWaiting({ kind: job.kind, reason: e.message, bookingId: job.bookingId });
          await d.update(schema.jobs).set({ alertedAt: new Date() }).where(eq(schema.jobs.id, job.id));
        });
      }
      return { ...base, outcome: "waiting", error: e.message };
    }
    if (e instanceof DeferError) {
      await d
        .update(schema.jobs)
        .set({ status: "queued", attempts: Math.max(0, job.attempts - 1), runAt: new Date(Date.now() + e.ms), leaseUntil: null, lastError: e.message, updatedAt: new Date() })
        .where(eq(schema.jobs.id, job.id));
      return { ...base, outcome: "deferred", error: e.message };
    }
    const message = e instanceof Error ? e.message : String(e);
    // A FatalJobError (no retry can fix it) dies on the spot.
    const dead = e instanceof FatalJobError || job.attempts >= job.maxAttempts;
    const backoffMin = Math.min(2 ** job.attempts, MAX_BACKOFF_MIN);
    await d
      .update(schema.jobs)
      .set({
        status: dead ? "dead" : "queued",
        runAt: dead ? job.runAt : new Date(Date.now() + backoffMin * 60_000),
        leaseUntil: null,
        lastError: message.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    await logActivity({ action: dead ? "job.dead" : "job.failed", listingId: job.listingId, meta: { kind: job.kind, jobId: job.id, bookingId: job.bookingId, attempts: job.attempts, error: message.slice(0, 300) } });
    // Migration batches never page the hub: the operator watches them directly.
    if (!job.alertedAt || dead) {
      await alertQuietly("issue", async () => {
        await hubJobIssue({ kind: job.kind, error: message, dead, bookingId: job.bookingId, listingId: job.listingId, attempts: job.attempts });
        if (!job.alertedAt) await d.update(schema.jobs).set({ alertedAt: new Date() }).where(eq(schema.jobs.id, job.id));
      });
    }
    console.error(`[jobs] ${job.kind} ${job.id} ${dead ? "died" : "failed"} (attempt ${job.attempts}):`, message);
    return { ...base, outcome: dead ? "dead" : "failed", error: message };
  }
}

// Claims due jobs for THIS environment one at a time and runs them until the
// budget is spent. `bookingId` narrows the drain to one booking (the intake
// route's after()) and `invoiceId` to one invoice (a webhook's after()), so a
// fresh booking or payment never waits behind the backlog.
// `kinds` narrows the drain to those kinds only (the migration runner, the
// cron's Dropbox pass and zip pass); every other drain leaves the
// BACKGROUND_KINDS alone, so an intake's after() never spends its budget
// copying files. `listingId` narrows it to one listing's jobs (the admin
// API's "rebuild this listing's zips now").
// FINAL DELIVERY copies go after every other due job (Oct 27 2026): a
// backfill queues thousands, and a fresh upload's raw copy and folders must
// not wait hours behind them. Among themselves, still oldest first.
// The raw cleanup (re-reading every raw to verify Dropbox's copy) waits too.
const LATER_KINDS: readonly JobKind[] = ["dropbox.final", "r2.raw_cleanup"];

export async function drainJobs(opts: { budgetMs?: number; bookingId?: string | null; invoiceId?: string | null; listingId?: string | null; limit?: number; kinds?: readonly string[] } = {}): Promise<{ env: string; worked: JobOutcome[]; more: boolean }> {
  const env = currentEnv();
  const worked: JobOutcome[] = [];
  if (!hasDb()) return { env, worked, more: false };
  const d = db();
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  const limit = opts.limit ?? 25;
  let more = false;
  // Handlers that work in chunks (the Dropbox mirror, the zip rebuild) read the deadline (drainDeadline) to stop in time.
  for (let i = 0; i < limit; i++) {
    if (Date.now() > deadline - 2_000) {
      more = true;
      break;
    }
    const now = new Date();
    const due = or(eq(schema.jobs.status, "queued"), and(eq(schema.jobs.status, "running"), lt(schema.jobs.leaseUntil, now)));
    const candidates = await d.query.jobs.findMany({
      where: and(
        eq(schema.jobs.env, env),
        lte(schema.jobs.runAt, now),
        due,
        ...(opts.bookingId ? [eq(schema.jobs.bookingId, opts.bookingId)] : []),
        ...(opts.invoiceId ? [eq(schema.jobs.invoiceId, opts.invoiceId)] : []),
        ...(opts.listingId ? [eq(schema.jobs.listingId, opts.listingId)] : []),
        opts.kinds ? inArray(schema.jobs.kind, [...opts.kinds] as JobKind[]) : notInArray(schema.jobs.kind, [...BACKGROUND_KINDS] as JobKind[])
      ),
      orderBy: [sql`case when ${inArray(schema.jobs.kind, [...LATER_KINDS])} then 1 else 0 end`, asc(schema.jobs.runAt), asc(schema.jobs.createdAt)],
      limit: 3,
      columns: { id: true, kind: true },
    });
    if (!candidates.length) break;
    let job: JobRow | null = null;
    for (const c of candidates) {
      const claimed = await d
        .update(schema.jobs)
        .set({ status: "running", leaseUntil: new Date(Date.now() + (c.kind === "bundle.rebuild" ? BUNDLE_LEASE_MS : LEASE_MS)), attempts: sql`${schema.jobs.attempts} + 1`, updatedAt: new Date() })
        .where(and(eq(schema.jobs.id, c.id), due))
        .returning();
      if (claimed.length) {
        job = claimed[0];
        break;
      }
    }
    if (!job) continue; // someone else took these three; look again
    const claimedJob = job;
    worked.push(await runWithDrainDeadline(deadline, () => runJob(claimedJob)));
  }
  return { env, worked, more };
}

// ---- Health -------------------------------------------------------------

export async function jobCounts(): Promise<Record<string, number>> {
  const rows = await db()
    .select({ status: schema.jobs.status, n: sql<number>`count(*)::int` })
    .from(schema.jobs)
    .where(eq(schema.jobs.env, currentEnv()))
    .groupBy(schema.jobs.status);
  const out: Record<string, number> = { queued: 0, running: 0, done: 0, dead: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

// The cron writes a heartbeat every run; health reports it so a stopped cron
// is visible ("lastCronAt" older than 10 min).
export async function heartbeat(): Promise<void> {
  const value = { at: new Date().toISOString(), env: currentEnv() };
  await db()
    .insert(schema.settings)
    .values({ key: "cron.last_tick", value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

export async function lastCronAt(): Promise<string | null> {
  const row = await db().query.settings.findFirst({ where: eq(schema.settings.key, "cron.last_tick") });
  const at = row?.value?.at;
  return typeof at === "string" ? at : null;
}
