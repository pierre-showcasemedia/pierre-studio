// Checks for Merge shoot (Nov 5 2026, src/lib/merge-shoot.ts; the coordinator,
// 20 Dogwood): which frames stay (client visible today on either shoot)
// and which go, filename clashes in the kept set, the refusals, the notices,
// the cover and published time after a merge, the suggested shoot to keep,
// that every table naming a media id or a shoot id is handled, and that the
// merge never emails, posts to Slack or touches the calendar.
//
//   npx tsx scripts/check-merge-shoot.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
import { readFileSync } from "node:fs";
import path from "node:path";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is demo mode only.");
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
  const m = await import("../src/lib/merge-shoot");
  const { describeActivity } = await import("../src/lib/activity");
  type Frame = Parameters<typeof m.planKeep>[0][number];
  type Side = NonNullable<Parameters<typeof m.mergeShootRefusals>[0]["from"]>;

  const A = "00000000-0000-4000-8000-00000000000a"; // uploaded Nov 1, published
  const B = "00000000-0000-4000-8000-00000000000b"; // uploaded Nov 2, published
  let seq = 0;
  const frame = (over: Partial<Frame>): Frame => ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    shootId: A,
    filename: `20-Dogwood-${String(seq).padStart(2, "0")}.jpg`,
    r2Key: `shoots/x/${seq}.jpg`,
    kind: "photo",
    section: null,
    revision: false,
    sort: seq * 10,
    qcState: "approved",
    published: true,
    held: false,
    ...over,
  });
  const side = (over: Partial<Side>): Side => ({
    id: A,
    listingId: "L1",
    status: "published",
    createdBy: "owner@studio.test",
    submittedAt: "2026-11-02T03:00:00.000Z",
    createdAt: "2026-11-02T01:00:00.000Z",
    publishedAt: "2026-11-03T18:00:00.000Z",
    label: "the shoot uploaded Nov 1",
    nda: false,
    autohdrPhotoshootId: 1,
    fileCount: 120,
    frames: 0,
    clientVisible: 0,
    ...over,
  });

  // ---- 1. keep set: client visible today, on either shoot ------------------------
  const live1 = frame({ shootId: A });
  const live2 = frame({ shootId: B, section: "Twilight" });
  const liveRev = frame({ shootId: B, revision: true });
  const pending = frame({ shootId: A, qcState: "pending", published: false });
  const rejected = frame({ shootId: B, qcState: "rejected", published: false });
  const waiting = frame({ shootId: B, qcState: "approved", published: false, filename: "STUDIO-20-Dogwood-1.jpg" });
  const held = frame({ shootId: A, published: false, held: true });
  const onUnpublished = frame({ shootId: "C", qcState: "approved", published: true }); // shoot never published
  const all = [live1, live2, liveRev, pending, rejected, waiting, held, onUnpublished];
  const { kept, deleted } = m.planKeep(all, { [A]: true, [B]: true, C: false });
  ok(kept.map((k) => k.id).join() === [live1, live2, liveRev].map((k) => k.id).join(), "client visible frames of both shoots are kept (sections and revised included)");
  ok(deleted.length === 5, `everything else goes (${deleted.length})`);
  const vis = Object.fromEntries(deleted.map((x) => [x.id, x.visibility]));
  ok(vis[pending.id] === "pending" && vis[rejected.id] === "rejected" && vis[waiting.id] === "waiting" && vis[held.id] === "held", `each deleted frame says why it is internal (${JSON.stringify(Object.values(vis))})`);
  ok(vis[onUnpublished.id] === "waiting", "an approved, published frame on a never-published shoot is not client visible, so it is not kept");
  ok(m.planFingerprint(kept, deleted) === m.planFingerprint([...kept].reverse(), [...deleted].reverse()), "the fingerprint does not depend on order");
  ok(m.planFingerprint(kept, deleted) !== m.planFingerprint(kept.slice(1), [...deleted, kept[0]]), "the fingerprint changes when a frame changes sides");

  // ---- 2. clashes ------------------------------------------------------------------
  ok(m.keptClashes([{ filename: "A.jpg" }, { filename: "a.JPG" }, { filename: "b.jpg" }]).join() === "A.jpg", "two kept frames with one name (any case) clash");
  ok(m.keptClashes(kept).length === 0, "no clash in the sample keep set");

  // ---- 3. refusals -----------------------------------------------------------------
  const a = side({});
  const b = side({ id: B, label: "the shoot uploaded Nov 2", submittedAt: "2026-11-02T20:00:00.000Z" });
  ok(m.mergeShootRefusals({ from: a, into: b, kept: 3 }).length === 0, "two published shoots of one listing merge");
  ok(m.mergeShootRefusals({ from: a, into: a, kept: 3 }).some((r) => /itself/.test(r)), "the same shoot twice is refused");
  ok(m.mergeShootRefusals({ from: a, into: { ...b, listingId: "L2" }, kept: 3 }).some((r) => /different listings/.test(r)), "shoots of two listings are refused");
  ok(m.mergeShootRefusals({ from: { ...a, status: "processing" }, into: b, kept: 3 }).some((r) => /still in editing/.test(r)), "a shoot in editing is refused");
  ok(m.mergeShootRefusals({ from: a, into: { ...b, status: "draft" }, kept: 3 }).some((r) => /still uploading/.test(r)), "a shoot still uploading is refused");
  ok(m.mergeShootRefusals({ from: a, into: { ...b, status: "ready_for_review" }, kept: 3 }).length === 0, "a shoot ready for review merges");
  ok(m.mergeShootRefusals({ from: a, into: { ...b, status: "failed" }, kept: 3 }).length === 0, "a stopped shoot merges");
  ok(m.mergeShootRefusals({ from: a, into: b, kept: 0 }).some((r) => /keep no photos/.test(r)), "nothing client visible is refused");
  ok(m.mergeShootRefusals({ from: a, into: b, kept: 3, clashes: ["x.jpg"] }).some((r) => /x\.jpg/.test(r)), "a clash is refused and named");
  ok(m.mergeShootRefusals({ from: a, into: b, kept: 3, revisionConflicts: 2 }).some((r) => /revision notes are on photos/.test(r)), "revision notes on deleted frames refuse");
  ok(m.mergeShootRefusals({ from: a, into: b, kept: 3, revisionConflicts: 2, allowRevisionLoss: true }).length === 0, "allowRevisionLoss lifts only that");
  ok(m.mergeShootRefusals({ from: a, into: b, kept: 3, videoCommentConflicts: 1, allowRevisionLoss: true }).some((r) => /film comment/.test(r)), "film comments on a deleted film always refuse");
  ok(m.mergeShootRefusals({ from: null, into: b }).length === 1, "a missing shoot is refused");

  // ---- 4. published time, cover, suggestion ------------------------------------------
  ok(m.publishedAfter({ publishedAt: "2026-11-03T00:00:00.000Z" }, { publishedAt: null }) === "2026-11-03T00:00:00.000Z", "an unpublished kept shoot takes the merged shoot's publish time");
  ok(m.publishedAfter({ publishedAt: "2026-11-03T00:00:00.000Z" }, { publishedAt: "2026-11-04T00:00:00.000Z" }) === "2026-11-04T00:00:00.000Z", "a published kept shoot keeps its own");
  ok(m.coverAfterMerge(null, kept, deleted) === undefined, "no cover: nothing to change");
  ok(m.coverAfterMerge(live1.r2Key, kept, deleted) === undefined, "a kept cover stays");
  ok(m.coverAfterMerge(pending.r2Key, kept, deleted) === live1.r2Key, "a deleted cover becomes the first kept gallery photo");
  ok(m.coverAfterMerge(pending.r2Key, [], deleted) === null, "a deleted cover with nothing kept is cleared");
  const sug = m.suggestKeep([
    { id: A, clientVisible: 40, submittedAt: "2026-11-02T03:00:00.000Z", createdAt: "" },
    { id: B, clientVisible: 90, submittedAt: "2026-11-02T20:00:00.000Z", createdAt: "" },
  ]);
  ok(sug?.id === B, "the shoot with more client visible photos is suggested");
  ok(m.suggestKeep([{ id: B, clientVisible: 5, submittedAt: "2026-11-02", createdAt: "" }, { id: A, clientVisible: 5, submittedAt: "2026-11-01", createdAt: "" }])?.id === A, "a tie goes to the earlier upload");
  ok(m.shootLabel({ submittedAt: "2026-11-02T03:00:00.000Z", createdAt: "2026-11-02T01:00:00.000Z" }) === "the shoot uploaded Nov 1", "labels use the local day of the upload");

  // ---- 5. notices --------------------------------------------------------------------
  const counts = { from: { frames: 4, kept: 1, deleted: 3, files: 120, videoCards: 1, activity: 9, jobs: 2 }, into: { frames: 4, kept: 2, deleted: 2, files: 306, videoCards: 0, activity: 5, jobs: 0 } };
  const notes = m.mergeShootNotices({ from: a, into: b, counts, deletedBy: { client: 0, held: 1, rejected: 1, pending: 1, waiting: 2 }, movedFromMerged: 1, looseFiles: 3, staleJobs: 1, revisionConflicts: 0, coverAfter: undefined });
  ok(notes.some((n) => /3 client visible photos stay/.test(n)), "says how many photos stay");
  ok(notes.some((n) => /5 internal only frames are deleted/.test(n) && /files stay in storage/i.test(n)), "says how many frames go and that files stay");
  ok(notes.some((n) => /waiting for Publish/.test(n)), "warns about approved frames waiting for Publish");
  ok(notes.some((n) => /120 uploaded files/.test(n)) && notes.some((n) => /Video board card/.test(n)), "says the files and the Video card move");
  ok(notes.some((n) => /3 files on the listing/.test(n)), "says loose files are left alone");
  ok(notes.some((n) => /Nothing is emailed/.test(n) && /Slack/.test(n) && /calendar/.test(n)), "says no email, no Slack, no calendar");
  ok(notes.every((n) => !/—|--/.test(n)), "no em dashes or double hyphens in the notices");

  // ---- 6. every table naming a media id or a shoot id is handled ---------------------
  const ddl = readFileSync(path.join(ROOT, "src/app/api/portal/migrate/route.ts"), "utf8");
  const withCol = (col: string) => {
    const t = new Set<string>();
    for (const x of ddl.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)" \(([\s\S]*?)\)`/g)) if (new RegExp(`"${col}"`).test(x[2])) t.add(x[1]);
    for (const x of ddl.matchAll(new RegExp(`ALTER TABLE "(\\w+)" ADD COLUMN IF NOT EXISTS "${col}"`, "g"))) t.add(x[1]);
    return t;
  };
  const lib = readFileSync(path.join(ROOT, "src/lib/merge-shoot.ts"), "utf8");
  const code = lib.replace(/\/\/.*$/gm, "");
  const camel = (t: string) => t.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  const shootTables = withCol("shoot_id");
  ok(shootTables.size >= 3, `found the shoot_id tables (${[...shootTables].join(", ")})`);
  // photo_qc_picks (Nov 6 2026) cascades with the merged shoot, written down in the lib.
  for (const t of shootTables) ok(new RegExp(`(update|delete)\\(schema\\.${camel(t)}\\)`).test(code) || (t === "photo_qc_picks" && /photo_qc_picks\.shoot_id\s+FK, cascade/.test(lib)), `${t}.shoot_id is moved or deleted by the merge`);
  const mediaTables = withCol("media_id");
  ok(mediaTables.size >= 4, `found the media_id tables (${[...mediaTables].join(", ")})`);
  for (const t of mediaTables) ok(new RegExp(`schema\\.${camel(t)}\\b`).test(code) || /^\s*\/\/\s+qc_fix_checks/m.test(lib) && t === "qc_fix_checks", `${t}.media_id is handled by the merge`);
  ok(/qc_fix_checks\.media_id\s+FK, cascade/.test(lib), "the qc_fix_checks cascade is written down");
  ok(/payload->>'shootId'/.test(code), "job payloads naming the merged shoot are moved");

  // ---- 7. never an email, Slack or calendar; one batch --------------------------------
  const imports = (lib.match(/^import .*$/gm) ?? []).join("\n");
  const applyCode = lib.slice(lib.indexOf("// ---- apply")).replace(/\/\/.*$/gm, "");
  ok(lib.indexOf("// ---- apply") > 0 && applyCode.length > 1500, "found the apply section");
  ok(!/email|stripe|titus|resend|slack|calendar|logActivity|hub/i.test(imports), `the merge imports no email, Slack, calendar, payment or hub code (${imports.replace(/\n/g, " | ")})`);
  ok(!/"email\.|"slack\.|"calendar\.|"stripe\.|"titus\./.test(applyCode), "the apply queues no email, Slack line, calendar or payment job");
  ok(/d\.batch\(/.test(code) && (applyCode.match(/await d\.(update|insert|delete)\(/g) ?? []).length === 0, "every write goes through the one batch");
  ok(/action: "shoot\.merged"/.test(code), "the batch writes a shoot.merged activity row");
  const hub = readFileSync(path.join(ROOT, "src/lib/hub-activity.ts"), "utf8");
  ok(!/"shoot\.merged"/.test(hub), "shoot.merged is not a hub (Slack) action");
  const route = readFileSync(path.join(ROOT, "src/app/api/portal/admin-api/route.ts"), "utf8");
  ok(/op === "mergeShoot"/.test(route) && /apply: body\.apply === true/.test(route.slice(route.indexOf('op === "mergeShoot"'))), "the admin-api op is a dry run unless apply: true");

  // ---- 8. the activity line -------------------------------------------------------------
  const line = describeActivity({ action: "shoot.merged", actorEmail: "team@studio.test", meta: { from: { label: "the shoot uploaded Nov 1" }, kept: 92, deleted: 265 } });
  ok(line === "team@studio.test merged the shoot uploaded Nov 1 into this shoot (92 client visible photos kept, 265 internal frames deleted)", `activity line (${line})`);

  console.log(`check-merge-shoot: ${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
