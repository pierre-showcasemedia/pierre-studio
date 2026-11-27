// Checks for the navigable address on shoot calendar events (Nov 2026):
// shootAddress() fills the street-only or street-and-city listing address
// from the split city / state / zip without contradicting it, directionsUrl()
// builds the Google Maps link, and the booking's and the additional shoot's
// event bodies (src/lib/google-calendar.ts) carry the full address as
// `location` and the directions link as the first description line, which
// stays a link when the description turns HTML and reads back as a bare URL.
//
//   npx tsx scripts/check-shoot-address.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
export {};

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
const eq = (got: unknown, want: unknown, what: string) => ok(got === want, `${what} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

async function main() {
  const { shootAddress, directionsUrl, directionsLine } = await import("../src/lib/shoot-address");
  const { calendarEventBody, visitEventBody, asHtml, asText, withBlock, keptNotes, withNotes } = await import("../src/lib/google-calendar");

  // shootAddress
  const full = "3330 Example Cedar Road, Springfield, CA 90000";
  eq(shootAddress({ address: full, city: "Springfield", state: "CA", zip: "90000" }), full, "a full address is left as it is");
  eq(shootAddress({ address: full }), full, "a full address with no parts is left as it is");
  eq(shootAddress({ address: "7702 Example Birch Lane", city: "Springfield", state: "ca", zip: "90000" }), "7702 Example Birch Lane, Springfield, CA 90000", "street only: city, state and zip added");
  eq(shootAddress({ address: "7702 Example Birch Lane, Springfield", city: "Springfield", state: "CA", zip: "90000" }), "7702 Example Birch Lane, Springfield, CA 90000", "street and city: state and zip added");
  eq(shootAddress({ address: "7702 Example Birch Lane, springfield", city: "Springfield", zip: "90000" }), "7702 Example Birch Lane, springfield, 90000", "city matched without case");
  eq(shootAddress({ address: "7702 Example Birch Lane, Springfield, CA", city: "Springfield", state: "CA", zip: "90000" }), "7702 Example Birch Lane, Springfield, CA 90000", "state there, zip added after it");
  eq(shootAddress({ address: "7702 Example Birch Lane, Springfield CA", city: "Springfield", state: "CA", zip: "90000" }), "7702 Example Birch Lane, Springfield CA 90000", "city and state in one part, zip added");
  eq(shootAddress({ address: "21 E Main St, Shelbyville", city: "Springfield", state: "CA", zip: "90000" }), "21 E Main St, Shelbyville", "a renamed listing never gets another city's zip");
  eq(shootAddress({ address: "7702 Example Birch Lane, Springfield" }), "7702 Example Birch Lane, Springfield", "no parts: as typed");
  eq(shootAddress({ address: "  7702   Example Birch Lane ,  Springfield  " }), "7702 Example Birch Lane, Springfield", "spacing tidied");
  eq(shootAddress(null, { street: "35 Example Larch Avenue", city: "Springfield", state: "CA", zip: "90000" }), "35 Example Larch Avenue, Springfield, CA 90000", "no listing: the form's property fields");
  eq(shootAddress(null, null), "", "nothing to go on");
  eq(shootAddress({ address: "" }, { street: "" }), "", "blank");

  // directionsUrl / directionsLine
  eq(directionsUrl(full), "https://www.google.com/maps/dir/?api=1&destination=3330%20Example%20Cedar%20Road%2C%20Springfield%2C%20CA%2090000", "directions URL, encoded");
  eq(directionsUrl("12 Main St #4, Ojai & Co"), "https://www.google.com/maps/dir/?api=1&destination=12%20Main%20St%20%234%2C%20Ojai%20%26%20Co", "# and & encoded");
  eq(directionsUrl("  "), null, "no address, no link");
  eq(directionsLine(full), `Directions: ${directionsUrl(full)}`, "directions line");

  // The booking's event
  const booking = {
    id: "4871c7d6-035c-4208-8a4a-a162904e9e09", status: "confirmed", clientId: "c1", listingId: "l1",
    listing: { address: "7702 Example Birch Lane, Springfield", nda: false, city: "Springfield", state: "CA", zip: "90000" },
    client: { name: "Devin Wong", email: "devin@example.com", phone: "555-010-0100", company: null },
    property: {}, raw: null, serviceIds: [], addonIds: [], servicesLabel: "Photography", sqft: 2000,
    accessNotes: null, customRequest: null, clientNotes: null, launchDate: null,
    desiredDate: "2026-11-10", startTime: "09:00", startsAt: null, endsAt: null, photographerEmail: "shooter@example.com", clientRescheduledAt: null, clientRescheduledFrom: null, calendarVersion: 1,
  } as unknown as Parameters<typeof calendarEventBody>[0];
  const when = { allDay: false as const, start: new Date("2026-11-10T17:00:00Z"), end: new Date("2026-11-10T19:00:00Z") };
  const addr = "7702 Example Birch Lane, Springfield, CA 90000";
  const body = calendarEventBody(booking, when);
  eq(body.location, addr, "booking event: location is the full address");
  eq(body.description.split("\n")[0], directionsLine(addr), "booking event: directions link on top");
  ok(body.summary.startsWith("7702 Example Birch Lane - Devin Wong / "), `booking event: title unchanged (got ${JSON.stringify(body.summary)})`);
  ok(body.attendees.length === 1 && body.attendees[0].email === "shooter@example.com", "booking event: guests unchanged (the shooter only)");
  const moved = calendarEventBody({ ...booking, clientRescheduledAt: new Date(), clientRescheduledFrom: "Mon, Nov 9" } as typeof booking, when);
  ok(moved.description.split("\n\n")[0] === directionsLine(addr) && moved.description.split("\n\n")[1].startsWith("Rescheduled by the client"), "client reschedule: directions, then the notice, a blank line apart");
  ok(body.description.startsWith(`${directionsLine(addr)}\n\nServices: Photography\n\nSquare footage: 2,000 sq ft\n\nContact: `), `booking event: directions, services, square footage, contact, a blank line apart (got ${JSON.stringify(body.description)})`);
  const noAddr = calendarEventBody({ ...booking, listing: null, property: {} } as unknown as typeof booking, when);
  ok(noAddr.location === undefined && !noAddr.description.includes("Directions:"), "no address: no location, no directions line");

  // The additional shoot's event
  const visit = { id: "9b2f0c1e-1111-4222-8333-444455556666", kind: "return", note: "kitchen pickups", startsAt: new Date("2026-11-12T17:00:00Z"), endsAt: new Date("2026-11-12T18:00:00Z"), photographerEmail: null } as unknown as Parameters<typeof visitEventBody>[1];
  const vb = visitEventBody(booking, visit);
  eq(vb.location, addr, "additional shoot: location is the full address");
  eq(vb.description.split("\n")[0], directionsLine(addr), "additional shoot: directions link on top");
  ok(vb.description.split("\n\n").length === 8 && !/\n{3}/.test(vb.description), `additional shoot: one blank line between sections (got ${JSON.stringify(vb.description)})`);

  // Clickable either way: plain text keeps the bare URL; HTML gets an <a>.
  const html = asHtml(body.description);
  ok(html.startsWith(`Directions: <a href="https://www.google.com/maps/dir/?api=1&amp;destination=7702%20Example%20Birch%20Lane%2C%20Springfield%2C%20CA%2090000">`), `HTML: the directions link is an <a> (got ${JSON.stringify(html.slice(0, 160))})`);
  ok(html.includes(`Booking: <a href="`), "HTML: the booking link too");
  eq(asText(html), body.description, "HTML reads back as the same text");
  eq(asHtml("See https://example.com/a, then go."), `See <a href="https://example.com/a">https://example.com/a</a>, then go.`, "trailing punctuation stays outside the link");
  const block = "<b>Weather:</b> ☀️ 72° clear";
  const withWx = withBlock(body.description, block);
  ok(withWx.startsWith(`${block}<br><br>Directions: <a href=`), "with the forecast: directions right under it");
  // The team's notes are still told apart from Studio's lines (the directions line is never kept as a note).
  const typed = `${withWx}<br>Gate is 4321.`;
  eq(keptNotes(typed), "Gate is 4321.", "notes after the link kept, the directions line not");
  const again = withBlock(withNotes(body.description, keptNotes(typed)), block);
  eq(again.split("Directions:").length, 2, "one directions line after another upsert");
  eq(keptNotes(again), "Gate is 4321.", "the same notes come back, once");

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
