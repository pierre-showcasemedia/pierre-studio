// Admin reads: the whole picture across every client. Demo data until
// DATABASE_URL is set, same pattern as the client portal.
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { QcState, ShootStatus as PipelineStatus } from "@/db/schema";
import type {
  AdminActivity,
  AdminUnplacedText,
  AdminBookingDetail,
  AdminBookingInvoice,
  AdminBookingRow,
  AdminClient,
  AdminDownload,
  AdminFrame,
  AdminInvoice,
  AdminJob,
  AdminListing,
  AdminMedia,
  AdminReplacedOriginal,
  AdminRevision,
  AdminShoot,
  AdminShootFile,
  AdminUpcomingShoot,
  Attention,
  BookingQuery,
  DownloadQuery,
  ListingQuery,
} from "./admin-types";
import { creativeEmails, envAdminEmails } from "./admin-allow";
import { itemById } from "./studio-pricing";
import { visitKindLabel } from "./booking-visits";
import { fmtWhen as fmtBookingWhen, wallClockToUtc } from "./booking-time";
import { addDaysYmd, localYmd } from "./local-date";
import {
  DEMO_ACTIVITY,
  DEMO_BOOKING_LISTINGS,
  DEMO_BOOKINGS,
  DEMO_CLIENTS,
  DEMO_DOWNLOADS,
  DEMO_JOBS,
  DEMO_LISTINGS,
  DEMO_REVISIONS,
  DEMO_SHOOTS,
  demoFrames,
  demoShootFiles,
} from "./demo-data";
import { currentEnv } from "./jobs-core";
import { derivativeKey } from "./media-keys";
import { hasR2, signedViewUrl, objectExists } from "./r2";
import { shootStatus } from "./listing-status";
import { ACTIVE_STATUSES, fmtDate } from "./shoot-status";
import type { SiblingShoot } from "./finals-names";
import { clientVisibleMedia } from "./media-visibility";
import { qcFixesFor } from "./qc-fixes";

export type { AdminActivity, AdminBookingDetail, AdminBookingInvoice, AdminBookingRow, AdminClient, AdminDownload, AdminFrame, AdminInvoice, AdminJob, AdminListing, AdminMedia, AdminRevision, AdminShoot, AdminShootFile, AdminUpcomingShoot, Attention };

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const dayStr = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const norm = (s: string) => s.trim().toLowerCase();

// ---- Clients -------------------------------------------------------------

export async function adminClients(q?: string): Promise<AdminClient[]> {
  let rows: AdminClient[];
  if (!hasDb()) rows = DEMO_CLIENTS;
  else {
    const r = await db().query.clients.findMany({ with: { listings: { columns: { id: true } } }, orderBy: (c, { desc: dz }) => [dz(c.createdAt)] });
    rows = r.map((c) => ({ id: c.id, email: c.email, name: c.name, company: c.company, phone: c.phone, team: c.team, listingCount: c.listings.length, createdAt: c.createdAt.toISOString() }));
  }
  if (!q?.trim()) return rows;
  const n = norm(q);
  return rows.filter((c) => [c.email, c.name, c.company, c.team].some((v) => v && norm(v).includes(n)));
}

export async function adminClientById(id: string): Promise<AdminClient | null> {
  return (await adminClients()).find((c) => c.id === id) ?? null;
}

// ---- Listings ------------------------------------------------------------

type ListingRow = typeof schema.listings.$inferSelect & {
  client: typeof schema.clients.$inferSelect;
  media: { qcState: QcState; published: boolean; shootId: string | null }[];
  invoices: { status: string }[];
  shoots: { id: string; status: PipelineStatus; updatedAt: Date; createdAt: Date; publishedAt: Date | null }[];
};

