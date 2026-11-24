"use server";
// Admin mutations. Every action re-checks the admin gate: never trust the UI.
// Each one writes an activity row so the dashboard can say who did what.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { InvoiceLineItem, InvoiceStatus, JobKind, QcState, RevisionStatus } from "@/db/schema";
import { assertAdmin, requireAdmin, requireStaff } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { adminClients, listingsForClientLite } from "@/lib/admin-data";
import { bookingExtra, fmtDollars, quote } from "@/lib/studio-pricing";
import { fmtWhen as fmtBookingWhen, wallClockToUtc, toHm, toYmd } from "@/lib/booking-time";
import { BOOKING_STATUS_LABEL, RESTORE_TO, isBookingStatus, isTimeConfirmed } from "@/lib/booking-status";
import { drainJobs } from "@/lib/jobs";
import { currentEnv, enqueueJobs, jobKey, type JobSpec } from "@/lib/jobs-core";
import { closeProviderObject, isOtherEnv, isPaid, isPayable, markPaidManually, payLineFor, rowEnv, transitionInvoice } from "@/lib/payments";
import { isPaidAnotherWay, payOtherPhrase } from "@/lib/pay-other";
import { advanceShoot, requeueQcRow, retryShootRow } from "@/lib/pipeline";
import { approveAllSkips } from "@/lib/qc-labels";
import { shooterInviteSpec, type InviteMethod } from "@/lib/shooter-invite";
import { timeConfirmedSpec, timeEmailVariant, type TimeEmailVariant } from "@/lib/booking-time-email";
import { hasCalendarSync } from "@/lib/google-calendar";
import { cancelVisitsForBooking } from "@/lib/booking-visits";
import { voidVisitInvoicesForCanceledVisits } from "@/lib/visit-invoice";
import { hubTextBookingCanceled, hubTextTimeConfirmed, paymentsText } from "@/lib/slack";
import { DEMO_CLIENTS } from "@/lib/demo-data";
import { ensureCoverDerivative } from "@/lib/derivatives";
import { enqueueBundleRebuild } from "@/lib/bundle-jobs";
import { linkVideoRevision } from "@/lib/video-board";

const slugify = (s: string) =>
  s.split(",")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Full admins only. Everything in this file uses it unless it is marked as
// open to the QA team (whoStaff): the cover, frame QC, Publish, Run now, Run
// QC again. The QA team never reaches clients, listings' creation, the lock,
// the delivery email, revisions or anything under Bookings.
async function who(): Promise<string> {
  return requireAdmin();
}

// Admins and the QA team (src/lib/admin.ts).
async function whoStaff(): Promise<string> {
  return (await requireStaff()).email;
}

// ---- Clients -------------------------------------------------------------

export async function createClient(formData: FormData) {
  const actor = await who();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  if (!email) return;
  if (!hasDb()) {
    redirect("/admin/clients?created=demo");
  }
  const r = await db()
    .insert(schema.clients)
    .values({
      email,
      name: String(formData.get("name") || "").trim() || null,
      company: String(formData.get("company") || "").trim() || null,
      phone: String(formData.get("phone") || "").trim() || null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.clients.id });
  if (r[0]) await logActivity({ actorEmail: actor, action: "client.created", clientId: r[0].id, meta: { email } });
  revalidatePath("/admin/clients");
  redirect(`/admin/clients?q=${encodeURIComponent(email)}`);
}

export type LiteClient = { id: string; email: string; name: string | null; company: string | null };

// Wizard: find clients by name, email or company.
export async function searchClients(q: string): Promise<LiteClient[]> {
  await assertAdmin();
  const rows = await adminClients(q);
  return rows.slice(0, 12).map((c) => ({ id: c.id, email: c.email, name: c.name, company: c.company }));
}

// Wizard: create (or reuse) a client inline.
export async function createClientInline(input: { email: string; name?: string; company?: string }): Promise<{ ok: true; client: LiteClient } | { ok: false; error: string }> {
  const actor = await who();
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "That email does not look right." };
  const name = input.name?.trim() || null;
  const company = input.company?.trim() || null;
  if (!hasDb()) {
    const existing = DEMO_CLIENTS.find((c) => c.email === email);
    return { ok: true, client: existing ? { id: existing.id, email, name: existing.name, company: existing.company } : { id: `demo-new-${Date.now()}`, email, name, company } };
  }
  const d = db();
  const existing = await d.query.clients.findFirst({ where: eq(schema.clients.email, email) });
  if (existing) {
    if ((!existing.name && name) || (!existing.company && company)) {
      await d.update(schema.clients).set({ name: existing.name ?? name, company: existing.company ?? company }).where(eq(schema.clients.id, existing.id));
      await logActivity({ actorEmail: actor, action: "client.updated", clientId: existing.id });
    }
    return { ok: true, client: { id: existing.id, email, name: existing.name ?? name, company: existing.company ?? company } };
  }
  const [row] = await d.insert(schema.clients).values({ email, name, company }).returning();
  await logActivity({ actorEmail: actor, action: "client.created", clientId: row.id, meta: { email } });
  return { ok: true, client: { id: row.id, email, name, company } };
}

// ---- Listings ------------------------------------------------------------

export type LiteListing = { id: string; address: string; slug: string; shootDate: string | null; nda: boolean };

export async function listingsForClient(clientId: string): Promise<LiteListing[]> {
  await assertAdmin();
  return listingsForClientLite(clientId);
}

