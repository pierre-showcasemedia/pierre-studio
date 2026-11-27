// Checks for the Google Drive mirror (Nov 18 2026). No database, no network,
// no real Google: a fake Drive answers the API client's fetch, and the copy
// engine runs against it with a fake clock. Refuses to run with DATABASE_URL set.
//
//   npx tsx scripts/check-drive-mirror.ts
//
// 1. The API client: folder search by exact name (quotes escaped), folder
//    create, ensurePath making only what is missing, a resumable session
//    (Location header), 308 with Range, the finished file, errors that carry
//    Google's reason but never the token, which errors mean "pause".
// 2. The engine: a small file in one PUT, bytes intact; the same name and size
//    already there is a skip; the same name with another size goes under the
//    second name; every name taken is fatal; a big file in chunks; a tick
//    that runs out saves its cursor and the next resumes where Google says
//    it is, nothing lost; Google keeping less than was sent is re-sent from
//    there; a forgotten session starts over.
// 3. The OAuth link (drive.file only, offline, consent, the redirect URI),
//    the not-configured gates, and this business on Google Drive.
import { createHash } from "node:crypto";
import type { DriveCursor } from "../src/lib/drive-mirror";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
  process.exit(2);
}
process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID = "fake-client.apps.googleusercontent.com";
process.env.GOOGLE_DRIVE_CLIENT_SECRET = "fake-secret-never-logged";
process.env.NEXT_PUBLIC_SITE_URL = "https://portal.example.test";

let failures = 0;
let passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const TOKEN = "fake-access-token-never-logged";

// ---- A fake Google Drive -------------------------------------------------------

type Node = { id: string; name: string; parent: string; folder: boolean; bytes?: Uint8Array; trashed?: boolean };
type Session = { parent: string; name: string; total: number; got: Uint8Array[]; received: number; mime: string };
type Knobs = { keepShortOnce?: number; forgetSessionOnce?: boolean; rateLimitOnce?: boolean };
type Fake = { nodes: Map<string, Node>; sessions: Map<string, Session>; calls: string[]; knobs: Knobs; n: number };

const cat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

function fakeDrive(): { fetch: (i: string, init?: RequestInit) => Promise<Response>; s: Fake } {
  const s: Fake = { nodes: new Map(), sessions: new Map(), calls: [], knobs: {}, n: 0 };
  s.nodes.set("root", { id: "root", name: "My Drive", parent: "", folder: true });
  const id = () => `id${(++s.n).toString().padStart(12, "0")}`;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const err = (status: number, reason: string) => json(status, { error: { message: `fake ${reason}`, errors: [{ reason }] } });
  const out = (n: Node) => ({ id: n.id, name: n.name, mimeType: n.folder ? "application/vnd.google-apps.folder" : "application/octet-stream", ...(n.bytes ? { size: String(n.bytes.length) } : {}), trashed: Boolean(n.trashed) });
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(input);
    const method = (init.method || "GET").toUpperCase();
    const auth = new Headers(init.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) return err(401, "authError");
    s.calls.push(`${method} ${u.pathname}`);
    // Resumable session PUTs
    if (u.hostname === "upload.fake" && method === "PUT") {
      const sess = s.sessions.get(u.pathname);
      if (!sess || s.knobs.forgetSessionOnce) {
        s.knobs.forgetSessionOnce = false;
        return err(404, "notFound");
      }
      const range = new Headers(init.headers).get("content-range") || "";
      const body = init.body ? new Uint8Array(init.body as ArrayBuffer) : new Uint8Array(0);
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        if (start !== sess.received) return err(400, "badRequest"); // a gap or overlap
        let take = body;
        if (s.knobs.keepShortOnce) {
          take = body.slice(0, Math.max(0, body.length - s.knobs.keepShortOnce));
          s.knobs.keepShortOnce = 0;
        }
        sess.got.push(take);
        sess.received += take.length;
      }
      if (sess.received >= sess.total) {
        const n: Node = { id: id(), name: sess.name, parent: sess.parent, folder: false, bytes: cat(sess.got) };
        s.nodes.set(n.id, n);
        s.sessions.delete(u.pathname);
        return json(200, out(n));
      }
      return new Response(null, { status: 308, headers: sess.received ? { range: `bytes=0-${sess.received - 1}` } : {} });
    }
    if (u.pathname === "/upload/drive/v3/files" && method === "POST") {
      if (s.knobs.rateLimitOnce) {
        s.knobs.rateLimitOnce = false;
        return err(403, "userRateLimitExceeded");
      }
      const meta = JSON.parse(String(init.body)) as { name: string; parents: string[] };
      const h = new Headers(init.headers);
      const path = `/session/${id()}`;
      s.sessions.set(path, { parent: meta.parents[0], name: meta.name, total: Number(h.get("x-upload-content-length")), got: [], received: 0, mime: h.get("x-upload-content-type") || "" });
      return new Response(null, { status: 200, headers: { location: `https://upload.fake${path}` } });
    }
    if (u.pathname === "/drive/v3/files" && method === "GET") {
      const q = u.searchParams.get("q") || "";
      const parent = /^'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
      const folderOnly = /mimeType = 'application\/vnd.google-apps.folder'/.test(q);
      const filesOnly = /mimeType != 'application\/vnd.google-apps.folder'/.test(q);
      const files = [...s.nodes.values()].filter((n) => n.parent === parent && n.name === name && !n.trashed && (!folderOnly || n.folder) && (!filesOnly || !n.folder)).map(out);
      return json(200, { files });
    }
    if (u.pathname === "/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(String(init.body)) as { name: string; parents: string[] };
      const n: Node = { id: id(), name: meta.name, parent: meta.parents[0], folder: true };
      s.nodes.set(n.id, n);
      return json(200, out(n));
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (one) {
      const n = s.nodes.get(decodeURIComponent(one[1]));
      if (!n) return err(404, "notFound");
      if (method === "PATCH") {
        n.trashed = true;
        return json(200, out(n));
      }
      if (u.searchParams.get("alt") === "media") return new Response(n.bytes ? new Uint8Array(n.bytes) : new Uint8Array(0), { status: 200 });
      return json(200, out(n));
    }
    return err(400, "unknownRoute");
  };
  return { fetch, s };
}

