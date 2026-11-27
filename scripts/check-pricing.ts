// Checks that the studio prices every booking the way the website does. No
// database, no network.
//
//   npx tsx scripts/check-pricing.ts
//   SITE_DIR=../pierre-site npx tsx scripts/check-pricing.ts   # also compares the website's file
//
// 1. src/lib/booking-pricing.ts is the website's src/lib/pricing.ts, byte for
//    byte (when SITE_DIR is set, or a sibling ../<name>-site / ../dwy-<name>-site
//    exists): same text, so the same PRICING_HASH.
// 2. A battery of bookings, built with the price file's own website payload
//    builder (buildBookingPayload), goes through the studio's intake parser
//    (normalizeBookingPayload) and quote(): same total, same quoted flag, the
//    quantities kept, the size first in service_ids.
// 3. No the business-era ids or names are left on the studio side.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
  const table = await import("../src/lib/booking-pricing");
  const { quote, SIZES, SERVICES, ADDONS, PRICING_HASH } = await import("../src/lib/studio-pricing");
  const { normalizeBookingPayload } = await import("../src/lib/booking-intake");

  // ---- 1. the same file as the website ----------------------------------------
  const here = readFileSync("src/lib/booking-pricing.ts", "utf8");
  ok(here.includes("==== BEGIN SHARED PRICE TABLE ====") && here.includes("==== END SHARED PRICE TABLE ===="), "the file has the shared block markers");
  const name = path.basename(process.cwd()).replace(/-studio$/, "");
  const candidates = [process.env.SITE_DIR, `../${name}-site`, `../dwy-${name}-site`].filter((d): d is string => Boolean(d));
  const site = candidates.map((d) => path.join(d, "src/lib/pricing.ts")).find((f) => existsSync(f));
  if (site) {
    ok(readFileSync(site, "utf8") === here, `src/lib/booking-pricing.ts is identical to ${site}`);
    console.log(`1. compared with ${site}`);
  } else {
    console.log("1. no website checkout next to this one (set SITE_DIR to compare the files)");
  }
  ok(PRICING_HASH === table.PRICING_HASH && /^[0-9a-f]{8}$/.test(PRICING_HASH), "one PRICING_HASH");

  // ---- 2. the website's payload through the studio's intake ------------------------
  const base = {
    client_type: "agent",
    client: { name: "Sam Example", email: "agent@example.com", phone: "(555) 010-0100", company: "Example Realty" },
    property: { address: "100 Example Street, Your City, ST 00000", access: "Lockbox" },
    area: table.AREAS[0],
    time_window: table.TIME_WINDOWS[0],
    desired_date: "2026-12-01",
    agreed_to_terms: true,
  };
  const counted = table.ITEMS.find((i) => i.price.kind === "each" || (i.price.kind === "quote" && "unit" in i.price && i.price.unit));
  const cases: { label: string; body: Record<string, unknown> }[] = [];
  for (const pkg of table.PACKAGES) {
    for (const svc of table.ITEMS.filter((i) => i.role === "service")) {
      cases.push({ label: `${pkg.name} + ${svc.name}`, body: { ...base, package: pkg.id, items: [{ id: svc.id }] } });
    }
    const svc = table.ITEMS.find((i) => i.role === "service");
    const addons = table.ITEMS.filter((i) => i.role === "addon").slice(0, 3);
    if (svc) cases.push({ label: `${pkg.name} + ${svc.name} + add-ons`, body: { ...base, package: pkg.id, items: [{ id: svc.id }, ...addons.map((a) => ({ id: a.id, qty: a === counted ? 3 : 1 }))] } });
  }
  const outside = table.AREAS.find((a) => table.isOutsideArea(a));
  if (outside && table.PACKAGES[0]) cases.push({ label: "outside the home area", body: { ...base, area: outside, package: table.PACKAGES[0].id, items: [{ id: table.ITEMS[0].id }] } });
  cases.push({ label: "a builder", body: { ...base, client_type: "builder", package: table.PACKAGES[0]?.id, items: [{ id: table.ITEMS[0].id }] } });

  let n = 0;
  for (const c of cases) {
    const built = table.buildBookingPayload(c.body, `test-${n++}`);
    if (!built.ok) {
      ok(false, `${c.label}: the website refused it (${built.error})`);
      continue;
    }
    const pl = built.payload as Record<string, unknown>;
    const norm = normalizeBookingPayload(pl);
    if (!norm.ok) {
      ok(false, `${c.label}: the studio refused it (${norm.error})`);
      continue;
    }
    const p = norm.p;
    const q = quote(p.serviceIds, p.addonIds, { items: p.items, clientType: p.clientType, area: p.market });
    ok(p.unknownItems.length === 0, `${c.label}: every item known (${p.unknownItems.join(", ")})`);
    ok(q.totalCents === pl.total_cents, `${c.label}: studio total ${q.totalCents} = website ${String(pl.total_cents)}`);
    ok((q.reasons.length > 0) === pl.needs_quote, `${c.label}: quoted on both sides (${q.reasons.join(" | ")})`);
    ok(pl.package == null || p.serviceIds[0] === pl.package, `${c.label}: the size comes first in service_ids`);
    ok(p.market === pl.service_area, `${c.label}: the area is kept`);
    ok(p.pricingHash === PRICING_HASH, `${c.label}: the website sent this table's hash`);
    if (counted && (pl.items as { id: string; qty: number }[]).some((i) => i.id === counted.id && i.qty === 3)) {
      ok(q.items.some((i) => i.id === counted.id && i.qty === 3), `${c.label}: the quantity is kept`);
    }
  }
  console.log(`2. ${cases.length} bookings priced the same on both sides`);

  // ---- 3. studio-side lists and leftovers ------------------------------------------
  ok(SIZES.length === table.PACKAGES.length && SERVICES.length + ADDONS.length === table.ITEMS.length, "every size and item is in the studio's lists");
  const studioSrc = ["src/lib/studio-pricing.ts", "src/lib/booking-intake.ts", "src/lib/booking-edit.ts", "src/lib/video-board.ts", "src/components/admin/EditBookingPanel.tsx"].map((f) => readFileSync(f, "utf8")).join("\n");
  ok(!/"(photography|tw_photo|vstaging|basicvideo|somethingelse)"/.test(studioSrc), "no old price-list ids in the studio code");
  ok(!/8,000 sq ft/.test(studioSrc), "no old size rule in the studio code");
  console.log("3. leftovers: ok");

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
