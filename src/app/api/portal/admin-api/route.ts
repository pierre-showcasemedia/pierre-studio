// Token-guarded server-side admin API: data ops that can't run locally
// (DATABASE_URL is sealed to Vercel). Same guard as /migrate (x-migrate-token
// header must equal MIGRATE_TOKEN). Used by scripts/push-to-listing.mjs and
// the legacy scripts/upload-listing-media.mjs.
// Ops (POST, JSON): one of
//   { op: "setTeam", team, emails: [..], names?: { email: name } }
//   { op: "createListing", clientEmail, address, slug?, shootDate?, locked? }
//   { op: "addMedia", slug, files: [{ r2Key, filename, bytes?, kind, sort?, published? }], coverKey?, replace? }
//     — rows land Internal only unless a file says published: true
//   { op: "listListings", clientEmail? }         — listings (+media counts, nda flag), optionally one client's
//   { op: "listClients" }                        — every client row (team slug + listing count)
//   { op: "photoEditingReady", shootId }         — post a ready shoot's line to #photo-editing again (Dellon tagged)
//   { op: "shooterPay", email, since? }         — a shooter's bookings + return visits with each invoice's amount and paid date (read-only)
//   { op: "videoCards", stage? }                 — every Video card: stage, footage, last move, open revision, Dropbox folder + link (read-only)
//   { op: "dropboxVideoLink", slug }             — the Video folder's share link: saved, else asked for now (error tag when refused)
//   { op: "videoEditingReady", shootId }         — post a shoot's "raw video is in Dropbox" line to #video-editing now
//   { op: "rebuildBundles", slug? | withSections? } — queue "Download all" zip rebuilds for one listing, or every
//     listing with client-visible section or revision photos, or films. { slug, inline: true } also works on
//     that listing's rebuild in this request (up to four minutes) and says whether it finished; what is left
//     carries on in the cron's zip pass
//   { op: "inspectInbound", limit? }             — read-only: stored Quo texts by status, newest rows without their text
//   { op: "revisionIntakeDryRun", phone | conversationId, since, until? } | { inboundIds } — read-only: what the revision intake
//     (src/lib/revision-intake.ts) would decide for those texts; nothing stored or filed
//   { op: "inboundBackfill", since, apply? } — incoming texts on the business line since a date that the webhook never
//     stored (before it existed, or missed); a count without apply, stored and queued for the intake with it
//   { op: "emailIntakePoll" }                    — read hello@'s new mail now (src/lib/email-intake.ts), as the
//     minute cron does: counts only, never the text. Only where the intake is on (production)
//   { op: "updateListing", slug, address?, newSlug? } — rename a listing (slug change opt-in)
//   { op: "deleteListing", slug, actor?, reason? } — remove a listing with no booking (+ media, downloads,
//     revision requests, shoot rows; invoices unlinked; files stay in storage); logged as listing.deleted
//   { op: "inspectListings", slugs?, ids? }       — read-only: counts, bookings and invoices behind each listing
//   { op: "inspectMedia", slug }                  — read-only: every media row (key, shoot, editing id), the shoots
//     and the revision notes on the listing
//   { op: "inspectJobs", slug, kind?, limit? }    — read-only: this environment's job rows on the listing with their
//     payload and last error (newest first), and each shoot's full progress (editing parts, image ids)
//   { op: "twilightProbe", jobId }                — read-only: one Make twilight job seen from the editing account
//     (part, listing, lineage, run state, download), nothing changed upstream
//   { op: "repairFrameCollisions", slug?, apply? } — frames that overwrote each other (src/lib/frame-collisions.ts).
//     Without apply (or without slug) a dry run: the plan for one listing, or every listing with a clash.
//     With slug + apply: true the repair runs for that listing.
//   { op: "setCover", slug, coverKey }            — pick the cover photo
//   { op: "setLinks", slug, links: [{ label, url }] } — tours and links under the gallery
//   { op: "deleteSection", slug, section }        — remove one named section's media rows
//   { op: "setLock", slug, locked }               — lock/unlock downloads
//   { op: "upsertInvoice", slug, stripeInvoiceId, status, amountDue?, hostedInvoiceUrl?, clientEmail?, propertyAddress? }
//     — attach a historical Stripe invoice to a listing (webhook only syncs NEW events)
//   { op: "deleteBooking", bookingId, deleteClient?, voidInvoice? } — remove a test or mistaken booking (+ its
//     jobs, payment events, invoice, and the listing when nothing else uses it; with deleteClient also the
//     client when nothing else is theirs). An issued invoice needs voidInvoice: true (the open Stripe invoice is
//     voided, a draft deleted, the open Titus checkout canceled). Refuses once paid, EXCEPT for the designated
//     test client (+studiotest@) with voidInvoice: true when the provider shows the object NOT paid (a synthetic
//     test event settled the row, no money moved): then it is closed and the rows go. Real money is refused.
//     A paid row whose Titus provider_id is not a UUID cannot be read back, so it is refused (409) unless
//     forceNonUuid: true (a synthetic id a legacy test delivered; nothing is asked of Titus either way).
//     Its additional shoots (booking_visits) go too, and their calendar events are deleted on the spot.
//     Every invoice on the booking follows these rules (its own and any row with booking_id = it: an add-on
//     invoice, a second shoot's own invoice, Oct 27 2026); all are checked before any is closed, and the
//     answer adds invoicesRemoved and voidedAll (every provider id closed).
//   { op: "setBookingStatus", bookingId, status, note? } — the admin's manual status control for an operator
//     (no admin session): requested (Unconfirmed) | confirmed | shot | delivered. Never cancels or restores:
//     those stay in the admin, where the invoice and calendar side effects run. Same rules as setBookingStatus.
//   { op: "calendarBackfill", apply? } — one calendar event per live booking (Oct 21 2026). Lists every
//     Unconfirmed or Confirmed booking of this environment from today on, whether it already has its own
//     event, and the hand-made events on the same day that name its street (the ones calendar.upsert merges
//     and deletes). Read-only unless apply: true, which queues calendar.upsert for every booking listed.
//   { op: "weatherRefresh" } — the forecast onto every upcoming shoot event now (Oct 26 2026), instead of at
//     the next three-hour slot: one calendar.weather job per booking plus one for the hand-made shoot events.
//   { op: "videoBackfill", days?, apply? } — Video board cards (Oct 26 2026) for bookings with a film or reel
//     that came in before the board existed: shoots from `days` ago (default 21) on, not canceled. A
//     listing with a client-visible film starts at Sent to client, otherwise In queue; raw video already
//     uploaded marks the footage in. Read-only unless apply: true.
//   { op: "dropboxFolders", apply? } — the Dropbox folder for every upcoming booking's listing (Oct 26 2026),
//     plus Photo and Video for listings that already have uploads. Read-only unless apply: true.
//   { op: "dropboxFinals", slug? | listingId? | since?, apply? } — delivered files not yet in a listing's
//     FINAL DELIVERY folder in Dropbox (src/lib/dropbox-mirror.ts): one listing, or every listing whose
//     delivery email went out since `since` (default the day it went live). Counts only unless apply: true,
//     which queues the copies (they wait quietly until Dropbox is connected)
//   { op: "discardDraftShoot", shootId? | slug?, extensions?, apply?, actor? } — Start over on an upload that never
//     reached Submit (src/lib/discard-upload.ts): the draft shoot, its files in storage, any Dropbox copy and its queued
//     copies. With slug, every draft shoot on that listing. With extensions (["arw", "dng"]) only those files go and
//     the shoot stays. A plan (counts) unless apply: true. Refuses a submitted shoot.
//   { op: "mergeListing", from? | fromSlug? | fromListingId?, into? | intoSlug? | intoListingId?, apply?,
//     allowDifferentClient?, actor?, reason? } — move everything on one listing onto another and delete the
//     empty source (src/lib/merge-listing.ts): bookings (street, a new calendar version), additional shoots,
//     invoices (property address), media, shoots, downloads, revisions, Video cards, film comments, inbound
//     messages, jobs, activity; the source's city, state, zip, notes and links only where the target has none.
//     ONE transaction. Queues calendar.upsert for the moved live bookings (Google emails the shooter an update),
//     a zip rebuild when media moved; never a client email, never Stripe. Refuses the same listing twice, two
//     clients (unless allowDifferentClient: true), NDA media onto a non-NDA listing, an upload still in editing.
//     A dry run (per-table counts, both clients, notices) unless apply: true. from / into take a slug or an id.
//   { op: "mergeShoot", fromShootId | from, intoShootId | into, apply?, allowRevisionLoss?, expect?, actor?, reason? }
//     — condense two shoots of ONE listing into one (src/lib/merge-shoot.ts): every frame client visible today on
//     either shoot stays (moved onto the kept shoot, approved + published + not held), every other frame of both is
//     deleted (rows only, files stay in storage), the merged shoot's files, Video cards, activity and job payloads
//     move, and the merged shoot is deleted. ONE transaction, then one zip rebuild; never an email, Slack or calendar.
//     Refuses two listings, the same shoot, a shoot uploading or in editing, kept filename clashes, revision notes on
//     frames that would go (unless allowRevisionLoss), film comments on them, and a plan that no longer matches
//     expect (the preview's fingerprint). A dry run (counts, kept and deleted filenames, conflicts) unless apply: true.
import { neon } from "@neondatabase/serverless";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "@/lib/activity";
import { BOOKING_STATUS_LABEL, isBookingStatus, isTimeConfirmed } from "@/lib/booking-status";
import { enqueueJobs, jobKey } from "@/lib/jobs-core";
import { enqueueBundleRebuild } from "@/lib/bundle-jobs";
import { isVideoBooking } from "@/lib/studio-pricing";
import { enqueueDropboxFolder } from "@/lib/dropbox-mirror";
import { isOtherEnv, rowEnv } from "@/lib/payments";
import { shooterInviteSpec } from "@/lib/shooter-invite";
import { findCollisions, repairCollisions } from "@/lib/frame-collisions";
import { carriedNotes, deleteVisitEventNow, eventIdFor, hasCalendarSync, legacyMatches, scheduleWeatherRefresh } from "@/lib/google-calendar";
import { inviteWhen } from "@/lib/shooter-invite";
import { currentEnv } from "@/lib/jobs-core";
import { hasMigrateToken } from "@/lib/operator-token";
import { discardDraftShoot } from "@/lib/discard-upload";
import { mergeListing } from "@/lib/merge-listing";
import { mergeShoot } from "@/lib/merge-shoot";
import { BUSINESS_TZ } from "@/lib/business";
import { TEST_CLIENT_RE } from "@/lib/payments-test";

