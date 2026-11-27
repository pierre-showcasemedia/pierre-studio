// Checks the per-instance bounds on image work (src/lib/image-gate.ts), the
// one-decode derivatives (src/lib/derivatives.ts) and the browser's handling
// of a dropped call (src/lib/ingest-client.ts). No database, no storage, no
// network: photos are made in memory and fetch is faked.
//
//   npx tsx scripts/check-image-gate.ts
//
// Why: Nov 10 2026, 3330 Example Cedar Road. 100 MP finals ran the server instance
// out of memory, the platform answered with an HTML error page, and every file
// read "Unexpected token '<' ... is not valid JSON". What must stay true:
//   1. the gate never lets more than its budget run, in order, an oversize
//      job runs alone, and a job that throws gives its room back;
//   2. a decode costs its megapixels, double for a progressive JPEG;
//   3. derivatives come out the right sizes, upright, in sRGB, for baseline,
//      progressive, rotated, CMYK and grayscale photos, and match a straight
//      resize of the original;
//   4. many big photos asked for at once never decode past the budget;
//   5. a dropped call is never shown as a parse error, and ingest retries it
//      file by file until it goes in.
import sharp from "sharp";
import { Gate, PIXEL_BUDGET, imageGateState, pixelCost } from "../src/lib/image-gate";
import { makeDerivatives, makeThumb, makeMls } from "../src/lib/derivatives";
import { SERVER_DROPPED, ingestBatch, postJson, readJson } from "../src/lib/ingest-client";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A photo-like JPEG: a gradient with some texture, so it is not one flat colour.
async function photo(width: number, height: number, opts: { progressive?: boolean; orientation?: number; cmyk?: boolean; grey?: boolean } = {}): Promise<Buffer> {
  const tile = 256;
  const raw = Buffer.alloc(tile * tile * 3);
  for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
    const i = (y * tile + x) * 3;
    raw[i] = x;
    raw[i + 1] = y;
    raw[i + 2] = (x * 7 + y * 13) & 255;
  }
  const small = sharp(raw, { raw: { width: tile, height: tile, channels: 3 } }).resize(width, height, { fit: "fill", kernel: "cubic" });
  let img = opts.grey ? small.greyscale() : opts.cmyk ? small.toColourspace("cmyk") : small;
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return img.jpeg({ quality: 90, progressive: Boolean(opts.progressive) }).toBuffer();
}

async function meanDiff(a: Buffer, b: Buffer): Promise<number> {
  const [x, y] = await Promise.all([sharp(a).resize(64, 64, { fit: "fill" }).toColourspace("srgb").raw().toBuffer(), sharp(b).resize(64, 64, { fit: "fill" }).toColourspace("srgb").raw().toBuffer()]);
  let d = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) d += Math.abs(x[i] - y[i]);
  return d / Math.min(x.length, y.length);
}

