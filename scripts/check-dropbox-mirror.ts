// Checks for the Dropbox raw mirror and the raw video upload box (Oct 21
// 2026). No database, no network, no real Dropbox: a fake Dropbox answers
// the API client's fetch, and the mirror engine runs against it with a fake
// clock. Refuses to run with DATABASE_URL set.
//
//   npx tsx scripts/check-dropbox-mirror.ts
//
// 1. The API client: token refresh through the OAuth endpoint (never the
//    secret in an error), one retry on 401, 429 with Retry-After, 409
//    conflicts and not_found, the ASCII-only arg header.
// 2. The engine: a small file in one upload; a file already there with the
//    same size is a skip; a different file of the same name goes under the
//    alternate name; every name taken is fatal; a big file through an upload
//    session in chunks, bytes intact and in order; a tick that runs out
//    saves its cursor and the next tick resumes at the same offset with
//    nothing re-sent; incorrect_offset and an expired session recover; a
//    conflict at finish moves to the alternate name.
// 3. Folder names, the video formats, the editing-kinds filter (a clip can
//    never be an editing file), the video-only status, the hub lines.
import { createHash } from "node:crypto";
import type { MirrorCursor } from "../src/lib/dropbox-mirror";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
  process.exit(2);
}
process.env.NEXT_PUBLIC_DROPBOX_APP_KEY = "fake-app-key";
process.env.DROPBOX_APP_SECRET = "fake-app-secret-never-logged";
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

// ---- A fake Dropbox ----------------------------------------------------------

type FakeFile = { size: number; folder?: boolean; bytes?: Uint8Array };
type Knobs = {
  unauthorizedOnce?: boolean; // the first authorized call answers 401
  retryAfterOnce?: number | null; // seconds: the next upload answers 429
  wrongOffsetOnce?: boolean; // the next append answers incorrect_offset with the real offset
  dropSessionOnce?: boolean; // the next append answers not_found (session gone)
  conflictAtFinishOnce?: boolean; // the next finish answers path/conflict/file
  serviceDownOnce?: boolean; // the next upload answers 503 with no Retry-After
};
type Fake = { files: Map<string, FakeFile>; sessions: Map<string, Uint8Array[]>; calls: string[]; tokens: number; knobs: Knobs; currentToken: string };

const cat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

