"use server";
// One-portal admin mutations (Oct 2026): edit and delete clients, manage
// teams, edit and delete listings, manage media rows, rebuild download zips,
// manage who is an admin. Every action re-checks the admin gate, writes an
// activity row, and comes back to the page with a banner in the query string.
// Deleting rows never deletes files in storage: objects stay where they are.
//
// Roles (Oct 2026): everything here is full admin only (requireAdmin) except
// the media manager's work, which the QA team may do too (requireStaff):
// reorder, edit a file's details, sections and the revised flag, Hide / Show
// (now "Internal only" / "Client visible", src/lib/visibility-core.ts) and
// Rebuild zips. Deleting files stays admin only.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireAdmin, requireStaff, type Staff } from "@/lib/admin";
import { envAdminEmails, forgetAdminCache, toRole } from "@/lib/admin-allow";
import { logActivity } from "@/lib/activity";
import { enqueueBundleRebuild } from "@/lib/bundle-jobs";
import { syncBookingsAfterListingEdit } from "@/lib/listing-booking-sync";
import { drainJobs } from "@/lib/jobs";
import { MERGE_DRAIN_KINDS, mergeListing } from "@/lib/merge-listing";
import { sendSignInLink } from "@/lib/login-link";
import { applyVisibility } from "@/lib/visibility-core";
import { parsePicTimeUrl } from "@/lib/pictime";
import { business } from "@/lib/business";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const enc = (s: string) => encodeURIComponent(s);
const field = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Run the database work, then redirect outside of it (a redirect is a thrown
// control-flow signal and must never be caught as an error).
type Done = { to: string };
async function attempt(fn: () => Promise<Done>, errorTo: string): Promise<string> {
  try {
    return (await fn()).to;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[crud-actions]", msg);
    return `${errorTo}${errorTo.includes("?") ? "&" : "?"}error=${enc(msg.slice(0, 160))}`;
  }
}
const fail = (msg: string): never => { throw new Error(msg); };

async function ensureTeamRow(slug: string): Promise<void> {
  await db().insert(schema.teams).values({ slug }).onConflictDoNothing();
}

// ---- Clients -------------------------------------------------------------

export async function updateClient(id: string, formData: FormData) {
  const actor = await requireAdmin();
  const to = `/admin/clients/${id}`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const d = db();
    const cur = await d.query.clients.findFirst({ where: eq(schema.clients.id, id) });
    if (!cur) fail("Client not found.");
    const email = field(formData, "email").toLowerCase();
    if (!EMAIL_RE.test(email)) fail("That email does not look right.");
    if (email !== cur!.email) {
      const taken = await d.query.clients.findFirst({ where: eq(schema.clients.email, email), columns: { id: true } });
      if (taken) fail("Another client already uses that email.");
    }
    const teamRaw = field(formData, "team");
    const team = teamRaw ? slugify(teamRaw) || null : null;
    const patch = { email, name: field(formData, "name") || null, company: field(formData, "company") || null, phone: field(formData, "phone") || null, team, notes: field(formData, "notes") || null, ...(business.clientDiscount ? { discountPercent: Math.max(0, Math.min(100, Math.round(Number(field(formData, "discountPercent")) || 0))), pricingNote: field(formData, "pricingNote") || null } : {}) };
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => JSON.stringify(cur![k] ?? null) !== JSON.stringify(patch[k] ?? null));
    if (changed.length) {
      await d.update(schema.clients).set(patch).where(eq(schema.clients.id, id));
      if (team) await ensureTeamRow(team);
      await logActivity({ actorEmail: actor, action: "client.updated", clientId: id, meta: { changed, ...(changed.includes("email") ? { from: cur!.email, to: email } : {}) } });
    }
    revalidatePath("/admin/clients");
    revalidatePath(to);
    revalidatePath("/admin/teams");
    return { to: `${to}?saved=1` };
  }, to);
  redirect(dest);
}

