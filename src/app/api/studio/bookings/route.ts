// Booking intake (docs/booking-to-payment.md). The website's own
// /api/booking route posts here with the shared secret (x-intake-secret =
// BOOKING_INTAKE_SECRET). This route guards and parses, hands the payload to
// intakeBooking (ONE database batch: client, listing, booking, invoice,
// activity, jobs), answers 200 only after that batch has committed, then
// drains this booking's jobs in after(): Stripe invoice, booking email, Slack.
//
// Idempotent: the same submission_id again is a duplicate (200, duplicate:
// true, no side effects); a new id for the same email + street + date inside
// 24 h is a revision. Accepts JSON (the spec) or form fields (the live form's
// shape, so a forwarded Formspree payload works too). 404 until the secret is
// set, so nothing answers on a deployment that has no intake.
//
// Operators (x-migrate-token, the token that guards migrate, health and the
// job drain) may post too, the way the cron route lets them drive the
// pipeline; with x-intake-dry-run: 1 the rows are written but the jobs are
// left queued (no email, no Slack, no Stripe) for a look through
// GET /api/studio/jobs/drain?bookingId=... on a preview.
import { after } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { hasDb } from "@/db";
import { intakeBooking, normalizeBookingPayload } from "@/lib/booking-intake";
import { drainJobs } from "@/lib/jobs";
import { currentEnv } from "@/lib/jobs-core";

export const dynamic = "force-dynamic";
// The after() work (Stripe round trips, Resend, Slack) runs past the response.
export const maxDuration = 120;

function same(given: string, secret: string): boolean {
  return Boolean(secret) && Boolean(given) && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

function authorized(request: Request): "website" | "operator" | null {
  if (same((request.headers.get("x-intake-secret") || "").trim(), (process.env.BOOKING_INTAKE_SECRET || "").trim())) return "website";
  if (same((request.headers.get("x-migrate-token") || "").trim(), (process.env.MIGRATE_TOKEN || "").trim())) return "operator";
  return null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
      const fd = await request.formData();
      const out: Record<string, unknown> = {};
      for (const [k, v] of fd.entries()) {
        if (typeof v !== "string") continue;
        const prev = out[k];
        out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
      }
      return out;
    }
    const parsed: unknown = JSON.parse(await request.text());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const who = authorized(request);
  if (!who) return Response.json({ ok: false }, { status: 404 });
  const dryRun = who === "operator" && request.headers.get("x-intake-dry-run") === "1";
  if (!hasDb()) return Response.json({ ok: false, error: "no database" }, { status: 503 });
  const body = await readBody(request);
  if (!body) return Response.json({ ok: false, error: "send JSON or form fields" }, { status: 400 });
  const norm = normalizeBookingPayload(body);
  if (!norm.ok) return Response.json({ ok: false, error: norm.error }, { status: 400 });
  try {
    const r = await intakeBooking(norm.p);
    if (r.kind !== "duplicate" && !dryRun) {
      after(async () => {
        try {
          await drainJobs({ budgetMs: 60_000, bookingId: r.bookingId });
        } catch (e) {
          console.error("[bookings] drain:", e);
        }
      });
    }
    return Response.json({ ok: true, duplicate: r.kind === "duplicate", revision: r.kind === "revised", ...r, env: currentEnv(), via: who, dryRun });
  } catch (e) {
    console.error("[bookings] intake:", e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
