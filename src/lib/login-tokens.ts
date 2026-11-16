// One-time sign-in tokens for the magic link (Oct 21 2026 hardening).
//
// The link carries an opaque token: 32 random bytes (base64url). Only its
// SHA-256 is stored, in login_tokens, with the email it was issued to, the
// optional in-portal path to land on, and when it expires (15 minutes).
// Consuming it is one UPDATE that sets used_at where used_at is still null
// and the row has not expired, so a link works exactly once: a second click,
// a replay, or a forwarded email all get "used" or "expired", never a session.
// Demo mode (no database) keeps the same rules in a process-local map.
//
// Nov 5 2026: the link itself no longer consumes the token. Opening it lands
// on /portal/login/continue, which only PEEKS (peekLoginToken, below) and
// shows a button; the button's POST is what consumes. Mail security at a
// client's brokerage (Microsoft 365) opens every emailed link before
// the person does, and a token spent on that first GET was "already used" by
// the time she tapped it. Scanners follow links; they do not press buttons.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, gt, lt } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_BYTES = 32;
// Rows older than this are deleted on the way past (cheap cleanup, no cron).
const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;

export type ConsumeResult = { ok: true; email: string; next: string | null } | { ok: false; reason: "used" | "expired" | "invalid" };

export function hashLoginToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// A token is 43 base64url characters; anything else is refused before the
// database is asked, so junk never reaches a query.
const TOKEN_RE = /^[A-Za-z0-9_-]{40,48}$/;

type DemoRow = { email: string; next: string | null; expiresAt: number; usedAt: number | null };
// One map for the whole process. In `next dev` every route is its own module
// graph, so a plain module-level Map is a different map in the login route,
// the verify route and the continue page, and a demo link issued by one can
// never be found by the others.
const demoRows: Map<string, DemoRow> = ((globalThis as { __studioDemoLoginTokens?: Map<string, DemoRow> }).__studioDemoLoginTokens ??= new Map());

function sweepDemo(now: number) {
  for (const [k, r] of demoRows) if (r.expiresAt < now - SWEEP_AFTER_MS) demoRows.delete(k);
}

export async function issueLoginToken(email: string, next: string | null = null): Promise<string> {
  const clean = email.trim().toLowerCase();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashLoginToken(token);
  const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MS);
  if (!hasDb()) {
    sweepDemo(Date.now());
    demoRows.set(tokenHash, { email: clean, next, expiresAt: expiresAt.getTime(), usedAt: null });
    return token;
  }
  const d = db();
  await d.insert(schema.loginTokens).values({ tokenHash, email: clean, next, expiresAt });
  // Sweep on roughly one issue in twenty: expired rows older than a day.
  if (randomBytes(1)[0] % 20 === 0) {
    await d.delete(schema.loginTokens).where(lt(schema.loginTokens.expiresAt, new Date(Date.now() - SWEEP_AFTER_MS))).catch(() => undefined);
  }
  return token;
}

// Marks the token used and returns its email, or why it was refused. The
// lookup is by hash; the returned hash is compared again in constant time
// before anything is trusted.
export async function consumeLoginToken(token: string): Promise<ConsumeResult> {
  if (!token || !TOKEN_RE.test(token)) return { ok: false, reason: "invalid" };
  const tokenHash = hashLoginToken(token);
  const now = new Date();
  if (!hasDb()) {
    const r = demoRows.get(tokenHash);
    if (!r) return { ok: false, reason: "invalid" };
    if (r.usedAt) return { ok: false, reason: "used" };
    if (r.expiresAt <= now.getTime()) return { ok: false, reason: "expired" };
    r.usedAt = now.getTime();
    return { ok: true, email: r.email, next: r.next };
  }
  const d = db();
  const claimed = await d
    .update(schema.loginTokens)
    .set({ usedAt: now })
    .where(and(eq(schema.loginTokens.tokenHash, tokenHash), isNull(schema.loginTokens.usedAt), gt(schema.loginTokens.expiresAt, now)))
    .returning({ tokenHash: schema.loginTokens.tokenHash, email: schema.loginTokens.email, next: schema.loginTokens.next });
  const row = claimed[0];
  if (row && sameHash(row.tokenHash, tokenHash)) return { ok: true, email: row.email, next: row.next };
  // Not claimed: say which, without ever handing back a session.
  const seen = await d.query.loginTokens.findFirst({ where: eq(schema.loginTokens.tokenHash, tokenHash), columns: { usedAt: true, expiresAt: true } });
  if (!seen) return { ok: false, reason: "invalid" };
  if (seen.usedAt) return { ok: false, reason: "used" };
  return { ok: false, reason: "expired" };
}

export type PeekResult = "valid" | "used" | "expired" | "invalid";

// Reads the token's state without spending it, for the continue page: a
// used or expired link can say so at once instead of behind a button that
// then fails. Nothing here hands back the email or a session.
export async function peekLoginToken(token: string): Promise<PeekResult> {
  if (!token || !TOKEN_RE.test(token)) return "invalid";
  const tokenHash = hashLoginToken(token);
  const now = Date.now();
  if (!hasDb()) {
    const r = demoRows.get(tokenHash);
    if (!r) return "invalid";
    if (r.usedAt) return "used";
    if (r.expiresAt <= now) return "expired";
    return "valid";
  }
  const seen = await db().query.loginTokens.findFirst({ where: eq(schema.loginTokens.tokenHash, tokenHash), columns: { usedAt: true, expiresAt: true } });
  if (!seen) return "invalid";
  if (seen.usedAt) return "used";
  if (seen.expiresAt.getTime() <= now) return "expired";
  return "valid";
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