export async function deleteClient(id: string) {
  const actor = await requireAdmin();
  const to = `/admin/clients/${id}`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const d = db();
    const cur = await d.query.clients.findFirst({ where: eq(schema.clients.id, id), with: { listings: { columns: { id: true } } } });
    if (!cur) fail("Client not found.");
    if (cur!.listings.length) fail(`This client still owns ${cur!.listings.length} listing${cur!.listings.length === 1 ? "" : "s"}. Move or delete them first.`);
    const bookings = await d.query.bookings.findMany({ where: eq(schema.bookings.clientId, id), columns: { id: true } });
    if (bookings.length) fail("This client has bookings. Cancel them first.");
    const invoices = await d.query.invoices.findMany({ where: eq(schema.invoices.clientId, id), columns: { id: true } });
    if (invoices.length) fail("This client has invoices on file, so the row stays for the records.");
    await d.delete(schema.clients).where(eq(schema.clients.id, id));
    await logActivity({ actorEmail: actor, action: "client.deleted", meta: { email: cur!.email, name: cur!.name } });
    revalidatePath("/admin/clients");
    revalidatePath("/admin/teams");
    return { to: `/admin/clients?deleted=${enc(cur!.email)}` };
  }, to);
  redirect(dest);
}

export async function sendClientSignInLink(id: string) {
  const actor = await requireAdmin();
  const to = `/admin/clients/${id}`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: no email is sent.")}`);
  const dest = await attempt(async () => {
    if (!process.env.RESEND_API_KEY) fail("Email is not connected (RESEND_API_KEY).");
    const cur = await db().query.clients.findFirst({ where: eq(schema.clients.id, id), columns: { email: true } });
    if (!cur) fail("Client not found.");
    await sendSignInLink(cur!.email);
    await logActivity({ actorEmail: actor, action: "client.signin_link_sent", clientId: id, meta: { to: cur!.email } });
    return { to: `${to}?sent=1` };
  }, to);
  redirect(dest);
}

// ---- Teams ---------------------------------------------------------------

async function upsertMember(email: string, name: string | null, team: string): Promise<{ id: string; created: boolean }> {
  const d = db();
  const existing = await d.query.clients.findFirst({ where: eq(schema.clients.email, email), columns: { id: true, name: true } });
  if (existing) {
    await d.update(schema.clients).set({ team, name: existing.name ?? name }).where(eq(schema.clients.id, existing.id));
    return { id: existing.id, created: false };
  }
  const [row] = await d.insert(schema.clients).values({ email, name, team }).returning({ id: schema.clients.id });
  return { id: row.id, created: true };
}

