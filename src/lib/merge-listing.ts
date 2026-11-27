// Merge one listing into another (Oct 30 2026).
//
// the owner, 2420 Example Fir Rd: the booking form made a new listing from a
// typo in the client's address. It was the same house and the same client as
// 2320 Example Fir Road, which already had its media, and nothing in the
// app could move a booking (or anything else) from one listing to another.
// This moves every row that points at the source listing onto the target,
// then deletes the empty source:
//   - bookings (listing, the street in bookings.property, a new calendar
//     version) and their additional shoots (booking_visits);
//   - invoices (listing and property_address; the Stripe or Titus object is
//     never touched, payments still match by invoice id);
//   - media, shoots (their shoot_files follow the shoot), downloads,
//     revision requests and their per-photo notes, Video board cards and
//     film comments, inbound texts and emails, jobs (the column and a
//     payload.listingId) and the activity log;
//   - the source's city, state, zip, notes, links and cover go onto the
//     target only where the target has none. The target's shoot date, lock,
//     NDA flag, delivery and approval state stay as they are.
//   - bookings.raw (the form as the client sent it) is never changed.
// The writes run as ONE transaction (a neon-http batch): either everything
// moves and the source is gone, or nothing changed. Each booking moves only
// at the calendar version the plan read, so a booking edited in between
// stays on the source, its foreign key stops the delete, and the whole batch
// rolls back.
//
// Side effects, queued in the same transaction: calendar.upsert for every
// live booking that moved (the event title then names the target's street;
// Google emails the shooter on the event an update) and calendar.visit_upsert
// for its scheduled additional shoots. After it commits: a "download all"
// rebuild on the target when media moved. Never a client email, never a
// Stripe or Titus call.
//
// Refused: the same listing twice, a listing that is not there, two
// different clients (unless allowDifferentClient), NDA media onto a listing
// that is not NDA, and a source shoot still in editing.
//
// Called by the admin's "Merge into another listing" page
// (/admin/listings/<id>/merge, admins only) and the operator op mergeListing
// (src/app/api/portal/admin-api/route.ts). A dry run unless apply: true.
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { JobKind } from "@/db/schema";
import { gatesGallery } from "./invoice-kinds";
import { currentEnv, jobKey, jobRows, type JobSpec } from "./jobs-core";
import { isActive } from "./shoot-status";

// A row with no env was written before env existed: production (as payments.ts rowEnv).
const rowEnv = (env: string | null | undefined): string => env ?? "production";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAID = new Set(["paid", "paid_manual"]);
const CLOSED = new Set(["void", "canceled", "refunded"]);

export type MergeListingInput = {
  fromListingId?: string | null;
  fromSlug?: string | null;
  intoListingId?: string | null;
  intoSlug?: string | null;
  apply?: boolean;
  // Two listings of different clients: refused unless this is set. The
  // bookings and invoices keep their own client either way.
  allowDifferentClient?: boolean;
  actor?: string | null;
  reason?: string | null;
};

export type MergeSide = {
  id: string;
  slug: string;
  address: string;
  street: string;
  clientId: string;
  clientEmail: string | null;
  clientName: string | null;
  clientTeam: string | null;
  downloadLocked: boolean;
  shootDate: string | null;
  nda: boolean;
  city: string | null;
  state: string | null;
  zip: string | null;
  notes: string | null;
  links: string | null;
  coverKey: string | null;
  dropboxFolder: string | null;
};

// Rows that point at the source listing, per table.
export type MergeCounts = {
  bookings: number;
  bookingVisits: number;
  invoices: number;
  paymentEvents: number; // follow their invoice; nothing to change
  media: number;
  shoots: number;
  shootFiles: number; // follow their shoot; nothing to change
  downloads: number;
  revisionRequests: number;
  revisionItems: number;
  videoProjects: number;
  videoComments: number;
  inboundMessages: number;
  jobs: number;
  jobPayloads: number; // jobs whose payload.listingId names the source
  activity: number;
};

