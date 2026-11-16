// Checks for the Champagne twilight (Oct 27 2026, src/lib/twilight-preset.ts):
// reading the preset id out of whatever is pasted on Settings, the slider's
// range, and how a shoot's twilight look reads.
//
//   npx tsx scripts/check-twilight-preset.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
  process.exit(2);
}
export {};

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
  const { presetUuidFrom, twilightLookName, TWILIGHT_LOOK_ID } = await import("../src/lib/twilight-preset");
  const { TWILIGHT_MIN, TWILIGHT_MAX, TWILIGHT_DEFAULT_COUNT } = await import("../src/lib/autohdr-constants");
  const id = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";

  ok(presetUuidFrom(id) === id, "a bare id");
  ok(presetUuidFrom(`https://new.autohdr.com/presets/${id}`) === id, "a preset link");
  ok(presetUuidFrom(`https://new.autohdr.com/presets/${id.toUpperCase()}?tab=edit`) === id, "upper case and a query string");
  ok(presetUuidFrom(`  ${id}  `) === id, "spaces around it");
  ok(presetUuidFrom(`https://new.autohdr.com/edit?preset=${id}`) === id, "the editor's address with the preset picked");
  const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  ok(presetUuidFrom(`https://new.autohdr.com/edit/2341211?enh=${other}&preset=${id}`) === id, "the preset id, not the photo's enh id before it");
  ok(presetUuidFrom("Champagne") === null && presetUuidFrom("") === null, "no id: nothing saved");

  ok(TWILIGHT_MIN === 1 && TWILIGHT_MAX === 20, "the slider runs 1 to 20");
  ok(TWILIGHT_DEFAULT_COUNT >= TWILIGHT_MIN && TWILIGHT_DEFAULT_COUNT <= TWILIGHT_MAX, "the default sits inside it");

  ok(TWILIGHT_LOOK_ID === "champagne" && twilightLookName("champagne", []) === "Champagne", "new shoots read Champagne");
  ok(twilightLookName("ember_dusk", [{ id: "ember_dusk", name: "Ember Dusk" }]) === "Ember Dusk", "an older shoot keeps its look's name");
  ok(twilightLookName(null, []) === null, "no twilight: no name");

  console.log(`${passes} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
