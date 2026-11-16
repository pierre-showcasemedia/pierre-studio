// Quo (formerly OpenPhone), the business's texting line (business.phone).
// READ ONLY. The portal and every Claude never text, call or message a client
// through Quo. This module
// verifies webhook deliveries and GETs threads and media. Never add a method
// that sends, and never call a Quo endpoint with anything but GET.
//
//   QUO_WEBHOOK_SECRET  signing secret of the webhook that posts to /api/inbound/quo
//   QUO_API_KEY         used for GET requests only (thread context, photos)
import { createHmac, timingSafeEqual } from "node:crypto";
import { business } from "./business";

export const QUO_API = "https://api.openphone.com/v1";
// The business line in E.164 ("(208) 555-0100" → "+12085550100").
export const QUO_LINE_E164: string = (() => {
  const d = business.phone.replace(/\D/g, "");
  return d ? `+${d.length === 10 ? `1${d}` : d}` : "";
})();

export function hasQuoWebhookSecret(): boolean {
  return Boolean((process.env.QUO_WEBHOOK_SECRET || "").trim());
}

export function hasQuoApiKey(): boolean {
  return Boolean((process.env.QUO_API_KEY || "").trim());
}

export type QuoVerify = { ok: boolean; scheme: "openphone" | "standard" | null; timestampMs: number | null };

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const toMs = (ts: string): number | null => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
};

// The secret is base64 ("Reveal signing secret" in Quo), with a whsec_ prefix
// when the webhook was made through the newer API. Quo's own Node example
// passes the decoded bytes as a "binary" string, which Node then re-encodes as
// UTF-8, so both key forms are tried.
function keyForms(secret: string): Buffer[] {
  const bytes = Buffer.from(secret.trim().replace(/^whsec_/, ""), "base64");
  const asBinaryString = Buffer.from(bytes.toString("binary"), "utf8");
  return asBinaryString.equals(bytes) ? [bytes] : [bytes, asBinaryString];
}

// Two schemes, depending on how the webhook was created:
//   openphone-signature: hmac;1;<timestamp>;<base64 HMAC-SHA256 of `${timestamp}.${payload}`>
//     where payload is the JSON with its whitespace removed (we try the raw body,
//     the re-serialised body, and the body stripped of all whitespace)
//   webhook-id / webhook-timestamp / webhook-signature (Standard Webhooks):
//     "v1,<base64 HMAC-SHA256 of `${id}.${timestamp}.${rawBody}`>", space separated
export function verifyQuoSignature(raw: string, headers: Headers, secret: string): QuoVerify {
  const keys = keyForms(secret);
  const legacy = headers.get("openphone-signature");
  if (legacy) {
    const [scheme, version, ts, digest] = legacy.split(";");
    if (scheme !== "hmac" || version !== "1" || !ts || !digest) return { ok: false, scheme: "openphone", timestampMs: null };
    let compact: string | null = null;
    try {
      compact = JSON.stringify(JSON.parse(raw));
    } catch {}
    const payloads = [...new Set([raw, compact, raw.replace(/\s+/g, "")].filter((p): p is string => p !== null))];
    for (const key of keys) {
      for (const payload of payloads) {
        if (sameText(createHmac("sha256", key).update(`${ts}.${payload}`).digest("base64"), digest)) return { ok: true, scheme: "openphone", timestampMs: toMs(ts) };
      }
    }
    return { ok: false, scheme: "openphone", timestampMs: toMs(ts) };
  }
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sig = headers.get("webhook-signature");
  if (id && ts && sig) {
    for (const key of keys) {
      const mac = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
      for (const part of sig.split(" ")) {
        const [v, d] = part.split(",");
        if (v === "v1" && d && sameText(mac, d)) return { ok: true, scheme: "standard", timestampMs: toMs(ts) };
      }
    }
    return { ok: false, scheme: "standard", timestampMs: toMs(ts) };
  }
  return { ok: false, scheme: null, timestampMs: null };
}

// GET only. The one way the portal talks to the Quo API.
export async function quoGet<T = unknown>(path: string, params: Record<string, string | string[]> = {}): Promise<T> {
  const key = (process.env.QUO_API_KEY || "").trim();
  if (!key) throw new Error("QUO_API_KEY is not set");
  const url = new URL(`${QUO_API}${path}`);
  for (const [k, v] of Object.entries(params)) for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
  const res = await fetch(url, { method: "GET", headers: { Authorization: key }, cache: "no-store" });
  if (!res.ok) throw new Error(`Quo GET ${path}: ${res.status}`);
  return (await res.json()) as T;
}