// Point the client at the fake: www.googleapis.com and upload.fake through one fetch.
function apiFor(f: ReturnType<typeof fakeDrive>, DriveApi: typeof import("../src/lib/google-drive").DriveApi) {
  return new DriveApi({ fetch: (i, init) => f.fetch(i.replace("https://www.googleapis.com", "https://g.fake"), init), token: async () => TOKEN });
}

const bytesOf = (n: number, seed = 7) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};

async function main() {
  const gd = await import("../src/lib/google-drive");
  const dm = await import("../src/lib/drive-mirror");
  const { business } = await import("../src/lib/business");

  // ---- 1. The API client ------------------------------------------------------
  {
    const f = fakeDrive();
    const api = apiFor(f, gd.DriveApi);
    const a = await api.ensurePath("root", ["Listings", "12 Example Way, Your City", "Photo"]);
    ok(f.s.nodes.get(a)?.name === "Photo", "ensurePath makes the last folder");
    const made = f.s.calls.filter((c) => c === "POST /drive/v3/files").length;
    ok(made === 3, `ensurePath made 3 folders (${made})`);
    const b = await api.ensurePath("root", ["Listings", "12 Example Way, Your City", "Photo"]);
    ok(a === b, "ensurePath finds the same folders again (quote in the name escaped)");
    ok(f.s.calls.filter((c) => c === "POST /drive/v3/files").length === 3, "nothing made twice");
    ok(gd.nextFromRange("bytes=0-1048575") === 1048576 && gd.nextFromRange(null) === 0, "Range header read as the next byte");
    try {
      await new gd.DriveApi({ fetch: (i, init) => f.fetch(i.replace("https://www.googleapis.com", "https://g.fake"), init), token: async () => "wrong-token" }).findChild("root", "x");
      ok(false, "a bad token throws");
    } catch (e) {
      ok(e instanceof gd.DriveError && e.status === 401, "a bad token is a 401 DriveError");
      ok(!String((e as Error).message).includes("wrong-token"), "the token never appears in the error");
    }
    ok(gd.isDriveRetry(new gd.DriveError("x", 429, "", 1000)), "429 pauses");
    ok(gd.isDriveRetry(new gd.DriveError("x", 503, "", null)), "503 pauses");
    ok(gd.isDriveRetry(new gd.DriveError("x", 403, "userRateLimitExceeded", null)), "403 rate limit pauses");
    ok(!gd.isDriveRetry(new gd.DriveError("x", 403, "insufficientFilePermissions", null)), "403 permission does not pause");
    ok(gd.isDriveNotFound(new gd.DriveError("x", 404, "notFound", null)) && gd.isDriveNotFound(new gd.DriveError("x", 410, "", null)), "404 and 410 are not found");
  }

  // ---- 2. The engine ----------------------------------------------------------
  const engine = async (f: ReturnType<typeof fakeDrive>, o: { folderId: string; names: string[]; data: Uint8Array; deadlines?: number[]; chunk?: number; cursor?: DriveCursor }) => {
    const api = apiFor(f, gd.DriveApi);
    let clock = 0;
    let cursor: DriveCursor = o.cursor ?? null;
    let saves = 0;
    const out = await dm.mirrorToDrive({
      api,
      folderId: o.folderId,
      names: o.names,
      size: o.data.length,
      contentType: "image/jpeg",
      read: async (s, e) => o.data.slice(s, e + 1),
      now: () => clock,
      deadline: o.deadlines?.[0] ?? 1e12,
      cursor,
      persist: async (c) => {
        cursor = c;
        saves++;
      },
      lease: async () => {
        clock += 30;
      },
      chunkBytes: o.chunk,
    });
    return { out, cursor: () => cursor, saves };
  };
  {
    const f = fakeDrive();
    const api = apiFor(f, gd.DriveApi);
    const folder = await api.ensurePath("root", ["Listings", "1 Main St", "Photo"]);
    const small = bytesOf(5000);
    const r1 = await engine(f, { folderId: folder, names: ["DSC_0001.ARW", "DSC_0001 (shoot abc).ARW"], data: small });
    ok(r1.out.done && !r1.out.skipped, "small file copied");
    const node = r1.out.done ? f.s.nodes.get(r1.out.fileId) : undefined;
    ok(node && sha(node.bytes!) === sha(small) && node.name === "DSC_0001.ARW" && node.parent === folder, "small file: bytes, name and folder intact");
    const r2 = await engine(f, { folderId: folder, names: ["DSC_0001.ARW", "DSC_0001 (shoot abc).ARW"], data: small });
    ok(r2.out.done && r2.out.skipped, "same name and size already there: skip");
    const other = bytesOf(6000, 9);
    const r3 = await engine(f, { folderId: folder, names: ["DSC_0001.ARW", "DSC_0001 (shoot abc).ARW"], data: other });
    ok(r3.out.done && !r3.out.skipped && r3.out.name === "DSC_0001 (shoot abc).ARW", "same name, other size: second name");
    try {
      await engine(f, { folderId: folder, names: ["DSC_0001.ARW", "DSC_0001 (shoot abc).ARW"], data: bytesOf(7000, 3) });
      ok(false, "every name taken throws");
    } catch (e) {
      ok(e instanceof dm.DriveMirrorError && e.fatal, "every name taken is fatal");
    }
  }
  {
    // A big file in chunks across two ticks.
    const f = fakeDrive();
    const folder = await apiFor(f, gd.DriveApi).ensurePath("root", ["Listings", "2 Example Elm", "Video"]);
    const CH = 256 * 1024;
    const big = bytesOf(CH * 5 + 1234, 5);
    // Tick 1: enough time for about two chunks (8 MB/s planning: 256 KiB ≈ 33 ms + 2 s margin, tail 4 s).
    const api = apiFor(f, gd.DriveApi);
    let clock = 0;
    let cursor: DriveCursor = null;
    const deadline1 = 4_000 + 2_000 + 40; // room for the session start and one chunk, then out
    const tick = (deadline: number) =>
      dm.mirrorToDrive({
        api,
        folderId: folder,
        names: ["A001.MP4"],
        size: big.length,
        contentType: "video/mp4",
        read: async (s, e) => big.slice(s, e + 1),
        now: () => clock,
        deadline,
        cursor,
        persist: async (c) => {
          cursor = c;
        },
        lease: async () => {
          clock += 30;
        },
        chunkBytes: CH,
      });
    const t1 = await tick(deadline1);
    ok(!t1.done && cursor && (cursor as NonNullable<DriveCursor>).offset > 0 && (cursor as NonNullable<DriveCursor>).offset < big.length, "tick 1 stops part way with a saved cursor");
    const sessions = f.s.calls.filter((c) => c === "POST /upload/drive/v3/files").length;
    f.s.knobs.keepShortOnce = 1000; // Google keeps 1000 bytes less than sent on the next chunk
    clock = 0;
    const t2 = await tick(1e12);
    ok(t2.done && !t2.skipped, "tick 2 finishes");
    ok(f.s.calls.filter((c) => c === "POST /upload/drive/v3/files").length === sessions, "tick 2 resumed the same session (no new one)");
    const node = t2.done ? f.s.nodes.get(t2.fileId) : undefined;
    ok(node && sha(node.bytes!) === sha(big), "big file: every byte intact and in order, the short chunk re-sent");
    ok(cursor === null, "the cursor is cleared at the end");
  }
  {
    // A forgotten session starts over.
    const f = fakeDrive();
    const folder = await apiFor(f, gd.DriveApi).ensurePath("root", ["Listings", "3 Oak"]);
    const data = bytesOf(256 * 1024 * 2 + 10, 11);
    const first = await engine(f, { folderId: folder, names: ["x.jpg"], data, chunk: 256 * 1024, deadlines: [4_000 + 2_000 + 40] });
    ok(!first.out.done, "first run stops part way");
    f.s.knobs.forgetSessionOnce = true;
    const again = await engine(f, { folderId: folder, names: ["x.jpg"], data, chunk: 256 * 1024, cursor: first.cursor() });
    const node = again.out.done ? f.s.nodes.get(again.out.fileId) : undefined;
    ok(again.out.done && node && sha(node.bytes!) === sha(data), "a forgotten session starts over and finishes intact");
  }
  {
    // A rate limit surfaces as a pause-worthy error.
    const f = fakeDrive();
    f.s.knobs.rateLimitOnce = true;
    try {
      await engine(f, { folderId: "root", names: ["r.jpg"], data: bytesOf(100) });
      ok(false, "rate limit throws");
    } catch (e) {
      ok(gd.isDriveRetry(e), "a 403 rate limit at session start is a pause, not a failure");
    }
  }

  // ---- 3. OAuth, gates, this business ------------------------------------------
  {
    const u = new URL(gd.driveAuthorizeUrl("state123"));
    const scope = u.searchParams.get("scope") || "";
    ok(scope.split(" ").includes("https://www.googleapis.com/auth/drive.file"), "asks for drive.file");
    ok(!/auth\/drive(\s|$)|drive\.readonly|auth\/drive\.metadata/.test(scope), "never the whole Drive");
    ok(u.searchParams.get("access_type") === "offline" && u.searchParams.get("prompt") === "consent", "offline access, consent every time (a refresh token on reconnect)");
    ok(u.searchParams.get("redirect_uri") === "https://portal.example.test/api/studio/drive/callback", "the redirect URI is the studio's callback");
    ok(!u.toString().includes("fake-secret"), "the secret never goes in the link");
    ok(gd.hasDriveApp(), "configured with both halves");
    const store = business as unknown as { fileStore: string };
    const savedStore = store.fileStore;
    store.fileStore = "dropbox";
    process.env.GOOGLE_DRIVE_MIRROR = "on";
    ok(!gd.driveMirrorEnabled(), "a business on Dropbox never copies to Drive, keys or not");
    store.fileStore = "google_drive";
    delete process.env.GOOGLE_DRIVE_MIRROR;
    ok(!gd.driveMirrorEnabled(), "the copy is off outside production");
    process.env.GOOGLE_DRIVE_MIRROR = "on";
    ok(gd.driveMirrorEnabled(), "GOOGLE_DRIVE_MIRROR=on turns it on");
    process.env.GOOGLE_DRIVE_MIRROR = "off";
    ok(!gd.driveMirrorEnabled(), "GOOGLE_DRIVE_MIRROR=off turns it off");
    delete process.env.GOOGLE_DRIVE_MIRROR;
    store.fileStore = savedStore;
    ok(gd.driveRootName() === "Listings", "the top folder is Listings by default");
    ok(gd.drivePickerConfig() === null, "no Picker without its key and project number");
    ok(dm.needsDriveFinal({ r2Key: "a", bytes: 5, driveFinalKey: null, driveFinalBytes: null }) && !dm.needsDriveFinal({ r2Key: "a", bytes: 5, driveFinalKey: "a", driveFinalBytes: 5 }) && dm.needsDriveFinal({ r2Key: "a", bytes: 6, driveFinalKey: "a", driveFinalBytes: 5 }), "a final is copied when missing or replaced, once otherwise");
    ok(dm.DRIVE_CHUNK_BYTES % (256 * 1024) === 0, "the production chunk is a multiple of 256 KiB");
    ok(business.fileStore === "dropbox" || business.fileStore === "google_drive", `fileStore is dropbox or google_drive (${business.fileStore})`);
  }

  console.log(failures ? `${failures} FAILED, ${passes} passed` : `All ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
