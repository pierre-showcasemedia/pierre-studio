// The magic-link landing. Since Nov 5 2026 a click-through, not a drive-by.
//
// GET ?token= with a one-time login token (15 min, src/lib/login-tokens.ts)
// signs nobody in. It sends the browser to /portal/login/continue, a page
// with one "Continue" button that POSTs the token back here, and only that
// POST consumes the token and sets the session cookie. Why: mail security at
// a client's brokerage (Microsoft 365, Nov 5 2026) opens
// every link in an email before the person does, and a token spent on that
// first GET was "already used" by the time she tapped it. Scanners follow
// links; they do not press buttons.
//
// A pay token (30 days, a JWT bound to one listing, since step two) is
// stateless, so a scanner cannot spend it: GET still turns it straight into a
// session on the listing's pay page, as before. POST accepts either kind.
//
// Admins and the QA team land in /admin, clients in /portal. A login token's
// `next` is the path bound to it when it was issued, honoured only when it
// still is a /portal/ path once normalized: a pay token must never land
// anywhere else. A used, expired or unknown link lands on the sign-in page
// with a plain note; nothing here ever answers 500.
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { verifyPayToken, createSession } from "@/lib/portal-auth";
import { consumeLoginToken } from "@/lib/login-tokens";
import { isStaffAllowed } from "@/lib/admin-allow";

export const dynamic = "force-dynamic";

// The one origin `next` is resolved against; nothing is ever fetched from it.
const NEXT_BASE = "https://next.invalid";
const CONTINUE_PATH = "/portal/login/continue";

// Pay tokens are JWTs with two dots; login tokens never contain one.
const isLoginToken = (token: string) => !token.includes(".");

// A relative path under /portal/ and nothing else. The prefix check runs on
// the NORMALIZED path (so "/portal/../admin", "/portal/%2e%2e/admin" and
// "/portal/./x" collapse before they are judged), and any segment that is
// still a dot segment or hides an encoded dot, slash or backslash is refused
// outright instead of being trusted to a router.
function safeNext(v: string | null): string | null {
  if (!v || !v.startsWith("/portal/") || v.startsWith("//") || /[\s\\]/.test(v) || v.includes("://")) return null;
  let u: URL;
  try {
    u = new URL(v, NEXT_BASE);
  } catch {
    return null;
  }
  if (u.origin !== NEXT_BASE || u.username || u.password) return null;
  const path = u.pathname;
  if (!path.startsWith("/portal/")) return null;
  const segments = path.split("/").slice(1);
  if (segments.some((s) => s === "." || s === ".." || /%(2e|2f|5c)/i.test(s))) return null;
  return `${path}${u.search}${u.hash}`;
}

type Landing = { to: string };

// Consumes the token (login) or verifies it (pay), makes the session, and
// says where to land. The only place a session comes out of a link.
async function land(token: string): Promise<Landing> {
  if (!token) return { to: "/portal/login?error=expired" };
  if (isLoginToken(token)) {
    const r = await consumeLoginToken(token);
    if (!r.ok) return { to: `/portal/login?error=${r.reason === "used" ? "used" : "expired"}` };
    await createSession(r.email);
    const next = safeNext(r.next);
    return { to: next ?? ((await isStaffAllowed(r.email)) ? "/admin" : "/portal") };
  }
  const pay = await verifyPayToken(token);
  if (!pay) return { to: "/portal/login?error=expired" };
  await createSession(pay.email);
  return { to: `/portal/${encodeURIComponent(pay.slug)}/pay` };
}

async function landQuietly(token: string): Promise<string> {
  try {
    return (await land(token)).to;
  } catch (e) {
    console.error("[verify] sign-in link failed:", e instanceof Error ? e.message : e);
    return "/portal/login?error=expired";
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = (url.searchParams.get("token") || "").trim();
  // A login token is never spent on GET: the continue page peeks, its button
  // POSTs. Only a pay token lands straight away.
  if (token && isLoginToken(token)) redirect(`${CONTINUE_PATH}?token=${encodeURIComponent(token)}`);
  redirect(await landQuietly(token));
}

export async function POST(request: Request) {
  let token = "";
  try {
    const form = await request.formData();
    token = String(form.get("token") || "").trim();
  } catch {
    token = "";
  }
  const to = await landQuietly(token);
  // 303 so the browser follows with a GET. A 307 would replay the POST on the
  // landing page.
  return NextResponse.redirect(new URL(to, request.url), 303);
}
