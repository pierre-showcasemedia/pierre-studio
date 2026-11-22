// Checks for Pic-Time galleries on a listing (Nov 22 2026, src/lib/pictime.ts):
// the link is checked before it is saved, and with one set the delivery email
// sends the client there, drops the studio cover and share link when the
// studio has no photos, keeps any owed invoice's Pay button, makes no promise
// about watermarks, and never names the vendor to the client. The portal
// status reads Delivered once the email has gone. The column exists in both
// the migrate route and the schema.
//
//   npx tsx scripts/check-pictime.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
export {};
import { readFileSync } from "node:fs";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
  process.exit(2);
}

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
  const { parsePicTimeUrl } = await import("../src/lib/pictime");
  const { deliveryEmailHtml, defaultDeliveryBody } = await import("../src/lib/delivery-email");
  const { shootStatus } = await import("../src/lib/listing-status");

  // 1. The link
  const good = parsePicTimeUrl("  https://showcasemediallc.pic-time.com/-100examplelane/gallery  ");
  ok(good.ok && good.url === "https://showcasemediallc.pic-time.com/-100examplelane/gallery", "a gallery link on the studio's Pic-Time address is kept, trimmed");
  ok(parsePicTimeUrl("https://pic-time.com/x").ok, "the bare pic-time.com host is accepted");
  const empty = parsePicTimeUrl("   ");
  ok(empty.ok && empty.url === null, "an empty field clears the link");
  ok(!parsePicTimeUrl("http://showcasemediallc.pic-time.com/x").ok, "http is refused");
  ok(!parsePicTimeUrl("https://pic-time.com.evil.example/x").ok, "a look-alike host is refused");
  ok(!parsePicTimeUrl("https://evilpic-time.com/x").ok, "a host that only ends in the same letters is refused");
  ok(!parsePicTimeUrl("https://user:pass@showcasemediallc.pic-time.com/x").ok, "a link with a username and password is refused");
  ok(!parsePicTimeUrl("javascript:alert(1)").ok, "a script link is refused");
  ok(!parsePicTimeUrl("showcasemediallc.pic-time.com").ok, "a link without https:// is refused");

  // 2. The delivery email
  const gallery = "https://showcasemediallc.pic-time.com/-100examplelane/gallery";
  const base = {
    address: "100 Example Lane, Madison, WI 53718",
    portalUrl: "https://portal.example.com/portal/login",
    shareUrl: null,
    invoiceUrl: "https://portal.example.com/pay-link",
    invoiceAmount: "$175",
    locked: true,
    clientFirstName: "Avery",
  };
  const outside = deliveryEmailHtml({ ...base, coverUrl: null, galleryUrl: gallery });
  ok(outside.includes(`href="${gallery}"`), "the main button goes to the Pic-Time gallery");
  ok(!/\/api\/portal\/cover\//.test(outside), "no studio cover image when the studio has no photos");
  ok(outside.includes("Pay invoice"), "an owed invoice keeps its Pay button");
  ok(!/Watermarks come off/.test(outside), "no promise that watermarks come off");
  ok(!/pic-?time/i.test(outside.replace(gallery, "")), "the email text never names the vendor");
  ok(outside.includes("in your gallery"), "the default wording points to the gallery");

  const studio = deliveryEmailHtml({ ...base, coverUrl: "https://portal.example.com/api/portal/cover/l1" });
  ok(studio.includes('href="https://portal.example.com/portal/login"'), "without a link the main button still goes to the portal");
  ok(/\/api\/portal\/cover\/l1/.test(studio), "without a link the cover image is still there");
  ok(/Watermarks come off/.test(studio), "without a link the unlock wording is unchanged");

  const body = defaultDeliveryBody(base.address, true, true);
  ok(!/pic-?time/i.test(body), "the default body never names the vendor");
  ok(!/unlock/i.test(body), "the default body makes no unlock promise for an outside gallery");
  ok(defaultDeliveryBody(base.address, true) === defaultDeliveryBody(base.address, true, false), "the studio wording is unchanged by default");

  // 3. Portal status
  ok(shootStatus({ mediaCount: 0, downloadLocked: true, picTimeUrl: gallery, deliveryEmailAt: "2026-11-22" }) === "Delivered", "a Pic-Time listing whose email has gone is Delivered");
  ok(shootStatus({ mediaCount: 0, downloadLocked: true, picTimeUrl: gallery, deliveryEmailAt: null }) === "Awaiting Shoot", "before the email it is not Delivered yet");
  ok(shootStatus({ mediaCount: 0, downloadLocked: true }) === "Awaiting Shoot", "a listing without a link is unchanged");

  // 4. Schema and migrate route agree
  const migrate = readFileSync("src/app/api/portal/migrate/route.ts", "utf8");
  const schema = readFileSync("src/db/schema.ts", "utf8");
  ok(migrate.includes('ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "pictime_url" text'), "the migrate route adds pictime_url idempotently");
  ok(schema.includes('picTimeUrl: text("pictime_url")'), "the schema mirrors it");

  // 5. Client copy on the portal page never names the vendor
  const page = readFileSync("src/app/portal/[slug]/page.tsx", "utf8");
  const jsxText = page.split("\n").filter((l) => !/^\s*(\/\/|\{\/\*)/.test(l)).join("\n");
  ok(!/>[^<{]*pic-?time/i.test(jsxText), "the portal page's visible text never names the vendor");

  console.log(failures ? `${failures} FAILED, ${passes} passed` : `All ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