function toAdminListing(l: ListingRow): AdminListing {
  // mediaCount is what the CLIENT sees: approved, published, shoot published.
  const approved = clientVisibleMedia(l.media, l.shoots).length;
  const pending = l.media.filter((m) => m.qcState === "pending").length;
  const latest = [...l.shoots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  // A video-only upload (Oct 21 2026) is finished the moment it is in: it is never the listing's active shoot.
  const active = latest && latest.status !== "published" && latest.status !== "draft" && latest.status !== "video_only" ? { id: latest.id, status: latest.status } : null;
  const stamps = [l.createdAt, l.deliveryEmailAt, l.approvedAt, latest?.updatedAt].filter((x): x is Date => Boolean(x));
  const updated = new Date(Math.max(...stamps.map((x) => x.getTime())));
  return {
    id: l.id,
    address: l.address,
    slug: l.slug,
    clientId: l.clientId,
    clientEmail: l.client.email,
    clientName: l.client.name,
    clientCompany: l.client.company,
    mediaCount: approved,
    pendingCount: pending,
    downloadLocked: l.downloadLocked,
    invoiceStatus: l.invoices.find((i) => i.status === "open")?.status ?? l.invoices[0]?.status ?? null,
    createdAt: l.createdAt.toISOString(),
    updatedAt: updated.toISOString(),
    shootDate: dayStr(l.shootDate),
    deliveryEmailAt: iso(l.deliveryEmailAt),
    approvedAt: iso(l.approvedAt),
    coverKey: l.coverKey,
    nda: l.nda,
    activeShoot: active,
  };
}

async function allListings(): Promise<AdminListing[]> {
  if (!hasDb()) return [...DEMO_LISTINGS, ...DEMO_BOOKING_LISTINGS];
  const rows = await db().query.listings.findMany({
    with: {
      client: true,
      media: { columns: { qcState: true, published: true, shootId: true } },
      invoices: { columns: { status: true } },
      shoots: { columns: { id: true, status: true, updatedAt: true, createdAt: true, publishedAt: true } },
    },
    orderBy: (l, { desc: dz }) => [dz(l.createdAt)],
  });
  return (rows as ListingRow[]).map(toAdminListing);
}

export function listingPipeline(l: AdminListing): "processing" | "review" | null {
  if (!l.activeShoot) return null;
  if (l.activeShoot.status === "ready_for_review") return "review";
  if (ACTIVE_STATUSES.includes(l.activeShoot.status)) return "processing";
  return null;
}

export function listingStatusLabel(l: AdminListing) {
  return shootStatus({ ...l, pipeline: listingPipeline(l) });
}

export async function adminListings(query: ListingQuery = {}): Promise<AdminListing[]> {
  let rows = await allListings();
  if (query.clientId) rows = rows.filter((l) => l.clientId === query.clientId);
  if (query.q?.trim()) {
    const n = norm(query.q);
    rows = rows.filter((l) => [l.address, l.slug, l.clientName, l.clientEmail, l.clientCompany].some((v) => v && norm(v).includes(n)));
  }
  if (query.status) rows = rows.filter((l) => listingStatusLabel(l) === query.status);
  const sort = query.sort ?? "newest_shoot";
  const order: Record<string, (a: AdminListing, b: AdminListing) => number> = {
    newest_shoot: (a, b) => (b.shootDate ?? b.createdAt.slice(0, 10)).localeCompare(a.shootDate ?? a.createdAt.slice(0, 10)) || b.createdAt.localeCompare(a.createdAt),
    client: (a, b) => (a.clientName ?? a.clientEmail).localeCompare(b.clientName ?? b.clientEmail) || a.address.localeCompare(b.address),
    status: (a, b) => listingStatusLabel(a).localeCompare(listingStatusLabel(b)) || b.updatedAt.localeCompare(a.updatedAt),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  };
  rows = [...rows].sort(order[sort] ?? order.newest_shoot);
  if (hasR2()) {
    await Promise.all(
      rows.map(async (l) => {
        if (!l.coverKey) return;
        try { l.coverUrl = await signedViewUrl(derivativeKey(l.coverKey, "preview")); } catch {}
      })
    );
  }
  return rows;
}

export async function adminListingById(id: string): Promise<AdminListing | null> {
  return (await allListings()).find((l) => l.id === id) ?? null;
}

// Small lists for the upload wizard.
export async function listingsForClientLite(clientId: string): Promise<{ id: string; address: string; slug: string; shootDate: string | null; nda: boolean }[]> {
  const rows = (await allListings()).filter((l) => l.clientId === clientId);
  return rows.map((l) => ({ id: l.id, address: l.address, slug: l.slug, shootDate: l.shootDate, nda: l.nda }));
}

// ---- Listing detail ------------------------------------------------------

export async function adminListingDetail(id: string): Promise<{
  listing: AdminListing;
  media: AdminMedia[];
  invoices: AdminInvoice[];
  downloads: AdminDownload[];
  revisionRequests: AdminRevision[];
  shoots: AdminShoot[];
  activity: AdminActivity[];
} | null> {
  const listing = await adminListingById(id);
  if (!listing) return null;
  if (!hasDb()) {
    const shoots = DEMO_SHOOTS.filter((s) => s.listingId === id);
    const media: AdminMedia[] = shoots.flatMap((s) => demoFrames(s)).map((f) => ({ id: f.id, kind: "photo", filename: f.filename, bytes: f.bytes, r2Key: f.r2Key, section: f.section, qcState: f.qcState, shootId: s_id(f.id), published: f.published, corrected: f.corrected, held: f.held }));
    return {
      listing,
      media,
      invoices: listing.invoiceStatus ? [{ id: "demo-inv-1", provider: "stripe", providerId: "in_demo123", stripeInvoiceId: "in_demo123", status: listing.invoiceStatus, method: "card", amountCents: 115000, hostedUrl: null, bookingId: null, createdAt: null }] : [],
      downloads: DEMO_DOWNLOADS.filter((d) => d.listingId === id),
      revisionRequests: DEMO_REVISIONS.filter((r) => r.listingId === id),
      shoots,
      activity: DEMO_ACTIVITY.filter((a) => a.listingId === id),
    };
  }
  const d = db();
  const l = await d.query.listings.findFirst({
    where: eq(schema.listings.id, id),
    with: { client: true, media: { orderBy: [asc(schema.media.sort)] }, invoices: true, revisionRequests: { with: { items: true, videoComments: true } }, shoots: { orderBy: [desc(schema.shoots.createdAt)] } },
  });
  if (!l) return null;
  const dls = await d.query.downloads.findMany({
    where: eq(schema.downloads.listingId, id),
    with: { media: { columns: { filename: true } } },
    orderBy: [desc(schema.downloads.at)],
    limit: 100,
  });
  const act = await adminActivity(30, id);
  return {
    listing,
    media: l.media.map((m) => ({ id: m.id, kind: m.kind, filename: m.filename, bytes: m.bytes, r2Key: m.r2Key, section: m.section, qcState: m.qcState, shootId: m.shootId, published: m.published, corrected: m.corrected, held: m.held })),
    invoices: l.invoices.map((i) => ({
      id: i.id,
      provider: i.provider ?? (i.stripeInvoiceId ? "stripe" : null),
      providerId: i.providerId ?? i.stripeInvoiceId,
      stripeInvoiceId: i.stripeInvoiceId,
      status: i.status,
      method: i.method,
      amountCents: i.amountCents ?? i.amountDue,
      hostedUrl: i.hostedUrl ?? i.hostedInvoiceUrl,
      bookingId: i.bookingId,
      createdAt: iso(i.createdAt),
    })),
    downloads: dls.map((x) => ({ at: x.at.toISOString(), clientEmail: x.clientEmail, filename: x.filename ?? x.media?.filename ?? "", address: l.address, listingId: l.id, slug: l.slug })),
    revisionRequests: l.revisionRequests
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => toRevision(r, l)),
    shoots: l.shoots.map((s) => toShoot(s, l)),
    activity: act,
  };
}

// ---- Shoots --------------------------------------------------------------

type ShootRow = typeof schema.shoots.$inferSelect;
type ListingLite = { id: string; address: string; slug: string; nda: boolean; dropboxFolder?: string | null; driveFolderId?: string | null; client: { name: string | null; email: string } };

