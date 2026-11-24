// Book again without personal details in the link (studio template, Nov 24 2026).
//
//   npx tsx scripts/check-book-again.ts
//
// 1. The token (src/lib/book-again-token.ts): round trip, the expiry, a
//    changed byte, another secret, malformed input, nothing personal inside.
// 2. The prefill shape the website gets back.
// 3. Static: bookAgainUrl puts only the token, the address and the item ids
//    in the link; the studio route checks the intake secret before anything.
// No database, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { BOOK_AGAIN_TTL_SECONDS, bookAgainPrefill, signBookAgainToken, verifyBookAgainToken } from "../src/lib/book-again-token";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check needs no database.");
  process.exit(2);
}

const ROOT = path.resolve(__dirname, "..");
let fails = 0;
let passes = 0;
const ok = (c: unknown, n: string) => {
  if (c) passes++;
  else {
    fails++;
    console.error(`FAIL ${n}`);
  }
};

async function main() {
  const secret = "test-secret-for-the-check-only";
  const id = "9b2e4c1a-5d6f-4a7b-8c9d-0e1f2a3b4c5d";
  const now = Date.parse("2026-11-24T12:00:00Z");
  const t = signBookAgainToken(id, secret, now);
  ok(/^[A-Za-z0-9_-]{48}$/.test(t), "the token is 48 url-safe characters");
  ok(verifyBookAgainToken(t, secret, now)?.clientId === id, "round trip gives the client id back");
  ok(verifyBookAgainToken(t, new TextEncoder().encode(secret), now)?.clientId === id, "the secret as bytes or text is the same key");
  ok(verifyBookAgainToken(t, secret, now)?.expiresAt === now + BOOK_AGAIN_TTL_SECONDS * 1000, "expires 30 days out");
  ok(BOOK_AGAIN_TTL_SECONDS === 30 * 86400, "the lifetime is 30 days");
  ok(verifyBookAgainToken(t, secret, now + 29 * 86400_000)?.clientId === id, "still good on day 29");
  ok(verifyBookAgainToken(t, secret, now + 30 * 86400_000) === null, "refused at 30 days");
  ok(verifyBookAgainToken(t, "another-secret", now) === null, "another secret is refused");
  ok(verifyBookAgainToken(t, "", now) === null, "an empty secret is refused");
  for (let i = 0; i < t.length; i += 7) {
    const c = t[i] === "A" ? "B" : "A";
    ok(verifyBookAgainToken(t.slice(0, i) + c + t.slice(i + 1), secret, now) === null, `a changed character at ${i} is refused`);
  }
  for (const bad of [null, undefined, 1, "", "1", t.slice(1), `${t}A`, `${t.slice(0, 47)}=`, `${t.slice(0, 47)}+`, "a".repeat(48)]) ok(verifyBookAgainToken(bad, secret, now) === null, `malformed refused: ${String(bad).slice(0, 12)}`);
  ok(signBookAgainToken(id, secret, now) === t, "the same input signs the same token");
  ok(signBookAgainToken("0f0e0d0c-0b0a-4908-8706-050403020100", secret, now) !== t, "another client gets another token");
  let threw = false;
  try {
    signBookAgainToken("agent@example.com", secret, now);
  } catch {
    threw = true;
  }
  ok(threw, "only a client id can be signed, never an email");
  threw = false;
  try {
    signBookAgainToken(id, "", now);
  } catch {
    threw = true;
  }
  ok(threw, "no secret, no token");
  const raw = Buffer.from(t, "base64url").toString("latin1");
  ok(!raw.includes("agent@example.com") && !raw.includes(id) && !t.includes(id.replace(/-/g, "")), "nothing readable inside the token");
  ok(verifyBookAgainToken(signBookAgainToken(id.toUpperCase(), secret, now), secret, now)?.clientId === id, "an upper case id reads back in lower case");

  const p = bookAgainPrefill({ name: "  Taylor  Ann Brooks ", email: "agent@example.com", phone: "(555) 010-0100", company: "Brooks Realty" }, "agent");
  ok(p.firstName === "Taylor" && p.lastName === "Ann Brooks" && p.email === "agent@example.com" && p.phone === "(555) 010-0100" && p.company === "Brooks Realty" && p.type === "agent", "the prefill splits the name and keeps the rest");
  const q = bookAgainPrefill({ name: null, email: "a@example.com", phone: null, company: null }, null);
  ok(q.firstName === "" && q.lastName === "" && q.phone === "" && q.company === "" && q.type === "", "missing fields come back empty");
  ok(Object.keys(p).sort().join(",") === "company,email,firstName,lastName,phone,type", "only the six form fields, never a price");

  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const pb = code(readFileSync(path.join(ROOT, "src/lib/portal-bookings.ts"), "utf8"));
  const fn = pb.slice(pb.indexOf("export async function bookAgainUrl("), pb.indexOf("export async function bookAgainLookup("));
  ok(fn.length > 100, "bookAgainUrl is there");
  ok(/again:\s*signBookAgainToken\(client\.id, authSecret\(\)\)/.test(fn), "the link's again= is the signed token");
  const keys = [...fn.matchAll(/q\.set\("(\w+)"/g)].map((m) => m[1]);
  ok(keys.join(",") === "address,items", `the link carries only address and items besides the token (${keys.join(",")})`);
  ok(!/client\.(email|phone|company|name)/.test(fn), "bookAgainUrl reads no personal field");
  const route = code(readFileSync(path.join(ROOT, "src/app/api/studio/book-again/route.ts"), "utf8"));
  ok(/x-intake-secret/.test(route) && /BOOKING_INTAKE_SECRET/.test(route), "the route checks the intake secret");
  ok(route.indexOf("BOOKING_INTAKE_SECRET") < route.indexOf("bookAgainLookup("), "the secret comes before the lookup");
  ok(/timingSafeEqual/.test(route), "the secret compare is constant time");
  ok(/no-store/.test(route), "the answer is never cached");
  ok(/if \(!business\.bookAgain\) return Response\.json\(\{ ok: false, error: "not found" \}, \{ status: 404/.test(route) && route.indexOf("business.bookAgain") < route.indexOf("bookAgainLookup("), "the route is a 404 while business.bookAgain is off");
  ok(/status: 404/.test(route) && /status: 401/.test(route), "401 without the secret, 404 for a bad token");
  const look = pb.slice(pb.indexOf("export async function bookAgainLookup("));
  ok(/verifyBookAgainToken\(token, authSecret\(\), nowMs\)/.test(look) && look.indexOf("verifyBookAgainToken(") < look.indexOf("clients.findFirst"), "the lookup verifies the token before reading the client");

  const { bookAgainUrl, bookAgainLookup } = await import("../src/lib/portal-bookings");
  ok((await bookAgainUrl("agent@example.com", "https://example.com/")) === "https://example.com/book", "demo mode links the plain booking page");
  ok((await bookAgainLookup(t)) === null, "demo mode looks nothing up");

  console.log(fails ? `${fails} FAILED, ${passes} passed` : `All ${passes} checks passed`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
