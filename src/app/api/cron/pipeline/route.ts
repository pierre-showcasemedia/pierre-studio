// The pipeline heartbeat. Vercel calls this every minute (vercel.json crons)
// with "Authorization: Bearer ${CRON_SECRET}". Each run advances a few shoots
// one bounded step and returns inside PIPELINE_STEP_SECONDS (default 200).
// Oct 27 2026: was 50, which left the import about 20 seconds a minute, so a
// 115-frame shoot came back from editing a few frames at a time for half an
// hour. The shoot's lease keeps overlapping runs off the same shoot.
// Nothing errors when the editing account is not connected: shoots park at
// "uploaded" and the run reports parked: true.
//
// Since the booking intake (step one) the same tick also drains the job queue
// (Stripe invoices, booking emails, Slack posts, later calendar) for THIS
// environment and writes the cron heartbeat that /api/studio/health reports.
import { runPipelineTick, retryShootRow } from "@/lib/pipeline";
import { drainJobs, heartbeat, WEATHER_KINDS } from "@/lib/jobs";
import { BUNDLE_KINDS } from "@/lib/bundle-jobs";
import { MIRROR_KINDS, scheduleFinalSweep, scheduleVideoLinks } from "@/lib/dropbox-mirror";
import { DRIVE_KINDS, scheduleDriveFinalSweep } from "@/lib/drive-mirror";
import { scheduleRawSweep } from "@/lib/r2-raw-cleanup";
import { currentEnv, enqueueJobs } from "@/lib/jobs-core";
import { scheduleShootBriefs } from "@/lib/shoot-brief";
import { scheduleReminders } from "@/lib/booking-time-email";
import { scheduleWeatherRefresh, syncFromCalendar } from "@/lib/google-calendar";
import { hasEmailIntake, pollHello, recordPoll } from "@/lib/email-intake";
import { hasDb } from "@/db";
import { hasCronSecret, hasMigrateToken } from "@/lib/operator-token";
import { sweepVideoStages } from "@/lib/video-board";

// The slice of every run kept for the job queue after the pipeline.
const JOBS_SLICE_MS = 15_000;

export const dynamic = "force-dynamic";
// Allows PIPELINE_STEP_SECONDS to be raised for very large shoots. The lease
// on each shoot keeps overlapping minute runs apart.
export const maxDuration = 300;

// The Dropbox pass (copies, FINAL DELIVERY, raw cleanup, the forecast)
// runs beside the tick with its own budget (Oct 27 2026). It used to get
// the tick's leftovers, which an editing transfer used up, so a 29 GB
// shoot reached Dropbox hours later. Runs overlap from minute to minute,
// so a few files copy at once; with nothing queued it ends at once.
const DROPBOX_PASS_MS = 230_000;

// The zip pass (Nov 10 2026): the "Download all" rebuilds run beside the tick
// too, with a budget of their own. They used to sit in the job drain at the
// end of the tick, with whatever time was left, and nothing told a rebuild
// when the run was about to end: one that started late, or needed longer than
// a run has, was cut off at maxDuration and began again from zero on a later
// run. Now a rebuild reads this pass's deadline, stops 20 seconds before it
// with its place saved, and the next minute's pass carries on from there
// (src/lib/bundles.ts). 240 s leaves a minute under maxDuration.
const BUNDLE_PASS_MS = 240_000;

