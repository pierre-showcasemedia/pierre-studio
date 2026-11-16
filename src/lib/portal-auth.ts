// Minimal magic-link auth for the client portal.
// Login: client enters their email → a one-time token (src/lib/login-tokens.ts:
// random, hashed at rest, 15 minutes, single use) is emailed via Resend →
// clicking it sets a 30-day httpOnly session cookie (a JWT, src/lib/session-token.ts).
// Needs AUTH_SECRET + RESEND_API_KEY.
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { isAdminAllowed } from "./admin-allow";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, authSecret, signSessionToken, verifySessionToken } from "./session-token";

const COOKIE = SESSION_COOKIE;
const SESSION_MAX_AGE = SESSION_MAX_AGE_SECONDS;

const secret = authSecret;

// Step two: the pay link in the booking and delivery emails. A 30-day token
// bound to one listing; /api/portal/verify turns it into a session and lands
// on /portal/<slug>/pay. It signs nobody in anywhere else.
const PAY_TTL = "30d";

export async function signPayToken(email: string, slug: string): Promise<string> {
  return new SignJWT({ email: email.trim().toLowerCase(), slug, use: "pay" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(PAY_TTL)
    .sign(secret());
}

export async function verifyPayToken(token: string): Promise<{ email: string; slug: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (payload.use !== "pay" || typeof payload.email !== "string" || typeof payload.slug !== "string") return null;
    return { email: payload.email, slug: payload.slug };
  } catch {
    return null;
  }
}

// A fresh session on every sign-in (new jti), never a reused token.
export async function createSession(email: string): Promise<void> {
  const jwt = await signSessionToken(email);
  (await cookies()).set(COOKIE, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
}

// The email actually signed in (ignores any admin view-as override).
export async function realSessionEmail(): Promise<string | null> {
  const jar = await cookies();
  return verifySessionToken(jar.get(COOKIE)?.value);
}

// Admin "view as client": while the view-as cookie is set AND the real session
// is an admin, the portal behaves exactly as if that client were signed in.
const VIEW_AS_COOKIE = "studio_portal_view_as";

// Env list plus the admins added on /admin/settings (src/lib/admin-allow.ts).
async function isAdminEmailLocal(email: string): Promise<boolean> {
  return isAdminAllowed(email);
}

// Who the portal should treat as signed in (view-as aware).
export async function sessionEmail(): Promise<string | null> {
  const real = await realSessionEmail();
  if (!real) return null;
  const viewAs = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  if (viewAs && (await isAdminEmailLocal(real))) return viewAs.trim().toLowerCase();
  return real;
}

// Non-null iff an admin is currently impersonating (returns the client email).
export async function viewingAs(): Promise<string | null> {
  const real = await realSessionEmail();
  if (!real || !(await isAdminEmailLocal(real))) return null;
  return (await cookies()).get(VIEW_AS_COOKIE)?.value?.trim().toLowerCase() ?? null;
}

export async function setViewAs(email: string): Promise<void> {
  (await cookies()).set(VIEW_AS_COOKIE, email.trim().toLowerCase(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 4, // auto-expires after 4h so an admin can't get stuck impersonating
    path: "/",
  });
}

export async function clearViewAs(): Promise<void> {
  (await cookies()).delete(VIEW_AS_COOKIE);
}

export async function destroySession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