function toShoot(s: ShootRow, l: ListingLite): AdminShoot {
  return {
    id: s.id,
    listingId: s.listingId,
    address: l.address,
    slug: l.slug,
    clientName: l.client.name,
    clientEmail: l.client.email,
    nda: l.nda,
    dropboxFolder: l.dropboxFolder ?? null,
    dropboxSyncedAt: iso(s.dropboxSyncedAt),
    driveFolderId: l.driveFolderId ?? null,
    driveSyncedAt: iso(s.driveSyncedAt),
    status: s.status,
    options: s.options ?? null,
    progress: (s.progress as Record<string, unknown> | null) ?? null,
    fileCount: s.fileCount,
    photoCount: s.photoCount,
    error: s.error,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    submittedAt: iso(s.submittedAt),
    readyAt: iso(s.readyAt),
    publishedAt: iso(s.publishedAt),
    publishedBy: s.publishedBy,
    stepStartedAt: iso(s.stepStartedAt),
    autohdrPhotoshootId: s.autohdrPhotoshootId,
    qcSummary: s.qcSummary ?? null,
    qcCheckedAt: iso(s.qcCheckedAt),
  };
}

// Demo frame ids are "<shootId>-m<n>" / "<shootId>-t<n>".
const s_id = (frameId: string) => frameId.replace(/-(m|t)\d+$/, "");

export async function adminShoots(filter: { statuses?: PipelineStatus[]; limit?: number } = {}): Promise<AdminShoot[]> {
  let rows: AdminShoot[];
  if (!hasDb()) rows = DEMO_SHOOTS;
  else {
    const r = await db().query.shoots.findMany({
      where: filter.statuses?.length ? inArray(schema.shoots.status, filter.statuses) : undefined,
      with: { listing: { with: { client: { columns: { name: true, email: true } } } } },
      orderBy: [desc(schema.shoots.updatedAt)],
      limit: filter.limit ?? 200,
    });
    rows = r.map((s) => toShoot(s, s.listing));
  }
  if (filter.statuses?.length) rows = rows.filter((s) => filter.statuses!.includes(s.status));
  return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, filter.limit ?? 200);
}

// Nov 2 2026 (20 Dogwood): the listing's other shoots that have frames,
// with their frame names, for the shoot page's corrected photos box
// (src/lib/finals-names.ts): a drop whose names match none of this shoot's
// frames but all of another's is on the wrong shoot, and the box says which.
export async function siblingShootFrames(listingId: string, shootId: string): Promise<SiblingShoot[]> {
  const label = (s: { submittedAt: string | Date | null; createdAt: string | Date }) => `the shoot uploaded ${fmtDate(s.submittedAt ?? s.createdAt)}`;
  if (!hasDb()) {
    return DEMO_SHOOTS.filter((s) => s.listingId === listingId && s.id !== shootId)
      .map((s) => ({ shootId: s.id, label: label(s), frameNames: demoFrames(s).map((f) => f.filename) }))
      .filter((s) => s.frameNames.length > 0);
  }
  const rows = await db().query.shoots.findMany({
    where: and(eq(schema.shoots.listingId, listingId), ne(schema.shoots.id, shootId)),
    columns: { id: true, submittedAt: true, createdAt: true },
    with: { media: { columns: { filename: true } } },
  });
  return rows.filter((s) => s.media.length > 0).map((s) => ({ shootId: s.id, label: label(s), frameNames: s.media.map((m) => m.filename) }));
}

export async function adminShootDetail(id: string): Promise<{ shoot: AdminShoot; files: AdminShootFile[]; frames: AdminFrame[] } | null> {
  if (!hasDb()) {
    const shoot = DEMO_SHOOTS.find((s) => s.id === id);
    if (!shoot) return null;
    return { shoot, files: demoShootFiles(shoot), frames: demoFrames(shoot) };
  }
  const d = db();
  const s = await d.query.shoots.findFirst({
    where: eq(schema.shoots.id, id),
    with: { listing: { with: { client: { columns: { name: true, email: true } } } }, files: { orderBy: [asc(schema.shootFiles.filename)] }, media: { orderBy: [asc(schema.media.sort)] } },
  });
  if (!s) return null;
  const fixes = await qcFixesFor(s.media.map((m) => m.id));
  const frames: AdminFrame[] = await Promise.all(
    s.media.map(async (m, i) => ({
      id: m.id,
      filename: m.filename,
      r2Key: m.r2Key,
      section: m.section,
      qcState: m.qcState,
      sort: m.sort,
      bytes: m.bytes,
      thumbUrl: hasR2() ? await signedViewUrl(derivativeKey(m.r2Key, "thumb")).catch(() => null) : null,
      largeUrl: hasR2() ? await signedViewUrl(derivativeKey(m.r2Key, "mls")).catch(() => null) : null,
      fullUrl: hasR2() ? await signedViewUrl(m.r2Key).catch(() => null) : null,
      hue: (i * 37) % 360,
      published: m.published,
      corrected: m.corrected,
      held: m.held,
      revision: m.revision,
      qcScore: m.qcScore,
      qcIssues: m.qcIssues ?? null,
      qcSuggestions: m.qcSuggestions ?? null,
      qcSummary: m.qcSummary,
      qcCheckedAt: iso(m.qcCheckedAt),
      qcFixes: fixes.get(m.id) ?? {},
    }))
  );
  return {
    shoot: toShoot(s, s.listing),
    files: s.files.map((f) => ({ id: f.id, filename: f.filename, bytes: f.bytes, kind: f.kind, uploaded: Boolean(f.autohdrUploadedAt), dropboxPath: f.dropboxPath, dropboxSyncedAt: iso(f.dropboxSyncedAt), driveSyncedAt: iso(f.driveSyncedAt), r2DeletedAt: iso(f.r2DeletedAt) })),
    frames,
  };
}

// ---- Revisions -----------------------------------------------------------