export const COUNT_LABELS: Record<keyof MergeCounts, { table: string; what: string; moves: boolean }> = {
  bookings: { table: "bookings", what: "Moved to the target; the street in the booking follows; a new calendar version. The form as sent stays as it was.", moves: true },
  bookingVisits: { table: "booking_visits", what: "Additional shoots move with their booking.", moves: true },
  invoices: { table: "invoices", what: "Moved to the target with its property address. Stripe and Titus are not touched.", moves: true },
  paymentEvents: { table: "payment_events", what: "Follow their invoice. Nothing to change.", moves: false },
  media: { table: "media", what: "Photos and films move to the target's gallery as they are (visibility unchanged).", moves: true },
  shoots: { table: "shoots", what: "Uploads move to the target.", moves: true },
  shootFiles: { table: "shoot_files", what: "Follow their shoot. Nothing to change.", moves: false },
  downloads: { table: "downloads", what: "Download history moves to the target.", moves: true },
  revisionRequests: { table: "revision_requests", what: "Revision requests move to the target.", moves: true },
  revisionItems: { table: "revision_items", what: "Per-photo revision notes move to the target.", moves: true },
  videoProjects: { table: "video_projects", what: "Video board cards move to the target.", moves: true },
  videoComments: { table: "video_comments", what: "Film review comments move to the target.", moves: true },
  inboundMessages: { table: "inbound_messages", what: "Texts and emails filed on the source move to the target.", moves: true },
  jobs: { table: "jobs", what: "Side-effect rows move to the target (queued ones then run for the target).", moves: true },
  jobPayloads: { table: "jobs (payload)", what: "Jobs whose payload names the source listing now name the target.", moves: true },
  activity: { table: "activity", what: "The activity log moves to the target.", moves: true },
};

export type MergeBooking = {
  id: string;
  status: string;
  env: string;
  clientId: string;
  shooter: string | null;
  calendarVersion: number;
  street: string | null; // bookings.property.street now
  retitle: boolean; // a calendar.upsert is queued
};

export type MergeVisit = { id: string; bookingId: string; status: string; calendarVersion: number; requeue: boolean };

export type MergeInvoice = {
  id: string;
  status: string;
  provider: string | null;
  method: string | null;
  propertyAddress: string | null;
  gates: boolean; // its payment moves the gallery lock
};

export type MergeFieldCopy = { field: "city" | "state" | "zip" | "notes" | "links" | "coverKey"; value: string };

export type MergePlan = {
  ok: boolean; // nothing refuses it (apply would run)
  applied: boolean;
  refused: string[];
  from: MergeSide | null;
  into: MergeSide | null;
  sameClient: boolean;
  counts: MergeCounts | null;
  fields: MergeFieldCopy[];
  bookings: MergeBooking[];
  visits: MergeVisit[];
  invoices: MergeInvoice[];
  notices: string[];
  // After apply: what the transaction actually changed, and what was queued.
  result?: { moved: Partial<MergeCounts>; calendarJobs: number; visitJobs: number; bundleRebuild: boolean; activityId: string | null; warnings: string[] };
};

export const emptyCounts = (): MergeCounts => ({
  bookings: 0, bookingVisits: 0, invoices: 0, paymentEvents: 0, media: 0, shoots: 0, shootFiles: 0, downloads: 0,
  revisionRequests: 0, revisionItems: 0, videoProjects: 0, videoComments: 0, inboundMessages: 0, jobs: 0, jobPayloads: 0, activity: 0,
});

export const streetOf = (address: string): string => address.split(",")[0].trim() || address.trim();

const blank = (v: string | null | undefined) => !v || !v.trim();
// links is a JSON string; "[]" or anything that is not a list of links counts as empty.
export function linksEmpty(raw: string | null | undefined): boolean {
  if (blank(raw)) return true;
  try {
    const v = JSON.parse(raw!) as unknown;
    return !Array.isArray(v) || v.length === 0;
  } catch {
    return false; // something is there, even if odd: never overwrite it
  }
}

// The source's details the target lacks. Never overwrites anything the target has.
export function fieldsToCopy(from: Pick<MergeSide, "city" | "state" | "zip" | "notes" | "links" | "coverKey">, into: Pick<MergeSide, "city" | "state" | "zip" | "notes" | "links" | "coverKey">, mediaMoves: boolean): MergeFieldCopy[] {
  const out: MergeFieldCopy[] = [];
  for (const f of ["city", "state", "zip", "notes"] as const) if (blank(into[f]) && !blank(from[f])) out.push({ field: f, value: from[f]!.trim() });
  if (linksEmpty(into.links) && !linksEmpty(from.links)) out.push({ field: "links", value: from.links! });
  // The cover is one of the source's own photos, so it only comes along with them.
  if (mediaMoves && blank(into.coverKey) && !blank(from.coverKey)) out.push({ field: "coverKey", value: from.coverKey! });
  return out;
}

