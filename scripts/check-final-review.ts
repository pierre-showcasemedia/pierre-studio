// Checks for Send for final review (Oct 28 2026, src/lib/final-review.ts):
// when a send is still open, the tagged hub line, the quiet run line, and the
// default final review list.
//
//   npx tsx scripts/check-final-review.ts
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
  const { finalReviewOpen, FINAL_REVIEW_ACTION } = await import("../src/lib/final-review");
  const { finalReviewText } = await import("../src/lib/slack");
  const { hubChannelFor } = await import("../src/lib/hub-activity");
  const { EMPTY_QC_TAGS, FINAL_REVIEW_DEFAULT, qcIds, qcMentionText } = await import("../src/lib/slack-qc");
  const { qaMaySee } = await import("../src/lib/activity");

  // ---- upload links in chunks the route hands out in full (Nov 1 2026, 195 Example Oakleaf) ----
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("src/app/api/studio/shoots/[id]/finals/upload-urls/route.ts", "utf8");
  const box = readFileSync("src/components/admin/UploadFinals.tsx", "utf8");
  const routeMax = Number(/const MAX_BATCH = (\d+);/.exec(route)?.[1]);
  const boxBatch = Number(/const URL_BATCH = (\d+);/.exec(box)?.[1]);
  ok(routeMax > 0 && boxBatch > 0 && boxBatch <= routeMax, `the box asks for at most the route's ${routeMax} links per call (asks ${boxBatch})`);
  ok(/for \(let b = 0; b < pending\.length; b \+= URL_BATCH\)/.test(box) && /files: chunk\.map/.test(box), "the box asks for links chunk by chunk");

  // ---- open until the next publish ----
  const at = new Date("2026-10-28T20:00:00Z");
  ok(!finalReviewOpen(null, null), "never sent: not open");
  ok(finalReviewOpen({ at }, null), "sent, never published: open");
  ok(finalReviewOpen({ at }, "2026-10-28T19:00:00Z"), "sent after the last publish: open");
  ok(!finalReviewOpen({ at }, "2026-10-28T21:00:00Z"), "published after the send: closed");
  ok(finalReviewOpen({ at: at.toISOString() }, new Date("2026-10-27T00:00:00Z")), "strings and dates both read");

  // ---- the hub line ----
  const s = "0b6a1c2e-1111-2222-3333-444455556666";
  const line = finalReviewText({ shootId: s, listing: { address: "1656 Example Pine Road, Springfield, CA 90000" }, corrected: 92, failed: 0, by: "editor@example.com" });
  ok(line.startsWith("1656 Example Pine Road is ready for final review: 92 corrected photos from editor@example.com."), "names the street, the count and who sent it");
  ok(line.includes(`/admin/shoots/${s}|Open the shoot>`), "links the shoot page");
  ok(!/\$\s?\d/.test(line) && !/—|--/.test(line), "no money, no dashes");
  const one = finalReviewText({ shootId: s, listing: { address: "1 A St, X" }, corrected: 1, failed: 2, by: "e@x.com" });
  ok(one.includes("1 corrected photo from") && one.includes("2 files did not upload."), "singular photo, failures counted");
  const none = finalReviewText({ shootId: s, listing: { address: "1 A St, X" }, corrected: 0, failed: 0, by: "e@x.com" });
  ok(none.includes("ready for final review: sent by e@x.com."), "a send with no corrections still reads");
  const nda = finalReviewText({ shootId: s, listing: { address: "9 Hideaway Example Lane, X", nda: true }, corrected: 3, failed: 0, by: "e@x.com" });
  ok(nda.startsWith("an NDA listing is ready for final review") && !nda.includes("Hideaway"), "an NDA listing is never named");

  // ---- one message: the run line stays quiet when the send posts ----
  ok(hubChannelFor({ action: "media.upload_finished", meta: { run: "r1", landed: 3, review: true } }) === null, "a reviewed run's line is quiet");
  ok(hubChannelFor({ action: "media.upload_finished", meta: { run: "r1", landed: 3 } }) === "hub", "an Upload only run still posts its line");
  ok(hubChannelFor({ action: "media.finals_uploaded", meta: { run: "r1", replaced: 3 } }) === null, "batches inside a run stay quiet");
  ok(hubChannelFor({ action: FINAL_REVIEW_ACTION }) === null, "the send posts its own tagged line, never a second activity line");

  // ---- who is tagged ----
  ok(EMPTY_QC_TAGS.final === FINAL_REVIEW_DEFAULT, "the final list defaults to the four");
  ok(qcIds(FINAL_REVIEW_DEFAULT).length === 0, "nobody is tagged until the final review team is set");
  ok(qcMentionText("U0AAAAAA1 U0BBBBBB2").split(" ").every((m) => /^<@U[A-Z0-9]+>$/.test(m)), "member ids are tagged as member mentions");
  ok(qaMaySee(FINAL_REVIEW_ACTION), "the QA team sees the send in activity");

  // ---- a drop whose names match no frame (Nov 2 2026, 20 Dogwood) ----
  const { frameBase, siblingMatches, strayNames } = await import("../src/lib/finals-names");
  ok(frameBase("corrected/STUDIO-20-Dogwood-1.JPG") === "studio-20-dogwood-1", "a name's base drops the folder, the extension and the case");
  ok(strayNames(["20-Dogwood-01.jpg", "STUDIO-20-Dogwood-1.jpg"], ["20-Dogwood-01.jpg"]).join() === "STUDIO-20-Dogwood-1.jpg", "strays are the names that match no frame");
  const sib = siblingMatches(["STUDIO-20-Dogwood-1.jpg", "STUDIO-20-Dogwood-2.jpg", "x.jpg"], [
    { shootId: "b", label: "the shoot uploaded Nov 2", frameNames: ["other.jpg"] },
    { shootId: "a", label: "the shoot uploaded Nov 1", frameNames: ["STUDIO-20-Dogwood-1.jpg", "STUDIO-20-Dogwood-2.jpg"] },
  ]);
  ok(sib.length === 1 && sib[0].shootId === "a" && sib[0].matched === 2, "names that match another shoot's frames point at that shoot, best match first");
  ok(/const noneMatch = queuedRows\.length > 0 && frameNames\.length > 0 && unmatched\.length === queuedRows\.length;/.test(box) && /adm-banner--bad/.test(box) && /None of these \{queuedRows\.length\} filenames match a frame on this shoot/.test(box), "the box turns red when nothing matches and says nothing would be replaced");
  ok(/const held = noneMatch && !forceNew;/.test(box) && /disabled=\{busy \|\| !queued \|\| held\}/.test(box) && /Add them as new photos anyway/.test(box), "both buttons stay off until Add them as new photos anyway is ticked");
  ok(/strays\.length === pending\.length && !forceNew\) \{\s*setErr\(/.test(box), "run() refuses that drop on its own too");
  ok(/Drop them there to replace those frames/.test(box) && /elsewhere\[0\]\.shootId\}#finals/.test(box), "it names the shoot of this listing the names do match");
  const shootPage = readFileSync("src/app/admin/shoots/[id]/page.tsx", "utf8");
  ok(/siblingShootFrames\(shoot\.listingId, shoot\.id\)/.test(shootPage) && /siblings=\{siblings\}/.test(shootPage), "the shoot page hands the box the listing's other shoots");

  // ---- the shoot's date and "Shoot 1 of 2" on the Photo QC cards (Nov 2 2026) ----
  const { shootOrdinals, photoQcBoard } = await import("../src/lib/photo-qc");
  const ord = shootOrdinals([
    { id: "d2", listingId: "L", uploadedAt: "2026-11-02T21:38:00.000Z" },
    { id: "d1", listingId: "L", uploadedAt: "2026-11-02T06:17:00.000Z" },
    { id: "x", listingId: "M", uploadedAt: "2026-11-01T00:00:00.000Z" },
  ]);
  ok(ord.get("d1")?.n === 1 && ord.get("d2")?.n === 2 && ord.get("d2")?.of === 2 && !ord.has("x"), "two shoots on one listing read Shoot 1 of 2 and 2 of 2 in upload order; a lone shoot has no ordinal");
  const board = await photoQcBoard();
  const shootCards = (["editing", "review", "final", "published", "stopped"] as const).flatMap((k) => board[k]);
  ok(shootCards.length > 0 && shootCards.every((c) => c.uploadedAt), "every shoot card carries the shoot's upload date");
  ok(board.revisions.every((c) => c.uploadedAt === null && c.nth === null), "revision cards carry neither");
  // Nov 6 2026: the cards render in the board's client component.
  const qcPage = readFileSync("src/components/admin/PhotoQcBoard.tsx", "utf8");
  ok(/Shoot \{c\.nth\.n\} of \{c\.nth\.of\} · uploaded \{fmtDate\(c\.uploadedAt\)\}/.test(qcPage) && /Uploaded \{fmtDate\(c\.uploadedAt\)\}/.test(qcPage), "the card shows the upload date, and which shoot of the listing it is");

  console.log(`${passes} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