export async function createTeam(formData: FormData) {
  const actor = await requireAdmin();
  if (!hasDb()) redirect(`/admin/teams?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const d = db();
    const name = field(formData, "name");
    const slug = slugify(field(formData, "slug") || name);
    if (!SLUG_RE.test(slug) || slug.length < 2) fail("Give the team a name (letters and numbers).");
    const taken = (await d.query.teams.findFirst({ where: eq(schema.teams.slug, slug), columns: { slug: true } })) || (await d.query.clients.findFirst({ where: eq(schema.clients.team, slug), columns: { id: true } }));
    if (taken) fail("A team with that id already exists.");
    await d.insert(schema.teams).values({ slug, name: name || null, notes: field(formData, "notes") || null });
    const emails = field(formData, "members").split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e));
    for (const email of emails) {
      const m = await upsertMember(email, null, slug);
      if (m.created) await logActivity({ actorEmail: actor, action: "client.created", clientId: m.id, meta: { email } });
      await logActivity({ actorEmail: actor, action: "team.member_added", clientId: m.id, meta: { slug, email, onCreate: true } });
    }
    await logActivity({ actorEmail: actor, action: "team.created", meta: { slug, name: name || null, members: emails.length } });
    revalidatePath("/admin/teams");
    revalidatePath("/admin/clients");
    return { to: `/admin/teams/${slug}?saved=1` };
  }, "/admin/teams");
  redirect(dest);
}

export async function updateTeam(slug: string, formData: FormData) {
  const actor = await requireAdmin();
  const to = `/admin/teams/${slug}`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const d = db();
    const name = field(formData, "name") || null;
    const notes = field(formData, "notes") || null;
    const newSlugRaw = field(formData, "slug");
    const newSlug = newSlugRaw ? slugify(newSlugRaw) : slug;
    if (!SLUG_RE.test(newSlug) || newSlug.length < 2) fail("The team id can only use letters, numbers and dashes.");
    if (newSlug !== slug) {
      const taken = (await d.query.teams.findFirst({ where: eq(schema.teams.slug, newSlug), columns: { slug: true } })) || (await d.query.clients.findFirst({ where: eq(schema.clients.team, newSlug), columns: { id: true } }));
      if (taken) fail("Another team already uses that id.");
      await d.update(schema.clients).set({ team: newSlug }).where(eq(schema.clients.team, slug));
      await d.delete(schema.teams).where(eq(schema.teams.slug, slug));
      await d.insert(schema.teams).values({ slug: newSlug, name, notes }).onConflictDoUpdate({ target: schema.teams.slug, set: { name, notes, updatedAt: new Date() } });
    } else {
      await d.insert(schema.teams).values({ slug, name, notes }).onConflictDoUpdate({ target: schema.teams.slug, set: { name, notes, updatedAt: new Date() } });
    }
    await logActivity({ actorEmail: actor, action: "team.updated", meta: { slug: newSlug, ...(newSlug !== slug ? { from: slug } : {}), name } });
    revalidatePath("/admin/teams");
    revalidatePath("/admin/clients");
    return { to: `/admin/teams/${newSlug}?saved=1` };
  }, to);
  redirect(dest);
}

export async function deleteTeam(slug: string) {
  const actor = await requireAdmin();
  const to = `/admin/teams/${slug}`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const d = db();
    const members = await d.update(schema.clients).set({ team: null }).where(eq(schema.clients.team, slug)).returning({ id: schema.clients.id });
    await d.delete(schema.teams).where(eq(schema.teams.slug, slug));
    await logActivity({ actorEmail: actor, action: "team.deleted", meta: { slug, members: members.length } });
    revalidatePath("/admin/teams");
    revalidatePath("/admin/clients");
    return { to: `/admin/teams?deleted=${enc(slug)}` };
  }, to);
  redirect(dest);
}

export async function addTeamMember(slug: string, formData: FormData) {
  const actor = await requireAdmin();
  const to = `/admin/teams/${slug}`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const email = field(formData, "email").toLowerCase();
    if (!EMAIL_RE.test(email)) fail("That email does not look right.");
    await ensureTeamRow(slug);
    const m = await upsertMember(email, field(formData, "name") || null, slug);
    if (m.created) await logActivity({ actorEmail: actor, action: "client.created", clientId: m.id, meta: { email } });
    await logActivity({ actorEmail: actor, action: "team.member_added", clientId: m.id, meta: { slug, email } });
    revalidatePath("/admin/teams");
    revalidatePath("/admin/clients");
    return { to: `${to}?saved=1` };
  }, to);
  redirect(dest);
}

export async function removeTeamMember(slug: string, clientId: string) {
  const actor = await requireAdmin();
  const to = `/admin/teams/${slug}`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const rows = await db().update(schema.clients).set({ team: null }).where(and(eq(schema.clients.id, clientId), eq(schema.clients.team, slug))).returning({ email: schema.clients.email });
    if (rows[0]) await logActivity({ actorEmail: actor, action: "team.member_removed", clientId, meta: { slug, email: rows[0].email } });
    revalidatePath("/admin/teams");
    revalidatePath("/admin/clients");
    return { to: `${to}?saved=1` };
  }, to);
  redirect(dest);
}

// ---- Listings ------------------------------------------------------------

function parseLinks(raw: string): { label: string; url: string }[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [a, b] = line.split("|").map((s) => s.trim());
      const url = b ?? a;
      const label = b ? a : url.replace(/^https?:\/\//, "").split("/")[0];
      return { label, url };
    })
    .filter((l) => /^https?:\/\//.test(l.url));
}

export async function updateListing(id: string, formData: FormData) {
  const actor = await requireAdmin();
  const to = `/admin/listings/${id}`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const d = db();
    const cur = await d.query.listings.findFirst({ where: eq(schema.listings.id, id) });
    if (!cur) fail("Listing not found.");
    const address = field(formData, "address");
    if (address.length < 4) fail("Enter the address.");
    const slug = field(formData, "slug") ? slugify(field(formData, "slug")) : cur!.slug;
    if (!SLUG_RE.test(slug)) fail("The portal id can only use letters, numbers and dashes.");
    if (slug !== cur!.slug) {
      const taken = await d.query.listings.findFirst({ where: eq(schema.listings.slug, slug), columns: { id: true } });
      if (taken) fail("Another listing already uses that portal id.");
    }
    const clientId = field(formData, "clientId") || cur!.clientId;
    if (clientId !== cur!.clientId) {
      const c = await d.query.clients.findFirst({ where: eq(schema.clients.id, clientId), columns: { id: true } });
      if (!c) fail("Choose a client.");
    }
    const shootDateRaw = field(formData, "shootDate");
    const shootDate = shootDateRaw ? new Date(`${shootDateRaw}T12:00:00`) : null;
    if (shootDateRaw && Number.isNaN(shootDate!.getTime())) fail("That shoot date does not look right.");
    const links = parseLinks(field(formData, "links"));
    const pic = parsePicTimeUrl(field(formData, "picTimeUrl"));
    if (!pic.ok) fail(pic.error);
    const patch = {
      address,
      slug,
      clientId,
      shootDate,
      city: field(formData, "city") || null,
      state: field(formData, "state").toUpperCase() || null,
      zip: field(formData, "zip") || null,
      nda: formData.get("nda") === "on",
      notes: field(formData, "notes") || null,
      links: links.length ? JSON.stringify(links) : null,
      picTimeUrl: pic.ok ? pic.url : null,
    };
    const same = (k: keyof typeof patch) => {
      const a = cur![k];
      const b = patch[k];
      if (a instanceof Date || b instanceof Date) return (a as Date | null)?.getTime() === (b as Date | null)?.getTime();
      return a === b;
    };
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => !same(k));
    if (changed.length) {
      await d.update(schema.listings).set(patch).where(eq(schema.listings.id, id));
      await logActivity({ actorEmail: actor, action: "listing.updated", listingId: id, clientId, meta: { changed, ...(changed.includes("slug") ? { fromSlug: cur!.slug, toSlug: slug } : {}) } });
      // The booking and its hello@ calendar event follow a new shoot date,
      // address or NDA flag.
      await syncBookingsAfterListingEdit({ listingId: id, actor, newDate: shootDateRaw || null, dateChanged: changed.includes("shootDate"), textChanged: changed.includes("address") || changed.includes("nda") });
    }
    revalidatePath("/admin/listings");
    revalidatePath(to);
    revalidatePath("/portal");
    return { to: `${to}?saved=1` };
  }, to);
  redirect(dest);
}

// Deletes the listing's rows (media, downloads, revision requests, shoots).
// Files stay in storage. Refused while a booking still points at it.
export async function deleteListing(id: string, formData: FormData) {
  const actor = await requireAdmin();
  const to = `/admin/listings/${id}`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    if (field(formData, "confirm") !== "DELETE") fail("Type DELETE to confirm.");
    const d = db();
    const cur = await d.query.listings.findFirst({ where: eq(schema.listings.id, id), columns: { id: true, address: true, slug: true, clientId: true, nda: true } });
    if (!cur) fail("Listing not found.");
    const bookings = await d.query.bookings.findMany({ where: eq(schema.bookings.listingId, id), columns: { id: true } });
    if (bookings.length) fail("This listing has a booking. Cancel the booking first.");
    const media = await d.delete(schema.revisionRequests).where(eq(schema.revisionRequests.listingId, id)).returning({ id: schema.revisionRequests.id });
    await d.delete(schema.downloads).where(eq(schema.downloads.listingId, id));
    const removed = await d.delete(schema.media).where(eq(schema.media.listingId, id)).returning({ id: schema.media.id });
    const shoots = await d.query.shoots.findMany({ where: eq(schema.shoots.listingId, id), columns: { id: true } });
    if (shoots.length) {
      await d.delete(schema.shootFiles).where(inArray(schema.shootFiles.shootId, shoots.map((s) => s.id)));
      await d.delete(schema.shoots).where(eq(schema.shoots.listingId, id));
    }
    await d.update(schema.invoices).set({ listingId: null }).where(eq(schema.invoices.listingId, id));
    await d.delete(schema.listings).where(eq(schema.listings.id, id));
    await logActivity({ actorEmail: actor, action: "listing.deleted", clientId: cur!.clientId, meta: { address: cur!.address, nda: Boolean(cur!.nda), slug: cur!.slug, files: removed.length, revisions: media.length } });
    revalidatePath("/admin/listings");
    revalidatePath("/portal");
    return { to: `/admin/listings?deleted=${enc(cur!.address.split(",")[0])}` };
  }, to);
  redirect(dest);
}

// Merge this listing into another (Oct 30 2026; src/lib/merge-listing.ts):
// the preview on /admin/listings/<id>/merge, then this. Admins only. Every
// row on the listing moves to the target in one transaction and the empty
// listing is deleted; the moved bookings' calendar events are rewritten right
// after the response. Never a client email.
export async function mergeListingInto(fromId: string, intoId: string, formData: FormData) {
  const actor = await requireAdmin();
  const back = `/admin/listings/${fromId}/merge?into=${enc(intoId)}`;
  if (!hasDb()) redirect(`${back}&error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    if (field(formData, "confirm").toUpperCase() !== "MERGE") fail("Type MERGE to confirm.");
    const plan = await mergeListing({
      fromListingId: fromId,
      intoListingId: intoId,
      apply: true,
      allowDifferentClient: field(formData, "allowDifferentClient") === "1",
      actor,
      reason: field(formData, "reason") || null,
    });
    if (!plan.applied) fail(plan.refused[0] ?? "The merge did not run.");
    const bookingIds = plan.bookings.filter((b) => b.retitle).map((b) => b.id);
    if (bookingIds.length)
      after(async () => {
        for (const bookingId of bookingIds) await drainJobs({ bookingId, budgetMs: 20_000, kinds: MERGE_DRAIN_KINDS }).catch((e) => console.error("[merge listing] calendar drain", e));
      });
    revalidatePath("/admin/listings");
    revalidatePath(`/admin/listings/${intoId}`);
    revalidatePath("/admin/bookings");
    revalidatePath("/portal");
    return { to: `/admin/listings/${intoId}?merged=${enc(plan.from?.street ?? "the listing")}` };
  }, back);
  redirect(dest);
}