// New listings are born LOCKED with a slug from the street line, like the
// booking intake. The slug gets a numeric suffix if it is already taken.
async function uniqueSlug(base: string): Promise<string> {
  const d = db();
  let slug = base || "listing";
  for (let i = 2; i < 50; i++) {
    const hit = await d.query.listings.findFirst({ where: eq(schema.listings.slug, slug), columns: { id: true } });
    if (!hit) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

export async function createListingInline(input: { clientId: string; address: string; city?: string; shootDate?: string; nda?: boolean }): Promise<{ ok: true; listing: LiteListing } | { ok: false; error: string }> {
  const actor = await who();
  const street = input.address.trim();
  if (street.length < 4) return { ok: false, error: "Enter the street address." };
  const city = input.city?.trim();
  const address = city && !street.toLowerCase().includes(city.toLowerCase()) ? `${street}, ${city}` : street;
  const shootDate = input.shootDate ? new Date(`${input.shootDate}T12:00:00`) : null;
  if (!hasDb()) {
    return { ok: true, listing: { id: `demo-new-l-${Date.now()}`, address, slug: slugify(address), shootDate: input.shootDate || null, nda: Boolean(input.nda) } };
  }
  const slug = await uniqueSlug(slugify(address));
  const [row] = await db()
    .insert(schema.listings)
    .values({ clientId: input.clientId, address, slug, shootDate, downloadLocked: true, nda: Boolean(input.nda) })
    .returning();
  await logActivity({ actorEmail: actor, action: "listing.created", listingId: row.id, clientId: input.clientId, meta: { address: row.nda ? "NDA listing" : address } });
  revalidatePath("/admin/listings");
  return { ok: true, listing: { id: row.id, address: row.address, slug: row.slug, shootDate: input.shootDate || null, nda: row.nda } };
}

export async function createListing(formData: FormData) {
  const clientId = String(formData.get("clientId") || "");
  const address = String(formData.get("address") || "").trim();
  if (!clientId || !address) return;
  const r = await createListingInline({
    clientId,
    address,
    city: String(formData.get("city") || ""),
    shootDate: String(formData.get("shootDate") || ""),
    nda: formData.get("nda") === "on",
  });
  if (r.ok && hasDb()) redirect(`/admin/listings/${r.listing.id}`);
  redirect("/admin/listings");
}

// Admins and the QA team. The key must be one of this listing's own files.
export async function setCover(listingId: string, coverKey: string) {
  const actor = await whoStaff();
  if (!hasDb()) return;
  const own = await db().query.media.findFirst({ where: and(eq(schema.media.listingId, listingId), eq(schema.media.r2Key, String(coverKey))), columns: { id: true } });
  if (!own) throw new Error("That file is not on this listing.");
  await db().update(schema.listings).set({ coverKey }).where(eq(schema.listings.id, listingId));
  await logActivity({ actorEmail: actor, action: "listing.cover", listingId, meta: { coverKey } });
  // The client's hero shows the cover at full size (3200px, clean and
  // watermarked): build both now so the first view is already sharp.
  after(() => ensureCoverDerivative(coverKey, false).then(() => undefined).catch((e) => console.error("[setCover] cover derivative", e)));
  revalidatePath(`/admin/listings/${listingId}`);
  revalidatePath("/portal");
}

export async function setLock(listingId: string, locked: boolean) {
  const actor = await who();
  if (!hasDb()) return;
  await db().update(schema.listings).set({ downloadLocked: locked }).where(eq(schema.listings.id, listingId));
  await logActivity({ actorEmail: actor, action: locked ? "listing.locked" : "listing.unlocked", listingId });
  revalidatePath("/admin/listings");
  revalidatePath(`/admin/listings/${listingId}`);
  revalidatePath("/portal");
}

// Send the business "your gallery is ready" delivery email to the listing's
// client. Explicit admin action ONLY: never fired automatically by uploads,
// so backfills can never mass-email clients. Re-sending is allowed (the
// button shows when it was last sent).
export async function sendDeliveryEmail(listingId: string, formData?: FormData) {
  const actor = await who();
  if (!hasDb()) return;
  const extraCc = String(formData?.get("cc") ?? "")
    .split(/[,\s;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  // Never throw: a thrown server action renders Next's opaque 500 page.
  // Outcome (success or the exact error) is surfaced via ?email= on redirect.
  let outcome: string;
  try {
    const { Resend } = await import("resend");
    const { buildDeliveryEmail } = await import("@/lib/delivery-send");
    const { emailFrom, supportEmail } = await import("@/lib/brand");
    const built = await buildDeliveryEmail(listingId, {
      subject: String(formData?.get("subject") ?? ""),
      headline: String(formData?.get("headline") ?? ""),
      body: String(formData?.get("body") ?? ""),
    });
    if (!built.ok) {
      outcome = `error:${built.error}`;
    } else {
      const resend = new Resend(process.env.RESEND_API_KEY);
      // Team CCs (the boxes ticked on the preview page): only people who are
      // really on the booker's team are accepted, whatever the form says.
      const onTeam = new Set((built.team?.members ?? []).map((m) => m.email));
      const teamCc = (formData?.getAll("teamCc") ?? []).map((v) => String(v).trim().toLowerCase()).filter((e) => onTeam.has(e));
      const cc = [...new Set([...built.cc, ...teamCc, ...extraCc])].filter((e) => e !== built.to.toLowerCase());
      const r = await resend.emails.send({
        from: emailFrom(),
        replyTo: supportEmail(),
        to: built.to,
        ...(cc.length ? { cc } : {}),
        subject: built.subject,
        html: built.html,
      });
      if (r.error) {
        outcome = `error:Resend rejected the email: ${r.error.message}`;
      } else {
        await db().update(schema.listings).set({ deliveryEmailAt: new Date() }).where(eq(schema.listings.id, listingId));
        await logActivity({ actorEmail: actor, action: "listing.delivery_email", listingId, meta: { to: built.to, cc } });
        // Nov 5 2026: delivered with a film live = the Video card is Sent to client.
        try {
          const { videoCardsDelivered } = await import("@/lib/video-board");
          await videoCardsDelivered(listingId, actor);
        } catch (e) {
          console.error("[delivery] video card", e);
        }
        // ...and the same in Google Drive when the business is on Drive (src/lib/drive-mirror.ts).
        try {
          const { driveMirrorEnabled } = await import("@/lib/google-drive");
          if (driveMirrorEnabled()) {
            const { enqueueDriveFinalSweep } = await import("@/lib/drive-mirror");
            await enqueueDriveFinalSweep({ listingId });
          }
        } catch (e) {
          console.error("[delivery] Drive FINAL DELIVERY sweep", e);
        }
        // What was delivered goes to the listing's FINAL DELIVERY folder in Dropbox (src/lib/dropbox-mirror.ts).
        try {
          const { dropboxMirrorEnabled } = await import("@/lib/dropbox");
          if (dropboxMirrorEnabled()) {
            const { enqueueFinalSweep } = await import("@/lib/dropbox-mirror");
            await enqueueFinalSweep({ listingId });
          }
        } catch (e) {
          console.error("[delivery] FINAL DELIVERY sweep", e);
        }
        outcome = `sent:${built.to}`;
      }
    }
  } catch (e) {
    outcome = `error:${e instanceof Error ? e.message : String(e)}`;
  }
  revalidatePath(`/admin/listings/${listingId}`);
  redirect(`/admin/listings/${listingId}?email=${encodeURIComponent(outcome)}`);
}

// ---- Revisions -----------------------------------------------------------

// Admins and the Photo QC team (Oct 26 2026).
export async function setRevisionStatus(id: string, status: RevisionStatus, returnTo = "/admin/revisions") {
  const actor = await whoStaff();
  if (hasDb()) {
    const [row] = await db()
      .update(schema.revisionRequests)
      .set({ status, resolvedAt: status === "done" ? new Date() : null, resolvedBy: status === "done" ? actor : null })
      .where(eq(schema.revisionRequests.id, id))
      .returning({ listingId: schema.revisionRequests.listingId });
    if (row) await logActivity({ actorEmail: actor, action: "revision.status", listingId: row.listingId, meta: { status, revisionId: id } });
  }
  revalidatePath("/admin/revisions");
  revalidatePath("/admin");
  redirect(returnTo);
}

// The shoot page's "Mark revision done" (Oct 30 2026): every open request
// behind the shoot's revision round (src/lib/revision-frames.ts) at once.
// Admins and the Photo QC team, like the status buttons on /admin/revisions.
export async function markRevisionsDone(ids: string[], returnTo: string) {
  const actor = await whoStaff();
  const clean = (Array.isArray(ids) ? ids : []).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20);
  if (hasDb() && clean.length) {
    const rows = await db()
      .update(schema.revisionRequests)
      .set({ status: "done", resolvedAt: new Date(), resolvedBy: actor })
      .where(and(inArray(schema.revisionRequests.id, clean), ne(schema.revisionRequests.status, "done")))
      .returning({ id: schema.revisionRequests.id, listingId: schema.revisionRequests.listingId });
    for (const r of rows) await logActivity({ actorEmail: actor, action: "revision.status", listingId: r.listingId, meta: { status: "done", revisionId: r.id } });
  }
  revalidatePath("/admin/revisions");
  revalidatePath("/admin/photo-qc");
  revalidatePath("/admin");
  redirect(returnTo.startsWith("/admin/") ? returnTo : "/admin/revisions");
}

// Retag a revision PHOTO or VIDEO (Oct 26 2026), for a text the intake read
// the wrong way. Tagged video, it joins the listing's Video card.
export async function setRevisionKind(id: string, kind: "photo" | "video", returnTo = "/admin/revisions") {
  const actor = await whoStaff();
  if (hasDb()) {
    const [row] = await db()
      .update(schema.revisionRequests)
      .set({ mediaKind: kind })
      .where(eq(schema.revisionRequests.id, id))
      .returning({ listingId: schema.revisionRequests.listingId });
    if (row) {
      await logActivity({ actorEmail: actor, action: "revision.kind", listingId: row.listingId, meta: { to: kind, revisionId: id } });
      if (kind === "video") await linkVideoRevision({ listingId: row.listingId, requestId: id, by: actor }).catch((e) => console.error("[revision kind] card", e));
    }
  }
  revalidatePath("/admin/revisions");
  revalidatePath("/admin/video");
  redirect(returnTo);
}

// A revision text the intake could not place: dismissed once someone has
// handled it by hand (filed it from the listing, or it was not a revision).
export async function dismissUnplacedText(id: string) {
  const actor = await who();
  if (hasDb()) {
    await db()
      .update(schema.inboundMessages)
      .set({ status: "ignored", processedAt: new Date(), result: { reason: `dismissed by ${actor}` } })
      .where(and(eq(schema.inboundMessages.id, id), eq(schema.inboundMessages.status, "needs_review")));
  }
  revalidatePath("/admin/revisions");
  redirect("/admin/revisions");
}

// ---- Shoots: QC and publish ----------------------------------------------

// A QC call can put a published frame in or out of the client's gallery, so
// the "Download all" zips follow it.
async function rebuildZipsForShoot(shootId: string): Promise<void> {
  try {
    const shoot = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { listingId: true } });
    if (shoot) await enqueueBundleRebuild(shoot.listingId);
  } catch (e) {
    console.error("[qc] bundle rebuild:", e instanceof Error ? e.message : e);
  }
}

// Approve or reject frames. The grid is optimistic, so this never revalidates
// the shoot page: a refresh here replayed the page cross-fade over the opened
// photo, which looked like the photo closing and reopening on every R or A
// (Nov 2 2026). Rejecting also takes a photo off the listing: a
// rejected photo is never client visible, whatever it was before.
export async function setFrameQc(shootId: string, mediaIds: string[], state: QcState): Promise<{ ok: boolean; unpublished: number }> {
  const actor = await whoStaff();
  if (!hasDb() || !mediaIds.length) return { ok: true, unpublished: 0 };
  const d = db();
  const mine = and(eq(schema.media.shootId, shootId), inArray(schema.media.id, mediaIds));
  const wasLive = state === "rejected" ? await d.query.media.findMany({ where: and(mine, eq(schema.media.published, true)), columns: { id: true } }) : [];
  await d.update(schema.media).set(state === "rejected" ? { qcState: state, published: false } : { qcState: state }).where(mine);
  await logActivity({ actorEmail: actor, action: "media.qc", shootId, meta: { count: mediaIds.length, state, ...(wasLive.length ? { unpublished: wasLive.length } : {}) } });
  await rebuildZipsForShoot(shootId);
  if (wasLive.length) {
    // The client's gallery changed: refresh it and the listing page.
    const shoot = await d.query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { listingId: true } });
    if (shoot) revalidatePath(`/admin/listings/${shoot.listingId}`);
    revalidatePath("/portal");
  }
  return { ok: true, unpublished: wasLive.length };
}

