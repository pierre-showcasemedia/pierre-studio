// The reminder's day and the property page's daily views (Nov 24 2026).
//
//   npx tsx scripts/check-reminder-and-views.ts
//
// 1. reminderDay (src/lib/reminder-day.ts): today, tomorrow, the weekday or
//    the date, from when the email is built, in the business's time zone
//    (late evening and the small hours, both sides of a time change).
// 2. The reminder email (buildTimeEmail) says that day in its subject,
//    eyebrow and headline, never a fixed "tomorrow"; the client copy rules.
// 3. schema.ts points at the reminder's real file.
// 4. Property views: the visitor key is the same for repeat loads on one
//    day, different on another day, listing, address or browser, and holds
//    neither the address nor the user agent; the address read; the one
//    statement that counts only a first visit; the DDL and its mirror.
// No database, no network.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

async function main() {
  const { reminderDay, localYmd } = await import("../src/lib/reminder-day");
  const { buildTimeEmail } = await import("../src/lib/booking-time-email");
  const { bookingEmailSubject } = await import("../src/lib/booking-email");
  const { BUSINESS_TZ } = await import("../src/lib/business");
  const { viewerKey, visitorIp, viewDay } = await import("../src/lib/property-page");

  // ---- 1. reminderDay -------------------------------------------------------------
  const NY = "America/New_York";
  const DEN = "America/Denver";
  const at = (iso: string) => new Date(iso);
  // Tuesday Nov 24 2026, 9:00 AM in New York.
  ok(reminderDay("2026-11-24", at("2026-11-24T14:00:00Z"), NY).phrase === "today", "same day: today");
  ok(reminderDay("2026-11-25", at("2026-11-24T14:00:00Z"), NY).phrase === "tomorrow", "next day: tomorrow");
  ok(reminderDay("2026-11-25", at("2026-11-24T14:00:00Z"), NY).eyebrow === "See you tomorrow", "tomorrow's eyebrow");
  ok(reminderDay("2026-11-24", at("2026-11-24T14:00:00Z"), NY).eyebrow === "See you today", "today's eyebrow");
  ok(reminderDay("2026-11-27", at("2026-11-24T14:00:00Z"), NY).phrase === "on Friday", "three days out: the weekday");
  ok(reminderDay("2026-11-27", at("2026-11-24T14:00:00Z"), NY).eyebrow === "See you Friday", "the weekday's eyebrow");
  ok(reminderDay("2026-11-30", at("2026-11-24T14:00:00Z"), NY).phrase === "on Monday", "six days out: still the weekday");
  ok(reminderDay("2026-12-01", at("2026-11-24T14:00:00Z"), NY).phrase === "on Tuesday, December 1", "a week out: the weekday and the date");
  ok(reminderDay("2026-11-23", at("2026-11-24T14:00:00Z"), NY).phrase === "coming up", "a past date never says tomorrow");
  ok(reminderDay(null, at("2026-11-24T14:00:00Z"), NY).phrase === "coming up" && reminderDay(null, at("2026-11-24T14:00:00Z"), NY).eyebrow === "See you soon", "no date: coming up");
  ok(reminderDay("not a date", at("2026-11-24T14:00:00Z"), NY).phrase === "coming up", "a bad date: coming up");
  // 11:30 PM Monday in Denver is already Tuesday in UTC: the business's day wins.
  ok(localYmd(at("2026-11-24T06:30:00Z"), DEN) === "2026-11-23", "11:30 PM in Denver is still Monday there");
  ok(reminderDay("2026-11-24", at("2026-11-24T06:30:00Z"), DEN).phrase === "tomorrow", "sent late Monday night for Tuesday: tomorrow, not today");
  ok(reminderDay("2026-11-24", at("2026-11-24T06:30:00Z"), "UTC").phrase === "today", "the same instant in UTC is today: the time zone matters");
  // 12:30 AM Tuesday in Denver for a Tuesday shoot.
  ok(reminderDay("2026-11-24", at("2026-11-24T07:30:00Z"), DEN).phrase === "today", "sent just after midnight for that day: today");
  // Across the March time change (Mar 8 2026 in the US).
  ok(reminderDay("2026-03-09", at("2026-03-08T15:00:00Z"), DEN).phrase === "tomorrow", "across the spring time change: tomorrow");
  ok(reminderDay("2026-11-02", at("2026-11-01T15:00:00Z"), DEN).phrase === "tomorrow", "across the fall time change: tomorrow");
  for (const d of ["2026-11-24", "2026-11-25", "2026-11-27", "2026-12-01", null]) {
    const r = reminderDay(d, at("2026-11-24T14:00:00Z"), NY);
    ok(!/—|--|!/.test(r.phrase + r.eyebrow), `no em dash, double hyphen or exclamation: ${r.phrase}`);
  }

  // ---- 2. the email -------------------------------------------------------------------
  const booking = {
    id: "9b2e4c1a-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
    status: "confirmed",
    desiredDate: "2026-11-27",
    startTime: "10:00",
    launchDate: null,
    serviceIds: [],
    addonIds: [],
    calendarVersion: 1,
    clientRescheduledAt: null,
    property: { street: "1420 Example Alder Drive" },
    listing: { address: "1420 Example Alder Drive, Springfield, CA 90000", slug: "1420-example-alder-drive" },
    client: { name: "Taylor Brooks", email: "agent@example.com" },
  } as unknown as Parameters<typeof buildTimeEmail>[0];
  const local = (ymd: string, hour: number) => {
    // An instant whose local day in the business's zone is ymd (noon-ish keeps it clear of midnight).
    for (let h = -14; h <= 14; h++) {
      const d = new Date(Date.parse(`${ymd}T${String(hour).padStart(2, "0")}:00:00Z`) + h * 3600_000);
      if (localYmd(d, BUSINESS_TZ) === ymd && Number(new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", hour12: false }).format(d)) === hour) return d;
    }
    throw new Error(`no instant for ${ymd} ${hour}`);
  };
  const thu = buildTimeEmail(booking, "reminder", { now: local("2026-11-26", 10) });
  ok(thu.subject === "Your shoot is tomorrow: 1420 Example Alder Drive", `the day before: tomorrow (${thu.subject})`);
  ok(/See you tomorrow/.test(thu.html) && /Your shoot is tomorrow\./.test(thu.text), "the day before: eyebrow and headline");
  const fri = buildTimeEmail(booking, "reminder", { now: local("2026-11-27", 7) });
  ok(fri.subject === "Your shoot is today: 1420 Example Alder Drive", `the same morning: today (${fri.subject})`);
  ok(/See you today/.test(fri.html) && /Your shoot is today\./.test(fri.text) && !/tomorrow/i.test(fri.html + fri.text), "the same morning: never says tomorrow");
  const tue = buildTimeEmail(booking, "reminder", { now: local("2026-11-24", 15) });
  ok(tue.subject === "Your shoot is on Friday: 1420 Example Alder Drive", `three days ahead: on Friday (${tue.subject})`);
  ok(/See you Friday/.test(tue.html) && /Your shoot is on Friday\./.test(tue.text) && !/tomorrow/i.test(tue.html + tue.text), "three days ahead: the weekday, never tomorrow");
  for (const e of [thu, fri, tue]) ok(!/—|--|!/.test(e.subject) && !/—/.test(e.text), `client copy rules: ${e.subject}`);
  ok(buildTimeEmail(booking, "time_confirmed", { now: local("2026-11-24", 15) }).subject === "Your shoot time is confirmed: 1420 Example Alder Drive", "the other time emails are unchanged");
  ok(bookingEmailSubject("1420 Example Alder Drive", false, "reminder") === "Your shoot is tomorrow: 1420 Example Alder Drive", "with no day worked out (an old caller) the subject keeps its old wording");
  const bte = code(read("src/lib/booking-time-email.ts"));
  ok(/reminderDay: mode === "reminder" \? reminderDay\(b\.desiredDate, opts\.now \?\? new Date\(\), BUSINESS_TZ\) : null/.test(bte), "buildTimeEmail works the day out from now, in the business's time zone");
  ok(/buildTimeEmail\(b, "reminder"\)/.test(bte), "the reminder job builds the email when it sends (now)");
  const be = code(read("src/lib/booking-email.ts"));
  ok(!/Your shoot is tomorrow|"See you tomorrow"|em\("tomorrow\."\)/.test(be), "booking-email.ts has no fixed tomorrow left");

  // ---- 3. the schema comment ------------------------------------------------------------
  const schemaSrc = read("src/db/schema.ts");
  for (const m of schemaSrc.matchAll(/src\/lib\/([\w-]+)\.ts/g)) ok(existsSync(path.join(ROOT, "src/lib", `${m[1]}.ts`)), `schema.ts points at a real file: src/lib/${m[1]}.ts`);
  ok(!/reminder-email\.ts/.test(schemaSrc), "no pointer to the missing reminder-email.ts");
  ok(/prep checklist \(src\/lib\/booking-time-email\.ts\)/.test(schemaSrc), "email.reminder points at booking-time-email.ts");

  // ---- 4. property views ------------------------------------------------------------------
  const secret = "check-only-secret";
  const L = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1";
  const k = viewerKey(secret, L, "2026-11-24", "203.0.113.7", UA);
  ok(k === viewerKey(secret, L, "2026-11-24", "203.0.113.7", UA), "a repeat load the same day is the same visitor");
  ok(k !== viewerKey(secret, L, "2026-11-25", "203.0.113.7", UA), "the next day counts again");
  ok(k !== viewerKey(secret, "1f0e0d0c-0b0a-4908-8706-050403020100", "2026-11-24", "203.0.113.7", UA), "another listing counts on its own");
  ok(k !== viewerKey(secret, L, "2026-11-24", "198.51.100.2", UA), "another address is another visitor");
  ok(k !== viewerKey(secret, L, "2026-11-24", "203.0.113.7", `${UA} Chrome`), "another browser is another visitor");
  ok(k !== viewerKey("another-secret", L, "2026-11-24", "203.0.113.7", UA), "the key depends on the server secret");
  ok(k.startsWith(`${L}:2026-11-24:`) && /^[0-9a-f]{32}$/.test(k.split(":")[2]), "the key is listing, day and a 32 character hash");
  ok(!k.includes("203.0.113.7") && !k.includes("iPhone") && !k.includes("Mozilla"), "the key holds neither the address nor the user agent");
  const H = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
  ok(visitorIp(H({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })) === "203.0.113.7", "the first forwarded address is the visitor's");
  ok(visitorIp(H({ "x-real-ip": " 198.51.100.2 " })) === "198.51.100.2", "x-real-ip when there is no forwarded list");
  ok(visitorIp(H({})) === "", "no address: empty, still one key per browser per day");
  ok(viewDay(at("2026-11-24T14:00:00Z")) === localYmd(at("2026-11-24T14:00:00Z"), BUSINESS_TZ), "the day is the business's calendar day");
  const pp = code(read("src/lib/property-page.ts"));
  const rec = pp.slice(pp.indexOf("export async function recordPropertyView("), pp.indexOf("export const VIEW_SOURCES"));
  ok(/WITH seen AS \(\s*INSERT INTO property_view_days \(key, day\) VALUES \(\$\{key\}, \$\{day\}::date\)\s*ON CONFLICT \(key\) DO NOTHING\s*RETURNING 1\s*\)/.test(rec), "the visitor row is inserted once a day, a repeat inserts nothing");
  ok(/UPDATE listings SET page_views = page_views \+ 1[\s\S]*WHERE id = \$\{listingId\} AND EXISTS \(SELECT 1 FROM seen\)/.test(rec), "the count goes up only when the visitor row is new, in the same statement");
  ok(/viewerKey\(authSecret\(\), listingId, day, ip \?\? "", userAgent\)/.test(rec), "the key is made with the server secret");
  ok(rec.indexOf("BOT_RE.test(userAgent)") < rec.indexOf("viewerKey("), "robots are still never counted");
  ok(/DELETE FROM property_view_days WHERE day < \$\{day\}::date - 1/.test(rec), "rows older than yesterday are pruned");
  ok(!/cookies\(|set-cookie|document\.cookie/i.test(pp), "no cookie");
  const page = code(read("src/app/property/[token]/page.tsx"));
  ok(/const ip = visitorIp\(h\);/.test(page) && /recordPropertyView\(listing\.id, ua, source, ip\)/.test(page), "the property page passes the visitor's address in");
  ok(!/<script[^>]+src=/i.test(page), "no third-party script on the property page");
  const ddl = read("src/app/api/portal/migrate/route.ts");
  ok(/CREATE TABLE IF NOT EXISTS "property_view_days" \(\s*"key" text PRIMARY KEY NOT NULL,\s*"day" date NOT NULL,\s*"created_at" timestamp DEFAULT now\(\) NOT NULL\s*\)/.test(ddl), "the DDL creates property_view_days, idempotent");
  ok(/CREATE INDEX IF NOT EXISTS "property_view_days_day_idx" ON "property_view_days"\("day"\)/.test(ddl), "the prune index, idempotent");
  ok(/pgTable\("property_view_days", \{\s*key: text\("key"\)\.primaryKey\(\),\s*day: date\("day"\)\.notNull\(\),\s*createdAt: timestamp\("created_at"\)\.defaultNow\(\)\.notNull\(\),\s*\}, \(t\) => \[index\("property_view_days_day_idx"\)\.on\(t\.day\)\]\)/.test(schemaSrc), "schema.ts mirrors the DDL");

  console.log(`check-reminder-and-views: ${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
