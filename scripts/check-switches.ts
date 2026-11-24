// Checks that the optional features ported from the studio template (Nov 24
// 2026) ship OFF for Showcase Media, and that each does what it says once
// turned on. No database, no network.
//
//   npx tsx scripts/check-switches.ts
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
const read = (p: string) => readFileSync(p, "utf8");

async function main() {
  const { business } = await import("../src/lib/business");

  // ---- The reminder before the shoot (off) ---------------------------------------------
  {
    ok(business.reminderEmail === false && business.reminderLeadHours === 24, "reminderEmail: off by default (24 hours ahead when on)");
    const { scheduleReminders, sendReminderEmail } = await import("../src/lib/booking-time-email");
    ok((await scheduleReminders()) === 0, "reminder off: nothing is queued");
    let skipped = false;
    try {
      await sendReminderEmail({ bookingId: "b1", idempotencyKey: "k", payload: null });
    } catch (e) {
      skipped = e instanceof Error && /switched off/.test(e.message);
    }
    ok(skipped, "reminder off: a queued reminder job skips without sending");
    const { reminderDay } = await import("../src/lib/reminder-day");
    const tz = "America/Chicago";
    ok(reminderDay("2026-12-01", new Date("2026-11-30T20:00:00Z"), tz).phrase === "tomorrow", "the day before: tomorrow");
    ok(reminderDay("2026-12-01", new Date("2026-12-01T05:30:00Z"), tz).phrase === "tomorrow", "late evening Central the night before is still tomorrow (UTC is already the 1st)");
    ok(reminderDay("2026-12-04", new Date("2026-11-30T20:00:00Z"), tz).phrase === "on Friday", "a few days out: the weekday");
    ok(reminderDay("2026-12-10", new Date("2026-11-30T20:00:00Z"), tz).phrase === "on Thursday, December 10", "a week or more: weekday and date");
    ok(reminderDay(null, new Date(), tz).phrase === "coming up", "no date: coming up");
  }

  // ---- File store and client discount -------------------------------------------------
  ok(business.fileStore === "dropbox", "fileStore: Dropbox, so no Google Drive anywhere");
  ok(business.clientDiscount === false, "clientDiscount: off by default");
  ok(/needsQuote \|\| !business\.clientDiscount \? q0/.test(read("src/lib/booking-intake.ts")), "client discount applied at intake only with the switch on");

  // ---- Travel bands (the shared price table's TRAVEL) -----------------------------------
  {
    const table = await import("../src/lib/booking-pricing");
    const { quote } = await import("../src/lib/studio-pricing");
    const size = table.PACKAGES[0].id;
    ok(!table.travelReady() && table.TRAVEL.steps.length === 0, "TRAVEL: no bands, so the per-mile rule stands and no band fee is ever added");
    const off = table.priceBooking({ package: size, items: [{ id: "photos" }], clientType: "agent", area: table.AREAS[1], miles: 80 });
    ok(!off.lines.some((l) => l.id === "travel"), "bands off: no travel line, whatever the miles");
    ok(off.quoteReasons.some((r) => /\$0\.50 a mile/.test(r)), "bands off: outside the area still reads Pierre's per-mile rule, to confirm");
    // Test values set and restored inside this check, never prices.
    const t = table.TRAVEL as unknown as { origin: string; freeMiles: number; steps: { upToMiles: number | null; cents: number }[] };
    const saved = { ...t, steps: [...t.steps] };
    Object.assign(t, { origin: "Base", freeMiles: 30, steps: [{ upToMiles: 60, cents: 1111 }, { upToMiles: 100, cents: 2222 }] });
    ok(table.travelCents(20) === 0 && table.travelCents(45) === 1111 && table.travelCents(100) === 2222 && table.travelCents(140) === null, "bands: free, a step, the last step, then quoted");
    const near = table.priceBooking({ package: size, items: [{ id: "photos" }], clientType: "agent", area: table.AREAS[0], miles: 45 });
    ok(near.lines.some((l) => l.id === "travel" && l.priced && l.cents === 1111), "bands on: a priced travel line");
    const far = table.priceBooking({ package: size, items: [{ id: "photos" }], clientType: "agent", area: table.AREAS[0], miles: 140 });
    ok(far.lines.some((l) => l.id === "travel" && !l.priced) && far.needsQuote, "past the last band: quoted, never a made-up price");
    const q = quote([size, "photos"], [], { clientType: "agent", area: table.AREAS[0], miles: 45 });
    ok(q.lineItems.some((l) => l.id === "travel" && l.cents === 1111), "the studio's quote() prices travel from the booking's miles");
    Object.assign(t, saved);
    ok(!table.travelReady(), "restored");
  }

  // ---- Optional intake fields: beds, baths, seller email, start-time notice, text opt-in -----
  {
    const table = await import("../src/lib/booking-pricing");
    const { normalizeBookingPayload } = await import("../src/lib/booking-intake");
    const base = {
      client_type: "agent",
      brokerage: "Example Realty",
      client: { name: "Sam Example", email: "agent@example.com", phone: "(555) 010-0100", company: "Example Realty" },
      property: { address: "100 Example Street, Madison, WI 53718", access: "Lockbox" },
      area: table.AREAS[0],
      time_window: table.TIME_WINDOWS[0],
      desired_date: "2026-12-01",
      agreed_to_terms: true,
      package: table.PACKAGES[0].id,
      items: [{ id: "photos" }],
    };
    const parse = (b: ReturnType<typeof table.buildBookingPayload>) => (b.ok ? normalizeBookingPayload(b.payload as never) : null);
    const p0 = parse(table.buildBookingPayload(base, "11111111-2222-4333-8444-555555555551"));
    ok(p0?.ok && p0.p.beds === null && p0.p.baths === null && p0.p.sellerEmail === null && !p0.p.timeShiftOk && !p0.p.textsOptIn && p0.p.travelMiles === null, "a form without the fields: null and false, as before");
    const p1 = parse(table.buildBookingPayload({ ...base, beds: "4", baths: 2.6, seller_email: " Seller@Example.com ", time_shift_ok: true, texts_opt_in: true }, "11111111-2222-4333-8444-555555555552"));
    ok(p1?.ok && p1.p.beds === 4 && p1.p.baths === 2.5 && p1.p.sellerEmail === "seller@example.com" && p1.p.timeShiftOk && p1.p.textsOptIn, "beds whole, baths in halves, the seller's email, both checkboxes");
    const bad = parse(table.buildBookingPayload({ ...base, beds: 99, baths: -1, seller_email: "nope" }, "11111111-2222-4333-8444-555555555553"));
    ok(bad?.ok && bad.p.beds === null && bad.p.baths === null && bad.p.sellerEmail === null, "out of range or not an email: dropped");
    ok(!/sellerEmail[\s\S]{0,80}(send|resend|emails\.)/i.test(read("src/lib/booking-intake.ts")), "the seller's email is stored, never emailed");
  }

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `All ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