async function main() {
  // ---- 1. the gate
  {
    const g = new Gate(125);
    let inUse = 0;
    let peak = 0;
    const order: number[] = [];
    const job = (id: number, cost: number, ms: number) =>
      g.run(cost, async () => {
        inUse += Math.min(125, cost);
        peak = Math.max(peak, inUse);
        order.push(id);
        await sleep(ms);
        inUse -= Math.min(125, cost);
      });
    // 100 (alone), then 61 + 61 together, then 24 x 5 together, then an oversize 400.
    await Promise.all([job(1, 100, 30), job(2, 61, 30), job(3, 61, 30), job(4, 24, 20), job(5, 24, 20), job(6, 24, 20), job(7, 24, 20), job(8, 24, 20), job(9, 400, 10), job(10, 1, 5)]);
    check("gate: never over its budget", peak <= 125, `peak ${peak}`);
    check("gate: first come, first served", order.join(",") === "1,2,3,4,5,6,7,8,9,10", order.join(","));
    check("gate: empty when done", g.inUse === 0 && g.waiting === 0);
    let threw = false;
    await g.run(125, async () => { throw new Error("boom"); }).catch(() => { threw = true; });
    check("gate: a job that throws gives its room back", threw && g.inUse === 0);
    let ran = false;
    await g.run(Number.NaN, async () => { ran = true; });
    check("gate: an unknown cost runs alone and finishes", ran && g.inUse === 0);
    // A big job waiting is not starved by small ones that would fit.
    const seq: string[] = [];
    const hold = g.run(100, async () => { seq.push("first"); await sleep(40); });
    const big = g.run(100, async () => { seq.push("big"); });
    const small = g.run(10, async () => { seq.push("small"); });
    await Promise.all([hold, big, small]);
    check("gate: a waiting big job goes before a later small one", seq.join(",") === "first,big,small", seq.join(","));
  }

  // ---- 2. what a decode costs
  check("cost: 12288 x 8192 is about 100", Math.round(pixelCost({ width: 12288, height: 8192 })) === 101);
  check("cost: progressive counts double", Math.round(pixelCost({ width: 12288, height: 8192, isProgressive: true })) === 201);
  check("cost: unknown size takes the whole budget", pixelCost({}) === PIXEL_BUDGET);
  check("budget: one 100 MP photo, or two 61 MP frames", PIXEL_BUDGET >= 122 && PIXEL_BUDGET < 200, String(PIXEL_BUDGET));

  // ---- 3. derivatives: sizes, orientation, colour, and the same picture
  const kinds: [string, Parameters<typeof photo>[2]][] = [["baseline", {}], ["progressive", { progressive: true }], ["rotated", { orientation: 6 }], ["cmyk", { cmyk: true }], ["grey", { grey: true }]];
  for (const [name, opts] of kinds) {
    const original = await photo(4200, 2800, opts);
    const d = await makeDerivatives(original, "listings/check/photos/a.jpg");
    const by = new Map(d.map((x) => [x.variant, x.buffer]));
    check(`${name}: five variants`, d.length === 5 && ["preview", "preview-wm", "thumb", "thumb-wm", "mls"].every((v) => by.has(v as never)));
    const want = { mls: 2048, preview: 1600, thumb: 600, "preview-wm": 1600, "thumb-wm": 600 } as const;
    for (const [v, edge] of Object.entries(want)) {
      const m = await sharp(by.get(v as never)!).metadata();
      const long = Math.max(m.width ?? 0, m.height ?? 0);
      check(`${name}: ${v} is ${edge}px on its long edge`, long === edge, `${m.width}x${m.height}`);
      check(`${name}: ${v} is a 3 channel sRGB JPEG`, m.format === "jpeg" && m.channels === 3 && m.space === "srgb", `${m.format} ${m.channels} ${m.space}`);
      const upright = opts?.orientation === 6 ? (m.height ?? 0) > (m.width ?? 0) : (m.width ?? 0) > (m.height ?? 0);
      check(`${name}: ${v} is upright`, upright, `${m.width}x${m.height}`);
      check(`${name}: ${v} carries no orientation tag`, !m.orientation || m.orientation === 1);
    }
    // The same picture as a straight resize of the original (the old way).
    const straight = await sharp(original, { failOn: "none" }).rotate().resize({ width: 1600, height: 1600, fit: "inside" }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    const diff = await meanDiff(by.get("preview")!, straight);
    check(`${name}: preview matches a straight resize`, diff < 1.5, `mean difference ${diff.toFixed(2)} of 255`);
    const t = await sharp(await makeThumb(original)).metadata();
    check(`${name}: makeThumb is 600px`, Math.max(t.width ?? 0, t.height ?? 0) === 600);
    const l = await sharp(await makeMls(original)).metadata();
    check(`${name}: makeMls is 2048px`, Math.max(l.width ?? 0, l.height ?? 0) === 2048);
  }
  // A small photo is never enlarged.
  {
    const d = await makeDerivatives(await photo(900, 600), "listings/check/photos/small.jpg");
    const m = await sharp(d.find((x) => x.variant === "mls")!.buffer).metadata();
    check("small photo: not enlarged", m.width === 900 && m.height === 600, `${m.width}x${m.height}`);
  }

  // ---- 4. many big photos at once stay inside the budget
  {
    const big = await photo(10000, 8000); // 80 MP
    const prog = await photo(10000, 8000, { progressive: true }); // costs the whole budget
    let peak = 0;
    let waited = 0;
    const watch = setInterval(() => {
      const s = imageGateState();
      peak = Math.max(peak, s.pixelsInUse);
      waited = Math.max(waited, s.pixelsWaiting);
    }, 2);
    const base = process.memoryUsage().rss;
    let top = base;
    const mem = setInterval(() => { top = Math.max(top, process.memoryUsage().rss); }, 5);
    const jobs = [big, big, prog, big, big, prog, big, big].map((b, i) => makeDerivatives(b, `listings/check/photos/big-${i}.jpg`));
    const out = await Promise.all(jobs);
    clearInterval(watch);
    clearInterval(mem);
    check("eight 80 MP photos at once: all made", out.every((d) => d.length === 5));
    check("eight 80 MP photos at once: never past the budget", peak <= PIXEL_BUDGET, `peak ${peak} of ${PIXEL_BUDGET}`);
    check("eight 80 MP photos at once: the rest waited their turn", waited >= 5, `most waiting ${waited}`);
    const grew = Math.round((top - base) / 1048576);
    // Loose on purpose (allocators differ): the old code needed over 3 GB for three progressive 100 MP photos.
    check("eight 80 MP photos at once: memory stays far under an instance", grew < 900, `grew ${grew} MB`);
    console.log(`4. eight 80 MP photos asked for at once: peak ${peak.toFixed(0)} of ${PIXEL_BUDGET} MP decoding, ${waited} waiting at most, memory grew ${grew} MB`);
  }

  // ---- 5. the browser side: a dropped call
  {
    const html = () => new Response("<!DOCTYPE html><html><body>An error occurred</body></html>", { status: 500, headers: { "content-type": "text/html" } });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    const r1 = await readJson(html());
    check("readJson: an HTML error page is a dropped call in plain words", r1.ok === false && r1.dropped === true && r1.error === SERVER_DROPPED && !/Unexpected token|DOCTYPE|JSON/i.test(r1.error ?? ""));
    const r2 = await readJson(json({ ok: false, error: "Shoot not found." }, 404));
    check("readJson: the route's own error comes through", r2.ok === false && !r2.dropped && r2.error === "Shoot not found.");
    const r3 = await readJson(json({ ok: false, error: "admin only" }, 401));
    check("readJson: signed out reads as signed out", /signed out/i.test(r3.error ?? ""));

    const realFetch = globalThis.fetch;
    const realTimeout = globalThis.setTimeout;
    // No real waiting in the check.
    (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as unknown;
    try {
      // postJson: dropped twice, then answered.
      let calls = 0;
      globalThis.fetch = (async () => (++calls < 3 ? html() : json({ ok: true, files: [] }))) as typeof fetch;
      const p = await postJson("/x", {}, { retries: 2 });
      check("postJson: retried until it answered", p.ok === true && calls === 3, `calls ${calls}`);
      calls = 0;
      globalThis.fetch = (async () => { calls++; return html(); }) as typeof fetch;
      const q = await postJson("/x", {});
      check("postJson: no retry unless asked", q.dropped === true && calls === 1);
      globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
      const off = await postJson("/x", {});
      check("postJson: offline reads as offline", off.ok === false && /connection/i.test(off.error ?? ""));

      // ingestBatch: the batch call dies, then each file goes in on its own;
      // one file needs a second try, one never answers.
      const tries = new Map<string, number>();
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        const files = (JSON.parse(String(init?.body)) as { files: string[] }).files;
        if (files.length > 1) return html();
        const f = files[0];
        const n = (tries.get(f) ?? 0) + 1;
        tries.set(f, n);
        if (f === "never.jpg") return html();
        if (f === "second-try.jpg" && n === 1) return html();
        if (f === "refused.jpg") return json({ ok: true, replaced: [], added: [], failed: [{ filename: f, error: "not a JPEG (png)" }] });
        return json({ ok: true, replaced: [{ filename: f, mediaId: `m-${f}` }], added: [], failed: [] });
      }) as typeof fetch;
      const r = await ingestBatch("/ingest", ["a.jpg", "second-try.jpg", "never.jpg", "refused.jpg"], { run: "check-run-1" });
      check("ingestBatch: a dropped batch still answers ok", r.ok === true);
      check("ingestBatch: the files that fit on their own went in", r.replaced.map((x) => x.filename).join(",") === "a.jpg,second-try.jpg", JSON.stringify(r.replaced));
      check("ingestBatch: a file is tried three times at most", tries.get("never.jpg") === 3 && tries.get("second-try.jpg") === 2 && tries.get("a.jpg") === 1, JSON.stringify([...tries]));
      const never = r.failed.find((x) => x.filename === "never.jpg");
      check("ingestBatch: a file that never goes in says so plainly", never?.error === SERVER_DROPPED);
      check("ingestBatch: the server's own refusal is kept", r.failed.find((x) => x.filename === "refused.jpg")?.error === "not a JPEG (png)");
      check("ingestBatch: nothing reads as a parse error", !JSON.stringify(r).match(/Unexpected token|DOCTYPE/));
      // A batch that answers is one call.
      let n = 0;
      globalThis.fetch = (async () => { n++; return json({ ok: true, replaced: [], added: [{ filename: "x.jpg", mediaId: "1" }], failed: [] }); }) as typeof fetch;
      const okBatch = await ingestBatch("/ingest", ["x.jpg", "y.jpg"], {});
      check("ingestBatch: a batch that answers is one call", n === 1 && okBatch.added.length === 1);
      // The route's own refusal (409, 404) is not retried.
      n = 0;
      globalThis.fetch = (async () => { n++; return json({ ok: false, error: "Finals can be uploaded once the frames are in." }, 409); }) as typeof fetch;
      const refused = await ingestBatch("/ingest", ["x.jpg", "y.jpg"], {});
      check("ingestBatch: the route's own refusal is not retried", n === 1 && refused.ok === false && /once the frames are in/.test(refused.error ?? ""));
    } finally {
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realTimeout;
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) FAILED:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nAll ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
