// The property page (studio template, Nov 18 2026; off unless
// business.propertyPage): /property/<shareToken>, the share gallery laid out
// as a listing page with the agent's card and the listing's links. Same rules
// as the share page: client-visible media only, watermarked while unpaid,
// never a download. NDA listings have no property page, ever.
import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { listingForShareToken } from "./portal-data";
import { hasR2, signedViewUrl } from "./r2";
import { createHmac } from "node:crypto";
import { authSecret } from "./session-token";
import { business, BUSINESS_TZ } from "./business";
import { localYmd } from "./reminder-day";

// Headshot and logo are short-lived signed addresses of the agent's own
// uploads (src/lib/profile-images.ts), or null.
export type PropertyAgent = { name: string | null; company: string | null; phone: string | null; email: string; headshotUrl: string | null; logoUrl: string | null };

async function viewUrl(key: string | null): Promise<string | null> {
  if (!key || !hasR2()) return null;
  return signedViewUrl(key).catch(() => null);
}

export async function propertyPage(token: string) {
  if (!business.propertyPage) return null; // off: /property/<token> is a 404
  const data = await listingForShareToken(token);
  if (!data) return null;
  if (!hasDb()) return { ...data, agent: null as PropertyAgent | null, links: [] as { label: string; url: string }[], views: 0, facts: null as string | null };
  const row = await db().query.listings.findFirst({
    where: eq(schema.listings.id, data.listing.id),
    columns: { nda: true, links: true, pageViews: true },
    with: { client: { columns: { name: true, company: true, phone: true, email: true, headshotKey: true, logoKey: true } } },
  });
  if (!row || row.nda) return null;
  let links: { label: string; url: string }[] = [];
  try {
    const parsed = JSON.parse(row.links ?? "[]") as { label?: unknown; url?: unknown }[];
    links = parsed.filter((l) => typeof l.label === "string" && typeof l.url === "string" && /^https:\/\//.test(l.url as string)).map((l) => ({ label: String(l.label), url: String(l.url) }));
  } catch {
    links = [];
  }
  // Beds and baths from the latest booking that gave them.
  const b = await db().query.bookings.findFirst({
    where: and(eq(schema.bookings.listingId, data.listing.id), or(isNotNull(schema.bookings.beds), isNotNull(schema.bookings.baths))),
    columns: { beds: true, baths: true },
    orderBy: desc(schema.bookings.createdAt),
  });
  const c = row.client;
  const [headshotUrl, logoUrl] = business.profileImages ? await Promise.all([viewUrl(c?.headshotKey ?? null), viewUrl(c?.logoKey ?? null)]) : [null, null];
  const agent: PropertyAgent | null = c ? { name: c.name, company: c.company, phone: c.phone, email: c.email, headshotUrl, logoUrl } : null;
  return { ...data, agent, links, views: row.pageViews, facts: bedsBaths(b?.beds ?? null, b?.baths ?? null) };
}

// "3 beds · 2.5 baths" (either may be missing), or null.
export function bedsBaths(beds: number | null, baths: number | null): string | null {
  const parts = [beds != null ? `${beds} ${beds === 1 ? "bed" : "beds"}` : null, baths != null ? `${baths} ${baths === 1 ? "bath" : "baths"}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slack|curl|wget|headless/i;

// One view per visitor per listing per day. A visitor is a keyed hash
// (HMAC-SHA256 with AUTH_SECRET) of the listing, the business's calendar day,
// the address the request came from and the browser's user agent: no cookie,
// no third party, and neither the address nor the user agent is ever stored.
// The day is inside the hash, so yesterday's visitor cannot be matched to
// today's, and the rows go after two days.
export function visitorIp(h: { get(name: string): string | null }): string {
  const fwd = (h.get("x-forwarded-for") || "").split(",")[0].trim();
  return (fwd || (h.get("x-real-ip") || "").trim()).slice(0, 64);
}

export function viewerKey(secret: Uint8Array | string, listingId: string, day: string, ip: string, userAgent: string): string {
  const hash = createHmac("sha256", Buffer.from(secret)).update(`property-view.v1|${listingId}|${day}|${ip}|${userAgent}`).digest("hex").slice(0, 32);
  return `${listingId}:${day}:${hash}`;
}

export const viewDay = (now: Date): string => localYmd(now, BUSINESS_TZ);

// One view per person per day (link-preview robots and crawlers are not counted).
export async function recordPropertyView(listingId: string, userAgent: string | null, source: ViewSource = "direct", ip: string | null = null, now: Date = new Date()): Promise<void> {
  if (!business.propertyPage || !hasDb() || !userAgent || BOT_RE.test(userAgent)) return;
  const day = viewDay(now);
  const key = viewerKey(authSecret(), listingId, day, ip ?? "", userAgent);
  const sources = sql`jsonb_set(${schema.listings.viewSources}, ${`{${source}}`}::text[], to_jsonb(coalesce((${schema.listings.viewSources} ->> ${source})::int, 0) + 1))`;
  try {
    // The insert and the count in one statement: a visitor already seen today inserts nothing and counts nothing.
    await db().execute(sql`
      WITH seen AS (
        INSERT INTO property_view_days (key, day) VALUES (${key}, ${day}::date)
        ON CONFLICT (key) DO NOTHING
        RETURNING 1
      )
      UPDATE listings SET page_views = page_views + 1, last_viewed_at = now(), view_sources = ${sources}
      WHERE id = ${listingId} AND EXISTS (SELECT 1 FROM seen)`);
  } catch (e) {
    // Deployed before the migrate step ran: count as before rather than lose the view.
    if (!/property_view_days/.test(String((e as Error)?.message ?? e))) throw e;
    await db().update(schema.listings).set({ pageViews: sql`${schema.listings.pageViews} + 1`, lastViewedAt: new Date(), viewSources: sources }).where(eq(schema.listings.id, listingId));
    return;
  }
  await db().execute(sql`DELETE FROM property_view_days WHERE day < ${day}::date - 1`).catch((e) => console.error("[property] prune", e));
}

// Where a visitor came from. ?utm_source= or ?src= wins (the agent's own
// links), else the referring site, else "direct" (typed, or a text or email
// app that sends no referrer).
export const VIEW_SOURCES = ["facebook", "instagram", "zillow", "realtor", "google", "email", "text", "other", "direct"] as const;
export type ViewSource = (typeof VIEW_SOURCES)[number];
export const VIEW_SOURCE_LABELS: Record<ViewSource, string> = { facebook: "Facebook", instagram: "Instagram", zillow: "Zillow", realtor: "Realtor.com", google: "Google", email: "Email", text: "Text", other: "Other sites", direct: "Direct" };
export function viewSource(tag: string | null | undefined, referrer: string | null | undefined): ViewSource {
  const t = (tag ?? "").trim().toLowerCase();
  if (t) {
    if (/^(fb|facebook)/.test(t)) return "facebook";
    if (/^(ig|insta)/.test(t)) return "instagram";
    if (t.startsWith("zillow")) return "zillow";
    if (t.startsWith("realtor")) return "realtor";
    if (t.startsWith("google")) return "google";
    if (/^(email|mail|newsletter)/.test(t)) return "email";
    if (/^(sms|text|imessage)/.test(t)) return "text";
    return "other";
  }
  let host = "";
  try {
    host = referrer ? new URL(referrer).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  if (!host) return "direct";
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/.test(host)) return "facebook";
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)zillow\.com$/.test(host)) return "zillow";
  if (/(^|\.)realtor\.com$/.test(host)) return "realtor";
  if (/(^|\.)(mail\.google\.com|outlook\.(live|office)\.com|mail\.yahoo\.com)$/.test(host)) return "email";
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return "google";
  return "other";
}

// The agent's line in the portal: the page's views (0 without a database).
export async function propertyViews(listingId: string): Promise<{ views: number; nda: boolean; sources: string | null }> {
  if (!hasDb()) return { views: 0, nda: false, sources: null };
  const r = await db().query.listings.findFirst({ where: eq(schema.listings.id, listingId), columns: { pageViews: true, nda: true, viewSources: true } });
  return { views: r?.pageViews ?? 0, nda: Boolean(r?.nda), sources: sourcesLine(r?.viewSources ?? {}) };
}

// "Facebook 12 · Direct 5 · Zillow 3", biggest first, or null.
export function sourcesLine(counts: Record<string, number>): string | null {
  const rows = VIEW_SOURCES.map((k) => [k, Number(counts[k]) || 0] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return rows.length ? rows.map(([k, n]) => `${VIEW_SOURCE_LABELS[k]} ${n}`).join(" · ") : null;
}