// Nov 3 2026: QC no longer rejects a photo with a block flag (it stays
// unreviewed and Internal only), so Approve all leaves those for a person
// (approveAllSkips in src/lib/qc-labels.ts), as it did when QC rejected them.
export async function approveAllFrames(shootId: string) {
  const actor = await whoStaff();
  if (!hasDb()) return;
  const d = db();
  const pending = await d.query.media.findMany({ where: and(eq(schema.media.shootId, shootId), eq(schema.media.qcState, "pending")), columns: { id: true, qcState: true, qcIssues: true } });
  const ids = pending.filter((m) => !approveAllSkips(m)).map((m) => m.id);
  const r = ids.length ? await d.update(schema.media).set({ qcState: "approved" }).where(and(eq(schema.media.shootId, shootId), eq(schema.media.qcState, "pending"), inArray(schema.media.id, ids))).returning({ id: schema.media.id }) : [];
  await logActivity({ actorEmail: actor, action: "media.qc", shootId, meta: { count: r.length, state: "approved", ...(pending.length > ids.length ? { leftForReview: pending.length - ids.length } : {}) } });
  if (r.length) await rebuildZipsForShoot(shootId);
}

// Publishing lives in src/lib/frame-publish.ts (publishShootFrames): only
// approved frames go, and the grid says how many. The all-at-once Publish
// that approved every unreviewed frame on the way out was removed Nov 2 2026
// (the owner: "ONLY approved photos should be published").

// Work budget for the immediate pipeline push behind an admin action. The
// response returns at once; the work runs in after() on the same invocation.
const PUSH_MS = 50_000;

export async function retryShoot(shootId: string) {
  const actor = await who();
  if (!hasDb()) redirect(`/admin/shoots/${shootId}?retried=demo`);
  const r = await retryShootRow(shootId, actor);
  if (r.ok) after(() => advanceShoot(shootId, PUSH_MS).catch((e) => console.error("[retryShoot] advance", e)));
  revalidatePath(`/admin/shoots/${shootId}`);
  revalidatePath("/admin");
  redirect(`/admin/shoots/${shootId}${r.ok ? "" : `?error=${encodeURIComponent(r.error)}`}`);
}

// "Run now": push an active shoot forward without waiting for the scheduler.
// The lease makes this safe next to the cron; if the cron holds it, nothing happens.
export async function runShootNow(shootId: string) {
  const actor = await whoStaff();
  if (!hasDb()) redirect(`/admin/shoots/${shootId}?ran=demo`);
  const shoot = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { id: true, status: true, listingId: true } });
  if (!shoot) redirect("/admin/shoots");
  await logActivity({ actorEmail: actor, action: "shoot.run_now", shootId, listingId: shoot.listingId, meta: { from: shoot.status } });
  after(() => advanceShoot(shootId, PUSH_MS).catch((e) => console.error("[runShootNow] advance", e)));
  revalidatePath(`/admin/shoots/${shootId}`);
  redirect(`/admin/shoots/${shootId}?ran=1`);
}

// "Run QC again": clear the automatic QC results and run the pass once more.
export async function rerunQc(shootId: string) {
  const actor = await whoStaff();
  if (!hasDb()) redirect(`/admin/shoots/${shootId}?qc=demo`);
  const r = await requeueQcRow(shootId, actor);
  if (r.ok) after(() => advanceShoot(shootId, PUSH_MS).catch((e) => console.error("[rerunQc] advance", e)));
  revalidatePath(`/admin/shoots/${shootId}`);
  revalidatePath("/admin");
  redirect(`/admin/shoots/${shootId}${r.ok ? "?qc=1" : `?error=${encodeURIComponent(r.error)}`}`);
}

// Frames still pending on a listing that has no active shoot (edge case): approve them.
export async function approvePendingForListing(listingId: string) {
  const actor = await whoStaff();
  if (!hasDb()) return;
  const r = await db().update(schema.media).set({ qcState: "approved" }).where(and(eq(schema.media.listingId, listingId), eq(schema.media.qcState, "pending"), isNull(schema.media.shootId))).returning({ id: schema.media.id });
  await logActivity({ actorEmail: actor, action: "media.qc", listingId, meta: { count: r.length, state: "approved" } });
  if (r.length) {
    try {
      await enqueueBundleRebuild(listingId);
    } catch (e) {
      console.error("[qc] bundle rebuild:", e instanceof Error ? e.message : e);
    }
  }
  revalidatePath(`/admin/listings/${listingId}`);
}

// ---- Bookings (step two, docs/booking-to-payment.md) ------------
// Every action re-checks the admin gate, writes an activity row with the
// actor, never throws (the outcome rides back on ?done= / ?error=, a thrown
// server action renders Next's opaque 500 page) and drains the booking's jobs
// in after() so a preview (no cron) sees the side effect at once.
//
// The lock rule stays: nothing here unlocks a listing except markPaid, which
// goes through payments.markPaidManually (the same CTE a webhook uses), and
// setLock above. Cancel voids the invoice and never touches download_locked.
//
// One database, two environments: every action acts only on rows of THIS
// environment (production also owns rows written before env existed), so a
// preview can never void a production invoice, cancel a production checkout
// or queue a job production never runs. The detail page applies the same rule
// (adminBooking) and runJob checks the job's own env.

type Outcome = { ok: true; message: string } | { ok: false; error: string };
const done = (message: string): Outcome => ({ ok: true, message });
const fail = (error: string): Outcome => ({ ok: false, error });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const otherEnv = (env: string | null | undefined): string | null => (isOtherEnv(env) ? `This booking belongs to the ${rowEnv(env)} environment and is handled there.` : null);
const providerName = (provider: string | null | undefined) => (provider === "titus" ? "Titus" : "Stripe");
// Side effects Cancel retires: the emails, the hub line and the provider
// object of a booking that is off never go out after the fact.
const CANCEL_RETIRES: JobKind[] = ["email.booking", "email.pay_link", "slack.booking", "stripe.invoice.create", "titus.checkout.create"];

// `back` (the bookings list with its filter and search, from the list's
// status select) brings the admin back where they were; anything that is not
// the bookings list is ignored, so the field can never redirect elsewhere.
function finishBooking(bookingId: string | null, r: Outcome, back?: string | null): never {
  revalidatePath("/admin/bookings");
  revalidatePath("/admin");
  if (bookingId) revalidatePath(`/admin/bookings/${bookingId}`);
  const key = r.ok ? "done" : "error";
  const text = r.ok ? r.message : r.error;
  const list = listBack(back);
  if (list) {
    list.searchParams.set(key, text);
    redirect(`${list.pathname}${list.search}`);
  }
  const q = `${key}=${encodeURIComponent(text)}`;
  redirect(bookingId ? `/admin/bookings/${bookingId}?${q}` : `/admin/bookings?${q}`);
}

function listBack(back: string | null | undefined): URL | null {
  const raw = String(back ?? "").trim();
  if (!raw.startsWith("/admin/bookings")) return null;
  try {
    const u = new URL(raw, "https://studio.invalid");
    if (u.origin !== "https://studio.invalid" || u.pathname !== "/admin/bookings") return null;
    u.searchParams.delete("done");
    u.searchParams.delete("error");
    return u;
  } catch {
    return null;
  }
}

// The response returns at once; the booking's due jobs run in after() on the
// same invocation (the pattern the intake route and the webhooks use).
function drainLater(scope: { bookingId?: string | null; invoiceId?: string | null }) {
  after(() => drainJobs({ budgetMs: 40_000, ...scope }).catch((e) => console.error("[admin/bookings] drain", e)));
}

const listingName = (b: { listing?: { address: string; nda: boolean } | null; property: Record<string, unknown> | null }) => ({
  address: b.listing?.address ?? String(b.property?.street ?? "a listing"),
  nda: b.listing?.nda ?? false,
});

// ---- The shooter's calendar invite (src/lib/shooter-invite.ts) ----------
// The invite jobs run right here, inside the action (a short budget, then the
// rest moves to after()), so the banner can say "Invite sent to ..." instead
// of guessing. Anything slower stays queued and the drain or the cron sends it.

type InviteResult = { email: string; method: InviteMethod; state: "sent" | "queued" | "waiting" | "skipped" | "google"; note: string | null };

