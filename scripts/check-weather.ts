// Checks for the weather on booking calendar events (Oct 26 2026): the badge,
// color and the one weather line (Oct 31 2026) from a sample forecast
// (src/lib/weather.ts), sunset / golden hour / dusk for Springfield, the
// title and description edits Studio makes on an event
// (src/lib/google-calendar.ts): badge after the reschedule tag, block replaced
// not stacked, hand-picked colors left alone; and the short event text with
// the team's notes kept and the client file blocks dropped (Oct 31 2026).
//
//   npx tsx scripts/check-weather.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
import { BUSINESS_TZ } from "../src/lib/business";
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
  const { describeWeather, eveningSunAt, hourEmoji, sunTimes, WEATHER_BLOCK_RE } = await import("../src/lib/weather");
  const { withBadge, withBlock, weatherOn, handColor, carriedNotes, cleanNotes, keptNotes, withNotes, calendarEventBody, asHtml, asText } = await import("../src/lib/google-calendar");
  type Hour = Parameters<typeof describeWeather>[0][number];

  // The sun math is checked at a fixed point with published times, in that
  // point's own zone (Pacific); what the studio writes on the calendar is in
  // the business's zone (BUSINESS_TZ), checked against the same instants.
  const pt = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(d);
  const bizTime = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", minute: "2-digit" }).format(d).replace(/\u202f/g, " ");
  const bizHour = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "numeric" }).format(d).replace(/\s|\u202f/g, "").toLowerCase();

  // Sun: Springfield, Tue Oct 27 2026. Published: sunset 6:10 PM PDT, civil dusk 6:36 PM.
  const sb = { lat: 34.4208, lon: -119.6982 };
  const sunset = eveningSunAt(sb.lat, sb.lon, "2026-10-27", 90.833)!;
  const mins = (d: Date) => Number(pt(d).split(":")[0]) * 60 + Number(pt(d).split(":")[1].slice(0, 2));
  ok(Math.abs(mins(sunset) - (6 * 60 + 10)) <= 2, `SB sunset Oct 27 near 6:10 PM (got ${pt(sunset)})`);
  const sun = sunTimes(sb.lat, sb.lon, "2026-10-27");
  ok(sun.goldenFrom! < sun.sunset! && sun.sunset! < sun.dusk!, "golden hour, sunset, dusk in order");
  ok((sun.sunset!.getTime() - sun.goldenFrom!.getTime()) / 60_000 > 25 && (sun.sunset!.getTime() - sun.goldenFrom!.getTime()) / 60_000 < 50, "golden hour starts 25 to 50 min before sunset");
  ok(Math.abs(mins(sun.dusk!) - (6 * 60 + 36)) <= 2, `SB dusk Oct 27 near 6:36 PM (got ${pt(sun.dusk!)})`);
  // Winter time: published Dec 15 sunset 4:50 PM PST.
  const dec = eveningSunAt(sb.lat, sb.lon, "2026-12-15", 90.833)!;
  ok(Math.abs(mins(dec) - (4 * 60 + 50)) <= 2, `SB sunset Dec 15 near 4:50 PM (got ${pt(dec)})`);

  // Emoji
  ok(hourEmoji({ text: "Sunny", pop: 0, isDaytime: true, sky: 5 }) === "☀️", "sunny");
  ok(hourEmoji({ text: "Partly Cloudy", pop: 0, isDaytime: true, sky: 45 }) === "⛅", "partly cloudy");
  ok(hourEmoji({ text: "Chance Light Rain", pop: 30, isDaytime: true, sky: 90 }) === "🌦️", "chance of rain");
  ok(hourEmoji({ text: "Rain Showers Likely", pop: 70, isDaytime: true, sky: 95 }) === "🌧️", "rain likely");
  ok(hourEmoji({ text: "Mostly Clear", pop: 0, isDaytime: false, sky: 10 }) === "🌙", "clear night");

  // A sample afternoon: 2 to 7 PM, Oct 27, hours 1 PM to 9 PM.
  const hour = (h: number, o: Partial<Hour>): Hour => {
    const start = new Date(Date.UTC(2026, 9, 27, h + 7));
    return { start, end: new Date(start.getTime() + 3600_000), isDaytime: h < 18, tempF: 70 - (h - 13), pop: 0, windMph: 8, sky: 20, text: "Mostly Sunny", ...o };
  };
  const shoot = { day: "2026-10-27", start: new Date("2026-10-27T21:00:00Z"), end: new Date("2026-10-28T02:00:00Z") };
  const clear = [13, 14, 15, 16, 17, 18, 19, 20, 21].map((h) => hour(h, {}));
  const now = new Date("2026-10-26T13:00:00Z");
  const c = describeWeather(clear, shoot, sun, now)!;
  ok(c.badge === "🌤️ 69°", `clear badge (got "${c.badge}")`);
  ok(c.color === null, "clear: no color");
  ok(c.block.startsWith("<b>Weather:</b> 🌤️ "), `block starts with the bold head (got "${c.block.slice(0, 30)}")`);
  ok(c.block.match(WEATHER_BLOCK_RE)?.[0] === c.block, "block matches its own pattern end to end");
  ok(!c.block.includes("<br>"), "one line, no table");
  ok(/^<b>Weather:<\/b> 🌤️ Mostly sunny, 65 to 69°\. No rain\. Clear at sunset, good for twilight\. Sunset \d+:\d\d (AM|PM)\. <i>\(forecast \w{3} \d+:\d\d (AM|PM)\)<\/i>$/.test(c.block) && c.block.includes(`Sunset ${bizTime(sun.sunset!)}.`), `line, sunset in the business time zone (got "${c.block}")`);
  ok(!/  /.test(c.block), "no ASCII double spaces (HTML would collapse them)");

  const wet = clear.map((h, i) => (i >= 3 ? { ...h, pop: 70, text: "Rain Showers Likely", sky: 95 } : h));
  const w = describeWeather(wet, shoot, sun, now)!;
  ok(w.color === "11", "rain: Tomato");
  ok(w.badge === "🌧️ 69° 70%", `rain badge (got "${w.badge}")`);
  ok(w.block.includes("Rain likely (70%).") && w.block.includes("Rain possible at sunset."), `rain summary (got "${w.block}")`);
  const grey = clear.map((h) => ({ ...h, sky: 90, text: "Mostly Cloudy" }));
  const g = describeWeather(grey, shoot, sun, now)!;
  ok(g.color === "5", "heavy overcast: Banana");
  ok(g.block.includes("Mostly cloudy, 65 to 69°.") && g.block.includes("Heavy cloud, views may be flat.") && g.block.includes("Cloudy at sunset, flat twilight likely."), `overcast line (got "${g.block}")`);
  const chance = clear.map((h, i) => (i === 2 ? { ...h, pop: 25, text: "Slight Chance Light Rain" } : h));
  ok(describeWeather(chance, shoot, sun, now)!.color === "5", "25% chance: Banana");
  ok(describeWeather(clear, { day: "2026-11-09", start: new Date("2026-11-09T18:00:00Z"), end: new Date("2026-11-09T20:00:00Z") }, sun, now) === null, "beyond the forecast: nothing");
  // A foggy morning, 7 AM to 12:30 PM.
  const am = [6, 7, 8, 9, 10, 11, 12, 13].map((h) => hour(h - 7, { start: new Date(Date.UTC(2026, 9, 28, h + 7)), end: new Date(Date.UTC(2026, 9, 28, h + 8)), isDaytime: true, text: h < 11 ? "Patchy Fog" : "Partly Sunny", sky: h < 11 ? 90 : 55 }));
  const fog = describeWeather(am, { day: "2026-10-28", start: new Date("2026-10-28T14:00:00Z"), end: new Date("2026-10-28T19:30:00Z") }, sun, now)!;
  ok(fog.block.includes("Patchy fog, ") && fog.block.includes(`Fog early, clearing by ${bizHour(new Date(Date.UTC(2026, 9, 28, 11 + 7)))}.`), `fog summary (got "${fog.block}")`);
  // Title
  const title = "7702 Example Birch Lane - Devin Wong / photos + video";
  ok(withBadge(title, "⛅ 66°") === `⛅ 66° ${title}`, "badge in front");
  ok(withBadge(`⛅ 66° ${title}`, "🌧️ 61° 70%", "⛅ 66°") === `🌧️ 61° 70% ${title}`, "badge replaced, not stacked");
  ok(withBadge(`[RESCHEDULED - UNCONFIRMED] ${title}`, "☀️ 72°") === `[RESCHEDULED - UNCONFIRMED] ☀️ 72° ${title}`, "badge after the reschedule tag");
  ok(withBadge(`☀️ 72° ${title}`, null, "☀️ 72°") === title, "badge removed");

  // Description
  const rest = "7702 Example Birch Lane, Springfield\nServices: photos & video\n\nCLIENT NOTES: Devin";
  const restHtml = "7702 Example Birch Lane, Springfield<br>Services: photos &amp; video<br><br>CLIENT NOTES: Devin";
  ok(asHtml(rest) === restHtml, "plain text becomes HTML lines, escaped");
  ok(asText(restHtml) === rest, "and back");
  const d1 = withBlock(rest, c.block);
  ok(d1 === `${c.block}<br><br>${restHtml}`, "block on top, the rest kept as HTML");
  const d2 = withBlock(d1, w.block);
  ok(d2 === `${w.block}<br><br>${restHtml}` && d2.split("Weather:").length === 2, "block replaced, not stacked");
  const html = "<b>Services</b>: photos<br>CLIENT NOTES: Devin\nline two";
  const d3 = withBlock(withBlock(html, c.block), w.block);
  ok(d3 === `${w.block}<br><br><b>Services</b>: photos<br>CLIENT NOTES: Devin<br>line two`, "hand-edited HTML kept, its newlines made breaks");
  ok(withBlock(d1, null) === restHtml, "block removed, the rest stays HTML");
  ok(withBlock(rest, null) === rest, "plain description with no block left alone");
  // The first format (plain text, Oct 26) is replaced by the new one, nothing left over.
  const old = "WEATHER AT THIS ADDRESS\nSunny, no rain expected.\n\n3 PM   ☀️ 77°  rain 0%\n\nUpdated Mon, Oct 26, 3:32 PM from the National Weather Service. Refreshes every 3 hours.\n\nClient: Janet\nCLIENT NOTES: Cristal";
  const up = withBlock(old, c.block);
  // And the table (Oct 26 to 31 2026) the same way.
  const table = "<b>Weather at this address</b><br>Sunny.<br><br>TIME TEMP<br> 1pm ☀️ 71°<br><br><i>📸 your shoot · wind in mph · Updated Sat 2:01 PM · National Weather Service</i><br><br>Client: Janet";
  ok(withBlock(table, c.block) === `${c.block}<br><br>Client: Janet`, "the table replaced by the one line");
  ok(up === `${c.block}<br><br>Client: Janet<br>CLIENT NOTES: Cristal`, `old format replaced (got ${JSON.stringify(up.slice(c.block.length, c.block.length + 60))})`);

  // Carry across an upsert
  const ev = { id: "studio1", summary: `🌧️ 61° 70% ${title}`, description: d2, colorId: "11", extendedProperties: { private: { studioBookingId: "b1", studioWeatherDay: "2026-10-27", studioWeatherBadge: "🌧️ 61° 70%", studioWeatherColor: "11" } } };
  const carried = weatherOn(ev, "2026-10-27");
  ok(carried?.badge === "🌧️ 61° 70%" && carried.color === "11" && carried.block === w.block, "weather carried for the same day");
  ok(weatherOn(ev, "2026-10-28") === null, "a new day drops the old weather");
  ok(weatherOn({ ...ev, description: old }, "2026-10-27") === null, "the old plain format is not carried");
  ok(handColor(ev) === null, "Studio's own color is not a hand color");
  ok(handColor({ ...ev, colorId: "2" }) === "2", "a color someone picked is kept");

  // A hand-made event merged into a booking's event never carries its old forecast along.
  const handMade = { id: "x1", description: withBlock("Gate code by text.\nPark on the street.", c.block) };
  ok(carriedNotes(handMade) === "Gate code by text.\nPark on the street.", "merged notes leave the forecast behind");
  // Nor the client file block or the old automation's copy of the form.
  const brainBlock = "CLIENT NOTES: Riley\nExample Homes · regular client\nBEFORE THIS SHOOT:\n- Confirm the package.\nPEOPLE: Riley (555) 010-0177\nFull note: brain, Clients/Riley.md";
  const handMade2 = { id: "x2", description: asHtml(`CASEY WILL MEET YOU 6:15am\nAuto-created from booking form, time TBD.\nCLIENT: Riley · Example Homes\nPHONE: 5550100177\nSERVICES: Photography $1,500;\nSQFT: 5600 · ACCESS: Morgan will meet you.\nNOTE: Texts 9/30, Oct 27 agreed.\n\n${brainBlock}`) };
  ok(carriedNotes(handMade2) === "CASEY WILL MEET YOU 6:15am\nAccess: Morgan will meet you.", `hand-made notes trimmed (got ${JSON.stringify(carriedNotes(handMade2))})`);

  // Shoot notes the team typed inside a client file block stay; the block's own lines go.
  const olesya = "Admin: https://portal.example.com/admin/bookings/5b5a2669-055d-44f4-89bd-0c823e354dce\n\nCLIENT NOTES: Robin Example\nExample Realty · top client · bookings run by the coordinator\nCALL NOTES (the coordinator with Robin, Oct 19 to 20 2026, Quo line):\n- Drone is NOT on the confirmed list.\n- Check the marine layer before driving.\nBEFORE THIS SHOOT:\n- Fire in every fireplace, always.\nPEOPLE: Robin Example (555) 010-0199\nACCESS: she or her assistant lets us in.\nFull note: brain, Clients/Robin Example.md";
  ok(keptNotes(asHtml(olesya)) === "CALL NOTES (the coordinator with Robin, Oct 19 to 20 2026, Quo line):\n- Drone is NOT on the confirmed list.\n- Check the marine layer before driving.", `call notes inside the block kept (got ${JSON.stringify(keptNotes(asHtml(olesya)))})`);
  const studioBlock = "CLIENT NOTES: Dana Example\nBEFORE EVERY SHOOT:\n- Weather decides the shoot.\nACCESS AND ON SITE:\n- She usually meets the shooter.\nTEAM NOTES: prefers texts\nFull note: brain, Clients/Dana Example.md";
  ok(keptNotes(`Admin: https://portal.example.com/admin/bookings/87646770-9817-44d9-b442-d214a66fec82\n\n${studioBlock}`) === "", "Studio's own client block leaves nothing");
  ok(cleanNotes(`${studioBlock}\nBring the drone.`) === "Bring the drone.", "a line typed after the block is kept");

  // The short event text (Oct 31 2026).
  const booking = {
    id: "4871c7d6-035c-4208-8a4a-a162904e9e09", status: "confirmed", clientId: "c1", listingId: "l1",
    listing: { address: "3330 Example Cedar Road, Springfield, CA 90000", nda: false },
    client: { name: "Riley Example", email: "riley@example.com", phone: "555-010-0177", company: "Example Homes" },
    property: { homeownerHome: "No", videoStyle: "Medium", status: "For Sale" },
    raw: null, serviceIds: [], addonIds: [], servicesLabel: "Photography + Basic property video", sqft: 3112,
    accessNotes: "Meet on site: Casey 555-010-0188", customRequest: "Possible virtual staging for two rooms", clientNotes: "Possibly 2 images, TBD", launchDate: "2026-11-03",
    desiredDate: "2026-11-01", startTime: "09:00", startsAt: null, endsAt: null, photographerEmail: null, clientRescheduledAt: null, clientRescheduledFrom: null, calendarVersion: 1,
  } as unknown as Parameters<typeof calendarEventBody>[0];
  const when = { allDay: false as const, start: new Date("2026-11-01T17:00:00Z"), end: new Date("2026-11-01T21:45:00Z") };
  const body = calendarEventBody(booking, when);
  const url = "/admin/bookings/4871c7d6-035c-4208-8a4a-a162904e9e09";
  const want = ["Directions: https://www.google.com/maps/dir/?api=1&destination=3330%20Example%20Cedar%20Road%2C%20Springfield%2C%20CA%2090000", "Services: Photography, Basic property video", "Square footage: 3,112 sq ft", "Access: Meet on site: Casey 555-010-0188.", "Requests: Possible virtual staging for two rooms. Possibly 2 images, TBD. Video style: Medium.", "Contact: Riley Example, 555-010-0177", ""];
  // One blank line between sections (Nov 4 2026), never two, none at the end.
  ok(body.description.startsWith(want.join("\n\n")) && body.description.endsWith(url) && body.description.split("\n\n").length === 7 && !/\n{3}/.test(body.description), `short description (got ${JSON.stringify(body.description)})`);
  ok(!/Email|Launch|Property|Example Homes/.test(body.description), "no email, launch, company or property line");
  ok(!calendarEventBody({ ...booking, sqft: null } as typeof booking, when).description.includes("Square footage"), "no square footage on the form: no line");
  // Notes the team typed stay; the old client file block and Studio's old lines do not.
  const before = `${c.block}<br><br>Client: Riley<br>Email: riley@example.com<br>Services: Photography<br><br>Admin: https://portal.example.com${url}<br><br>${asHtml(brainBlock)}<br>Bring the long lens.`;
  ok(keptNotes(before) === "Bring the long lens.", `old layout: typed note kept (got ${JSON.stringify(keptNotes(before))})`);
  const next = withNotes(body.description, keptNotes(before));
  ok(next.includes("\n\nNotes:\nBring the long lens.\n\nBooking: ") && next.endsWith(url), `notes above the link (got ${JSON.stringify(next)})`);
  const after = withBlock(next, c.block);
  ok(keptNotes(after) === "Bring the long lens.", "new layout: the same notes come back, once");
  ok(keptNotes(`${after}<br>Gate is 4321.`) === "Bring the long lens.\n\nGate is 4321.", "a line typed after the link is kept too");
  ok(withNotes(body.description, "") === body.description, "no notes, no Notes line");
  ok(next.includes("\n\nContact: Riley Example, 555-010-0177\n\nNotes:\n") && !/\n{3}/.test(next), `one blank line above Notes, not two (got ${JSON.stringify(next)})`);
  const bare = calendarEventBody({ ...booking, accessNotes: null, customRequest: null, clientNotes: null, property: {} } as unknown as typeof booking, when).description;
  ok(bare.includes("\n\nContact:") && !bare.includes("Access:") && !bare.includes("Requests:") && !/\n{3}/.test(bare), `empty sections leave no gap (got ${JSON.stringify(bare)})`);
  const longReq = calendarEventBody({ ...booking, customRequest: "word ".repeat(80) } as typeof booking, when).description.split("\n").find((l) => l.startsWith("Requests:"))!;
  ok(longReq.length <= 232 && longReq.endsWith("…"), `long requests clipped to two lines (got ${longReq.length})`);

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