// ---- Read helpers for the revision intake (GET only) ---------------------

type Page<T> = { data?: T[]; nextPageToken?: string | null };

// Every page of a list endpoint (maxResults 100 where Quo allows it).
export async function quoPages<T>(path: string, params: Record<string, string | string[]> = {}, max = 2000): Promise<T[]> {
  const out: T[] = [];
  let token: string | null | undefined;
  do {
    const page = await quoGet<Page<T>>(path, { maxResults: "50", ...params, ...(token ? { pageToken: token } : {}) });
    out.push(...(page.data ?? []));
    token = page.nextPageToken;
  } while (token && out.length < max);
  return out;
}

export type QuoMessage = { id: string; from?: string; to?: string[] | string; text?: string; body?: string; media?: { url?: string; type?: string }[]; direction?: string; createdAt?: string; conversationId?: string; phoneNumberId?: string };

// The business line's Quo id (PN...), looked up once per instance.
let _lineId: string | null = null;
export async function quoLineId(): Promise<string> {
  if (_lineId) return _lineId;
  const nums = await quoPages<{ id: string; number?: string }>("/phone-numbers");
  const line = nums.find((n) => n.number === QUO_LINE_E164);
  if (!line) throw new Error("The business line is not on this Quo account");
  _lineId = line.id;
  return line.id;
}

// A thread on the business line (one number, or every number of a group thread),
// both directions, oldest first.
export async function quoThread(participants: string | string[], since: Date, until?: Date): Promise<QuoMessage[]> {
  const pn = await quoLineId();
  const list = Array.isArray(participants) ? participants : [participants];
  const rows = await quoPages<QuoMessage>("/messages", { phoneNumberId: pn, "participants[]": list, createdAfter: since.toISOString(), ...(until ? { createdBefore: until.toISOString() } : {}) }, 500);
  return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// Conversations on the business line with activity since a date (for backfill).
export async function quoConversationsSince(since: Date): Promise<{ id: string; participants?: string[] }[]> {
  const pn = await quoLineId();
  return quoPages("/conversations", { "phoneNumbers[]": [pn], updatedAfter: since.toISOString() }, 500);
}

// Every number in a conversation (group threads have several), or null.
export async function quoConversationParticipants(conversationId: string, activeSince: Date): Promise<string[] | null> {
  const convs = await quoConversationsSince(activeSince);
  return convs.find((c) => c.id === conversationId)?.participants ?? null;
}

// Email addresses Quo's contacts hold for a phone number (cached 10 minutes).
let _book: { at: number; byPhone: Map<string, string[]> } | null = null;
const last10 = (p: string) => p.replace(/\D/g, "").slice(-10);
export async function quoContactEmails(phone: string): Promise<string[]> {
  if (!_book || Date.now() - _book.at > 10 * 60_000) {
    const contacts = await quoPages<{ defaultFields?: { phoneNumbers?: { value?: string }[]; emails?: { value?: string }[] } }>("/contacts", {}, 3000);
    const byPhone = new Map<string, string[]>();
    for (const c of contacts) {
      const emails = (c.defaultFields?.emails ?? []).map((e) => (e.value || "").trim().toLowerCase()).filter((e) => e.includes("@"));
      if (!emails.length) continue;
      for (const n of c.defaultFields?.phoneNumbers ?? []) {
        const k = last10(n.value || "");
        if (k.length === 10) byPhone.set(k, [...new Set([...(byPhone.get(k) ?? []), ...emails])]);
      }
    }
    _book = { at: Date.now(), byPhone };
  }
  return _book.byPhone.get(last10(phone)) ?? [];
}

// A photo a client sent, as bytes. Quo's media links are usually public;
// when one is not, the same GET is tried with the API key.
export async function quoMedia(url: string): Promise<Buffer | null> {
  for (const auth of [false, true]) {
    const key = (process.env.QUO_API_KEY || "").trim();
    if (auth && !key) break;
    const res = await fetch(url, { method: "GET", headers: auth ? { Authorization: key } : {}, cache: "no-store" }).catch(() => null);
    if (res?.ok) return Buffer.from(await res.arrayBuffer());
  }
  return null;
}
