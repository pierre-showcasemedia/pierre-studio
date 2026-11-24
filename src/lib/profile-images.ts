// The agent's headshot and brokerage logo (studio template #16, Nov 23 2026).
// The client adds them on the portal's Account tab; they show on the agent
// card of every property page of theirs (src/lib/property-page.ts). Off unless
// business.profileImages. No broker lookup: only what the agent uploads.
//
// Server-validated: images only (JPEG, PNG or WebP by their first bytes, never
// the name or the browser's type; never SVG), at most 4 MB, then re-encoded by
// the upload route (metadata dropped, bounded size), so what lands in R2 is
// always a clean image of a known type. Keys live under clients/<id>/profile/.
// The sniffing and the key are pure; scripts/check-profile-images.ts runs them.

export const PROFILE_KINDS = ["headshot", "logo"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];
export const isProfileKind = (v: unknown): v is ProfileKind => typeof v === "string" && (PROFILE_KINDS as readonly string[]).includes(v);

export const PROFILE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
// The upload is decoded once; refuse anything wider than this many pixels before decoding.
export const PROFILE_IMAGE_MAX_PIXELS = 40_000_000;

// What each kind becomes: a headshot is a JPEG (photos), a logo a PNG (keeps transparency).
export const PROFILE_OUTPUT: Record<ProfileKind, { width: number; height: number; format: "jpeg" | "png"; contentType: string; ext: string }> = {
  headshot: { width: 800, height: 800, format: "jpeg", contentType: "image/jpeg", ext: "jpg" },
  logo: { width: 800, height: 400, format: "png", contentType: "image/png", ext: "png" },
};

export type SniffedImage = "jpeg" | "png" | "webp";

// The file's real type from its first bytes, or null for anything that is not one of the three.
export function sniffImageType(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

// Why an upload is refused (client-facing words), or null when it may go ahead.
export function profileImageRefusal(f: { size: number; head: Uint8Array }): string | null {
  if (!f.size) return "Choose an image to upload.";
  if (f.size > PROFILE_IMAGE_MAX_BYTES) return "That image is larger than 4 MB. Please choose a smaller one.";
  if (!sniffImageType(f.head)) return "Please upload a JPG, PNG or WebP image.";
  return null;
}

// A fresh key per upload (the old object is removed after the row moves), so a
// cached image never shows after a change.
export function profileImageKey(clientId: string, kind: ProfileKind, nonce: string): string {
  const safeId = clientId.replace(/[^a-zA-Z0-9-]/g, "");
  const safeNonce = nonce.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  return `clients/${safeId}/profile/${kind}-${safeNonce}.${PROFILE_OUTPUT[kind].ext}`;
}

// Only keys this feature wrote are ever removed.
export const isProfileKey = (key: string | null | undefined, clientId: string): boolean => Boolean(key && key.startsWith(`clients/${clientId.replace(/[^a-zA-Z0-9-]/g, "")}/profile/`));

// The email the client row is looked up by, in the form every client row stores it.
export const profileLookupEmail = (email: string): string => email.trim().toLowerCase();

// An explicit same-origin check on the upload post, on top of the session
// cookie's SameSite. A post whose Origin header is present and is not one of
// this app's own origins is refused; one with no Origin header goes on to the
// session check. The route passes siteUrl() and the address the request came
// in on (a preview deployment).
const originOf = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
};

export function sameOriginPost(originHeader: string | null, ownOrigins: (string | null | undefined)[]): boolean {
  if (originHeader === null) return true;
  const given = originOf(originHeader.trim());
  if (!given) return false; // "null", garbage, another scheme
  return ownOrigins.some((o) => originOf(o) === given);
}
