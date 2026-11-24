// Book again tokens (studio template, Nov 24 2026). The portal's Book again
// link carries one short signed token, ?again=<token>, never the client's
// name, email, phone or company (those would sit in browser history, server
// logs and referrers). The website never reads it; its own server hands it
// back to the studio (GET /api/studio/book-again?token=..., with the intake
// secret) and gets the prefill from there.
//
// The token is 36 bytes, base64url (48 characters): the client id (16 bytes
// of its uuid), the expiry (4 bytes, seconds since 1970) and the first 16
// bytes of an HMAC-SHA256 over both, keyed with the studio's own AUTH_SECRET
// (no new secret). Nothing personal is inside it, and it is only good for 30
// days. The pure functions take the secret so the check script can run them
// with a test value.
import { createHmac, timingSafeEqual } from "node:crypto";

export const BOOK_AGAIN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DOMAIN = "studio.book-again.v1";
const PAYLOAD_BYTES = 20;
const SIG_BYTES = 16;
const TOKEN_RE = /^[A-Za-z0-9_-]{48}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mac = (secret: Uint8Array | string, payload: Buffer): Buffer => createHmac("sha256", Buffer.from(secret)).update(DOMAIN).update(payload).digest().subarray(0, SIG_BYTES);

export function signBookAgainToken(clientId: string, secret: Uint8Array | string, nowMs: number = Date.now(), ttlSeconds: number = BOOK_AGAIN_TTL_SECONDS): string {
  if (!UUID_RE.test(clientId)) throw new Error("book again: not a client id");
  if (!secret || !secret.length) throw new Error("book again: no secret");
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  Buffer.from(clientId.replace(/-/g, ""), "hex").copy(payload, 0);
  payload.writeUInt32BE(Math.floor(nowMs / 1000) + Math.max(1, Math.floor(ttlSeconds)), 16);
  return Buffer.concat([payload, mac(secret, payload)]).toString("base64url");
}

// The client id, or null for anything malformed, mis-signed or expired.
export function verifyBookAgainToken(token: unknown, secret: Uint8Array | string, nowMs: number = Date.now()): { clientId: string; expiresAt: number } | null {
  if (typeof token !== "string" || !TOKEN_RE.test(token) || !secret || !secret.length) return null;
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== PAYLOAD_BYTES + SIG_BYTES) return null;
  const payload = raw.subarray(0, PAYLOAD_BYTES);
  const sig = raw.subarray(PAYLOAD_BYTES);
  if (!timingSafeEqual(sig, mac(secret, payload))) return null;
  const exp = payload.readUInt32BE(16);
  if (exp * 1000 <= nowMs) return null;
  const hex = payload.subarray(0, 16).toString("hex");
  const clientId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { clientId, expiresAt: exp * 1000 };
}

// The prefill the website gets back for a good token: who is booking, never
// prices. Names split the way the website's form has them.
export type BookAgainPrefill = { firstName: string; lastName: string; email: string; phone: string; company: string; type: string };

export function bookAgainPrefill(client: { name: string | null; email: string; phone: string | null; company: string | null }, clientType: string | null): BookAgainPrefill {
  const [first, ...rest] = (client.name ?? "").trim().split(/\s+/).filter(Boolean);
  return { firstName: first ?? "", lastName: rest.join(" "), email: client.email, phone: client.phone ?? "", company: client.company ?? "", type: clientType ?? "" };
}
