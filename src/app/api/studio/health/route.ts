// Which integrations this deployment can see. Booleans only, never values.
// Guarded by MIGRATE_TOKEN so it's not a public fingerprint.
import { hasCalendarSync } from "@/lib/google-calendar";
import { emailIntakeStatus, hasEmailIntake } from "@/lib/email-intake";
import { hasR2 } from "@/lib/r2";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { probeEditing } from "@/lib/autohdr";
import { hasQc, qcMaxFrames, qcModel, qcWorkspaceId } from "@/lib/qc";
import { hasDb } from "@/db";
import { hasStripe } from "@/lib/stripe-invoice";
import { jobCounts, lastCronAt } from "@/lib/jobs";
import { currentEnv } from "@/lib/jobs-core";
import { hasSlackBookings, hasSlackPayments, hasSlackPhotoEditing, hasSlackPhotoReview, hasSlackVideoEditing } from "@/lib/slack";
import { hasTitus } from "@/lib/titus";
import { hasMigrateToken } from "@/lib/operator-token";
import { dropboxMirrorEnabled, dropboxRoot, hasDropboxApp, isDropboxConnected } from "@/lib/dropbox";
import { siteUrl } from "@/lib/brand";

const envSet = (k: string): boolean => Boolean((process.env[k] || "").trim());

// Env values as pasted into Vercel sometimes carry a trailing space or newline.
const r2env = (k: string): string => (process.env[k] || "").trim();

// Simulates the browser's CORS preflight for a direct upload from `origin`.
async function corsProbe(origin: string) {
  const acct = r2env("R2_ACCOUNT_ID");
  const bucket = r2env("R2_BUCKET");
  if (!acct || !bucket) return { origin, checked: false };
  try {
    const r = await fetch(`https://${acct}.r2.cloudflarestorage.com/${bucket}/cors-probe.txt`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
      cache: "no-store",
    });
    const allowOrigin = r.headers.get("access-control-allow-origin");
    const allowMethods = r.headers.get("access-control-allow-methods");
    return { origin, checked: true, status: r.status, allowOrigin, allowMethods, ok: Boolean(allowOrigin) };
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    return { origin, checked: true, error: e instanceof Error ? e.message : String(e), cause: cause?.code || cause?.message || null };
  }
}

// Proves the account id + keys reach the bucket, independent of CORS.
async function storageProbe() {
  const acct = r2env("R2_ACCOUNT_ID") || "";
  const bucket = r2env("R2_BUCKET") || "";
  const accountIdLooksValid = /^[0-9a-f]{32}$/.test(acct);
  const ak = r2env("R2_ACCESS_KEY_ID");
  const sk = r2env("R2_SECRET_ACCESS_KEY");
  // R2 keys are hex: access key id 32 chars, secret 64 chars. Lengths and
  // the presence of odd characters are safe to report; the values are not.
  const keyShape = {
    accessKeyLength: ak.length,
    accessKeyLooksValid: /^[0-9a-f]{32}$/.test(ak),
    accessKeyHasOddChars: /[^0-9a-zA-Z]/.test(ak),
    secretLength: sk.length,
    secretLooksValid: /^[0-9a-f]{64}$/.test(sk),
    secretHasOddChars: /[^0-9a-zA-Z]/.test(sk),
  };
  if (!hasR2()) return { configured: false, accountIdLooksValid, keyShape };
  try {
    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${acct}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: r2env("R2_ACCESS_KEY_ID"), secretAccessKey: r2env("R2_SECRET_ACCESS_KEY") },
    });
    await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    return { configured: true, accountIdLooksValid, keyShape, bucketReachable: true };
  } catch (e) {
    const err = e as { name?: string; message?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    return { configured: true, accountIdLooksValid, keyShape, bucketReachable: false, error: err.Code || err.name || "error", message: (err.message || "").slice(0, 160), code: (err as { code?: string }).code ?? null, status: err.$metadata?.httpStatusCode ?? null };
  }
}

