// Checks for the shoot's revision round (Oct 30 2026, src/lib/revision-frames.ts):
// which photos a client's revision puts at the top of the shoot page, and
// whether each is waiting for the fix, fixed and ready to check, or live.
//
//   npx tsx scripts/check-revision-frames.ts
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
  const { computeRound } = await import("../src/lib/revision-frames");
  const S = "11111111-2222-3333-4444-555555555555";
  const t = (h: number) => new Date(Date.UTC(2026, 9, 29, h));
  const frames = [
    { id: "f1", filename: "1656-Pine-01.jpg", published: true },
    { id: "f2", filename: "1656-Pine-02.jpg", published: false },
    { id: "f3", filename: "1656-Pine-03.jpg", published: true },
    { id: "f4", filename: "1656-Pine-04.jpg", published: false },
  ];
  const req = (o: Partial<Parameters<typeof computeRound>[2][number]>) => ({ id: "r1", status: "new" as const, clientEmail: "agent@example.com", clientName: "Agent", submittedAt: t(10), source: null, filenames: null, items: [], ...o });

  // ---- named photos: waiting, fixed, live ----
  const r1 = computeRound(S, frames, [req({ items: [{ mediaId: "f1", filename: "x", note: "Brighter kitchen" }, { mediaId: "f2", filename: "y", note: "Remove the hose" }, { mediaId: "f3", filename: "z", note: "Straighten" }] })], [
    { mediaId: "f2", at: t(12), activityId: "a2" },
    { mediaId: "f3", at: t(13), activityId: "a3" },
  ]);
  ok(r1 && r1.total === 3, "three named photos in the round");
  ok(r1?.frames.f1 && !r1.frames.f1.fixedAt, "no fix uploaded: waiting");
  ok(r1?.frames.f2?.fixedAt && !r1.frames.f2.live, "replaced after the ask, not live: fixed, ready to check");
  ok(r1?.frames.f3?.fixedAt && r1.frames.f3.live, "replaced after the ask and published: live");
  ok(r1?.waiting === 1 && r1.fixed === 1 && r1.live === 1, "counts: 1 waiting, 1 fixed, 1 live");
  ok(r1?.frames.f2?.notes[0] === "Remove the hose", "the client's note rides with the photo");
  ok(r1?.frames.f2?.beforeHref === `/api/studio/shoots/${S}/download?replaced=a2&view=1`, "before = the replaced file, shown inline");
  ok(!r1?.frames.f4, "a photo nobody asked about stays out");
  ok(r1?.asks.length === 1 && r1.asks[0].id === "r1", "the open request is listed for Mark revision done");

  // ---- a replacement before the ask is not the fix ----
  const r2 = computeRound(S, frames, [req({ items: [{ mediaId: "f2", filename: "", note: "n" }] })], [{ mediaId: "f2", at: t(9), activityId: "a0" }]);
  ok(r2?.frames.f2 && !r2.frames.f2.fixedAt && r2.waiting === 1, "replaced before the client asked: still waiting");

  // ---- the latest replacement counts ----
  const r3 = computeRound(S, frames, [req({ items: [{ mediaId: "f2", filename: "", note: "n" }] })], [{ mediaId: "f2", at: t(9), activityId: "old" }, { mediaId: "f2", at: t(14), activityId: "new" }]);
  ok(r3?.frames.f2?.beforeHref?.includes("replaced=new"), "the newest replacement is the fix");

  // ---- done requests ----
  const done = (items: { mediaId: string; filename: string; note: string }[]) => req({ status: "done", items });
  ok(computeRound(S, frames, [done([{ mediaId: "f1", filename: "", note: "n" }])], []) === null, "done and never fixed: gone");
  ok(computeRound(S, frames, [done([{ mediaId: "f3", filename: "", note: "n" }])], [{ mediaId: "f3", at: t(12), activityId: "a" }]) === null, "done and live: gone");
  const r4 = computeRound(S, frames, [done([{ mediaId: "f2", filename: "", note: "n" }])], [{ mediaId: "f2", at: t(12), activityId: "a" }]);
  ok(r4?.frames.f2?.fixedAt && r4.fixed === 1, "done but the fix is not live yet: it stays until published");
  ok(r4?.asks.length === 0, "a done request is not offered for Mark revision done again");

  // ---- matching by filename ----
  const r5 = computeRound(S, frames, [req({ items: [{ mediaId: null, filename: "1656-PINE-02.JPEG", note: "n" }], filenames: "1656-Pine-04.jpg" })], []);
  ok(r5?.frames.f2 && r5.frames.f4, "items and the filenames list match by name, any case or extension");

  // ---- a general request (no photo named) ----
  const r6 = computeRound(S, frames, [req({})], [
    { mediaId: "f2", at: t(12), activityId: "a" }, // replaced after, not live: in
    { mediaId: "f3", at: t(12), activityId: "b" }, // replaced after but live: out
    { mediaId: "f4", at: t(8), activityId: "c" }, // replaced before: out
  ]);
  ok(r6?.total === 1 && r6.frames.f2 && r6.asks[0]?.general, "general request: only frames fixed since it came in and not live");
  ok(computeRound(S, frames, [req({})], []) === null, "general request with nothing fixed yet: no section");

  // ---- unsent and elsewhere ----
  ok(computeRound(S, frames, [req({ submittedAt: null, items: [{ mediaId: "f1", filename: "", note: "n" }] })], []) === null, "a request the client has not sent yet is ignored");
  ok(computeRound(S, frames, [req({ items: [{ mediaId: "other", filename: "Elsewhere-09.jpg", note: "n" }] })], []) === null, "a request about another shoot's photos stays off this shoot");

  console.log(`${passes} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
