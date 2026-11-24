// The business's Google Drive, server side (Nov 18 2026). The same jobs the
// Dropbox mirror does, for a business that keeps its files in Google Drive:
// every raw file a shooter uploads is copied into Drive under
// Listings/<address>/Photo or /Video (drive.mirror), and what a client was
// delivered goes under Listings/<address>/FINAL DELIVERY/<section>
// (drive.final). src/lib/drive-mirror.ts runs the jobs; this file is the
// connection and the API client. It never logs, returns or renders a token.
//
//   NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID   the OAuth client (Web application) in the
//                                        business's own Google Cloud project; public
//                                        (the browser's Save to Drive and Picker use it too)
//   GOOGLE_DRIVE_CLIENT_SECRET           its secret; with both set Drive is "configured"
//   NEXT_PUBLIC_GOOGLE_PICKER_API_KEY    a browser key limited to the Picker API and the
//                                        portal's address (Import from Google Drive)
//   NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER  the project number (the Picker's app id)
//   GOOGLE_DRIVE_ROOT_FOLDER             the top folder's name, default Listings
//   GOOGLE_DRIVE_MIRROR                  on | off; the mirror runs on production only
//                                        unless this says on (previews share the
//                                        database and must never write to the real Drive)
//
// Scope: drive.file only. The app sees and writes only the files and folders
// it made itself (or that a person picked for it), never the rest of the
// Drive, so Google treats it as a non-sensitive scope and the consent screen
// needs no review. One consequence: the app makes its own Listings folder; a
// Listings folder the business made by hand is a different folder to it.
//
// Connecting: an admin presses Connect on /admin/settings, which sends them to
// Google with access_type=offline, prompt=consent and a signed state (a short
// JWT bound to the admin's email). The callback swaps the code for a REFRESH
// token and stores it in the settings table under DRIVE_SETTING_KEY with the
// account's name and email for display. Access tokens are minted from it and
// cached per instance.
//
// The API client takes its fetch and token through DriveDeps, so
// scripts/check-drive-mirror.ts drives it with a fake Drive.
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { authSecret } from "./session-token";
import { siteUrl } from "./brand";
import { business } from "./business";
import { currentEnv, NotConfiguredError } from "./jobs-core";

export const DRIVE_SETTING_KEY = "google_drive.refresh_token";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SIGN_IN_SCOPES = ["openid", "email", "profile"];
const OAUTH_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const STATE_TTL = "15m";

// Env values as pasted into Vercel sometimes carry a trailing space or newline.
const env = (k: string): string => (process.env[k] || "").trim();

export function driveClientId(): string {
  return env("NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID");
}

// Both halves of the OAuth client are set: Drive can be connected and run.
export function hasDriveApp(): boolean {
  return Boolean(driveClientId() && env("GOOGLE_DRIVE_CLIENT_SECRET"));
}

// What the browser needs for Import from Google Drive (the Picker).
export function drivePickerConfig(): { clientId: string; apiKey: string; appId: string } | null {
  const clientId = driveClientId();
  const apiKey = env("NEXT_PUBLIC_GOOGLE_PICKER_API_KEY");
  const appId = env("NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER");
  return clientId && apiKey && appId ? { clientId, apiKey, appId } : null;
}

// Whether mirror jobs are made and run HERE: Drive is configured and this is
// production (or GOOGLE_DRIVE_MIRROR=on). "off" turns it off anywhere.
export function driveMirrorEnabled(): boolean {
  const flag = env("GOOGLE_DRIVE_MIRROR").toLowerCase();
  // Only a business on Google Drive copies there (business.fileStore); a
  // Dropbox business with Drive keys set copies nothing to Drive.
  if (business.fileStore !== "google_drive" || flag === "off" || !hasDriveApp()) return false;
  return currentEnv() === "production" || flag === "on";
}

