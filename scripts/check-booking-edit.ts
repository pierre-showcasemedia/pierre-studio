// Checks for Edit booking (Oct 21 2026): the invoice decision logic in
// src/lib/booking-edit.ts on sample invoice states, the change detection,
// the form parsing, the hub and payments lines, and the client emails
// (rendered to HTML files when OUT_DIR is set).
//
//   npx tsx scripts/check-booking-edit.ts            # the checks
//   OUT_DIR=/some/folder npx tsx scripts/check-booking-edit.ts   # also writes the emails there
//
// No database, no network: refuses to run with DATABASE_URL set.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is demo mode only.");
  process.exit(2);
}
process.env.NEXT_PUBLIC_SITE_URL = "https://portal.example.com";

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
  const { planInvoiceChange, lineDiff, diffEdit, editInputFromForm, needsQuoteReasons } = await import("../src/lib/booking-edit");
  const { quote, SERVICES, ADDONS, SIZES } = await import("../src/lib/studio-pricing");
  const { bookingEmailHtml, bookingEmailSubject, bookingEmailText, TIME_EMAIL_MODES } = await import("../src/lib/booking-email");
  const { buildTimeEmail, timeEmailVariant } = await import("../src/lib/booking-time-email");
  const { hubActivityText, hubChannelFor } = await import("../src/lib/hub-activity");
  const { paymentsText, MONEY_RE } = await import("../src/lib/slack");
  const { describeActivity, qaMaySee } = await import("../src/lib/activity");
  const { brand, mailDomain } = await import("../src/lib/brand");

  type Inv = Parameters<typeof planInvoiceChange>[0]["invoice"];
  type Q = ReturnType<typeof quote>;
  const inv = (over: Partial<NonNullable<Inv>> & { status: string }): NonNullable<Inv> => ({ provider: "stripe", providerId: "in_x", amountCents: 210000, lineItems: null, method: "card", meta: null, ...over });
  // The invoice plans do not depend on any buyer's price table: these quotes
  // are built by hand (fq), with sample amounts, so the logic is checked the
  // same way in every studio. "big" is the next size up.
  const PRICES: Record<string, [string, number | null, number | null]> = {
    photos: ["Photos", 60000, 75000],
    film: ["Property film", 150000, 170000],
    twilight: ["Twilight photos", 30000, 30000],
    verticals: ["Verticals", 30000, 30000],
    staging: ["Virtual staging (3 images)", null, null],
    custom: ["Something else", null, null],
  };
  const fq = (ids: string[], big = false): Q => {
    const lineItems = ids.map((id) => {
      const [name, small, large] = PRICES[id];
      const cents = big ? large : small;
      return { id, name, cents: cents ?? 0, priced: cents != null };
    });
    const unpriced = lineItems.filter((l) => !l.priced);
    return {
      tier: big ? 1 : 0, lineItems, totalCents: lineItems.reduce((n, l) => n + l.cents, 0), pending: unpriced.length > 0, inquire: false, custom: ids.includes("custom"), hasVideo: ids.includes("film"), minutes: 60,
      servicesLabel: lineItems.map((l) => l.name).join(" + "), addonsLabel: "", reasons: unpriced.map((l) => `We will confirm the price for the ${l.name.toLowerCase()}.`), items: ids.map((id) => ({ id, qty: 1 })), unknown: [],
    };
  };
  const oldQ = fq(["photos", "film"]); // 600 + 1500
  ok(oldQ.totalCents === 210000, `old quote is $2,100 (${oldQ.totalCents})`);
  const plan = (invoice: Inv, ids: string[], big = false, priceChanged = true) => planInvoiceChange({ invoice, oldQuote: oldQ, newQuote: fq(ids, big), priceChanged });

  // ---- 1. unpaid card (Stripe) ---------------------------------------------------
  let p = plan(inv({ status: "open" }), ["photos", "film", "twilight"]);
  ok(p.kind === "reissue" && p.provider === "stripe" && p.amountCents === 240000 && p.close === true && p.lines.length === 3, `unpaid stripe + twilight: reissued at $2,400, old invoice closed (${JSON.stringify(p)})`);
  p = plan(inv({ status: "open", providerId: null }), ["photos", "film", "twilight"]);
  ok(p.kind === "reissue" && p.close === false, "unpaid stripe not issued yet: updated in place, nothing to close");
  p = plan(inv({ status: "uncollectible" }), ["photos"]);
  ok(p.kind === "reissue" && p.amountCents === 60000, "uncollectible stripe: reissued at the new amount");
  // A hand-set discount moves by the difference, never resets to the price table.
  p = plan(inv({ status: "open", amountCents: 180000, meta: { quotedBy: "owner@example.com" } }), ["photos", "film", "twilight"]);
  ok(p.kind === "reissue" && p.amountCents === 210000 && p.lines.some((l) => l.id === "quote"), `hand-set $1,800 + twilight: reissued at $2,100 with a quoted line (${p.kind === "reissue" ? p.amountCents : p.kind})`);
  // A quoted item needs a human: the invoice is closed and waits for Set amount.
  p = plan(inv({ status: "open" }), ["photos", "custom"]);
  ok(p.kind === "to_quote" && p.close === true && p.reasons.some((r) => /something else/.test(r)), `unpaid stripe + a quoted item: closed, waits for a quote (${p.kind})`);
  p = plan(inv({ status: "needs_quote", providerId: null }), ["photos", "film", "twilight"]);
  ok(p.kind === "update_quote" && p.amountCents === 240000 && p.reasons.length === 0, "needs_quote stays needs_quote with its items refreshed");

  // ---- 2. pay at close (Titus) ----------------------------------------------------
  p = plan(inv({ status: "open", provider: "titus", providerId: "11111111-1111-4111-8111-111111111111", method: "pay_at_close" }), ["photos", "film", "twilight"]);
  ok(p.kind === "reissue" && p.provider === "titus" && p.close === true, "titus open: checkout canceled and a new one at the new amount");
  p = plan(inv({ status: "review", provider: "titus", providerId: "11111111-1111-4111-8111-111111111111", method: "pay_at_close" }), ["photos", "film", "twilight"]);
  ok(p.kind === "addon" && p.provider === "stripe" && p.method === "card" && p.amountCents === 30000 && p.inFlight === true && p.lines.length === 1 && p.lines[0].name === "Twilight photos", `titus review: the application is left alone, a $300 card add-on invoice for Twilight photos (${JSON.stringify(p)})`);
  p = plan(inv({ status: "processing", provider: "titus", providerId: "11111111-1111-4111-8111-111111111111", method: "pay_at_close" }), ["photos", "film", "twilight"]);
  ok(p.kind === "addon" && p.inFlight, "titus processing: same as review");

  // ---- 3. pay another way --------------------------------------------------------
  const other = inv({ status: "open", provider: null, providerId: null, method: "other" });
  p = plan(other, ["photos", "film", "twilight"]);
  ok(p.kind === "update_other" && p.amountCents === 240000, "pay another way, open: amount updated, nothing issued");
  p = plan(inv({ status: "paid_manual", provider: null, providerId: null, method: "other" }), ["photos", "film", "twilight"]);
  ok(p.kind === "addon" && p.provider === null && p.method === "other" && p.amountCents === 30000, "pay another way, paid: a provider-less $300 add-on invoice");

  // ---- 4. paid card ---------------------------------------------------------------
  const paid = inv({ status: "paid", amountCents: 210000 });
  p = plan(paid, ["photos", "film", "twilight"]);
  ok(p.kind === "addon" && p.provider === "stripe" && p.amountCents === 30000 && p.needsQuote === false && p.added.join() === "Twilight photos" && p.removed.length === 0, `paid $2,100 + twilight: a new $300 invoice with that one line (${JSON.stringify(p)})`);
  // Paid $2,000 by hand, twilight added at the shoot: a $300 invoice.
  const j = planInvoiceChange({ invoice: inv({ status: "paid", amountCents: 200000, meta: { quotedBy: "owner@example.com" } }), oldQuote: fq(["photos", "film"]), newQuote: fq(["photos", "film", "twilight"]), priceChanged: true });
  ok(j.kind === "addon" && j.amountCents === 30000, "paid $2,000 (hand-set) + twilight: still a $300 invoice, the discount is not clawed back");
  // Paid, then the size moves up: the differences are the lines.
  p = plan(paid, ["photos", "film"], true);
  ok(p.kind === "addon" && p.amountCents === 35000 && p.lines.length === 2 && p.lines.every((l) => /\(difference\)$/.test(l.name)), `paid, larger home: $350 of differences (${p.kind === "addon" ? p.lines.map((l) => `${l.name} ${l.cents}`).join("; ") : p.kind})`);
  // Paid, a quoted per-image add-on added: the add-on invoice waits for an amount.
  p = plan(paid, ["photos", "film", "staging"]);
  ok(p.kind === "addon" && p.needsQuote === true && p.lines.some((l) => !l.priced), "paid + virtual staging (quoted): an add-on invoice that waits for a quote");

  // ---- 5. paid, then items removed ---------------------------------------------
  p = plan(paid, ["photos"]);
  ok(p.kind === "refund_by_hand" && p.cents === 150000 && p.removed.join() === "Property film", `paid, film removed: refund $1,500 by hand (${JSON.stringify(p)})`);
  p = plan(paid, ["photos", "twilight"]);
  ok(p.kind === "refund_by_hand" && p.cents === 120000 && p.added.join() === "Twilight photos", "paid, film removed and twilight added: refund the net $1,200 by hand");
  const swap = planInvoiceChange({ invoice: paid, oldQuote: fq(["photos", "film", "verticals"]), newQuote: fq(["photos", "film", "twilight"]), priceChanged: true });
  ok(swap.kind === "balanced" && swap.added.join() === "Twilight photos" && swap.removed.join() === "Verticals", `paid, verticals swapped for twilight: balanced (${swap.kind})`);
  const netUp = planInvoiceChange({ invoice: paid, oldQuote: fq(["photos"]), newQuote: fq(["film"]), priceChanged: true });
  ok(netUp.kind === "addon" && netUp.amountCents === 90000 && netUp.lines.length === 1 && netUp.lines[0].id === "changes" && netUp.removed.join() === "Photos", `paid, photos swapped for the film: one $900 "changes" line (${JSON.stringify(netUp)})`);

  // ---- 6. nothing to do ------------------------------------------------------------
  p = plan(inv({ status: "open" }), ["photos", "film"], false, false);
  ok(p.kind === "none" && /stands at \$2,100/.test(p.reason), `no price change: the invoice stands (${p.kind === "none" ? p.reason : p.kind})`);
  p = plan(inv({ status: "void" }), ["photos", "film", "twilight"]);
  ok(p.kind === "none" && /void/.test(p.reason), "void invoice: left alone");
  p = plan(null, ["photos", "film", "twilight"]);
  ok(p.kind === "none", "no invoice: nothing to do");
  p = plan(paid, ["photos", "film"]);
  ok(p.kind === "none", "paid, same items at the same size: nothing owed");
  const d = lineDiff(oldQ, fq(["photos", "film", "twilight", "staging"]));
  ok(d.net === 30000 && d.unpriced.length === 1 && d.addedNames.length === 2, "lineDiff keeps the unpriced line apart from the net");
  // The real price table: an empty booking needs a human, and so does any
  // quoted line the table has.
  ok(needsQuoteReasons(quote([], [])).includes("no services chosen"), "quote reasons: nothing chosen");
  const quotedSvc = SERVICES.find((x) => x.quoted);
  if (quotedSvc) ok(needsQuoteReasons(quote([SIZES[0].id, quotedSvc.id], [])).length > 0, "quote reasons: a quoted item waits for a human");
  console.log("1. invoice plans: ok");

  // ---- 7. the diff and the form -------------------------------------------------
  // Ids from this studio's price table, so the form parses the same way for every buyer.
  const [svcA, svcB] = [SERVICES[0].id, (SERVICES[1] ?? SERVICES[0]).id];
  const addA = ADDONS[0].id;
  const counted = ADDONS.find((a) => a.counted);
  const prevBooking: Parameters<typeof diffEdit>[0] = { serviceIds: [SIZES[0].id, svcA], addonIds: [], customRequest: null, sqft: 1900, property: { street: "35 Example Avenue", status: "Vacant / Staged", listingType: "For Sale", offMarket: "No", listingAgreement: "Yes", viewHome: "Yes", views: ["Ocean"], homeownerHome: "No", videoStyle: "Medium" }, accessNotes: "Lockbox on the side gate.", launchDate: "2026-10-24", clientNotes: null };
  const prevClient = { name: "Taylor Brooks", phone: "(555) 010-0100", company: "Coast Realty" };
  const fd = new FormData();
  fd.append("size", SIZES[0].id);
  fd.append("services", svcA);
  fd.append("addons", addA);
  fd.append("sqft", "1,900");
  fd.append("pStatus", "Vacant / Staged");
  fd.append("pListingType", "For Sale");
  fd.append("pOffMarket", "No");
  fd.append("pListingAgreement", "Yes");
  fd.append("pViewHome", "");
  fd.append("views", "Ocean, Mountain");
  fd.append("pHomeownerHome", "No");
  fd.append("pVideoStyle", "Medium");
  fd.append("pMusicLink", "");
  fd.append("accessNotes", "Lockbox on the side gate. Dog in the yard.");
  fd.append("launchDate", "2026-10-24");
  fd.append("clientNotes", "  ");
  fd.append("clientName", "Taylor Brooks");
  fd.append("clientPhone", "(555) 010-0199");
  fd.append("clientCompany", "Coast Realty");
  const input = editInputFromForm(fd);
  ok(input.sqft === 1900 && input.serviceIds.join() === `${SIZES[0].id},${svcA}` && input.addonIds.join() === addA && input.property.viewHome === "Yes" && input.property.views.join() === "Ocean,Mountain" && input.clientNotes === null, `form parsing (${JSON.stringify(input)})`);
  const diff = diffEdit(prevBooking, prevClient, input);
  ok(diff.priceChanged && diff.changed.join(", ") === "add-ons, views, access notes, client phone", `changed: ${diff.changed.join(", ")}`);
  const same = diffEdit({ ...prevBooking, addonIds: [addA], property: { ...prevBooking.property, views: ["Ocean", "Mountain"] }, accessNotes: input.accessNotes }, { ...prevClient, phone: "(555) 010-0199" }, input);
  ok(same.changed.length === 0 && !same.priceChanged, "the same values again: nothing changed");
  if (counted) {
    const fq3 = new FormData();
    fq3.append("size", SIZES[0].id);
    fq3.append("services", svcB);
    fq3.append("addons", counted.id);
    fq3.append(`qty_${counted.id}`, "3");
    const withQty = editInputFromForm(fq3);
    ok(withQty.items.some((i) => i.id === counted.id && i.qty === 3), "a counted add-on keeps its quantity");
    ok(diffEdit({ ...prevBooking, serviceIds: withQty.serviceIds, addonIds: withQty.addonIds, items: withQty.items.map((i) => ({ ...i, qty: 1 })) }, prevClient, { ...withQty, property: input.property, accessNotes: prevBooking.accessNotes, launchDate: prevBooking.launchDate, clientNotes: null, customRequest: null, sqft: 1900, client: { ...prevClient } }).changed.includes("quantities"), "a new quantity is a price change");
  }
  const fd2 = new FormData();
  fd2.append("services", "nonsense");
  ok(editInputFromForm(fd2).serviceIds.length === 0, "an unknown service id is dropped");
  console.log("2. diff and form: ok");

  // ---- 8. hub, payments and activity lines ------------------------------------------
  const place = { listing: { address: "1420 Example Alder Drive, Springfield, CA", nda: false }, clientEmail: "agent@example.com" };
  const line = hubActivityText({ action: "booking.edited", actorEmail: "owner@example.com", meta: { changed: "services, access notes", bookingId: "b1" } }, place) ?? "";
  ok(line === "Booking edited: 1420 Example Alder Drive (services, access notes). By owner@example.com.", `hub line: ${line}`);
  ok(hubChannelFor({ action: "booking.edited" }) === "bookings", "booking.edited posts to the bookings channel");
  const ndaLine = hubActivityText({ action: "booking.edited", actorEmail: "owner@example.com", meta: { changed: "services" } }, { listing: { address: "35 Example Secret Lane", nda: true }, clientEmail: null }) ?? "";
  ok(ndaLine.startsWith("Booking edited: an NDA listing"), "NDA listings stay anonymous");
  ok(!MONEY_RE.test(line) && !MONEY_RE.test(describeActivity({ action: "invoice.addon_created", actorEmail: "x", meta: { items: "Twilight photos" } })), "no money in the hub or feed lines");
  const pl = { listing: { address: "1420 Example Alder Drive", nda: false }, bookingId: "b1", client: "Taylor Brooks (agent@example.com)", amount: "$300", method: "card", provider: "stripe" };
  ok(/\$300/.test(paymentsText.addonInvoice({ ...pl, by: "owner@example.com", items: "Twilight photos", paidAmount: "$2,000", needsQuote: false })), "payments channel carries the amount");
  ok(/Refund the difference by hand/.test(paymentsText.refundByHand({ ...pl, by: "owner@example.com", items: "Property film" })), "refund by hand line");
  for (const a of ["booking.edited", "invoice.addon_created", "invoice.refund_by_hand", "email.time_confirmed_sent", "email.rescheduled_sent"]) ok(!qaMaySee(a), `QA never reads ${a}`);
  ok(hubChannelFor({ action: "email.time_confirmed_sent" }) === "bookings" && hubChannelFor({ action: "email.rescheduled_sent" }) === "bookings", "time email lines go to the bookings channel");
  console.log("3. lines: ok");

  // ---- 9. the client emails ---------------------------------------------------------
  ok(timeEmailVariant({ clientRescheduled: true, wasConfirmed: true }) === "reconfirmed" && timeEmailVariant({ clientRescheduled: false, wasConfirmed: true }) === "moved" && timeEmailVariant({ clientRescheduled: false, wasConfirmed: false }) === "confirmed", "time email variants");
  const booking = {
    id: "9b2e4c1a-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
    status: "confirmed",
    desiredDate: "2026-10-28",
    startTime: "10:00",
    launchDate: "2026-10-31",
    serviceIds: [SIZES[0].id, svcA],
    addonIds: [addA],
    calendarVersion: 3,
    clientRescheduledAt: null,
    property: { street: "1420 Example Alder Drive" },
    listing: { address: "1420 Example Alder Drive, Springfield, CA 90000", slug: "1420-example-alder-drive" },
    client: { name: "Taylor Brooks", email: "agent@example.com" },
  } as unknown as Parameters<typeof buildTimeEmail>[0];
  const re = buildTimeEmail(booking, "rescheduled");
  ok(re.subject === "Your shoot has been rescheduled: 1420 Example Alder Drive" && re.ics === null && /Shoot has been rescheduled\./.test(re.text) && re.html.includes(`${brand.shortName} will confirm your new time shortly`) && /Nothing is confirmed until you hear from us/.test(re.html) && !/Total/.test(re.html) && !/shoot\.ics/.test(re.html), "rescheduled email: subject, headline, the note, no .ics, no payment row");
  const nt = buildTimeEmail(booking, "new_time_confirmed");
  ok(nt.subject === "Your new time is confirmed: 1420 Example Alder Drive" && nt.ics !== null && /SEQUENCE:2/.test(nt.ics!) && nt.ics!.includes(`UID:9b2e4c1a-5d6f-4a7b-8c9d-0e1f2a3b4c5d@${mailDomain()}`) && /Your new time is confirmed\./.test(nt.text) && nt.html.includes(SERVICES[0].name) && nt.html.includes(ADDONS[0].name) && /Where/.test(nt.html) && /pre-shoot checklist|Need to reschedule/.test(nt.html) && !/Total/.test(nt.html), "new time confirmed: subject, headline, services, add-ons, what happens next, shoot.ics with SEQUENCE = calendar_version - 1, no payment row");
  const tc = buildTimeEmail(booking, "time_confirmed");
  ok(tc.subject === "Your shoot time is confirmed: 1420 Example Alder Drive" && tc.ics !== null && /Your shoot time is confirmed\./.test(tc.text), "time confirmed email");
  const mv = buildTimeEmail(booking, "time_moved");
  ok(mv.subject === "Your shoot has moved: 1420 Example Alder Drive" && mv.ics !== null && /Your shoot has moved\./.test(mv.text) && /Confirmed\./.test(mv.html), "shoot moved email");
  const addedInput = { clientFirstName: "Taylor", street: "1420 Example Alder Drive", rest: "Springfield, CA 90000", when: "Wednesday, October 28 at 10:00 AM", launch: null, services: [], addons: [], added: ["Twilight photos"], payment: { kind: "card" as const, totalLabel: "$300", payUrl: "https://portal.example.com/portal/login" }, portalUrl: "https://portal.example.com/portal/login", updated: false, mode: "added" as const, address: "1420 Example Alder Drive, Springfield, CA 90000", event: null, checklistUrl: null };
  const addedHtml = bookingEmailHtml(addedInput);
  ok(bookingEmailSubject("1420 Example Alder Drive", false, "added") === "Your added items: 1420 Example Alder Drive" && /Added to your/.test(addedHtml) && /Twilight photos/.test(addedHtml) && /Pay invoice · \$300/.test(addedHtml) && /Due on receipt/.test(addedHtml) && !/Need to reschedule/.test(addedHtml) && !/reserves your date/.test(addedHtml), "added items email: subject, the added line, the pay button, no booking terms");
  const addedOther = bookingEmailText({ ...addedInput, payment: { kind: "other", totalLabel: "$300", detail: "check" } });
  ok(addedOther.includes(`${brand.shortName} will follow up about paying by check`) && !/Pay invoice/.test(addedOther), "added items paid another way: the amount, no button");
  // Copy rules on the words (the plain-text twin of each email, and the HTML
  // with its head and tags removed): no em dashes, no exclamation marks, no
  // vendor words, signs off the business.
  const words = (html: string) => html.replace(/<head>[\s\S]*?<\/head>/i, "").replace(/<!doctype html>/i, "").replace(/<[^>]+>/g, " ");
  for (const [name, html, text] of [["rescheduled", re.html, re.text], ["new_time_confirmed", nt.html, nt.text], ["time_confirmed", tc.html, tc.text], ["time_moved", mv.html, mv.text], ["added", addedHtml, bookingEmailText(addedInput)]] as const) {
    for (const body of [words(html), text]) ok(!/[—!]/.test(body) && !/AutoHDR|Resend|Lightroom|\bAI\b/.test(body) && body.includes(brand.name), `${name}: copy rules`);
  }
  ok(TIME_EMAIL_MODES.length === 4, "four time modes");
  console.log("4. emails: ok");

  const out = process.env.OUT_DIR;
  if (out) {
    mkdirSync(out, { recursive: true });
    const files: [string, string][] = [
      ["01-rescheduled.html", re.html],
      ["02-new-time-confirmed.html", nt.html],
      ["03-time-confirmed.html", tc.html],
      ["04-shoot-moved.html", mv.html],
      ["05-added-items.html", addedHtml],
      ["06-added-items-again.html", bookingEmailHtml({ ...addedInput, mode: "added_again" })],
    ];
    for (const [name, html] of files) writeFileSync(path.join(out, name), html);
    writeFileSync(path.join(out, "02-new-time-confirmed.ics"), nt.ics!);
    console.log(`   wrote ${files.length} emails to ${out}`);
  }

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
