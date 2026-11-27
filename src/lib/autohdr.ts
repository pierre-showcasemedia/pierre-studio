// Server-only client for the AutoHDR External API, used by the shoot pipeline
// (src/lib/pipeline.ts). Every upstream call lives here so the rest of the
// app talks about "editing", never about the vendor.
//
// Auth is OAuth2 client_credentials against the business's company account. No
// credentials live in the repo; everything comes from env:
//   AUTOHDR_CLIENT_ID, AUTOHDR_CLIENT_SECRET   (required to connect)
//   AUTOHDR_API_BASE_URL, AUTOHDR_TOKEN_URL    (optional overrides)
//   STUDIO_TWILIGHT_DEFAULT_LOOK               (default twilight look id)
//
// Rules (CLAUDE.md):
//   - Aura (id 37) is the default model for every shoot.
//   - NDA shoots are named exactly NDA_PHOTOSHOOT_NAME, run on Aura only and
//     never carry an address anywhere upstream.
//   - Client-facing copy never mentions AI, AutoHDR or editing software.

import { AURA_MODEL_ID, MAX_FILES_WARNING, TWILIGHT_CREDITS } from "./autohdr-constants";
import { business } from "./business";

export const NDA_PHOTOSHOOT_NAME = "DO NOT DEMO - NDA PROPERTY";
export { AURA_MODEL_ID, MAX_FILES_WARNING, TWILIGHT_CREDITS };

const API = () => process.env.AUTOHDR_API_BASE_URL || "https://external.realestatephotoediting.com";
const TOKEN_URL = () => process.env.AUTOHDR_TOKEN_URL || "https://new.autohdr.com/api/auth/oauth2/token";
const SCOPES = "photoshoots:read photoshoots:write images:edit presets:read presets:run";

// The editing service is used only when business.editing is "autohdr" and
// its keys are set. With "manual" the team edits outside the studio and
// adds finished photos on the listing page, and nothing is ever sent here.
export function hasAutoHdr(): boolean {
  if (business.editing !== "autohdr") return false;
  return Boolean(process.env.AUTOHDR_CLIENT_ID && process.env.AUTOHDR_CLIENT_SECRET);
}

export class AutoHdrError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let cached: { token: string; exp: number } | null = null;

const CORE_SCOPES = "photoshoots:read photoshoots:write images:edit";

async function requestToken(scope: string) {
  return fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: (process.env.AUTOHDR_CLIENT_ID || "").trim(),
      client_secret: (process.env.AUTOHDR_CLIENT_SECRET || "").trim(),
      scope,
      // resource is required: omitting it makes every /v1 call 401.
      resource: `${API()}/v1`,
    }),
    cache: "no-store",
  });
}

let grantedScopes: string | null = null;

async function token(): Promise<string> {
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  // Ask for the preset scopes too. If this API client wasn't granted them,
  // fall back to the core set so shoots still run; presets just stay off.
  let scope = SCOPES;
  let r = await requestToken(scope);
  if (!r.ok) {
    const body = await r.text();
    if (r.status < 500 && /invalid_scope/i.test(body)) {
      scope = CORE_SCOPES;
      r = await requestToken(scope);
    } else {
      throw new AutoHdrError(`Editing account sign-in failed (${r.status}). Check AUTOHDR_CLIENT_ID and AUTOHDR_CLIENT_SECRET.`, r.status, "auth");
    }
  }
  if (!r.ok) throw new AutoHdrError(`Editing account sign-in failed (${r.status}). Check AUTOHDR_CLIENT_ID and AUTOHDR_CLIENT_SECRET.`, r.status, "auth");
  const j = await r.json();
  grantedScopes = j.scope || scope;
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 1800) * 1000 };
  return cached.token;
}