// The revision intake dry run reads a thread, builds contact sheets and asks the model twice.
export const maxDuration = 300;

// Every Titus checkout id seen so far has been a UUID, and Titus answers a
// validation error (not a 404) for an id of another shape; that is an
// observation, not a documented guarantee. An UNPAID row whose provider_id is
// not one (a synthetic id a legacy test delivered) has nothing at Titus to
// cancel, so deleteBooking skips the call there. A PAID row with such an id
// cannot be proven unfunded, so it is refused unless the body says
// forceNonUuid: true.
const TITUS_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  if (!hasMigrateToken(request)) {
    return Response.json({ ok: false }, { status: 404 });
  }
  if (!process.env.DATABASE_URL) return Response.json({ ok: false, error: "no db" }, { status: 503 });
  const sql = neon(process.env.DATABASE_URL);
  const body = await request.json();

  try {
    if (body.op === "setTeam") {
      const results = [];
      for (const raw of body.emails as string[]) {
        const email = raw.trim().toLowerCase();
        const name = body.names?.[raw] ?? null;
        await sql`
          insert into clients (email, team, name) values (${email}, ${body.team}, ${name})
          on conflict (email) do update set
            team = excluded.team,
            name = coalesce(excluded.name, clients.name)`;
        results.push(email);
      }
      return Response.json({ ok: true, team: body.team, members: results });
    }

    if (body.op === "createListing") {
      const email = String(body.clientEmail).trim().toLowerCase();
      const client = await sql`select id from clients where email = ${email}`;
      if (!client.length) return Response.json({ ok: false, error: "client not found" }, { status: 404 });
      const slug =
        body.slug ||
        String(body.address).split(",")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const r = await sql`
        insert into listings (client_id, address, slug, shoot_date, download_locked)
        values (${client[0].id}, ${body.address}, ${slug}, ${body.shootDate ? new Date(body.shootDate) : null}, ${body.locked ?? true})
        on conflict (slug) do update set address = excluded.address
        returning id, slug`;
      return Response.json({ ok: true, listingId: r[0].id, slug: r[0].slug });
    }

    if (body.op === "addMedia") {
      const l = await sql`select id from listings where slug = ${body.slug}`;
      if (!l.length) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      const listingId = l[0].id;
      // replace is SCOPED: only (kind, revision, section) groups present in the
      // incoming payload are cleared. A video-only or single-section upload can
      // never wipe the rest of the gallery.
      if (body.replace) {
        const groups = new Map<string, { kind: string; rev: boolean; section: string | null }>();
        for (const f of body.files as { kind: string; revision?: boolean; section?: string | null }[]) {
          const section = f.section ?? null;
          groups.set(`${f.kind}:${Boolean(f.revision)}:${section ?? ""}`, { kind: f.kind, rev: Boolean(f.revision), section });
        }
        for (const g of groups.values()) {
          await sql`delete from media where listing_id = ${listingId} and kind = ${g.kind}
                    and coalesce(revision, false) = ${g.rev}
                    and coalesce(section, '') = ${g.section ?? ""}`;
        }
      }
      let n = 0;
      for (const f of body.files) {
        await sql`
          insert into media (listing_id, kind, r2_key, filename, bytes, sort, revision, section, published, held)
          values (${listingId}, ${f.kind}, ${f.r2Key}, ${f.filename}, ${f.bytes ?? null}, ${f.sort ?? n}, ${f.revision ?? false}, ${f.section ?? null}, ${f.published === true}, ${f.published !== true})`;
        n++;
      }
      // Default cover only if none chosen yet — never clobber a hand-picked one.
      if (body.coverKey) await sql`update listings set cover_key = coalesce(cover_key, ${body.coverKey}) where id = ${listingId}`;
      const count = await sql`select count(*)::int as n from media where listing_id = ${listingId}`;
      await enqueueBundleRebuild(listingId);
      return Response.json({ ok: true, added: n, totalMedia: count[0].n, listingId });
    }

    if (body.op === "setBookingStatus") {
      const bookingId = String(body.bookingId ?? "");
      const to = String(body.status ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return Response.json({ ok: false, error: "bookingId (uuid) required" }, { status: 400 });
      if (!isBookingStatus(to) || to === "canceled") return Response.json({ ok: false, error: "status must be requested, confirmed, shot or delivered" }, { status: 400 });
      const d = db();
      const b = await d.query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId) });
      if (!b) return Response.json({ ok: false, error: "booking not found" }, { status: 404 });
      if (isOtherEnv(b.env)) return Response.json({ ok: false, error: `this booking belongs to the ${rowEnv(b.env)} environment` }, { status: 409 });
      if (b.status === "canceled") return Response.json({ ok: false, error: "the booking is canceled; restore it in the admin" }, { status: 409 });
      if (b.status === to) return Response.json({ ok: true, unchanged: true, status: to });
      const from = b.status;
      const clearMoved = Boolean(b.clientRescheduledAt) && isTimeConfirmed(to);
      const calendarChange = isTimeConfirmed(from) !== isTimeConfirmed(to) || clearMoved;
      const version = calendarChange ? b.calendarVersion + 1 : b.calendarVersion;
      await d.update(schema.bookings).set({ status: to, calendarVersion: version, updatedAt: new Date(), ...(clearMoved ? { clientRescheduledAt: null, clientRescheduledFrom: null } : {}) }).where(eq(schema.bookings.id, bookingId));
      await logActivity({ actorEmail: "operator", action: "booking.status_set", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, from, to, version, note: typeof body.note === "string" ? body.note : null, via: "admin-api" } });
      const shooter = b.photographerEmail?.trim().toLowerCase() || null;
      const live = to !== "shot" && to !== "delivered";
      if (calendarChange) {
        await enqueueJobs([
          { kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", bookingId, version), bookingId, listingId: b.listingId, payload: { version } },
          ...(shooter && live && (b.desiredDate || b.startsAt) ? [shooterInviteSpec({ bookingId, listingId: b.listingId, version, email: shooter, method: "REQUEST" })] : []),
        ]);
      }
      return Response.json({ ok: true, bookingId, from, to, label: BOOKING_STATUS_LABEL[to], version, shooterInviteQueued: Boolean(calendarChange && shooter && live) });
    }

    if (body.op === "weatherRefresh") {
      if (!hasCalendarSync()) return Response.json({ ok: false, error: "the booking calendar sync is off here" }, { status: 409 });
      const queued = await scheduleWeatherRefresh(new Date(), { now: true });
      return Response.json({ ok: true, queued, note: "the cron's second pass runs them within a minute or two" });
    }

    if (body.op === "videoBackfill") {
      const d = db();
      const days = Math.min(120, Math.max(1, Number(body.days) || 21));
      const since = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - days * 86_400_000));
      const rows = await d.query.bookings.findMany({ columns: { id: true, listingId: true, serviceIds: true, status: true, desiredDate: true, env: true } });
      const env = currentEnv();
      const mine = rows.filter((b) => (env === "production" ? b.env == null || b.env === env : b.env === env) && b.status !== "canceled" && isVideoBooking(b.serviceIds) && (!b.desiredDate || b.desiredDate >= since));
      const existing = new Set((await d.query.videoProjects.findMany({ columns: { key: true } })).map((r) => r.key));
      const todo = mine.filter((b) => !existing.has(`booking:${b.id}`));
      const out: { bookingId: string; listingId: string; date: string | null; stage: string; footage: boolean }[] = [];
      for (const b of todo) {
        const [films, raw] = await Promise.all([
          d.query.media.findMany({ where: and(eq(schema.media.listingId, b.listingId), eq(schema.media.kind, "video"), eq(schema.media.published, true)), columns: { id: true } }),
          d.query.shoots.findMany({ where: eq(schema.shoots.listingId, b.listingId), columns: { id: true, submittedAt: true }, with: { files: { where: eq(schema.shootFiles.kind, "raw_video"), columns: { id: true } } } }),
        ]);
        const withRaw = raw.filter((s) => s.files.length);
        const stage = films.length ? "sent" : "queue";
        out.push({ bookingId: b.id, listingId: b.listingId, date: b.desiredDate, stage, footage: withRaw.length > 0 });
        if (body.apply === true) {
          await d
            .insert(schema.videoProjects)
            .values({ key: `booking:${b.id}`, listingId: b.listingId, bookingId: b.id, shootId: withRaw[0]?.id ?? null, stage, footageAt: withRaw.length ? withRaw[0].submittedAt ?? new Date() : null, stageChangedBy: "backfill", env: b.env ?? env })
            .onConflictDoNothing({ target: schema.videoProjects.key });
        }
      }
      return Response.json({ ok: true, applied: body.apply === true, since, candidates: mine.length, alreadyOnBoard: mine.length - todo.length, cards: out });
    }

    if (body.op === "dropboxFinals") {
      const { enqueueFinalSweep, FINALS_SINCE, planFinals } = await import("@/lib/dropbox-mirror");
      const { dropboxMirrorEnabled } = await import("@/lib/dropbox");
      let ids: string[];
      let since: Date | undefined;
      if (typeof body.slug === "string" || typeof body.listingId === "string") {
        const l = await db().query.listings.findFirst({ where: typeof body.slug === "string" ? eq(schema.listings.slug, body.slug) : eq(schema.listings.id, String(body.listingId)), columns: { id: true } });
        if (!l) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
        ids = [l.id];
      } else {
        since = typeof body.since === "string" ? new Date(body.since) : new Date(FINALS_SINCE);
        if (Number.isNaN(since.getTime())) return Response.json({ ok: false, error: "since must be an ISO date" }, { status: 400 });
        const rows = await sql`select id from listings where delivery_email_at is not null and delivery_email_at >= ${since.toISOString()}`;
        ids = rows.map((r) => String(r.id));
      }
      const plans = await planFinals(ids);
      const summary = { listings: plans.length, visible: plans.reduce((n, p) => n + p.visible, 0), due: plans.reduce((n, p) => n + p.due.length, 0), mirrorOnHere: dropboxMirrorEnabled() };
      if (!body.apply) return Response.json({ ok: true, ...summary });
      if (!dropboxMirrorEnabled()) return Response.json({ ok: false, error: "the Dropbox mirror is off here (production, or DROPBOX_MIRROR=on)", ...summary }, { status: 409 });
      const queued = ids.length === 1 && !since ? await enqueueFinalSweep({ listingId: ids[0] }) : await enqueueFinalSweep({ since });
      return Response.json({ ok: true, ...summary, sweepQueued: queued });
    }

    if (body.op === "editingHistory") {
      // Read only: each day frame's lineage upstream (labels per version), to
      // find a frame that came in as something other than its plain edit.
      const { editingHistory } = await import("@/lib/pipeline");
      return Response.json({ ok: true, frames: await editingHistory(String(body.shootId || "")) });
    }

    if (body.op === "restoreFrameVersion") {
      // { mediaId, versionUuid, apply: true }: that version becomes the photo
      // upstream and the frame's file (previous kept under replaced/).
      if (body.apply !== true) return Response.json({ ok: false, error: "send apply: true" }, { status: 400 });
      const { restoreFrameVersion } = await import("@/lib/pipeline");
      return Response.json({ ok: true, ...(await restoreFrameVersion(String(body.mediaId || ""), String(body.versionUuid || ""), typeof body.actor === "string" ? body.actor : "operator")) });
    }

    if (body.op === "deleteShootFrames") {
      // { shootId, filenames: [...] | prefix: "the business-…", apply?, actor? }:
      // frames of one shoot, matched by exact filename or a filename prefix.
      // Dry run lists them; apply: true deletes them the way the shoot page's
      // Delete does (src/lib/frame-publish.ts: rows only, files stay in storage).
      const shootId = String(body.shootId || "");
      const names = Array.isArray(body.filenames) ? body.filenames.map(String) : [];
      const prefix = typeof body.prefix === "string" ? body.prefix : "";
      if (!shootId || (!names.length && prefix.length < 3)) return Response.json({ ok: false, error: "shootId and filenames or a prefix (3+ characters) are required" }, { status: 400 });
      const rows = (await sql`select id, filename, qc_state, published, corrected from media where shoot_id = ${shootId} order by sort`) as { id: string; filename: string; qc_state: string; published: boolean; corrected: boolean }[];
      const hits = rows.filter((r) => (names.length ? names.includes(r.filename) : r.filename.startsWith(prefix)));
      if (body.apply !== true) return Response.json({ ok: true, dryRun: true, count: hits.length, of: rows.length, frames: hits });
      if (!hits.length) return Response.json({ ok: false, error: "no frames match" }, { status: 404 });
      const { deleteFrames } = await import("@/lib/frame-publish");
      const r = await deleteFrames(typeof body.actor === "string" ? body.actor : "operator", shootId, hits.map((h) => h.id));
      return Response.json({ ok: true, deleted: r.count, filenames: hits.map((h) => h.filename) });
    }

    if (body.op === "twilightPreset") {
      // The saved twilight preset, and whether the AutoHDR account can
      // open it (or a given { uuid }) right now. { uuid, apply: true } saves
      // it, after the same checks as Settings (a photo preset, no extra inputs).
      const { presetUuidFrom, saveTwilightPreset, twilightPreset } = await import("@/lib/twilight-preset");
      const { getPreset } = await import("@/lib/autohdr");
      const saved = await twilightPreset();
      const uuid = typeof body.uuid === "string" ? presetUuidFrom(body.uuid) : saved?.uuid ?? null;
      if (!uuid) return Response.json({ ok: true, saved, check: null });
      try {
        const check = await getPreset(uuid);
        if (body.apply !== true) return Response.json({ ok: true, saved, check });
        if (check.makesClip || check.extraPorts) return Response.json({ ok: false, error: "not a plain photo preset", check }, { status: 409 });
        await saveTwilightPreset({ uuid: check.uuid, name: check.name, creditCost: check.creditCost, savedBy: typeof body.actor === "string" ? body.actor : "operator" });
        await logActivity({ actorEmail: typeof body.actor === "string" ? body.actor : null, action: "twilight.preset_saved", meta: { name: check.name, credits: check.creditCost } });
        return Response.json({ ok: true, saved: await twilightPreset(), check });
      } catch (e) {
        return Response.json({ ok: true, saved, check: { uuid, error: e instanceof Error ? e.message : String(e), status: (e as { status?: number }).status ?? null } });
      }
    }

    if (body.op === "r2RawCleanup") {
      // Raws in R2 by state (ready to check, waiting for editing, not in
      // Dropbox yet, already removed), and the checks that kept a file. apply
      // queues a sweep now instead of waiting for the next 15 minutes.
      const { enqueueRawSweepNow, rawCleanupStatus } = await import("@/lib/r2-raw-cleanup");
      const { dropboxMirrorEnabled } = await import("@/lib/dropbox");
      const states = await rawCleanupStatus();
      const kept = await sql`select payload->>'shootFileId' as file, last_error, updated_at from jobs where kind = 'r2.raw_cleanup' and last_error like 'skipped: kept in R2%' order by updated_at desc limit 50`;
      if (!body.apply) return Response.json({ ok: true, states, kept, mirrorOnHere: dropboxMirrorEnabled() });
      if (!dropboxMirrorEnabled()) return Response.json({ ok: false, error: "the Dropbox mirror is off here (production, or DROPBOX_MIRROR=on)", states }, { status: 409 });
      return Response.json({ ok: true, states, kept, sweepQueued: await enqueueRawSweepNow() });
    }

    if (body.op === "dropboxFolders") {
      const d = db();
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const env = currentEnv();
      const rows = await d.query.bookings.findMany({ columns: { id: true, listingId: true, status: true, desiredDate: true, env: true } });
      const upcoming = rows.filter((b) => (env === "production" ? b.env == null || b.env === env : b.env === env) && b.status !== "canceled" && b.desiredDate && b.desiredDate >= today);
      const listingIds = [...new Set(upcoming.map((b) => b.listingId))];
      const withUploads = new Set(listingIds.length ? (await d.query.shoots.findMany({ where: inArray(schema.shoots.listingId, listingIds), columns: { listingId: true, status: true } })).filter((s) => s.status !== "draft").map((s) => s.listingId) : []);
      let queued = 0;
      if (body.apply === true) {
        for (const id of listingIds) {
          queued += await enqueueDropboxFolder({ listingId: id });
          if (withUploads.has(id)) queued += await enqueueDropboxFolder({ listingId: id, subfolders: true, shootId: "backfill" });
        }
      }
      return Response.json({ ok: true, applied: body.apply === true, listings: listingIds.length, withUploads: withUploads.size, queued, note: body.apply === true ? "the cron's background pass makes them once Dropbox is connected" : "dry run; send apply: true" });
    }

    if (body.op === "calendarBackfill") {
      const d = db();
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const rows = await d.query.bookings.findMany({
        where: and(eq(schema.bookings.env, currentEnv()), inArray(schema.bookings.status, ["requested", "confirmed"])),
        with: { listing: { columns: { address: true } }, client: { columns: { name: true } } },
      });
      const live = rows.filter((b) => (b.desiredDate ?? (b.startsAt ? b.startsAt.toISOString().slice(0, 10) : "")) >= today);
      const report = [];
      for (const b of live) {
        const when = inviteWhen(b);
        const day = when ? (when.allDay ? when.date : new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(when.start)) : null;
        const matches = hasCalendarSync() && day && b.listing?.address ? await legacyMatches(b.listing.address, day) : [];
        report.push({
          bookingId: b.id,
          address: b.listing?.address ?? null,
          client: b.client?.name ?? null,
          status: b.status,
          when: when ? (when.allDay ? `${when.date} (all day)` : when.start.toISOString()) : null,
          linked: Boolean(b.calendarEventId),
          eventId: eventIdFor(b.id),
          handMade: matches.map((e) => ({ id: e.id, title: e.summary ?? null, start: e.start?.dateTime ?? e.start?.date ?? null, notes: carriedNotes(e).slice(0, 300) })),
          action: matches.length > 1 ? "upsert; team told to remove the extra hand-made events" : matches.length === 1 ? "upsert; merge and delete the hand-made event" : "upsert",
        });
      }
      let queued = 0;
      if (body.apply === true) {
        if (!hasCalendarSync()) return Response.json({ ok: false, error: "calendar sync is off in this environment" }, { status: 409 });
        for (const b of live) {
          const version = b.calendarVersion + 1;
          await d.update(schema.bookings).set({ calendarVersion: version, updatedAt: new Date() }).where(eq(schema.bookings.id, b.id));
          queued += await enqueueJobs([{ kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", b.id, version), bookingId: b.id, listingId: b.listingId, payload: { version } }]);
        }
      }
      return Response.json({ ok: true, env: currentEnv(), sync: hasCalendarSync(), count: report.length, applied: body.apply === true, queued, report });
    }

    if (body.op === "setCover") {
      const r = await sql`update listings set cover_key = ${body.coverKey} where slug = ${body.slug} returning id`;
      if (!r.length) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      return Response.json({ ok: true });
    }

    if (body.op === "listListings") {
      const email = body.clientEmail ? String(body.clientEmail).trim().toLowerCase() : null;
      const rows = email
        ? await sql`
            select l.id, l.address, l.slug, l.shoot_date, l.download_locked, l.cover_key, l.share_token, l.nda,
                   c.email as client_email, c.name as client_name, c.team,
                   (select count(*)::int from media m where m.listing_id = l.id) as media_count
            from listings l join clients c on c.id = l.client_id
            where c.email = ${email} order by l.address`
        : await sql`
            select l.id, l.address, l.slug, l.shoot_date, l.download_locked, l.cover_key, l.share_token, l.nda,
                   c.email as client_email, c.name as client_name, c.team,
                   (select count(*)::int from media m where m.listing_id = l.id) as media_count
            from listings l join clients c on c.id = l.client_id order by l.address`;
      return Response.json({ ok: true, listings: rows });
    }

    if (body.op === "inspectMedia") {
      const l = await db().query.listings.findFirst({ where: eq(schema.listings.slug, String(body.slug || "")), columns: { id: true, slug: true, address: true, coverKey: true } });
      if (!l) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      const media = await sql`
        select id, filename, r2_key, kind, section, sort, shoot_id, editor_image_id, published, qc_state, corrected, bytes, created_at
          from media where listing_id = ${l.id} order by section nulls first, sort, created_at`;
      const shoots = await sql`select id, status, autohdr_photoshoot_id, photo_count, published_at, created_at from shoots where listing_id = ${l.id} order by created_at`;
      const notes = await sql`
        select i.media_id, i.filename, i.note, i.updated_at, r.status, r.client_email
          from revision_items i join revision_requests r on r.id = i.request_id
         where i.listing_id = ${l.id} order by i.created_at`;
      return Response.json({ ok: true, listing: l, media, shoots, revisionNotes: notes });
    }

    if (body.op === "inspectJobs") {
      // Read-only (Oct 28 2026): this environment's job rows on one listing,
      // payload included, so an operator can see what a stuck job knows (a
      // twilight.frame's upstream run id, for one), plus each shoot's full
      // progress (the editing parts and their image ids). { slug, kind?, limit? }
      const l = await db().query.listings.findFirst({ where: eq(schema.listings.slug, String(body.slug || "")), columns: { id: true, slug: true } });
      if (!l) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      const kind = typeof body.kind === "string" && body.kind ? body.kind : null;
      const limit = Math.min(Math.max(1, Number(body.limit) || 50), 200);
      const rows = await sql`
        select id, kind, status, attempts, max_attempts, run_at, last_error, payload, booking_id, created_at, updated_at, done_at
          from jobs where env = ${currentEnv()} and listing_id = ${l.id} and (${kind}::text is null or kind = ${kind})
         order by created_at desc limit ${limit}`;
      const jobs = rows;
      const shoots = await sql`
        select id, status, options, progress, autohdr_photoshoot_id, autohdr_job_id, error, photo_count, created_at
          from shoots where listing_id = ${l.id} order by created_at`;
      return Response.json({ ok: true, listing: l, jobs, shoots });
    }

    if (body.op === "photoEditingReady") {
      // Send the #photo-editing copy of a shoot's "ready for review" line
      // again (Oct 30 2026): for a shoot that reached review before that copy
      // shipped, or while the webhook was down. Posts to #photo-editing only,
      // never to the hub, and only for a shoot that is in review or past it.
      // { shootId }
      const shootId = String(body.shootId || "");
      const shoot = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), with: { listing: { columns: { address: true, nda: true } } } });
      if (!shoot) return Response.json({ ok: false, error: "shoot not found" }, { status: 404 });
      if (!["ready_for_review", "published"].includes(shoot.status)) return Response.json({ ok: false, error: `shoot is ${shoot.status}, not ready for review` }, { status: 409 });
      const { hasSlackPhotoEditing, photoEditingShootReady } = await import("@/lib/slack");
      if (!hasSlackPhotoEditing()) return Response.json({ ok: false, error: "SLACK_PHOTO_EDITING_WEBHOOK_URL is not set" }, { status: 503 });
      const { qcSummaryLine } = await import("@/lib/qc");
      const tw = (shoot.progress as { twilight?: { jobs?: { status?: string }[] } } | null)?.twilight?.jobs ?? [];
      const posted = await photoEditingShootReady({
        shootId: shoot.id,
        listing: shoot.listing,
        photoCount: shoot.photoCount,
        twilightCount: tw.filter((j) => j.status === "done").length,
        qcLine: shoot.qcSummary ? qcSummaryLine(shoot.qcSummary) : null,
      });
      return Response.json({ ok: posted, posted, shootId: shoot.id, status: shoot.status });
    }

    if (body.op === "shooterPay") {
      // Read-only (Nov 10 2026): what a creative specialist has shot, with
      // each booking's invoice (amount, status, paid date) so their share of
      // collected revenue can be worked out. Bookings and return visits
      // assigned to that email, canceled ones left out. { email, since? }
      const email = String(body.email || "").trim().toLowerCase();
      if (!email) return Response.json({ ok: false, error: "email required" }, { status: 400 });
      const since = typeof body.since === "string" && body.since ? body.since : "2026-01-01";
      const bookings = await sql`
        select b.id, b.status, b.desired_date, b.start_time, b.services_label, b.service_ids, b.addon_ids, b.photographer_email, b.created_at,
               l.address, l.slug, l.delivery_email_at,
               i.id as invoice_id, i.provider, i.status as invoice_status, i.method, i.amount_cents, i.paid_at, i.refunded_cents
          from bookings b join listings l on l.id = b.listing_id
          left join invoices i on i.id = b.invoice_id
         where lower(b.photographer_email) = ${email} and b.status <> 'canceled' and b.desired_date >= ${since}
         order by b.desired_date, b.start_time`;
      const visits = await sql`
        select v.*, l.address, l.slug, i.status as invoice_status, i.amount_cents, i.paid_at
          from booking_visits v join listings l on l.id = v.listing_id
          left join bookings b on b.id = v.booking_id
          left join invoices i on i.id = b.invoice_id
         where lower(v.photographer_email) = ${email} and v.status <> 'canceled' and v.desired_date >= ${since}
         order by v.desired_date`;
      return Response.json({ ok: true, email, since, bookings, visits });
    }

    if (body.op === "videoCards") {
      // Read-only (Nov 5 2026): every Video card of this environment with its
      // stage, footage stamp, last move and open revision, to check the
      // automatic moves without the board. { stage? }
      const rows = await sql`
        select v.id, v.stage, v.key, v.assignee, v.shoot_id, v.footage_at, v.stage_changed_at, v.stage_changed_by, v.revision_request_id, v.revision_round, v.created_at,
               l.address, l.slug, l.dropbox_folder, l.dropbox_video_link, r.status as revision_status,
               (select count(*)::int from media m where m.listing_id = v.listing_id and m.kind = 'video' and m.published) as films_live
          from video_projects v join listings l on l.id = v.listing_id
          left join revision_requests r on r.id = v.revision_request_id
         where (v.env = ${currentEnv()} or (${currentEnv()} = 'production' and v.env is null))
           and (${body.stage ? String(body.stage) : null}::text is null or v.stage = ${body.stage ? String(body.stage) : null})
         order by v.stage, v.stage_changed_at`;
      return Response.json({ ok: true, cards: rows });
    }

    if (body.op === "dropboxVideoLink") {
      // The Video folder's share link for one listing (Nov 5 2026): what is
      // saved, and a fresh ask to Dropbox (saved when it answers; the error
      // tag when it refuses, "banned_member" while the account is blocked).
      // { slug }
      const l = await db().query.listings.findFirst({ where: eq(schema.listings.slug, String(body.slug || "")), columns: { id: true, address: true, dropboxFolder: true, dropboxVideoLink: true } });
      if (!l) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      const { retryVideoLinks } = await import("@/lib/dropbox-mirror");
      const before = { folder: l.dropboxFolder, link: l.dropboxVideoLink };
      const r = l.dropboxFolder && !l.dropboxVideoLink ? await retryVideoLinks({ listingId: l.id, max: 1 }) : null;
      const after = await db().query.listings.findFirst({ where: eq(schema.listings.id, l.id), columns: { dropboxVideoLink: true } });
      return Response.json({ ok: true, before, link: after?.dropboxVideoLink ?? null, tried: r?.tried ?? 0, banned: r?.banned ?? false, error: r?.error ?? null });
    }

    if (body.op === "dropboxShootLink") {
      // A view link to the Dropbox folder(s) holding one shoot's raw copies
      // (Nov 10 2026, 3330 Example Cedar: the hand-off to the editing service
      // failed and the owner needed the raws as a link an outside editor can
      // open). The folder is whatever the mirror used: Photo or Video, or the
      // dropped folder's own name (shoot_files.dropbox_dir). A link Dropbox
      // already has is reused, never replaced. { shootId, ndaOk? }
      const shootId = String(body.shootId || "");
      const s = await db().query.shoots.findFirst({ where: eq(schema.shoots.id, shootId), columns: { id: true, listingId: true }, with: { listing: { columns: { address: true, dropboxFolder: true, nda: true } } } });
      if (!s) return Response.json({ ok: false, error: "shoot not found" }, { status: 404 });
      if (!s.listing?.dropboxFolder) return Response.json({ ok: false, error: "the listing has no Dropbox folder yet" }, { status: 409 });
      if (s.listing.nda && body.ndaOk !== true) return Response.json({ ok: false, error: "NDA listing; pass ndaOk: true only on the owner's say-so" }, { status: 409 });
      const files = await sql`select kind, dropbox_dir, dropbox_path from shoot_files where shoot_id = ${shootId}`;
      const { dropboxApi, mirrorSubfolder } = await import("@/lib/dropbox");
      const folder = s.listing.dropboxFolder;
      const dirs = new Map<string, { files: number; mirrored: number }>();
      for (const f of files) {
        const p = f.dropbox_dir ? `${folder}/${String(f.dropbox_dir)}` : `${folder}/${mirrorSubfolder(String(f.kind))}`;
        const cur = dirs.get(p) ?? { files: 0, mirrored: 0 };
        cur.files++;
        if (f.dropbox_path) cur.mirrored++;
        dirs.set(p, cur);
      }
      const api = dropboxApi();
      const links: { path: string; files: number; mirrored: number; link: string | null }[] = [];
      for (const [path, n] of dirs) links.push({ path, ...n, link: await api.sharedLink(path) });
      await sql`insert into activity (actor_email, action, listing_id, meta)
                values (${body.actor ?? null}, 'dropbox.shoot_link', ${s.listingId}, ${JSON.stringify({ shootId, links: links.map((x) => ({ path: x.path, link: x.link })) })}::jsonb)`;
      return Response.json({ ok: true, address: s.listing.address, folder, links });
    }

    if (body.op === "videoEditingReady") {
      // Post a shoot's #video-editing line (Nov 1 2026) now: for a shoot
      // whose clips landed before the line shipped, or while the webhook was
      // down. Only when every clip of the shoot is in Dropbox. { shootId }
      const { hasSlackVideoEditing, videoEditingShootReady } = await import("@/lib/slack");
      if (!hasSlackVideoEditing()) return Response.json({ ok: false, error: "SLACK_VIDEO_EDITING_WEBHOOK_URL is not set" }, { status: 503 });
      const { videoEditingLineFor } = await import("@/lib/video-board");
      const line = await videoEditingLineFor(String(body.shootId || ""));
      if (!line) return Response.json({ ok: false, error: "shoot not found, no clips, or a clip is not in Dropbox yet" }, { status: 409 });
      await videoEditingShootReady(line);
      return Response.json({ ok: true, posted: true, clips: line.clips, cardId: line.cardId });
    }

    if (body.op === "twilightProbe") {
      // Read-only (Oct 28 2026): one Make twilight job from the editing
      // account's side: part, listing, lineage, run state, download. { jobId }
      const { probeFrameTwilight } = await import("@/lib/pipeline");
      return Response.json({ ok: true, ...(await probeFrameTwilight(String(body.jobId || ""))) });
    }

    if (body.op === "repairFrameCollisions") {
      const slug = body.slug ? String(body.slug) : null;
      const l = slug ? await db().query.listings.findFirst({ where: eq(schema.listings.slug, slug), columns: { id: true } }) : null;
      if (slug && !l) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      if (!l || body.apply !== true) return Response.json({ ok: true, dryRun: true, groups: await findCollisions(l ? { listingId: l.id } : {}) });
      const r = await repairCollisions(l.id, typeof body.actor === "string" ? body.actor : "operator");
      return Response.json({ ok: true, dryRun: false, ...r });
    }

    if (body.op === "inspectListings") {
      // Read-only: everything that hangs off a listing, so an operator can see
      // what a delete would touch. { slugs: [..] } or { ids: [..] }.
      const slugs = Array.isArray(body.slugs) ? body.slugs.map(String) : [];
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const rows = await sql`
        select l.id, l.slug, l.address, l.shoot_date, l.download_locked, c.email as client_email, c.name as client_name,
               (select count(*)::int from media m where m.listing_id = l.id) as media,
               (select count(*)::int from shoots s where s.listing_id = l.id) as shoots,
               (select count(*)::int from revision_requests r where r.listing_id = l.id) as revisions,
               (select count(*)::int from downloads d where d.listing_id = l.id) as downloads
          from listings l join clients c on c.id = l.client_id
         where l.slug = any(${slugs}) or l.id::text = any(${ids})`;
      const out = [];
      for (const l of rows) {
        const bookings = await sql`
          select b.id, b.status, b.desired_date, b.start_time, b.env, b.created_at, b.invoice_id,
                 i.provider, i.provider_id, i.status as invoice_status, i.amount_cents, i.method
            from bookings b left join invoices i on i.id = b.invoice_id
           where b.listing_id = ${l.id} order by b.created_at`;
        const invoices = await sql`
          select id, provider, provider_id, status, amount_cents, method, booking_id, env
            from invoices where listing_id = ${l.id} order by created_at`;
        out.push({ ...l, bookings, invoices });
      }
      return Response.json({ ok: true, listings: out });
    }

    if (body.op === "revisionIntakeDryRun") {
      // Read-only: what the revision intake would decide, nothing stored or
      // filed. { phone | conversationId, since, until? } reads that thread from
      // Quo (client texts in [since, until) are NEW); { inboundIds } uses stored texts.
      const { batchFromQuo, batchFromRows, decide, describe } = await import("@/lib/revision-intake");
      let batch;
      if (Array.isArray(body.inboundIds) && body.inboundIds.length) {
        const rows = await db().query.inboundMessages.findMany({ where: inArray(schema.inboundMessages.id, body.inboundIds.map(String)) });
        if (!rows.length) return Response.json({ ok: false, error: "no such inbound texts" }, { status: 404 });
        batch = await batchFromRows(rows.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime()));
      } else if ((typeof body.phone === "string" || typeof body.conversationId === "string") && typeof body.since === "string") {
        const since = new Date(body.since);
        let people: string[] | null = typeof body.phone === "string" ? [body.phone] : null;
        if (!people) {
          const { quoConversationParticipants } = await import("@/lib/quo");
          people = await quoConversationParticipants(String(body.conversationId), new Date(since.getTime() - 30 * 86_400_000));
          if (!people) return Response.json({ ok: false, error: "no such conversation in the last 30 days" }, { status: 404 });
        }
        batch = await batchFromQuo(people, since, typeof body.until === "string" ? new Date(body.until) : undefined);
      } else {
        return Response.json({ ok: false, error: "phone or conversationId + since, or inboundIds" }, { status: 400 });
      }
      const started = Date.now();
      const decision = await decide(batch);
      return Response.json({
        ok: true,
        ms: Date.now() - started,
        messages: batch.messages.map((m) => ({ at: m.at, outgoing: m.outgoing, isNew: m.isNew, chars: m.text.length, photos: m.media.length })),
        decision: describe(decision),
      });
    }

    if (body.op === "inboundBackfill") {
      // Texts Quo received before the webhook existed (or missed): every
      // incoming text on the business line since `since`. Without apply: a count.
      // With apply: stored like a webhook delivery and queued for the intake.
      const { quoConversationsSince, quoThread } = await import("@/lib/quo");
      if (typeof body.since !== "string") return Response.json({ ok: false, error: "since (ISO date) required" }, { status: 400 });
      const since = new Date(body.since);
      const convs = await quoConversationsSince(since);
      const found: { id: string; from: string | null; at: string | null; conversationId: string; text: string; media: { url: string; type: string | null }[]; to: string | null }[] = [];
      for (const c of convs) {
        const parts = c.participants ?? [];
        if (!parts.length) continue;
        for (const m of await quoThread(parts, since)) {
          if (m.direction === "outgoing") continue;
          found.push({ id: m.id, from: m.from ?? null, at: m.createdAt ?? null, conversationId: c.id, text: typeof m.text === "string" ? m.text : typeof m.body === "string" ? m.body : "", media: (m.media ?? []).filter((x) => x.url).map((x) => ({ url: x.url!, type: x.type ?? null })), to: Array.isArray(m.to) ? m.to[0] ?? null : m.to ?? null });
        }
      }
      const known = found.length ? await db().query.inboundMessages.findMany({ where: and(eq(schema.inboundMessages.source, "quo"), inArray(schema.inboundMessages.externalId, found.map((f) => f.id))), columns: { externalId: true } }) : [];
      const seen = new Set(known.map((k) => k.externalId));
      const fresh = found.filter((f) => !seen.has(f.id));
      if (!body.apply) return Response.json({ ok: true, conversations: convs.length, incoming: found.length, alreadyStored: found.length - fresh.length, wouldStore: fresh.length });
      let stored = 0;
      for (const f of fresh) {
        const [row] = await db()
          .insert(schema.inboundMessages)
          .values({ source: "quo", externalId: f.id, conversationId: f.conversationId, fromAddr: f.from, toAddr: f.to, body: f.text, media: f.media, sentAt: f.at ? new Date(f.at) : null, env: currentEnv(), raw: { backfill: true } })
          .onConflictDoNothing({ target: [schema.inboundMessages.source, schema.inboundMessages.externalId] })
          .returning({ id: schema.inboundMessages.id });
        if (!row) continue;
        stored++;
        await enqueueJobs([{ kind: "inbound.revision", idempotencyKey: jobKey("inbound.revision", row.id), payload: { version: 1, inboundId: row.id } }]);
      }
      // Texts stored before the intake existed have no job yet: queue every
      // "new" one (the idempotency key makes a repeat a no-op).
      const waiting = await db().query.inboundMessages.findMany({ where: and(eq(schema.inboundMessages.status, "new"), eq(schema.inboundMessages.env, currentEnv())), columns: { id: true } });
      const requeued = await enqueueJobs(waiting.map((w) => ({ kind: "inbound.revision" as const, idempotencyKey: jobKey("inbound.revision", w.id), payload: { version: 1, inboundId: w.id } })));
      return Response.json({ ok: true, conversations: convs.length, incoming: found.length, stored, requeued });
    }

    if (body.op === "emailIntakePoll") {
      // One poll of hello@ now: new mail stored and queued for the intake. Counts only.
      const { emailIntakeStatus, hasEmailIntake, pollHello, recordPoll } = await import("@/lib/email-intake");
      // Only where the cron reads hello@ too: a message is read once in the shared
      // database, so a preview storing it would hide it from production.
      if (!hasEmailIntake()) return Response.json({ ok: false, error: "the email intake is off here (production, or EMAIL_INTAKE=on)" }, { status: 409 });
      try {
        const poll = await pollHello({ budgetMs: 45_000 });
        await recordPoll(null);
        return Response.json({ ok: true, poll, status: await emailIntakeStatus() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await recordPoll(msg).catch(() => null);
        return Response.json({ ok: false, error: msg }, { status: 502 });
      }
    }

    if (body.op === "inspectInbound") {
      // Read-only: what the Quo webhook (and later email) has stored. Counts by
      // source and status, and the newest rows without their text: the sender's
      // last four digits, body length, photo count.
      const counts = await sql`select source, status, count(*)::int as n from inbound_messages group by source, status order by source, status`;
      const latest = await sql`
        select id, source, status, env, right(coalesce(from_addr, ''), 4) as from_last4, length(coalesce(body, '')) as body_chars,
               coalesce(jsonb_array_length(media), 0) as photos, sent_at, received_at
        from inbound_messages order by received_at desc limit ${Math.min(Number(body.limit) || 10, 50)}`;
      return Response.json({ ok: true, counts, latest });
    }

    if (body.op === "rebuildBundles") {
      // Queue "Download all" zip rebuilds (src/lib/bundles.ts): { slug } for one
      // listing, or { withSections: true } for every listing whose client-visible
      // media include a section or revision photo, or any film (what the Oct 27
      // 2026 fixes added to the zips). { slug, inline: true } queues it and
      // works on it here, as the cron's zip pass would (one rebuild per
      // listing at a time, the same job row): it answers with the counts per
      // folder when the rebuild finished in this request, and with
      // finished: false when the listing needs more runs (the cron carries on).
      const { enqueueBundleRebuild } = await import("@/lib/bundle-jobs");
      let ids: string[] = [];
      if (typeof body.slug === "string") {
        const l = await db().query.listings.findFirst({ where: eq(schema.listings.slug, body.slug), columns: { id: true } });
        if (!l) return Response.json({ ok: false, error: "no such listing" }, { status: 404 });
        ids = [l.id];
        if (body.inline === true) {
          const { BUNDLE_KINDS } = await import("@/lib/bundle-jobs");
          const { drainJobs } = await import("@/lib/jobs");
          await enqueueBundleRebuild(l.id);
          const drained = await drainJobs({ kinds: BUNDLE_KINDS, listingId: l.id, budgetMs: 250_000, limit: 20 });
          const rows = await sql`
            select id, status, last_error, payload -> 'bundle' as bundle from jobs
             where env = ${currentEnv()} and kind = 'bundle.rebuild' and listing_id = ${l.id} order by created_at desc limit 1`;
          const bundle = (rows[0]?.bundle ?? null) as { done?: boolean; built?: unknown; zips?: number; bytes?: number; runs?: number; ms?: number; z?: number } | null;
          const finished = rows[0]?.status === "done" && bundle?.done === true;
          return Response.json({
            ok: true,
            finished,
            rebuilt: finished ? (bundle?.built ?? null) : null,
            progress: bundle ? { zipsDone: bundle.z ?? 0, zips: bundle.zips ?? null, bytes: bundle.bytes ?? 0, runs: bundle.runs ?? 0, ms: bundle.ms ?? 0 } : null,
            note: finished ? null : String(rows[0]?.last_error ?? "queued; the cron's zip pass carries on"),
            worked: drained.worked,
          });
        }
      } else if (body.withSections === true) {
        // Films joined the zips (and every area its own zip) after #48: a listing with a film counts too.
        const rows = await sql`select distinct listing_id from media where qc_state = 'approved' and published = true and ((kind = 'photo' and (section is not null or revision = true)) or kind = 'video')`;
        ids = rows.map((r) => String(r.listing_id));
      } else {
        return Response.json({ ok: false, error: "slug, or withSections: true" }, { status: 400 });
      }
      for (const id of ids) await enqueueBundleRebuild(id);
      return Response.json({ ok: true, queued: ids.length });
    }

    if (body.op === "listClients") {
      // Read-only roster: every client row with its team slug and listing count.
      const rows = await sql`
        select c.id, c.email, c.name, c.company, c.phone, c.team, c.created_at,
               (select count(*)::int from listings l where l.client_id = c.id) as listing_count
        from clients c order by c.team nulls last, c.email`;
      return Response.json({ ok: true, clients: rows });
    }

    if (body.op === "setLinks") {
      // links: [{ label, url }] — stored as JSON, rendered under the gallery.
      const r = await sql`update listings set links = ${JSON.stringify(body.links ?? [])} where slug = ${body.slug} returning id`;
      if (!r.length) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      return Response.json({ ok: true, slug: body.slug, links: body.links ?? [] });
    }

    if (body.op === "deleteSection") {
      const l = await sql`select id from listings where slug = ${body.slug}`;
      if (!l.length) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      const r = await sql`delete from media where listing_id = ${l[0].id} and section = ${body.section} returning id`;
      if (r.length) await enqueueBundleRebuild(l[0].id);
      return Response.json({ ok: true, removed: r.length, section: body.section });
    }

    if (body.op === "setLock") {
      const r = await sql`update listings set download_locked = ${Boolean(body.locked)} where slug = ${body.slug} returning id`;
      if (!r.length) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      return Response.json({ ok: true, slug: body.slug, locked: Boolean(body.locked) });
    }

    if (body.op === "updateListing") {
      // Rename a listing's display address (and optionally its slug). Slug
      // changes are opt-in because share links and portal URLs carry it.
      const l = await sql`select id, address, slug from listings where slug = ${body.slug}`;
      if (!l.length) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      const address = body.address ? String(body.address).trim() : l[0].address;
      const slug = body.newSlug ? String(body.newSlug).trim() : l[0].slug;
      const r = await sql`
        update listings set address = ${address}, slug = ${slug}
        where id = ${l[0].id}
        returning id, address, slug`;
      return Response.json({ ok: true, before: { address: l[0].address, slug: l[0].slug }, after: r[0] });
    }

    if (body.op === "upsertInvoice") {
      const l = await sql`select id from listings where slug = ${body.slug}`;
      if (!l.length) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      await sql`
        insert into invoices (stripe_invoice_id, listing_id, client_email, property_address, status, amount_due, hosted_invoice_url, updated_at)
        values (${body.stripeInvoiceId}, ${l[0].id}, ${body.clientEmail ?? null}, ${body.propertyAddress ?? null},
                ${body.status}, ${body.amountDue ?? null}, ${body.hostedInvoiceUrl ?? null}, now())
        on conflict (stripe_invoice_id) do update set
          listing_id = excluded.listing_id,
          status = excluded.status,
          amount_due = excluded.amount_due,
          hosted_invoice_url = excluded.hosted_invoice_url,
          updated_at = now()`;
      return Response.json({ ok: true, attached: body.stripeInvoiceId, listingId: l[0].id });
    }

    if (body.op === "deleteBooking") {
      const bk = await sql`select id, listing_id, client_id, invoice_id from bookings where id = ${body.bookingId}`;
      if (!bk.length) return Response.json({ ok: false, error: "booking not found" }, { status: 404 });
      const b = bk[0];
      // One invoice row of the booking, closed at its provider for the delete
      // (the original single-invoice rules, unchanged). Returns the closed
      // provider id, null, or a refusal.
      const closeForDelete = async (inv: Record<string, unknown>[]): Promise<string | null | Response> => {
        let voided: string | null = null;
        const paidHere = inv.length > 0 && (inv[0].status === "paid" || inv[0].status === "paid_manual" || inv[0].status === "refunded");
        if (paidHere) {
          // The test harness settles a test row with a synthetic event while the
          // provider object stays open. Only the designated test client, only
          // with voidInvoice: true, and only when the provider itself shows the
          // object NOT paid: then it is closed and the rows may go. Anything
          // else that reads paid here is real money and stays refused.
          if (!testClient || !body.voidInvoice) return Response.json({ ok: false, error: "invoice already paid; refund it with the provider first" }, { status: 409 });
          if (inv[0].provider_id) {
            const key = (process.env.STRIPE_SECRET_KEY || "").trim();
            const titusKey = (process.env.TITUS_API_KEY || "").trim();
            if (inv[0].provider === "stripe") {
              if (!key) return Response.json({ ok: false, error: "paid here and no Stripe key to read the invoice back" }, { status: 409 });
              const { default: Stripe } = await import("stripe");
              const stripe = new Stripe(key);
              const s = await stripe.invoices.retrieve(String(inv[0].provider_id));
              if (s.status === "paid") return Response.json({ ok: false, error: "paid at Stripe for real; refund it with the provider first" }, { status: 409 });
              if (s.status === "draft") await stripe.invoices.del(String(inv[0].provider_id));
              else if (s.status === "open" || s.status === "uncollectible") await stripe.invoices.voidInvoice(String(inv[0].provider_id));
              voided = String(inv[0].provider_id);
            } else if (inv[0].provider === "titus") {
              if (!titusKey) return Response.json({ ok: false, error: "paid here and no Titus key to read the checkout back" }, { status: 409 });
              const { cancelCheckout, getCheckout, TitusApiError } = await import("@/lib/titus");
              const checkoutId = String(inv[0].provider_id);
              if (!TITUS_ID_RE.test(checkoutId)) {
                // Not a Titus id shape: Titus cannot say whether it is funded, so
                // nothing here can prove no money moved. Only an explicit
                // forceNonUuid: true (a synthetic id a legacy test delivered) lets
                // the rows go, and nothing is asked of Titus either way.
                if (body.forceNonUuid !== true) {
                  return Response.json({ ok: false, error: `paid here through provider_id ${checkoutId}, which is not a Titus checkout id (UUID), so Titus cannot confirm it is unfunded; pass forceNonUuid: true only for a synthetic test id` }, { status: 409 });
                }
              } else {
                let c: Awaited<ReturnType<typeof getCheckout>> | null = null;
                try {
                  c = await getCheckout(checkoutId);
                } catch (e) {
                  if (!(e instanceof TitusApiError && e.status === 404)) throw e;
                }
                if (c?.status === "succeeded") return Response.json({ ok: false, error: "funded at Titus for real; refund it with the provider first" }, { status: 409 });
                if (c && c.status !== "canceled") {
                  try {
                    await cancelCheckout(checkoutId);
                  } catch (e) {
                    if (!(e instanceof TitusApiError && (e.status === 404 || e.status === 409 || e.status === 422))) throw e;
                  }
                }
                voided = checkoutId;
              }
            } else {
              return Response.json({ ok: false, error: "paid here with an unknown provider" }, { status: 409 });
            }
          }
        } else if (inv.length && inv[0].provider_id && (inv[0].status === "void" || inv[0].status === "canceled")) {
          // Already closed at the provider (voided Stripe invoice, canceled Titus
          // checkout): nothing to call, the rows can go.
        } else if (inv.length && inv[0].provider_id) {
          // Issued at the provider. With voidInvoice: true an open Stripe invoice is
          // voided there first, or the open Titus checkout is canceled (step two).
          const key = (process.env.STRIPE_SECRET_KEY || "").trim();
          const titusKey = (process.env.TITUS_API_KEY || "").trim();
          if (body.voidInvoice && inv[0].provider === "stripe" && key) {
            const { default: Stripe } = await import("stripe");
            await new Stripe(key).invoices.voidInvoice(String(inv[0].provider_id));
            voided = String(inv[0].provider_id);
          } else if (body.voidInvoice && inv[0].provider === "titus" && titusKey) {
            const { cancelCheckout, TitusApiError } = await import("@/lib/titus");
            if (TITUS_ID_RE.test(String(inv[0].provider_id))) {
              try {
                await cancelCheckout(String(inv[0].provider_id));
              } catch (e) {
                // A checkout Titus already canceled or expired is fine to forget.
                if (!(e instanceof TitusApiError && (e.status === 404 || e.status === 409 || e.status === 422))) throw e;
              }
            }
            voided = String(inv[0].provider_id);
          } else {
            return Response.json({ ok: false, error: "invoice already issued; pass voidInvoice: true (Stripe or Titus) or cancel it with the provider first" }, { status: 409 });
          }
        }
        return voided;
      };
      // Every invoice on the booking: its own (bookings.invoice_id) and any
      // other row with booking_id = this booking (an add-on from Edit
      // booking, a second shoot's own invoice, Oct 27 2026). Each follows
      // the same rules; all are checked before anything is closed.
      const inv = await sql`select id, provider, provider_id, status from invoices where id = ${b.invoice_id ?? null} or booking_id = ${b.id} order by (id = ${b.invoice_id ?? null}) desc, created_at asc`;
      const cl = await sql`select email from clients where id = ${b.client_id}`;
      const testClient = TEST_CLIENT_RE.test(String(cl[0]?.email ?? ""));
      const isPaidRow = (r: Record<string, unknown>) => r.status === "paid" || r.status === "paid_manual" || r.status === "refunded";
      const isClosedRow = (r: Record<string, unknown>) => r.status === "void" || r.status === "canceled";
      // Pass 1, no provider calls: refuse real money and unvoided issued objects up front.
      for (const r of inv) {
        const which = r.id === b.invoice_id ? "invoice" : `invoice ${String(r.id)} (an extra invoice on this booking)`;
        if (isPaidRow(r)) {
          if (!testClient || !body.voidInvoice) return Response.json({ ok: false, error: `${which} already paid; refund it with the provider first` }, { status: 409 });
        } else if (r.provider_id && !isClosedRow(r)) {
          const hasKey = r.provider === "stripe" ? Boolean((process.env.STRIPE_SECRET_KEY || "").trim()) : r.provider === "titus" ? Boolean((process.env.TITUS_API_KEY || "").trim()) : false;
          if (!body.voidInvoice || !hasKey) return Response.json({ ok: false, error: `${which} already issued; pass voidInvoice: true (Stripe or Titus) or cancel it with the provider first` }, { status: 409 });
        }
      }
      // Pass 2: close each at its provider (closeForDelete above, per row).
      const voidedAll: string[] = [];
      for (const row of inv) {
        const one = [row];
        const closed = await closeForDelete(one);
        if (closed instanceof Response) return closed;
        if (closed) voidedAll.push(closed);
      }
      const voided: string | null = voidedAll[0] ?? null;
      const media = await sql`select count(*)::int as n from media where listing_id = ${b.listing_id}`;
      const shoots = await sql`select count(*)::int as n from shoots where listing_id = ${b.listing_id}`;
      const others = await sql`select count(*)::int as n from bookings where listing_id = ${b.listing_id} and id <> ${b.id}`;
      await sql`delete from jobs where booking_id = ${b.id}`;
      for (const r of inv) await sql`delete from jobs where invoice_id = ${r.id}`;
      // Additional shoots (Oct 27 2026): their events come off the hello@
      // calendar right here (Google tells each shooter; the queued jobs that
      // would have done it just went with the booking's jobs), then the rows.
      // A database the migrate route has not reached has no such table.
      const visitEvents: { id: string; result: string }[] = [];
      let visitsRemoved = 0;
      const visitTable = await sql`select to_regclass('public.booking_visits') as t`;
      if (visitTable[0]?.t) {
        const vs = await sql`select id from booking_visits where booking_id = ${b.id}`;
        for (const v of vs) {
          try {
            visitEvents.push({ id: String(v.id), result: await deleteVisitEventNow(String(v.id)) });
          } catch (e) {
            visitEvents.push({ id: String(v.id), result: `not deleted: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        const gone = await sql`delete from booking_visits where booking_id = ${b.id} returning id`;
        visitsRemoved = gone.length;
      }
      await sql`delete from bookings where id = ${b.id}`;
      for (const r of inv) {
        await sql`delete from payment_events where invoice_id = ${r.id}`;
        await sql`delete from invoices where id = ${r.id}`;
      }
      await sql`delete from activity where meta->>'bookingId' = ${b.id}`;
      let listingRemoved = false;
      if (media[0].n === 0 && shoots[0].n === 0 && others[0].n === 0) {
        await sql`delete from downloads where listing_id = ${b.listing_id}`;
        await sql`update invoices set listing_id = null where listing_id = ${b.listing_id}`;
        await sql`delete from activity where listing_id = ${b.listing_id}`;
        await sql`delete from listings where id = ${b.listing_id}`;
        listingRemoved = true;
      }
      let clientRemoved = false;
      if (body.deleteClient) {
        const left = await sql`
          select (select count(*)::int from listings where client_id = ${b.client_id})
               + (select count(*)::int from bookings where client_id = ${b.client_id})
               + (select count(*)::int from invoices where client_id = ${b.client_id}) as n`;
        if (left[0].n === 0) {
          await sql`delete from activity where client_id = ${b.client_id}`;
          await sql`delete from clients where id = ${b.client_id}`;
          clientRemoved = true;
        }
      }
      return Response.json({ ok: true, deleted: b.id, invoiceRemoved: inv.length > 0, invoicesRemoved: inv.length, voided, voidedAll, listingRemoved, clientRemoved, visitsRemoved, visitEvents });
    }

    if (body.op === "discardDraftShoot") {
      // Oct 30 2026 (the owner, 195 Example Oakleaf Road): an upload of raws paused and he
      // wanted to begin again with JPGs. The same wipe as the upload page's
      // Start over, for one shoot or every draft on a listing.
      let ids: string[] = typeof body.shootId === "string" && body.shootId ? [body.shootId] : [];
      if (!ids.length && typeof body.slug === "string" && body.slug) {
        const l = await db().query.listings.findFirst({ where: eq(schema.listings.slug, body.slug), columns: { id: true } });
        if (!l) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
        ids = (await db().query.shoots.findMany({ where: and(eq(schema.shoots.listingId, l.id), eq(schema.shoots.status, "draft")), columns: { id: true } })).map((s) => s.id);
      }
      if (!ids.length) return Response.json({ ok: false, error: "no draft shoot (pass shootId, or slug of a listing with one)" }, { status: 404 });
      const results = [];
      const extensions = Array.isArray(body.extensions) ? body.extensions.filter((e: unknown): e is string => typeof e === "string") : undefined;
      for (const shootId of ids) results.push({ shootId, ...(await discardDraftShoot({ shootId, actor: String(body.actor || "claude-token"), apply: body.apply === true, extensions })) });
      return Response.json({ ok: results.every((r) => r.ok), applied: body.apply === true, results });
    }

    if (body.op === "mergeListing") {
      // Oct 30 2026 (the owner, 2420 into 2320 Example Fir Road): a listing the
      // booking form made from a typo, merged into the real one. The same
      // code as the admin's Merge into another listing page.
      const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
      const ref = (v: string | null) => (v && /^[0-9a-f-]{36}$/i.test(v) ? { id: v, slug: null } : { id: null, slug: v });
      const f = ref(pick(body.fromListingId) ?? pick(body.fromSlug) ?? pick(body.from));
      const t = ref(pick(body.intoListingId) ?? pick(body.intoSlug) ?? pick(body.into));
      const plan = await mergeListing({
        fromListingId: f.id, fromSlug: f.slug, intoListingId: t.id, intoSlug: t.slug,
        apply: body.apply === true,
        allowDifferentClient: body.allowDifferentClient === true,
        actor: pick(body.actor) ?? "claude-token",
        reason: pick(body.reason),
      });
      const status = plan.refused.length && body.apply === true ? 409 : !plan.from || !plan.into ? 404 : 200;
      // ok: nothing refuses it (a dry run) or it ran (apply); the plan says which.
      return Response.json({ ...plan, ok: plan.refused.length === 0 }, { status });
    }

    if (body.op === "mergeShoot") {
      // Nov 5 2026 (the coordinator, 20 Dogwood): two shoots of one listing
      // condensed into one. The same code as the shoot page's Merge into
      // another shoot.
      const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
      const plan = await mergeShoot({
        fromShootId: pick(body.fromShootId) ?? pick(body.from),
        intoShootId: pick(body.intoShootId) ?? pick(body.into),
        apply: body.apply === true,
        allowRevisionLoss: body.allowRevisionLoss === true,
        expect: pick(body.expect),
        actor: pick(body.actor) ?? "claude-token",
        reason: pick(body.reason),
      });
      const status = plan.refused.length && body.apply === true ? 409 : !plan.from || !plan.into ? 404 : 200;
      return Response.json({ ...plan, ok: plan.refused.length === 0 }, { status });
    }

    if (body.op === "deleteListing") {
      // Same rules as the admin "Delete listing" button: refused while a booking
      // points at it (deleteBooking first); removes media, downloads, revision
      // requests and shoot rows; files in storage are never touched.
      const l = await sql`select id, address, client_id from listings where slug = ${body.slug}`;
      if (!l.length) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });
      const id = l[0].id;
      const bookings = await sql`select count(*)::int as n from bookings where listing_id = ${id}`;
      if (bookings[0].n > 0) return Response.json({ ok: false, error: "this listing has a booking; deleteBooking it first" }, { status: 409 });
      const media = await sql`select count(*)::int as n from media where listing_id = ${id}`;
      const shoots = await sql`select id from shoots where listing_id = ${id}`;
      await sql`delete from downloads where listing_id = ${id}`;
      await sql`delete from revision_requests where listing_id = ${id}`;
      await sql`update invoices set listing_id = null where listing_id = ${id}`;
      await sql`delete from media where listing_id = ${id}`;
      for (const s of shoots) await sql`delete from shoot_files where shoot_id = ${s.id}`;
      await sql`delete from shoots where listing_id = ${id}`;
      await sql`delete from listings where id = ${id}`;
      await sql`insert into activity (actor_email, action, client_id, meta)
                values (${body.actor ?? null}, 'listing.deleted', ${l[0].client_id}, ${JSON.stringify({ address: l[0].address, slug: body.slug, files: media[0].n, via: "operator", reason: body.reason ?? null })}::jsonb)`;
      return Response.json({ ok: true, deleted: body.slug, address: l[0].address, mediaRemoved: media[0].n, shootsRemoved: shoots.length });
    }

    return Response.json({ ok: false, error: "unknown op" }, { status: 400 });
  } catch (e) {
    console.error("admin-api:", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
