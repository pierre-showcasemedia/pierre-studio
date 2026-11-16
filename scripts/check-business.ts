// Checks the business config and that nothing from another business is left
// in the repo. No database, no network.
//
//   npx tsx scripts/check-business.ts
//
// 1. src/lib/business.ts: a real IANA time zone, https URLs, valid emails, a
//    known payment method and editing path, a calendar prefix Google accepts,
//    whole-cent shooter pay rates.
// 2. A buyer's studio (TEMPLATE = false): no placeholder left (example.com,
//    a 555 number, "Your Studio", "Your City").
// 3. No ACRE-era names, domains, people or repos in any tracked file.
// 4. The brand files exist, and .env.example lists names only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

let failures = 0;
let passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
};

async function main() {
  const { business, TEMPLATE, BUSINESS_TZ } = await import("../src/lib/business");
  const { brand } = await import("../src/lib/brand");

  // ---- 1. shape -------------------------------------------------------------------
  let tzOk = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ }).format(new Date());
    tzOk = /^[A-Z][A-Za-z_]+\/[A-Za-z_/]+$/.test(BUSINESS_TZ);
  } catch {
    tzOk = false;
  }
  ok(tzOk, `a real time zone (${BUSINESS_TZ})`);
  ok(business.timeZoneShort.length > 0 && business.timeZoneAbbr.length > 0 && business.timeZoneLabel.length > 0, "time zone labels set");
  for (const [k, v] of [["marketingUrl", business.marketingUrl], ["portalUrl", business.portalUrl]] as const) ok(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/.test(v), `${k} is an https origin with no path (${v})`);
  const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;
  ok(EMAIL.test(business.supportEmail), `supportEmail is an email (${business.supportEmail})`);
  ok(/^[^<>]+ <[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>$/.test(business.emailFrom), `emailFrom reads "Name <address>" (${business.emailFrom})`);
  ok(!business.phone || business.phone.replace(/\D/g, "").length === 10, `phone is empty or ten digits (${business.phone})`);
  ok(["stripe", "manual"].includes(business.payments), `payments is stripe or manual (${business.payments})`);
  ok(["autohdr", "manual"].includes(business.editing), `editing is autohdr or manual (${business.editing})`);
  ok(/^[a-v0-9]{3,20}$/.test(business.calendarPrefix), `calendar prefix uses Google's base32hex letters only (${business.calendarPrefix})`);
  ok(business.neverMessage.every((e) => EMAIL.test(e) && e === e.toLowerCase()), "never-message list: lowercase emails");
  const rates = [...Object.values(business.shooterPay.perShoot), ...Object.values(business.shooterPay.byItem).flatMap((r) => Object.values(r))];
  ok(rates.every((c) => Number.isInteger(c) && c >= 0), "shooter pay rates are whole cents");
  ok([...Object.keys(business.shooterPay.perShoot), ...Object.keys(business.shooterPay.byItem)].every((e) => EMAIL.test(e) && e === e.toLowerCase()), "shooter pay rates are keyed by lowercase email");
  const person = business.scorecard.person;
  ok(!person || (EMAIL.test(person.email) && /^\d{4}-\d{2}-\d{2}$/.test(person.start)), "scorecard person: an email and a start date");
  ok(brand.name === business.name && brand.legalName === business.legalName, "brand.ts reads business.ts");
  // Manual editing: nothing is ever sent to the editing service, keys or not.
  {
    const env = process.env as Record<string, string | undefined>;
    const saved = [env.AUTOHDR_CLIENT_ID, env.AUTOHDR_CLIENT_SECRET];
    env.AUTOHDR_CLIENT_ID = "check-id";
    env.AUTOHDR_CLIENT_SECRET = "check-secret";
    const { hasAutoHdr } = await import("../src/lib/autohdr");
    ok(hasAutoHdr() === (business.editing === "autohdr"), `editing "${business.editing}": the editing service is ${business.editing === "autohdr" ? "used when its keys are set" : "never used, even with keys set"}`);
    [env.AUTOHDR_CLIENT_ID, env.AUTOHDR_CLIENT_SECRET] = saved;
    const upload = readFileSync("src/app/admin/upload/page.tsx", "utf8");
    ok(/business\.editing === "manual"/.test(upload) && /#upload/.test(upload), "manual editing: Upload a shoot points to the listing's upload");
  }
  console.log(`1. business.ts: ${business.name}, ${BUSINESS_TZ}, ${business.payments}, editing ${business.editing}`);

  // ---- 2. placeholders -----------------------------------------------------------------
  const PLACEHOLDER = /example\.com|\(555\) 01\d-\d{4}|Your Studio|Your City|your area/;
  const bizSrc = readFileSync("src/lib/business.ts", "utf8").replace(/^\s*\/\/.*$/gm, "");
  if (TEMPLATE) {
    console.log("2. studio-universal (TEMPLATE = true): placeholders allowed");
  } else {
    const left = bizSrc.split("\n").filter((l) => PLACEHOLDER.test(l));
    ok(left.length === 0, `no placeholder left in business.ts (${left.map((l) => l.trim()).join(" | ")})`);
    console.log("2. placeholders: none");
  }

  // ---- 3. nothing from another business -------------------------------------------------
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((f) => f && /\.(ts|tsx|mjs|js|css|md|json|py|example)$|^\.env\.example$/.test(f) && !/package-lock\.json$/.test(f));
  const BANNED: [RegExp, string][] = [
    [/\bACRE\b|acrecalifornia|acreagency|acre-california|\bacre[_-](?!s)/, "ACRE"],
    [/Framed by JG|jacobguthrie/i, "Framed by JG"],
    [/\b(Jacob|Dillon|Mariella|Bryden)\b/, "an ACRE team member"],
    [/Olesya|Thyne|Kellenberger|Village Properties/, "an ACRE client"],
    [/\(805\) 308-7877|\+18053087877/, "the ACRE phone line"],
    [/jacobtguthrie|jordan\.wipf/i, "a personal email"],
  ];
  const self = "scripts/check-business.ts";
  for (const [re, what] of BANNED) {
    const hits = files.filter((f) => f !== self && existsSync(f) && re.test(readFileSync(f, "utf8")));
    ok(hits.length === 0, `no ${what} in the repo (${hits.slice(0, 8).join(", ")}${hits.length > 8 ? ", ..." : ""})`);
  }
  console.log(`3. ${files.length} files searched`);

  // ---- 4. brand files and .env.example --------------------------------------------------
  for (const f of ["public/brand/logo-dark.png", "public/brand/logo-white.png", "public/brand/watermark.png", "src/app/icon.png", "src/app/apple-icon.png"]) ok(existsSync(f), `${f} exists`);
  ok(brand.logoBlack === "/brand/logo-dark.png" && brand.watermark === "/brand/watermark.png", "brand.ts points at the files");
  const env = readFileSync(".env.example", "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  const valued = env.filter((l) => !/^[A-Z][A-Z0-9_]*=\s*$/.test(l));
  ok(valued.length === 0, `.env.example lists names only (${valued.join(" | ")})`);
  console.log("4. brand files and .env.example: ok");

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
