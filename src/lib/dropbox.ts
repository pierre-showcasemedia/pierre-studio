// the business's Dropbox, server side (Oct 21 2026). Every raw file a shooter uploads
// is copied into the team's Dropbox under /Listings/<address>/Photo or
// /Video by the dropbox.mirror job (src/lib/dropbox-mirror.ts); the address
// folder itself is made when the shoot is booked (Oct 26 2026). This file
// is the connection and the API client; it never logs, returns or renders a
// token.
//
//   NEXT_PUBLIC_DROPBOX_APP_KEY   the app (the same one the Chooser and Saver use)
//   DROPBOX_APP_SECRET            its secret; with both set the app is "configured"
//   DROPBOX_LISTINGS_ROOT         the root folder, default /Listings
//   DROPBOX_MIRROR                on | off; the mirror runs on production only
//                                 unless this says on (previews share the
//                                 database and the connection, and their test
//                                 shoots must never land in the real Dropbox)
//
// Connecting: an admin presses Connect on /admin/settings, which sends them to
// Dropbox's OAuth page with token_access_type=offline and a signed state
// (a short JWT bound to the admin's email). The callback swaps the code for a
// REFRESH token and stores it in the settings table under
// DROPBOX_SETTING_KEY with the account's name and email for display. Access
// tokens are minted from the refresh token and cached per instance.
//
// The API client takes its fetch and token through DropboxDeps, so
// scripts/check-dropbox-mirror.ts drives it with a fake Dropbox.
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { authSecret } from "./session-token";
import { siteUrl } from "./brand";
import { currentEnv, NotConfiguredError } from "./jobs-core";

export const DROPBOX_SETTING_KEY = "dropbox.refresh_token";
export const DROPBOX_SCOPES = ["files.metadata.read", "files.metadata.write", "files.content.read", "files.content.write", "account_info.read"];
// Optional (Oct 26 2026): with these on in the App Console, Studio makes a
// view link to each listing's Video folder for the editors. Without them the
// Video card links to the folder in Dropbox itself (team members only).
export const DROPBOX_SHARING_SCOPES = ["sharing.read", "sharing.write"];
const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const OAUTH_AUTHORIZE = "https://www.dropbox.com/oauth2/authorize";
const OAUTH_TOKEN = "https://api.dropboxapi.com/oauth2/token";
const STATE_TTL = "15m";

// Env values as pasted into Vercel sometimes carry a trailing space or newline.
const env = (k: string): string => (process.env[k] || "").trim();

export function dropboxAppKey(): string {
  return env("NEXT_PUBLIC_DROPBOX_APP_KEY");
}

// Both halves of the app are set: the mirror can be connected and run.
export function hasDropboxApp(): boolean {
  return Boolean(dropboxAppKey() && env("DROPBOX_APP_SECRET"));
}

// Whether mirror jobs are made and run HERE: the app is configured and this
// is production (or DROPBOX_MIRROR=on). "off" turns it off anywhere.
export function dropboxMirrorEnabled(): boolean {
  const flag = env("DROPBOX_MIRROR").toLowerCase();
  if (flag === "off" || !hasDropboxApp()) return false;
  return currentEnv() === "production" || flag === "on";
}

// Connecting needs the callback to come back to THIS deployment: production
// (the registered redirect URI) or a deployment running with DROPBOX_MIRROR=on
// and its own NEXT_PUBLIC_SITE_URL registered in the App Console.
export function canConnectDropboxHere(): boolean {
  return hasDropboxApp() && (currentEnv() === "production" || env("DROPBOX_MIRROR").toLowerCase() === "on");
}

// "/Listings": leading slash, no trailing slash, never empty.
export function dropboxRoot(): string {
  const raw = env("DROPBOX_LISTINGS_ROOT") || "/Listings";
  const s = `/${raw.replace(/^\/+|\/+$/g, "")}`;
  return s === "/" ? "/Listings" : s;
}

export function dropboxRedirectUri(): string {
  return `${siteUrl()}/api/studio/dropbox/callback`;
}

// ---- The stored connection --------------------------------------------------

type Stored = {
  token: string; // the refresh token; never leaves this module
  accountId: string | null;
  name: string | null;
  email: string | null;
  connectedBy: string | null;
  connectedAt: string;
  error?: string | null; // the last reason a refresh was refused, for the card
  errorAt?: string | null;
};

// What the settings card and health may see. No token, ever.
export type DropboxConnection = {
  connected: boolean;
  name: string | null;
  email: string | null;
  connectedBy: string | null;
  connectedAt: string | null;
  error: string | null;
};

