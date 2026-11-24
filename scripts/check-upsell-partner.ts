// The portal's upsell note shows to the client's own login only, never to a
// partner login (Nov 24 2026, upsellNoteFor in src/lib/upsell.ts).
//
//   npx tsx scripts/check-upsell-partner.ts
//
// 1. upsellNoteFor against PARTNER_EMAILS (case and spaces as a login types them).
// 2. Static: the listing page looks the upsell up, builds its Book again link
//    and renders the note only through upsellNoteFor(email).
// No database, no network.
import { readFileSync } from "node:fs";
import path from "node:path";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check needs no database.");
  process.exit(2);
}
process.env.PARTNER_EMAILS = "Partner@Example.com, second.partner@example.com";

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
  const { upsellNoteFor } = await import("../src/lib/upsell");
  const { isPartnerEmail } = await import("../src/lib/partner");

  // ---- 1. who gets the note --------------------------------------------------
  ok(upsellNoteFor("agent@example.com"), "a client login gets the note");
  ok(!upsellNoteFor("partner@example.com"), "a partner login does not");
  ok(!upsellNoteFor("  PARTNER@example.com "), "a partner login in another case or with spaces does not");
  ok(!upsellNoteFor("second.partner@example.com"), "every partner on the list");
  ok(upsellNoteFor("partner@example.com.au"), "a look-alike address is a client");
  for (const e of ["agent@example.com", "partner@example.com", "second.partner@example.com", "x@y.z"]) ok(upsellNoteFor(e) === !isPartnerEmail(e), `the same rule as isPartnerEmail: ${e}`);
  process.env.PARTNER_EMAILS = "";
  ok(upsellNoteFor("partner@example.com"), "with no partners set, everyone signed in is a client");

  // ---- 2. the listing page ------------------------------------------------------
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const page = code(readFileSync(path.join(ROOT, "src/app/portal/[slug]/page.tsx"), "utf8"));
  ok(/const upsell = upsellNoteFor\(email\) \? await upsellFor\(/.test(page), "the page looks the upsell up only for a client login");
  ok((page.match(/upsellFor\(/g) ?? []).length === 1, "upsellFor is called in one place only");
  ok(/const upsellUrl = upsell \?/.test(page), "the Book again link is built only when there is an upsell");
  ok(/\{upsell && upsellUrl && \(/.test(page), "the note renders only with an upsell and its link");
  ok(page.indexOf("upsellNoteFor(email)") > page.indexOf("const email = await sessionEmail()"), "the check reads the signed-in (or viewed as) email");
  const lib = code(readFileSync(path.join(ROOT, "src/lib/upsell.ts"), "utf8"));
  ok(/upsellNoteFor = \(email: string\): boolean => !isPartnerEmail\(email\)/.test(lib), "upsellNoteFor is the partner rule");

  console.log(`check-upsell-partner: ${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