export async function GET(request: Request) {
  const viaCron = hasCronSecret(request);
  // Vercel runs crons on production only. On previews an operator drives the
  // pipeline by hand with the same token the migrate route uses.
  const viaOperator = hasMigrateToken(request);
  if (!viaCron && !viaOperator) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // Operator-only: ?retry=<shootId> puts a failed shoot back on the belt before this tick.
  const retryId = viaOperator ? new URL(request.url).searchParams.get("retry") : null;
  let retried: unknown = null;
  if (retryId) {
    retried = await retryShootRow(retryId, "operator");
  }
  const seconds = Math.min(280, Math.max(10, Number(process.env.PIPELINE_STEP_SECONDS || 200) || 200));
  const started = Date.now();
  const mirrorPass: Promise<Awaited<ReturnType<typeof drainJobs>> | { error: string }> | null = hasDb()
    ? drainJobs({ kinds: [...WEATHER_KINDS, ...MIRROR_KINDS, ...DRIVE_KINDS], budgetMs: DROPBOX_PASS_MS, limit: 600 }).catch((e) => {
        console.error("[cron/dropbox]", e);
        return { error: e instanceof Error ? e.message : String(e) };
      })
    : null;
  const bundlePass: Promise<Awaited<ReturnType<typeof drainJobs>> | { error: string }> | null = hasDb()
    ? drainJobs({ kinds: BUNDLE_KINDS, budgetMs: BUNDLE_PASS_MS, limit: 50 }).catch((e) => {
        console.error("[cron/zips]", e);
        return { error: e instanceof Error ? e.message : String(e) };
      })
    : null;
  try {
    const budget = seconds * 1000;
    const result = await runPipelineTick(Math.max(10_000, budget - JOBS_SLICE_MS));
    if (retried) (result as Record<string, unknown>).retried = retried;
    let jobs: Awaited<ReturnType<typeof drainJobs>> | { error: string } | null = null;
    let mirror: Awaited<ReturnType<typeof drainJobs>> | { error: string } | null = null;
    let zips: Awaited<ReturnType<typeof drainJobs>> | { error: string } | null = null;
    let calendarPull: Awaited<ReturnType<typeof syncFromCalendar>> | { error: string } | null = null;
    let emailPoll: Awaited<ReturnType<typeof pollHello>> | { error: string } | null = null;
    if (hasDb()) {
      // Step two: the payments.reconcile job (last resort behind the webhooks
      // and the sync hooks) is enqueued at most once per quarter hour; the
      // idempotency key makes every other tick in that window a no-op. The key
      // carries the environment: jobs.idempotency_key is unique across the
      // shared database, so an operator tick on a preview must never take
      // production's slot for that window (or the other way round).
      try {
        await enqueueJobs([{ kind: "payments.reconcile", idempotencyKey: `payments.reconcile:${currentEnv()}:${Math.floor(Date.now() / 900_000)}`, payload: { version: 1 } }]);
      } catch (e) {
        console.error("[cron/reconcile]", e);
      }
      // Google back to Studio: times and shooters changed on the calendar follow onto the booking (src/lib/google-calendar.ts).
      try {
        calendarPull = await syncFromCalendar();
      } catch (e) {
        console.error("[cron/calendar-pull]", e);
        calendarPull = { error: e instanceof Error ? e.message : String(e) };
      }
      // New mail to hello@ into the revision intake (src/lib/email-intake.ts), read only.
      if (hasEmailIntake()) {
        try {
          emailPoll = await pollHello({ budgetMs: 10_000 });
          if (emailPoll.stored || emailPoll.skipped) console.log("[cron/email-intake]", JSON.stringify(emailPoll));
          await recordPoll(null);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[cron/email-intake]", msg);
          emailPoll = { error: msg };
          await recordPoll(msg).catch((err) => console.error("[cron/email-intake] status", err));
        }
      }
      // Delivered finals into Dropbox's FINAL DELIVERY folders, every 10 minutes (src/lib/dropbox-mirror.ts).
      try {
        await scheduleFinalSweep();
      } catch (e) {
        console.error("[cron/dropbox-finals]", e);
      }
      // Delivered finals into Google Drive's FINAL DELIVERY folders, every 10 minutes (src/lib/drive-mirror.ts).
      try {
        await scheduleDriveFinalSweep();
      } catch (e) {
        console.error("[cron/drive-finals]", e);
      }
      // Share links for Video folders that still have none, every 30 minutes (src/lib/dropbox-mirror.ts).
      try {
        await scheduleVideoLinks();
      } catch (e) {
        console.error("[cron/dropbox-video-links]", e);
      }
      // Raws leave R2 once Dropbox's copy is verified, every 15 minutes (src/lib/r2-raw-cleanup.ts).
      try {
        await scheduleRawSweep();
      } catch (e) {
        console.error("[cron/r2-raw-cleanup]", e);
      }
      // The shoot brief: queued 30 minutes ahead of each Unconfirmed or Confirmed shoot (src/lib/shoot-brief.ts).
      try {
        await scheduleShootBriefs();
      } catch (e) {
        console.error("[cron/shoot-brief]", e);
      }
      // The client's reminder before the shoot, off unless business.reminderEmail (src/lib/booking-time-email.ts).
      try {
        await scheduleReminders();
      } catch (e) {
        console.error("[cron/reminder]", e);
      }
      // The forecast on each upcoming booking's calendar event, every 3 hours (src/lib/weather.ts).
      try {
        await scheduleWeatherRefresh();
      } catch (e) {
        console.error("[cron/weather]", e);
      }
      // Video cards: Sent to client → Complete after 3 quiet days, and footage
      // that landed on a queued card → In editing (src/lib/video-board.ts).
      try {
        const swept = await sweepVideoStages();
        if (swept.completed.length || swept.editing.length) console.log("[cron/video-stages]", JSON.stringify(swept));
      } catch (e) {
        console.error("[cron/video-stages]", e);
      }
      try {
        jobs = await drainJobs({ budgetMs: Math.max(5_000, budget - (Date.now() - started)) });
      } catch (e) {
        console.error("[cron/jobs]", e);
        jobs = { error: e instanceof Error ? e.message : String(e) };
      }
      await heartbeat().catch((e) => console.error("[cron/heartbeat]", e));
      // The Dropbox pass started with the tick (DROPBOX_PASS_MS above).
      mirror = await mirrorPass;
      // So did the zip pass (BUNDLE_PASS_MS above).
      zips = await bundlePass;
    }
    return Response.json({ ok: true, ms: Date.now() - started, ...result, jobs, mirror, zips, calendarPull, emailPoll });
  } catch (e) {
    console.error("[cron/pipeline]", e);
    // A failed tick still lets the Dropbox pass finish its copies and the zip pass save its place.
    await mirrorPass;
    await bundlePass;
    return Response.json({ ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