type RevRow = typeof schema.revisionRequests.$inferSelect & { items?: (typeof schema.revisionItems.$inferSelect)[]; videoComments?: (typeof schema.videoComments.$inferSelect)[] };
export function toRevision(r: RevRow, l: { id: string; address: string; slug: string; clientId: string; client: { name: string | null; email: string } }): AdminRevision {
  const sentAt = r.submittedAt ?? null;
  const items = [...(r.items ?? [])]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((i) => ({ id: i.id, mediaId: i.mediaId, filename: i.filename, note: i.note, createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString(), sent: Boolean(sentAt && i.updatedAt.getTime() <= sentAt.getTime()) }));
  return {
    items,
    submittedAt: iso(sentAt),
    unsent: items.filter((i) => !i.sent).length,
    id: r.id,
    listingId: l.id,
    address: l.address,
    slug: l.slug,
    clientId: l.clientId,
    clientEmail: r.clientEmail,
    clientName: l.client.name,
    notes: r.notes,
    filenames: r.filenames ? r.filenames.split(",").map((s) => s.trim()).filter(Boolean) : [],
    createdAt: r.createdAt.toISOString(),
    status: r.status,
    resolvedAt: iso(r.resolvedAt),
    resolvedBy: r.resolvedBy,
    source: r.source ?? null,
    sourceText: r.sourceText ?? null,
    needsReview: r.needsReview ?? false,
    reviewNote: r.reviewNote ?? null,
    mediaKind: r.mediaKind === "video" ? "video" : "photo",
    videoComments: [...(r.videoComments ?? [])]
      .sort((a, b) => a.filename.localeCompare(b.filename) || a.atMs - b.atMs)
      .map((c) => ({ id: c.id, filename: c.filename, atMs: c.atMs, note: c.note })),
  };
}

// Revision texts the intake could not place (src/lib/revision-intake.ts), newest first.
export async function adminUnplacedTexts(): Promise<AdminUnplacedText[]> {
  if (!hasDb()) return [];
  const rows = await db().query.inboundMessages.findMany({ where: eq(schema.inboundMessages.status, "needs_review"), orderBy: [desc(schema.inboundMessages.receivedAt)], limit: 50 });
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((x): x is string => Boolean(x)))];
  const clients = clientIds.length ? await db().query.clients.findMany({ where: inArray(schema.clients.id, clientIds), columns: { id: true, name: true, email: true } }) : [];
  const byId = new Map(clients.map((c) => [c.id, c]));
  return rows.map((r) => {
    const res = (r.result ?? {}) as { reason?: string; summary?: string };
    const c = r.clientId ? byId.get(r.clientId) : undefined;
    return { id: r.id, source: r.source, from: r.fromAddr, receivedAt: (r.sentAt ?? r.receivedAt).toISOString(), body: r.body ?? "", photos: (r.media ?? []).length, clientName: c?.name ?? null, clientEmail: c?.email ?? null, reason: res.reason ?? "", summary: res.summary ?? "" };
  });
}

export async function adminRevisions(): Promise<AdminRevision[]> {
  if (!hasDb()) return [...DEMO_REVISIONS].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows = await db().query.revisionRequests.findMany({
    with: { listing: { with: { client: { columns: { name: true, email: true } } } }, items: true, videoComments: true },
    orderBy: [desc(schema.revisionRequests.createdAt)],
    limit: 500,
  });
  return rows.map((r) => toRevision(r, r.listing));
}

// kind "photo": the Photo QC team's count (Oct 26 2026).
export async function openRevisionCount(kind?: "photo" | "video"): Promise<number> {
  if (!hasDb()) return DEMO_REVISIONS.filter((r) => r.status !== "done" && (!kind || (r.mediaKind ?? "photo") === kind)).length;
  const rows = await db().query.revisionRequests.findMany({ where: and(inArray(schema.revisionRequests.status, ["new", "in_progress"]), kind ? eq(schema.revisionRequests.mediaKind, kind) : undefined), columns: { id: true } });
  return rows.length;
}

// ---- Downloads -----------------------------------------------------------

export async function adminDownloads(query: DownloadQuery = {}): Promise<AdminDownload[]> {
  let rows: AdminDownload[];
  if (!hasDb()) rows = DEMO_DOWNLOADS;
  else {
    const r = await db().query.downloads.findMany({
      where: query.listingId ? eq(schema.downloads.listingId, query.listingId) : undefined,
      with: { media: { columns: { filename: true } }, listing: { columns: { id: true, address: true, slug: true, clientId: true } } },
      orderBy: [desc(schema.downloads.at)],
      limit: 1000,
    });
    rows = r
      .filter((x) => !query.clientId || x.listing.clientId === query.clientId)
      .map((x) => ({ at: x.at.toISOString(), clientEmail: x.clientEmail, filename: x.filename ?? x.media?.filename ?? "", address: x.listing.address, listingId: x.listing.id, slug: x.listing.slug }));
  }
  if (query.clientId && !hasDb()) {
    const emails = new Set(DEMO_LISTINGS.filter((l) => l.clientId === query.clientId).map((l) => l.id));
    rows = rows.filter((x) => emails.has(x.listingId));
  }
  if (query.listingId) rows = rows.filter((x) => x.listingId === query.listingId);
  if (query.from) rows = rows.filter((x) => x.at.slice(0, 10) >= query.from!);
  if (query.to) rows = rows.filter((x) => x.at.slice(0, 10) <= query.to!);
  const sort = query.sort ?? "date";
  const order: Record<string, (a: AdminDownload, b: AdminDownload) => number> = {
    date: (a, b) => b.at.localeCompare(a.at),
    client: (a, b) => a.clientEmail.localeCompare(b.clientEmail) || b.at.localeCompare(a.at),
    listing: (a, b) => a.address.localeCompare(b.address) || b.at.localeCompare(a.at),
  };
  return [...rows].sort(order[sort] ?? order.date);
}

// ---- Activity ------------------------------------------------------------

export async function adminActivity(limit = 15, listingId?: string): Promise<AdminActivity[]> {
  if (!hasDb()) return DEMO_ACTIVITY.filter((a) => !listingId || a.listingId === listingId).slice(0, limit);
  const rows = await db().query.activity.findMany({
    where: listingId ? eq(schema.activity.listingId, listingId) : undefined,
    with: { listing: { columns: { address: true } } },
    orderBy: [desc(schema.activity.createdAt)],
    limit,
  });
  return rows.map((a) => ({
    id: a.id,
    actorEmail: a.actorEmail,
    action: a.action,
    listingId: a.listingId,
    shootId: a.shootId,
    clientId: a.clientId,
    meta: (a.meta as Record<string, unknown> | null) ?? null,
    createdAt: a.createdAt.toISOString(),
    address: a.listing?.address ?? null,
  }));
}