const INVITE_WAIT_MS = 9_000;

async function sendInvitesNow(bookingId: string, specs: JobSpec[]): Promise<InviteResult[]> {
  if (!specs.length) return [];
  // One invite path: with the booking calendar on, the shooter is the
  // event's guest and Google emails them (the calendar.upsert job queued with
  // the change), so no .ics email is queued at all.
  if (hasCalendarSync()) return specs.map((s) => ({ email: String(s.payload?.email ?? ""), method: (s.payload?.method ?? "REQUEST") as InviteMethod, state: "google" as const, note: null }));
  await enqueueJobs(specs);
  const run = drainJobs({ bookingId, kinds: ["email.shooter_invite"], budgetMs: 20_000, limit: 6 }).catch((e) => {
    console.error("[admin/bookings] invite drain", e);
    return null;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = await Promise.race([run.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), INVITE_WAIT_MS)))]);
  if (timer) clearTimeout(timer);
  if (late) after(() => run);
  const rows = await db().query.jobs.findMany({
    where: inArray(schema.jobs.idempotencyKey, specs.map((s) => s.idempotencyKey)),
    columns: { idempotencyKey: true, status: true, lastError: true },
  });
  return specs.map((s) => {
    const row = rows.find((r) => r.idempotencyKey === s.idempotencyKey);
    const base = { email: s.payload?.email ?? "", method: (s.payload?.method ?? "REQUEST") as InviteMethod };
    if (!row) return { ...base, state: "queued", note: null };
    if (row.status === "done") {
      return row.lastError?.startsWith("skipped") ? { ...base, state: "skipped", note: row.lastError.replace(/^skipped:\s*/, "") } : { ...base, state: "sent", note: null };
    }
    if (row.status === "queued" && /not configured/.test(row.lastError ?? "")) return { ...base, state: "waiting", note: row.lastError };
    return { ...base, state: "queued", note: row.lastError };
  });
}

function inviteNote(results: InviteResult[]): string {
  const parts = results.map((r) => {
    const cancel = r.method === "CANCEL";
    switch (r.state) {
      case "sent":
        return cancel ? `Calendar cancel sent to ${r.email}.` : `Invite sent to ${r.email}.`;
      case "google":
        return cancel ? `Google Calendar takes ${r.email} off the event.` : `Google Calendar sends ${r.email} the invite.`;
      case "waiting":
        return `${cancel ? "The calendar cancel" : "The invite"} for ${r.email} is queued: email sending is not configured here.`;
      case "skipped":
        // A cancel for someone who never got an invite is nothing to report.
        return cancel ? "" : `No invite went to ${r.email}: ${r.note ?? "nothing to send"}.`;
      default:
        return `${cancel ? "The calendar cancel" : "The invite"} for ${r.email} is queued and goes out within a few minutes${r.note ? ` (first try: ${r.note.slice(0, 120)})` : ""}.`;
    }
  });
  const text = parts.filter(Boolean).join(" ");
  return text ? ` ${text}` : "";
}

// Shot and delivered shoots are history: no invite, no cancel.
const inviteLive = (status: string) => status !== "shot" && status !== "delivered" && status !== "canceled";

// Confirm time, and reschedule (the same action): the local wall clock the
// admin typed becomes starts_at / ends_at (duration from the price table),
// the booking is confirmed, the calendar gets a new version, the team hears
// (#bookings when set, else the hub) through a slack.issue job, so a Slack
// hiccup retries on its own instead of failing the action. Since Oct 21 2026
// the client hears too (email.time_confirmed, src/lib/booking-time-email.ts):
// "Your new time is confirmed" after a portal reschedule, "Your shoot has
// moved" when a confirmed time changes, else "Your shoot time is confirmed".

// What the banner calls the client's time email.
const TIME_EMAIL_NAME: Record<TimeEmailVariant, string> = { confirmed: "the time confirmation email", reconfirmed: "the new time confirmation email", moved: "the shoot moved email" };
export async function confirmTime(bookingId: string, formData: FormData) {
  const actor = await who();
  if (!hasDb()) finishBooking(bookingId, fail("Demo mode: nothing was saved."));
  const date = toYmd(String(formData.get("date") || ""));
  const time = toHm(String(formData.get("time") || ""));
  let out: Outcome;
  try {
    if (!date || !time) out = fail("Enter both a date and a start time.");
    else {
      const d = db();
      const b = await d.query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), with: { listing: { columns: { address: true, nda: true } } } });
      const envErr = b ? otherEnv(b.env) : null;
      if (!b) out = fail("Booking not found.");
      else if (envErr) out = fail(envErr);
      else if (b.status === "canceled") out = fail("This booking is canceled. Nothing was changed.");
      else {
        const startsAt = wallClockToUtc(date, time);
        if (!startsAt) throw new Error("that date and time could not be read");
        const minutes = quote(b.serviceIds ?? [], b.addonIds ?? [], bookingExtra(b)).minutes;
        const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
        // Intake fills starts_at for every booking that came with a time, so
        // only the status says whether an admin confirmed it before.
        const rescheduled = b.status !== "requested";
        const version = b.calendarVersion + 1;
        const when = fmtBookingWhen({ desiredDate: date, startTime: time }) ?? `${date} ${time}`;
        const now = new Date();
        await d
          .update(schema.bookings)
          .set({ desiredDate: date, startTime: time, startsAt, endsAt, status: b.status === "requested" ? "confirmed" : b.status, calendarVersion: version, clientRescheduledAt: null, clientRescheduledFrom: null, updatedAt: now })
          .where(eq(schema.bookings.id, bookingId));
        await d.update(schema.listings).set({ shootDate: new Date(`${date}T00:00:00Z`) }).where(eq(schema.listings.id, b.listingId));
        await logActivity({ actorEmail: actor, action: rescheduled ? "booking.rescheduled" : "booking.time_confirmed", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, date, time, when, minutes, version } });
        await enqueueJobs([
          { kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", bookingId, version), bookingId, listingId: b.listingId, payload: { version } },
          {
            kind: "slack.issue",
            idempotencyKey: `slack.issue:time_confirmed:${bookingId}:v${version}`,
            bookingId,
            listingId: b.listingId,
            payload: { version, channel: "bookings", note: hubTextTimeConfirmed({ bookingId, listing: listingName(b), when, rescheduled, shooter: b.photographerEmail, by: actor }) },
          },
        ]);
        // The client's confirmation (Oct 21 2026). Shot and delivered shoots
        // are history: a date fix on those emails nobody.
        const variant = timeEmailVariant({ clientRescheduled: Boolean(b.clientRescheduledAt), wasConfirmed: rescheduled });
        const clientEmail = b.status === "requested" || b.status === "confirmed";
        if (clientEmail) await enqueueJobs([timeConfirmedSpec({ bookingId, listingId: b.listingId, version, variant })]);
        // The shooter's invite moves with the time (same UID, new SEQUENCE).
        const shooter = b.photographerEmail?.trim().toLowerCase() || null;
        const invites = shooter && inviteLive(b.status) ? await sendInvitesNow(bookingId, [shooterInviteSpec({ bookingId, listingId: b.listingId, version, email: shooter, method: "REQUEST" })]) : [];
        drainLater({ bookingId });
        out = done(`${rescheduled ? "Rescheduled to" : "Time confirmed:"} ${when}. The calendar updates next.${clientEmail ? ` The client gets ${TIME_EMAIL_NAME[variant]}.` : ""}${inviteNote(invites)}`);
      }
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finishBooking(bookingId, out);
}

