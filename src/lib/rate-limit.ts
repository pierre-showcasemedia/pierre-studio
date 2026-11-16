// Fixed-window rate limiting for the sign-in request (Oct 21 2026).
//
// One row per key in rate_limits: a counter and the start of its window. A
// hit is a single upsert that either bumps the counter inside the current
// window or starts a fresh window, and returns the count, so two instances
// never race past the limit together. Keys never carry an address in the
// clear: emails are hashed, IPs are kept as given (they are the thing being
// limited). Demo mode (no database) keeps the same rule in a process map.
// Nothing here answers the caller differently on purpose: the login route
// stays quiet either way; this only decides whether an email goes out.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, hasDb } from "@/db";

export type RateLimitResult = { allowed: boolean; count: number; limit: number };

// Rows whose window ended this long ago are swept on the way past.
const SWEEP_AFTER_MS = 60 * 60 * 1000;

const demo = new Map<string, { count: number; windowStart: number }>();

export function rateLimitKeyForEmail(email: string): string {
  return `login:email:${createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex").slice(0, 32)}`;
}

export function rateLimitKeyForIp(ip: string): string {
  return `login:ip:${ip}`;
}

// The caller's address: the first hop of x-forwarded-for (what Vercel sets
// from the connection), else x-real-ip, else "unknown" so every unknown
// caller shares one bucket rather than none.
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  const real = (request.headers.get("x-real-ip") || "").trim();
  return real ? real.slice(0, 64) : "unknown";
}

// Counts one hit against key and says whether it is still inside the limit.
// A failing database counts as allowed: the sign-in link is the thing that
// must keep working, and the limit is a brake, not a gate.
export async function rateLimitHit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now();
  if (!hasDb()) {
    for (const [k, v] of demo) if (v.windowStart < now - windowMs - SWEEP_AFTER_MS) demo.delete(k);
    const cur = demo.get(key);
    const fresh = !cur || cur.windowStart < now - windowMs;
    const next = fresh ? { count: 1, windowStart: now } : { count: cur.count + 1, windowStart: cur.windowStart };
    demo.set(key, next);
    return { allowed: next.count <= limit, count: next.count, limit };
  }
  try {
    const d = db();
    const windowSeconds = Math.max(1, Math.round(windowMs / 1000));
    const r = await d.execute(sql`
      insert into rate_limits (key, count, window_start, updated_at)
      values (${key}, 1, now(), now())
      on conflict (key) do update set
        count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then 1 else rate_limits.count + 1 end,
        window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then now() else rate_limits.window_start end,
        updated_at = now()
      returning count`);
    const count = Number((r.rows[0] as { count: number } | undefined)?.count ?? 1);
    // Sweep on a fresh window about one time in twenty.
    if (count === 1 && Math.random() < 0.05) {
      await d.execute(sql`delete from rate_limits where window_start < now() - make_interval(secs => ${windowSeconds + Math.round(SWEEP_AFTER_MS / 1000)})`).catch(() => undefined);
    }
    return { allowed: count <= limit, count, limit };
  } catch (e) {
    console.error("[rate-limit] counter unavailable, allowing:", e instanceof Error ? e.message : e);
    return { allowed: true, count: 0, limit };
  }
}