// ---- Replaced originals (Oct 2026) ------------------------------------------
// What a corrected final replaced, newest first: the media.replaced rows of a
// shoot or a listing. Internal only; the link is the shoot download route.
export async function adminReplacedOriginals(scope: { shootId?: string; listingId?: string }, limit = 200): Promise<AdminReplacedOriginal[]> {
  if (!hasDb() || (!scope.shootId && !scope.listingId)) return [];
  const rows = await db().query.activity.findMany({
    where: and(
      eq(schema.activity.action, "media.replaced"),
      scope.shootId ? eq(schema.activity.shootId, scope.shootId) : undefined,
      scope.listingId ? eq(schema.activity.listingId, scope.listingId) : undefined
    ),
    orderBy: [desc(schema.activity.createdAt)],
    limit,
  });
  return rows
    .filter((a) => a.shootId && typeof a.meta?.previous === "string")
    .map((a) => ({
      id: a.id,
      shootId: a.shootId!,
      filename: typeof a.meta?.filename === "string" ? a.meta.filename : "frame",
      at: a.createdAt.toISOString(),
      by: a.actorEmail,
      href: `/api/studio/shoots/${a.shootId}/download?replaced=${a.id}`,
    }));
}

// ---- Published shoots with frames waiting (Oct 2026) ---------------------
// Published shoots whose corrected or approved frames are still waiting for
// Publish: the Photo QC board (src/lib/photo-qc.ts) puts them back in Ready
// for QC. Reads media rows only, never money.
export async function publishedWaiting(published: AdminShoot[]): Promise<Map<string, { waiting: number; internal: number }>> {
  const out = new Map<string, { waiting: number; internal: number }>();
  if (!published.length) return out;
  const rows = hasDb()
    ? await db().query.media.findMany({ where: inArray(schema.media.shootId, published.map((s) => s.id)), columns: { shootId: true, qcState: true, published: true, held: true } })
    : published.flatMap((s) => demoFrames(s).map((f) => ({ shootId: s.id, qcState: f.qcState, published: f.published, held: f.held })));
  for (const s of published) {
    const mine = rows.filter((m) => m.shootId === s.id);
    // Approved, not live and not held back: what Publish would still send.
    // (Nov 2 2026: only approved photos ever publish, so unreviewed leftovers
    // no longer hold a shoot in Ready for QC.)
    const waiting = mine.filter((m) => m.qcState === "approved" && !m.published && !m.held).length;
    if (waiting) out.set(s.id, { waiting, internal: mine.filter((m) => !(m.qcState === "approved" && m.published)).length });
  }
  return out;
}

// ---- Dashboard -----------------------------------------------------------

export async function adminDashboard(): Promise<{
  attention: Attention;
  upcoming: AdminUpcomingShoot[];
  recentDeliveries: AdminListing[];
  activity: AdminActivity[];
  openRevisions: AdminRevision[];
  reviewShoots: AdminShoot[];
}> {
  const [listings, shoots, revisions, activity, bookings] = await Promise.all([allListings(), adminShoots(), adminRevisions(), adminActivity(15), adminBookings({ filter: "all" })]);
  // Read after the bookings: a return shoot shows only under a booking of this environment.
  const visits = await upcomingVisitRows(bookings);
  const openRevisions = revisions.filter((r) => r.status !== "done");
  const reviewShoots = shoots.filter((s) => s.status === "ready_for_review");
  const attention: Attention = {
    processing: shoots.filter((s) => ACTIVE_STATUSES.includes(s.status)).length,
    review: reviewShoots.length,
    revisionsOpen: openRevisions.length,
    deliveredUnpaid: listings.filter((l) => l.mediaCount > 0 && l.downloadLocked && Boolean(l.deliveryEmailAt)).length,
    publishedNoEmail: listings.filter((l) => l.mediaCount > 0 && !l.deliveryEmailAt).length,
    failed: shoots.filter((s) => s.status === "failed").length,
    unpaidBookings: bookings.filter(bookingFilters.unpaid).length,
    paymentsInReview: bookings.filter(bookingFilters.review).length,
    // The same definition as the "Stopped" filter the tile links to: bookings
    // with a side-effect job that gave up, not a raw dead-job count.
    failedJobs: bookings.filter(bookingFilters.failed).length,
    toConfirm: bookings.filter(bookingFilters.to_confirm).length,
  };
  const upcoming = upcomingShoots(bookings, listings, visits);
  const recentDeliveries = listings
    .filter((l) => l.deliveryEmailAt)
    .sort((a, b) => b.deliveryEmailAt!.localeCompare(a.deliveryEmailAt!))
    .slice(0, 5);
  return { attention, upcoming, recentDeliveries, activity, openRevisions, reviewShoots };
}

