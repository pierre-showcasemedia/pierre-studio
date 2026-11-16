// GET /api/studio/calendar/probe  (x-migrate-token)
// Operator check for the calendar setup: signs in as the Google service
// account, reads AS hello@example.com (domain-wide delegation, scope
// calendar.readonly, exactly what the website's booking form uses for open
// times), lists every calendar hello@ can see at least free/busy on (its own
// plus calendars shared to it and added to its list) and asks Google for the
// busy blocks on each over the next 14 days. Read-only; returns calendar ids,
// names and counts, never event details. ?user= reads as another
// @the marketing site user.
import { createSign } from "node:crypto";
import { hasMigrateToken } from "@/lib/operator-token";
import { mailDomain } from "@/lib/brand";
import { calendarUser } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";

const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export async function GET(request: Request) {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  const email = (process.env.GOOGLE_SA_CLIENT_EMAIL || "").trim();
  const raw = (process.env.GOOGLE_SA_PRIVATE_KEY || "").trim();
  if (!email || !raw) return Response.json({ ok: false, step: "env", error: "GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY not set here" });
  const asked = new URL(request.url).searchParams.get("user")?.trim().toLowerCase();
  const user = asked && asked.endsWith(`@${mailDomain()}`) ? asked : calendarUser();
  const key = raw.includes("BEGIN") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");

  // 1. A token as the user (fails here when delegation or the scope is missing).
  let access: string;
  try {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: email, sub: user, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }), cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      return Response.json({ ok: false, step: "token", serviceAccount: email, user, status: r.status, error: j.error ?? null, detail: j.error_description ?? null, hint: j.error === "unauthorized_client" ? "Domain-wide delegation is missing this service account's client id or the calendar.readonly scope." : null });
    }
    access = j.access_token as string;
  } catch (e) {
    return Response.json({ ok: false, step: "token", error: e instanceof Error ? e.message : String(e) });
  }
  const auth = { authorization: `Bearer ${access}` };

  // 2. Every calendar in the user's list with at least free/busy access.
  const lr = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=freeBusyReader&maxResults=250", { headers: auth, cache: "no-store" });
  const lj = await lr.json().catch(() => ({}));
  if (!lr.ok) return Response.json({ ok: false, step: "calendarList", status: lr.status, error: lj.error?.message ?? null });
  type Cal = { id: string; summary?: string; summaryOverride?: string; accessRole?: string; primary?: boolean; selected?: boolean };
  const cals = (lj.items ?? []) as Cal[];
  const ids = cals.map((c) => c.id);
  if (!ids.includes(user)) ids.unshift(user);

  // 3. Busy blocks over the next 14 days, per calendar.
  const timeMin = new Date();
  const timeMax = new Date(Date.now() + 14 * 864e5);
  const fr = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: ids.map((id) => ({ id })) }), cache: "no-store" });
  const fj = await fr.json().catch(() => ({}));
  const busy = (fj.calendars ?? {}) as Record<string, { busy?: unknown[]; errors?: { reason?: string }[] }>;
  const calendars = ids.map((id) => {
    const c = cals.find((x) => x.id === id);
    return {
      id,
      name: c?.summaryOverride ?? c?.summary ?? id,
      access: c?.accessRole ?? (id === user ? "owner" : "not in list"),
      primary: Boolean(c?.primary),
      busyBlocksNext14Days: busy[id]?.busy?.length ?? 0,
      error: busy[id]?.errors?.map((e) => e.reason).join(", ") || null,
    };
  });
  return Response.json({ ok: fr.ok, serviceAccount: email, user, scope: SCOPE, calendars, shootsCalendarInList: process.env.GOOGLE_CALENDAR_ID ? ids.includes(process.env.GOOGLE_CALENDAR_ID) : null });
}
