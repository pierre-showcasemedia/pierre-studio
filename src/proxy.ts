// The sign-in boundary in front of /admin and /portal (Oct 21 2026).
//
// A request to either tree with no valid session cookie is redirected to
// /portal/login before any page code runs; one with a valid cookie goes
// through with Cache-Control: private, no-store so a signed-in page is never
// kept by a shared cache or shown from history after sign-out. Only the
// cookie's signature and shape are checked here. Who the person is, which
// role they hold and what they may see stays with the pages and routes
// (requireAdmin / requireStaff / sessionEmail), exactly as before: this is a
// first fence, not the security boundary.
//
// Out of scope on purpose: /portal/login (the sign-in page), /api/portal/*
// (every handler checks its own session or secret and answers 401/404),
// /share/<token> (public preview by design) and static assets.
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session-token";

const NO_STORE = "private, no-store";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/portal/login" || pathname.startsWith("/portal/login/")) return NextResponse.next();

  const email = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!email) {
    const login = request.nextUrl.clone();
    login.pathname = "/portal/login";
    login.search = "";
    login.hash = "";
    const res = NextResponse.redirect(login);
    res.headers.set("Cache-Control", NO_STORE);
    return res;
  }
  const res = NextResponse.next();
  res.headers.set("Cache-Control", NO_STORE);
  return res;
}

export const config = {
  matcher: ["/admin/:path*", "/portal/:path*"],
};
