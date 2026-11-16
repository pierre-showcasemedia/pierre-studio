// hello@ → revision intake (Oct 27 2026). the owner: a client emailed a revision
// to hello@ and nothing filed it, because the intake (src/lib/revision-intake.ts)
// only read texts on the Quo line. The minute cron now reads hello@'s mail too.
//
// Read only: Gmail as hello@ through the booking calendar's service account
// (domain-wide delegation, scope gmail.readonly, added by the owner Oct 27 2026).
// Nothing is ever sent, labelled, archived or deleted in hello@.
//
// Each tick lists hello@'s mail since GO_LIVE (at most LOOKBACK_DAYS back),
// skips what inbound_messages already holds (source "email", keyed on the
// Gmail message id) and stores each new message BEFORE anything acts on it:
//   - mail from a person: the client's own words (what sits above any quoted
//     earlier message), with the subject and the quoted part kept as context
//     (they often name the listing), and photo attachments as references that
//     are only downloaded when the intake reads them. Status new and one
//     inbound.revision job, exactly like a text: the intake waits BURST_MS,
//     reads the Gmail thread for context, then files a revision ("By email"),
//     parks it in "couldn't place", or ignores it.
//   - our own mail, automated mail (no-reply senders, mailing lists,
//     auto-replies, calendar responses, Promotions / Social / Forums) and
//     anything older than GO_LIVE: stored as "ignored" with the reason and no
//     text, so it is read once and never goes to the model.
//
// On from production (like the calendar sync); EMAIL_INTAKE=on turns it on
// elsewhere, =off turns it off. The hub hears once when reading hello@ starts
// failing and once when it works again (settings key EMAIL_STATUS_KEY).
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { InboundMedia } from "@/db/schema";
import { calendarUser, googleToken, hasGoogleKeys } from "./google-calendar";
import { currentEnv, enqueueJobs, jobKey } from "./jobs-core";
import type { IntakeMsg } from "./revision-intake";
import { BURST_MS } from "./revision-intake";
import { flagged, postToHub } from "./slack";
import { emailFrom, mailDomain } from "./brand";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// Midnight local, Oct 27 2026: the first morning's email is read, nothing older.
export const GO_LIVE = Date.parse("2026-10-27T07:00:00Z");
const LOOKBACK_DAYS = 3;
const MAX_PER_TICK = 20;
const MIN_IMAGE_BYTES = 15_000; // smaller images are signature logos and icons
const MAX_IMAGES = 6;
const BODY_MAX = 8000;
const QUOTED_MAX = 3000;
export const EMAIL_STATUS_KEY = "email_intake.status";

// Our own addresses: never a client, never read as a request.
const OWN_DOMAINS = [...new Set([mailDomain(), (emailFrom().match(/@([^>\s]+)/)?.[1] ?? "").toLowerCase()].filter(Boolean))];

export function hasEmailIntake(): boolean {
  const flag = (process.env.EMAIL_INTAKE || "").trim().toLowerCase();
  if (flag === "off" || !hasGoogleKeys()) return false;
  return currentEnv() === "production" || flag === "on";
}

async function gmail<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${await googleToken(GMAIL_SCOPE)}` }, cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${j.error?.message ?? "request failed"}`);
  return j;
}

// ---- reading one message (pure, checked by scripts/check-email-intake.ts) ----

export type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};
export type GmailMessage = { id: string; threadId: string; labelIds?: string[]; internalDate?: string; snippet?: string; payload?: GmailPart };

export type ParsedEmail = {
  id: string;
  threadId: string;
  at: Date;
  fromEmail: string | null;
  fromName: string | null;
  to: string | null;
  subject: string;
  labels: string[];
  headers: Record<string, string>; // lower-case names, first value
  fresh: string; // the sender's own words
  quoted: string; // the earlier message their email quoted, if any
  images: InboundMedia[];
  hasCalendar: boolean;
};

const decode = (data?: string) => (data ? Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "");