// ---- Media rows ----------------------------------------------------------
// (enqueueBundleRebuild moved to src/lib/bundle-jobs.ts: an export of a
// "use server" file is a server action anyone could call.)

export async function rebuildBundles(listingId: string) {
  await requireStaff();
  const to = `/admin/listings/${listingId}`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    await enqueueBundleRebuild(listingId);
    return { to: `${to}?bundles=queued` };
  }, to);
  redirect(dest);
}

// Result of the media grid's actions, which answer instead of redirecting so
// the grid can stay optimistic (no page jump, no lost selection).
export type MediaActionResult = { ok: true } | { ok: false; error: string };
const demoResult: MediaActionResult = { ok: false, error: "Demo mode: nothing is saved." };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
function revalidateMedia(listingId: string) {
  revalidatePath(`/admin/listings/${listingId}`);
  revalidatePath("/portal");
}

// One file's name, section and revised flag (and order, when a sort is sent).
async function applyUpdateMedia(actor: string, mediaId: string, formData: FormData): Promise<string> {
  const listingId = field(formData, "listingId");
  const d = db();
  const cur = await d.query.media.findFirst({ where: eq(schema.media.id, mediaId) });
  if (!cur || cur.listingId !== listingId) fail("File not found.");
  const filename = field(formData, "filename") || cur!.filename;
  const section = field(formData, "section") || null;
  const revision = formData.get("revision") === "on";
  const sortRaw = field(formData, "sort");
  const sort = sortRaw ? Number(sortRaw) : cur!.sort;
  if (!Number.isFinite(sort)) fail("Order must be a number.");
  await d.update(schema.media).set({ filename, section, revision, sort }).where(eq(schema.media.id, mediaId));
  await logActivity({ actorEmail: actor, action: "media.updated", listingId, meta: { mediaId, filename, section, revision, sort } });
  if (filename !== cur!.filename || section !== cur!.section || revision !== cur!.revision || sort !== cur!.sort) await enqueueBundleRebuild(listingId);
  revalidateMedia(listingId);
  return listingId;
}