// Connecting needs Google to send the admin back to THIS deployment: production
// (the registered redirect URI) or one running with GOOGLE_DRIVE_MIRROR=on.
export function canConnectDriveHere(): boolean {
  return hasDriveApp() && (currentEnv() === "production" || env("GOOGLE_DRIVE_MIRROR").toLowerCase() === "on");
}

// The top folder's name in My Drive. One plain name, never empty.
export function driveRootName(): string {
  const s = env("GOOGLE_DRIVE_ROOT_FOLDER").replace(/^\/+|\/+$/g, "").replace(/[\\/]+/g, "-").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return s || "Listings";
}

export function driveRedirectUri(): string {
  return `${siteUrl()}/api/studio/drive/callback`;
}

export function driveFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

// ---- The stored connection --------------------------------------------------

type Stored = {
  token: string; // the refresh token; never leaves this module
  name: string | null;
  email: string | null;
  connectedBy: string | null;
  connectedAt: string;
  rootId?: string | null; // the Listings folder the app made, once it exists
  rootName?: string | null; // the name it was made under (a renamed root env makes a new one)
  error?: string | null; // the last reason a refresh was refused, for the card
  errorAt?: string | null;
};

// What the settings card and health may see. No token, ever.
export type DriveConnection = {
  connected: boolean;
  name: string | null;
  email: string | null;
  connectedBy: string | null;
  connectedAt: string | null;
  rootId: string | null;
  error: string | null;
};

async function storedConnection(): Promise<Stored | null> {
  if (!hasDb()) return null;
  const row = await db().query.settings.findFirst({ where: eq(schema.settings.key, DRIVE_SETTING_KEY) });
  const v = row?.value as Partial<Stored> | null | undefined;
  if (!v || typeof v.token !== "string" || !v.token) return null;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  return {
    token: v.token,
    name: str(v.name),
    email: str(v.email),
    connectedBy: str(v.connectedBy),
    connectedAt: str(v.connectedAt) ?? row!.updatedAt.toISOString(),
    rootId: str(v.rootId),
    rootName: str(v.rootName),
    error: str(v.error),
    errorAt: str(v.errorAt),
  };
}

export async function driveConnection(): Promise<DriveConnection> {
  const s = await storedConnection();
  if (!s) return { connected: false, name: null, email: null, connectedBy: null, connectedAt: null, rootId: null, error: null };
  return { connected: true, name: s.name, email: s.email, connectedBy: s.connectedBy, connectedAt: s.connectedAt, rootId: s.rootName === driveRootName() ? s.rootId ?? null : null, error: s.error ?? null };
}

