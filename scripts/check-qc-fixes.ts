// Checks for the automatic QC fix checkboxes (Nov 2 2026, src/lib/qc-fixes.ts):
// the fix key, what a re-run keeps, the done counts, the demo ticks, the
// action's gate and checks, and the activity line.
//
//   npx tsx scripts/check-qc-fixes.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
import { readFileSync } from "node:fs";
import path from "node:path";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
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
  const { qcFixKey, qcFixProgress } = await import("../src/lib/qc-labels");
  const { findFix, pruneQcFixes, qcFixesFor } = await import("../src/lib/qc-fixes");
  const { describeActivity, qaMaySee } = await import("../src/lib/activity");
  const { hubChannelFor } = await import("../src/lib/hub-activity");
  const { DEMO_SHOOTS, demoFrames } = await import("../src/lib/demo-data");
  type Issue = import("../src/db/schema").QcIssue;

  // ---- 1. the key ------------------------------------------------------------
  const blown: Issue = { type: "blown_window", severity: "fix", note: "The two windows behind the dining table are fully white." };
  ok(qcFixKey(blown) === "blown_window:the two windows behind the dining table are fully white", `key is type and normalized note (${qcFixKey(blown)})`);
  ok(qcFixKey({ ...blown, note: "  The two windows behind the  dining table are FULLY white " }) === qcFixKey(blown), "case, spacing and end punctuation do not change the key");
  const blownMinor: Issue = { ...blown, severity: "minor" };
  ok(qcFixKey(blownMinor) === qcFixKey(blown), "severity is not part of the key");
  ok(qcFixKey({ ...blown, type: "color" }) !== qcFixKey(blown), "another type is another fix");
  ok(qcFixKey({ ...blown, note: "The windows behind the dining table are blown." }) !== qcFixKey(blown), "a reworded note is a new fix");

  // ---- 2. a re-run -----------------------------------------------------------
  const dust: Issue = { type: "dust", severity: "fix", note: "Dust spot in the sky, upper left." };
  const done = { [qcFixKey(blown)]: { by: "qa@example.com", name: "Demo QA", at: "2026-11-02T17:00:00.000Z" } };
  ok(JSON.stringify(qcFixProgress([blown, dust], done)) === JSON.stringify({ done: 1, total: 2 }), "1 of 2 done");
  // The next pass finds the window again word for word, drops the dust and finds a cast.
  const rerun: Issue[] = [{ ...blown, note: blown.note + "  " }, { type: "color", severity: "minor", note: "Warm cast on the ceiling." }];
  ok(JSON.stringify(qcFixProgress(rerun, done)) === JSON.stringify({ done: 1, total: 2 }), "a flag found again keeps its tick; a new flag starts open");
  ok(JSON.stringify(qcFixProgress([dust], done)) === JSON.stringify({ done: 0, total: 1 }), "a tick on a flag the pass no longer found is not counted");
  ok(JSON.stringify(qcFixProgress([blown, blown], done)) === JSON.stringify({ done: 1, total: 1 }), "two identical flags are one fix");
  ok(JSON.stringify(qcFixProgress(null, done)) === JSON.stringify({ done: 0, total: 0 }), "no flags, nothing to count");
  ok(findFix([blown, dust], qcFixKey(dust)) === dust && findFix([blown], qcFixKey(dust)) === null && findFix(null, qcFixKey(dust)) === null, "findFix only finds a flag the frame has now");
  ok((await pruneQcFixes([{ id: "x", qcIssues: [blown] }])) === 0 && (await qcFixesFor(["x"])).size === 0, "demo mode reads and prunes nothing");
  console.log("1-2. key and re-run: ok");

  // ---- 3. demo ---------------------------------------------------------------
  const s2 = DEMO_SHOOTS.find((s) => s.id === "demo-s2")!;
  const frames = demoFrames(s2);
  const multi = frames.filter((f) => (f.qcIssues?.length ?? 0) > 1);
  ok(multi.length > 0 && multi.every((f) => qcFixProgress(f.qcIssues, f.qcFixes).done === 1), "demo: frames with two flags have the first ticked");
  ok(frames.filter((f) => (f.qcIssues?.length ?? 0) === 1).every((f) => qcFixProgress(f.qcIssues, f.qcFixes).done === 0), "demo: single flags are open");
  console.log("3. demo: ok");

  // ---- 4. the action ---------------------------------------------------------
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const act = code(readFileSync(path.join(ROOT, "src/app/admin/qc-fix-actions.ts"), "utf8"));
  const body = act.slice(act.indexOf("export async function setQcFixDone("));
  ok(/^\s*"use server"/.test(readFileSync(path.join(ROOT, "src/app/admin/qc-fix-actions.ts"), "utf8")), "the action file is a server action file");
  ok(body.indexOf("requireStaff()") > 0 && body.indexOf("requireStaff()") < body.indexOf("hasDb()"), "the action checks the staff gate first");
  ok(!/requireAdmin\(/.test(body), "the action is not admin only (the Photo QC team ticks)");
  ok(/eq\(schema\.media\.id, mediaId\), eq\(schema\.media\.shootId, shootId\)/.test(body), "the photo must be on the shoot");
  ok(body.indexOf("findFix(") > 0 && body.indexOf("findFix(") < body.indexOf("writeQcFix("), "the flag must be on the photo before anything is written");
  ok(!/revalidatePath|redirect\(/.test(body), "the action never refreshes the shoot page (the opened photo stays put)");
  const pipe = code(readFileSync(path.join(ROOT, "src/lib/pipeline.ts"), "utf8"));
  const fin = pipe.slice(pipe.indexOf("async function finishQc("));
  ok(fin.indexOf("pruneQcFixes(frames)") > 0 && fin.indexOf("pruneQcFixes(frames)") < fin.indexOf("finishToReview("), "finishing a QC pass prunes the ticks of flags it did not find");
  const ddl = readFileSync(path.join(ROOT, "src/app/api/portal/migrate/route.ts"), "utf8");
  ok(/CREATE TABLE IF NOT EXISTS "qc_fix_checks"/.test(ddl) && /ON DELETE CASCADE/.test(ddl.slice(ddl.indexOf('"qc_fix_checks"'))) && /CREATE UNIQUE INDEX IF NOT EXISTS "qc_fix_checks_media_key_idx"/.test(ddl), "the migrate route creates the table and its unique index");
  console.log("4. action: ok");

  // ---- 5. activity -----------------------------------------------------------
  const line = describeActivity({ action: "media.qc_fix", actorEmail: "qa@example.com", meta: { filename: "610-Beech-Road-08.jpg", label: "Blown window", done: true } });
  ok(line === "qa@example.com marked a QC fix done (Blown window) on 610-Beech-Road-08.jpg", `feed line: ${line}`);
  ok(/reopened a QC fix/.test(describeActivity({ action: "media.qc_fix", actorEmail: "qa@example.com", meta: { done: false } })), "untick feed line");
  ok(qaMaySee("media.qc_fix"), "the Photo QC team reads its own ticks in the feed");
  ok(hubChannelFor({ action: "media.qc_fix" }) === null, "a tick posts nothing to Slack");
  console.log("5. activity: ok");

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