// "Upcoming shoots · next 14 days", local: the bookings (Unconfirmed and
// Confirmed, never canceled) dated today through two weeks out, every
// Unconfirmed request whose time has passed or that has no date yet (flagged,
// so a request never drops off the dashboard), and the listings that carry a
// shoot date but no live booking (older the previous portal rows), one row per listing,
// plus every scheduled return shoot in the window on its own date (Oct 28
// 2026, upcomingVisitRows), soonest first by date and time.
function upcomingShoots(bookings: AdminBookingRow[], listings: AdminListing[], visits: AdminBookingRow[] = []): AdminUpcomingShoot[] {
  const today = localYmd();
  const horizon = addDaysYmd(today, 14);
  const rows: AdminUpcomingShoot[] = [];
  const seen = new Set<string>();
  const inWindow = (d: string | null) => Boolean(d && d >= today && d <= horizon);
  for (const b of bookings) {
    if (b.status !== "requested" && b.status !== "confirmed") continue;
    const keep = inWindow(b.desiredDate) || b.datePassed || (b.status === "requested" && !b.desiredDate);
    if (!keep || seen.has(b.listingId)) continue;
    seen.add(b.listingId);
    rows.push({
      key: `b-${b.id}`,
      kind: "booking",
      href: `/admin/bookings/${b.id}`,
      bookingId: b.id,
      listingId: b.listingId,
      clientId: b.client.id,
      date: b.desiredDate,
      time: b.startTime,
      address: b.address,
      nda: b.nda,
      clientName: b.client.name,
      clientEmail: b.client.email,
      shooter: b.photographerEmail,
      status: b.status,
      datePassed: b.datePassed,
    });
  }
  for (const v of visits) {
    if (!v.visit || !inWindow(v.desiredDate)) continue;
    rows.push({
      key: `v-${v.visit.id}`,
      kind: "booking",
      href: `/admin/bookings/${v.id}#visits`,
      bookingId: v.id,
      listingId: v.listingId,
      clientId: v.client.id,
      date: v.desiredDate,
      time: v.startTime,
      address: v.address,
      nda: v.nda,
      clientName: v.client.name,
      clientEmail: v.client.email,
      shooter: v.photographerEmail,
      status: null,
      datePassed: false,
      returnShoot: true,
    });
  }
  // A listing a live booking manages is that booking's row (or deliberately
  // off the list, like a shot one); only bookingless listings come in here.
  const booked = new Set(bookings.filter((b) => b.status !== "canceled").map((b) => b.listingId));
  for (const l of listings) {
    if (!inWindow(l.shootDate) || l.mediaCount > 0 || booked.has(l.id) || seen.has(l.id)) continue;
    seen.add(l.id);
    rows.push({
      key: `l-${l.id}`,
      kind: "listing",
      href: `/admin/listings/${l.id}`,
      bookingId: null,
      listingId: l.id,
      clientId: l.clientId,
      date: l.shootDate,
      time: null,
      address: l.address,
      nda: l.nda,
      clientName: l.clientName,
      clientEmail: l.clientEmail,
      shooter: null,
      status: null,
      datePassed: false,
    });
  }
  const key = (r: AdminUpcomingShoot) => `${r.date ?? "9999-99-99"}T${r.time ?? "99:99"}`;
  return rows.sort((a, b) => key(a).localeCompare(key(b)) || a.address.localeCompare(b.address));
}

// Does the thumb for a frame exist yet? (lazy derivative check)
export async function thumbExists(r2Key: string): Promise<boolean> {
  return hasR2() ? objectExists(derivativeKey(r2Key, "thumb")) : false;
}

// ---- Bookings (step two, docs/booking-to-payment.md) ------------
// Rows for THIS environment only: preview and production share one database,
// and a preview admin must never act on a production booking (its jobs would
// be written with env = preview and drained here). Production also owns the
// rows written before env existed.

// "Today" is the local calendar date (the server's UTC date flips at 5 PM
// local, which used to drop same-day bookings out of Upcoming).
const todayYmd = () => localYmd();

// Still Unconfirmed and the requested time is behind us, local: an earlier
// date, or today with a start time that has passed (a same-day request that
// arrives after its own slot, like the website allows).
function requestPassed(b: { status: string; desiredDate: string | null; startTime: string | null }, now: Date, today: string): boolean {
  if (b.status !== "requested" || !b.desiredDate) return false;
  if (b.desiredDate < today) return true;
  if (b.desiredDate > today || !b.startTime) return false;
  const at = wallClockToUtc(b.desiredDate, b.startTime);
  return Boolean(at && at.getTime() < now.getTime());
}

function withFlags<T extends AdminBookingRow>(rows: T[]): T[] {
  const now = new Date();
  const today = localYmd(now);
  return rows.map((b) => ({ ...b, datePassed: requestPassed(b, now, today) }));
}

function bookingsEnvWhere() {
  const env = currentEnv();
  return env === "production" ? or(eq(schema.bookings.env, env), isNull(schema.bookings.env)) : eq(schema.bookings.env, env);
}

type InvoiceRow = typeof schema.invoices.$inferSelect;
type BookingRowDb = typeof schema.bookings.$inferSelect & {
  listing: { id: string; address: string; slug: string; nda: boolean; downloadLocked: boolean } | null;
  client: { id: string; name: string | null; email: string; phone: string | null; company: string | null } | null;
  invoice: InvoiceRow | null;
};

function toBookingInvoice(i: InvoiceRow): AdminBookingInvoice {
  return {
    id: i.id,
    status: i.status,
    amountCents: i.amountCents ?? i.amountDue,
    provider: i.provider ?? (i.stripeInvoiceId ? "stripe" : null),
    providerId: i.providerId ?? i.stripeInvoiceId,
    hostedUrl: i.hostedUrl ?? i.hostedInvoiceUrl,
    method: i.method,
    paidAt: iso(i.paidAt),
    refundedCents: i.refundedCents,
    description: i.description,
    lineItems: i.lineItems ?? [],
    idempotencyVersion: i.idempotencyVersion,
    lastEvent: i.lastEvent ?? null,
    lastCheckedAt: iso(i.lastCheckedAt),
    meta: i.meta ?? null,
    createdAt: iso(i.createdAt),
  };
}

function addonsLabelOf(ids: string[] | null): string | null {
  // Names only (never prices): the add-on ids map back to the price table.
  if (!ids?.length) return null;
  return ids.map((id) => itemById(id)?.name ?? id).join(" + ");
}