export async function saveDriveConnection(c: { refreshToken: string; name: string | null; email: string | null; connectedBy: string }): Promise<void> {
  // A reconnect as the same account keeps the Listings folder it already made.
  const prev = await storedConnection();
  const keep = prev && prev.email && c.email && prev.email === c.email ? { rootId: prev.rootId ?? null, rootName: prev.rootName ?? null } : { rootId: null, rootName: null };
  const value: Stored = { token: c.refreshToken, name: c.name, email: c.email, connectedBy: c.connectedBy, connectedAt: new Date().toISOString(), ...keep, error: null, errorAt: null };
  await db()
    .insert(schema.settings)
    .values({ key: DRIVE_SETTING_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  forgetDriveToken();
}

export async function clearDriveConnection(): Promise<void> {
  await db().delete(schema.settings).where(eq(schema.settings.key, DRIVE_SETTING_KEY));
  forgetDriveToken();
}

async function patchStored(patch: Partial<Stored>): Promise<void> {
  const s = await storedConnection();
  if (!s) return;
  const value: Stored = { ...s, ...patch };
  await db().update(schema.settings).set({ value, updatedAt: new Date() }).where(eq(schema.settings.key, DRIVE_SETTING_KEY));
}

// ---- OAuth -----------------------------------------------------------------

// The state is a short JWT bound to the admin who pressed Connect, signed
// with AUTH_SECRET; the callback accepts it only for that same admin.
export async function signDriveState(email: string): Promise<string> {
  const jti = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return new SignJWT({ use: "drive_state", email: email.trim().toLowerCase() })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(STATE_TTL)
    .sign(authSecret());
}

export async function verifyDriveState(state: string | null | undefined, email: string): Promise<boolean> {
  if (!state) return false;
  try {
    const { payload } = await jwtVerify(state, authSecret(), { algorithms: ["HS256"] });
    return payload.use === "drive_state" && typeof payload.email === "string" && payload.email === email.trim().toLowerCase();
  } catch {
    return false;
  }
}

export function driveAuthorizeUrl(state: string): string {
  const u = new URL(OAUTH_AUTHORIZE);
  u.searchParams.set("client_id", driveClientId());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", driveRedirectUri());
  u.searchParams.set("scope", [...SIGN_IN_SCOPES, DRIVE_SCOPE].join(" "));
  // offline + consent: Google returns a refresh token every time, also on a reconnect.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

async function oauthToken(form: Record<string, string>, fetchFn: typeof fetch): Promise<TokenResponse> {
  const r = await fetchFn(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, client_id: driveClientId(), client_secret: env("GOOGLE_DRIVE_CLIENT_SECRET") }),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as TokenResponse;
  if (!r.ok) {
    // Google's error words only (invalid_grant, invalid_client); never the form.
    throw new DriveError(`Google sign-in failed (${r.status}): ${j.error_description || j.error || "no detail"}`, r.status, String(j.error || ""), null);
  }
  return j;
}

// The callback's exchange: a refresh token (offline access) plus a first access token.
export async function exchangeDriveCode(code: string, fetchFn: typeof fetch = fetch): Promise<{ refreshToken: string; accessToken: string; expiresIn: number; scope: string }> {
  const j = await oauthToken({ code, grant_type: "authorization_code", redirect_uri: driveRedirectUri() }, fetchFn);
  if (!j.refresh_token || !j.access_token) throw new Error("Google did not return a refresh token. Press Connect again and allow access.");
  return { refreshToken: j.refresh_token, accessToken: j.access_token, expiresIn: j.expires_in ?? 3_600, scope: j.scope ?? "" };
}

export async function refreshDriveAccessToken(refreshToken: string, fetchFn: typeof fetch = fetch): Promise<{ token: string; expiresIn: number }> {
  const j = await oauthToken({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchFn);
  if (!j.access_token) throw new Error("Google did not return an access token.");
  return { token: j.access_token, expiresIn: j.expires_in ?? 3_600 };
}

// The signed-in account, for the settings card (name and email only).
export async function driveAccount(accessToken: string, fetchFn: typeof fetch = fetch): Promise<{ name: string | null; email: string | null }> {
  const r = await fetchFn(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (!r.ok) return { name: null, email: null };
  const j = (await r.json().catch(() => ({}))) as { name?: string; email?: string };
  return { name: j.name ?? null, email: j.email ?? null };
}

// Per-instance cache of the short-lived access token, tied to the saved
// connection it was minted from (a reconnect is picked up within a minute).
let cachedAccess: { token: string; exp: number; connectedAt: string; checkedAt: number } | null = null;
let refreshing: Promise<string> | null = null;
const CONNECTION_RECHECK_MS = 60_000;

export function forgetDriveToken(): void {
  cachedAccess = null;
}

// Not configured here = NotConfiguredError, so a job waits quietly instead of
// failing. A refresh token Google no longer accepts (access removed on the
// Google side) is noted on the connection for the settings card.
export async function driveAccessToken(): Promise<string> {
  if (!hasDriveApp()) throw new NotConfiguredError("Google Drive (NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET)");
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
      if (!stored) throw new NotConfiguredError("Google Drive (connect it on Settings)");
      let r: { token: string; expiresIn: number };
      try {
        r = await refreshDriveAccessToken(stored.token);
      } catch (e) {
        if (e instanceof DriveError && e.status === 400 && /invalid_grant/i.test(e.reason)) {
          await patchStored({ error: "Google no longer accepts the saved connection. Press Reconnect on Settings.", errorAt: new Date().toISOString() });
          throw new NotConfiguredError("Google Drive (the saved connection was refused; reconnect it on Settings)");
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

export class DriveError extends Error {
  status: number;
  reason: string; // Google's reason word (notFound, rateLimitExceeded, invalid_grant)
  retryAfterMs: number | null;
  constructor(message: string, status: number, reason: string, retryAfterMs: number | null) {
    super(message);
    this.name = "DriveError";
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export const isDriveNotFound = (e: unknown): boolean => e instanceof DriveError && (e.status === 404 || e.status === 410);
// Google asks for a pause: 429, 5xx, or 403 with a rate-limit reason.
export const isDriveRetry = (e: unknown): e is DriveError =>
  e instanceof DriveError && (e.status === 429 || e.status >= 500 || (e.status === 403 && /rateLimitExceeded|userRateLimitExceeded|backendError/i.test(e.reason)));

export type DriveDeps = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  token: () => Promise<string>;
};

export type DriveFile = { id: string; name: string; size: number | null; mimeType: string };

// The outcome of one PUT into a resumable session.
export type ChunkResult = { done: true; file: DriveFile } | { done: false; next: number };

// A name inside a Drive query: backslash and quote escaped.
const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function errorOf(r: Response, what: string): Promise<DriveError> {
  const j = (await r.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } | string } | null;
  const err = j && typeof j.error === "object" ? j.error : null;
  const reason = err?.errors?.[0]?.reason || err?.status || (typeof j?.error === "string" ? j.error : "") || "";
  const ra = Number(r.headers.get("retry-after"));
  return new DriveError(`Google Drive ${what} failed (${r.status})${err?.message ? `: ${err.message.slice(0, 160)}` : ""}`, r.status, reason, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
}

function toFile(j: { id?: string; name?: string; size?: string | number; mimeType?: string }): DriveFile {
  return { id: String(j.id), name: String(j.name ?? ""), size: j.size == null ? null : Number(j.size), mimeType: String(j.mimeType ?? "") };
}

// "bytes=0-1048575" → 1048576 (the next byte Google wants); no header → 0.
export function nextFromRange(range: string | null): number {
  const m = /bytes=0-(\d+)/.exec(range || "");
  return m ? Number(m[1]) + 1 : 0;
}

export class DriveApi {
  constructor(private deps: DriveDeps) {}

  private async call(url: string, init: RequestInit, what: string): Promise<Response> {
    const token = await this.deps.token();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const r = await this.deps.fetch(url, { ...init, headers, cache: "no-store" });
    if (!r.ok && r.status !== 308) throw await errorOf(r, what);
    return r;
  }

  // One child of a folder by exact name (folders only when folder=true). The
  // first match: Drive allows two of a name, and this app never makes two.
  async findChild(parentId: string, name: string, folder = false): Promise<DriveFile | null> {
    const query = [`${q(parentId)} in parents`, `name = ${q(name)}`, "trashed = false", folder ? `mimeType = '${FOLDER_MIME}'` : `mimeType != '${FOLDER_MIME}'`].join(" and ");
    const u = new URL(`${API}/files`);
    u.searchParams.set("q", query);
    u.searchParams.set("fields", "files(id,name,size,mimeType)");
    u.searchParams.set("pageSize", "10");
    u.searchParams.set("spaces", "drive");
    const r = await this.call(u.toString(), { method: "GET" }, "search");
    const j = (await r.json()) as { files?: { id: string; name: string; size?: string; mimeType: string }[] };
    const f = j.files?.[0];
    return f ? toFile(f) : null;
  }

  async createFolder(parentId: string, name: string): Promise<DriveFile> {
    const r = await this.call(`${API}/files?fields=id,name,mimeType`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }) }, "create folder");
    return toFile(await r.json());
  }

  async ensureFolder(parentId: string, name: string): Promise<string> {
    const found = await this.findChild(parentId, name, true);
    return found ? found.id : (await this.createFolder(parentId, name)).id;
  }

  // a/b/c under a folder, made as needed; returns the last one's id.
  async ensurePath(parentId: string, segments: string[]): Promise<string> {
    let id = parentId;
    for (const s of segments) if (s) id = await this.ensureFolder(id, s);
    return id;
  }

  async getFile(id: string): Promise<DriveFile | null> {
    try {
      const r = await this.call(`${API}/files/${encodeURIComponent(id)}?fields=id,name,size,mimeType,trashed`, { method: "GET" }, "read");
      const j = (await r.json()) as { trashed?: boolean };
      return j.trashed ? null : toFile(j as Parameters<typeof toFile>[0]);
    } catch (e) {
      if (isDriveNotFound(e)) return null;
      throw e;
    }
  }

  // Into Drive's trash (restorable there for 30 days), never deleted for good.
  async trash(id: string): Promise<void> {
    try {
      await this.call(`${API}/files/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) }, "trash");
    } catch (e) {
      if (!isDriveNotFound(e)) throw e;
    }
  }

  // Opens a resumable upload; returns the session address (good for a week).
  async startUpload(parentId: string, name: string, size: number, contentType: string): Promise<string> {
    const r = await this.call(
      `${UPLOAD}/files?uploadType=resumable&fields=id,name,size,mimeType`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": contentType || "application/octet-stream" },
        body: JSON.stringify({ name, parents: [parentId] }),
      },
      "start upload"
    );
    const loc = r.headers.get("location");
    if (!loc) throw new DriveError("Google Drive did not open an upload session.", 500, "noSession", null);
    return loc;
  }

  // One piece of a resumable upload, at `start`. Every piece but the last is
  // a multiple of 256 KiB. Google answers 308 with how much it has (which may
  // be less than was sent: the next call starts there), or the finished file.
  async putChunk(session: string, start: number, chunk: Uint8Array, total: number): Promise<ChunkResult> {
    const end = start + chunk.byteLength - 1;
    const token = await this.deps.token();
    const r = await this.deps.fetch(session, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Length": String(chunk.byteLength), "Content-Range": chunk.byteLength ? `bytes ${start}-${end}/${total}` : `bytes */${total}` },
      body: chunk as unknown as BodyInit,
      cache: "no-store",
    });
    if (r.status === 308) return { done: false, next: nextFromRange(r.headers.get("range")) };
    if (!r.ok) throw await errorOf(r, "upload");
    return { done: true, file: toFile(await r.json()) };
  }

  // Where an interrupted session stands (empty PUT with bytes */total).
  async uploadStatus(session: string, total: number): Promise<ChunkResult> {
    return this.putChunk(session, 0, new Uint8Array(0), total);
  }

  // A file's bytes (Import from Google Drive), as a stream.
  async download(id: string): Promise<Response> {
    return this.call(`${API}/files/${encodeURIComponent(id)}?alt=media`, { method: "GET" }, "download");
  }
}

// The business's Drive, with the stored connection's token.
export function driveApi(): DriveApi {
  return new DriveApi({ fetch: (i, init) => fetch(i, init), token: () => driveAccessToken() });
}

// A Drive for a token the browser handed over (a client's own Drive for Save
// to Google Drive, or the shooter's for an import). Never stored.
export function driveApiWithToken(token: string): DriveApi {
  return new DriveApi({ fetch: (i, init) => fetch(i, init), token: async () => token });
}

// The app's top folder in the business's Drive, made once and remembered.
export async function driveRootId(api: DriveApi): Promise<string> {
  const s = await storedConnection();
  if (!s) throw new NotConfiguredError("Google Drive (connect it on Settings)");
  const name = driveRootName();
  if (s.rootId && s.rootName === name) {
    const f = await api.getFile(s.rootId);
    if (f && f.mimeType === FOLDER_MIME) return s.rootId;
  }
  const id = await api.ensureFolder("root", name);
  await patchStored({ rootId: id, rootName: name });
  return id;
}
