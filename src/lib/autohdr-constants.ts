// Constants that client components may import. Everything that talks to the
// network stays in src/lib/autohdr.ts (server only).
export const AURA_MODEL_ID = 37;
export const TWILIGHT_CREDITS = 5;
export const MAX_FILES_WARNING = 400;
// Oct 27 2026: the twilight slider runs 1 to 20.
export const TWILIGHT_MIN = 1;
export const TWILIGHT_MAX = 20;
export const TWILIGHT_DEFAULT_COUNT = 6;
export const RAW_ACCEPT = ".jpg,.jpeg,.dng,.arw,.cr2,.cr3,.nef,.raf,image/jpeg";

export const RAW_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  dng: "image/x-adobe-dng",
  arw: "image/x-sony-arw",
  cr2: "image/x-canon-cr2",
  cr3: "image/x-canon-cr3",
  nef: "image/x-nikon-nef",
  raf: "image/x-fuji-raf",
};

export function contentTypeFor(filename: string, fallback = "application/octet-stream"): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return RAW_CONTENT_TYPES[ext] || VIDEO_CONTENT_TYPES[ext] || fallback;
}

export function isAcceptedFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ext in RAW_CONTENT_TYPES;
}

// ---- Raw video (Oct 21 2026) --------------------------------------------
// Camera footage goes to Dropbox only, never to editing. Checked by extension
// (phones and card readers report odd or empty MIME types), so the list is
// generous: every container the team's cameras, drones and gimbals write.
// DNG sequences are photos, not video, and belong in the photo box.
export const VIDEO_CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  mxf: "application/mxf",
  braw: "application/octet-stream", // Blackmagic RAW
  r3d: "application/octet-stream", // RED
  crm: "application/octet-stream", // Canon Cinema RAW Light
  mts: "video/mp2t", // AVCHD
  m2ts: "video/mp2t",
  m2t: "video/mp2t",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  "3gp": "video/3gpp",
  insv: "application/octet-stream", // Insta360
  lrv: "video/mp4", // GoPro low-res proxy
  "360": "video/mp4", // GoPro 360
  ari: "application/octet-stream", // ARRIRAW
  prores: "video/quicktime",
};
export const VIDEO_ACCEPT = `${Object.keys(VIDEO_CONTENT_TYPES).map((e) => `.${e}`).join(",")},video/*`;
// One PUT to R2 tops out at 5 GB; a bigger clip is refused with a clear
// message instead of failing after an hour of upload (see STUDIO.md).
export const MAX_VIDEO_BYTES = 5_000_000_000;

export function isVideoFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ext in VIDEO_CONTENT_TYPES;
}