export function mergeRefusals(p: { from: MergeSide | null; into: MergeSide | null; allowDifferentClient?: boolean; activeShoots?: number; fromMissing?: string; intoMissing?: string }): string[] {
  const out: string[] = [];
  if (!p.from) out.push(p.fromMissing ?? "The listing to merge from was not found.");
  if (!p.into) out.push(p.intoMissing ?? "The listing to merge into was not found.");
  if (!p.from || !p.into) return out;
  if (p.from.id === p.into.id) out.push("A listing cannot be merged into itself. Pick another listing.");
  if (p.from.clientId !== p.into.clientId && !p.allowDifferentClient)
    out.push(`The two listings belong to different clients (${p.from.clientEmail ?? p.from.clientId} and ${p.into.clientEmail ?? p.into.clientId}). Confirm that this is right to merge anyway.`);
  if (p.from.nda && !p.into.nda) out.push(`${p.from.street} is an NDA listing and ${p.into.street} is not. Mark ${p.into.street} NDA first, so nothing from the NDA shoot shows on a listing that can be shared.`);
  if ((p.activeShoots ?? 0) > 0) out.push(`${p.from.street} has ${p.activeShoots === 1 ? "an upload" : `${p.activeShoots} uploads`} still in editing. Wait until it is ready for review, then merge.`);
  return out;
}

// What a person should know before pressing Merge, in plain words.
export function mergeNotices(p: { from: MergeSide; into: MergeSide; counts: MergeCounts; bookings: MergeBooking[]; invoices: MergeInvoice[]; fields: MergeFieldCopy[] }): string[] {
  const { from, into, counts } = p;
  const out: string[] = [];
  const retitled = p.bookings.filter((b) => b.retitle);
  if (retitled.length) {
    const shooters = [...new Set(retitled.map((b) => b.shooter).filter((s): s is string => Boolean(s)))];
    out.push(
      `The calendar event${retitled.length === 1 ? "" : "s"} for ${retitled.length === 1 ? "the booking" : `${retitled.length} bookings`} will be retitled to ${into.street}. ` +
        (shooters.length ? `Google emails the shooter on the event (${shooters.join(", ")}) an update.` : "No shooter is on the event yet, so nobody is emailed.")
    );
  }
  const otherEnv = p.bookings.filter((b) => b.env !== currentEnv() && b.status !== "canceled");
  if (otherEnv.length) out.push(`${otherEnv.length} booking${otherEnv.length === 1 ? " belongs" : "s belong"} to the ${otherEnv[0].env} site; ${otherEnv.length === 1 ? "it moves" : "they move"}, but the calendar update is left to that site.`);
  if (p.bookings.length) out.push(`No email goes to the client. Emails they already have keep the old address (${from.street}).`);
  const open = p.invoices.filter((i) => i.gates && !PAID.has(i.status) && !CLOSED.has(i.status));
  if (open.length && into.downloadLocked)
    out.push(`When the moved invoice${open.length === 1 ? " is" : "s are"} paid, downloads unlock on ${into.street}: the whole gallery, including the photos already there.`);
  const paid = p.invoices.filter((i) => i.gates && PAID.has(i.status));
  if (paid.length && into.downloadLocked) out.push(`A moved invoice is already paid, but ${into.street} stays locked. Unlock it by hand if that payment covers this gallery.`);
  if (!from.downloadLocked && into.downloadLocked && counts.media > 0) out.push(`${from.street}'s downloads were unlocked; its photos join ${into.street}, which stays locked.`);
  if (p.invoices.some((i) => i.provider === "stripe")) out.push(`The Stripe invoice itself still names ${from.street} (its description and metadata). Nothing at Stripe is changed; a payment still finds its invoice.`);
  if (p.invoices.some((i) => i.provider === "titus")) out.push("A pay at close checkout keeps the old listing id as its order id. Payments match by the checkout id first, so they still land; watch the first update from Titus.");
  if (from.shootDate && from.shootDate !== into.shootDate) out.push(`${into.street}'s shoot date stays ${into.shootDate ?? "empty"} (${from.street} had ${from.shootDate}). Change it on the listing if needed.`);
  if (from.clientId !== into.clientId) out.push(`Bookings and invoices keep their own client (${from.clientEmail ?? "the source's client"}); the listing stays ${into.clientEmail ?? "the target's client"}'s.`);
  if (counts.media > 0) out.push(`${counts.media} file${counts.media === 1 ? "" : "s"} join ${into.street}'s gallery as they are, and its download zips are rebuilt.`);
  if (from.dropboxFolder) out.push(`The Dropbox folder ${from.dropboxFolder} stays where it is. New files go to ${into.street}'s folder; move or delete the old one by hand.`);
  out.push(`The link /portal/${from.slug} stops working once ${from.street} is gone.`);
  return out;
}

