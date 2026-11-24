// Book again prefill for the website's booking form (studio template, Nov 24
// 2026). The portal's Book again link carries a signed token
// (src/lib/book-again-token.ts) in place of the client's details; the
// website's server calls this with that token and the intake secret
// (x-intake-secret = BOOKING_INTAKE_SECRET), never the browser, and gets back
// the name, email, phone, company and client type for the form. A bad, expired
// or unknown token is a plain 404, and so is every call while business.bookAgain is off.
//   GET ?token=<token> → { ok, firstName, lastName, email, phone, company, type }
import { timingSafeEqual } from "node:crypto";
import { business } from "@/lib/business";
import { bookAgainLookup } from "@/lib/portal-bookings";

export const dynamic = "force-dynamic";

function same(given: string, secret: string): boolean {
  return Boolean(secret) && Boolean(given) && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  if (!same((request.headers.get("x-intake-secret") || "").trim(), (process.env.BOOKING_INTAKE_SECRET || "").trim())) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!business.bookAgain) return Response.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  const token = new URL(request.url).searchParams.get("token");
  const prefill = await bookAgainLookup(token).catch((e) => {
    console.error("[book-again]", e);
    return null;
  });
  if (!prefill) return Response.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  return Response.json({ ok: true, ...prefill }, { headers: NO_STORE });
}
