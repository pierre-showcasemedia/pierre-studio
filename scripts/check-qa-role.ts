// Checks for the team roles (admin, QA team, creative specialist, video
// editor) and the
// client visibility model (Oct 2026). No database, no network: runs in demo
// mode and refuses to run otherwise.
//
//   npx tsx scripts/check-qa-role.ts
//
// 1. The admin's "Client visible" (src/lib/visibility.ts) is exactly the
//    client rule (src/lib/media-visibility.ts) on every combination.
// 2. The reasons an internal frame gives.
// 3. Roles: env admins, the demo QA and creative logins, strangers, odd
//    stored values; which shoots a creative specialist may open.
// 4. What the QA team may read in an activity feed (no money, no clients).
// 5. The hub lines for the new activity rows are money-free and NDA-safe.
// 6. A static audit of every admin page, server action and studio route:
//    which gate it calls first (admin / staff / uploader / team / token),
//    against the expected map below. A new page, action or route with no
//    gate, or with the wrong one, fails here. The two "team" pages that
//    branch on the role (the dashboard, the shoot page) are checked for the
//    branch itself.
// 7. Every client-facing file that reads media goes through the client rule.
//
// The live counterpart (every page, route and action over HTTP against a
// demo dev server, as each role) is scripts/check-roles-http.mjs.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is demo mode only.");
  process.exit(2);
}
process.env.ADMIN_EMAILS = "boss@studio.test, second@studio.test";

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
  const { isClientVisibleRow, visibilityOf } = await import("../src/lib/visibility");
  const { clientVisibleMedia, isClientVisible } = await import("../src/lib/media-visibility");
  const { staffRole, isAdminAllowed, isStaffAllowed, toRole, creativeEmails, videoAssignees } = await import("../src/lib/admin-allow");
  const { mayOpenShoot, isStaffRole, isVideoRole, deniedPath } = await import("../src/lib/admin");
  const { qaMaySee, describeActivity } = await import("../src/lib/activity");
  const { hubActivityText, hubChannelFor } = await import("../src/lib/hub-activity");
  const { DEMO_SHOOTS, DEMO_CREATIVE_EMAIL, DEMO_VIDEO_EMAIL } = await import("../src/lib/demo-data");
  const { shooterSuggestions } = await import("../src/lib/admin-data");

  // ---- 1. same rule ----------------------------------------------------------
  const states = ["pending", "approved", "rejected"] as const;
  let combos = 0;
  for (const qcState of states)
    for (const published of [true, false])
      for (const held of [true, false])
        for (const shootId of [null, "s1"])
          for (const shootPublished of [true, false]) {
            combos++;
            const row = { qcState, published, held, shootId };
            const shoots = shootId ? [{ id: "s1", publishedAt: shootPublished ? new Date() : null }] : [];
            const client = clientVisibleMedia([row], shoots).length === 1;
            ok(client === isClientVisible(row, shoots), `isClientVisible agrees ${JSON.stringify(row)}`);
            ok(client === isClientVisibleRow(row, Boolean(shootId) && shootPublished), `same rule ${JSON.stringify({ ...row, shootPublished })}`);
            ok((visibilityOf(row, Boolean(shootId) && shootPublished) === "client") === client, `visibilityOf client ${JSON.stringify({ ...row, shootPublished })}`);
            // A held frame is never client visible in practice: held always comes with published=false.
            if (held && !published) ok(!client, `held + unpublished is internal ${JSON.stringify(row)}`);
          }
  console.log(`1. client rule: ${combos} combinations agree`);

  // ---- 2. reasons ------------------------------------------------------------
  const r = (qcState: "pending" | "approved" | "rejected", published: boolean, held: boolean, shootId: string | null, shootPublished: boolean) => visibilityOf({ qcState, published, held, shootId }, shootPublished);
  ok(r("approved", true, false, "s", true) === "client", "live shoot frame is client visible");
  ok(r("approved", true, false, null, false) === "client", "loose approved published file is client visible");
  ok(r("pending", false, false, "s", false) === "pending", "fresh editing output is not reviewed");
  ok(r("approved", false, true, "s", true) === "held", "held frame reads held back");
  ok(r("pending", false, true, "s", false) === "held", "held wins over pending");
  ok(r("approved", false, false, null, false) === "held", "loose hidden file reads held back");
  ok(r("rejected", false, false, "s", true) === "rejected", "rejected frame");
  ok(r("approved", false, false, "s", true) === "waiting", "corrected final waits for publish");
  ok(r("approved", true, false, "s", false) === "waiting", "approved frame on an unpublished shoot waits");
  console.log("2. reasons: ok");

  // ---- 3. roles --------------------------------------------------------------
  ok((await staffRole("boss@studio.test")) === "admin", "env admin is admin");
  ok((await staffRole("  SECOND@studio.test ")) === "admin", "env admin, any case and spacing");
  ok((await staffRole("qa@example.com")) === "qa", "demo QA login is qa");
  ok((await staffRole("stranger@example.com")) === null, "a stranger is not staff");
  ok((await staffRole(null)) === null, "no email is not staff");
  ok((await isAdminAllowed("qa@example.com")) === false, "QA is not an admin (view as, admin-only gates)");
  ok((await isStaffAllowed("qa@example.com")) === true, "QA may sign in to /admin");
  ok((await isAdminAllowed("boss@studio.test")) === true, "env admin is an admin");
  ok(toRole("admin") === "admin" && toRole("qa") === "qa" && toRole("ADMIN") === "qa" && toRole(null) === "qa" && toRole("owner") === "qa", "odd stored roles read as qa");
  // Creative specialists (Oct 21 2026).
  ok(toRole("creative") === "creative" && toRole("Creative") === "qa", "creative is a stored role; its odd spellings read as qa");
  ok((await staffRole(DEMO_CREATIVE_EMAIL)) === "creative", "demo creative login is creative");
  ok((await isStaffAllowed(DEMO_CREATIVE_EMAIL)) === true, "a creative specialist may sign in to /admin");
  ok((await isAdminAllowed(DEMO_CREATIVE_EMAIL)) === false, "a creative specialist is not an admin");
  ok((await creativeEmails()).join() === DEMO_CREATIVE_EMAIL, "creativeEmails lists the creative specialists only");
  const creative = { email: DEMO_CREATIVE_EMAIL.toUpperCase(), role: "creative" as const };
  const own = DEMO_SHOOTS.filter((s) => s.createdBy === DEMO_CREATIVE_EMAIL);
  const others = DEMO_SHOOTS.filter((s) => s.createdBy !== DEMO_CREATIVE_EMAIL);
  ok(own.length >= 2 && others.length >= 2, "demo has shoots the creative uploaded and shoots they did not");
  for (const s of own) ok(mayOpenShoot(creative, s.createdBy), `creative may open their own upload ${s.id} (any case)`);
  for (const s of others) ok(!mayOpenShoot(creative, s.createdBy), `creative may not open ${s.id} (uploaded by ${s.createdBy})`);
  ok(!mayOpenShoot(creative, null) && !mayOpenShoot(creative, ""), "creative may not open a shoot with no uploader");
  ok(mayOpenShoot({ email: "qa@example.com", role: "qa" }, "nobody@example.com") && mayOpenShoot({ email: "boss@studio.test", role: "admin" }, null), "admins and the QA team open any shoot");
  // Video editors (Oct 26 2026): the Video board only.
  ok(toRole("video") === "video" && toRole("Video") === "qa", "video is a stored role; its odd spellings read as qa");
  ok((await staffRole(DEMO_VIDEO_EMAIL)) === "video", "demo video login is video");
  ok((await isStaffAllowed(DEMO_VIDEO_EMAIL)) === true && (await isAdminAllowed(DEMO_VIDEO_EMAIL)) === false, "a video editor may sign in to /admin and is not an admin");
  ok(!isStaffRole("video") && !isStaffRole("creative") && isStaffRole("qa") && isStaffRole("admin"), "staff gates let in admins and the QA team only");
  ok(isVideoRole("video") && isVideoRole("admin") && !isVideoRole("qa") && !isVideoRole("creative"), "the Video board lets in admins and video editors only");
  ok(deniedPath("video") === "/admin/video?denied=1", "a video editor is sent back to the Video board");
  ok(deniedPath("qa") === "/admin/photo-qc?denied=1", "the Photo QC team is sent back to the Photo QC board");
  ok(!mayOpenShoot({ email: DEMO_VIDEO_EMAIL, role: "video" }, DEMO_VIDEO_EMAIL), "a video editor never opens a shoot page");
  const va = await videoAssignees();
  ok(va.includes(DEMO_VIDEO_EMAIL) && va.includes("boss@studio.test") && !va.includes("qa@example.com") && !va.includes(DEMO_CREATIVE_EMAIL), "Video cards go to video editors and admins only");
  const suggested = await shooterSuggestions();
  ok(suggested[0] === DEMO_CREATIVE_EMAIL, `creative specialists come first in the shooter suggestions (got ${suggested[0]})`);
  console.log("3. roles: ok");

  // ---- 4. what QA reads ------------------------------------------------------
  const never = ["invoice.paid", "invoice.amount_set", "invoice.partially_refunded", "payment.webhook_rejected", "booking.created", "booking.canceled", "email.pay_link_sent", "email.booking_sent", "client.created", "client.updated", "client.deleted", "team.created", "admin.added", "admin.role_set", "admin.view_as", "listing.locked", "listing.unlocked", "listing.delivery_email", "listing.updated", "listing.deleted", "client.downloaded", "job.dead"];
  for (const a of never) ok(!qaMaySee(a), `QA never reads ${a}`);
  for (const a of ["shoot.published", "shoot.ready", "media.visibility", "media.replaced", "media.qc", "listing.cover", "client.revision_requested"]) ok(qaMaySee(a), `QA reads ${a}`);
  ok(describeActivity({ action: "media.visibility", actorEmail: "qa@example.com", meta: { to: "client", count: 3, waiting: 1 } }).includes("qa@example.com"), "a QA action shows the QA email in the activity log");
  console.log("4. QA activity allowlist: ok");

  // ---- 5. hub lines ----------------------------------------------------------
  const place = { listing: { address: "1420 Example Alder Drive, Springfield, CA", nda: false }, clientEmail: "agent@example.com" };
  const nda = { listing: { address: "35 Hideaway Example Lane, Springfield, CA", nda: true }, clientEmail: "agent@example.com" };
  const visLine = hubActivityText({ action: "media.visibility", actorEmail: "qa@example.com", meta: { to: "internal", count: 2, filenames: ["35-Secret-Lane-01.jpg"] } }, nda) ?? "";
  ok(visLine.includes("an NDA listing") && !visLine.includes("Hideaway") && !visLine.includes(".jpg"), `NDA visibility line stays anonymous: ${visLine}`);
  ok(/client visible/i.test(hubActivityText({ action: "media.visibility", actorEmail: "qa@example.com", meta: { to: "client", count: 1, waiting: 0 } }, place) ?? ""), "client visible hub line");
  ok(/on photo QC/.test(hubActivityText({ action: "admin.role_set", actorEmail: "boss@studio.test", meta: { email: "qa@example.com", role: "qa", from: "admin" } }, { listing: null, clientEmail: null }) ?? ""), "role hub line");
  const creativeLine = hubActivityText({ action: "admin.role_set", actorEmail: "boss@studio.test", meta: { email: "shooter@example.com", role: "creative", from: "qa" } }, { listing: null, clientEmail: null }) ?? "";
  ok(/a creative specialist/.test(creativeLine) && /was photo QC/.test(creativeLine), `creative role hub line: ${creativeLine}`);
  ok(/Creative specialist access/.test(hubActivityText({ action: "admin.added", actorEmail: "boss@studio.test", meta: { email: "shooter@example.com", role: "creative" } }, { listing: null, clientEmail: null }) ?? ""), "creative added hub line");
  ok(/a creative specialist \(was admin\)/.test(describeActivity({ action: "admin.role_set", actorEmail: "boss@studio.test", meta: { email: "x@example.com", role: "creative", from: "admin" } })), "creative role feed line");
  ok(hubChannelFor({ action: "media.visibility" }) === "hub" && hubChannelFor({ action: "admin.role_set" }) === "hub", "both new rows post to the hub");
  for (const t of [visLine]) ok(!/\$\d/.test(t), "hub lines carry no dollar amounts");
  // One line per upload (Oct 26 2026, src/lib/upload-runs.ts): a run's batches are quiet.
  const { hubActivityLine } = await import("../src/lib/hub-activity");
  const { sumBatches, cleanRun } = await import("../src/lib/upload-runs");
  const run = "0f2c8a9e-1111-4a2b-9c3d-123456789abc";
  ok(hubChannelFor({ action: "media.uploaded", meta: { count: 6, run } }) === null && hubChannelFor({ action: "media.finals_uploaded", meta: { replaced: 2, run } }) === null, "an upload's batches post nothing on their own");
  ok(hubChannelFor({ action: "media.uploaded", meta: { count: 6 } }) === "hub", "an upload with no run still posts its line (older clients)");
  ok(hubChannelFor({ action: "media.visibility", meta: { via: "upload", to: "client", count: 3 } }) === null, "frames made visible by an upload are part of its one line");
  ok(hubChannelFor({ action: "media.upload_finished", meta: { run } }) === "hub", "the run's summary posts to the hub");
  const tot = sumBatches([{ action: "media.uploaded", meta: { added: 6, replaced: 0 } }, { action: "media.uploaded", meta: { added: 4, replaced: 2 } }, { action: "media.finals_uploaded", meta: { added: 0, replaced: 3 } }]);
  ok(tot.added === 10 && tot.replaced === 2 && tot.corrected === 3 && tot.landed === 15, `batches add up (${JSON.stringify(tot)})`);
  ok(cleanRun(run) === run && cleanRun("x") === null && cleanRun("a b c d e f g h") === null && cleanRun(5) === null, "run ids are checked");
  const ortega = { listing: { address: "2320 Example Fir Road, Springfield, CA", nda: false }, clientEmail: null, link: "<link|Open the listing>" };
  const done = hubActivityLine({ action: "media.upload_finished", actorEmail: "owner@example.com", meta: { run, landed: 25, added: 25, total: 25, failed: 0, published: true } }, ortega, "production") ?? "";
  ok(done === "Upload finished: 2320 Example Fir Road, 25 files, client visible. By owner@example.com. <link|Open the listing>", `one clean line: ${done}`);
  const mixed = hubActivityLine({ action: "media.upload_finished", actorEmail: "j@x.com", meta: { run, landed: 8, added: 5, replaced: 3, total: 8, failed: 0, published: false, section: "Twilight" } }, ortega, "production") ?? "";
  ok(/8 files \(5 new, 3 replaced\) to Twilight, internal only/.test(mixed) && !mixed.startsWith(":exclamation:"), `new and replaced counted, plain: ${mixed}`);
  const partly = hubActivityLine({ action: "media.upload_finished", actorEmail: "j@x.com", meta: { run, landed: 23, added: 23, total: 25, failed: 2, failedNames: ["Twilight-07.jpg", "Twilight-09.jpg"], published: true } }, ortega, "production") ?? "";
  ok(partly.startsWith(":exclamation: *Upload finished with problems") && /23 of 25 files went in/.test(partly) && /2 failed: Twilight-07\.jpg, Twilight-09\.jpg/.test(partly), `partial upload is flagged with the names: ${partly}`);
  const failedAll = hubActivityLine({ action: "media.upload_finished", actorEmail: "j@x.com", meta: { run, landed: 0, total: 6, failed: 6, failedNames: ["a.jpg"], firstError: "Network error" } }, ortega, "production") ?? "";
  ok(failedAll.startsWith(":exclamation: *Upload failed") && /none of 6 files went in \(Network error\)/.test(failedAll), `a failed upload is flagged: ${failedAll}`);
  const stopped = hubActivityLine({ action: "media.upload_finished", actorEmail: "j@x.com", meta: { run, landed: 12, added: 12, stopped: true } }, ortega, "production") ?? "";
  ok(stopped.startsWith(":exclamation: *Upload stopped before it finished") && /12 files went in/.test(stopped), `a stopped upload is flagged: ${stopped}`);
  const ndaFail = hubActivityLine({ action: "media.upload_finished", actorEmail: "j@x.com", meta: { run, landed: 3, total: 4, failed: 1, failedNames: ["35-Hideaway-Example-Lane-01.jpg"], section: "Hideaway" } }, { ...nda, link: "<l|x>" }, "production") ?? "";
  ok(/an NDA listing/.test(ndaFail) && !/Hideaway/.test(ndaFail), `NDA upload line names nothing: ${ndaFail}`);
  console.log("5. hub lines: ok");

  // ---- 6. gate audit ---------------------------------------------------------
  const walk = (dir: string, match: (f: string) => boolean, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, match, out);
      else if (match(p)) out.push(p);
    }
    return out;
  };
  const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
  // admin: full admins. staff: admins and the QA team. uploader: admins and
  // creative specialists (the upload flow). team: anyone on the team (the
  // page then branches on the role). token: operator secret.
  // video: admins and video editors (the Video board, Oct 26 2026).
  type Gate = "admin" | "staff" | "uploader" | "video" | "team" | "token" | "none";
  // Comments mention gates too: judge the code only.
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const firstGate = (raw: string): Gate => {
    const src = code(raw);
    const m = /\b(requireAdmin|assertAdmin|requireAdminApi|who|requireStaff|assertStaff|requireStaffApi|requireStaffOrTokenApi|requireListingUploaderApi|whoStaff|requireUploader|assertUploader|requireUploaderApi|requireVideo|assertVideo|requireVideoApi|requireTeam|requireScorecard|assertScorecard)\(/.exec(src);
    // The listing upload routes: staff and the token, plus a video editor
    // for films only (checked in the route; see the asserts below).
    if (m?.[1] === "requireListingUploaderApi") return "staff";
    if (m) return /Uploader/.test(m[1]) ? "uploader" : /Video/.test(m[1]) ? "video" : /Team/.test(m[1]) ? "team" : /Staff/.test(m[1]) ? "staff" : "admin";
    // Operator routes: the migrate token (directly or through the payments
    // harness guard, src/lib/payments-test.ts testGuard), the cron secret, the
    // website's intake secret.
    if (/x-migrate-token|MIGRATE_TOKEN|CRON_SECRET|BOOKING_INTAKE_SECRET|x-intake-secret|\btestGuard\(|\bhasMigrateToken\(|\bhasCronSecret\(/.test(src)) return "token";
    return "none";
  };
  const table: { kind: string; name: string; gate: Gate; want: Gate }[] = [];

  // Pages (and the layout).
  // Oct 26 2026: the Photo QC team (role qa) has two tabs, Photo QC and
  // Revisions, plus the shoot and listing pages they open from there; the
  // shoot and listing lists are admin only.
  const STAFF_PAGES = new Set(["src/app/admin/photo-qc/page.tsx", "src/app/admin/revisions/page.tsx", "src/app/admin/listings/[id]/page.tsx"]);
  // The layout (shell only), the dashboard (sends a creative specialist on to
  // Upload a shoot, the QA team to its own dashboard) and the shoot page (a
  // creative specialist opens only their own upload, read only). Nov 3 2026:
  // Team SOPs (the list and one page per SOP), every SOP for every role
  // (the owner: "make SOPs tab visible to everyone, all SOPs").
  const TEAM_PAGES = new Set(["src/app/admin/layout.tsx", "src/app/admin/page.tsx", "src/app/admin/shoots/[id]/page.tsx", "src/app/admin/sops/page.tsx", "src/app/admin/sops/[slug]/page.tsx"]);
  const UPLOADER_PAGES = new Set(["src/app/admin/upload/page.tsx"]);
  const VIDEO_PAGES = new Set(["src/app/admin/video/page.tsx", "src/app/admin/video/[id]/page.tsx"]);
  for (const f of walk(path.join(ROOT, "src/app/admin"), (p) => /(page|layout)\.tsx$/.test(p))) {
    const name = rel(f);
    const src = readFileSync(f, "utf8");
    const body = src.slice(src.indexOf("export default"));
    table.push({ kind: "page", name, gate: firstGate(body), want: STAFF_PAGES.has(name) ? "staff" : TEAM_PAGES.has(name) ? "team" : UPLOADER_PAGES.has(name) ? "uploader" : VIDEO_PAGES.has(name) ? "video" : "admin" });
    // The two "team" pages that render must branch on the role themselves.
    if (name === "src/app/admin/page.tsx") {
      ok(/role === "creative"\)\s*redirect\(/.test(code(body)), "the dashboard sends a creative specialist to Upload a shoot before reading anything");
      ok(/role === "video"\)\s*redirect\("\/admin\/video"\)/.test(code(body)), "the dashboard sends a video editor to the Video board before reading anything");
      ok(/role !== "admin"\)\s*redirect\("\/admin\/photo-qc"\)/.test(code(body)) && code(body).indexOf('redirect("/admin/photo-qc")') < code(body).indexOf("adminDashboard("), "the dashboard sends the Photo QC team to its board before reading anything");
    }
    // Team SOPs read only the SOP files (src/lib/sops.ts, src/content/sops):
    // no database, so a team gate opens nothing else.
    if (name.startsWith("src/app/admin/sops/")) ok(!/from "@\/(db"|lib\/admin-data|lib\/admin-crud)/.test(src), `${name} reads only the SOP files`);
    if (name === "src/app/admin/shoots/[id]/page.tsx") {
      const c = code(body);
      ok(/role === "video"\)\s*redirect\(VIDEO_DENIED_PATH\)/.test(c) && c.indexOf("VIDEO_DENIED_PATH)") < c.indexOf("adminShootDetail("), "the shoot page sends a video editor away before reading anything");
      ok(/if \(!mayOpenShoot\(staff, shoot\.createdBy\)\) redirect\(CREATIVE_DENIED_PATH\)/.test(c), "the shoot page checks mayOpenShoot before rendering");
      ok(/role === "creative"\) return <CreativeShootView/.test(c), "the shoot page gives a creative specialist the read-only view");
      ok(c.indexOf("mayOpenShoot(") < c.indexOf("<section"), "the ownership check comes before any markup");
    }
  }

  // Server actions: every exported async function of a "use server" file.
  const STAFF_ACTIONS = new Set([
    // Nov 2 2026: actions.publishShoot is gone; publishing is frame-actions.publishShootFrames, approved frames only.
    "actions.setCover", "actions.setFrameQc", "actions.approveAllFrames", "actions.runShootNow", "actions.rerunQc", "actions.approvePendingForListing",
    "crud-actions.rebuildBundles", "crud-actions.updateMedia", "crud-actions.updateMediaInline", "crud-actions.reorderMedia", "crud-actions.bulkMedia", "crud-actions.bulkMediaInline",
    "visibility-actions.setMediaVisibility",
    // Oct 28 2026: publish chosen frames now (delete stays admin only).
    "frame-actions.publishShootFrames",
    // Oct 28 2026: Make twilight on an opened frame (the coordinator).
    "twilight-actions.makeFrameTwilight",
    // Oct 26 2026: the Photo QC team works the photo revisions.
    "actions.setRevisionStatus", "actions.setRevisionKind",
    // Oct 30 2026: Mark revision done on the shoot page's revision round.
    "actions.markRevisionsDone",
    // Nov 2 2026: tick an automatic QC flag done on an opened photo (the coordinator).
    "qc-fix-actions.setQcFixDone",
    // Nov 6 2026: the Photo QC status bar on every card (the coordinator).
    "photo-qc-actions.setPhotoQcStatus",
  ]);
  // The one action a creative specialist may call: the upload wizard's listing picker.
  const UPLOADER_ACTIONS = new Set(["upload-actions.pickListings"]);
  // The Video board's actions (src/app/admin/video/actions.ts): admins and
  // video editors, except adding or removing a card (admin only).
  const VIDEO_ACTIONS = new Set(["video/actions.moveVideoCard", "video/actions.moveVideoCardForm", "video/actions.assignVideoCard", "video/actions.saveVideoEditorNotes", "video/actions.saveClientVideoNotes"]);
  // An action whose gate sits in the function it calls first.
  const VIA: Record<string, string> = { "actions.createListing": "createListingInline", "video/actions.moveVideoCardForm": "moveVideoCard" };
  for (const f of walk(path.join(ROOT, "src/app"), (p) => /\.ts$/.test(p) && readFileSync(p, "utf8").trimStart().startsWith('"use server"'))) {
    const src = readFileSync(f, "utf8");
    // Two files are called actions.ts: the board's is "video/actions".
    const mod = rel(f) === "src/app/admin/video/actions.ts" ? "video/actions" : path.basename(f, ".ts");
    const fns = [...src.matchAll(/export async function (\w+)\s*\(/g)];
    fns.forEach((m, i) => {
      const end = i + 1 < fns.length ? fns[i + 1].index! : src.length;
      let body = src.slice(m.index! + m[0].length, end);
      const via = VIA[`${mod}.${m[1]}`];
      if (via) {
        const at = src.indexOf(`export async function ${via}(`);
        body = src.slice(at, src.indexOf("\nexport ", at + 10));
      }
      const key = `${mod}.${m[1]}`;
      table.push({ kind: "action", name: key, gate: firstGate(body), want: STAFF_ACTIONS.has(key) ? "staff" : UPLOADER_ACTIONS.has(key) ? "uploader" : VIDEO_ACTIONS.has(key) ? "video" : "admin" });
    });
  }

  // Studio routes.
  const STAFF_ROUTES = [/^src\/app\/api\/studio\/thumb\//, /^src\/app\/api\/studio\/frame\//, /^src\/app\/api\/studio\/shoots\/\[id\]\/(download|status|finals)\//, /^src\/app\/api\/studio\/listings\/\[id\]\//];
  // The upload flow: admins and creative specialists.
  const UPLOADER_ROUTES = [/^src\/app\/api\/studio\/(import-dropbox|import-drive|upload-urls|upload-status|upload-landed|upload-discard|models)\//, /^src\/app\/api\/studio\/shoots\/\[id\]\/submit\//];
  // Reports (Oct 21 2026): the CSV downloads carry money; admins only.
  // Dropbox connect and callback (Oct 21 2026): an admin session (the
  // callback also checks the signed state); the operator check stays token.
  // Nov 24 2026: intake-file opens a file a client attached to a booking (admins only).
  const ADMIN_ROUTES = [/^src\/app\/api\/studio\/reports\//, /^src\/app\/api\/studio\/dropbox\/(connect|callback)\//, /^src\/app\/api\/studio\/drive\/(connect|callback)\//, /^src\/app\/api\/studio\/intake-file\//];
  for (const f of walk(path.join(ROOT, "src/app/api/studio"), (p) => p.endsWith("route.ts"))) {
    const name = rel(f);
    const want: Gate = STAFF_ROUTES.some((re) => re.test(name)) ? "staff" : UPLOADER_ROUTES.some((re) => re.test(name)) ? "uploader" : ADMIN_ROUTES.some((re) => re.test(name)) ? "admin" : "token";
    table.push({ kind: "route", name, gate: firstGate(readFileSync(f, "utf8")), want });
  }
  for (const t of table) ok(t.gate === t.want, `${t.kind} ${t.name}: gate ${t.gate}, expected ${t.want}`);
  ok(table.some((t) => t.kind === "page" && t.name === "src/app/admin/reports/page.tsx" && t.gate === "admin"), "the reports page is admin only");
  ok(table.some((t) => t.kind === "route" && /reports/.test(t.name) && t.gate === "admin"), "the reports CSV route is admin only");
  // The Dropbox raw mirror (Oct 21 2026): connect and callback are admin
  // session routes, the operator check is token, the two actions are admin
  // only, and the callback refuses a state that is not the admin's own.
  ok(table.some((t) => t.kind === "route" && /dropbox\/connect/.test(t.name) && t.gate === "admin"), "dropbox connect is an admin session route");
  ok(table.some((t) => t.kind === "route" && /dropbox\/callback/.test(t.name) && t.gate === "admin"), "dropbox callback is an admin session route");
  ok(table.some((t) => t.kind === "route" && /dropbox\/check/.test(t.name) && t.gate === "token"), "dropbox check is an operator token route");
  ok(table.some((t) => t.kind === "action" && t.name === "dropbox-actions.disconnectDropbox" && t.gate === "admin"), "disconnectDropbox is admin only");
  ok(table.some((t) => t.kind === "action" && t.name === "dropbox-actions.mirrorShootAgain" && t.gate === "admin"), "mirrorShootAgain is admin only");
  const cb = code(readFileSync(path.join(ROOT, "src/app/api/studio/dropbox/callback/route.ts"), "utf8"));
  ok(/verifyDropboxState\(state, admin\)/.test(cb) && cb.indexOf("requireAdminApi(") < cb.indexOf("verifyDropboxState("), "the callback checks the signed state for the signed-in admin, after the gate");
  ok(!/refreshToken|refresh_token/.test(code(readFileSync(path.join(ROOT, "src/app/admin/settings/page.tsx"), "utf8"))), "the settings page never touches the refresh token");
  // The Google Drive mirror (Nov 18 2026), the same rules: connect and callback
  // are admin session routes, the import is an uploader route, both actions are
  // admin only, the callback checks the admin's own signed state, and neither
  // the settings card nor the import ever touches a stored token.
  ok(table.some((t) => t.kind === "route" && /drive\/connect/.test(t.name) && t.gate === "admin"), "drive connect is an admin session route");
  ok(table.some((t) => t.kind === "route" && /drive\/callback/.test(t.name) && t.gate === "admin"), "drive callback is an admin session route");
  ok(table.some((t) => t.kind === "route" && /import-drive/.test(t.name) && t.gate === "uploader"), "the Google Drive import is an uploader route");
  ok(table.some((t) => t.kind === "action" && t.name === "drive-actions.disconnectDrive" && t.gate === "admin"), "disconnectDrive is admin only");
  ok(table.some((t) => t.kind === "action" && t.name === "drive-actions.driveShootAgain" && t.gate === "admin"), "driveShootAgain is admin only");
  const dcb = code(readFileSync(path.join(ROOT, "src/app/api/studio/drive/callback/route.ts"), "utf8"));
  ok(/verifyDriveState\(state, admin\)/.test(dcb) && dcb.indexOf("requireAdminApi(") < dcb.indexOf("verifyDriveState("), "the Drive callback checks the signed state for the signed-in admin, after the gate");
  ok(!/refreshToken|refresh_token|driveAccessToken/.test(code(readFileSync(path.join(ROOT, "src/components/admin/DriveSettingsCard.tsx"), "utf8"))), "the Drive card never touches a token");
  // Raw video never reaches editing: every file read in the pipeline goes
  // through the editing-kinds filter, and submit never flips a clip to display.
  const pipe = code(readFileSync(path.join(ROOT, "src/lib/pipeline.ts"), "utf8"));
  const fileReads = (pipe.match(/query\.shootFiles\.findMany\(/g) || []).length;
  const filtered = (pipe.match(/editingFilesWhere\(/g) || []).length;
  ok(fileReads > 0 && fileReads === filtered, `every shoot_files read in the pipeline is filtered to editing kinds (${filtered} of ${fileReads})`);
  const submit = code(readFileSync(path.join(ROOT, "src/app/api/studio/shoots/[id]/submit/route.ts"), "utf8"));
  ok(/set\(\{ kind: "display" \}\)\.where\(and\(eq\(schema\.shootFiles\.shootId, id\), eq\(schema\.shootFiles\.kind, "raw"\)\)\)/.test(submit), "submit's finished-JPGs switch only touches kind raw");
  ok(/videoOnly \? "video_only" : "uploaded"/.test(submit), "a video-only shoot goes to video_only, never to editing");
  // The video editor's cut upload: films only, on a listing with a Video
  // card, internal only, and never over a file already on the listing.
  const urls = code(readFileSync(path.join(ROOT, "src/app/api/studio/listings/[id]/upload-urls/route.ts"), "utf8"));
  const ingest = code(readFileSync(path.join(ROOT, "src/app/api/studio/listings/[id]/ingest/route.ts"), "utf8"));
  ok(/who\.video && !\(await listingHasVideoCard\(listing\.id\)\)/.test(urls) && /who\.video && !\(await listingHasVideoCard\(listing\.id\)\)/.test(ingest), "both upload routes refuse a video editor on a listing with no Video card");
  ok(/\(!isPhotoName\(asked\) \|\| who\.video\) && !isVideoName\(asked\)/.test(urls) && /!who\.video \|\| isVideoName\(f\)/.test(ingest), "a video editor uploads films only");
  ok(/published: !who\.video && b\.published === true/.test(ingest), "a video editor's cut always lands internal only");
  ok(/who\.video \? versionedFilename\(asked, \(n\) => seen\.has\(n\) \|\| taken\.has\(listingUploadKey\(/.test(urls), "a video editor never writes over a file already on the listing (a taken name gets the next version)");
  const by = (k: string, g: Gate) => table.filter((t) => t.kind === k && t.gate === g).length;
  console.log(`6. gate audit: ${table.length} entry points (pages ${by("page", "team")} team / ${by("page", "staff")} staff / ${by("page", "uploader")} uploader / ${by("page", "video")} video / ${by("page", "admin")} admin; actions ${by("action", "staff")} staff / ${by("action", "uploader")} uploader / ${by("action", "video")} video / ${by("action", "admin")} admin; studio routes ${by("route", "staff")} staff / ${by("route", "uploader")} uploader / ${by("route", "admin")} admin / ${by("route", "token")} token)`);
  if (process.argv.includes("--list")) for (const t of table) console.log(`   ${t.gate.padEnd(5)} ${t.kind.padEnd(6)} ${t.name}`);

  // ---- 7. client-facing media reads ------------------------------------------
  const CLIENT_DIRS = ["src/app/api/portal", "src/app/portal", "src/app/share", "src/components/gallery", "src/lib/portal-data.ts", "src/lib/bundles.ts", "src/lib/delivery-send.ts"];
  const GATED = /clientMediaWhere|clientVisibleMedia|isClientVisible|listingForEmail|listingForShareToken|listingsForEmail/;
  // Reads media on purpose, never hands it to a client: the reason is the value.
  const ALLOW: Record<string, string> = {
    "src/app/api/portal/admin-api/route.ts": "operator token route (x-migrate-token), not a client route",
    "src/app/api/portal/migrate/route.ts": "DDL only",
    "src/app/api/portal/bundle/[listingId]/[kind]/route.ts": "the first media row only anchors the download log; the zip itself is built from client-visible photos (src/lib/bundles.ts)",
  };
  const clientFiles = CLIENT_DIRS.flatMap((d) => {
    const p = path.join(ROOT, d);
    return statSync(p).isDirectory() ? walk(p, (x) => /\.(ts|tsx)$/.test(x)) : [p];
  });
  let readers = 0;
  for (const f of clientFiles) {
    const src = readFileSync(f, "utf8");
    if (!/schema\.media\b|query\.media\b|\bmedia: \{/.test(src)) continue;
    readers++;
    const name = rel(f);
    ok(GATED.test(src) || ALLOW[name], `client-facing ${name} reads media through the client rule`);
    if (process.argv.includes("--list")) console.log(`   ${GATED.test(src) ? "gated" : "allow"} ${name}${ALLOW[name] ? ` (${ALLOW[name]})` : ""}`);
  }
  console.log(`7. client-facing media reads: ${readers} files checked`);

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