function walk(p: GmailPart | undefined, out: GmailPart[] = []): GmailPart[] {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts ?? []) walk(c, out);
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<blockquote[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The text of the message: text/plain when there is one, else the HTML as text.
export function bodyText(payload: GmailPart | undefined): string {
  const parts = walk(payload).filter((p) => !p.body?.attachmentId && !p.filename);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return decode(plain.body!.data).replace(/\r\n/g, "\n");
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  return html ? htmlToText(decode(html.body!.data)) : "";
}

// Where the quoted history starts in a reply: Gmail / Apple "On … wrote:"
// (wrapped over two lines when long), Outlook's header block or separator,
// "Original Message", or the first run of "> " lines.
const CUTS = [
  /^[ \t]*On [^\n]{0,300}(?:\n[^\n]{0,200})?wrote:[ \t]*$/m,
  /^[ \t]*-{2,}\s*Original Message\s*-{2,}/im,
  /^[ \t]*_{10,}[ \t]*$/m,
  /^[ \t]*From:[^\n]+\n(?:[^\n]*\n){0,3}?[ \t]*(?:Sent|Date):[ \t]/im,
  /^>/m,
];

export function splitReply(text: string): { fresh: string; quoted: string } {
  const t = text.replace(/\r\n/g, "\n");
  let at = t.length;
  for (const re of CUTS) {
    const m = re.exec(t);
    if (m && m.index < at) at = m.index;
  }
  let fresh = t.slice(0, at);
  // A signature after "-- " and phone footers are not the request.
  fresh = fresh.split(/\n-- ?\n/)[0].replace(/\n\s*Sent from my [^\n]*\s*$/i, "");
  const quoted = t
    .slice(at)
    .split("\n")
    .map((l) => l.replace(/^(\s*>)+\s?/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { fresh: fresh.replace(/\n{3,}/g, "\n\n").trim(), quoted: quoted.slice(0, QUOTED_MAX) };
}

export function parseFrom(v: string | undefined): { email: string | null; name: string | null } {
  if (!v) return { email: null, name: null };
  const angle = v.match(/<([^<>\s]+@[^<>\s]+)>/);
  const email = (angle ? angle[1] : v.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? "").trim().toLowerCase() || null;
  const name = angle ? v.slice(0, angle.index).replace(/^["'\s]+|["'\s]+$/g, "").trim() || null : null;
  return { email, name };
}

export function parseMessage(m: GmailMessage): ParsedEmail {
  const headers: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) {
    const k = h.name.toLowerCase();
    if (!(k in headers)) headers[k] = h.value;
  }
  const from = parseFrom(headers.from);
  const all = walk(m.payload);
  const images = all
    .filter((p) => p.body?.attachmentId && (p.mimeType ?? "").startsWith("image/") && (p.body.size ?? 0) >= MIN_IMAGE_BYTES)
    .slice(0, MAX_IMAGES)
    .map((p) => ({ url: `gmail:${m.id}/${p.body!.attachmentId}`, type: p.mimeType ?? null }));
  const { fresh, quoted } = splitReply(bodyText(m.payload));
  return {
    id: m.id,
    threadId: m.threadId,
    at: new Date(Number(m.internalDate) || Date.now()),
    fromEmail: from.email,
    fromName: from.name,
    to: parseFrom(headers.to).email,
    subject: (headers.subject ?? "").trim().slice(0, 300),
    labels: m.labelIds ?? [],
    headers,
    fresh: fresh.slice(0, BODY_MAX),
    quoted,
    images,
    hasCalendar: all.some((p) => p.mimeType === "text/calendar" || /\.ics$/i.test(p.filename ?? "")),
  };
}

const NOREPLY = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|calendar-notification|automated|system|billing|receipts?|invoice\+statements|support\+noreply)([+._-]|@)/i;
const CAL_SUBJECT = /^(accepted|declined|tentatively accepted|invitation|updated invitation|canceled event|cancelled event|new event|event updated)( \([^)]*\))?:/i;
const SKIP_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM", "TRASH", "DRAFT", "SENT"];

// Why a message is not something a client wrote to us (null = read it).
export function skipReason(e: ParsedEmail, opts: { goLive?: number; self?: string } = {}): string | null {
  if (e.at.getTime() < (opts.goLive ?? GO_LIVE)) return "before the email intake went live";
  if (!e.fromEmail) return "no sender";
  const domain = e.fromEmail.split("@")[1] ?? "";
  if (e.fromEmail === (opts.self ?? "").toLowerCase() || OWN_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return "our own mail";
  const label = e.labels.find((l) => SKIP_LABELS.includes(l));
  if (label) return `Gmail ${label.replace("CATEGORY_", "").toLowerCase()}`;
  if (NOREPLY.test(e.fromEmail)) return "automated sender";
  const auto = (e.headers["auto-submitted"] ?? "").toLowerCase();
  if (auto && auto !== "no") return "auto-reply";
  if (e.headers["x-autoreply"] || e.headers["x-autorespond"] || /^(auto(matic)? reply|out of (the )?office)/i.test(e.subject)) return "auto-reply";
  if (e.headers["list-id"] || e.headers["list-unsubscribe"]) return "mailing list";
  if (/^(bulk|list|junk)$/i.test((e.headers.precedence ?? "").trim())) return "bulk mail";
  if (e.hasCalendar || CAL_SUBJECT.test(e.subject)) return "calendar response";
  if (!e.fresh && !e.images.length && !e.subject) return "empty";
  return null;
}

// ---- the poll ----------------------------------------------------------------

export type EmailPoll = { listed: number; known: number; stored: number; skipped: number; left: number };

async function listIds(sinceMs: number): Promise<string[]> {
  const q = `after:${Math.floor(sinceMs / 1000)} -from:me -in:chats -in:drafts`;
  const ids: string[] = [];
  let page: string | undefined;
  for (let i = 0; i < 5; i++) {
    const r = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?maxResults=100&q=${encodeURIComponent(q)}${page ? `&pageToken=${page}` : ""}`);
    ids.push(...(r.messages ?? []).map((m) => m.id));
    page = r.nextPageToken;
    if (!page) break;
  }
  return ids;
}

export async function pollHello(opts: { budgetMs?: number } = {}): Promise<EmailPoll> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 10_000;
  const since = Math.max(GO_LIVE, Date.now() - LOOKBACK_DAYS * 86_400_000);
  const ids = await listIds(since);
  const known = ids.length
    ? new Set((await db().query.inboundMessages.findMany({ where: and(eq(schema.inboundMessages.source, "email"), inArray(schema.inboundMessages.externalId, ids)), columns: { externalId: true } })).map((r) => r.externalId))
    : new Set<string>();
  const todo = ids.filter((id) => !known.has(id)).reverse(); // Gmail lists newest first; store oldest first
  const out: EmailPoll = { listed: ids.length, known: known.size, stored: 0, skipped: 0, left: todo.length };
  const self = calendarUser();
  for (const id of todo.slice(0, MAX_PER_TICK)) {
    if (Date.now() - started > budget) break;
    const e = parseMessage(await gmail<GmailMessage>(`/messages/${id}?format=full`));
    const why = skipReason(e, { self });
    const [row] = await db()
      .insert(schema.inboundMessages)
      .values({
        source: "email",
        externalId: e.id,
        conversationId: e.threadId,
        fromAddr: e.fromEmail,
        toAddr: e.to,
        body: why ? null : e.fresh,
        media: why ? [] : e.images,
        sentAt: e.at,
        env: currentEnv(),
        status: why ? "ignored" : "new",
        processedAt: why ? new Date() : null,
        result: why ? { reason: why } : null,
        raw: why ? { skipped: why } : { subject: e.subject, fromName: e.fromName, quoted: e.quoted || null, labels: e.labels },
      })
      .onConflictDoNothing({ target: [schema.inboundMessages.source, schema.inboundMessages.externalId] })
      .returning({ id: schema.inboundMessages.id });
    out.left--;
    if (!row) continue;
    if (why) {
      out.skipped++;
      continue;
    }
    out.stored++;
    await enqueueJobs([{ kind: "inbound.revision", idempotencyKey: jobKey("inbound.revision", row.id), payload: { version: 1, inboundId: row.id }, runAt: new Date(Date.now() + BURST_MS) }]);
  }
  return out;
}

// One hub line when reading hello@ starts failing, one when it works again.
export async function recordPoll(error: string | null): Promise<void> {
  const d = db();
  const prev = (await d.query.settings.findFirst({ where: eq(schema.settings.key, EMAIL_STATUS_KEY) }))?.value as { ok?: boolean } | undefined;
  const value = { ok: !error, error: error ? error.slice(0, 300) : null, at: new Date().toISOString() };
  await d.insert(schema.settings).values({ key: EMAIL_STATUS_KEY, value, updatedAt: new Date() }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  if (error && prev?.ok !== false) {
    await postToHub({ text: `${flagged("Revision emails to hello@ are not being read")}\n${value.error}` }).catch(() => false);
  } else if (!error && prev?.ok === false) {
    await postToHub({ text: "Revision emails to hello@ are being read again." }).catch(() => false);
  }
}

export async function emailIntakeStatus(): Promise<{ ok: boolean | null; error: string | null; at: string | null }> {
  const v = (await db().query.settings.findFirst({ where: eq(schema.settings.key, EMAIL_STATUS_KEY) }))?.value as { ok?: boolean; error?: string | null; at?: string } | undefined;
  return { ok: v?.ok ?? null, error: v?.error ?? null, at: v?.at ?? null };
}

// ---- what the intake reads ---------------------------------------------------

// A photo the client attached (InboundMedia url "gmail:<message>/<attachment>").
export async function gmailAttachment(url: string): Promise<Buffer | null> {
  const m = url.match(/^gmail:([^/]+)\/(.+)$/);
  if (!m) return null;
  try {
    const r = await gmail<{ data?: string }>(`/messages/${m[1]}/attachments/${encodeURIComponent(m[2])}`);
    return r.data ? Buffer.from(r.data.replace(/-/g, "+").replace(/_/g, "/"), "base64") : null;
  } catch (e) {
    console.error("[email-intake] attachment", e instanceof Error ? e.message : e);
    return null;
  }
}

// The rest of the Gmail thread as context: our replies from hello@ (the business) and
// the client's earlier mail, each without its quoted history.
export async function gmailThread(threadId: string, newIds: Set<string>): Promise<IntakeMsg[]> {
  const t = await gmail<{ messages?: GmailMessage[] }>(`/threads/${threadId}?format=full`);
  const self = calendarUser();
  return (t.messages ?? []).map((raw) => {
    const e = parseMessage(raw);
    const domain = (e.fromEmail ?? "").split("@")[1] ?? "";
    return {
      id: e.id,
      at: e.at,
      from: e.fromEmail,
      outgoing: e.fromEmail === self || OWN_DOMAINS.includes(domain),
      text: e.fresh,
      media: newIds.has(e.id) ? e.images : [],
      isNew: newIds.has(e.id),
      subject: e.subject,
    };
  });
}