function fakeDropbox(): { fetch: typeof fetch; s: Fake } {
  const s: Fake = { files: new Map(), sessions: new Map(), calls: [], tokens: 0, knobs: {}, currentToken: "" };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const conflict = (what: string) => json(409, { error_summary: `path/conflict/${what}/..`, error: { ".tag": "path", path: { ".tag": "conflict", conflict: { ".tag": what } } } });
  const notFound = () => json(409, { error_summary: "path/not_found/..", error: { ".tag": "path", path: { ".tag": "not_found" } } });
  let sessionN = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    s.calls.push(path);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body;
    const bytes = rawBody instanceof Uint8Array ? rawBody : rawBody instanceof ArrayBuffer ? new Uint8Array(rawBody) : null;
    const text = typeof rawBody === "string" ? rawBody : rawBody instanceof URLSearchParams ? rawBody.toString() : null;
    if (path === "/oauth2/token") {
      const form = new URLSearchParams(text ?? "");
      if (form.get("client_secret") !== process.env.DROPBOX_APP_SECRET) return json(400, { error: "invalid_client" });
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") === "rt-bad-secret-token") return json(400, { error: "invalid_grant", error_description: "refresh token is invalid or revoked" });
        s.currentToken = `at-${++s.tokens}`;
        return json(200, { access_token: s.currentToken, token_type: "bearer", expires_in: 14400 });
      }
      if (form.get("grant_type") === "authorization_code") {
        s.currentToken = `at-${++s.tokens}`;
        return json(200, { access_token: s.currentToken, refresh_token: "rt-1", expires_in: 14400, account_id: "dbid:fake", scope: "files.content.write" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    const auth = headers.Authorization ?? "";
    if (s.knobs.unauthorizedOnce) {
      s.knobs.unauthorizedOnce = false;
      return json(401, { error_summary: "expired_access_token/", error: { ".tag": "expired_access_token" } });
    }
    if (auth !== `Bearer ${s.currentToken}`) return json(401, { error_summary: "invalid_access_token/", error: { ".tag": "invalid_access_token" } });
    const arg = headers["Dropbox-API-Arg"] ? (JSON.parse(headers["Dropbox-API-Arg"]) as Record<string, unknown>) : null;
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const key = (p: unknown) => String(p).toLowerCase();
    switch (path) {
      case "/2/users/get_current_account":
        return json(200, { account_id: "dbid:fake", name: { display_name: "Studio Name" }, email: "hello@example.test" });
      case "/2/files/get_metadata": {
        const f = s.files.get(key(body!.path));
        if (!f) return notFound();
        return json(200, { ".tag": f.folder ? "folder" : "file", name: String(body!.path).split("/").pop(), path_display: body!.path, size: f.size });
      }
      case "/2/files/create_folder_v2": {
        const k = key(body!.path);
        if (s.files.has(k)) return conflict("folder");
        s.files.set(k, { size: 0, folder: true });
        return json(200, { metadata: { ".tag": "folder", path_display: body!.path } });
      }
      case "/2/files/delete_v2":
        s.files.delete(key(body!.path));
        return json(200, { metadata: {} });
      case "/2/files/list_folder": {
        const base = key(body!.path);
        const entries = [...s.files.entries()].filter(([k]) => k.startsWith(`${base}/`) && !k.slice(base.length + 1).includes("/")).map(([k, f]) => ({ ".tag": f.folder ? "folder" : "file", name: k.split("/").pop(), path_display: k, size: f.size }));
        return json(200, { entries, has_more: false });
      }
      case "/2/files/upload": {
        if (s.knobs.retryAfterOnce != null) {
          const ra = s.knobs.retryAfterOnce;
          s.knobs.retryAfterOnce = null;
          return json(429, { error_summary: "too_many_write_operations/..", error: { ".tag": "too_many_write_operations", retry_after: ra } }, { "Retry-After": String(ra) });
        }
        if (s.knobs.serviceDownOnce) {
          s.knobs.serviceDownOnce = false;
          return new Response("service unavailable", { status: 503 });
        }
        const k = key(arg!.path);
        if (s.files.has(k)) return conflict("file");
        s.files.set(k, { size: bytes!.length, bytes: bytes! });
        return json(200, { size: bytes!.length, path_display: arg!.path });
      }
      case "/2/files/upload_session/start": {
        const id = `sess-${++sessionN}`;
        s.sessions.set(id, [bytes!]);
        return json(200, { session_id: id });
      }
      case "/2/files/upload_session/append_v2":
      case "/2/files/upload_session/finish": {
        const cursor = arg!.cursor as { session_id: string; offset: number };
        const finish = path.endsWith("finish");
        if (s.knobs.dropSessionOnce && !finish) {
          s.knobs.dropSessionOnce = false;
          s.sessions.delete(cursor.session_id);
        }
        const sess = s.sessions.get(cursor.session_id);
        if (!sess) return json(409, { error_summary: "lookup_failed/not_found/..", error: { ".tag": "lookup_failed", lookup_failed: { ".tag": "not_found" } } });
        const have = sess.reduce((a, p) => a + p.length, 0);
        if (s.knobs.wrongOffsetOnce && !finish) {
          s.knobs.wrongOffsetOnce = false;
          // Pretend the previous append landed although the client never heard: push it again? No: report the real offset.
          return json(409, { error_summary: "incorrect_offset/..", error: { ".tag": "incorrect_offset", incorrect_offset: { correct_offset: have } } });
        }
        if (cursor.offset !== have) {
          return json(409, { error_summary: finish ? "lookup_failed/incorrect_offset/.." : "incorrect_offset/..", error: finish ? { ".tag": "lookup_failed", lookup_failed: { ".tag": "incorrect_offset", correct_offset: have } } : { ".tag": "incorrect_offset", incorrect_offset: { correct_offset: have } } });
        }
        if (bytes && bytes.length) sess.push(bytes);
        if (!finish) return json(200, {});
        const commit = arg!.commit as { path: string };
        if (s.knobs.conflictAtFinishOnce) {
          s.knobs.conflictAtFinishOnce = false;
          return conflict("file");
        }
        const k = key(commit.path);
        if (s.files.has(k)) return conflict("file");
        const all = cat(sess);
        s.files.set(k, { size: all.length, bytes: all });
        s.sessions.delete(cursor.session_id);
        return json(200, { size: all.length, path_display: commit.path });
      }
      default:
        return json(400, `unknown endpoint ${path}`);
    }
  }) as typeof fetch;
  return { fetch: fetchFn, s };
}

async function main() {
  const { DropboxApi, DropboxError, alternateFilename, correctOffsetOf, dropboxFolderName, dropboxRoot, headerJson, isDropboxRetry, listingFolderPath, mirrorTargetPath, refreshDropboxAccessToken, exchangeDropboxCode, dropboxAuthorizeUrl, dropboxRedirectUri, signDropboxState, verifyDropboxState } = await import("../src/lib/dropbox");
  const { mirrorFile, MirrorError, mirrorSummary } = await import("../src/lib/dropbox-mirror");
  const { isEditingFile, isRawVideo, countKinds, EDITING_KINDS } = await import("../src/lib/shoot-files");
  const { isAcceptedFile, isVideoFile, contentTypeFor, MAX_VIDEO_BYTES, VIDEO_ACCEPT } = await import("../src/lib/autohdr-constants");
  const { railFor, STEP_LABELS, STEP_BLURBS, ACTIVE_STATUSES, photoFileCount } = await import("../src/lib/shoot-status");
  const { hubActivityText, hubChannelFor, dropboxCounts } = await import("../src/lib/hub-activity");
  const { describeActivity, qaMaySee } = await import("../src/lib/activity");
  const { SHOOT_FILE_KINDS, SHOOT_STATUSES } = await import("../src/db/schema");

  // ---- 1. the API client -------------------------------------------------------
  {
    const { fetch: f, s } = fakeDropbox();
    const t = await refreshDropboxAccessToken("rt-1", f);
    ok(t.token === "at-1" && t.expiresIn === 14400, "refresh mints an access token through oauth2/token");
    let revokedMsg = "";
    try {
      await refreshDropboxAccessToken("rt-bad-secret-token", f);
    } catch (e) {
      revokedMsg = e instanceof Error ? e.message : String(e);
      ok(e instanceof DropboxError && e.status === 400 && /invalid_grant/.test(e.tag), "a revoked refresh token is a 400 invalid_grant DropboxError");
    }
    ok(revokedMsg && !revokedMsg.includes("fake-app-secret") && !revokedMsg.includes("rt-bad-secret-token"), `the refresh error never carries the secret or the token (${revokedMsg})`);
    const x = await exchangeDropboxCode("code-1", f);
    ok(x.refreshToken === "rt-1" && x.accessToken.startsWith("at-") && x.accountId === "dbid:fake", "the code exchange returns the refresh token and the account id");
    ok(dropboxRedirectUri() === "https://portal.example.test/api/studio/dropbox/callback", "the redirect URI is siteUrl()/api/studio/dropbox/callback");
    const au = new URL(dropboxAuthorizeUrl("st"));
    ok(au.hostname === "www.dropbox.com" && au.searchParams.get("token_access_type") === "offline" && au.searchParams.get("response_type") === "code" && au.searchParams.get("redirect_uri") === dropboxRedirectUri() && au.searchParams.get("client_id") === "fake-app-key", "the authorize URL asks for offline access, a code and our redirect");
    const scopes = (au.searchParams.get("scope") ?? "").split(" ");
    ok(["account_info.read", "files.metadata.read", "files.metadata.write", "files.content.read", "files.content.write", "sharing.read", "sharing.write"].every((s) => scopes.includes(s)) && scopes.length === 7, "the authorize URL names the seven account scopes");
    ok(!scopes.some((s) => /^(team|members|groups|sessions|events)/.test(s) || s.startsWith("files.team")), "no team scope is ever asked for (a team token is refused by every file call)");
    const state = await signDropboxState("Boss@Studio.test");
    ok(await verifyDropboxState(state, "boss@studio.test"), "the signed state verifies for the admin who made it");
    ok(!(await verifyDropboxState(state, "other@studio.test")), "the signed state refuses another admin");
    ok(!(await verifyDropboxState(`${state}x`, "boss@studio.test")) && !(await verifyDropboxState(null, "boss@studio.test")), "a tampered or missing state refuses");

    // A client whose token dep mints and caches like the real one.
    let forgets = 0;
    let token: string | null = null;
    const api = new DropboxApi({
      fetch: f,
      token: async () => {
        if (!token) token = (await refreshDropboxAccessToken("rt-1", f)).token;
        return token;
      },
      forgetToken: () => {
        forgets++;
        token = null;
      },
    });
    const me = await api.currentAccount();
    ok(me.name === "Studio Name" && me.email === "hello@example.test", "get_current_account reads the name and email");
    ok(s.calls.filter((c) => c === "/2/users/get_current_account").length === 1, "get_current_account is one call");
    ok((await api.getMetadata("/Listings/nothing.jpg")) === null, "get_metadata of a missing path is null (409 not_found)");
    ok((await api.createFolder("/Listings/A/Raw/Photos")) === "created" && (await api.createFolder("/Listings/A/Raw/Photos")) === "exists", "create_folder_v2 creates, then a conflict reads as exists");
    const up = await api.upload("/Listings/A/Raw/Photos/one.jpg", new Uint8Array([1, 2, 3]));
    ok(up.size === 3 && up.path === "/Listings/A/Raw/Photos/one.jpg", "files/upload answers the size and path");
    const meta = await api.getMetadata("/Listings/A/Raw/Photos/one.jpg");
    ok(meta?.tag === "file" && meta.size === 3, "get_metadata reads the uploaded file");
    let conflictErr: unknown = null;
    try {
      await api.upload("/Listings/A/Raw/Photos/one.jpg", new Uint8Array([9]));
    } catch (e) {
      conflictErr = e;
    }
    ok(conflictErr instanceof DropboxError && conflictErr.status === 409 && /conflict/.test(conflictErr.tag), "mode add, autorename false: a second upload of the same name is a 409 conflict");
    s.knobs.unauthorizedOnce = true;
    const before = s.calls.length;
    const meta2 = await api.getMetadata("/Listings/A/Raw/Photos/one.jpg");
    ok(meta2?.size === 3 && forgets === 1 && s.calls.slice(before).filter((c) => c === "/2/files/get_metadata").length === 2, "a 401 forgets the token and retries once");
    s.knobs.retryAfterOnce = 7;
    let rl: unknown = null;
    try {
      await api.upload("/Listings/A/Raw/Photos/two.jpg", new Uint8Array([1]));
    } catch (e) {
      rl = e;
    }
    ok(isDropboxRetry(rl) && (rl as InstanceType<typeof DropboxError>).retryAfterMs === 7000, "a 429 carries Retry-After in ms");
    s.knobs.serviceDownOnce = true;
    let sd: unknown = null;
    try {
      await api.upload("/Listings/A/Raw/Photos/two.jpg", new Uint8Array([1]));
    } catch (e) {
      sd = e;
    }
    ok(isDropboxRetry(sd) && (sd as InstanceType<typeof DropboxError>).retryAfterMs === 30_000, "a 503 with no Retry-After waits the default 30 s");
    ok(headerJson({ path: "/Listings/Calle Niño/é.jpg" }) === '{"path":"/Listings/Calle Ni\\u00f1o/\\u00e9.jpg"}', "Dropbox-API-Arg is ASCII only");
    const list = await api.listFolder("/Listings/A/Raw/Photos");
    ok(list.entries.length === 1 && list.entries[0].name === "one.jpg", "list_folder lists the folder's entries");
    await api.deletePath("/Listings/A/Raw/Photos/one.jpg");
    ok((await api.getMetadata("/Listings/A/Raw/Photos/one.jpg")) === null, "delete_v2 removes the file");
    ok(correctOffsetOf(new DropboxError("x", 409, "incorrect_offset", null, { error: { ".tag": "incorrect_offset", incorrect_offset: { correct_offset: 4096 } } })) === 4096, "correct_offset is read from an append error");
    ok(correctOffsetOf(new DropboxError("x", 409, "lookup_failed/incorrect_offset", null, { error: { ".tag": "lookup_failed", lookup_failed: { ".tag": "incorrect_offset", correct_offset: 99 } } })) === 99, "correct_offset is read from a finish error");
    ok(correctOffsetOf(new Error("x")) === null && correctOffsetOf(new DropboxError("x", 409, "path/conflict", null, {})) === null, "no correct_offset on other errors");
    console.log("1. API client: ok");
  }

  // ---- 2. the engine ------------------------------------------------------------
  const CH = 1000; // chunk for the tests
  const SINGLE = 2500; // single-upload ceiling for the tests
  const pattern = (n: number) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
    return b;
  };
  type Run = { outcome: Awaited<ReturnType<typeof mirrorFile>>; persisted: MirrorCursor[]; leases: number; reads: [number, number][] };
  const run = async (api: InstanceType<typeof DropboxApi>, data: Uint8Array, o: { cursor?: MirrorCursor; paths?: string[]; clock?: { now: number; perRead: number }; deadlineIn?: number }): Promise<Run> => {
    const persisted: MirrorCursor[] = [];
    let leases = 0;
    const reads: [number, number][] = [];
    const clock = o.clock ?? { now: 1_700_000_000_000, perRead: 0 };
    const deadline = clock.now + (o.deadlineIn ?? 3_600_000);
    const outcome = await mirrorFile({
      api,
      size: data.length,
      readAll: async () => data,
      read: async (s, e) => {
        reads.push([s, e]);
        clock.now += clock.perRead;
        return data.slice(s, e + 1);
      },
      now: () => clock.now,
      deadline,
      cursor: o.cursor ?? null,
      persist: async (c) => {
        persisted.push(c ? { ...c } : null);
      },
      lease: async () => {
        leases++;
      },
      paths: o.paths ?? ["/Listings/X/Raw/Photos/a.bin", "/Listings/X/Raw/Photos/a (shoot deadbeef).bin"],
      chunkBytes: CH,
      singleUploadMax: SINGLE,
    });
    return { outcome, persisted, leases, reads };
  };
  const mk = () => {
    const { fetch: f, s } = fakeDropbox();
    s.currentToken = "at-x";
    const api = new DropboxApi({ fetch: f, token: async () => "at-x" });
    return { api, s };
  };
  const stored = (s: Fake, path: string) => s.files.get(path.toLowerCase());

  {
    // small file, one request
    const { api, s } = mk();
    const data = pattern(1800);
    const r = await run(api, data, {});
    ok(r.outcome.done && !r.outcome.skipped && r.outcome.path === "/Listings/X/Raw/Photos/a.bin", "a small file lands in one upload");
    ok(s.calls.filter((c) => c === "/2/files/upload").length === 1 && !s.calls.some((c) => c.includes("upload_session")), "one files/upload, no session");
    ok(sha(stored(s, "/Listings/X/Raw/Photos/a.bin")!.bytes!) === sha(data), "the bytes are intact");
    // the same file again: a skip, no upload
    const n = s.calls.length;
    const r2 = await run(api, data, {});
    ok(r2.outcome.done && r2.outcome.skipped && !s.calls.slice(n).includes("/2/files/upload"), "already there with the same size: skipped, nothing uploaded");
    // a different file of the same name: the alternate name
    const other = pattern(1700);
    const r3 = await run(api, other, {});
    ok(r3.outcome.done && !r3.outcome.skipped && r3.outcome.path === "/Listings/X/Raw/Photos/a (shoot deadbeef).bin", "a different file of the same name goes under the alternate name");
    // both names taken by other sizes: fatal
    let fatal: unknown = null;
    try {
      await run(api, pattern(1234), {});
    } catch (e) {
      fatal = e;
    }
    ok(fatal instanceof MirrorError && fatal.fatal, "every name taken by another file is a fatal MirrorError");
    // a conflict race on the small path: looked up again, found same size → skipped
    const { api: api2, s: s2 } = mk();
    const d2 = pattern(900);
    s2.files.set("/listings/x/raw/photos/a.bin", { size: 900, bytes: d2 });
    const r4 = await run(api2, d2, {});
    ok(r4.outcome.done && r4.outcome.skipped, "a same-size file found before upload is a skip");
    console.log("2a. small files: ok");
  }
  {
    // big file through a session, in one run
    const { api, s } = mk();
    const data = pattern(4321); // > SINGLE, 5 chunks: 1000 ×4 + 321
    const r = await run(api, data, {});
    ok(r.outcome.done && !r.outcome.skipped, "a big file finishes through an upload session");
    const starts = s.calls.filter((c) => c.endsWith("/start")).length;
    const appends = s.calls.filter((c) => c.endsWith("/append_v2")).length;
    const finishes = s.calls.filter((c) => c.endsWith("/finish")).length;
    ok(starts === 1 && appends === 3 && finishes === 1, `start, 3 appends, finish (got ${starts}/${appends}/${finishes})`);
    ok(sha(stored(s, "/Listings/X/Raw/Photos/a.bin")!.bytes!) === sha(data), "the session's bytes are intact and in order");
    ok(r.persisted.length >= 5 && r.persisted[r.persisted.length - 1] === null, "the cursor is saved after every chunk and cleared at the end");
    ok(r.leases >= 4, "the lease is refreshed per chunk");
    ok(r.reads.every(([a, b]) => b - a + 1 <= CH), "no read is bigger than a chunk");
    // exact multiple of the chunk: the last chunk still finishes the session
    const { api: apiM, s: sM } = mk();
    const dm = pattern(3000);
    const rm = await run(apiM, dm, {});
    ok(rm.outcome.done && sha(stored(sM, "/Listings/X/Raw/Photos/a.bin")!.bytes!) === sha(dm), "a size that is an exact multiple of the chunk finishes");
    console.log("2b. sessions: ok");
  }
  {
    // the deadline: run one stops with a cursor, run two resumes with nothing re-sent
    const { api, s } = mk();
    const data = pattern(5200);
    const clock = { now: 1_700_000_000_000, perRead: 3_000 };
    const r1 = await run(api, data, { clock, deadlineIn: 9_000 });
    ok(!r1.outcome.done, "a tick that runs out stops before the next chunk");
    const cursor = !r1.outcome.done ? r1.outcome.cursor : null;
    ok(cursor != null && cursor.offset > 0 && cursor.offset < data.length && cursor.id.startsWith("sess-"), `the cursor holds the session and the offset (${cursor?.offset})`);
    const sentSoFar = cursor!.offset;
    const callsBefore = s.calls.length;
    const r2 = await run(api, data, { cursor, clock: { now: clock.now + 60_000, perRead: 0 } });
    ok(r2.outcome.done && !r2.outcome.skipped, "the next tick finishes the copy");
    ok(r2.reads[0][0] === sentSoFar, `the next tick resumes at the saved offset (${r2.reads[0][0]} = ${sentSoFar})`);
    ok(!s.calls.slice(callsBefore).some((c) => c.endsWith("/start")), "no second session is opened");
    ok(sha(stored(s, "/Listings/X/Raw/Photos/a.bin")!.bytes!) === sha(data), "bytes intact across the two ticks");
    console.log("2c. resume across ticks: ok");
  }
  {
    // incorrect_offset: carry on from Dropbox's offset
    const { api, s } = mk();
    const data = pattern(3500);
    s.knobs.wrongOffsetOnce = true;
    const r = await run(api, data, {});
    ok(r.outcome.done && sha(stored(s, "/Listings/X/Raw/Photos/a.bin")!.bytes!) === sha(data), "incorrect_offset recovers at the correct offset, bytes intact");
    // the session vanished: start over
    const { api: api2, s: s2 } = mk();
    s2.knobs.dropSessionOnce = true;
    const r2 = await run(api2, data, {});
    ok(r2.outcome.done && sha(stored(s2, "/Listings/X/Raw/Photos/a.bin")!.bytes!) === sha(data), "an expired session starts over and finishes");
    ok(s2.calls.filter((c) => c.endsWith("/start")).length === 2, "two sessions were opened for the expired case");
    // a conflict at finish: the alternate name
    const { api: api3, s: s3 } = mk();
    s3.knobs.conflictAtFinishOnce = true;
    const r3 = await run(api3, data, {});
    ok(r3.outcome.done && r3.outcome.path === "/Listings/X/Raw/Photos/a (shoot deadbeef).bin" && sha(stored(s3, "/Listings/X/Raw/Photos/a (shoot deadbeef).bin")!.bytes!) === sha(data), "a conflict at finish lands under the alternate name");
    // a 429 inside a session propagates as a retry error with Retry-After (the handler defers)
    const { api: api4, s: s4 } = mk();
    s4.knobs.retryAfterOnce = 3;
    let rl: unknown = null;
    try {
      await run(api4, pattern(800), {});
    } catch (e) {
      rl = e;
    }
    ok(isDropboxRetry(rl) && (rl as InstanceType<typeof DropboxError>).retryAfterMs === 3000, "a 429 reaches the handler as a retry error with its Retry-After");
    console.log("2d. recovery: ok");
  }

  // ---- 3. names, kinds, statuses, hub lines --------------------------------------
  ok(dropboxFolderName("1420 Example Alder Drive, Springfield, CA 90000") === "1420 Example Alder Drive, Springfield, CA 90000", "a plain address is its own folder name");
  ok(dropboxFolderName("12 A/B Street \\ Unit 3... ") === "12 A-B Street - Unit 3", "slashes become dashes, trailing dots and spaces go");
  ok(dropboxFolderName("  \t  ") === "Listing" && dropboxFolderName("...") === "Listing", "an empty name falls back to Listing");
  ok(dropboxFolderName("x".repeat(400)).length === 180, "names are capped at 180 characters");
  ok(dropboxFolderName("Calle  Niño\u0007, Springfield") === "Calle Niño, Springfield", "control characters go and spaces collapse");
  ok(dropboxRoot() === "/Listings", "the default root is /Listings");
  process.env.DROPBOX_LISTINGS_ROOT = "Studio/Listings/";
  ok(dropboxRoot() === "/Studio/Listings", "the root gets a leading slash and no trailing slash");
  process.env.DROPBOX_LISTINGS_ROOT = "/";
  ok(dropboxRoot() === "/Listings", "a bare slash root falls back to /Listings");
  delete process.env.DROPBOX_LISTINGS_ROOT;
  ok(listingFolderPath("/Listings", "1 Main St, Springfield") === "/Listings/1 Main St, Springfield", "listingFolderPath joins root and name");
  ok(mirrorTargetPath("/Listings/1 Main St", "raw", "DSC_0001.ARW") === "/Listings/1 Main St/Photo/DSC_0001.ARW", "raw photos go under Photo");
  ok(mirrorTargetPath("/Listings/1 Main St", "display", "a.jpg") === "/Listings/1 Main St/Photo/a.jpg", "display files go under Photo too");
  ok(mirrorTargetPath("/Listings/1 Main St", "raw_video", "C0001.MOV") === "/Listings/1 Main St/Video/C0001.MOV", "raw video goes under Video");
  ok(alternateFilename("C0001.MOV", "3f2a9b1c-aaaa-bbbb-cccc-000000000000") === "C0001 (shoot 3f2a9b1c).MOV" && alternateFilename("noext", "abcdef12-x") === "noext (shoot abcdef12)", "the alternate name carries the shoot id");

  ok(SHOOT_FILE_KINDS.includes("raw_video") && (EDITING_KINDS as readonly string[]).includes("raw") && (EDITING_KINDS as readonly string[]).includes("display") && !(EDITING_KINDS as readonly string[]).includes("raw_video"), "raw_video is a file kind and never an editing kind");
  ok(isEditingFile({ kind: "raw" }) && isEditingFile({ kind: "display" }) && !isEditingFile({ kind: "raw_video" }), "isEditingFile keeps clips out");
  ok(isRawVideo({ kind: "raw_video" }) && !isRawVideo({ kind: "raw" }), "isRawVideo");
  const counts = countKinds([{ kind: "raw" }, { kind: "display" }, { kind: "raw_video" }, { kind: "raw_video" }]);
  ok(counts.photos === 2 && counts.video === 2, "countKinds splits photos and clips");
  const ms = mirrorSummary([{ kind: "raw", dropboxSyncedAt: "x" }, { kind: "raw_video", dropboxSyncedAt: null }, { kind: "raw", dropboxSyncedAt: null }]);
  ok(ms.total === 3 && ms.synced === 1 && ms.photos === 2 && ms.video === 1, "mirrorSummary counts copied, photos and clips");
  for (const n of ["C0001.MOV", "clip.mp4", "A001_C002.braw", "A001_C002_0101AB.R3D", "00001.MTS", "cam.mxf", "x.CRM", "VID_0001.insv", "GX010001.360", "a.m2ts", "a.mkv"]) ok(isVideoFile(n) && !isAcceptedFile(n), `${n} is video, not a photo`);
  for (const n of ["DSC_0001.ARW", "IMG_0001.CR3", "a.dng", "b.jpg", "c.NEF", "d.RAF"]) ok(isAcceptedFile(n) && !isVideoFile(n), `${n} is a photo, not video (DNG sequences are photos)`);
  ok(!isVideoFile("notes.txt") && !isAcceptedFile("notes.txt"), "a stray file is neither");
  ok(contentTypeFor("clip.mov") === "video/quicktime" && contentTypeFor("a.mp4") === "video/mp4" && contentTypeFor("x.braw") === "application/octet-stream" && contentTypeFor("DSC.ARW") === "image/x-sony-arw", "content types for clips and raws");
  ok(MAX_VIDEO_BYTES === 5_000_000_000 && VIDEO_ACCEPT.includes(".mov") && VIDEO_ACCEPT.includes("video/*"), "the 5 GB cap and the accept list");

  ok(SHOOT_STATUSES.includes("video_only") && !ACTIVE_STATUSES.includes("video_only"), "video_only is a status and never active (the pipeline never claims it)");
  ok(STEP_LABELS.video_only === "Video only" && /Dropbox/.test(STEP_BLURBS.video_only) && /Nothing goes to editing/.test(STEP_BLURBS.video_only), "video_only has its label and blurb");
  const rail = railFor("video_only");
  ok(rail.length === 2 && rail[1].label === "Dropbox" && rail.every((s) => s.state === "done"), "the video-only rail is Uploaded then Dropbox");
  ok(photoFileCount({ fileCount: 186, options: { indoorModelId: 37, outdoorModelId: 37, skipHdr: false, twilight: { enabled: false, count: 6, look: "x" }, nda: false, files: { photos: 183, video: 3 } } }) === 183 && photoFileCount({ fileCount: 10, options: null }) === 10, "photoFileCount leaves the clips out of the credits estimate");

  const place = { listing: { address: "1420 Example Alder Drive, Springfield, CA", nda: false }, clientEmail: "agent@example.com" };
  const ndaPlace = { listing: { address: "35 Hideaway Example Lane, Springfield, CA", nda: true }, clientEmail: "agent@example.com" };
  const done = hubActivityText({ action: "shoot.dropbox_synced", shootId: "s1", meta: { photos: 14, video: 3, folder: "/Listings/1420 Example Alder Drive" } }, place) ?? "";
  ok(done === "Raw files copied to Dropbox: 1420 Example Alder Drive, 14 photos and 3 films.", `the hub line reads as asked (${done})`);
  const one = hubActivityText({ action: "shoot.dropbox_synced", shootId: "s1", meta: { photos: 1, video: 0 } }, place) ?? "";
  ok(one === "Raw files copied to Dropbox: 1420 Example Alder Drive, 1 photo.", `singular and no films (${one})`);
  const ndaLine = hubActivityText({ action: "shoot.dropbox_synced", shootId: "s1", meta: { photos: 2, video: 1, folder: "/Listings/35 Hideaway Example Lane" } }, ndaPlace) ?? "";
  ok(ndaLine.includes("an NDA listing") && !ndaLine.includes("Hideaway"), `an NDA listing stays anonymous with no folder (${ndaLine})`);
  ok(dropboxCounts(0, 0) === "no files" && dropboxCounts(2, 2) === "2 photos and 2 films", "dropboxCounts words");
  for (const a of ["shoot.dropbox_synced", "shoot.dropbox_requeued", "dropbox.connected", "dropbox.disconnected"] as const) ok(hubChannelFor({ action: a }) === "hub", `${a} posts to the hub`);
  const conn = hubActivityText({ action: "dropbox.connected", actorEmail: "boss@studio.test", meta: { name: "Studio Name", email: "hello@example.test", root: "/Listings" } }, { listing: null, clientEmail: null }) ?? "";
  ok(/Dropbox connected: Studio Name \(hello@example\.test\)/.test(conn) && !/token|secret/i.test(conn), `the connected line names the account, never a token (${conn})`);
  for (const t of [done, ndaLine, conn]) ok(!/\$\d/.test(t), "hub lines carry no dollar amounts");
  ok(/Raw files copied to Dropbox \(14 photos and 3 films\)/.test(describeActivity({ action: "shoot.dropbox_synced", actorEmail: null, meta: { photos: 14, video: 3 } })), "the feed line");
  ok(qaMaySee("shoot.dropbox_synced") && !qaMaySee("dropbox.connected"), "QA reads the shoot line, not the connection changes");
  console.log("3. names, kinds, statuses, hub lines: ok");

  // ---- 4. FINAL DELIVERY (Oct 27 2026) ----
  const { FINAL_DELIVERY_FOLDER, finalSubfolder, finalTargetPath, finalAlternatePath } = await import("../src/lib/dropbox");
  const { needsFinalCopy, MIRROR_KINDS, FINAL_KIND, FINAL_SWEEP_KIND } = await import("../src/lib/dropbox-mirror");
  const folder = "/Listings/123 Example Juniper Dr, Springfield, CA 90000";
  ok(FINAL_DELIVERY_FOLDER === "FINAL DELIVERY", "the folder is named FINAL DELIVERY");
  ok(finalTargetPath(folder, { kind: "photo", section: null, filename: "01.jpg" }) === `${folder}/FINAL DELIVERY/Photos/01.jpg`, "main gallery photo → Photos");
  ok(finalTargetPath(folder, { kind: "video", section: null, filename: "Film.mp4" }) === `${folder}/FINAL DELIVERY/Video/Film.mp4`, "main gallery film → Video");
  ok(finalTargetPath(folder, { kind: "photo", section: "Twilight", filename: "t1.jpg" }) === `${folder}/FINAL DELIVERY/Twilight/t1.jpg`, "a named section keeps its name");
  ok(finalTargetPath(folder, { kind: "photo", section: "Floor Plans", filename: "plan.jpg" }) === `${folder}/FINAL DELIVERY/Floor Plans/plan.jpg`, "Floor Plans section");
  ok(finalSubfolder({ kind: "photo", section: "A/B: notes. " }) === "A-B: notes", "a section with a slash and trailing dot is made safe");
  ok(finalSubfolder({ kind: "photo", section: "   " }) === "Photos", "a blank section is the main gallery");
  ok(finalAlternatePath(folder, { id: "abcd1234-0000-0000-0000-000000000000", kind: "photo", section: null, filename: "01.jpg" }) === `${folder}/FINAL DELIVERY/Photos/01 (abcd1234).jpg`, "the second name carries the file id");
  ok(needsFinalCopy({ r2Key: "k", bytes: 10, dropboxFinalKey: null, dropboxFinalBytes: null }), "never copied: due");
  ok(!needsFinalCopy({ r2Key: "k", bytes: 10, dropboxFinalKey: "k", dropboxFinalBytes: 10 }), "copied, same version: not due");
  ok(needsFinalCopy({ r2Key: "k", bytes: 12, dropboxFinalKey: "k", dropboxFinalBytes: 10 }), "replaced final (same key, new bytes): due again");
  ok(needsFinalCopy({ r2Key: "k2", bytes: 10, dropboxFinalKey: "k", dropboxFinalBytes: 10 }), "moved to another object: due again");
  ok(!needsFinalCopy({ r2Key: "k", bytes: null, dropboxFinalKey: "k", dropboxFinalBytes: 10 }), "unknown size, same key: not due (the job compares the real size)");
  ok(MIRROR_KINDS.includes(FINAL_KIND) && MIRROR_KINDS.includes(FINAL_SWEEP_KIND), "finals run in the background pass with the raw mirror");
  console.log("4. FINAL DELIVERY paths and versions: ok");

  // ---- 5. A connection for a whole Business team (Oct 27 2026) ----
  const { NotConfiguredError } = await import("../src/lib/jobs-core");
  const { TEAM_TOKEN_MESSAGE } = await import("../src/lib/dropbox");
  let noted = 0;
  const teamApi = new DropboxApi({
    fetch: (async () => new Response('Error in call to API function "files/get_metadata": This API function operates on a single Dropbox account, but the OAuth 2 access token you provided is for an entire Dropbox Business team.', { status: 400 })) as typeof fetch,
    token: async () => "t",
    onTeamToken: async () => {
      noted++;
    },
  });
  let teamErr: unknown = null;
  try {
    await teamApi.getMetadata("/Listings/x");
  } catch (e) {
    teamErr = e;
  }
  ok(teamErr instanceof NotConfiguredError, "a team-wide token waits quietly (NotConfiguredError), never a failure that alerts");
  ok(teamErr instanceof Error && teamErr.message.includes("Press Reconnect Dropbox"), "the reason says what to fix");
  ok(noted === 1, "the Settings card is told once per refusal");
  ok(TEAM_TOKEN_MESSAGE.length <= 200, "the Settings note fits (200 chars)");
  console.log("5. team-wide connection: ok");

  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