type ListingRow = typeof schema.listings.$inferSelect & { client: { email: string; name: string | null; team: string | null } | null };

function side(l: ListingRow): MergeSide {
  return {
    id: l.id,
    slug: l.slug,
    address: l.address,
    street: streetOf(l.address),
    clientId: l.clientId,
    clientEmail: l.client?.email ?? null,
    clientName: l.client?.name ?? null,
    clientTeam: l.client?.team ?? null,
    downloadLocked: l.downloadLocked,
    shootDate: l.shootDate ? l.shootDate.toISOString().slice(0, 10) : null,
    nda: l.nda,
    city: l.city,
    state: l.state,
    zip: l.zip,
    notes: l.notes,
    links: l.links,
    coverKey: l.coverKey,
    dropboxFolder: l.dropboxFolder,
  };
}

async function findListing(id: string | null | undefined, slug: string | null | undefined): Promise<ListingRow | null> {
  const d = db();
  const where = id && UUID_RE.test(id.trim()) ? eq(schema.listings.id, id.trim()) : slug && slug.trim() ? eq(schema.listings.slug, slug.trim()) : null;
  if (!where) return null;
  const l = await d.query.listings.findFirst({ where, with: { client: { columns: { email: true, name: true, team: true } } } });
  return (l as ListingRow | undefined) ?? null;
}

async function countRefs(listingId: string): Promise<MergeCounts> {
  const r = await db().execute<Record<string, number>>(sql`
    SELECT
      (SELECT count(*) FROM bookings WHERE listing_id = ${listingId})::int AS bookings,
      (SELECT count(*) FROM booking_visits WHERE listing_id = ${listingId})::int AS booking_visits,
      (SELECT count(*) FROM invoices WHERE listing_id = ${listingId})::int AS invoices,
      (SELECT count(*) FROM payment_events WHERE invoice_id IN (SELECT id FROM invoices WHERE listing_id = ${listingId}))::int AS payment_events,
      (SELECT count(*) FROM media WHERE listing_id = ${listingId})::int AS media,
      (SELECT count(*) FROM shoots WHERE listing_id = ${listingId})::int AS shoots,
      (SELECT count(*) FROM shoot_files WHERE shoot_id IN (SELECT id FROM shoots WHERE listing_id = ${listingId}))::int AS shoot_files,
      (SELECT count(*) FROM downloads WHERE listing_id = ${listingId})::int AS downloads,
      (SELECT count(*) FROM revision_requests WHERE listing_id = ${listingId})::int AS revision_requests,
      (SELECT count(*) FROM revision_items WHERE listing_id = ${listingId})::int AS revision_items,
      (SELECT count(*) FROM video_projects WHERE listing_id = ${listingId})::int AS video_projects,
      (SELECT count(*) FROM video_comments WHERE listing_id = ${listingId})::int AS video_comments,
      (SELECT count(*) FROM inbound_messages WHERE listing_id = ${listingId})::int AS inbound_messages,
      (SELECT count(*) FROM jobs WHERE listing_id = ${listingId})::int AS jobs,
      (SELECT count(*) FROM jobs WHERE payload->>'listingId' = ${listingId})::int AS job_payloads,
      (SELECT count(*) FROM activity WHERE listing_id = ${listingId})::int AS activity`);
  const row = r.rows[0] ?? {};
  const n = (k: string) => Number(row[k] ?? 0);
  return {
    bookings: n("bookings"), bookingVisits: n("booking_visits"), invoices: n("invoices"), paymentEvents: n("payment_events"), media: n("media"),
    shoots: n("shoots"), shootFiles: n("shoot_files"), downloads: n("downloads"), revisionRequests: n("revision_requests"), revisionItems: n("revision_items"),
    videoProjects: n("video_projects"), videoComments: n("video_comments"), inboundMessages: n("inbound_messages"), jobs: n("jobs"), jobPayloads: n("job_payloads"), activity: n("activity"),
  };
}