// The shooter is the calendar event's one attendee; a new version re-sends it.
// The new shooter gets an iCalendar invite (REQUEST) by email right away; a
// shooter who was replaced or cleared gets a CANCEL for the same event.
// Saving the same shooter again sends the invite again (a new SEQUENCE).
export async function assignShooter(bookingId: string, formData: FormData) {
  const actor = await who();
  if (!hasDb()) finishBooking(bookingId, fail("Demo mode: nothing was saved."));
  const email = String(formData.get("email") || "").trim().toLowerCase();
  let out: Outcome;
  try {
    if (email && !EMAIL_RE.test(email)) out = fail("That email does not look right.");
    else {
      const d = db();
      const b = await d.query.bookings.findFirst({
        where: eq(schema.bookings.id, bookingId),
        columns: { id: true, listingId: true, clientId: true, calendarVersion: true, status: true, photographerEmail: true, env: true, desiredDate: true, startsAt: true },
      });
      const envErr = b ? otherEnv(b.env) : null;
      if (!b) out = fail("Booking not found.");
      else if (envErr) out = fail(envErr);
      else if (b.status === "canceled") out = fail("This booking is canceled. Nothing was changed.");
      else {
        const version = b.calendarVersion + 1;
        const previous = b.photographerEmail?.trim().toLowerCase() || null;
        await d.update(schema.bookings).set({ photographerEmail: email || null, calendarVersion: version, updatedAt: new Date() }).where(eq(schema.bookings.id, bookingId));
        await logActivity({ actorEmail: actor, action: "booking.shooter_assigned", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, email: email || null, previous, version } });
        await enqueueJobs([{ kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", bookingId, version), bookingId, listingId: b.listingId, payload: { version } }]);
        const live = inviteLive(b.status);
        const dated = Boolean(b.desiredDate || b.startsAt);
        const specs: JobSpec[] = [];
        if (live && previous && previous !== email) specs.push(shooterInviteSpec({ bookingId, listingId: b.listingId, version, email: previous, method: "CANCEL" }));
        if (live && email && dated) specs.push(shooterInviteSpec({ bookingId, listingId: b.listingId, version, email, method: "REQUEST" }));
        const invites = await sendInvitesNow(bookingId, specs);
        drainLater({ bookingId });
        const head = email ? (email === previous ? `${email} stays the shooter.` : `${email} is the shooter.`) : "Shooter cleared.";
        const why = !email ? "" : !live ? ` The shoot is marked ${BOOKING_STATUS_LABEL[b.status].toLowerCase()}, so no invite was sent.` : !dated ? " There is no date yet, so the invite goes out once the time is confirmed." : "";
        out = done(`${head}${why}${inviteNote(invites)}`);
      }
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finishBooking(bookingId, out);
}

// The manual status control (the booking page and the list's status select):
// Unconfirmed (stored as requested), Confirmed, Shot, Delivered, Canceled.
// Canceled runs the full cancel (cancelBookingCore: the invoice is voided, the
// queued side effects retired, the shoot date cleared, the calendar hold and
// the shooter's invite canceled). A canceled booking comes back only as
// Unconfirmed or Confirmed, and its invoice stays as it is. Confirmed with no
// confirmed time keeps the requested date and time. Moving between
// Unconfirmed and the confirmed statuses gives the calendar a new version and
// sends the shooter an updated invite. The client is emailed from here only
// when the status becomes Confirmed with a date and time (Oct 21 2026): the
// time confirmation, or the new time confirmation after a portal reschedule.
export async function setBookingStatus(bookingId: string, formData: FormData) {
  const actor = await who();
  const back = String(formData.get("back") ?? "") || null;
  if (!hasDb()) finishBooking(bookingId, fail("Demo mode: nothing was saved."), back);
  const to = String(formData.get("status") || "").trim();
  // The booking page sends its Note field (the booking's internal note); the
  // list's status select sends none, and then the saved note is left alone.
  const hasNote = formData.has("note");
  const note = cleanNote(formData.get("note"));
  let out: Outcome;
  try {
    if (!isBookingStatus(to)) out = fail("Pick one of the statuses.");
    else {
      const d = db();
      const b = await d.query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), with: { invoice: { columns: { status: true } } } });
      const envErr = b ? otherEnv(b.env) : null;
      if (!b) out = fail("Booking not found.");
      else if (envErr) out = fail(envErr);
      else if (b.status === to) out = done(`The booking is already ${BOOKING_STATUS_LABEL[to]}. Nothing changed.`);
      else if (to === "canceled") {
        // An edited note goes with the change (into the history) and is saved
        // on the booking; an unchanged saved note is not repeated in the log.
        const noteChanged = hasNote && note !== (b.internalNote ?? "");
        out = await cancelBookingCore(bookingId, actor, noteChanged ? note : "", { from: b.status, via: "status" });
        if (out.ok && noteChanged) {
          await d.update(schema.bookings).set({ internalNote: note || null }).where(eq(schema.bookings.id, bookingId));
          out = done(`${out.message} The note is saved.`);
        }
      }
      else if (b.status === "canceled" && !RESTORE_TO.includes(to)) out = fail("A canceled booking comes back as Unconfirmed or Confirmed. Pick one of those first.");
      else {
        const from = b.status;
        const restored = from === "canceled";
        // Confirming a time the client moved clears the reschedule flag (the
        // calendar title drops "[RESCHEDULED - UNCONFIRMED]").
        const clearMoved = Boolean(b.clientRescheduledAt) && isTimeConfirmed(to);
        const calendarChange = restored || isTimeConfirmed(from) !== isTimeConfirmed(to) || clearMoved;
        const version = calendarChange ? b.calendarVersion + 1 : b.calendarVersion;
        const now = new Date();
        const noteChanged = hasNote && note !== (b.internalNote ?? "");
        const set: Partial<typeof schema.bookings.$inferInsert> = { status: to, calendarVersion: version, updatedAt: now, ...(clearMoved ? { clientRescheduledAt: null, clientRescheduledFrom: null } : {}), ...(noteChanged ? { internalNote: note || null } : {}) };
        // Confirmed without Confirm time: the requested date and time stand.
        let keptTime = false;
        if (to === "confirmed" && !b.startsAt && b.desiredDate && b.startTime) {
          const startsAt = wallClockToUtc(b.desiredDate, b.startTime);
          if (startsAt) {
            const minutes = quote(b.serviceIds ?? [], b.addonIds ?? [], bookingExtra(b)).minutes;
            set.startsAt = startsAt;
            set.endsAt = new Date(startsAt.getTime() + minutes * 60_000);
            keptTime = true;
          }
        }
        await d.update(schema.bookings).set(set).where(eq(schema.bookings.id, bookingId));
        // Cancel cleared the listing's shoot date; a restore puts it back.
        if (restored && b.desiredDate) await d.update(schema.listings).set({ shootDate: new Date(`${b.desiredDate}T00:00:00Z`) }).where(and(eq(schema.listings.id, b.listingId), isNull(schema.listings.shootDate)));
        await logActivity({ actorEmail: actor, action: "booking.status_set", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, from, to, version, restored, note: noteChanged ? note || null : null } });
        if (calendarChange) await enqueueJobs([{ kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", bookingId, version), bookingId, listingId: b.listingId, payload: { version } }]);
        // Confirmed, with a date and time: the client's confirmation email
        // (calendarChange is true whenever this is, so the version is new).
        const confirmedNow = to === "confirmed" && !isTimeConfirmed(from) && Boolean(b.desiredDate && b.startTime) && Boolean(set.startsAt ?? b.startsAt);
        const variant: TimeEmailVariant = clearMoved ? "reconfirmed" : "confirmed";
        if (confirmedNow) await enqueueJobs([timeConfirmedSpec({ bookingId, listingId: b.listingId, version, variant })]);
        const shooter = b.photographerEmail?.trim().toLowerCase() || null;
        const invites =
          calendarChange && shooter && inviteLive(to) && (b.desiredDate || b.startsAt)
            ? await sendInvitesNow(bookingId, [shooterInviteSpec({ bookingId, listingId: b.listingId, version, email: shooter, method: "REQUEST" })])
            : [];
        drainLater({ bookingId });
        const inv = b.invoice?.status ?? null;
        const invoiceLine = restored && inv ? ` The invoice stays as it is (${inv === "void" ? "voided" : inv.replace(/_/g, " ")}); nothing was reissued.` : "";
        const timeLine = to === "confirmed" && !b.desiredDate ? " There is no date yet: use Confirm time to set one." : keptTime ? " The requested time is now the confirmed time." : "";
        out = done(
          `${restored ? "Booking restored as" : "Status set to"} ${BOOKING_STATUS_LABEL[to]}.${timeLine}${invoiceLine}${calendarChange ? " The calendar updates next." : ""}${inviteNote(invites)}${confirmedNow ? ` The client gets ${TIME_EMAIL_NAME[variant]}.` : " The client was not emailed."}${noteChanged ? " The note is saved." : ""}`
        );
      }
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finishBooking(bookingId, out, back);
}

// The booking's internal note (Oct 22 2026): the status card's Note field,
// kept on the booking so it is there after a refresh. Team only: it never
// reaches the client, the portal, the calendar or the shoot brief.
const NOTE_MAX = 2000;
function cleanNote(v: FormDataEntryValue | null): string {
  return String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, NOTE_MAX);
}

// Save note on the booking page's status card: saves the note without
// touching the status (setBookingStatus also saves an edited note).
export async function saveBookingNote(bookingId: string, formData: FormData) {
  const actor = await who();
  if (!hasDb()) finishBooking(bookingId, fail("Demo mode: nothing was saved."));
  const note = cleanNote(formData.get("note"));
  let out: Outcome;
  try {
    const d = db();
    const b = await d.query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), columns: { id: true, env: true, listingId: true, clientId: true, internalNote: true } });
    const envErr = b ? otherEnv(b.env) : null;
    if (!b) out = fail("Booking not found.");
    else if (envErr) out = fail(envErr);
    else if (note === (b.internalNote ?? "")) out = done("The note is already saved. Nothing changed.");
    else {
      await d.update(schema.bookings).set({ internalNote: note || null, updatedAt: new Date() }).where(eq(schema.bookings.id, bookingId));
      await logActivity({ actorEmail: actor, action: "booking.note_saved", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, note: note || null } });
      out = done(note ? "Note saved." : "Note cleared.");
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finishBooking(bookingId, out);
}

// "Photography = 900" per line (also "Photography: $900" or "Photography · 900").
function parseLines(raw: string): { items: InvoiceLineItem[]; error: string | null } {
  const items: InvoiceLineItem[] = [];
  for (const line of raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(.+?)\s*(?:=|:|·)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*$/.exec(line);
    if (!m) return { items: [], error: `Could not read the line "${line.slice(0, 60)}". Use Name = 600, one per line.` };
    const cents = Math.round(Number(m[2].replace(/,/g, "")) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return { items: [], error: `The amount on "${m[1]}" must be above zero.` };
    items.push({ id: `line-${items.length + 1}`, name: m[1].trim(), cents, priced: true });
  }
  return { items, error: null };
}

// The lines for a quoted amount: priced lines stay when the quote covers them
// and the difference is one quoted line; a quote below them (a discount) is a
// single line for the whole amount.
function quotedLines(existing: InvoiceLineItem[], cents: number, label: string, description: string | null): InvoiceLineItem[] {
  const priced = existing.filter((l) => l.priced && l.cents > 0);
  const sum = priced.reduce((n, l) => n + l.cents, 0);
  if (priced.length && cents === sum) return priced;
  if (priced.length && cents > sum) return [...priced, { id: "quote", name: label, cents: cents - sum, priced: true }];
  return [{ id: "quote", name: description ?? label, cents, priced: true }];
}

// Set amount: needs_quote → open (the admin sets the total and optionally the
// lines), or an open invoice not issued yet, or an ISSUED unpaid invoice,
// which is reissued (contract section 5: after a client revision the admin
// sets the amount in /admin). A reissue closes the provider object first
// (closeProviderObject: void or delete the Stripe invoice, cancel the Titus
// checkout; if the provider shows it paid, that payment wins and nothing is
// reissued), forgets it, and remembers the old id so a late webhook about it
// is only noted. Every path bumps idempotency_version, so the create job and
// the provider idempotency keys are new: a dead or still-queued older job
// (same key as intake's) can never leave the invoice unissued while the
// banner says it is on its way. The pay link email follows the create job.
// A pay another way invoice (check, ACH transfer or cash) has no provider: the
// amount is set and the invoice opens, and nothing is issued and no pay link
// goes out; the team tells the client and marks it paid when it arrives.
export async function setInvoiceAmount(invoiceId: string, formData: FormData) {
  const actor = await who();
  if (!hasDb()) finishBooking(null, fail("Demo mode: nothing was saved."));
  const amountRaw = String(formData.get("amount") || "").replace(/[^0-9.]/g, "");
  const label = String(formData.get("label") || "").trim() || "Quoted items";
  const parsed = parseLines(String(formData.get("lines") || ""));
  let bookingId: string | null = null;
  let out: Outcome;
  try {
    const d = db();
    const inv = await d.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { booking: { columns: { paymentDetail: true } } } });
    if (!inv) throw new Error("invoice not found");
    bookingId = inv.bookingId;
    const envErr = otherEnv(inv.env);
    const linesSum = parsed.items.reduce((n, l) => n + l.cents, 0);
    const cents = amountRaw ? Math.round(Number(amountRaw) * 100) : linesSum;
    const manual = isPaidAnotherWay(inv);
    const provider = manual ? null : inv.provider ?? "stripe";
    const reissue = inv.status === "open" && Boolean(inv.providerId);
    if (parsed.error) out = fail(parsed.error);
    else if (envErr) out = fail(envErr);
    else if (!Number.isFinite(cents) || cents < 100) out = fail("Enter a total of at least $1.");
    else if (parsed.items.length && linesSum !== cents) out = fail(`The line items add up to ${fmtDollars(linesSum)}, not ${fmtDollars(cents)}. Fix one or the other.`);
    else if (isPaid(inv.status)) out = fail("This invoice is already paid.");
    else if (inv.status !== "needs_quote" && inv.status !== "open") out = fail(`This invoice is ${inv.status.replace(/_/g, " ")}. ${isPayable(inv.status) ? "Wait for the payment to settle, or switch it to card." : "Nothing was changed."}`);
    else if (provider === "titus" && cents > 50_000 * 100) out = fail("Pay at close covers up to $50,000. Switch to card for a larger amount.");
    else if (reissue && cents === inv.amountCents && !parsed.items.length) out = fail(`The issued ${provider === "titus" ? "pay at close checkout" : "Stripe invoice"} is already for ${fmtDollars(cents)}. Use Resend pay link to send it again.`);
    else {
      let closed: string | null = null;
      let unclosed = "";
      let paidInstead: Awaited<ReturnType<typeof closeProviderObject>>["paidAtProvider"] = null;
      if (reissue) {
        const c = await closeProviderObject(inv, "admin");
        if (c.paidAtProvider) paidInstead = c.paidAtProvider;
        else {
          closed = c.closed;
          unclosed = c.unclosed ? ` ${c.unclosed}` : "";
        }
      }
      if (paidInstead) {
        drainLater(inv.bookingId ? { bookingId: inv.bookingId } : { invoiceId: inv.id });
        out = done(`${providerName(provider)} shows this invoice paid, so it was recorded as a real payment and not reissued.${paidInstead.unlocked ? " Downloads are unlocked." : ""}`);
      } else {
        const lines = parsed.items.length ? parsed.items : quotedLines(inv.lineItems ?? [], cents, label, inv.description);
        const version = inv.idempotencyVersion + 1;
        const now = new Date();
        const previousNote = inv.meta?.note ? { previousNote: inv.meta.note } : {};
        await d
          .update(schema.invoices)
          .set({
            status: "open",
            amountCents: cents,
            amountDue: cents,
            lineItems: lines,
            idempotencyVersion: version,
            ...(reissue
              ? {
                  providerId: null,
                  hostedUrl: null,
                  hostedInvoiceUrl: null,
                  stripeInvoiceId: null,
                  orderId: null,
                  lastEvent: { type: "reissued", at: now.toISOString(), by: actor, closed, previousProviderId: inv.providerId, previousAmountCents: inv.amountCents },
                  lastCheckedAt: now,
                }
              : {}),
            meta: {
              ...(inv.meta ?? {}),
              ...previousNote,
              quotedCents: cents,
              quotedBy: actor,
              quotedAt: now.toISOString(),
              note: reissue ? `reissued at a new amount by ${actor}` : `amount set by ${actor}`,
              ...(reissue ? { revisedAfterIssue: false, replacedProviderIds: [...(inv.meta?.replacedProviderIds ?? []), ...(inv.providerId ? [inv.providerId] : [])] } : {}),
            },
            updatedAt: now,
          })
          .where(eq(schema.invoices.id, inv.id));
        // The booking email's "wait for the invoice to be issued" window restarts.
        if (inv.bookingId) await d.update(schema.bookings).set({ updatedAt: now }).where(eq(schema.bookings.id, inv.bookingId));
        await logActivity({ actorEmail: actor, action: "invoice.amount_set", listingId: inv.listingId, clientId: inv.clientId, meta: { invoiceId: inv.id, amountCents: cents, previousAmountCents: inv.amountCents, provider, lines: lines.length, version, reissued: reissue, closed } });
        // The provider job first, then the pay link, as separate inserts so the
        // drain runs them in that order (same run_at, earlier created_at).
        const base = { invoiceId: inv.id, bookingId: inv.bookingId, listingId: inv.listingId };
        if (!manual) {
          const kind = provider === "titus" ? "titus.checkout.create" : "stripe.invoice.create";
          await enqueueJobs([{ kind, idempotencyKey: jobKey(kind, inv.id, version), ...base, payload: { version, invoiceId: inv.id } }]);
          if (inv.bookingId) await enqueueJobs([{ kind: "email.pay_link", idempotencyKey: jobKey("email.pay_link", inv.id, version), ...base, payload: { version, again: false } }]);
        }
        const line = await payLineFor(inv.id);
        if (line) await enqueueJobs([{ kind: "slack.payment", idempotencyKey: `slack.payment:amount_set:${inv.id}:v${version}`, ...base, payload: { version, text: manual ? paymentsText.amountSetOther({ ...line, by: actor }) : paymentsText.amountSet({ ...line, by: actor }) } }]);
        drainLater(inv.bookingId ? { bookingId: inv.bookingId } : { invoiceId: inv.id });
        out = manual
          ? done(`Amount set to ${fmtDollars(cents)}. This booking pays ${payOtherPhrase(inv.booking?.paymentDetail)}, so nothing is issued and no pay link goes out. Let the client know the amount, and mark it paid when the payment arrives.`)
          : done(`Amount set to ${fmtDollars(cents)}.${closed ? ` The previous ${closed} was closed.` : ""} The ${provider === "titus" ? "pay at close checkout" : "Stripe invoice"} is being issued and the pay link goes out next.${unclosed}`);
      }
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finishBooking(bookingId, out);
}

// Pay at close is off the table (declined, ineligible, or the client changed
// their mind): read the Titus checkout back and close it (a funded one wins
// instead: applyPaid, nothing is switched; a refusal to cancel surfaces),
// re-key the row as a Stripe invoice with a new idempotency version and let
// the usual jobs issue it and send the pay link. A pay another way invoice
// (check, ACH transfer or cash) switches the same way; it has nothing to close.
export async function switchToCard(invoiceId: string) {
  const actor = await who();
  if (!hasDb()) finishBooking(null, fail("Demo mode: nothing was saved."));
  let bookingId: string | null = null;
  let out: Outcome;
  try {
    const d = db();
    const inv = await d.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId) });
    if (!inv) throw new Error("invoice not found");
    bookingId = inv.bookingId;
    const envErr = otherEnv(inv.env);
    if (isPaid(inv.status)) out = fail("This invoice is already paid.");
    else if (envErr) out = fail(envErr);
    else if (inv.provider === "stripe") out = fail("This invoice is already a card invoice.");
    else if (!["needs_quote", "open", "processing", "review"].includes(inv.status)) out = fail(`This invoice is ${inv.status.replace(/_/g, " ")}. Nothing was changed.`);
    else {
      const c = await closeProviderObject(inv, "admin");
      if (c.paidAtProvider) {
        drainLater(inv.bookingId ? { bookingId: inv.bookingId } : { invoiceId: inv.id });
        out = done(`Titus shows this checkout funded, so the invoice was recorded as paid and not switched.${c.paidAtProvider.unlocked ? " Downloads are unlocked." : ""}`);
      } else {
        const closed = c.closed ? inv.providerId : null;
        const unclosed = c.unclosed ? ` ${c.unclosed}` : "";
        const fromOther = isPaidAnotherWay(inv);
        const version = inv.idempotencyVersion + 1;
        const status: InvoiceStatus = inv.status === "needs_quote" ? "needs_quote" : "open";
        const now = new Date();
        await d
          .update(schema.invoices)
          .set({
            provider: "stripe",
            providerId: null,
            hostedUrl: null,
            hostedInvoiceUrl: null,
            stripeInvoiceId: null,
            orderId: null,
            method: "card",
            status,
            idempotencyVersion: version,
            meta: { ...(inv.meta ?? {}), ...(inv.providerId ? { replacedProviderIds: [...(inv.meta?.replacedProviderIds ?? []), inv.providerId] } : {}) },
            lastEvent: { type: "switched_to_card", at: now.toISOString(), by: actor, closedCheckout: closed },
            lastCheckedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.invoices.id, inv.id));
        if (inv.bookingId) await d.update(schema.bookings).set({ paymentMethod: "card", paymentDetail: null, updatedAt: now }).where(eq(schema.bookings.id, inv.bookingId));
        await logActivity({ actorEmail: actor, action: "invoice.switched_to_card", listingId: inv.listingId, clientId: inv.clientId, meta: { invoiceId: inv.id, from: inv.provider, ...(fromOther ? { fromMethod: "other" } : {}), canceledCheckout: closed, version } });
        const base = { invoiceId: inv.id, bookingId: inv.bookingId, listingId: inv.listingId };
        const issuing = status === "open" && (inv.amountCents ?? 0) > 0;
        if (issuing) {
          await enqueueJobs([{ kind: "stripe.invoice.create", idempotencyKey: jobKey("stripe.invoice.create", inv.id, version), ...base, payload: { version, invoiceId: inv.id } }]);
          if (inv.bookingId) await enqueueJobs([{ kind: "email.pay_link", idempotencyKey: jobKey("email.pay_link", inv.id, version), ...base, payload: { version, again: false } }]);
        }
        const line = await payLineFor(inv.id);
        if (line) await enqueueJobs([{ kind: "slack.payment", idempotencyKey: `slack.payment:switched_to_card:${inv.id}:v${version}`, ...base, payload: { version, text: paymentsText.switchedToCard({ ...line, by: actor, fromOther }) } }]);
        drainLater(inv.bookingId ? { bookingId: inv.bookingId } : { invoiceId: inv.id });
        out = done(`${issuing ? "Switched to card. The Stripe invoice is being issued and the pay link goes out next." : "Switched to card. Set the amount to issue the invoice."}${unclosed}`);
      }
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finishBooking(bookingId, out);
}

// "Here is your link again": the pay link email once more, as a fresh job.
// Keyed to the minute, so a double click sends one email; only while the
// invoice is open (a payment or application in flight is past the link).
export async function resendPayLink(invoiceId: string) {
  const actor = await who();
  if (!hasDb()) finishBooking(null, fail("Demo mode: nothing was sent."));
  let bookingId: string | null = null;
  let out: Outcome;
  try {
    const inv = await db().query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { client: { columns: { email: true } } } });
    if (!inv) throw new Error("invoice not found");
    bookingId = inv.bookingId;
    const to = inv.client?.email ?? inv.clientEmail ?? null;
    const envErr = otherEnv(inv.env);
    if (!inv.bookingId) out = fail("This invoice has no booking, so there is no booking email to resend.");
    else if (envErr) out = fail(envErr);
    else if (isPaidAnotherWay(inv)) out = fail("This booking pays by check, ACH transfer or cash, so there is no pay link. Mark it paid when the payment arrives, or switch it to card.");
    else if (inv.status !== "open") {
      out = fail(
        inv.status === "needs_quote"
          ? "Set the amount first; there is no pay link until the invoice is issued."
          : isPayable(inv.status)
            ? `This invoice is ${inv.status.replace(/_/g, " ")}; the client is already past the pay link.`
            : `This invoice is ${inv.status.replace(/_/g, " ")}; there is nothing to pay.`
      );
    } else if (inv.provider === "stripe" && !(inv.hostedUrl ?? inv.hostedInvoiceUrl)) out = fail("The Stripe invoice is not issued yet. Run its stripe.invoice.create job below first.");
    else {
      const n = await enqueueJobs([{ kind: "email.pay_link", idempotencyKey: `email.pay_link:${inv.id}:resend:${Math.floor(Date.now() / 60_000)}`, invoiceId: inv.id, bookingId: inv.bookingId, listingId: inv.listingId, payload: { version: inv.idempotencyVersion, again: true } }]);
      if (n) {
        await logActivity({ actorEmail: actor, action: "email.pay_link_requested", listingId: inv.listingId, clientId: inv.clientId, meta: { invoiceId: inv.id, bookingId: inv.bookingId, to } });
        drainLater({ bookingId: inv.bookingId });
        out = done(`The pay link is on its way${to ? ` to ${to}` : ""}.`);
      } else out = done("The pay link was already sent a moment ago.");
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finishBooking(bookingId, out);
}

// Mark paid with a note: payments.markPaidManually closes the open provider
// object first (so the client cannot pay twice) and unlocks through the same
// CTE a webhook uses. If the provider in fact shows it paid, the real payment
// wins (status paid) instead.
export async function markPaid(invoiceId: string, formData: FormData) {
  const actor = await who();
  if (!hasDb()) finishBooking(null, fail("Demo mode: nothing was saved."));
  const note = String(formData.get("note") || "").trim();
  let bookingId: string | null = null;
  let out: Outcome;
  try {
    const inv = await db().query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), columns: { bookingId: true, status: true, env: true } });
    if (!inv) throw new Error("invoice not found");
    bookingId = inv.bookingId;
    const envErr = otherEnv(inv.env);
    if (!note) out = fail("Add a short note first: how and when was it paid?");
    else if (envErr) out = fail(envErr);
    else if (isPaid(inv.status)) out = fail("This invoice is already paid.");
    else {
      const r = await markPaidManually(invoiceId, note, actor);
      if (r.changed) drainLater({ invoiceId });
      if (r.alreadyPaidAtProvider) out = done(`The provider already shows this invoice paid, so it was recorded as a real payment.${r.unlocked ? " Downloads are unlocked." : ""}`);
      else if (r.changed) out = done(`Marked paid.${r.unlocked ? " Downloads are unlocked." : ""}${r.voided ? " The open provider object was closed so the client cannot pay twice." : ""}${r.unclosed ? ` ${r.unclosed}` : ""}`);
      else out = fail(r.reason ?? "Nothing changed: the invoice was not in a state that can be marked paid.");
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finishBooking(bookingId, out);
}

// Cancel: the booking is canceled, the open Stripe invoice is voided (a draft
// deleted) or the open Titus checkout canceled (closeProviderObject reads it
// back first: a funded one is recorded as paid and left alone), the invoice
// row is void, every side effect still queued for the booking (its emails,
// hub line, provider object) is retired so nothing goes out after the fact,
// the listing's shoot date is cleared when no other live booking uses it, the
// calendar hold is released (calendar.cancel), the shooter's invite is
// canceled (email.shooter_invite CANCEL) and the team hears (#bookings
// when set, else the hub, as a slack.issue job). A paid invoice is left alone
// (refund it with the provider). Downloads are never touched.
export async function cancelBooking(bookingId: string, formData: FormData) {
  const actor = await who();
  if (!hasDb()) finishBooking(bookingId, fail("Demo mode: nothing was saved."));
  const note = String(formData.get("note") || "").trim();
  let out: Outcome;
  try {
    out = await cancelBookingCore(bookingId, actor, note);
  } catch (e) {
    out = fail(errText(e));
  }
  finishBooking(bookingId, out);
}

// The cancel itself, shared by Cancel and the status control (Canceled), so
// both void, retire and release exactly the same way. Returns the banner;
// never redirects. `from` / `via` only enrich the activity row.
async function cancelBookingCore(bookingId: string, actor: string, note: string, ctx: { from?: string; via?: "status" } = {}): Promise<Outcome> {
  const d = db();
  const b = await d.query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), with: { listing: { columns: { address: true, nda: true } }, invoice: true } });
  const envErr = b ? otherEnv(b.env) : null;
  if (!b) return fail("Booking not found.");
  if (envErr) return fail(envErr);
  if (b.status === "canceled") return fail("This booking is already canceled.");
  const inv = b.invoice;
  let closed: string | null = null;
  let tail = "";
  let providerPaid = false;
  if (inv && isPaid(inv.status)) {
    tail = " The invoice is paid; refund it with the provider if the client should get the money back.";
  } else if (inv?.providerId) {
    const c = await closeProviderObject(inv, "admin");
    if (c.paidAtProvider) {
      providerPaid = true;
      tail = ` ${providerName(inv.provider)} shows this invoice paid, so it was recorded as paid and left alone; refund it with the provider if the client should get the money back.`;
    } else {
      closed = c.closed;
      if (c.unclosed) tail = ` ${c.unclosed}`;
    }
  }
  const now = new Date();
  // Retire what is still queued before anything drains: the confirmation
  // or pay link email, the "New booking" hub line, the provider object.
  const retired = await d
    .update(schema.jobs)
    .set({ status: "done", doneAt: now, leaseUntil: null, lastError: "skipped: booking canceled", updatedAt: now })
    .where(
      and(
        eq(schema.jobs.env, currentEnv()),
        inArray(schema.jobs.status, ["queued", "running"]),
        inArray(schema.jobs.kind, CANCEL_RETIRES),
        inv ? or(eq(schema.jobs.bookingId, bookingId), eq(schema.jobs.invoiceId, inv.id)) : eq(schema.jobs.bookingId, bookingId)
      )
    )
    .returning({ id: schema.jobs.id });
  if (inv && !isPaid(inv.status) && !providerPaid) {
    await transitionInvoice(inv.id, "void", {
      from: ["needs_quote", "open", "processing", "review", "draft", "uncollectible"],
      lastEvent: { type: "booking.canceled", at: now.toISOString(), by: actor, closed },
      activity: { action: "invoice.voided", actorEmail: actor, meta: { provider: inv.provider, reason: "booking canceled", closed } },
    });
  }
  const version = b.calendarVersion + 1;
  await d.update(schema.bookings).set({ status: "canceled", calendarVersion: version, updatedAt: now }).where(eq(schema.bookings.id, bookingId));
  // The listing's shoot date: clear it unless another live booking still
  // holds this listing (the dashboard's bookingless rows read it).
  const otherLive = await d.query.bookings.findFirst({ where: and(eq(schema.bookings.listingId, b.listingId), ne(schema.bookings.id, bookingId), ne(schema.bookings.status, "canceled")), columns: { id: true } });
  if (!otherLive) await d.update(schema.listings).set({ shootDate: null }).where(eq(schema.listings.id, b.listingId));
  await logActivity({ actorEmail: actor, action: "booking.canceled", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, note: note || null, version, closed, retiredJobs: retired.length, ...(ctx.from ? { from: ctx.from } : {}), ...(ctx.via ? { via: ctx.via } : {}) } });
  await enqueueJobs([
    { kind: "calendar.cancel", idempotencyKey: jobKey("calendar.cancel", bookingId, version), bookingId, listingId: b.listingId, payload: { version } },
    {
      kind: "slack.issue",
      idempotencyKey: `slack.issue:booking_canceled:${bookingId}:v${version}`,
      bookingId,
      listingId: b.listingId,
      payload: { version, channel: "bookings", note: hubTextBookingCanceled({ bookingId, listing: listingName(b), when: fmtBookingWhen({ desiredDate: b.desiredDate, startTime: b.startTime }), by: actor }) },
    },
  ]);
  if (inv) {
    const line = await payLineFor(inv.id);
    if (line) await enqueueJobs([{ kind: "slack.payment", idempotencyKey: `slack.payment:booking_canceled:${bookingId}:v${version}`, invoiceId: inv.id, bookingId, listingId: b.listingId, payload: { version, text: paymentsText.bookingCanceled({ ...line, by: actor, closed }) } }]);
  }
  // The shooter's invite comes off their calendar (the handler skips it when
  // no invite ever went out, or the shoot is already history).
  const shooter = b.photographerEmail?.trim().toLowerCase() || null;
  const invites = shooter && b.status !== "shot" && b.status !== "delivered" ? await sendInvitesNow(bookingId, [shooterInviteSpec({ bookingId, listingId: b.listingId, version, email: shooter, method: "CANCEL" })]) : [];
  // Its scheduled second shoots go too (Oct 27 2026): each event is deleted and Google tells that shooter.
  const visits = await cancelVisitsForBooking(bookingId, actor);
  // Their open invoices are voided with them; a paid one stays (refund it in Stripe).
  const vi = await voidVisitInvoicesForCanceledVisits(bookingId, actor);
  const visitInvoices = `${vi.voided ? ` ${vi.voided} open second shoot invoice${vi.voided === 1 ? " was" : "s were"} voided.` : ""}${vi.paid ? ` ${vi.paid} paid second shoot invoice${vi.paid === 1 ? " stays" : "s stay"} as paid; refund in Stripe if needed.` : ""}${vi.inFlight ? ` ${vi.inFlight} second shoot invoice${vi.inFlight === 1 ? " has" : "s have"} a payment in progress and ${vi.inFlight === 1 ? "was" : "were"} left alone.` : ""}`;
  drainLater({ bookingId });
  return done(`Booking canceled.${closed ? ` The ${closed} was closed.` : ""}${retired.length ? ` ${retired.length} queued side effect${retired.length === 1 ? " was" : "s were"} retired.` : ""}${visits ? ` ${visits} scheduled second shoot${visits === 1 ? " was" : "s were"} canceled with it.` : ""}${visitInvoices}${tail}${inviteNote(invites)}`);
}