async function storedConnection(): Promise<Stored | null> {
  if (!hasDb()) return null;
  const row = await db().query.settings.findFirst({ where: eq(schema.settings.key, DROPBOX_SETTING_KEY) });
  const v = row?.value as Partial<Stored> | null | undefined;
  if (!v || typeof v.token !== "string" || !v.token) return null;
  return {
    token: v.token,
    accountId: typeof v.accountId === "string" ? v.accountId : null,
    name: typeof v.name === "string" ? v.name : null,
    email: typeof v.email === "string" ? v.email : null,
    connectedBy: typeof v.connectedBy === "string" ? v.connectedBy : null,
    connectedAt: typeof v.connectedAt === "string" ? v.connectedAt : row!.updatedAt.toISOString(),
    error: typeof v.error === "string" ? v.error : null,
    errorAt: typeof v.errorAt === "string" ? v.errorAt : null,
  };
}

export async function dropboxConnection(): Promise<DropboxConnection> {
  const s = await storedConnection();
  if (!s) return { connected: false, name: null, email: null, connectedBy: null, connectedAt: null, error: null };
  return { connected: true, name: s.name, email: s.email, connectedBy: s.connectedBy, connectedAt: s.connectedAt, error: s.error ?? null };
}

export async function isDropboxConnected(): Promise<boolean> {
  return (await storedConnection()) !== null;
}

