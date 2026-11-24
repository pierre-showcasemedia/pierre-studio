// Upsell prompts: days on market and suggestions (src/lib/upsell.ts).
import { daysOnMarket, inWindow, suggestions } from "../src/lib/upsell";
import { itemDef } from "../src/lib/booking-pricing";
let fails = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const now = Date.parse("2026-11-18T12:00:00Z");
ok("launch date wins", daysOnMarket({ launchDate: "2026-10-01", deliveryEmailAt: new Date("2026-11-01T00:00:00Z"), shootDate: null }, now) === 48);
ok("delivery email next", daysOnMarket({ launchDate: null, deliveryEmailAt: new Date("2026-10-04T12:00:00Z"), shootDate: null }, now) === 45);
ok("nothing to count from", daysOnMarket({ launchDate: null, deliveryEmailAt: null, shootDate: null }, now) === null);
ok("45 and 60 are inside", inWindow(45) && inWindow(60));
ok("44 and 61 are outside", !inWindow(44) && !inWindow(61));
// The buyer's own list (business.upsell.itemIds; empty in the template).
const all = suggestions(new Set());
const had = all[0]?.id;
const s = suggestions(new Set(had ? [had] : []));
ok("something already on the listing is not suggested again", !had || !s.some((i) => i.id === had));
ok("every suggestion is on the price table, with its name from there", all.every((i) => itemDef(i.id) && i.name === itemDef(i.id)!.name));
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
