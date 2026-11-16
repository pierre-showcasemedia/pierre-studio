// The session JWT, on its own so src/proxy.ts can verify a cookie without
// importing next/headers. HS256 with AUTH_SECRET; the claims are the signed
// in email, use: "session", a random jti (every sign-in is a distinct
// session) and the standard iat / exp. Older cookies without a jti still
// verify, so nobody is signed out by a deploy; a cookie that fails to verify
// for any reason reads as signed out, never as an error.
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "studio_portal_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function authSecret(): Uint8Array {
  let s = process.env.AUTH_SECRET;
  // Local demo mode only (no database, not a production build): a fixed
  // secret so the demo sign-in works without any setup. Never used on Vercel.
  if (!s && !process.env.DATABASE_URL && process.env.NODE_ENV !== "production") s = "studio-local-demo-not-a-secret";
  if (!s) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function signSessionToken(email: string): Promise<string> {
  const jti = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return new SignJWT({ email: email.trim().toLowerCase(), use: "session" })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(authSecret());
}

// The signed-in email, or null for a missing, malformed, expired or
// mis-signed cookie.
export async function verifySessionToken(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, authSecret(), { algorithms: ["HS256"] });
    return payload.use === "session" && typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}