// For the health endpoint: mints a token and reads /v1/me. Never returns secrets.
export async function probeEditing(): Promise<Record<string, unknown>> {
  if (!hasAutoHdr()) return { configured: false };
  try {
    const t = await token();
    const r = await fetch(`${API()}/v1/me`, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" });
    const j = r.ok ? await r.json().catch(() => null) : null;
    return {
      configured: true,
      tokenOk: true,
      scopes: grantedScopes,
      meStatus: r.status,
      account: j?.email ?? j?.user?.email ?? j?.username ?? null,
      credits: j?.credits ?? j?.credit_balance ?? j?.balance ?? null,
    };
  } catch (e) {
    return { configured: true, tokenOk: false, error: e instanceof Error ? e.message.slice(0, 160) : String(e) };
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown> & T;
  if (!r.ok) {
    const code = typeof j.error === "string" ? j.error : null;
    let msg = String(j.error_description || j.detail || j.message || j.error || `editing api ${r.status}`);
    // Validation errors carry the specifics in nested fields; keep a short tail so the log says why.
    if (r.status >= 400 && r.status < 500) {
      const detail = JSON.stringify(j).slice(0, 300);
      if (detail && detail !== "{}" && !msg.includes(detail)) msg = `${msg} ${detail}`;
    }
    throw new AutoHdrError(msg, r.status, code);
  }
  return j;
}

// ---- Models and looks ----------------------------------------------------

export type EditModel = {
  id: number;
  name: string;
  description: string | null;
  variant: "indoor" | "outdoor" | "indoor/outdoor";
  type: "predefined" | "custom";
  credits: number | null; // per photo
};

// Demo-mode and offline fallback only. The real list is fetched live from
// /v1/models; new models appear there without a deploy here.
// Credit costs on the business's own account can differ from the public list the API
// returns. STUDIO_CREDIT_OVERRIDES is "modelId=credits,modelId=credits"; the
// default covers Aura, which bills the business 5 a photo (Nov 2 2026; the old
// default of 3 under-read every shoot page by 40%, 925 Example Spruce showed 411 for
// a 685-credit shoot).
const DEFAULT_CREDIT_OVERRIDES = "37=5";
export function accountCredits(modelId: number, apiCredits: number | null): number | null {
  const raw = (process.env.STUDIO_CREDIT_OVERRIDES || DEFAULT_CREDIT_OVERRIDES).trim();
  for (const pair of raw.split(",")) {
    const [id, cr] = pair.split("=").map((x) => x.trim());
    if (Number(id) === modelId && cr !== "" && !Number.isNaN(Number(cr))) return Number(cr);
  }
  return apiCredits;
}

export const FALLBACK_MODELS: EditModel[] = [
  { id: 37, name: "Aura", description: "Handcrafted, flash composite look", variant: "indoor/outdoor", type: "custom", credits: 3 },
  { id: 114, name: "Luxe", description: "Precise light, natural balance", variant: "indoor/outdoor", type: "custom", credits: 5 },
  { id: 46, name: "Brut", description: "Amplify directional light with a refined flash look", variant: "indoor", type: "custom", credits: 5 },
  { id: 47, name: "Brut", description: "Amplify directional light with a refined flash look", variant: "outdoor", type: "custom", credits: 5 },
  { id: 43, name: "Fuse", description: "First ever true flambient model", variant: "indoor/outdoor", type: "custom", credits: 2 },
  { id: 140, name: "True", description: "Organic tones, subtle refinement", variant: "indoor/outdoor", type: "custom", credits: 2 },
  { id: 153, name: "Melt", description: "The first model with creator presets", variant: "indoor/outdoor", type: "custom", credits: 1 },
  { id: 80, name: "Editorial | Moody", description: "Magazine feel, grounded in reality", variant: "indoor/outdoor", type: "custom", credits: 3 },
  { id: 81, name: "Editorial | Bright", description: "Magazine feel, grounded in reality", variant: "indoor/outdoor", type: "custom", credits: 3 },
  { id: 73, name: "Kasl | Airy", description: "Bright, open and clean", variant: "indoor/outdoor", type: "custom", credits: 5 },
  { id: 79, name: "Kasl | Moody", description: "Rich, dimensional and atmospheric", variant: "indoor/outdoor", type: "custom", credits: 5 },
  { id: 82, name: "Kasl | Balanced", description: "Natural light, color and contrast", variant: "indoor/outdoor", type: "custom", credits: 5 },
  { id: 25, name: "Iris With Clouds", description: "Flagship HDR model", variant: "indoor", type: "predefined", credits: 1 },
  { id: 26, name: "Iris Blue Sky", description: "Cloudless, blue sky replacement", variant: "indoor", type: "predefined", credits: 1 },
  { id: 27, name: "Iris Original Sky", description: "Preserves the original sky", variant: "indoor", type: "predefined", credits: 1 },
  { id: 30, name: "Iris Fluffy Wispy Clouds", description: "Fluffy and wispy clouds", variant: "outdoor", type: "predefined", credits: 1 },
  { id: 31, name: "Iris Original Sky", description: "Preserves the original sky", variant: "outdoor", type: "predefined", credits: 1 },
  { id: 32, name: "Iris Blue Sky", description: "Cloudless, blue sky replacement", variant: "outdoor", type: "predefined", credits: 1 },
  { id: 1, name: "Classic", description: "Natural, beautiful look for interiors", variant: "indoor", type: "predefined", credits: 1 },
  { id: 3, name: "Lisa", description: "Extra pop and deep window pulls", variant: "indoor", type: "predefined", credits: 1 },
];

type RawModel = { id: number; name: string; description?: string | null; variant?: string; type?: string; style_credit_cost?: number | null; credit_cost?: number | null };

export async function listModels(): Promise<EditModel[]> {
  const j = await api<{ models?: RawModel[]; items?: RawModel[] }>("/v1/models");
  const raw = j.models ?? j.items ?? [];
  const models = raw
    .filter((m) => typeof m.id === "number" && m.name)
    .map<EditModel>((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? null,
      variant: (m.variant === "indoor" || m.variant === "outdoor" ? m.variant : "indoor/outdoor"),
      type: m.type === "predefined" ? "predefined" : "custom",
      credits: accountCredits(m.id, typeof m.style_credit_cost === "number" ? m.style_credit_cost : typeof m.credit_cost === "number" ? m.credit_cost : null),
    }));
  // Aura first, then the rest alphabetically: the default should be the first thing you see.
  return models.sort((a, b) => (a.id === AURA_MODEL_ID ? -1 : b.id === AURA_MODEL_ID ? 1 : a.name.localeCompare(b.name) || a.id - b.id));
}

// The twilight transform's looks, picked per shoot until Oct 27 2026. Kept
// so older shoots still show their look by name; every twilight now is the
// Champagne preset (src/lib/twilight-preset.ts).
export type TwilightLook = { id: string; name: string; description: string | null; credits: number };

export const FALLBACK_LOOKS: TwilightLook[] = [
  { id: "ember_golden_hour", name: "Ember Golden Hour", description: "Golden sky with shining pavement", credits: 5 },
  { id: "ember_twilight", name: "Ember Twilight", description: "Pink cotton candy clouds", credits: 5 },
  { id: "ember_dusk", name: "Ember Dusk", description: "Natural, late evening sky", credits: 5 },
  { id: "pink_early_evening", name: "Pink Early Evening", description: "Lightest, sun just down", credits: 5 },
  { id: "pink_sunset", name: "Pink Sunset", description: "Warm band at the horizon", credits: 5 },
  { id: "pink_twilight", name: "Pink Twilight", description: "Darkest, most dramatic", credits: 5 },
  { id: "purple_early_evening", name: "Purple Early Evening", description: "Lightest, sun just down", credits: 5 },
  { id: "purple_sunset", name: "Purple Sunset", description: "Warm band at the horizon", credits: 5 },
  { id: "purple_twilight", name: "Purple Twilight", description: "Darkest, most dramatic", credits: 5 },
  { id: "natural_early_evening", name: "Natural Early Evening", description: "Lightest, sun just down", credits: 5 },
  { id: "natural_sunset", name: "Natural Sunset", description: "Warm band at the horizon", credits: 5 },
  { id: "natural_twilight", name: "Natural Twilight", description: "Darkest, most dramatic", credits: 5 },
  { id: "golden_early_evening", name: "Golden Early Evening", description: "Lightest, sun just down", credits: 5 },
  { id: "golden_sunset", name: "Golden Sunset", description: "Warm band at the horizon", credits: 5 },
  { id: "golden_twilight", name: "Golden Twilight", description: "Darkest, most dramatic", credits: 5 },
];


// ---- Photoshoots ---------------------------------------------------------

export type UploadSlot = { filename: string; url: string; content_type: string };

// Creates the upstream photoshoot and returns one presigned PUT per file.
// The PUT URLs expire 5 minutes after this call: the caller must start
// uploading at once. For an NDA listing pass the NDA name, never an address.
export async function createPhotoshoot(p: {
  name: string;
  files: { filename: string; kind: "raw" | "display" }[];
  indoorModelId: number;
  outdoorModelId: number;
}): Promise<{ photoshootId: number; jobId: string; uploads: UploadSlot[] }> {
  const j = await api<{ photoshoot_id: number; job_id: string; uploads: UploadSlot[] }>("/v1/photoshoots", {
    method: "POST",
    body: JSON.stringify({
      // The API calls this field "address"; it is only ever a display name here.
      // Send nothing else: the endpoint rejects unknown fields with "Request validation failed".
      address: p.name,
      files: p.files,
      indoor_model_id: p.indoorModelId,
      outdoor_model_id: p.outdoorModelId,
    }),
  });
  if (!j.photoshoot_id || !j.job_id || !Array.isArray(j.uploads)) throw new AutoHdrError("Editing service did not return upload slots.", 502);
  return { photoshootId: j.photoshoot_id, jobId: j.job_id, uploads: j.uploads };
}

// Long enough for a slow raw, short enough that a hung PUT cannot hold the
// run (and the shoot's lease) until the function is killed.
const PUT_TIMEOUT_MS = 90_000;

// PUT one file to its presigned slot. A 403 whose body says the link expired
// is "slot_expired" (the engine sends the part again with fresh links); any
// other refusal, or a timeout, stops the shoot with the reason and a short
// piece of the response.
export async function putToSlot(slot: UploadSlot, body: Buffer): Promise<void> {
  let r: Response;
  try {
    r = await fetch(slot.url, { method: "PUT", headers: { "Content-Type": slot.content_type }, body: body as unknown as BodyInit, signal: AbortSignal.timeout(PUT_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new AutoHdrError(`Upload to editing timed out after ${PUT_TIMEOUT_MS / 1000} s for ${slot.filename}.`, 504, "put_timeout");
    throw e;
  }
  if (r.ok) return;
  // Storage errors are XML (<Code>AccessDenied</Code><Message>Request has expired</Message>): keep the words.
  const said = (await r.text().catch(() => ""))
    .replace(/<\?xml[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  if (r.status === 403 && /expired/i.test(said)) throw new AutoHdrError(`Upload link expired before the transfer finished (${said}).`, 403, "slot_expired");
  throw new AutoHdrError(`Upload to editing failed (${r.status}${said ? `: ${said}` : ""}) for ${slot.filename}.`, r.status, "put_failed");
}

// 202 → "committed"; 409 files_not_landed → "not_landed" (retry later);
// 409 conflict → already committed (treated as committed).
export async function commitPhotoshoot(photoshootId: number, jobId: string): Promise<"committed" | "not_landed"> {
  try {
    await api(`/v1/photoshoots/${photoshootId}/commit`, { method: "POST", body: JSON.stringify({ job_id: jobId }) });
    return "committed";
  } catch (e) {
    if (e instanceof AutoHdrError && e.status === 409) {
      if (e.code === "files_not_landed" || /not.?landed/i.test(e.message)) return "not_landed";
      return "committed"; // conflict: already committed
    }
    throw e;
  }
}

export type ShootStatusUpstream = {
  status: "in_progress" | "success" | "failure" | string;
  imageCount: number;
  awaitingFiles: boolean;
  pipeline: string | null;
};

export async function photoshootStatus(photoshootId: number): Promise<ShootStatusUpstream> {
  const j = await api<{ status: string; image_count?: number; photo_count?: number; awaiting_files?: boolean; pipeline?: string }>(
    `/v1/photoshoots/${photoshootId}/status`
  );
  return {
    status: j.status,
    imageCount: Number(j.image_count ?? j.photo_count ?? 0),
    awaitingFiles: Boolean(j.awaiting_files),
    pipeline: j.pipeline ?? null,
  };
}

export type EditedPhoto = { imageUuid: string; versionUuid: string; name: string | null };

type RawPhoto = { image_uuid: string; image_version_uuid?: string; current_image_version_uuid?: string; head_image_version_uuid?: string; name?: string; filename?: string; original_filename?: string };

// Every processed photo in gallery order (all pages).
export async function listPhotos(photoshootId: number): Promise<EditedPhoto[]> {
  const out: EditedPhoto[] = [];
  const size = 100;
  for (let page = 0; page < 30; page++) {
    const j = await api<{ photos?: RawPhoto[]; items?: RawPhoto[]; results?: RawPhoto[] }>(
      `/v1/photoshoots/${photoshootId}/photos?page=${page}&page_size=${size}`
    );
    const raw = j.photos ?? j.items ?? j.results ?? [];
    for (const p of raw) {
      if (!p.image_uuid) continue;
      out.push({
        imageUuid: p.image_uuid,
        versionUuid: p.image_version_uuid ?? p.current_image_version_uuid ?? p.head_image_version_uuid ?? "",
        name: p.name ?? p.filename ?? p.original_filename ?? null,
      });
    }
    if (raw.length < size) break;
  }
  return out;
}

// A photo's edit lineage, oldest first (what the editor's history panel shows).
export type HistoryStep = { versionUuid: string; parentUuid: string | null; isHead: boolean; label: string; description: string | null };
export async function photoHistory(photoshootId: number, imageUuid: string): Promise<HistoryStep[]> {
  const j = await api<{ steps?: { image_version_uuid: string; parent_image_version_uuid?: string | null; is_head?: boolean; label?: string; description?: string | null }[] }>(
    `/v1/photoshoots/${photoshootId}/photos/${imageUuid}/history`
  );
  return (j.steps ?? []).map((s) => ({ versionUuid: s.image_version_uuid, parentUuid: s.parent_image_version_uuid ?? null, isHead: Boolean(s.is_head), label: s.label ?? "", description: s.description ?? null }));
}

export async function currentHead(photoshootId: number, imageUuid: string): Promise<string> {
  const photos = await listPhotos(photoshootId);
  const p = photos.find((x) => x.imageUuid === imageUuid);
  if (!p || !p.versionUuid) throw new AutoHdrError("Photo is missing from the editing shoot.", 404);
  return p.versionUuid;
}

// Full-resolution URLs for the current head of each photo (6 hours).
export async function downloadUrls(photoshootId: number, images: { imageUuid: string; filename?: string }[]): Promise<string[]> {
  const j = await api<{ downloads: { url: string }[] }>(`/v1/photoshoots/${photoshootId}/photos/download`, {
    method: "POST",
    body: JSON.stringify({ images: images.map((i) => ({ image_uuid: i.imageUuid, ...(i.filename ? { filename: i.filename } : {}) })) }),
  });
  const urls = (j.downloads ?? []).map((d) => d.url);
  if (urls.length !== images.length) throw new AutoHdrError("Editing service returned the wrong number of download links.", 502);
  return urls;
}

// Free vision question about a photo. Returns the model's text.
export async function describePhoto(photoshootId: number, imageUuid: string, prompt: string): Promise<string> {
  const j = await api<Record<string, unknown>>(`/v1/photoshoots/${photoshootId}/photos/${imageUuid}/describe`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
  for (const k of ["description", "text", "answer", "result", "content"]) {
    if (typeof j[k] === "string") return j[k] as string;
  }
  return JSON.stringify(j);
}

export const SCENE_PROMPT =
  "Classify this real estate photo. Answer with exactly one token and nothing else: EXTERIOR_DAY (front or back exterior of the home shot from the ground in daylight), AERIAL_DAY (drone or aerial view in daylight), INTERIOR (any indoor room), or OTHER (detail, twilight, night, or anything else).";

export type SceneClass = "EXTERIOR_DAY" | "AERIAL_DAY" | "INTERIOR" | "OTHER";
export function snapScene(answer: string): SceneClass {
  const a = answer.toUpperCase();
  if (a.includes("EXTERIOR_DAY") || (a.includes("EXTERIOR") && !a.includes("INTERIOR"))) return "EXTERIOR_DAY";
  if (a.includes("AERIAL")) return "AERIAL_DAY";
  if (a.includes("INTERIOR")) return "INTERIOR";
  return "OTHER";
}

// ---- Presets (Oct 27 2026: every virtual twilight is the owner's Champagne) ----
//
// A preset saved in the AutoHDR account, run by its uuid. Unlike the
// API's `style` transform (which re-renders from the original merge at
// 3300x2200), a preset runs on the version passed, so Champagne lands on the
// Aura edit exactly as in the AutoHDR app. Private presets are not listed by
// the API but can be read and run by uuid by the account that owns them.

export type PresetInfo = { uuid: string; name: string; creditCost: number | null; makesClip: boolean; isPublic: boolean; extraPorts: number };

export async function getPreset(uuid: string): Promise<PresetInfo> {
  const j = await api<{ preset_uuid: string; name: string; credit_cost?: number | null; makes_clip?: boolean; is_public?: boolean; input_ports?: { key: string }[] }>(`/v1/presets/${encodeURIComponent(uuid)}`);
  return {
    uuid: j.preset_uuid || uuid,
    name: j.name,
    creditCost: typeof j.credit_cost === "number" ? j.credit_cost : null,
    makesClip: Boolean(j.makes_clip),
    isPublic: Boolean(j.is_public),
    extraPorts: (j.input_ports ?? []).filter((p) => p.key !== "subject").length,
  };
}

// One run per photo, at the version given (the Aura head). Returns each
// target's workflow uuid (poll it with transformJob) or why it did not start.
export async function runPreset(uuid: string, items: { photoshootId: number; imageUuid: string; versionUuid: string }[]): Promise<{ imageUuid: string; workflowUuid: string | null; error: string | null }[]> {
  const j = await api<{ items: { image_uuid: string; workflow_uuid?: string | null; error?: string | null }[] }>(`/v1/presets/${encodeURIComponent(uuid)}/run`, {
    method: "POST",
    body: JSON.stringify({ items: items.map((i) => ({ photoshoot_id: i.photoshootId, image_uuid: i.imageUuid, image_version_uuid: i.versionUuid })) }),
  });
  return (j.items ?? []).map((i) => ({ imageUuid: i.image_uuid, workflowUuid: i.workflow_uuid ?? null, error: i.error ?? null }));
}

// ---- Transforms ----------------------------------------------------------

export async function transformJob(jobId: string): Promise<{
  status: "queued" | "running" | "succeeded" | "failed" | string;
  outputVersionUuid: string | null;
  failureMessage: string | null;
}> {
  const j = await api<{ status: string; output_image_version_uuid?: string | null; failure_code?: string; failure_message?: string }>(
    `/v1/transforms/${jobId}`
  );
  return {
    status: j.status,
    outputVersionUuid: j.output_image_version_uuid ?? null,
    failureMessage: j.failure_message ?? j.failure_code ?? null,
  };
}

// Point a photo back at an earlier version (free). Used after a twilight so
// the day photo stays the day photo.
export async function setPhotoVersion(photoshootId: number, imageUuid: string, versionUuid: string): Promise<void> {
  await api(`/v1/photoshoots/${photoshootId}/photos/${imageUuid}/version`, {
    method: "POST",
    body: JSON.stringify({ image_version_uuid: versionUuid }),
  });
}