export async function saveDropboxConnection(c: { refreshToken: string; accountId: string | null; name: string | null; email: string | null; connectedBy: string }): Promise<void> {
  const value: Stored = { token: c.refreshToken, accountId: c.accountId, name: c.name, email: c.email, connectedBy: c.connectedBy, connectedAt: new Date().toISOString(), error: null, errorAt: null };
  await db()
    .insert(schema.settings)
    .values({ key: DROPBOX_SETTING_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  forgetDropboxToken();
}

export async function clearDropboxConnection(): Promise<void> {
  await db().delete(schema.settings).where(eq(schema.settings.key, DROPBOX_SETTING_KEY));
  forgetDropboxToken();
}

async function noteConnectionError(message: string): Promise<void> {
  const s = await storedConnection();
  if (!s) return;
  const value: Stored = { ...s, error: message.slice(0, 200), errorAt: new Date().toISOString() };
  await db().update(schema.settings).set({ value, updatedAt: new Date() }).where(eq(schema.settings.key, DROPBOX_SETTING_KEY));
}

// ---- OAuth -----------------------------------------------------------------

// The state is a short JWT bound to the admin who pressed Connect, signed
// with AUTH_SECRET; the callback accepts it only for that same admin.
export async function signDropboxState(email: string): Promise<string> {
  const jti = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return new SignJWT({ use: "dropbox_state", email: email.trim().toLowerCase() })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(STATE_TTL)
    .sign(authSecret());
}

export async function verifyDropboxState(state: string | null | undefined, email: string): Promise<boolean> {
  if (!state) return false;
  try {
    const { payload } = await jwtVerify(state, authSecret(), { algorithms: ["HS256"] });
    return payload.use === "dropbox_state" && typeof payload.email === "string" && payload.email === email.trim().toLowerCase();
  } catch {
    return false;
  }
}

export function dropboxAuthorizeUrl(state: string): string {
  const u = new URL(OAUTH_AUTHORIZE);
  u.searchParams.set("client_id", dropboxAppKey());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("token_access_type", "offline");
  u.searchParams.set("redirect_uri", dropboxRedirectUri());
  u.searchParams.set("state", state);
  // Oct 27 2026: the scopes are named, single-account ones only. Without a
  // scope parameter Dropbox asks for every permission ticked on the app, and
  // the business's app has team permissions too, which made the connection a token
  // for the whole Business team that every file call refuses. Naming only
  // account scopes gets a token for the account that signs in, whatever else
  // is ticked (developers.dropbox.com/oauth-guide). The app must have all of
  // these ticked on its Permissions tab.
  u.searchParams.set("scope", [...DROPBOX_SCOPES, ...DROPBOX_SHARING_SCOPES].join(" "));
  return u.toString();
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; account_id?: string; error?: string; error_description?: string };

async function oauthToken(form: Record<string, string>, fetchFn: typeof fetch): Promise<TokenResponse> {
  const r = await fetchFn(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, client_id: dropboxAppKey(), client_secret: env("DROPBOX_APP_SECRET") }),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as TokenResponse;
  if (!r.ok) {
    // Dropbox's error words only (invalid_grant, invalid_client); never the form.
    throw new DropboxError(`Dropbox sign-in failed (${r.status}): ${j.error_description || j.error || "no detail"}`, r.status, String(j.error || ""), null, null);
  }
  return j;
}

// The callback's exchange: a refresh token (offline access) plus a first access token.
export async function exchangeDropboxCode(code: string, fetchFn: typeof fetch = fetch): Promise<{ refreshToken: string; accessToken: string; accountId: string | null; expiresIn: number }> {
  const j = await oauthToken({ code, grant_type: "authorization_code", redirect_uri: dropboxRedirectUri() }, fetchFn);
  if (!j.refresh_token || !j.access_token) throw new Error("Dropbox did not return a refresh token. Check that the app allows offline access and try Connect again.");
  return { refreshToken: j.refresh_token, accessToken: j.access_token, accountId: j.account_id ?? null, expiresIn: j.expires_in ?? 14_400 };
}

export async function refreshDropboxAccessToken(refreshToken: string, fetchFn: typeof fetch = fetch): Promise<{ token: string; expiresIn: number }> {
  const j = await oauthToken({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchFn);
  if (!j.access_token) throw new Error("Dropbox did not return an access token.");
  return { token: j.access_token, expiresIn: j.expires_in ?? 14_400 };
}

// Per-instance cache of the short-lived access token, tied to the saved
// connection it was minted from: after a reconnect, every instance mints a
// new one within CONNECTION_RECHECK_MS instead of reusing the old one for hours.
let cachedAccess: { token: string; exp: number; connectedAt: string; checkedAt: number } | null = null;
let refreshing: Promise<string> | null = null;
const CONNECTION_RECHECK_MS = 60_000;

export function forgetDropboxToken(): void {
  cachedAccess = null;
}

// Not configured here = NotConfiguredError, so a mirror job waits quietly
// (like the calendar jobs) instead of failing. A refresh token Dropbox no
// longer accepts (the app was disconnected on the Dropbox side) is noted on
// the connection for the settings card and waits the same way.
export async function dropboxAccessToken(): Promise<string> {
  if (!hasDropboxApp()) throw new NotConfiguredError("Dropbox (NEXT_PUBLIC_DROPBOX_APP_KEY and DROPBOX_APP_SECRET)");
  if (cachedAccess && Date.now() < cachedAccess.exp - 60_000) {
    if (Date.now() - cachedAccess.checkedAt < CONNECTION_RECHECK_MS) return cachedAccess.token;
    const now = await storedConnection();
    if (now && now.connectedAt === cachedAccess.connectedAt) {
      cachedAccess.checkedAt = Date.now();
      return cachedAccess.token;
    }
    cachedAccess = null;
  }
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const stored = await storedConnection();
      if (!stored) throw new NotConfiguredError("Dropbox (connect it on Settings)");
      let r: { token: string; expiresIn: number };
      try {
        r = await refreshDropboxAccessToken(stored.token);
      } catch (e) {
        if (e instanceof DropboxError && e.status === 400 && /invalid_grant/i.test(e.tag)) {
          await noteConnectionError("Dropbox no longer accepts the saved connection. Disconnect and connect again on Settings.");
          throw new NotConfiguredError("Dropbox (the saved connection was refused; reconnect it on Settings)");
        }
        throw e;
      }
      cachedAccess = { token: r.token, exp: Date.now() + r.expiresIn * 1000, connectedAt: stored.connectedAt, checkedAt: Date.now() };
      return r.token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---- The API client ------------------------------------------------------------

export class DropboxError extends Error {
  status: number;
  tag: string; // error_summary ("path/conflict/file/..") or the OAuth error word
  retryAfterMs: number | null;
  body: unknown;
  constructor(message: string, status: number, tag: string, retryAfterMs: number | null, body: unknown) {
    super(message);
    this.name = "DropboxError";
    this.status = status;
    this.tag = tag;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

export const isDropboxNotFound = (e: unknown): boolean => e instanceof DropboxError && e.status === 409 && /not_found/.test(e.tag);
export const isDropboxConflict = (e: unknown): boolean => e instanceof DropboxError && e.status === 409 && /conflict/.test(e.tag);
export const isDropboxRetry = (e: unknown): e is DropboxError => e instanceof DropboxError && (e.status === 429 || e.status === 503);

// Dropbox refusing to make a share link for a while (Nov 2 2026: hello@ hit
// the link-bandwidth block, every create_shared_link answered 409
// banned_member for days, the raw copies were fine). Not a permission
// problem: the same call works again once the block lifts, so it is retried,
// never given up on.
export const isDropboxSharingBan = (e: unknown): e is DropboxError => e instanceof DropboxError && /banned_member|shared_link_access_denied|too_many_shared_links/.test(e.tag);

// The correct_offset Dropbox reports when an upload session cursor is behind
// or ahead, wherever it sits in the error (append_v2 and finish nest it
// differently). null when the error is something else.
export function correctOffsetOf(e: unknown): number | null {
  if (!(e instanceof DropboxError)) return null;
  const walk = (v: unknown, depth: number): number | null => {
    if (!v || typeof v !== "object" || depth > 6) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.correct_offset === "number") return o.correct_offset;
    for (const k of Object.keys(o)) {
      const r = walk(o[k], depth + 1);
      if (r != null) return r;
    }
    return null;
  };
  return walk(e.body, 0);
}

// Dropbox-API-Arg must be ASCII: escape anything else.
export function headerJson(o: unknown): string {
  return JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export type DropboxDeps = {
  fetch: typeof fetch;
  token: () => Promise<string>;
  // Called on a 401 so the next call mints a fresh access token.
  forgetToken?: () => void;
  // Called when Dropbox says the connection is a whole Business team's (see TEAM_TOKEN).
  onTeamToken?: () => Promise<void>;
};

// Oct 27 2026: an app with any team permission ticked, connected by a team
// admin, gets a token for the whole Dropbox Business team, and every file
// call is refused ("This API function operates on a single Dropbox account,
// but the OAuth 2 access token you provided is for an entire Dropbox Business
// team"). Studio only needs one account. That is a setting to fix, not a
// failure to retry: the jobs wait quietly and Settings shows what to do.
const TEAM_TOKEN = /entire Dropbox Business team/i;
export const TEAM_TOKEN_MESSAGE = "Dropbox is connected for the whole Business team, which file calls refuse. Press Reconnect Dropbox here and Allow (Studio now asks for this account only).";

// contentHash: Dropbox's hash of a file's bytes (get_metadata only).
export type DropboxEntry = { tag: "file" | "folder" | "deleted"; name: string; path: string; size: number | null; contentHash?: string | null };

export class DropboxApi {
  private deps: DropboxDeps;
  constructor(deps: DropboxDeps) {
    this.deps = deps;
  }

  private async call<T>(url: string, init: RequestInit, retry = true): Promise<T> {
    const token = await this.deps.token();
    const r = await this.deps.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (r.ok) {
      const text = await r.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    const text = await r.text().catch(() => "");
    if (r.status === 400 && TEAM_TOKEN.test(text)) {
      this.deps.forgetToken?.();
      await this.deps.onTeamToken?.().catch(() => undefined);
      throw new NotConfiguredError(`Dropbox (${TEAM_TOKEN_MESSAGE})`);
    }
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const err = (o.error && typeof o.error === "object" ? o.error : {}) as Record<string, unknown>;
    const tag = typeof o.error_summary === "string" ? o.error_summary : typeof err[".tag"] === "string" ? String(err[".tag"]) : typeof body === "string" ? body.slice(0, 120) : "";
    const ra = r.headers.get("retry-after");
    const retryAfterMs = ra && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : typeof err.retry_after === "number" ? err.retry_after * 1000 : r.status === 429 || r.status === 503 ? 30_000 : null;
    if (r.status === 401 && retry) {
      this.deps.forgetToken?.();
      return this.call<T>(url, init, false);
    }
    throw new DropboxError(`Dropbox ${r.status}${tag ? `: ${tag}` : ""}`, r.status, tag, retryAfterMs, body);
  }

  // RPC endpoints take JSON; a few take no body at all (null).
  private rpc<T>(path: string, arg: unknown): Promise<T> {
    return this.call<T>(`${API}${path}`, arg === null ? { method: "POST" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(arg) });
  }

  // Content endpoints take the arg in a header and the bytes as the body.
  private content<T>(path: string, arg: unknown, body: Uint8Array): Promise<T> {
    return this.call<T>(`${CONTENT}${path}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": headerJson(arg) }, body: new Uint8Array(body) });
  }

  async currentAccount(): Promise<{ accountId: string | null; name: string | null; email: string | null }> {
    const j = await this.rpc<{ account_id?: string; name?: { display_name?: string }; email?: string }>("/users/get_current_account", null);
    return { accountId: j.account_id ?? null, name: j.name?.display_name ?? null, email: j.email ?? null };
  }

  // null when nothing is at that path.
  async getMetadata(path: string): Promise<DropboxEntry | null> {
    try {
      const j = await this.rpc<{ ".tag": string; name: string; path_display?: string; path_lower?: string; size?: number; content_hash?: string }>("/files/get_metadata", { path });
      return { tag: j[".tag"] as DropboxEntry["tag"], name: j.name, path: j.path_display ?? j.path_lower ?? path, size: typeof j.size === "number" ? j.size : null, contentHash: typeof j.content_hash === "string" ? j.content_hash : null };
    } catch (e) {
      if (isDropboxNotFound(e)) return null;
      throw e;
    }
  }

  // Intermediate folders are created too. A folder already there is fine.
  async createFolder(path: string): Promise<"created" | "exists"> {
    try {
      await this.rpc("/files/create_folder_v2", { path, autorename: false });
      return "created";
    } catch (e) {
      if (isDropboxConflict(e)) return "exists";
      throw e;
    }
  }

  // A view link to a file or folder (the Video folder for the editors).
  // null when the app has no sharing permission or the account's sharing
  // policy refuses one; an existing link is reused.
  async sharedLink(path: string): Promise<string | null> {
    try {
      const j = await this.rpc<{ url?: string }>("/sharing/create_shared_link_with_settings", { path });
      return j.url ?? null;
    } catch (e) {
      if (!(e instanceof DropboxError)) throw e;
      if (/missing_scope|access_denied|settings_error|email_not_verified/.test(e.tag)) return null;
      if (!/shared_link_already_exists/.test(e.tag)) throw e;
      const b = (e.body && typeof e.body === "object" ? e.body : {}) as { error?: { shared_link_already_exists?: { metadata?: { url?: string } } } };
      const url = b.error?.shared_link_already_exists?.metadata?.url;
      if (url) return url;
      const list = await this.rpc<{ links?: { url?: string }[] }>("/sharing/list_shared_links", { path, direct_only: true }).catch(() => ({ links: [] }));
      return list.links?.[0]?.url ?? null;
    }
  }

  async deletePath(path: string): Promise<void> {
    await this.rpc("/files/delete_v2", { path });
  }

  async listFolder(path: string, limit = 200): Promise<{ entries: DropboxEntry[]; hasMore: boolean }> {
    const j = await this.rpc<{ entries: { ".tag": string; name: string; path_display?: string; path_lower?: string; size?: number }[]; has_more: boolean }>("/files/list_folder", { path: path === "/" ? "" : path, limit, recursive: false });
    return {
      entries: (j.entries ?? []).map((e) => ({ tag: e[".tag"] as DropboxEntry["tag"], name: e.name, path: e.path_display ?? e.path_lower ?? "", size: typeof e.size === "number" ? e.size : null })),
      hasMore: Boolean(j.has_more),
    };
  }

  // One request, files up to 150 MB. mode add + autorename false: a file
  // already there is a 409 path/conflict/file, never a silent rename.
  async upload(path: string, body: Uint8Array): Promise<{ size: number; path: string }> {
    const j = await this.content<{ size: number; path_display?: string; path_lower?: string }>("/files/upload", { path, mode: "add", autorename: false, mute: true }, body);
    return { size: j.size, path: j.path_display ?? j.path_lower ?? path };
  }

  async sessionStart(chunk: Uint8Array): Promise<string> {
    const j = await this.content<{ session_id: string }>("/files/upload_session/start", { close: false }, chunk);
    return j.session_id;
  }

  async sessionAppend(sessionId: string, offset: number, chunk: Uint8Array): Promise<void> {
    await this.content("/files/upload_session/append_v2", { cursor: { session_id: sessionId, offset }, close: false }, chunk);
  }

  async sessionFinish(sessionId: string, offset: number, path: string, chunk: Uint8Array): Promise<{ size: number; path: string }> {
    const j = await this.content<{ size: number; path_display?: string; path_lower?: string }>(
      "/files/upload_session/finish",
      { cursor: { session_id: sessionId, offset }, commit: { path, mode: "add", autorename: false, mute: true } },
      chunk
    );
    return { size: j.size, path: j.path_display ?? j.path_lower ?? path };
  }
}

let defaultApi: DropboxApi | null = null;
export function dropboxApi(): DropboxApi {
  if (!defaultApi) defaultApi = new DropboxApi({ fetch: (input, init) => fetch(input, init), token: dropboxAccessToken, forgetToken: forgetDropboxToken, onTeamToken: () => noteConnectionError(TEAM_TOKEN_MESSAGE) });
  return defaultApi;
}

// ---- Folder layout ---------------------------------------------------------------
//
//   <root>/<listing address>/              made when the shoot is booked
//   <root>/<listing address>/Photo/<file>  raw photos, from the first upload
//   <root>/<listing address>/Video/<file>  raw video (the editors' folder)
//
// (Oct 26 2026, the owner's SOP; was Raw/Photos and Raw/Video before anything
// was ever copied.) The address folder is the listing's full address line with the characters
// Dropbox forbids in a name replaced (/ and \ become -), control characters
// dropped, whitespace collapsed and trailing dots or spaces trimmed. Once a
// listing has a folder it keeps it (listings.dropbox_folder), so an address
// edit never leaves files behind under an old name.

export const RAW_PHOTOS_SUBFOLDER = "Photo";
export const RAW_VIDEO_SUBFOLDER = "Video";

// The folder on dropbox.com, for people signed in to the account (or a team
// member it is shared with). Each segment encoded, the slashes kept.
export function dropboxWebUrl(path: string): string {
  return `https://www.dropbox.com/home${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function dropboxFolderName(address: string): string {
  const s = address
    .replace(/[\\/]+/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
    .replace(/[. ]+$/g, "")
    .replace(/^\.+/, "");
  return s || "Listing";
}

export function listingFolderPath(root: string, address: string): string {
  return `${root}/${dropboxFolderName(address)}`;
}

export function mirrorSubfolder(kind: string): string {
  return kind === "raw_video" ? RAW_VIDEO_SUBFOLDER : RAW_PHOTOS_SUBFOLDER;
}

// A file from a dropped folder keeps that folder (shoot_files.dropbox_dir);
// a loose one goes to Photo or Video.
export function mirrorTargetPath(folder: string, kind: string, filename: string, dir?: string | null): string {
  return dir ? `${folder}/${dir}/${filename}` : `${folder}/${mirrorSubfolder(kind)}/${filename}`;
}

// A folder-drop path from the browser, made safe for Dropbox: each folder
// name cleaned like the address folder, empty, "." and ".." parts dropped,
// at most 6 deep. null when nothing is left (a loose file).
export function cleanDropboxDir(dir: unknown): string | null {
  if (typeof dir !== "string") return null;
  const parts = dir
    .split(/[\\/]+/)
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 120).replace(/[. ]+$/g, "").replace(/^\.+/, ""))
    .filter(Boolean);
  return parts.length ? parts.slice(0, 6).join("/") : null;
}

// FINAL DELIVERY (Oct 27 2026): what the client was delivered, beside the raws.
// the owner: "whenever FINAL outputs are delivered to clients, I want them to be
// saved in a Dropbox folder as well in that same listing under FINAL DELIVERY".
// Inside it one folder per gallery section, as the client sees them: the
// main gallery's photos under Photos, its films under Video, a named section
// ("Twilight", "Floor Plans", "Revised") under its own name.
export const FINAL_DELIVERY_FOLDER = "FINAL DELIVERY";

export function finalSubfolder(m: { kind: string; section: string | null }): string {
  const named = (m.section ?? "").replace(/[\\/]+/g, "-").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "").replace(/^\.+/, "").slice(0, 80);
  return named || (m.kind === "video" ? "Video" : "Photos");
}

export function finalTargetPath(folder: string, m: { kind: string; section: string | null; filename: string }): string {
  return `${folder}/${FINAL_DELIVERY_FOLDER}/${finalSubfolder(m)}/${m.filename}`;
}

// The second name when another file already holds the first: the media id's start.
export function finalAlternatePath(folder: string, m: { id: string; kind: string; section: string | null; filename: string }): string {
  const dot = m.filename.lastIndexOf(".");
  const stem = dot > 0 ? m.filename.slice(0, dot) : m.filename;
  const ext = dot > 0 ? m.filename.slice(dot) : "";
  return `${folder}/${FINAL_DELIVERY_FOLDER}/${finalSubfolder(m)}/${stem} (${m.id.replace(/-/g, "").slice(0, 8)})${ext}`;
}

// A second name for a file whose name is already taken in the folder by a
// different file (two shoots of one listing, same camera counter).
export function alternateFilename(filename: string, shootId: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  return `${stem} (shoot ${shootId.replace(/-/g, "").slice(0, 8)})${ext}`;
}