export async function updateMedia(mediaId: string, formData: FormData) {
  const { email: actor } = await requireStaff();
  const listingId = field(formData, "listingId");
  const to = `/admin/listings/${listingId}#media`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    await applyUpdateMedia(actor, mediaId, formData);
    return { to: `/admin/listings/${listingId}?saved=1#media` };
  }, to);
  redirect(dest);
}

// The media grid's edit-details sheet: same contract as updateMedia
// (listingId, filename, section, revision in the form data), answers instead
// of redirecting.
export async function updateMediaInline(mediaId: string, formData: FormData): Promise<MediaActionResult> {
  const { email: actor } = await requireStaff();
  if (!hasDb()) return demoResult;
  try {
    await applyUpdateMedia(actor, mediaId, formData);
    return { ok: true };
  } catch (e) {
    console.error("[crud-actions]", errorText(e));
    return { ok: false, error: errorText(e) };
  }
}

// Drag to reorder on the listing page. orderedIds is the full new order of one
// group: the main gallery, one named section, or the revised files (the same
// groups the grid shows). Every id must be on this listing and in that one
// group. Rows added to the group since the page loaded keep their order after
// the ones sent. Writes sort = 10, 20, 30... in one statement.
export async function reorderMedia(listingId: string, orderedIds: string[]): Promise<MediaActionResult> {
  const { email: actor } = await requireStaff();
  if (!hasDb()) return { ok: false, error: "Demo mode: order not saved." };
  try {
    if (!Array.isArray(orderedIds) || !orderedIds.length) fail("Nothing to reorder.");
    const ids = orderedIds.map(String);
    if (new Set(ids).size !== ids.length) fail("The same file is in the order twice.");
    const d = db();
    const rows = await d.query.media.findMany({
      where: eq(schema.media.listingId, listingId),
      columns: { id: true, sort: true, section: true, revision: true, createdAt: true },
    });
    const byId = new Map(rows.map((m) => [m.id, m]));
    if (ids.some((id) => !byId.has(id))) fail("Some of those files are not on this listing.");
    const groupOf = (m: { section: string | null; revision: boolean }) => (m.revision ? "revised" : m.section ? `section:${m.section}` : "main");
    const group = groupOf(byId.get(ids[0])!);
    if (ids.some((id) => groupOf(byId.get(id)!) !== group)) fail("Files can only be reordered within one section.");
    const sent = new Set(ids);
    const rest = rows
      .filter((m) => groupOf(m) === group && !sent.has(m.id))
      .sort((a, b) => a.sort - b.sort || a.createdAt.getTime() - b.createdAt.getTime())
      .map((m) => m.id);
    const order = [...ids, ...rest];
    const cases = sql.join(order.map((id, i) => sql`when ${id}::uuid then ${(i + 1) * 10}::int`), sql` `);
    await d
      .update(schema.media)
      .set({ sort: sql`(case ${schema.media.id} ${cases} else ${schema.media.sort} end)` })
      .where(and(eq(schema.media.listingId, listingId), inArray(schema.media.id, order)));
    await logActivity({ actorEmail: actor, action: "media.reordered", listingId, meta: { count: order.length, group } });
    try {
      await enqueueBundleRebuild(listingId);
    } catch (e) {
      // The order is saved; a missed rebuild is caught by "Rebuild zips".
      console.error("[crud-actions] bundle rebuild after reorder:", errorText(e));
    }
    revalidateMedia(listingId);
    return { ok: true };
  } catch (e) {
    console.error("[crud-actions]", errorText(e));
    return { ok: false, error: errorText(e) };
  }
}