function toBookingDetail(b: BookingRowDb, deadJobs: number): AdminBookingDetail {
  const street = (b.property?.street as string | undefined) ?? "";
  return {
    id: b.id,
    when: fmtBookingWhen({ desiredDate: b.desiredDate, startTime: b.startTime }),
    desiredDate: b.desiredDate,
    startTime: b.startTime,
    startsAt: iso(b.startsAt),
    endsAt: iso(b.endsAt),
    address: b.listing?.address ?? street,
    slug: b.listing?.slug ?? "",
    listingId: b.listingId,
    nda: b.listing?.nda ?? false,
    listingLocked: b.listing?.downloadLocked ?? true,
    client: b.client ? { id: b.client.id, name: b.client.name, email: b.client.email, phone: b.client.phone, company: b.client.company } : { id: b.clientId, name: null, email: "", phone: null, company: null },
    servicesLabel: b.servicesLabel,
    addonsLabel: addonsLabelOf(b.addonIds),
    paymentMethod: b.paymentMethod,
    paymentDetail: b.paymentDetail,
    invoice: b.invoice ? toBookingInvoice(b.invoice) : null,
    calendarSynced: Boolean(b.calendarEventId),
    calendarEventId: b.calendarEventId,
    photographerEmail: b.photographerEmail,
    status: b.status,
    market: b.market,
    deadJobs,
    datePassed: false, // withFlags sets it at read time
    movedByClient: b.clientRescheduledAt ? { at: b.clientRescheduledAt.toISOString(), from: b.clientRescheduledFrom } : null,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
    launchDate: b.launchDate,
    sqft: b.sqft,
    tier: b.tier,
    serviceIds: b.serviceIds ?? [],
    addonIds: b.addonIds ?? [],
    items: b.items ?? [],
    clientType: b.clientType ?? null,
    customRequest: b.customRequest,
    accessNotes: b.accessNotes,
    property: b.property ?? null,
    signedName: b.signedName,
    signedAt: iso(b.signedAt),
    clientNotes: b.clientNotes,
    internalNote: b.internalNote,
    calendarVersion: b.calendarVersion,
    calendarSyncedAt: iso(b.calendarSyncedAt),
    source: b.source,
    env: b.env,
    raw: b.raw ?? null,
  };
}

// Dead (gave up) side-effect jobs per booking, this environment.
async function deadJobsByBooking(): Promise<Map<string, number>> {
  const rows = await db()
    .select({ bookingId: schema.jobs.bookingId, n: sql<number>`count(*)::int` })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.env, currentEnv()), eq(schema.jobs.status, "dead")))
    .groupBy(schema.jobs.bookingId);
  const out = new Map<string, number>();
  for (const r of rows) if (r.bookingId) out.set(r.bookingId, Number(r.n));
  return out;
}

// Upcoming: not canceled, and dated today or later (local), undated, or an
// Unconfirmed request whose date has passed (it waits here, flagged "Date
// passed", until an admin sets a new time or another status).
const isUpcoming = (b: AdminBookingRow, today: string) =>
  b.status !== "canceled" && (!b.desiredDate || b.desiredDate >= today || b.status === "requested");

// The list filters and the dashboard counts share one definition.
export const bookingFilters: Record<Exclude<NonNullable<BookingQuery["filter"]>, "all">, (b: AdminBookingRow) => boolean> = {
  upcoming: (b) => isUpcoming(b, todayYmd()),
  to_confirm: (b) => b.status === "requested",
  // The client moved it from the portal and nobody has reconfirmed yet.
  rescheduled: (b) => b.status !== "canceled" && Boolean(b.movedByClient),
  needs_quote: (b) => b.status !== "canceled" && b.invoice?.status === "needs_quote",
  unpaid: (b) => isUpcoming(b, todayYmd()) && (b.invoice?.status === "open" || b.invoice?.status === "needs_quote"),
  review: (b) => b.status !== "canceled" && (b.invoice?.status === "processing" || b.invoice?.status === "review"),
  failed: (b) => b.deadJobs > 0,
};

// Unconfirmed requests whose date passed come first (they need a new time),
// then upcoming (soonest at the top, undated right after), then the past,
// most recent first.
function sortBookings(rows: AdminBookingRow[]): AdminBookingRow[] {
  const today = todayYmd();
  const key = (b: AdminBookingRow) => `${b.desiredDate ?? "9999-99-99"}T${b.startTime ?? "99:99"}`;
  const soonest = (a: AdminBookingRow, b: AdminBookingRow) => key(a).localeCompare(key(b)) || b.createdAt.localeCompare(a.createdAt);
  const stale = rows.filter((b) => b.datePassed && b.status !== "canceled").sort(soonest);
  const rest = rows.filter((b) => !(b.datePassed && b.status !== "canceled"));
  const upcoming = rest.filter((b) => !b.desiredDate || b.desiredDate >= today).sort(soonest);
  const past = rest.filter((b) => b.desiredDate && b.desiredDate < today).sort((a, b) => key(b).localeCompare(key(a)));
  return [...stale, ...upcoming, ...past];
}

async function allBookings(): Promise<AdminBookingDetail[]> {
  if (!hasDb()) return withFlags(DEMO_BOOKINGS);
  const d = db();
  const [rows, dead] = await Promise.all([
    d.query.bookings.findMany({
      where: bookingsEnvWhere(),
      with: {
        listing: { columns: { id: true, address: true, slug: true, nda: true, downloadLocked: true } },
        client: { columns: { id: true, name: true, email: true, phone: true, company: true } },
        invoice: true,
      },
      orderBy: [desc(schema.bookings.createdAt)],
      limit: 500,
    }),
    deadJobsByBooking(),
  ]);
  return withFlags((rows as BookingRowDb[]).map((b) => toBookingDetail(b, dead.get(b.id) ?? 0)));
}

