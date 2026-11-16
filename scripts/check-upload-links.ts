// Checks for upload link renewal on Upload a shoot (Nov 1 2026,
// src/components/admin/UploadWizard.tsx): every link used to come at Start and
// lasts an hour, so on a long upload (3330 Cedar Road, 43 GB) every file
// that began after the hour failed. A link older than LINK_RENEW_MS is renewed
// before its file starts, and every failed try gets a fresh one.
// Same day: one click, then walk away (files start uploading when added, the
// options sit under them, and an armed Submit goes on its own).
//
//   npx tsx scripts/check-upload-links.ts
//
// No database, no network: reads the source only.
if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
  process.exit(2);
}
export {};

let passes = 0;
let failures = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL: ${what}`);
  }
};

async function main() {
  const { readFileSync } = await import("node:fs");
  const wizard = readFileSync("src/components/admin/UploadWizard.tsx", "utf8");
  const r2 = readFileSync("src/lib/r2.ts", "utf8");

  const linkLife = Number(/export async function presignedPutUrl\([^)]*expiresIn = (\d+)\)/.exec(r2)?.[1]) * 1000;
  const m = /const LINK_RENEW_MS = (\d+) \* (\d+) \* (\d+);/.exec(wizard);
  const renew = m ? Number(m[1]) * Number(m[2]) * Number(m[3]) : NaN;
  ok(Number.isFinite(linkLife) && linkLife > 0, "upload links have a known lifetime in r2.ts");
  ok(Number.isFinite(renew), "the wizard has LINK_RENEW_MS");
  ok(renew <= linkLife - 10 * 60 * 1000, "links are renewed at least 10 minutes before they expire");

  const worker = wizard.slice(wizard.indexOf("const worker = async () => {", wizard.indexOf("const runUploads")));
  const renewAt = worker.indexOf("Date.now() - slot.at > LINK_RENEW_MS");
  const putAt = worker.indexOf("await xhrPut(slot.url");
  ok(renewAt > 0 && putAt > renewAt, "a stale link is renewed before the file starts");
  ok(/at \}\);/.test(wizard) && /const at = Date\.now\(\);/.test(wizard), "every link remembers when it was handed out");
  ok(!/status === 403/.test(worker), "a failed try renews its link whatever the error, not on a 403 only");
  ok(/slot = undefined;/.test(worker), "a failed try drops its link so the next try gets a fresh one");

  // ---- one click, then walk away (Nov 1 2026) ----
  ok(/if \(next\.some\(\(f\) => f\.state === "queued"\)\) setTimeout\(\(\) => void runUploads\(\), 0\);/.test(wizard), "adding files starts the upload");
  ok(!/Start upload/.test(wizard), "there is no Start upload button");
  ok(/if \(runningRef\.current\) return;\s*runningRef\.current = true;/.test(wizard), "one upload run at a time");
  ok(/for \(let pass = 0; ; pass\+\+\) \{\s*const wanted = filesRef\.current\.filter\(\(f\) => \(f\.state === "queued" \|\| \(pass === 0 && f\.state === "failed"\)\) && f\.file\);\s*if \(!wanted\.length\) break;/.test(wizard), "files added mid-run go up in the next pass; failed ones only in the first");
  ok(/!urls\.has\(f\.name\) && filesRef\.current\.find\(\(x\) => x\.id === f\.id\)\?\.state === "queued"\) patch\(f\.id, \{ state: "failed"/.test(wizard), "a file with no link is failed, so no pass repeats forever");
  ok(/kind: kind === "video" \? "raw_video" : "raw", files: batch/.test(wizard), "photos always go up as raws (Submit marks finished JPGs)");
  ok(/label="Skip HDR" \/>/.test(wizard), "the finished-JPGs switch is never locked");
  ok(/if \(!armed \|\| !allLanded \|\| uploading \|\| submitting \|\| autoRef\.current\.submits >= AUTO_SUBMIT_TRIES\) return;\s*autoRef\.current\.submits\+\+;\s*void submit\(\);/.test(wizard), "armed: it submits once everything has landed and the reports went out");
  ok(/autoRef\.current\.retries >= AUTO_RETRY_ROUNDS\) \{ setGaveUp\(true\); return; \}/.test(wizard), "armed: failed files are retried a few rounds, then it says so");
  ok(!/\[3, "Editing options"\]/.test(wizard) && /\[2, "Files and editing"\]/.test(wizard), "files and editing options are one step");
  const submitRoute = readFileSync("src/app/api/studio/shoots/[id]/submit/route.ts", "utf8");
  ok(/if \(options\.skipHdr\) await d\.update\(schema\.shootFiles\)\.set\(\{ kind: "display" \}\)/.test(submitRoute), "Submit turns the raws into finished JPGs when that switch is on");

  console.log(`${passes} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