// Checkbox selection + one action (form field "do"): hide, show, delete,
// revision, unrevision, or section (with a "section" field; empty = the main
// gallery). Ids come as repeated "ids" fields. hide = "Internal only" and
// show = "Client visible" (src/lib/visibility-core.ts). delete is admin only.
async function applyBulkMedia(staff: Staff, listingId: string, formData: FormData): Promise<void> {
  const actor = staff.email;
  const d = db();
  const ids = formData.getAll("ids").map(String).filter(Boolean);
  const action = field(formData, "do");
  if (!ids.length) fail("Select at least one file.");
  const owned = await d.query.media.findMany({ where: and(eq(schema.media.listingId, listingId), inArray(schema.media.id, ids)), columns: { id: true } });
  const safeIds = owned.map((m) => m.id);
  if (!safeIds.length) fail("Those files are not on this listing.");
  if (action === "hide" || action === "show") {
    await applyVisibility(actor, { listingId }, safeIds, action === "show" ? "client" : "internal", "listing");
  } else if (action === "delete") {
    if (staff.role !== "admin") fail("Only an admin can delete files. Move them to internal only instead.");
    await d.update(schema.downloads).set({ mediaId: null }).where(inArray(schema.downloads.mediaId, safeIds));
    await d.delete(schema.media).where(inArray(schema.media.id, safeIds));
    await logActivity({ actorEmail: actor, action: "media.deleted", listingId, meta: { count: safeIds.length } });
    await enqueueBundleRebuild(listingId);
  } else if (action === "section") {
    const section = field(formData, "section") || null;
    await d.update(schema.media).set({ section }).where(inArray(schema.media.id, safeIds));
    await logActivity({ actorEmail: actor, action: "media.updated", listingId, meta: { count: safeIds.length, section } });
    await enqueueBundleRebuild(listingId);
  } else if (action === "revision" || action === "unrevision") {
    await d.update(schema.media).set({ revision: action === "revision" }).where(inArray(schema.media.id, safeIds));
    await logActivity({ actorEmail: actor, action: "media.updated", listingId, meta: { count: safeIds.length, revision: action === "revision" } });
    await enqueueBundleRebuild(listingId);
  } else {
    fail("Choose what to do with the selection.");
  }
  revalidateMedia(listingId);
}