export async function GET(request: Request) {
  if (!hasMigrateToken(request)) {
    return Response.json({ ok: false }, { status: 404 });
  }
  const here = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : siteUrl();
  const cors = hasR2()
    ? await Promise.all([corsProbe(siteUrl()), corsProbe(here)])
    : [];
  const storageCheck = await storageProbe();
  const editingCheck = await probeEditing();
  // Booking intake (step one): the job queue for THIS environment and the cron heartbeat.
  let jobs: Record<string, number> | null = null;
  let cronAt: string | null = null;
  let jobsError: string | null = null;
  let dropboxConnected = false;
  let emailIntakeLast: Awaited<ReturnType<typeof emailIntakeStatus>> | null = null;
  if (hasDb()) {
    try {
      jobs = await jobCounts();
      cronAt = await lastCronAt();
    } catch (e) {
      jobsError = e instanceof Error ? e.message : String(e); // before migrate ran: tables missing
    }
    try {
      dropboxConnected = await isDropboxConnected();
    } catch {
      dropboxConnected = false;
    }
    if (hasEmailIntake()) emailIntakeLast = await emailIntakeStatus().catch(() => null);
  }
  return Response.json({
    // step one: booking intake, payments, side effects. Booleans and counts only.
    intake: envSet("BOOKING_INTAKE_SECRET"),
    stripe: hasStripe(),
    stripeLive: (process.env.STRIPE_SECRET_KEY || "").trim().startsWith("sk_live_"),
    stripeWebhook: envSet("STRIPE_WEBHOOK_SECRET"),
    titus: hasTitus(),
    // step two: the Titus webhook answers 503 until its secret is set; the
    // payments channel is the private #payments webhook (amounts allowed).
    titusWebhook: envSet("TITUS_WEBHOOK_SECRET"),
    titusStaging: envSet("NEXT_PUBLIC_TITUS_WEB_BASE_URL"),
    slackPayments: hasSlackPayments(),
    // #bookings: one card per booking and the lifecycle lines (money-free).
    slackBookings: hasSlackBookings(),
    // #photo-editing: a copy of every PHOTO revision request, tagging Dellon.
    slackPhotoEditing: hasSlackPhotoEditing(),
    // #video-editing: a shoot's raw video is all in Dropbox, tagging the video editor.
    slackVideoEditing: hasSlackVideoEditing(),
    // The PMs' final review channel (Nov 3 2026): Send for final review, tagging the four. false = the hub gets it.
    slackPhotoReview: hasSlackPhotoReview(),
    calendar: envSet("GOOGLE_SA_CLIENT_EMAIL") && envSet("GOOGLE_SA_PRIVATE_KEY"),
    // Bookings are written to hello@'s calendar here (production, or GOOGLE_CALENDAR_SYNC=on).
    calendarSync: hasCalendarSync(),
    defaultShooter: envSet("DEFAULT_SHOOTER_EMAIL"),
    // Oct 27 2026: hello@'s mail read into the revision intake (production, or EMAIL_INTAKE=on), and the last poll.
    emailIntake: hasEmailIntake(),
    emailIntakeOk: emailIntakeLast?.ok ?? null,
    emailIntakeError: emailIntakeLast?.error ?? null,
    emailIntakeAt: emailIntakeLast?.at ?? null,
    jobsEnv: currentEnv(),
    jobs,
    jobsError,
    lastCronAt: cronAt,
    cronStale: cronAt ? Date.now() - Date.parse(cronAt) > 10 * 60_000 : null,
    storageCheck,
    editingCheck,
    cors,
    ok: true,
    env: process.env.VERCEL_ENV || "local",
    deployment: process.env.VERCEL_DEPLOYMENT_ID || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    database: Boolean(process.env.DATABASE_URL),
    storage: hasR2(),
    email: Boolean(process.env.RESEND_API_KEY),
    slack: Boolean(process.env.SLACK_WEBHOOK_URL),
    editing: Boolean(process.env.AUTOHDR_CLIENT_ID && process.env.AUTOHDR_CLIENT_SECRET),
    // Oct 21 2026: dropbox = an admin connected the business's Dropbox on Settings
    // (refresh token stored); dropboxApp = key + secret present; dropboxMirror
    // = mirror jobs are made and run here; dropboxChooser = the app key alone
    // (the client Saver and the admin Chooser). Never a token.
    dropbox: dropboxConnected,
    dropboxApp: hasDropboxApp(),
    dropboxMirror: dropboxMirrorEnabled(),
    dropboxRoot: dropboxRoot(),
    dropboxChooser: Boolean(process.env.NEXT_PUBLIC_DROPBOX_APP_KEY),
    cron: Boolean(process.env.CRON_SECRET),
    // v1.2 automatic QC: key present, which model, frame budget. Never the key.
    qc: hasQc(),
    qcModel: hasQc() ? qcModel() : null,
    qcMaxFrames: qcMaxFrames(),
    qcWorkspace: Boolean(qcWorkspaceId()),
  });
}
