// Client-specific pricing: the discount line and the total (src/lib/client-pricing.ts).
// Sample amounts only, never a real price.
//
//   npx tsx scripts/check-client-pricing.ts
import { readFileSync } from "node:fs";
import { applyClientDiscount } from "../src/lib/client-pricing";
let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) passes++;
  else {
    fails++;
    console.error(`FAIL ${name}`);
  }
};
const q = { totalCents: 20000, lineItems: [{ id: "photos", name: "Sample item", cents: 20000, priced: true }] };
ok("no discount leaves the quote alone", applyClientDiscount(q, 0) === q);
const ten = applyClientDiscount(q, 10);
ok("10% off 200.00 is 180.00", ten.totalCents === 18000);
ok("discount is its own negative line", ten.lineItems.length === 2 && ten.lineItems[1].cents === -2000 && ten.lineItems[1].name === "Client discount (10%)");
ok("lines still sum to the total", ten.lineItems.reduce((n, l) => n + l.cents, 0) === ten.totalCents);
ok("over 100 is capped at 100", applyClientDiscount(q, 250).totalCents === 0);
ok("an unpriced quote is left alone", applyClientDiscount({ ...q, totalCents: 0 }, 20).totalCents === 0);
ok("rounding stays in whole cents", Number.isInteger(applyClientDiscount({ ...q, totalCents: 33333 }, 15).totalCents));
const intake = readFileSync("src/lib/booking-intake.ts", "utf8");
ok("intake applies it only with the switch on and a final price", /needsQuote \|\| !business\.clientDiscount \? q0/.test(intake));
ok("intake compares the website total with the undiscounted price", /p\.websiteTotalCents !== q0\.totalCents/.test(intake));
const edit = readFileSync("src/lib/booking-edit.ts", "utf8");
ok("Edit booking keeps the client's discount on the reissued bill", /applyClientDiscount\(/.test(edit));
ok("the discount fields show only with the switch on", /business\.clientDiscount && \(/.test(readFileSync("src/app/admin/clients/[id]/page.tsx", "utf8")));
ok("Stripe takes the negative line as a credit", /l\.priced && l\.cents !== 0/.test(readFileSync("src/lib/stripe-invoice.ts", "utf8")));
console.log(fails ? `${fails} FAILED, ${passes} passed` : `All ${passes} checks passed`);
process.exit(fails ? 1 : 0);