// "Run now" on a queued, waiting or dead job: back on the queue for this
// moment (a dead one with its attempts reset) and drained right away. The job
// must belong to this environment and to the booking the page shows.
export async function runJob(jobId: string, bookingId: string | null) {
  const actor = await who();
  if (!hasDb()) finishBooking(bookingId, fail("Demo mode: nothing ran."));
  let out: Outcome;
  try {
    const d = db();
    const job = await d.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
    const b = bookingId ? await d.query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), columns: { id: true, invoiceId: true, env: true } }) : null;
    const envErr = b ? otherEnv(b.env) : null;
    if (!job) out = fail("Job not found.");
    else if (job.env !== currentEnv()) out = fail(`This job belongs to the ${job.env} environment and runs there.`);
    else if (envErr) out = fail(envErr);
    else if (bookingId && (!b || (job.bookingId !== b.id && !(b.invoiceId && job.invoiceId === b.invoiceId)))) out = fail("That job does not belong to this booking.");
    else if (job.status === "done") out = fail("This job already finished.");
    else if (job.status === "running" && job.leaseUntil && job.leaseUntil.getTime() > Date.now()) out = fail("This job is running right now. Give it a minute.");
    else {
      const wasDead = job.status === "dead";
      await d.update(schema.jobs).set({ status: "queued", attempts: wasDead ? 0 : job.attempts, runAt: new Date(), leaseUntil: null, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));
      await logActivity({ actorEmail: actor, action: "job.run_now", listingId: job.listingId, meta: { jobId, kind: job.kind, bookingId: job.bookingId, wasDead, attempts: job.attempts } });
      drainLater(job.bookingId ? { bookingId: job.bookingId } : job.invoiceId ? { invoiceId: job.invoiceId } : {});
      out = done(`${job.kind} is running now. Refresh in a moment to see how it went.`);
    }
  } catch (e) {
    out = fail(errText(e));
  }
  finishBooking(bookingId, out);
}
