// Checks for Merge listing (Oct 30 2026, src/lib/merge-listing.ts): what is
// copied onto the target and what never is, the refusals, the notices a
// person reads before pressing Merge, which bookings get a calendar update,
// the activity line, and that the merge never queues a client email or calls
// Stripe or Titus.
//
//   npx tsx scripts/check-merge-listing.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
import { readFileSync } from "node:fs";
import path from "node:path";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is demo mode only.");
  process.exit(2);
}

const ROOT = path.resolve(__dirname, "..");
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
  const { fieldsToCopy, linksEmpty, mergeRefusals, mergeNotices, retitles, streetOf, emptyCounts, COUNT_LABELS } = await import("../src/lib/merge-listing");
  const { describeActivity } = await import("../src/lib/activity");
  type Side = Parameters<typeof mergeNotices>[0]["from"];

  const side = (over: Partial<Side>): Side => ({
    id: "00000000-0000-4000-8000-000000000001",
    slug: "x",
    address: "1 Example Lane, Springfield, CA 90000",
    street: "1 Example Lane",
    clientId: "c1",
    clientEmail: "agent@example.com",
    clientName: "Agent",
    clientTeam: null,
    downloadLocked: true,
    shootDate: null,
    nda: false,
    city: null,
    state: null,
    zip: null,
    notes: null,
    links: null,
    coverKey: null,
    dropboxFolder: null,
    ...over,
  });
  const from = side({ id: "00000000-0000-4000-8000-000000000420", slug: "2420-example-fir-rd", address: "2420 Example Fir Rd, Springfield, CA 90000", street: "2420 Example Fir Rd", city: "Springfield", state: "CA", zip: "90000", shootDate: "2026-11-14", dropboxFolder: "/Listings/2420 Example Fir Rd" });
  const into = side({ id: "00000000-0000-4000-8000-000000000320", slug: "2320-example-fir-road", address: "2320 Example Fir Road", street: "2320 Example Fir Road", shootDate: "2026-10-24", notes: "Gate code at the office", coverKey: "listings/2320/cover.jpg" });

  // ---- 1. fields: only where the target has none -------------------------------
  let f = fieldsToCopy(from, into, false);
  ok(f.map((x) => x.field).join(",") === "city,state,zip", `city, state and zip copied onto an empty target (${JSON.stringify(f)})`);
  ok(!f.some((x) => x.field === "notes"), "the target's own notes are never overwritten");
  ok(!f.some((x) => x.field === "coverKey"), "the target's cover stays");
  f = fieldsToCopy({ ...from, coverKey: "listings/2420/c.jpg", links: '[{"label":"Tour","url":"https://t.example"}]', notes: "Meet Luke on site" }, { ...into, city: "Springfield", coverKey: null, notes: "  ", links: "[]" }, true);
  ok(!f.some((x) => x.field === "city"), "a target city is kept");
  ok(f.some((x) => x.field === "notes" && x.value === "Meet Luke on site"), "blank target notes take the source's");
  ok(f.some((x) => x.field === "links"), "empty target links ([]) take the source's");
  ok(f.some((x) => x.field === "coverKey"), "the source cover comes along with its photos when the target has none");
  ok(!fieldsToCopy({ ...from, coverKey: "k" }, { ...into, coverKey: null }, false).some((x) => x.field === "coverKey"), "no cover without media moving");
  ok(linksEmpty(null) && linksEmpty("") && linksEmpty("[]") && linksEmpty("{}") && !linksEmpty('[{"url":"u"}]') && !linksEmpty("not json"), "links emptiness (odd text is never overwritten)");
  ok(fieldsToCopy(from, into, true).every((x) => ["city", "state", "zip", "notes", "links", "coverKey"].includes(x.field)), "only city, state, zip, notes, links and cover are ever copied (never shoot date, lock or NDA)");

  // ---- 2. refusals --------------------------------------------------------------
  ok(mergeRefusals({ from, into }).length === 0, "same client, both there: allowed");
  ok(mergeRefusals({ from: null, into }).length === 1 && mergeRefusals({ from, into: null }).length === 1, "a missing listing refuses");
  ok(mergeRefusals({ from, into: from }).some((r) => /itself/.test(r)), "a listing into itself refuses");
  const other = { ...into, clientId: "c2", clientEmail: "team@example.com" };
  const diff = mergeRefusals({ from, into: other });
  ok(diff.length === 1 && /different clients/.test(diff[0]) && diff[0].includes("agent@example.com") && diff[0].includes("team@example.com"), "different clients refuse and name both");
  ok(mergeRefusals({ from, into: other, allowDifferentClient: true }).length === 0, "allowDifferentClient lifts it");
  ok(mergeRefusals({ from: { ...from, nda: true }, into }).some((r) => /NDA/.test(r)), "NDA onto a non-NDA listing refuses");
  ok(mergeRefusals({ from, into: { ...into, nda: true } }).length === 0, "a non-NDA listing into an NDA one is fine");
  ok(mergeRefusals({ from, into, activeShoots: 1 }).some((r) => /editing/.test(r)), "an upload still in editing refuses");

  // ---- 3. notices ---------------------------------------------------------------
  const counts = { ...emptyCounts(), bookings: 1, invoices: 1, jobs: 9, activity: 8 };
  const b = { id: "8a6703ca-8e3a-4721-885a-5389c2d40d2f", status: "confirmed", env: "development", clientId: "c1", shooter: "owner@studio.test", calendarVersion: 2, street: "2420 Example Fir Rd", retitle: true };
  const inv = { id: "i1", status: "open", provider: "stripe", method: "card", propertyAddress: from.address, gates: true };
  const notes = mergeNotices({ from, into, counts, bookings: [b], invoices: [inv], fields: [] });
  const has = (re: RegExp) => notes.some((n) => re.test(n));
  ok(has(/retitled to 2320 Example Fir Road/) && has(/Google emails the shooter on the event \(owner@studio\.test\) an update/), "the calendar retitle and the shooter's update email are spelled out");
  ok(has(/No email goes to the client/), "says no client email goes out");
  ok(has(/When the moved invoice is paid, downloads unlock on 2320 Example Fir Road/), "an open invoice will unlock the target");
  ok(has(/Stripe invoice itself still names 2420/), "the Stripe invoice keeps the old address");
  ok(has(/shoot date stays 2026-10-24/), "the target's shoot date is kept and said");
  ok(has(/\/portal\/2420-example-fir-rd stops working/), "the old portal link");
  ok(has(/Dropbox folder \/Listings\/2420 Example Fir Rd stays/), "the old Dropbox folder");
  ok(!mergeNotices({ from, into: { ...into, downloadLocked: false }, counts, bookings: [b], invoices: [inv], fields: [] }).some((n) => /downloads unlock/.test(n)), "no unlock note when the target is already unlocked");
  ok(!mergeNotices({ from, into, counts, bookings: [b], invoices: [{ ...inv, gates: false }], fields: [] }).some((n) => /downloads unlock/.test(n)), "an add-on invoice never unlocks, so no note");
  ok(mergeNotices({ from, into, counts, bookings: [{ ...b, shooter: null }], invoices: [], fields: [] }).some((n) => /nobody is emailed/.test(n)), "no shooter: nobody is emailed");
  ok(notes.every((n) => !/—|--/.test(n)), "no em dashes or double hyphens in the notices");

  // ---- 4. which bookings get a calendar update -----------------------------------
  ok(retitles({ status: "confirmed", env: null, desiredDate: "2026-11-14" }, "production"), "a live production booking (env null) is retitled");
  ok(!retitles({ status: "canceled", env: null, desiredDate: "2026-11-14" }, "production"), "a canceled booking is not");
  ok(!retitles({ status: "confirmed", env: "preview", desiredDate: "2026-11-14" }, "production"), "another site's booking is not");
  ok(!retitles({ status: "requested", env: null, desiredDate: null }, "production"), "a booking with no date is not");
  ok(streetOf("2320 Example Fir Road, Springfield, CA 90000") === "2320 Example Fir Road" && streetOf("2320 Example Fir Road") === "2320 Example Fir Road", "street from an address");

  // ---- 5. every listing reference in the migrations is covered -------------------
  const ddl = readFileSync(path.join(ROOT, "src/app/api/portal/migrate/route.ts"), "utf8");
  const tablesWithListing = new Set<string>();
  for (const m of ddl.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)" \(([\s\S]*?)\)`/g)) if (/"listing_id"/.test(m[2])) tablesWithListing.add(m[1]);
  for (const m of ddl.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN IF NOT EXISTS "listing_id"/g)) tablesWithListing.add(m[1]);
  const covered = new Set(Object.values(COUNT_LABELS).map((c) => c.table.split(" ")[0]));
  for (const t of tablesWithListing) ok(covered.has(t), `${t}.listing_id is moved by the merge`);
  ok(tablesWithListing.size >= 13, `found the listing_id tables in the migrations (${[...tablesWithListing].join(", ")})`);
  const lib = readFileSync(path.join(ROOT, "src/lib/merge-listing.ts"), "utf8");
  const code = lib.replace(/\/\/.*$/gm, "");
  for (const t of tablesWithListing) {
    const camel = t.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    ok(new RegExp(`update\\(schema\\.${camel}\\)`).test(code), `the apply batch updates schema.${camel}`);
  }

  // ---- 6. never a client email, never Stripe or Titus ---------------------------
  const imports = (lib.match(/^import .*$/gm) ?? []).join("\n");
  const applyCode = lib.slice(lib.indexOf("// ---- apply")).replace(/\/\/.*$/gm, "");
  ok(lib.indexOf("// ---- apply") > 0 && applyCode.length > 2000, "found the apply section");
  ok(!/email|stripe|titus|resend|slack/i.test(imports), `the merge imports no email, Slack, Stripe or Titus code (${imports.replace(/\n/g, " | ")})`);
  ok(!/"email\.|"slack\.|"stripe\.|"titus\.|"payments\./.test(applyCode), "the apply queues no email, Slack line, Stripe or Titus job");
  ok(!/\braw\s*:/.test(applyCode), "bookings.raw (the form as sent) is never written");
  ok(!/shootDate\s*:|downloadLocked\s*:|\bnda\s*:|approvedAt\s*:|deliveryEmailAt\s*:/.test(applyCode), "the apply never writes the target's shoot date, lock, NDA flag, approval or delivery state");
  ok(/eq\(schema\.bookings\.calendarVersion, b\.calendarVersion\)/.test(code), "each booking moves only at the calendar version the plan read");
  ok(/d\.batch\(/.test(code) && (code.match(/await d\.(update|insert|delete)\(/g) ?? []).length === 0, "every write goes through the one batch (no write awaited on its own)");

  // ---- 7. the activity line -------------------------------------------------------
  const line = describeActivity({ action: "listing.merged", actorEmail: "owner@studio.test", meta: { from: { address: from.address, slug: from.slug }, counts: { ...counts, media: 0 } } });
  ok(line === "owner@studio.test merged 2420 Example Fir Rd into this listing (1 booking, 1 invoice)", `activity line (${line})`);

  console.log(`check-merge-listing: ${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