// Return shoots (Oct 28 2026, the coordinator: "We need to be able to see return shoots
// listed under upcoming bookings"). An additional shoot (src/lib/booking-visits.ts)
// lives in booking_visits, not bookings, so a return trip on a booking whose
// own date has passed never reached Upcoming. Here every scheduled one dated
// today or later (local), on a booking of this environment that is not
// canceled, becomes a row of its own: the booking's address and client, the
// visit's date, time, shooter and own invoice, and "Return shoot" as its
// services. The row keeps the booking's id, so it opens that booking. Only
// Upcoming lists these; the other filters and the dashboard counts are
// bookings only. Until the migrate route has created the table, none.
async function upcomingVisitRows(bookings: AdminBookingRow[]): Promise<AdminBookingRow[]> {
  if (!hasDb()) return [];
  const byId = new Map(bookings.filter((b) => b.status !== "canceled").map((b) => [b.id, b]));
  if (!byId.size) return [];
  try {
    const d = db();
    const visits = (
      await d.query.bookingVisits.findMany({
        where: and(eq(schema.bookingVisits.status, "scheduled"), gte(schema.bookingVisits.desiredDate, todayYmd())),
        orderBy: [asc(schema.bookingVisits.startsAt)],
      })
    ).filter((v) => byId.has(v.bookingId));
    const invoiceIds = visits.map((v) => v.invoiceId).filter((x): x is string => Boolean(x));
    const invoices = invoiceIds.length ? await d.query.invoices.findMany({ where: inArray(schema.invoices.id, invoiceIds) }) : [];
    const invoiceById = new Map(invoices.map((i) => [i.id, toBookingInvoice(i)]));
    return visits.map((v) => {
      const b = byId.get(v.bookingId)!;
      const kind = v.kind === "return_trip" || v.kind === "other" ? null : visitKindLabel(v.kind);
      const note = v.note?.trim() ? (v.note.trim().length > 110 ? `${v.note.trim().slice(0, 110)}…` : v.note.trim()) : null;
      const row: AdminBookingRow = {
        ...b,
        when: fmtBookingWhen({ desiredDate: v.desiredDate, startTime: v.startTime }),
        desiredDate: v.desiredDate,
        startTime: v.startTime,
        startsAt: iso(v.startsAt),
        endsAt: iso(v.endsAt),
        servicesLabel: "Return shoot",
        addonsLabel: [kind, note].filter(Boolean).join(" · ") || null,
        paymentMethod: null,
        paymentDetail: null,
        invoice: v.invoiceId ? invoiceById.get(v.invoiceId) ?? null : null,
        calendarSynced: Boolean(v.calendarEventId),
        calendarEventId: v.calendarEventId,
        photographerEmail: v.photographerEmail,
        deadJobs: 0,
        datePassed: false,
        movedByClient: null,
        visit: { id: v.id, kindLabel: visitKindLabel(v.kind), note: v.note },
      };
      return row;
    });
  } catch (e) {
    console.error("[admin-data] return shoots read failed (has the migrate route run?)", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function adminBookings(query: BookingQuery = {}): Promise<AdminBookingRow[]> {
  const all: AdminBookingRow[] = await allBookings();
  let rows = all;
  const filter = query.filter ?? "upcoming";
  if (filter !== "all") rows = rows.filter(bookingFilters[filter]);
  if (filter === "upcoming") rows = [...rows, ...(await upcomingVisitRows(all))];
  if (query.q?.trim()) {
    const n = norm(query.q);
    rows = rows.filter((b) => [b.address, b.slug, b.client.name, b.client.email, b.client.company, b.servicesLabel].some((v) => v && norm(v).includes(n)));
  }
  return sortBookings(rows);
}

export async function adminBooking(id: string): Promise<{ booking: AdminBookingDetail; activity: AdminActivity[]; jobs: AdminJob[] } | null> {
  if (!hasDb()) {
    const found = DEMO_BOOKINGS.find((b) => b.id === id);
    if (!found) return null;
    const [booking] = withFlags([found]);
    return { booking, activity: DEMO_ACTIVITY.filter((a) => a.listingId === booking.listingId), jobs: DEMO_JOBS[booking.id] ?? [] };
  }
  const d = db();
  // Same environment rule as the list: a production id pasted into a preview
  // (links in Slack and the activity feed carry ids) is a 404 here, so none of
  // the page's actions can reach it either (each re-checks env on its own).
  const row = await d.query.bookings.findFirst({
    where: and(eq(schema.bookings.id, id), bookingsEnvWhere()),
    with: {
      listing: { columns: { id: true, address: true, slug: true, nda: true, downloadLocked: true } },
      client: { columns: { id: true, name: true, email: true, phone: true, company: true } },
      invoice: true,
    },
  });
  if (!row) return null;
  const b = row as BookingRowDb;
  // Every side effect of this booking: its own jobs plus the invoice's
  // (payment jobs carry the invoice id, not always the booking id).
  const jobRows = await d.query.jobs.findMany({
    where: b.invoiceId ? or(eq(schema.jobs.bookingId, b.id), eq(schema.jobs.invoiceId, b.invoiceId)) : eq(schema.jobs.bookingId, b.id),
    orderBy: [desc(schema.jobs.createdAt)],
    limit: 100,
  });
  const jobs: AdminJob[] = jobRows.map((j) => ({
    id: j.id,
    kind: j.kind,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    lastError: j.lastError,
    runAt: j.runAt.toISOString(),
    doneAt: iso(j.doneAt),
    alertedAt: iso(j.alertedAt),
    createdAt: j.createdAt.toISOString(),
    idempotencyKey: j.idempotencyKey,
  }));
  const dead = jobs.filter((j) => j.status === "dead").length;
  const activity = await adminActivity(60, b.listingId);
  const [booking] = withFlags([toBookingDetail(b, dead)]);
  return { booking, activity, jobs };
}

// Suggestions for the shooter field: the creative specialists first (the
// shooters on /admin/settings, Oct 21 2026), then the default shooter,
// everyone who has shot for this environment before, then the team
// (ADMIN_EMAILS and the admins added on /admin/settings). The field takes any
// email.
export async function shooterSuggestions(): Promise<string[]> {
  const out = new Set<string>();
  const add = (e: string | null | undefined) => {
    const v = (e ?? "").trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) out.add(v);
  };
  for (const e of await creativeEmails()) add(e);
  add(process.env.DEFAULT_SHOOTER_EMAIL);
  if (!hasDb()) {
    for (const b of DEMO_BOOKINGS) add(b.photographerEmail);
  } else {
    try {
      const used = await db().selectDistinct({ email: schema.bookings.photographerEmail }).from(schema.bookings).where(bookingsEnvWhere()).limit(50);
      for (const r of used) add(r.email);
    } catch (e) {
      console.error("[admin-data] shooter suggestions", e);
    }
  }
  for (const e of envAdminEmails()) add(e);
  if (hasDb()) {
    try {
      for (const r of await db().query.admins.findMany({ columns: { email: true } })) add(r.email);
    } catch {
      // The admins table lands with the migrate route; the env list is enough.
    }
  }
  return [...out];
}
