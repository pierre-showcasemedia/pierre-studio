// The headshot and logo upload (Nov 24 2026): same origin only, and the
// client looked up by the lower case email (src/lib/profile-images.ts,
// src/app/api/portal/profile-image/route.ts).
//
//   npx tsx scripts/check-profile-origin.ts
//
// 1. sameOriginPost: no Origin header goes on; the app's own origins pass;
//    another site, "null", another scheme or port, or garbage is refused.
// 2. profileLookupEmail.
// 3. Static: the route checks the origin first, against siteUrl() and its
//    own request address, and looks the client up by profileLookupEmail.
// No database, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { profileLookupEmail, sameOriginPost } from "../src/lib/profile-images";

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

// ---- 1. same origin ----------------------------------------------------------
const own = ["https://portal.example.com", "https://studio-git-preview.example.app"];
ok(sameOriginPost(null, own), "no Origin header: on to the session check");
ok(sameOriginPost("https://portal.example.com", own), "the portal's own origin passes");
ok(sameOriginPost("https://PORTAL.example.com", own), "host case does not matter");
ok(sameOriginPost("https://studio-git-preview.example.app", own), "the address the request came in on passes (a preview)");
ok(sameOriginPost("https://portal.example.com:443", own), "the default port is the same origin");
ok(!sameOriginPost("https://evil.example.net", own), "another site is refused");
ok(!sameOriginPost("https://portal.example.com.evil.net", own), "a look-alike host is refused");
ok(!sameOriginPost("https://evilportal.example.com", own), "a look-alike prefix is refused");
ok(!sameOriginPost("http://portal.example.com", own), "plain http is another origin");
ok(!sameOriginPost("https://portal.example.com:8443", own), "another port is another origin");
ok(!sameOriginPost("null", own), "an opaque origin (\"null\") is refused");
ok(!sameOriginPost("", own), "an empty Origin header is refused");
ok(!sameOriginPost("not a url", own), "garbage is refused");
ok(!sameOriginPost("file:///etc/passwd", own), "another scheme is refused");
ok(!sameOriginPost("https://portal.example.com", []), "no own origin: refused");
ok(sameOriginPost("https://portal.example.com", ["https://portal.example.com/", null, undefined, "not a url"]), "a trailing slash or a missing entry in the own list is fine");

// ---- 2. the lookup email -------------------------------------------------------
ok(profileLookupEmail("  Taylor.Brooks@Example.COM ") === "taylor.brooks@example.com", "the lookup email is trimmed and lower case");
ok(profileLookupEmail("agent@example.com") === "agent@example.com", "a lower case email stays the same");

// ---- 3. the route ----------------------------------------------------------------
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const route = code(readFileSync(path.join(ROOT, "src/app/api/portal/profile-image/route.ts"), "utf8"));
const post = route.slice(route.indexOf("export async function POST("));
ok(/sameOriginPost\(request\.headers\.get\("origin"\), \[siteUrl\(\), new URL\(request\.url\)\.origin\]\)/.test(post), "the route checks the Origin header against siteUrl() and its own address");
ok(post.indexOf("sameOriginPost(") < post.indexOf("formData(") && post.indexOf("sameOriginPost(") < post.indexOf("sessionEmail("), "the origin check comes before the session and the form are read");
ok(/status: 403/.test(post), "a cross-site post is a 403");
ok(/clients\.email, profileLookupEmail\(email\)\)/.test(post), "the client is looked up by the lower case email");
ok(!/clients\.email, email\)/.test(post), "never by the raw email");

console.log(`check-profile-origin: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
