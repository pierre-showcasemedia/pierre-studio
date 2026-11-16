// The operator secrets, compared in constant time everywhere (Oct 21 2026).
//
//   hasMigrateToken(request)  x-migrate-token equals MIGRATE_TOKEN
//   hasCronSecret(request)    Authorization: Bearer <CRON_SECRET>
//
// Both answer false when the secret is unset, so a route that depends on one
// hides (404) on a deployment that has not got it. Every token route calls
// one of these instead of comparing header strings with !==, which leaks
// the position of the first wrong byte through timing.
import { timingSafeEqual } from "node:crypto";

export function secretEquals(given: string | null | undefined, secret: string | null | undefined): boolean {
  const g = (given || "").trim();
  const s = (secret || "").trim();
  if (!g || !s) return false;
  const a = Buffer.from(g, "utf8");
  const b = Buffer.from(s, "utf8");
  // Compare against a buffer of our own length either way so the length
  // check itself does not short-circuit the work.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function hasMigrateToken(request: Request): boolean {
  return secretEquals(request.headers.get("x-migrate-token"), process.env.MIGRATE_TOKEN);
}

export function hasCronSecret(request: Request): boolean {
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return secretEquals(bearer, process.env.CRON_SECRET);
}
