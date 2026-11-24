// Checks for the #video-editing line (Nov 1 2026, src/lib/slack.ts): the
// text (the video editor's tag, folder, 24 to 48 hour deadline, card, NDA, test site), the
// "ready for review" line when a cut comes back from the editor, and the
// wiring that queues it once per shoot when the last clip lands or at Submit.
//
//   npx tsx scripts/check-video-editing.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
import { BUSINESS_TZ, TZ_ABBR } from "../src/lib/business";
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
  process.env.SLACK_VIDEO_EDITING_TAG = "U0TESTVID1";
  const { videoEditingText, videoCutReadyText, slackDate, VIDEO_DELIVERY_HOURS, VIDEO_EDITING_TAG } = await import("../src/lib/slack");
  const { FINAL_REVIEW_DEFAULT, qcMentionText } = await import("../src/lib/slack-qc");
  const { JOB_KINDS } = await import("../src/db/schema");
  const { readFileSync } = await import("node:fs");

  // ---- the text ----
  const landedAt = new Date("2026-11-01T23:55:09Z");
  const base = {
    cardId: "card-1",
    listing: { address: "3330 Cedar Road, Springfield, CA 90000", nda: false },
    clips: 139,
    bytes: 16_100_000_000,
    landedAt,
    folderUrl: "https://www.dropbox.com/scl/fo/abc/xyz",
  };
  const prod = videoEditingText({ ...base, mention: "<!subteam^S0VIDEO1> ", production: true });
  ok(prod.startsWith("<!subteam^S0VIDEO1> :exclamation: *"), "production: the group tag first, then the flagged line");
  ok(prod.includes("Raw video for 3330 Cedar Road is in Dropbox: 139 clips (16.1 GB) in the Video folder."), "street, clip count and size");
  ok(prod.includes("<https://www.dropbox.com/scl/fo/abc/xyz|Open the Video folder>"), "the Video folder link");
  ok(/\/admin\/video\/card-1\|Open the Video card>/.test(prod), "the shoot's Video card");
  const unix = (h: number) => Math.floor(landedAt.getTime() / 1000) + h * 3600;
  ok(VIDEO_DELIVERY_HOURS.from === 24 && VIDEO_DELIVERY_HOURS.to === 48, "the deadline is 24 to 48 hours");
  ok(prod.includes(`Due in 24 to 48 hours, between <!date^${unix(24)}^`) && prod.includes(`and <!date^${unix(48)}^`), "both deadlines count from when the last clip landed");
  const wantWhen = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(unix(24) * 1000));
  ok(slackDate(new Date(unix(24) * 1000)).endsWith(`|${wantWhen} ${TZ_ABBR}>`), "the fallback reads in the business's time zone");
  ok(!/[—–]|--/.test(prod), "no em dashes or double hyphens");

  const one = videoEditingText({ ...base, clips: 1, bytes: 420_000_000, mention: "", production: true });
  ok(one.includes(": 1 clip (420 MB) in the Video folder.") && one.startsWith(":exclamation:"), "one clip, MB, and no tag when the group is not set");

  const nda = videoEditingText({ ...base, listing: { ...base.listing, nda: true }, mention: "", production: true });
  ok(nda.includes("Raw video for an NDA listing") && !nda.includes("Cedar") && !nda.includes("dropbox.com") && nda.includes("The Dropbox folder is on the card."), "NDA: no name and no folder link");

  const noCard = videoEditingText({ ...base, cardId: null, folderUrl: null, mention: "", production: true });
  ok(/\/admin\/video\|Open the Video board>/.test(noCard) && noCard.includes("The Dropbox folder is on the card."), "no card: the board; no folder: says where it is");

  const test = videoEditingText({ ...base, mention: "<!subteam^S0VIDEO1> ", production: false });
  ok(test.startsWith("Test site: Raw video") && !test.includes("subteam") && !test.includes(":exclamation:"), "a preview tags nobody");

  // ---- the video editor, for now (Nov 1 2026) ----
  ok(VIDEO_EDITING_TAG === "<@U0TESTVID1>", "the raw video line tags the editor in SLACK_VIDEO_EDITING_TAG");
  const slackSrc = readFileSync("src/lib/slack.ts", "utf8");
  const post = slackSrc.slice(slackSrc.indexOf("export async function videoEditingShootReady"), slackSrc.indexOf("export function videoCutReadyText"));
  ok(/mention: production \? `\$\{VIDEO_EDITING_TAG\} `/.test(post) && !/qcMention/.test(post), "and not the Video QC group");

  // ---- a cut back from the editor: ready for review ----
  ok(qcMentionText(FINAL_REVIEW_DEFAULT) === "", "no final review team by default");
  const four = `${qcMentionText("U0AAAAAA1 U0BBBBBB2 U0CCCCCC3 U0DDDDDD4")} `;
  ok(four.split("<@").length - 1 === 4, "a final review list of four people tags four");
  const cut = videoCutReadyText({ cardId: "card-1", listing: base.listing, count: 1, names: ["3330 Cedar v1.mp4"], by: "editor@example.com", mention: four, production: true });
  ok(cut.startsWith(`${four}:exclamation: *Video for 3330 Cedar Road is ready for review: 1 cut uploaded by editor@example.com (3330 Cedar v1.mp4).`), "tags the four, says ready for review, who and which cut");
  ok(/\/admin\/video\/card-1\|Review it on the Video card>/.test(cut), "links the Video card");
  const cuts = videoCutReadyText({ cardId: "c", listing: { ...base.listing, nda: true }, count: 5, names: ["a", "b", "c", "d", "e"], by: "x", mention: "", production: true });
  ok(cuts.includes("an NDA listing is ready for review: 5 cuts uploaded by x.") && !cuts.includes("(a"), "NDA: no names");
  ok(videoCutReadyText({ cardId: "c", listing: base.listing, count: 5, names: ["a", "b", "c", "d", "e"], by: "x", mention: "", production: true }).includes("(a, b, c, 2 more)"), "at most three names");
  ok(videoCutReadyText({ cardId: "c", listing: base.listing, count: 1, names: [], by: "x", mention: four, production: false }).startsWith("Test site: Video for"), "a preview tags nobody");
  const done = readFileSync("src/app/api/studio/listings/[id]/upload-done/route.ts", "utf8");
  ok(/b\.source === "video-card" && r\.posted && r\.totals\.landed > 0/.test(done) && /card\.listingId === listing\.id/.test(done), "once per drop, only for a card on this listing");
  const box = readFileSync("src/components/admin/VideoCutUpload.tsx", "utf8");
  ok(/source: "video-card", cardId, done: doneNames/.test(box), "the Video card box says where the cut came from");
  ok(/mention: production \? await qcMention\("final"\)/.test(slackSrc), "the cut line tags the final review list");

  // ---- the wiring ----
  ok((JOB_KINDS as readonly string[]).includes("slack.video_editing"), "the job kind exists");
  const jobs = readFileSync("src/lib/jobs.ts", "utf8");
  const handler = jobs.slice(jobs.indexOf('case "slack.video_editing"'), jobs.indexOf('case "slack.upload_check"'));
  ok(/hasSlackVideoEditing\(\)\) throw new SkipJobError/.test(handler), "unset webhook: the job is skipped, nothing waits to go out late");
  ok(/videoEditingLineFor\(p\.shootId\)/.test(handler) && /videoEditingShootReady\(line\)/.test(handler), "the handler builds the line from the shoot and posts it");

  const mirror = readFileSync("src/lib/dropbox-mirror.ts", "utf8");
  ok(/if \(file\.kind === "raw_video"\) await queueVideoEditingLine\(shoot\.id, listing\.id\)\.catch/.test(mirror), "a landed clip checks the shoot, and a failure never fails the copy");
  const q = mirror.slice(mirror.indexOf("export async function queueVideoEditingLine"));
  ok(/shoot\.status === "draft"\) return false/.test(q), "a draft never queues it (more clips may be on the way)");
  // Nov 18 2026: in the business's file store, Dropbox or Google Drive (business.fileStore).
  ok(/clips\.some\(\(c\) => !\(drive \? c\.driveSyncedAt : c\.dropboxSyncedAt\)\)\) return false/.test(q) && /const drive = business\.fileStore === "google_drive"/.test(q), "every clip must be in the file store (Dropbox or Google Drive)");
  const dmirror = readFileSync("src/lib/drive-mirror.ts", "utf8");
  ok(/if \(file\.kind === "raw_video"\) \{[\s\S]{0,200}queueVideoEditingLine\(shoot\.id, listing\.id\)\.catch/.test(dmirror), "a clip landed in Google Drive checks the shoot too, and a failure never fails the copy");
  ok(/idempotencyKey: jobKey\(VIDEO_EDITING_KIND, shootId\)/.test(q), "once per shoot");

  const submit = readFileSync("src/app/api/studio/shoots/[id]/submit/route.ts", "utf8");
  ok(/if \(landed\.kinds\.video > 0\) await queueVideoEditingLine\(id, shoot\.listingId\)/.test(submit), "Submit queues it when the clips finished copying during the upload");
  ok(submit.indexOf("status: videoOnly") < submit.indexOf("queueVideoEditingLine(id"), "Submit saves the status before it checks");

  console.log(`${passes} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
