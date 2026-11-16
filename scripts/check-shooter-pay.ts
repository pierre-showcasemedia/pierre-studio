// Checks for the Shooter pay report (/admin/reports#pay, src/lib/reports.ts).
// No database, no network.
//
//   npx tsx scripts/check-shooter-pay.ts
//
// 1. Rates: a job-type rate wins, then the per-shoot rate, else "Rate not set"
//    (null), never a made-up number.
// 2. What counts: bookings with a shooter, by shoot date in the range;
//    canceled ones and ones with nobody on them are left out; additional
//    shoots count when countVisits is on.
// 3. Totals add only the rated shoots, and the CSV carries every line.
// 4. The page shows the section, the CSV route knows it, and the admin API's
//    read-only shooterPay op reads the real visits table.
import { readFileSync } from "node:fs";

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
  const { shooterPay, shooterRate, sectionCsv, isReportSection } = await import("../src/lib/reports");
  type Rows = Parameters<typeof shooterPay>[0];
  const rates = { perShoot: { "alex@example.com": 100_00, "kim@example.com": 90_00 }, byItem: { "alex@example.com": { video: 150_00, "visit:twilight": 40_00 } }, countVisits: true };

  // ---- 1. rates -------------------------------------------------------------------
  ok(shooterRate(rates, "Alex@Example.com", ["medium", "video"]) === 150_00, "a job-type rate wins (and the email is matched without case)");
  ok(shooterRate(rates, "alex@example.com", ["medium", "photos"]) === 100_00, "else the per-shoot rate");
  ok(shooterRate(rates, "new@example.com", ["photos"]) === null, "no rate: null, never a number");
  console.log("1. rates: ok");

  // ---- 2. what counts -------------------------------------------------------------
  const b = (id: string, shooter: string | null, ymd: string, status = "confirmed", serviceIds = ["medium", "photos"]) => ({
    id, status, dateYmd: ymd, shootYmd: ymd, createdYmd: "2026-11-01", photographerEmail: shooter, clientEmail: "agent@example.com", clientName: null, clientCompany: null, listingId: `l-${id}`, address: `${id} Example Street`, serviceIds, servicesLabel: "Medium home + Photos",
  });
  const rows: Rows = {
    invoices: [],
    revisions: [],
    shoots: [],
    bookings: [
      b("b1", "alex@example.com", "2026-11-03"),
      b("b2", "alex@example.com", "2026-11-04", "shot", ["medium", "video"]),
      b("b3", "kim@example.com", "2026-11-05"),
      b("b4", "kim@example.com", "2026-11-06", "canceled"),
      b("b5", null, "2026-11-07"),
      b("b6", "new@example.com", "2026-11-08"),
      b("b7", "alex@example.com", "2026-12-20"),
    ],
    visits: [
      { id: "v1", bookingId: "b1", kind: "twilight", status: "done", ymd: "2026-11-09", photographerEmail: "alex@example.com", address: "" },
      { id: "v2", bookingId: "b3", kind: "return_trip", status: "canceled", ymd: "2026-11-10", photographerEmail: "kim@example.com", address: "" },
    ],
  };
  const range = { from: "2026-11-01", to: "2026-11-30" };
  const pay = shooterPay(rows, range, rates);
  const alex = pay.totals.find((t) => t.shooter === "alex@example.com");
  const kim = pay.totals.find((t) => t.shooter === "kim@example.com");
  const fresh = pay.totals.find((t) => t.shooter === "new@example.com");
  ok(alex?.shoots === 3 && alex.payCents === 100_00 + 150_00 + 40_00, `alex: two bookings and a twilight visit, $290 (${JSON.stringify(alex)})`);
  ok(kim?.shoots === 1 && kim.payCents === 90_00, "kim: the canceled booking and the canceled visit are left out");
  ok(fresh?.shoots === 1 && fresh.unrated === 1 && fresh.payCents === 0, "a shooter with no rate: counted, Rate not set, $0 in the total");
  ok(!pay.lines.some((l) => l.bookingId === "b5"), "a booking with nobody on it is not anyone's pay");
  ok(!pay.lines.some((l) => l.bookingId === "b7"), "outside the range: left out");
  ok(pay.lines.find((l) => l.kind === "visit")?.address === "b1 Example Street", "a visit takes its booking's address");
  const noVisits = shooterPay(rows, range, { ...rates, countVisits: false });
  ok(noVisits.totals.find((t) => t.shooter === "alex@example.com")?.shoots === 2, "countVisits off: additional shoots are not counted");
  // Paid as a share of what the booking collected (Jerry: "50% of collected").
  const paid = (id: string, bookingId: string, cents: number, status = "paid", refundedCents = 0) => ({ id, status, provider: "stripe", method: "card", amountCents: cents, refundedCents, paidYmd: "2026-11-10", createdYmd: "2026-11-01", clientEmail: null, clientName: null, clientCompany: null, listingId: null, address: null, bookingId });
  const pctRows: Rows = { ...rows, invoices: [paid("i1", "b1", 300_00), paid("i1b", "b1", 50_00), paid("i3", "b3", 200_00, "paid", 40_00), paid("i6", "b6", 999_00, "open")] };
  const half = shooterPay(pctRows, range, { perShoot: { "kim@example.com": 90_00 }, byItem: {}, countVisits: true, percentOfCollected: 50 });
  const line = (id: string, kind = "booking") => half.lines.find((l) => l.bookingId === id && l.kind === kind)!;
  ok(line("b1").basis === "percent" && line("b1").rateCents === 175_00 && line("b1").collectedCents === 350_00, "50% of everything collected on the booking, add-on invoice included ($175 of $350)");
  ok(line("b2").basis === "uncollected" && line("b2").rateCents === 0, "nothing paid yet: Not collected yet, $0");
  ok(line("b6").basis === "uncollected", "an open invoice is not collected");
  ok(line("b3").basis === "rate" && line("b3").rateCents === 90_00, "an explicit per-shoot rate still wins");
  ok(line("b1", "visit").basis === "included" && line("b1", "visit").rateCents === 0, "an additional shoot is part of the booking's pay");
  const alexHalf = half.totals.find((t) => t.shooter === "alex@example.com")!;
  ok(alexHalf.payCents === 175_00 && alexHalf.uncollected === 1, `alex's total counts only what is collected (${JSON.stringify(alexHalf)})`);
  const refunded = shooterPay({ ...rows, invoices: [paid("i3", "b3", 200_00, "paid", 40_00)] }, range, { perShoot: {}, byItem: {}, countVisits: false, percentOfCollected: 50 });
  ok(refunded.lines.find((l) => l.bookingId === "b3")!.rateCents === 80_00, "refunds come off before the share ($160 net, $80)");
  console.log("2. what counts: ok");

  // ---- 3. the CSV ------------------------------------------------------------------
  ok(isReportSection("pay"), "pay is a report section");
  const csv = sectionCsv("pay", rows, range);
  const text = csv.lines.join("\n");
  ok(csv.lines[0].startsWith("Shooter,Shoot date,Address"), "the CSV header");
  const { payRates } = await import("../src/lib/reports");
  const emptyLine = payRates().percentOfCollected ? /Not collected yet/ : /Rate not set/; // the CSV follows this studio's settings
  ok(emptyLine.test(text) && /alex@example\.com,Total/.test(text) && csv.lines[0].includes("Collected"), "the CSV has the unpaid or unrated line, the collected column and the totals");
  console.log("3. csv: ok");

  // ---- 4. wiring ----------------------------------------------------------------------
  const page = readFileSync("src/app/admin/reports/page.tsx", "utf8");
  ok(/shooterPay\(rows, range, payRates\(\)\)/.test(page) && /id="pay"/.test(page) && /requireAdmin\(\)/.test(page), "the Reports page shows it, admins only");
  const api = readFileSync("src/app/api/portal/admin-api/route.ts", "utf8");
  ok(/from booking_visits v/.test(api) && !/from visits v/.test(api), "the admin API's shooterPay op reads booking_visits");
  const biz = readFileSync("src/lib/business.ts", "utf8");
  ok(/shooterPay: \{/.test(biz) && /perShoot/.test(biz), "the rates live in src/lib/business.ts");
  console.log("4. wiring: ok");

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
