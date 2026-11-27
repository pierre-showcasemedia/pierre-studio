// Checks for the editors' photo flow (Nov 3 2026): QC never
// rejects or hides a photo, the editors' re-uploads sit in a Revised section
// and go through Run QC again, Approve all leaves block-flagged photos for a
// person, Send for final review warns about open flags and posts to the PMs'
// review channel (hub when unset), once, and publishing is unchanged.
//
//   npx tsx scripts/check-qc-flow.ts
//
// No database, no network (fetch is stubbed): refuses to run with DATABASE_URL set.
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
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const fn = (src: string, start: string) => {
  const i = src.indexOf(start);
  if (i < 0) return "";
  const next = src.indexOf("\nexport ", i + start.length);
  const nextFn = src.indexOf("\nasync function ", i + start.length);
  const end = [next, nextFn].filter((n) => n > 0).sort((a, b) => a - b)[0] ?? src.length;
  return src.slice(i, end);
};

async function main() {
  const { approveAllSkips, qcFixKey, readinessWarning, reviewReadiness } = await import("../src/lib/qc-labels");
  const { finalReviewText, hasSlackPhotoReview, hubFinalReview } = await import("../src/lib/slack");
  const { DEMO_SHOOTS, demoFrames } = await import("../src/lib/demo-data");
  const { visibilityOf } = await import("../src/lib/visibility");
  type Issue = import("../src/db/schema").QcIssue;

  // ---- 1. QC never rejects or hides a photo (step 2) --------------------------
  const pipe = code(read("src/lib/pipeline.ts"));
  const step = fn(pipe, "async function stepQc(");
  ok(step.length > 0 && !/qcState/.test(step), "the QC pass never writes qc_state (a block flag no longer rejects)");
  ok(!/published|held/.test(step.slice(step.indexOf(".set({"), step.indexOf(".where(eq(schema.media.id, m.id))"))), "the QC pass never touches published or held");
  const cand = fn(pipe, "function qcCandidatesWhere(");
  ok(/ne\(schema\.media\.qcState, "rejected"\)/.test(cand) && !/corrected/.test(cand), "QC looks at every frame a person has not rejected, revised uploads included");
  const requeue = fn(pipe, "export async function requeueQcRow(");
  ok(requeue.length > 0 && !/corrected/.test(requeue), "Run QC again clears and re-checks the revised uploads too");
  ok(!/corrected/.test(fn(pipe, "async function finishQc(")), "the QC summary counts the revised uploads");
  const s2 = DEMO_SHOOTS.find((s) => s.id === "demo-s2")!;
  const frames = demoFrames(s2);
  const blocked = frames.filter((f) => f.qcIssues?.some((i) => i.severity === "block"));
  ok(blocked.length > 0 && blocked.every((f) => f.qcState === "pending" && !f.section && visibilityOf({ ...f, shootId: s2.id }, false) === "pending"), "demo: block-flagged photos stay unreviewed, Internal only, in the gallery");
  ok(frames.every((f) => visibilityOf({ ...f, shootId: s2.id }, false) !== "client"), "demo: every photo of a shoot in review is Internal only");
  console.log("1. no QC rejection: ok");

  // ---- 2. Approve all leaves block flags for a person ---------------------------
  const block: Issue = { type: "person", severity: "block", note: "Person in the doorway." };
  const fix: Issue = { type: "dust", severity: "fix", note: "Dust in the sky." };
  ok(approveAllSkips({ qcState: "pending", qcIssues: [fix, block] }), "a pending photo with a block flag is skipped");
  ok(!approveAllSkips({ qcState: "pending", qcIssues: [fix] }) && !approveAllSkips({ qcState: "pending", qcIssues: null }), "fix flags and clean photos are approved");
  ok(!approveAllSkips({ qcState: "approved", qcIssues: [block] }), "an approved photo is not Approve all's business");
  const acts = code(read("src/app/admin/actions.ts"));
  const all = fn(acts, "export async function approveAllFrames(");
  ok(/approveAllSkips\(/.test(all) && /inArray\(schema\.media\.id, ids\)/.test(all) && all.indexOf("whoStaff()") < all.indexOf("hasDb()"), "approveAllFrames gates first and approves only the ids that pass approveAllSkips");
  ok(/approveAllSkips\(f\)/.test(read("src/components/admin/ShootReview.tsx")), "the grid's optimistic Approve all skips the same photos");
  console.log("2. approve all: ok");

  // ---- 3. Revised section and re-uploads (steps 4 and 5) ------------------------
  const grid = read("src/components/admin/ShootReview.tsx");
  ok(/k === "final" \? "Revised"/.test(grid), "the editors' corrected uploads are the Revised section");
  ok(/f\.corrected \? "final"/.test(grid), "every corrected frame sits in Revised (in-place replacements and new names)");
  const finals = code(read("src/lib/finals.ts"));
  const repl = finals.slice(finals.indexOf('r.kind === "replace"'), finals.indexOf('action: "media.replaced"'));
  ok(/qcIssues: null/.test(repl) && /qcCheckedAt: null/.test(repl) && /clearQcFixes\(match\.id\)/.test(repl), "a replaced file starts with no flags and no ticks, ready for Run QC again");
  ok(/published: false/.test(repl) && /qcState: "approved"/.test(repl), "a revised photo lands Internal only (approved, not published), as before");
  ok(/copyObject\(/.test(finals), "the replaced original is still archived before the swap");
  const box = read("src/components/admin/UploadFinals.tsx");
  ok(/onClick=\{\(\) => run\(false\)\}[^>]*>\{busy \? busyLabel : `Upload \$\{queued\} to Revised`\}/.test(box), "Upload to Revised is the primary upload button");
  ok(/Upload and send for final review/.test(box), "upload and send stays as the shortcut");
  console.log("3. revised: ok");

  // ---- 4. readiness: the warning, never a block (step 6) --------------------------
  const ticked = { [qcFixKey(fix)]: { by: "qa@example.com", name: "QA", at: "2026-11-03T15:00:00Z" } };
  const r = reviewReadiness([
    { qcState: "pending", corrected: false, qcIssues: [fix, block], qcCheckedAt: "2026-11-03T15:00:00Z", qcFixes: ticked },
    { qcState: "approved", corrected: true, qcIssues: [fix], qcCheckedAt: "2026-11-03T15:00:00Z", qcFixes: ticked },
    { qcState: "approved", corrected: true, qcIssues: null, qcCheckedAt: null },
    { qcState: "rejected", corrected: false, qcIssues: [block, fix], qcCheckedAt: "2026-11-03T15:00:00Z" },
  ]);
  ok(r.openFlags === 1 && r.openPhotos === 1, `one open flag on one photo; a rejected photo's flags do not count (${JSON.stringify(r)})`);
  ok(r.revised === 2 && r.revisedUnchecked === 1, "two revised photos, one QC has not seen since the upload");
  const w = readinessWarning(r);
  ok(w === "1 QC flag is not ticked yet, on 1 photo. 1 revised photo has not been through QC since it was uploaded. Run QC again first.", `warning: ${w}`);
  ok(readinessWarning({ openFlags: 0, openPhotos: 0, revised: 3, revisedUnchecked: 0 }) === "", "no warning when everything is ticked");
  const demoR = reviewReadiness(frames);
  ok(demoR.revised === 3 && demoR.revisedUnchecked === 1 && demoR.openFlags > 0, "demo: three revised photos, one unchecked, some flags open");
  const panel = read("src/components/admin/FinalReviewPanel.tsx");
  ok(/window\.confirm\(ask\)/.test(panel) && /Send again/.test(panel) && /disabled=\{busy \|\| !enabled\}/.test(panel), "the panel confirms a send with open flags and a Send again, and disables while sending");
  ok(/again \}\)/.test(panel) && /finals\/done/.test(panel), "the panel posts review with again to the staff finals done route");
  ok(!/[—]|--|!/.test(panel.match(/>[^<>{}]*</g)?.join("") ?? ""), "panel copy has no dashes or exclamation marks");
  console.log("4. readiness: ok");

  // ---- 5. one send, who and when ------------------------------------------------
  const fr = code(read("src/lib/final-review.ts"));
  const send = fn(fr, "export async function sendForFinalReview(");
  ok(/RESEND_MS/.test(send) && /finalReviewOpen\(last, shoot\.publishedAt\) && !p\.again/.test(send), "a send inside two minutes, or while one is open without again, sends nothing");
  ok(send.indexOf("logActivity(") > 0 && send.indexOf("logActivity(") < send.indexOf("hubFinalReview("), "the activity row is written before the post");
  ok(/openFlags: readiness\.openFlags/.test(send), "the activity row and the line carry the open flag count");
  const route = code(read("src/app/api/studio/shoots/[id]/finals/done/route.ts"));
  ok(route.indexOf("requireStaffApi()") > 0 && route.indexOf("requireStaffApi()") < route.indexOf("hasDb()") && /again: b\.again === true/.test(route), "the done route is staff gated and passes again through");
  const page = read("src/app/admin/shoots/[id]/page.tsx");
  ok(/<FinalReviewPanel/.test(page) && /lastFinalReviews\(\[shoot\.id\]\)/.test(page) && /staffNames\(\[finalReview\.by\]\)/.test(page), "the shoot page shows the panel with who sent the last one");
  console.log("5. one send: ok");

  // ---- 6. the line and where it goes --------------------------------------------
  const s = "0b6a1c2e-1111-2222-3333-444455556666";
  const base = { shootId: s, listing: { address: "1656 Example Pine Road, Springfield, CA 90000" }, corrected: 92, failed: 0, by: "editor@example.com" };
  const line = finalReviewText({ ...base, openFlags: 3, revisedUnchecked: 0 });
  ok(line.includes("1656 Example Pine Road is ready for final review") && line.includes("3 QC flags not ticked.") && line.includes(`/admin/shoots/${s}|Open the shoot>`), `the line names the street, the open flags and links the shoot (${line})`);
  ok(finalReviewText({ ...base, openFlags: 0 }).includes("Every QC flag is ticked."), "all ticked reads so");
  ok(!finalReviewText(base).includes("QC flag"), "an upload and send without counts says nothing about flags");
  ok(finalReviewText({ ...base, listing: { address: "9 Example Secret Lane, X", nda: true }, openFlags: 1 }).startsWith("an NDA listing"), "NDA listings stay unnamed");

  const posts: { url: string; text: string }[] = [];
  let reviewStatus = 200;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    posts.push({ url: u, text: JSON.parse(String(init?.body ?? "{}")).text });
    return new Response("ok", { status: u.includes("review") ? reviewStatus : 200 });
  }) as typeof fetch;
  const env = process.env as Record<string, string | undefined>;
  env.SLACK_WEBHOOK_URL = "https://hooks.example.invalid/hub";
  delete env.SLACK_PHOTO_REVIEW_WEBHOOK_URL;
  env.VERCEL_ENV = "production";
  ok(!hasSlackPhotoReview(), "unset: no review channel");
  let p = await hubFinalReview({ ...base, openFlags: 0 });
  ok(p.channel === "hub" && posts.length === 1 && posts[0].url.endsWith("/hub"), "unset: the hub gets the line, as before");
  ok(!posts[0].text.includes("<@"), "production, no final review team set: the line tags nobody");
  posts.length = 0;
  env.SLACK_PHOTO_REVIEW_WEBHOOK_URL = "https://hooks.example.invalid/review";
  ok(hasSlackPhotoReview(), "set: the review channel is on");
  p = await hubFinalReview({ ...base, openFlags: 0 });
  ok(p.channel === "review" && posts.length === 1 && posts[0].url.endsWith("/review"), "set: one post, to the review channel only");
  ok(!posts[0].text.startsWith("<@"), "the review channel line has no tags until the team is set");
  posts.length = 0;
  reviewStatus = 500;
  p = await hubFinalReview({ ...base, openFlags: 0 });
  ok(p.channel === "hub" && posts.length === 2 && posts[1].url.endsWith("/hub"), "a refused review post falls back to the hub");
  posts.length = 0;
  reviewStatus = 200;
  env.VERCEL_ENV = "preview";
  await hubFinalReview({ ...base, openFlags: 0 });
  ok(posts[0].text.startsWith("Test site:") && !/<@U/.test(posts[0].text), "a preview says Test site and tags nobody");
  delete env.VERCEL_ENV;
  ok(/SLACK_PHOTO_REVIEW_WEBHOOK_URL=\s*$/m.test(read(".env.example")), ".env.example names the variable with no value");
  ok(/slackPhotoReview: hasSlackPhotoReview\(\)/.test(read("src/app/api/studio/health/route.ts")), "health reports slackPhotoReview");
  console.log("6. the line: ok");

  // ---- 7. publishing is unchanged (step 7) ---------------------------------------
  const fa = code(read("src/app/admin/frame-actions.ts"));
  ok(/publishFrames|publishShootFrames/.test(fa) && !/sendForFinalReview|hubFinalReview/.test(fa), "a send never publishes and publishing never sends");
  ok(!/\.update\(|\.insert\(|publishFrames|frame-publish/.test(fr), "sending for final review writes no media or shoot row (nothing is published or approved)");
  console.log("7. publishing: ok");

  console.log(`${passes} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
