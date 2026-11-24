// Files a client attaches on the website's booking form (Nov 24 2026: the
// plat or lot map). The website asks this studio for a short-lived upload
// address (POST /api/studio/intake-upload, with the intake secret), the
// browser sends the file straight to R2, and the booking then carries
// { key, name, kind } in its payload (bookings.raw.payload.attachments).
//
// Only an admin ever opens one (GET /api/studio/intake-file), and only when
// its key sits under that booking's own submission id: a payload can't point
// the studio at any other object in the bucket. Nothing is shown to clients.
export const INTAKE_PREFIX = "intake/";
export const INTAKE_MAX_BYTES = 25 * 1024 * 1024;
export const INTAKE_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
export const INTAKE_KINDS = ["plat"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];
export type IntakeAttachment = { key: string; name: string; kind: IntakeKind };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A file name safe for a storage key and a download: letters, digits, dot,
// dash and underscore, at most 80 characters, keeping the extension.
export function safeName(name: string, contentType: string): string {
  const ext = INTAKE_TYPES[contentType] ?? "bin";
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 70);
  return `${base || "file"}.${ext}`;
}

export function intakeKey(submissionId: string, name: string, contentType: string, nonce: string): string | null {
  const id = submissionId.toLowerCase();
  if (!UUID_RE.test(id) || !/^[a-z0-9]{6,16}$/.test(nonce)) return null;
  return `${INTAKE_PREFIX}${id}/${nonce}-${safeName(name, contentType)}`;
}

// What a request for an upload address may ask for.
export function checkUpload(input: { submissionId: string; contentType: string; size: number }): string | null {
  if (!UUID_RE.test(input.submissionId.toLowerCase())) return "submission_id";
  if (!INTAKE_TYPES[input.contentType]) return "Please attach a PDF or a photo (JPG, PNG, WebP or HEIC).";
  if (!Number.isFinite(input.size) || input.size <= 0) return "That file looks empty.";
  if (input.size > INTAKE_MAX_BYTES) return "That file is over 25 MB. Please send a smaller one, or a link instead.";
  return null;
}

// The attachments a booking may open: from its stored payload, each under
// one of the booking's own submission ids.
export function bookingAttachments(raw: { submissionIds?: string[]; payload?: Record<string, unknown> } | null | undefined, bookingId: string): IntakeAttachment[] {
  if (!raw?.payload) return [];
  const ids = new Set([bookingId, ...(raw.submissionIds ?? [])].map((s) => String(s).toLowerCase()).filter((s) => UUID_RE.test(s)));
  const list = Array.isArray(raw.payload.attachments) ? raw.payload.attachments : [];
  const out: IntakeAttachment[] = [];
  for (const a of list.slice(0, 5)) {
    if (!a || typeof a !== "object") continue;
    const { key, name, kind } = a as Record<string, unknown>;
    if (typeof key !== "string" || !key.startsWith(INTAKE_PREFIX) || key.includes("..") || key.length > 200) continue;
    const owner = key.slice(INTAKE_PREFIX.length).split("/")[0];
    if (!ids.has(owner) || key.split("/").length !== 3) continue;
    const k = (INTAKE_KINDS as readonly string[]).includes(String(kind)) ? (kind as IntakeKind) : "plat";
    out.push({ key, name: typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : key.split("/").pop()!, kind: k });
  }
  return out;
}
