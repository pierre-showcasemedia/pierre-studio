// Reads for the one-portal admin pages (Oct 2026): teams, the client detail
// page, the admin roster and the listing editor's media rows. Demo data when
// DATABASE_URL is unset, like admin-data.ts.
import { asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import type { AdminAdmin, AdminClient, AdminClientDetail, AdminMediaRow, AdminTeam } from "./admin-types";
import { adminBookings, adminClients, adminListings, toRevision } from "./admin-data";
import { envAdminEmails, toRole } from "./admin-allow";
import { derivativeKey } from "./media-keys";
import { hasR2, signedDownloadUrl, signedViewUrl } from "./r2";
import { DEMO_ACTIVITY, DEMO_DOWNLOADS, DEMO_LISTINGS, DEMO_REVISIONS, DEMO_SHOOTS, DEMO_STAFF, demoFrames } from "./demo-data";
import { DEMO_PHOTOS, type DemoPhoto } from "./demo-photos";

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const byName = (a: AdminClient, b: AdminClient) => (a.name ?? a.email).localeCompare(b.name ?? b.email);

// Team display names (teams table). Empty until the migrate route has run.
export async function teamRows(): Promise<Map<string, { name: string | null; notes: string | null }>> {
  if (!hasDb()) return new Map();
  try {
    const rows = await db().query.teams.findMany();
    return new Map(rows.map((t) => [t.slug, { name: t.name, notes: t.notes }]));
  } catch {
    return new Map();
  }
}

async function lastShootByTeam(slugs: string[]): Promise<Map<string, string>> {
  if (!hasDb() || !slugs.length) return new Map();
  const r = await db().execute(sql`
    select c.team as team, max(l.shoot_date)::text as last
      from listings l join clients c on c.id = l.client_id
     where c.team is not null
     group by c.team`);
  const out = new Map<string, string>();
  for (const row of r.rows as { team: string; last: string | null }[]) if (row.last) out.set(row.team, row.last.slice(0, 10));
  return out;
}

export async function adminTeams(): Promise<AdminTeam[]> {
  const [clients, names] = await Promise.all([adminClients(), teamRows()]);
  const groups = new Map<string, AdminClient[]>();
  for (const c of clients) {
    if (!c.team) continue;
    if (!groups.has(c.team)) groups.set(c.team, []);
    groups.get(c.team)!.push(c);
  }
  for (const slug of names.keys()) if (!groups.has(slug)) groups.set(slug, []);
  const last = await lastShootByTeam([...groups.keys()]);
  return [...groups.entries()]
    .map(([slug, members]) => ({
      slug,
      name: names.get(slug)?.name ?? null,
      notes: names.get(slug)?.notes ?? null,
      members: members.sort(byName).map((m) => ({ ...m, teamName: names.get(slug)?.name ?? null })),
      listingCount: members.reduce((a, m) => a + m.listingCount, 0),
      lastShoot: last.get(slug) ?? null,
    }))
    .sort((a, b) => (a.name ?? a.slug).localeCompare(b.name ?? b.slug));
}

export async function adminTeam(slug: string): Promise<AdminTeam | null> {
  return (await adminTeams()).find((t) => t.slug === slug) ?? null;
}

// Clients with their team's display name, for the list page.
export async function adminClientsWithTeams(q?: string): Promise<AdminClient[]> {
  const [clients, names] = await Promise.all([adminClients(q), teamRows()]);
  return clients.map((c) => ({ ...c, teamName: c.team ? names.get(c.team)?.name ?? null : null }));
}

export async function adminClientDetail(id: string): Promise<AdminClientDetail | null> {
  const clients = await adminClients();
  const client = clients.find((c) => c.id === id);
  if (!client) return null;
  const names = await teamRows();
  client.teamName = client.team ? names.get(client.team)?.name ?? null : null;
  const [listings, allBookings, team] = await Promise.all([
    adminListings({ clientId: id, sort: "newest_shoot" }),
    adminBookings({ filter: "all" }),
    client.team ? adminTeam(client.team) : Promise.resolve(null),
  ]);
  const bookings = allBookings.filter((b) => b.client.id === id);
  if (!hasDb()) {
    return {
      client,
      team,
      listings,
      bookings,
      invoices: [],
      downloads: DEMO_DOWNLOADS.filter((x) => listings.some((l) => l.id === x.listingId)),
      revisions: DEMO_REVISIONS.filter((r) => r.clientId === id),
      activity: DEMO_ACTIVITY.filter((a) => a.clientId === id || listings.some((l) => l.id === a.listingId)),
    };
  }
  const d = db();
  const row = await d.query.clients.findFirst({ where: eq(schema.clients.id, id), columns: { notes: true } });
  client.notes = row?.notes ?? null;
  const listingIds = listings.map((l) => l.id);
  const addr = new Map(listings.map((l) => [l.id, l.address]));
  const slugOf = new Map(listings.map((l) => [l.id, l.slug]));
  const inv = await d.query.invoices.findMany({
    where: listingIds.length ? or(eq(schema.invoices.clientId, id), inArray(schema.invoices.listingId, listingIds)) : eq(schema.invoices.clientId, id),
    orderBy: [desc(schema.invoices.createdAt)],
    limit: 50,
  });
  const dls = listingIds.length
    ? await d.query.downloads.findMany({ where: inArray(schema.downloads.listingId, listingIds), with: { media: { columns: { filename: true } } }, orderBy: [desc(schema.downloads.at)], limit: 25 })
    : [];
  const revs = listingIds.length
    ? await d.query.revisionRequests.findMany({ where: inArray(schema.revisionRequests.listingId, listingIds), with: { listing: { with: { client: { columns: { name: true, email: true } } } }, items: true }, orderBy: [desc(schema.revisionRequests.createdAt)], limit: 50 })
    : [];
  const acts = await d.query.activity.findMany({
    where: listingIds.length ? or(eq(schema.activity.clientId, id), inArray(schema.activity.listingId, listingIds)) : eq(schema.activity.clientId, id),
    orderBy: [desc(schema.activity.createdAt)],
    limit: 30,
  });
  return {
    client,
    team,
    listings,
    bookings,
    invoices: inv.map((i) => ({
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
      address: (i.listingId ? addr.get(i.listingId) : null) ?? i.propertyAddress ?? null,
    })),
    downloads: dls.map((x) => ({ at: x.at.toISOString(), clientEmail: x.clientEmail, filename: x.filename ?? x.media?.filename ?? "", address: addr.get(x.listingId) ?? "", listingId: x.listingId, slug: slugOf.get(x.listingId) ?? "" })),
    revisions: revs.map((r) => toRevision(r, r.listing)),
    activity: acts.map((a) => ({ id: a.id, actorEmail: a.actorEmail, action: a.action, listingId: a.listingId, shootId: a.shootId, clientId: a.clientId, meta: a.meta, createdAt: a.createdAt.toISOString(), address: a.listingId ? addr.get(a.listingId) ?? null : null })),
  };
}

// Every media row of a listing, hidden ones included, for the media grid:
// a thumb, a larger preview (photos) or a playable source (films), and a link
// that downloads the original. Frames from a shoot download through the shoot
// route (it logs the download); loose files get a signed link.
export async function adminMediaRows(listingId: string): Promise<AdminMediaRow[]> {
  if (!hasDb()) return demoMediaRows(listingId);
  const [rows, shoots] = await Promise.all([
    db().query.media.findMany({
      where: eq(schema.media.listingId, listingId),
      orderBy: [asc(schema.media.revision), asc(schema.media.section), asc(schema.media.sort), asc(schema.media.createdAt)],
    }),
    db().query.shoots.findMany({ where: eq(schema.shoots.listingId, listingId), columns: { id: true, publishedAt: true } }),
  ]);
  const liveShoots = new Set(shoots.filter((s) => s.publishedAt).map((s) => s.id));
  const storage = hasR2();
  const sign = (p: Promise<string>) => p.catch(() => null);
  return Promise.all(
    rows.map(async (m) => {
      const photo = m.kind === "photo";
      const [thumbUrl, previewUrl, signedDownload] = storage
        ? await Promise.all([
            photo ? sign(signedViewUrl(derivativeKey(m.r2Key, "thumb"))) : Promise.resolve(null),
            sign(signedViewUrl(photo ? derivativeKey(m.r2Key, "preview") : m.r2Key)),
            m.shootId ? Promise.resolve(null) : sign(signedDownloadUrl(m.r2Key, m.filename, 3600)),
          ])
        : [null, null, null];
      return {
        id: m.id,
        kind: m.kind,
        filename: m.filename,
        r2Key: m.r2Key,
        bytes: m.bytes,
        section: m.section,
        revision: m.revision,
        sort: m.sort,
        qcState: m.qcState,
        published: m.published,
        corrected: m.corrected,
        held: m.held,
        shootPublished: !m.shootId || liveShoots.has(m.shootId),
        shootId: m.shootId,
        createdAt: m.createdAt.toISOString(),
        thumbUrl,
        previewUrl,
        downloadUrl: !storage ? null : m.shootId ? `/api/studio/shoots/${m.shootId}/download?file=${m.id}` : signedDownload,
        width: null,
        height: null,
      };
    })
  );
}

// Demo mode: the sample frames (DEMO_PHOTOS) so the grid, drag to
// reorder and the preview can be checked locally. The first demo listing gets
// a curated set (main gallery, a named section, a revised pair, one film and a
// few states to show the badges); other demo listings with frames reuse the
// photos in turn. Nothing here is ever written anywhere.
function demoMediaRows(listingId: string): AdminMediaRow[] {
  const created = (i: number) => new Date(Date.UTC(2026, 9, 9, 17, 0, i)).toISOString();
  const photoRow = (p: DemoPhoto, i: number, extra: Partial<AdminMediaRow>): AdminMediaRow => ({
    id: `${listingId}-p${i}`,
    kind: "photo",
    filename: p.filename,
    r2Key: `listings/demo/photos/${p.filename}`,
    bytes: 5_400_000 + (i % 7) * 380_000,
    section: null,
    revision: false,
    sort: (i + 1) * 10,
    qcState: "approved",
    published: true,
    corrected: false,
    held: false,
    shootPublished: true,
    shootId: null,
    createdAt: created(i),
    thumbUrl: p.url,
    previewUrl: p.url,
    downloadUrl: p.url,
    width: p.width,
    height: p.height,
    ...extra,
  });
  if (listingId === DEMO_LISTINGS[0]?.id) {
    const rows = DEMO_PHOTOS.map((p, i) => {
      if (i >= 22) return photoRow(p, i, { revision: true, sort: (i - 21) * 10, corrected: true });
      if (i >= 18) return photoRow(p, i, { section: "Details", sort: (i - 17) * 10 });
      return photoRow(p, i, {
        published: i !== 7,
        held: i === 7,
        qcState: i === 11 ? "pending" : "approved",
        corrected: i === 3,
      });
    });
    rows.push({
      ...photoRow(DEMO_PHOTOS[0], DEMO_PHOTOS.length, {}),
      kind: "video",
      filename: "1420-Alder-Film.mp4",
      r2Key: "listings/demo/video/1420-Alder-Film.mp4",
      bytes: 412_000_000,
      sort: 190,
      thumbUrl: null,
      previewUrl: null,
      downloadUrl: null,
      width: null,
      height: null,
    });
    return rows;
  }
  const shoots = DEMO_SHOOTS.filter((s) => s.listingId === listingId);
  const frames = shoots.flatMap((s) => demoFrames(s).map((f) => ({ f, shootId: s.id, shootPublished: Boolean(s.publishedAt) })));
  return frames.map(({ f, shootId, shootPublished }, i) => {
    const p = DEMO_PHOTOS[i % DEMO_PHOTOS.length];
    return photoRow(p, i, { id: f.id, filename: f.filename, r2Key: f.r2Key, bytes: f.bytes, section: f.section, sort: (f.sort + 1) * 10, qcState: f.qcState, published: f.published, corrected: f.corrected, held: f.held, shootId, shootPublished });
  });
}

export async function adminAdmins(): Promise<AdminAdmin[]> {
  const env: AdminAdmin[] = envAdminEmails().map((email) => ({ email, name: null, source: "env" as const, addedBy: null, createdAt: null, role: "admin" as const }));
  const envSet = new Set(env.map((e) => e.email));
  if (!hasDb()) return [...env, ...DEMO_STAFF.filter((s) => !envSet.has(s.email)).map((s) => ({ email: s.email, name: s.name, source: "db" as const, addedBy: s.addedBy, createdAt: s.createdAt, role: s.role }))];
  const d = db();
  let rows: { email: string; name: string | null; addedBy: string | null; createdAt: Date; role: string }[] = [];
  try {
    rows = await d.query.admins.findMany({ orderBy: [asc(schema.admins.createdAt)] });
  } catch {
    // Before the migrate route added admins.role: every added row is an admin.
    try {
      const old = await d.query.admins.findMany({ columns: { email: true, name: true, addedBy: true, createdAt: true }, orderBy: [asc(schema.admins.createdAt)] });
      rows = old.map((r) => ({ ...r, role: "admin" }));
    } catch {
      return env;
    }
  }
  return [...env, ...rows.filter((r) => !envSet.has(r.email.toLowerCase())).map((r) => ({ email: r.email, name: r.name, source: "db" as const, addedBy: r.addedBy, createdAt: r.createdAt.toISOString(), role: toRole(r.role) }))];
}
