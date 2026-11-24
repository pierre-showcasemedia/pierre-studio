// Leads from the website's pricing page (Nov 24 2026). A visitor gives a
// name and email to open the price list; the website posts it to
// POST /api/studio/leads with the intake secret. Stored here, shown under
// Admin > Leads with where the visit came from, and marked Booked once that
// email has a booking. Nobody is emailed or texted automatically: following
// up is Pierre's call (business.neverMessage and the house rules still hold).
import { desc, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { LeadVisit } from "@/db/schema";
import { currentEnv } from "@/lib/jobs-core";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const VISIT_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "referrer", "landing"] as const;
const CLIENT_TYPES = ["agent", "homeowner", "builder", "other"];

export type LeadInput = { id: string; kind: string; name: string; email: string; phone: string | null; clientType: string | null; brokerage: string | null; visit: LeadVisit | null };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function normalizeLead(b: Record<string, unknown>): { ok: true; lead: LeadInput } | { ok: false; error: string } {
  const id = str(b.submission_id, 64).toLowerCase();
  const name = str(b.name, 120);
  const email = str(b.email, 200).toLowerCase();
  if (!UUID_RE.test(id)) return { ok: false, error: "submission_id" };
  if (name.length < 2) return { ok: false, error: "name" };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "email" };
  const ct = str(b.client_type, 20).toLowerCase();
  const v = b.visit && typeof b.visit === "object" && !Array.isArray(b.visit) ? (b.visit as Record<string, unknown>) : {};
  const visit: LeadVisit = {};
  for (const k of VISIT_KEYS) {
    const s = str(v[k], 300);
    if (s) visit[k] = s;
  }
  return {
    ok: true,
    lead: {
      id,
      kind: str(b.kind, 20) === "pricing" ? "pricing" : "website",
      name,
      email,
      phone: str(b.phone, 40) || null,
      clientType: CLIENT_TYPES.includes(ct) ? ct : null,
      brokerage: str(b.brokerage, 120) || null,
      visit: Object.keys(visit).length ? visit : null,
    },
  };
}

// Idempotent on the submission id.
export async function saveLead(l: LeadInput): Promise<{ created: boolean }> {
  const r = await db()
    .insert(schema.leads)
    .values({ ...l, env: currentEnv() })
    .onConflictDoNothing({ target: schema.leads.id })
    .returning({ id: schema.leads.id });
  return { created: r.length > 0 };
}

// "google / cpc / spring" or "facebook.com" or "Direct".
export function visitLabel(v: LeadVisit | null | undefined): string {
  if (!v) return "Direct";
  const utm = [v.utm_source, v.utm_medium, v.utm_campaign].filter(Boolean).join(" / ");
  return utm || v.referrer || "Direct";
}

export type AdminLead = { id: string; name: string; email: string; phone: string | null; clientType: string | null; brokerage: string | null; came: string; landing: string | null; createdAt: Date; booked: boolean };

export async function adminLeads(limit = 300): Promise<AdminLead[]> {
  const rows = await db().select().from(schema.leads).orderBy(desc(schema.leads.createdAt)).limit(limit);
  const emails = [...new Set(rows.map((r) => r.email))];
  const booked = new Set<string>();
  if (emails.length) {
    const hit = await db()
      .select({ email: schema.clients.email })
      .from(schema.clients)
      .where(sql`${inArray(sql`lower(${schema.clients.email})`, emails)} and exists (select 1 from ${schema.bookings} where ${schema.bookings.clientId} = ${schema.clients.id})`);
    for (const h of hit) booked.add(h.email.toLowerCase());
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    clientType: r.clientType,
    brokerage: r.brokerage,
    came: visitLabel(r.visit),
    landing: r.visit?.landing ?? null,
    createdAt: r.createdAt,
    booked: booked.has(r.email.toLowerCase()),
  }));
}