export async function bulkMedia(listingId: string, formData: FormData) {
  const staff = await requireStaff();
  const to = `/admin/listings/${listingId}#media`;
  if (!hasDb()) redirect(`${to}?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    await applyBulkMedia(staff, listingId, formData);
    return { to: `/admin/listings/${listingId}?saved=1#media` };
  }, to);
  redirect(dest);
}

// The media grid's selection bar and tile menus: same contract as bulkMedia,
// answers instead of redirecting.
export async function bulkMediaInline(listingId: string, formData: FormData): Promise<MediaActionResult> {
  const staff = await requireStaff();
  if (!hasDb()) return demoResult;
  try {
    await applyBulkMedia(staff, listingId, formData);
    return { ok: true };
  } catch (e) {
    console.error("[crud-actions]", errorText(e));
    return { ok: false, error: errorText(e) };
  }
}

// ---- Admins --------------------------------------------------------------

// Add someone as an admin or to the QA team (role field: admin | qa). An
// email that is already on the list keeps its row and takes the new role.
export async function addAdmin(formData: FormData) {
  const actor = await requireAdmin();
  if (!hasDb()) redirect(`/admin/settings?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const email = field(formData, "email").toLowerCase();
    if (!EMAIL_RE.test(email)) fail("That email does not look right.");
    const role = toRole(field(formData, "role") || "admin");
    if (envAdminEmails().includes(email)) fail("That email is in the ADMIN_EMAILS environment variable, so it is always a full admin.");
    const d = db();
    const cur = await d.query.admins.findFirst({ where: eq(schema.admins.email, email), columns: { email: true, role: true } });
    if (cur) {
      if (toRole(cur.role) !== role) {
        await d.update(schema.admins).set({ role }).where(eq(schema.admins.email, email));
        await logActivity({ actorEmail: actor, action: "admin.role_set", meta: { email, role, from: toRole(cur.role) } });
      }
    } else {
      await d.insert(schema.admins).values({ email, name: field(formData, "name") || null, addedBy: actor, role }).onConflictDoNothing();
      await logActivity({ actorEmail: actor, action: "admin.added", meta: { email, role } });
    }
    forgetAdminCache();
    revalidatePath("/admin/settings");
    return { to: "/admin/settings?saved=1" };
  }, "/admin/settings");
  redirect(dest);
}

// Change an added person's role (admin or qa). Environment admins are always
// admins; nobody changes their own role (so the last admin cannot demote
// themselves by accident).
export async function setAdminRole(email: string, formData: FormData) {
  const actor = await requireAdmin();
  if (!hasDb()) redirect(`/admin/settings?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const e = String(email).trim().toLowerCase();
    const role = toRole(field(formData, "role"));
    if (envAdminEmails().includes(e)) fail("That admin is set in the ADMIN_EMAILS environment variable and is always a full admin.");
    if (e === actor.toLowerCase()) fail("You cannot change your own role.");
    const d = db();
    const cur = await d.query.admins.findFirst({ where: eq(schema.admins.email, e), columns: { email: true, role: true } });
    if (!cur) fail("That person is not on the list.");
    if (toRole(cur!.role) !== role) {
      await d.update(schema.admins).set({ role }).where(eq(schema.admins.email, e));
      forgetAdminCache();
      await logActivity({ actorEmail: actor, action: "admin.role_set", meta: { email: e, role, from: toRole(cur!.role) } });
    }
    revalidatePath("/admin/settings");
    return { to: "/admin/settings?saved=1" };
  }, "/admin/settings");
  redirect(dest);
}

export async function removeAdmin(email: string) {
  const actor = await requireAdmin();
  if (!hasDb()) redirect(`/admin/settings?error=${enc("Demo mode: nothing is saved.")}`);
  const dest = await attempt(async () => {
    const e = email.trim().toLowerCase();
    if (envAdminEmails().includes(e)) fail("That admin is set in the ADMIN_EMAILS environment variable and can only be removed there.");
    if (e === actor.toLowerCase()) fail("You cannot remove yourself.");
    await db().delete(schema.admins).where(eq(schema.admins.email, e));
    forgetAdminCache();
    await logActivity({ actorEmail: actor, action: "admin.removed", meta: { email: e } });
    revalidatePath("/admin/settings");
    return { to: "/admin/settings?saved=1" };
  }, "/admin/settings");
  redirect(dest);
}

// Row counts for the settings page (so an admin sees what the portal holds).
export async function portalCounts(): Promise<Record<string, number>> {
  await requireAdmin();
  if (!hasDb()) return {};
  const r = await db().execute(sql`select (select count(*)::int from clients) as clients, (select count(*)::int from listings) as listings, (select count(*)::int from media) as media`);
  return (r.rows[0] as Record<string, number>) ?? {};
}
