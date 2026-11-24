// POST /api/studio/leads: the website's pricing page form (Nov 24 2026,
// src/lib/leads.ts). Only the website posts here (x-intake-secret =
// BOOKING_INTAKE_SECRET); 404 until that is set. Stores the lead and nothing
// else: no email or text goes to the visitor.
import { timingSafeEqual } from "node:crypto";
import { hasDb } from "@/db";
import { normalizeLead, saveLead } from "@/lib/leads";

export const dynamic = "force-dynamic";

function same(given: string, secret: string): boolean {
  return Boolean(secret) && Boolean(given) && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

export async function POST(request: Request) {
  if (!same((request.headers.get("x-intake-secret") || "").trim(), (process.env.BOOKING_INTAKE_SECRET || "").trim())) {
    return Response.json({ ok: false }, { status: 404 });
  }
  if (!hasDb()) return Response.json({ ok: false, error: "no database" }, { status: 503 });
  let b: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    b = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "send JSON" }, { status: 400 });
  }
  const n = normalizeLead(b);
  if (!n.ok) return Response.json({ ok: false, error: n.error }, { status: 400 });
  try {
    const r = await saveLead(n.lead);
    return Response.json({ ok: true, created: r.created });
  } catch (e) {
    console.error("[leads]", e);
    return Response.json({ ok: false, error: "could not save" }, { status: 500 });
  }
}
