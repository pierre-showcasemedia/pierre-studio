// Checks for the video pipeline (Oct 26 2026). No database, no network.
//
//   npx tsx scripts/check-video.ts
//
// 1. Slack QC tags: every way an id gets pasted, and the webhook mention.
// 2. Timecodes and the film review's time bounds.
// 3. Which bookings are video, and the card's service names.
// 4. The client file lines a video editor sees (video only, no money).
// 5. The Dropbox layout: the address folder, Photo and Video, the web link.
// 6. The board's stages, in the owner's order.
export {};

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check needs no database.");
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
  const { qcIds, qcMentionText } = await import("../src/lib/slack-qc");
  const { fmtTimecode, videoServiceNames, isVideoBooking, videoLines, STAGE_LABELS, VIDEO_STAGES, isVideoStage } = await import("../src/lib/video-board");
  const { cleanAtMs, AT_MS_MAX } = await import("../src/lib/video-review");
  const { dropboxWebUrl, mirrorTargetPath, listingFolderPath, RAW_PHOTOS_SUBFOLDER, RAW_VIDEO_SUBFOLDER } = await import("../src/lib/dropbox");
  const { videoFolderUrl } = await import("../src/lib/dropbox-mirror");

  // ---- 1. Slack QC tags ----------------------------------------------------------
  ok(qcIds("S0123ABCD").join() === "S0123ABCD", "a bare group id");
  ok(qcIds("<!subteam^S0123ABCD|@photo-qc>").join() === "S0123ABCD", "a group mention as Slack copies it");
  ok(qcIds("U01AAAAAA, U02BBBBBB U01AAAAAA").join() === "U01AAAAAA,U02BBBBBB", "member ids, comma or space, each once");
  ok(qcIds("<@U01AAAAAA> and https://studio.slack.com/team/U02BBBBBB").join() === "U01AAAAAA,U02BBBBBB", "a pasted mention and a profile link");
  ok(qcIds("s0123abcd").join() === "S0123ABCD", "lowercase is read as the id");
  ok(qcIds("photo qc").length === 0 && qcIds("").length === 0, "words that are not ids are ignored");
  ok(qcMentionText("S0123ABCD U01AAAAAA") === "<!subteam^S0123ABCD> <@U01AAAAAA>", "groups ping as subteam, people as users");
  ok(qcMentionText("") === "", "nobody set: no mention");
  console.log("1. Slack QC tags: ok");

  // ---- 2. timecodes ---------------------------------------------------------------
  ok(fmtTimecode(0) === "0:00" && fmtTimecode(42_000) === "0:42" && fmtTimecode(65_900) === "1:05", "minutes and seconds, rounded down");
  ok(fmtTimecode(3_909_000) === "1:05:09", "hours when the film is that long");
  ok(fmtTimecode(-5) === "0:00", "a negative time reads as the start");
  ok(cleanAtMs(42_000) === 42_000 && cleanAtMs("1500.4") === 1500, "a time in ms, rounded");
  ok(cleanAtMs(-1) === null && cleanAtMs(AT_MS_MAX + 1) === null && cleanAtMs("x") === null && cleanAtMs(null) === null, "out of range or not a number is refused");
  console.log("2. timecodes: ok");

  // ---- 3. video bookings -------------------------------------------------------
  // From this studio's price table: whatever it marks video: true.
  const { SERVICES, ADDONS } = await import("../src/lib/studio-pricing");
  const vSvc = SERVICES.filter((x) => x.video), pSvc = SERVICES.filter((x) => !x.video);
  const vAdd = ADDONS.filter((x) => x.video), pAdd = ADDONS.filter((x) => !x.video);
  ok(vSvc.every((x) => isVideoBooking([x.id])) && vAdd.every((x) => isVideoBooking([], [x.id])), "every video item on the price table is video");
  ok(pSvc.every((x) => !isVideoBooking([x.id])) && !isVideoBooking([]) && !isVideoBooking(null) && !isVideoBooking(["nonsense"]), "photo items, nothing, or an unknown id is not");
  const v = videoServiceNames([...pSvc, ...vSvc].map((x) => x.id), [...pAdd, ...vAdd].map((x) => x.id));
  ok(v.services.join() === vSvc.map((x) => x.name).join(), `the card lists the video services only (${v.services.join()})`);
  ok(v.addons.join() === vAdd.map((x) => x.name).join(), `and the video add-ons only (${v.addons.join()})`);
  console.log("3. video bookings: ok");

  // ---- 4. client file lines -------------------------------------------------------
  const lines = videoLines(
    { "Before every shoot": ["- Always deliver a horizontal film, a vertical reel, and a vertical with no music.", "- Bring the long lens for the view."], Billing: ["- Film is $1,900 for her, net 15."], Notes: ["- Likes slow cinematic pacing", "- Prefers the gate code by text"] },
    ["Always deliver a horizontal film, a vertical reel, and a vertical with no music."]
  );
  ok(lines.some((l) => /vertical with no music/.test(l)) && lines.filter((l) => /vertical with no music/.test(l)).length === 1, "video lines kept, each once");
  ok(lines.some((l) => /slow cinematic pacing/.test(l)), "pace lines kept");
  ok(!lines.some((l) => /long lens|gate code/.test(l)), "lines with nothing about video are left out");
  ok(!lines.some((l) => /\$\s?\d/.test(l)), `no amount reaches a video editor (${lines.join(" | ")})`);
  ok(videoLines(null).length === 0, "no client file, no lines");
  console.log("4. client file lines: ok");

  // ---- 5. Dropbox layout ----------------------------------------------------------
  ok(RAW_PHOTOS_SUBFOLDER === "Photo" && RAW_VIDEO_SUBFOLDER === "Video", "the folders are Photo and Video (the SOP)");
  const folder = listingFolderPath("/Listings", "1420 Alder Drive, Springfield, CA 90000");
  ok(folder === "/Listings/1420 Alder Drive, Springfield, CA 90000", "the listing folder is the address");
  ok(mirrorTargetPath(folder, "raw_video", "C0001.MP4") === `${folder}/Video/C0001.MP4` && mirrorTargetPath(folder, "raw", "A.ARW") === `${folder}/Photo/A.ARW`, "clips go to Video, raws to Photo");
  ok(dropboxWebUrl(`${folder}/Video`) === "https://www.dropbox.com/home/Listings/1420%20Alder%20Drive%2C%20Springfield%2C%20CA%2090000/Video", "the web link encodes each part and keeps the slashes");
  ok(videoFolderUrl({ dropboxFolder: folder, dropboxVideoLink: "https://www.dropbox.com/scl/fo/abc" })?.shared === true, "a saved share link wins");
  const web = videoFolderUrl({ dropboxFolder: folder, dropboxVideoLink: null });
  ok(web?.shared === false && web.url.endsWith("/Video"), "no share link: the folder on dropbox.com");
  ok(videoFolderUrl({ dropboxFolder: null, dropboxVideoLink: null }) === null, "no folder yet: no link");
  console.log("5. Dropbox layout: ok");

  // ---- 6. stages ------------------------------------------------------------------
  ok(VIDEO_STAGES.map((s) => STAGE_LABELS[s]).join(" > ") === "In queue > In editing > In review > Sent to client > Complete", "the five stages, in order");
  ok(isVideoStage("review") && !isVideoStage("done") && !isVideoStage(null), "only the five are stages");
  console.log("6. stages: ok");

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