// A booking's calendar event is rewritten when the booking is live and has a date in this environment.
export const retitles = (b: { status: string; env: string | null; desiredDate: string | null }, env = currentEnv()) => b.status !== "canceled" && Boolean(b.desiredDate) && rowEnv(b.env) === env;

export async function mergeListing(input: MergeListingInput): Promise<MergePlan> {
  const d = db();
  const [fromRow, intoRow] = await Promise.all([findListing(input.fromListingId, input.fromSlug), findListing(input.intoListingId, input.intoSlug)]);
  const from = fromRow ? side(fromRow) : null;
  const into = intoRow ? side(intoRow) : null;
  const plan: MergePlan = { ok: false, applied: false, refused: [], from, into, sameClient: Boolean(from && into && from.clientId === into.clientId), counts: null, fields: [], bookings: [], visits: [], invoices: [], notices: [] };
  const name = (id?: string | null, slug?: string | null) => slug?.trim() || id?.trim() || "(none given)";
  if (!from || !into) {
    plan.refused = mergeRefusals({ from, into, fromMissing: `No listing ${name(input.fromListingId, input.fromSlug)} to merge from.`, intoMissing: `No listing ${name(input.intoListingId, input.intoSlug)} to merge into.` });
    return plan;
  }

  const [counts, bookingRows, visitRows, invoiceRows, shootRows] = await Promise.all([
    countRefs(from.id),
    d.query.bookings.findMany({ where: eq(schema.bookings.listingId, from.id), columns: { id: true, status: true, env: true, clientId: true, photographerEmail: true, calendarVersion: true, property: true, desiredDate: true } }),
    d.query.bookingVisits.findMany({ where: eq(schema.bookingVisits.listingId, from.id), columns: { id: true, bookingId: true, status: true, calendarVersion: true, env: true } }),
    d.query.invoices.findMany({ where: eq(schema.invoices.listingId, from.id), columns: { id: true, status: true, provider: true, method: true, propertyAddress: true, meta: true } }),
    d.query.shoots.findMany({ where: eq(schema.shoots.listingId, from.id), columns: { id: true, status: true } }),
  ]);
  plan.counts = counts;
  const env = currentEnv();
  plan.bookings = bookingRows.map((b) => ({
    id: b.id,
    status: b.status,
    env: rowEnv(b.env),
    clientId: b.clientId,
    shooter: b.photographerEmail,
    calendarVersion: b.calendarVersion,
    street: typeof b.property?.street === "string" ? (b.property.street as string) : null,
    retitle: retitles(b, env),
  }));
  const liveBooking = new Set(plan.bookings.filter((b) => b.retitle).map((b) => b.id));
  plan.visits = visitRows.map((v) => ({ id: v.id, bookingId: v.bookingId, status: v.status, calendarVersion: v.calendarVersion, requeue: v.status === "scheduled" && liveBooking.has(v.bookingId) && rowEnv(v.env) === env }));
  plan.invoices = invoiceRows.map((i) => ({ id: i.id, status: i.status, provider: i.provider, method: i.method, propertyAddress: i.propertyAddress, gates: gatesGallery(i.meta) }));
  plan.fields = fieldsToCopy(from, into, counts.media > 0);
  plan.refused = mergeRefusals({ from, into, allowDifferentClient: input.allowDifferentClient, activeShoots: shootRows.filter((s) => isActive(s.status)).length });
  plan.ok = plan.refused.length === 0;
  plan.notices = mergeNotices({ from, into, counts, bookings: plan.bookings, invoices: plan.invoices, fields: plan.fields });
  if (!input.apply || !plan.ok) return plan;

  // ---- apply: one transaction ------------------------------------------------
  const now = new Date();
  const actor = input.actor?.trim() || null;
  const intoStreet = into.street;
  const L = from.id;
  const T = into.id;
  const specs: JobSpec[] = [];
  const bookingStmts = plan.bookings.map((b) => {
    const version = b.calendarVersion + 1;
    if (b.retitle) specs.push({ kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", b.id, version), bookingId: b.id, listingId: T, payload: { version } });
    return d
      .update(schema.bookings)
      .set({
        listingId: T,
        property: sql`jsonb_set(coalesce(${schema.bookings.property}, '{}'::jsonb), '{street}', to_jsonb(${intoStreet}::text))`,
        calendarVersion: version,
        updatedAt: now,
      })
      // Only at the version the plan read: a booking changed in between stays
      // behind, and its foreign key then stops the delete below (all rolls back).
      .where(and(eq(schema.bookings.id, b.id), eq(schema.bookings.listingId, L), eq(schema.bookings.calendarVersion, b.calendarVersion)))
      .returning({ id: schema.bookings.id });
  });
  const visitStmts = plan.visits
    .filter((v) => v.requeue)
    .map((v) => {
      const version = v.calendarVersion + 1;
      specs.push({ kind: "calendar.visit_upsert", idempotencyKey: jobKey("calendar.visit_upsert", v.id, version), bookingId: v.bookingId, listingId: T, payload: { version, visitId: v.id } });
      return d
        .update(schema.bookingVisits)
        .set({ listingId: T, calendarVersion: version, updatedAt: now })
        .where(and(eq(schema.bookingVisits.id, v.id), eq(schema.bookingVisits.calendarVersion, v.calendarVersion)))
        .returning({ id: schema.bookingVisits.id });
    });
  const set = (f: MergeFieldCopy["field"]) => plan.fields.find((x) => x.field === f)?.value;
  const targetPatch: Partial<typeof schema.listings.$inferInsert> = {};
  for (const f of ["city", "state", "zip", "notes", "links", "coverKey"] as const) {
    const v = set(f);
    if (v !== undefined) targetPatch[f] = v;
  }
  const moved = {
    bookings: plan.bookings.map((b) => b.id),
    invoices: plan.invoices.map((i) => i.id),
  };
  const meta = {
    from: { id: from.id, slug: from.slug, address: from.address, clientEmail: from.clientEmail },
    into: { id: into.id, slug: into.slug, address: into.address, clientEmail: into.clientEmail },
    counts,
    bookings: moved.bookings,
    invoices: moved.invoices,
    copied: plan.fields.map((f) => f.field),
    differentClient: from.clientId !== into.clientId,
    reason: input.reason?.trim() || null,
    via: actor && actor.includes("@") ? "admin" : "operator",
  };

  type Stmt = Parameters<typeof d.batch>[0][number];
  const stmts: Stmt[] = [
    ...bookingStmts,
    ...visitStmts,
    d.update(schema.bookingVisits).set({ listingId: T, updatedAt: now }).where(eq(schema.bookingVisits.listingId, L)).returning({ id: schema.bookingVisits.id }),
    d.update(schema.invoices).set({ listingId: T, propertyAddress: into.address, updatedAt: now }).where(eq(schema.invoices.listingId, L)).returning({ id: schema.invoices.id }),
    d.update(schema.media).set({ listingId: T }).where(eq(schema.media.listingId, L)).returning({ id: schema.media.id }),
    d.update(schema.shoots).set({ listingId: T, updatedAt: now }).where(eq(schema.shoots.listingId, L)).returning({ id: schema.shoots.id }),
    d.update(schema.downloads).set({ listingId: T }).where(eq(schema.downloads.listingId, L)).returning({ id: schema.downloads.id }),
    d.update(schema.revisionRequests).set({ listingId: T }).where(eq(schema.revisionRequests.listingId, L)).returning({ id: schema.revisionRequests.id }),
    d.update(schema.revisionItems).set({ listingId: T, updatedAt: now }).where(eq(schema.revisionItems.listingId, L)).returning({ id: schema.revisionItems.id }),
    d.update(schema.videoProjects).set({ listingId: T, updatedAt: now }).where(eq(schema.videoProjects.listingId, L)).returning({ id: schema.videoProjects.id }),
    d.update(schema.videoComments).set({ listingId: T, updatedAt: now }).where(eq(schema.videoComments.listingId, L)).returning({ id: schema.videoComments.id }),
    d.update(schema.inboundMessages).set({ listingId: T }).where(eq(schema.inboundMessages.listingId, L)).returning({ id: schema.inboundMessages.id }),
    d.update(schema.jobs).set({ listingId: T }).where(eq(schema.jobs.listingId, L)).returning({ id: schema.jobs.id }),
    d
      .update(schema.jobs)
      .set({ payload: sql`jsonb_set(${schema.jobs.payload}, '{listingId}', to_jsonb(${T}::text))` })
      .where(sql`${schema.jobs.payload}->>'listingId' = ${L}`)
      .returning({ id: schema.jobs.id }),
    d.update(schema.activity).set({ listingId: T }).where(eq(schema.activity.listingId, L)).returning({ id: schema.activity.id }),
    ...(Object.keys(targetPatch).length ? [d.update(schema.listings).set(targetPatch).where(eq(schema.listings.id, T)).returning({ id: schema.listings.id })] : []),
    d.delete(schema.listings).where(eq(schema.listings.id, L)).returning({ id: schema.listings.id }),
    d.insert(schema.activity).values({ actorEmail: actor, action: "listing.merged", listingId: T, clientId: into.clientId, meta }).returning({ id: schema.activity.id }),
    ...(specs.length ? [d.insert(schema.jobs).values(jobRows(specs)).onConflictDoNothing({ target: schema.jobs.idempotencyKey }).returning({ id: schema.jobs.id })] : []),
  ];

  let results: { id: string }[][];
  try {
    results = (await d.batch(stmts as [Stmt, ...Stmt[]])) as { id: string }[][];
  } catch (e) {
    // Drizzle wraps the driver's error ("Failed query: ..."); the reason is in its cause.
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : null;
    const code = (cause as { code?: unknown } | null)?.code ?? (e as { code?: unknown } | null)?.code;
    const msg = `${e instanceof Error ? e.message : String(e)} ${cause?.message ?? ""}`;
    if (code === "23503" || /foreign key/i.test(msg)) {
      plan.ok = false;
      plan.refused = [`Something on ${from.street} changed while merging (a booking was edited or a new row arrived), so nothing was changed. Open the preview again and merge.`];
      return plan;
    }
    throw e;
  }

  // Read the counts back in statement order.
  let i = 0;
  const take = (n = 1) => {
    const out = results.slice(i, i + n);
    i += n;
    return out.reduce((s, r) => s + (Array.isArray(r) ? r.length : 0), 0);
  };
  const bookingsMoved = take(bookingStmts.length);
  const visitsMoved = take(visitStmts.length) + take();
  const m: Partial<MergeCounts> = {
    bookings: bookingsMoved,
    bookingVisits: visitsMoved,
    invoices: take(),
    media: take(),
    shoots: take(),
    downloads: take(),
    revisionRequests: take(),
    revisionItems: take(),
    videoProjects: take(),
    videoComments: take(),
    inboundMessages: take(),
    jobs: take(),
    jobPayloads: take(),
    activity: take(),
  };
  if (Object.keys(targetPatch).length) take();
  take(); // the delete
  const actRow = results[i]?.[0] ?? null;
  i++;
  const visitJobs = specs.filter((s) => s.kind === "calendar.visit_upsert").length;
  const calendarJobs = specs.length - visitJobs;

  plan.applied = true;
  const warnings: string[] = [];
  let bundleRebuild = false;
  if ((m.media ?? 0) > 0) {
    try {
      const { enqueueBundleRebuild } = await import("./bundle-jobs");
      await enqueueBundleRebuild(T);
      bundleRebuild = true;
    } catch (e) {
      warnings.push(`The download zips were not queued (${e instanceof Error ? e.message : String(e)}). Press Rebuild zips on ${into.street}.`);
    }
  }
  plan.result = { moved: m, calendarJobs, visitJobs, bundleRebuild, activityId: actRow?.id ?? null, warnings };
  return plan;
}

// The jobs a merge queued, for a caller that drains them right away (the
// admin action). Only calendar writes: never anything else that waits.
export const MERGE_DRAIN_KINDS: readonly JobKind[] = ["calendar.upsert", "calendar.visit_upsert"];
