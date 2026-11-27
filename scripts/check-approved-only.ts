// Checks for "only approved photos publish" (Nov 2 2026, src/lib/publish-plan.ts
// and the shoot page): what a Publish sends and skips, the words on the button
// and the banner, the Rejected section, the server side (rejected never goes,
// rejecting unpublishes, QC marks never refresh the page), the opened
// photo's own transition layer (the R / A close-and-reopen glitch) and its
// size (the 2048px derivative filling the stage, Z for the original).
//
//   npx tsx scripts/check-approved-only.ts
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
const noDashes = (s: string) => !/—|--/.test(s);

async function main() {
  const { publishPlan, publishLabel, publishedBanner, defaultDestination, NOTHING_APPROVED, DESTINATION_LABEL } = await import("../src/lib/publish-plan");
  const { VISIBILITY_LABEL, VISIBILITY_HINT } = await import("../src/lib/visibility");
  const { readFileSync } = await import("node:fs");

  // ---- the plan: approved and not live go, nothing else ----
  const frames = [
    { id: "a1", qcState: "approved" as const, published: false, held: false, section: null },
    { id: "a2", qcState: "approved" as const, published: false, held: false, section: "Twilight" },
    { id: "live", qcState: "approved" as const, published: true, held: false, section: null },
    { id: "held", qcState: "approved" as const, published: false, held: true, section: null },
    { id: "p1", qcState: "pending" as const, published: false, held: false, section: null },
    { id: "p2", qcState: "pending" as const, published: false, held: false, section: null },
    { id: "r1", qcState: "rejected" as const, published: false, held: false, section: null },
    { id: "rlive", qcState: "rejected" as const, published: true, held: false, section: null },
  ];
  const all = publishPlan(frames);
  ok(all.ids.join(",") === "a1,a2", `bulk plan sends the approved, not live, not held frames (${all.ids.join(",")})`);
  ok(all.approved === 2 && all.rejected === 2 && all.pending === 2 && all.held === 1 && all.live === 1, `bulk plan counts ${JSON.stringify(all)}`);
  ok(!all.ids.includes("rlive"), "a rejected frame that is still marked published never goes");
  const sel = publishPlan(frames, { pick: ["a1", "held", "p1", "r1", "nope"] });
  ok(sel.ids.join(",") === "a1" && sel.held === 1 && sel.pending === 1 && sel.rejected === 1, `a selection sends only its approved frames (${JSON.stringify(sel)})`);
  const withHeld = publishPlan(frames, { pick: ["a1", "held"], includeHeld: true });
  ok(withHeld.ids.join(",") === "a1,held" && withHeld.held === 0, "a Publish on the photo itself or a selection takes a held frame too");
  const none = publishPlan(frames, { pick: ["p1", "r1"] });
  ok(none.ids.length === 0 && none.pending === 1 && none.rejected === 1, "nothing approved in the pick: nothing goes");
  ok(publishPlan([]).ids.length === 0, "no frames: empty plan");
  // Nov 7 2026 (the business-4585 Example Vista Way): frames marked published on a shoot that
  // was never published are waiting, not live, so Publish sends them.
  const neverPublished = publishPlan(frames, { shootPublished: false });
  ok(neverPublished.ids.join(",") === "a1,a2,live" && neverPublished.live === 0, `unpublished shoot: a published-marked approved frame goes (${JSON.stringify(neverPublished)})`);
  ok(!neverPublished.ids.includes("rlive") && !neverPublished.ids.includes("held"), "unpublished shoot: rejected and held still stay back");
  const pickedNever = publishPlan(frames, { pick: ["live"], includeHeld: true, shootPublished: false });
  ok(pickedNever.ids.join(",") === "live", "unpublished shoot: a photo's own Publish sends a published-marked frame");
  ok(publishPlan(frames, { shootPublished: true }).ids.join(",") === "a1,a2", "published shoot: a published frame is live, nothing to send");
  const sr = readFileSync("src/components/admin/ShootReview.tsx", "utf8");
  ok((sr.match(/publishPlan\(/g) ?? []).length === (sr.match(/shootPublished: published/g) ?? []).length, "every publishPlan call on the shoot grid passes the shoot's published state");

  // ---- destination ----
  ok(defaultDestination(false) === "gallery", "first delivery goes to the main gallery");
  ok(defaultDestination(true) === "revised", "after the first delivery new photos default to Revised images");
  ok(DESTINATION_LABEL.revised === "Revised images" && DESTINATION_LABEL.gallery === "Main gallery", "destination labels");

  // ---- the button ----
  ok(publishLabel(47, "gallery") === "Publish 47 approved photos to the listing →", `bulk label: ${publishLabel(47, "gallery")}`);
  ok(publishLabel(1, "gallery") === "Publish 1 approved photo to the listing →", "singular label");
  ok(publishLabel(12, "revised") === "Publish 12 approved photos as Revised images →", `revised label: ${publishLabel(12, "revised")}`);
  ok(publishLabel(55, "gallery", { finals: true }) === "Publish 55 approved finals only →", `finals label: ${publishLabel(55, "gallery", { finals: true })}`);
  ok(publishLabel(1, "gallery", { finals: true }) === "Publish 1 approved final only →", "finals singular");
  ok(publishLabel(3, "revised", { fixed: true }) === "Publish 3 fixed as Revised images →", `fixed label: ${publishLabel(3, "revised", { fixed: true })}`);
  for (const s of [publishLabel(2, "gallery"), publishLabel(2, "revised"), publishLabel(2, "gallery", { finals: true }), publishLabel(2, "revised", { fixed: true })]) ok(noDashes(s), `no dashes in "${s}"`);

  // ---- the banner: what the client sees now, what stays back ----
  const b1 = publishedBanner({ live: 47, dest: "gallery", skipped: { rejected: 5, pending: 138 } });
  ok(b1 === "47 approved photos are now visible to the client on the listing page. 5 rejected and 138 unreviewed photos stay internal only.", `banner: ${b1}`);
  const b2 = publishedBanner({ live: 1, dest: "revised" });
  ok(b2 === "1 approved photo is now visible to the client in Revised images on the listing page.", `revised banner: ${b2}`);
  const b3 = publishedBanner({ live: 55, dest: "gallery", hidden: 30, skipped: { rejected: 4, pending: 0 } });
  ok(b3.includes("55 approved photos are now visible") && b3.includes("4 rejected photos stay internal only.") && b3.includes("The other 30 photos of this shoot moved to internal only."), `finals banner: ${b3}`);
  ok(!publishedBanner({ live: 3, dest: "gallery", skipped: { rejected: 0, pending: 0 } }).includes("stay internal"), "nothing skipped: no second sentence");
  ok(noDashes(b1) && noDashes(b3) && noDashes(NOTHING_APPROVED), "no dashes in the banners");
  ok(NOTHING_APPROVED.includes("never reach the client"), "the refusal says why");

  // ---- labels on the cards ----
  ok(VISIBILITY_LABEL.rejected.startsWith("Rejected") && /never visible/.test(VISIBILITY_LABEL.rejected), `rejected label: ${VISIBILITY_LABEL.rejected}`);
  ok(/approve to publish/.test(VISIBILITY_LABEL.pending), `pending label: ${VISIBILITY_LABEL.pending}`);
  ok(/never reaches the client/.test(VISIBILITY_HINT.rejected) && /no Publish sends it/.test(VISIBILITY_HINT.rejected), "rejected hint says no Publish sends it");

  // ---- the server: approved only, rejecting unpublishes, marks never refresh the page ----
  const publish = readFileSync("src/lib/frame-publish.ts", "utf8");
  ok(/rows\.filter\(\(r\) => r\.qcState === "approved"\)/.test(publish), "publishFrames keeps only approved rows");
  ok(!/set\(\{ qcState: "approved", published: true/.test(publish), "publishFrames no longer approves on the way out");
  ok(/throw new Error\(NOTHING_APPROVED\)/.test(publish), "publishFrames refuses when nothing is approved");
  ok(/set\(\{ revision: true \}\)[\s\S]*isNull\(schema\.media\.section\)/.test(publish), "destination revised flags main-gallery frames as revised, sections keep their place");
  ok(/skipped: \{ rejected: .*pending: /.test(publish), "publishFrames counts what it skipped");
  const actions = readFileSync("src/app/admin/actions.ts", "utf8");
  ok(/state === "rejected" \? \{ qcState: state, published: false \}/.test(actions), "rejecting a frame also sets published=false");
  ok(!/export async function publishShoot\b/.test(actions), "the all-at-once Publish that approved unreviewed frames is gone");
  const qcFn = actions.slice(actions.indexOf("export async function setFrameQc"), actions.indexOf("export async function approveAllFrames"));
  ok(!/revalidatePath\(`\/admin\/shoots\//.test(qcFn), "setFrameQc never revalidates the shoot page (that replayed the page fade over the opened photo)");
  ok(/revalidatePath\("\/portal"\)/.test(qcFn) && /wasLive\.length/.test(qcFn), "setFrameQc refreshes the client's gallery only when a live photo was pulled");
  const approveAll = actions.slice(actions.indexOf("export async function approveAllFrames"), actions.indexOf("// Publishing lives in"));
  ok(!/revalidatePath/.test(approveAll), "approveAllFrames never revalidates the page either");
  const waiting = readFileSync("src/lib/admin-data.ts", "utf8");
  ok(/m\.qcState === "approved" && !m\.published && !m\.held/.test(waiting), "the Photo QC board's waiting count is approved frames only");
  const page = readFileSync("src/app/admin/shoots/[id]/page.tsx", "utf8");
  ok(!/publishShoot/.test(page), "the shoot page no longer imports the old Publish");
  ok(/href="#publish"/.test(page), "the header jumps to the grid's Publish bar");
  ok(/f\.qcState === "approved" && \(!f\.published \|\| !shootPublished\) && !f\.held/.test(page), "the page counts approved-not-live as waiting, a published-marked frame on a never-published shoot included");

  // ---- the grid ----
  const grid = readFileSync("src/components/admin/ShootReview.tsx", "utf8");
  ok(/f\.qcState === "rejected" \? "rejected"/.test(grid), "a rejected frame lands in the Rejected section whatever else it is");
  ok(/k === "rejected" \? 9/.test(grid), "Rejected is the last section");
  ok(/useState<Set<SectionKey>>\(\(\) => new Set\(\["rejected"\]\)\)/.test(grid), "Rejected starts collapsed");
  ok(/className="sr-fold" data-open=/.test(grid) && /inert=\{shut\}/.test(grid), "sections fold through .sr-fold and are inert while shut");
  ok(/id="publish"/.test(grid) && /publishLabel\(plan\.ids\.length/.test(grid), "the Publish bar says how many approved photos go");
  ok(/f\.qcState === "approved" && canPublish \? \(/.test(grid), "a card's Publish button shows only on an approved photo");
  ok(/disabled=\{!publishable\}/.test(grid) && /"Approve to publish"/.test(grid) && /"Never visible"/.test(grid), "the opened photo cannot publish an unreviewed or rejected frame");
  ok(/Publish \{selPlan\.ids\.length\} approved/.test(grid), "the selection bar publishes its approved frames only");
  ok(/publish\(revFixedIds, \{ dest: "revised" \}\)/.test(grid), "revision fixes always publish as Revised images");
  ok(!/setMediaVisibility\(\{[^}]*to:\s*"client"/.test(grid) && !/to, via: "shoot"/.test(grid), "the grid never flips a frame to client visible around the approved-only publish");
  ok(/state === "rejected" \? \{ \.\.\.f, qcState: state, published: false \}/.test(grid), "rejecting in the grid takes the photo off the listing at once");

  // ---- the opened photo keeps its layer through a page transition ----
  const css = readFileSync("src/styles/admin-visibility.css", "utf8");
  ok(/\.srl \{[^}]*view-transition-name: srl-viewer/.test(css), ".srl has its own view-transition-name");
  ok(/::view-transition-group\(srl-viewer\) \{ z-index: 300; animation: none; \}/.test(css), "its group sits above the page swap and does not animate");
  ok(/::view-transition-old\(srl-viewer\) \{ display: none; \}/.test(css), "no ghost of the old photo");
  ok(/\.sr-fold\[data-open="false"\] \{ grid-template-rows: 0fr/.test(css) && /transition: grid-template-rows/.test(css), "the fold eases shut through grid rows");
  ok(/\.sr-section--rejected/.test(css), "the Rejected section has its own tint");

  // ---- the opened photo is the big one (Nov 2 2026: "the previews are very, very, very tiny") ----
  ok(/\[f\.largeUrl, demo \? null : `\/api\/studio\/frame\/\$\{f\.id\}\?size=large`/.test(grid), "the opened photo starts from the 2048px derivative, not the thumb");
  ok(/largeUrl: hasR2\(\) \? await signedViewUrl\(derivativeKey\(m\.r2Key, "mls"\)\)/.test(waiting) && /fullUrl: hasR2\(\) \? await signedViewUrl\(m\.r2Key\)/.test(waiting), "the shoot page signs the 2048px derivative and the original per frame");
  ok(/\.srl \.amg-lb__frame img \{ width: 100%; height: 100%;[^}]*object-fit: contain/.test(css), "the photo fills the stage, letterboxed");
  ok(/className=\{`srl-zoom/.test(grid) && /\?size=full`/.test(grid) && /img\.naturalWidth \/ \(window\.devicePixelRatio \|\| 1\)/.test(grid), "Z or a click shows the original at one image pixel per screen pixel");
  ok(/e\.key === "Escape" && zoom/.test(grid) && /addEventListener\("keydown", onKey, true\)/.test(grid), "Escape leaves the zoom before it closes the viewer");
  const frameRoute = readFileSync("src/app/api/studio/frame/[mediaId]/route.ts", "utf8");
  ok(/requireStaffApi\(\)/.test(frameRoute) && /derivativeKey\(m\.r2Key, "mls"\)/.test(frameRoute) && /makeMls\(body\)/.test(frameRoute), "the frame route is staff only and builds a missing 2048px derivative");

  // ---- submit without the files that never landed (Nov 2 2026, 20 Dogwood) ----
  const wizard = readFileSync("src/components/admin/UploadWizard.tsx", "utf8");
  const submitRoute = readFileSync("src/app/api/studio/shoots/[id]/submit/route.ts", "utf8");
  const discard = readFileSync("src/lib/discard-upload.ts", "utf8");
  ok(/Submit without the \{leaveOut\}/.test(wizard) && /window\.confirm\(`Submit without \$\{what\}/.test(wizard), "the upload page offers Submit without the failed files, behind a confirm that names them");
  ok(/void submit\(\{ dropMissing: true \}\)/.test(wizard) && /\.\.\.\(opts\.dropMissing \? \{ dropMissing: true \} : \{\}\)/.test(wizard), "that button is the only caller of dropMissing");
  ok(/b\.dropMissing === true/.test(submitRoute) && /dropMissingFiles\(id, landed\.missing\)/.test(submitRoute), "the submit route drops only the files storage says are missing");
  ok(/const h = await headObject\(r\.r2Key\);\s*if \(!h \|\| h\.size === 0\) gone\.push/.test(discard) && !/deleteObject/.test(discard.slice(discard.indexOf("export async function dropMissingFiles"))), "dropMissingFiles checks storage again and never deletes an object");
  ok(/\.\.\.\(dropped\.length \? \{ dropped \} : \{\}\)/.test(submitRoute), "the dropped names go into the activity row");
  ok(/const BACKOFF = \[1500, 4000, 9000, 20000, 40000\]/.test(wizard), "a file gets five tries over about a minute before it fails");

  // ---- the client's gallery ----
  const portal = readFileSync("src/components/PortalGallery.tsx", "utf8");
  ok(/Revised images · \{g\.revisedPhotos\.length\}/.test(portal), "the client sees a Revised images section");

  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
