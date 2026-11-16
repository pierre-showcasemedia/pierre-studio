// Revision intake (Oct 21 2026). Client texts to the Quo line land in
// inbound_messages (/api/inbound/quo). This turns the ones that ask for a
// revision into a revision request on /admin/revisions, and does nothing
// else: scheduling, access, payment, questions, thanks and everything that is
// not a revision is marked "ignored" and left alone (Oct 21 2026).
//
// One inbound.revision job per stored text, due BURST_MS after it lands.
// Clients send bursts (three texts and a photo), so the job waits until the
// conversation has been quiet for BURST_MS, claims every unprocessed text in
// it at once (status processing), and reads them together with the last few
// days of the thread. A claim older than STALE_CLAIM_MS is taken over.
//
//   1. Who: the sender's phone against clients.phone (last 10 digits), then the
//      emails Quo's contacts hold for that number against clients.email. The
//      client's team shares one library, so team listings count.
//   2. Is it a revision, and for which listing? One model call, text only.
//   3. Which photos? One model call with numbered contact sheets of the
//      listing's client-visible photos (src/lib/contact-sheet.ts) and the
//      photos the client sent. Notes per photo; a note about the whole gallery
//      becomes the request's general note.
//   4. File one request (source "quo", the client's own words kept), status
//      new and sent, and tell the team the way a portal request does. Unsure
//      about the listing or the photos: filed anyway with "Needs a look" and
//      the reason. A revision with no client or no listing: the texts stay
//      needs_review and show at the top of /admin/revisions.
//
// Read only toward Quo; never answers the client. Model: STUDIO_INTAKE_MODEL
// (default claude-sonnet-5-5) on ANTHROPIC_API_KEY.
//
// Oct 27 2026: emails to hello@ come through the same steps
// (src/lib/email-intake.ts stores them; source "email"). The sender's address
// is matched to clients.email, the Gmail thread is the context, the subject
// and the earlier message the email quoted are shown to the model, and the
// request is filed "By email".
import Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { InboundMedia } from "@/db/schema";
import { brand, emailFrom, notifyEmails, siteUrl } from "./brand";
import { contactSheets, modelImage, SHEET_SIZE } from "./contact-sheet";
import { currentEnv, DeferError, NotConfiguredError, SkipJobError } from "./jobs-core";
import { clientVisibleMedia } from "./media-visibility";
import { hasQuoApiKey, quoContactEmails, quoConversationParticipants, quoMedia, quoThread, type QuoMessage } from "./quo";
import { hubRevisionRequested } from "./slack";
import { linkVideoRevision } from "./video-board";

export const BURST_MS = 3 * 60_000; // quiet time before a conversation is read
const STALE_CLAIM_MS = 15 * 60_000;
const CONTEXT_DAYS = 5;
const MAX_CONTEXT = 30;
const MAX_PHOTOS = 180; // six contact sheets
const MAX_CLIENT_IMAGES = 6;
const NOTE_MAX = 2000;

type InboundRow = typeof schema.inboundMessages.$inferSelect;
type ClientRow = typeof schema.clients.$inferSelect;
type JobRow = typeof schema.jobs.$inferSelect;

// subject and quoted: an email's subject line and the earlier message it quoted (context for the model, never the client's words).
export type IntakeMsg = { id: string | null; at: Date; from: string | null; outgoing: boolean; text: string; media: InboundMedia[]; isNew: boolean; subject?: string; quoted?: string };
export type IntakeBatch = { source: "quo" | "email"; sender: string | null; messages: IntakeMsg[] };

export type Candidate = { id: string; address: string; shootDate: string | null; deliveredAt: string | null; photos: number; sections: string[] };
export type FiledItem = { mediaId: string; filename: string; note: string };
export type Decision =
  | { kind: "ignored"; reason: string; classify?: Classified }
  | { kind: "needs_review"; reason: string; summary: string; clientId: string | null; classify?: Classified }
  | {
      kind: "file";
      client: { id: string; email: string; name: string | null };
      listing: { id: string; address: string; nda: boolean };
      generalNote: string;
      items: FiledItem[];
      needsReview: boolean;
      reviewNote: string | null;
      sourceText: string;
      classify: Classified;
      // Oct 26 2026: PHOTO or VIDEO. A video request files the summary as its
      // note (no photo placement) and joins the listing's Video card.
      mediaKind?: "photo" | "video";
    };

// ---- model ---------------------------------------------------------------

export function hasIntakeModel(): boolean {
  return Boolean((process.env.ANTHROPIC_API_KEY || "").trim());
}

export function intakeModel(): string {
  const m = (process.env.STUDIO_INTAKE_MODEL || "").trim();
  if (!m || /^sonnet$/i.test(m)) return "claude-sonnet-5-5";
  if (/^haiku$/i.test(m)) return "claude-haiku-5-5";
  return m;
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const ws = (process.env.ANTHROPIC_WORKSPACE_ID || "").trim();
    _client = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY || "").trim(), maxRetries: 1, timeout: 120_000, ...(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {}) });
  }
  return _client;
}

type Block = Anthropic.Messages.ContentBlockParam;

async function askJson<T>(system: string, content: Block[], schemaDef: Record<string, unknown>, maxTokens = 2048): Promise<T> {
  const r = await client().messages.create({
    model: intakeModel(),
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: { type: "json_schema", schema: schemaDef } },
    messages: [{ role: "user", content }],
  });
  const text = r.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error("The intake model did not return JSON");
  }
}

// No em dashes, tidy spaces, and no stray JSON punctuation a model leaves at the end of a string.
const scrub = (s: string) => s.replace(/—|–|--/g, ", ").replace(/\s+,/g, ",").replace(/[ \t]+/g, " ").trim().replace(/[\s"'\]}[{,]+$/, "").trim();

const CLASSIFY_SYSTEM = `You read text messages and emails that clients (real estate agents and their teams) send to ${brand.name}, a real estate photo and video studio. Your only job is to spot revision requests.

A revision request asks the studio to change, fix, re-edit, redo, swap, add or remove something in photos, videos or other media the studio delivered for a listing, including retaking specific shots on a return visit. Examples: "can you brighten the kitchen", "the twilight interiors look too fake, darker and more orange", "remove the car in the driveway shot", "can we get a vertical of photo 12", "retake the living room with the doors open when you go back", a photo sent with a note about what to change.

Not a revision: scheduling, times, rescheduling, access and gate codes, booking a new shoot, prices, invoices, payment, asking when media will arrive, thanks or praise, general chat, and anything the studio's own team writes.

Decide on the messages marked NEW. Earlier messages are context only: a request that appears only in earlier messages is not new. If the NEW messages contain any revision request, is_revision is true even when they also contain other things. An email's subject line and the earlier message it quotes are context too (they often name the listing): decide on what the client wrote.

When it is a revision, pick the listing from the candidates: the one the thread names (address, street, or details), else the most recently delivered one when the thread is clearly about recent work. listing_sure is true only when it is clear. No candidates or no fit: listing_id is null.

media: "video" when the request is about a film, video, reel or its music, pace, cuts or timing; otherwise "photo".

reason: one short plain sentence. summary: the revision request in one or two plain sentences, no em dashes. For a video request keep any times the client gave ("at 0:42") in the summary.`;

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    is_revision: { type: "boolean" },
    listing_id: { type: ["string", "null"] },
    listing_sure: { type: "boolean" },
    reason: { type: "string" },
    summary: { type: "string" },
    media: { type: "string", enum: ["photo", "video"] },
  },
  required: ["is_revision", "listing_id", "listing_sure", "reason", "summary", "media"],
  additionalProperties: false,
} as const;

export type Classified = { is_revision: boolean; listing_id: string | null; listing_sure: boolean; reason: string; summary: string; media?: "photo" | "video" };

const PLACE_SYSTEM = `You file a client's revision request for ${brand.name}'s editing team. You get the client's messages, any photos the client attached, the list of the gallery's photo numbers with their file names (names often say "twilight", "exterior", "interior", "drone"), and numbered contact sheets of every photo in the gallery (each photo's number is in the black box at its top left).

Write one item per distinct request and list the gallery photo numbers it applies to:
- a photo the client attached: find the same photo on the contact sheets (same scene and angle) and use its number;
- "all the twilights", "the kitchen shots", "the bedrooms": every photo that matches;
- a request about the whole gallery with no particular photos ("make everything a little warmer"): photos is an empty list.

note: a short, clear instruction an editor can act on, in plain English, faithful to what the client asked and keeping their specifics. Do not add anything the client did not ask for. When the request is to retake shots on site, start the note with "Reshoot:". No em dashes or double hyphens.

sure is false when you could not confidently find a photo the client pointed to, or the request is ambiguous; then say why in unsure_reason (one short sentence for the team, naming photos by what they show or by file name, never by sheet number). Otherwise unsure_reason is an empty string.`;

const PLACE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { photos: { type: "array", items: { type: "integer" } }, note: { type: "string" } },
        required: ["photos", "note"],
        additionalProperties: false,
      },
    },
    sure: { type: "boolean" },
    unsure_reason: { type: "string" },
  },
  required: ["items", "sure", "unsure_reason"],
  additionalProperties: false,
} as const;

type Placed = { items: { photos: number[]; note: string }[]; sure: boolean; unsure_reason: string };

// ---- who and which listing -----------------------------------------------

const last10 = (p: string | null | undefined) => (p || "").replace(/\D/g, "").slice(-10);

export async function matchClient(sender: string | null): Promise<{ client: ClientRow; via: "phone" | "email" | "quo-contact" } | null> {
  if (!sender) return null;
  const d = db();
  if (sender.includes("@")) {
    const c = await d.query.clients.findFirst({ where: eq(schema.clients.email, sender.toLowerCase()) });
    return c ? { client: c, via: "email" } : null;
  }
  const want = last10(sender);
  if (want.length !== 10) return null;
  const withPhone = await d.query.clients.findMany({ where: sql`${schema.clients.phone} is not null` });
  const byPhone = withPhone.find((c) => last10(c.phone) === want);
  if (byPhone) return { client: byPhone, via: "phone" };
  if (!hasQuoApiKey()) return null;
  const emails = await quoContactEmails(sender).catch(() => [] as string[]);
  if (!emails.length) return null;
  const c = await d.query.clients.findFirst({ where: inArray(schema.clients.email, emails) });
  return c ? { client: c, via: "quo-contact" } : null;
}

async function teamIds(c: ClientRow): Promise<string[]> {
  if (!c.team) return [c.id];
  const rows = await db().query.clients.findMany({ where: eq(schema.clients.team, c.team), columns: { id: true } });
  return [...new Set([c.id, ...rows.map((r) => r.id)])];
}

type ListingWithMedia = Awaited<ReturnType<typeof loadListings>>[number];
async function loadListings(clientIds: string[]) {
  return db().query.listings.findMany({
    where: inArray(schema.listings.clientId, clientIds),
    with: {
      media: { where: eq(schema.media.kind, "photo"), columns: { id: true, r2Key: true, filename: true, section: true, sort: true, qcState: true, published: true, shootId: true, createdAt: true } },
      shoots: { columns: { id: true, publishedAt: true } },
    },
    orderBy: [desc(schema.listings.createdAt)],
    limit: 60,
  });
}

function visiblePhotos(l: ListingWithMedia) {
  return clientVisibleMedia(l.media, l.shoots).sort((a, b) => (a.section ?? "").localeCompare(b.section ?? "") || a.sort - b.sort || a.filename.localeCompare(b.filename));
}

export async function candidateListings(c: ClientRow): Promise<{ candidates: Candidate[]; byId: Map<string, ListingWithMedia> }> {
  const listings = await loadListings(await teamIds(c));
  const rows = listings
    .map((l) => {
      const photos = visiblePhotos(l);
      const delivered = photos.reduce<Date | null>((m, p) => (!m || p.createdAt > m ? p.createdAt : m), null);
      return { l, photos, delivered };
    })
    .filter((x) => x.photos.length > 0)
    .sort((a, b) => (b.delivered?.getTime() ?? 0) - (a.delivered?.getTime() ?? 0))
    .slice(0, 10);
  return {
    candidates: rows.map(({ l, photos, delivered }) => ({
      id: l.id,
      address: l.address,
      shootDate: l.shootDate ? l.shootDate.toISOString().slice(0, 10) : null,
      deliveredAt: delivered ? delivered.toISOString().slice(0, 10) : null,
      photos: photos.length,
      sections: [...new Set(photos.map((p) => p.section).filter((s): s is string => Boolean(s)))],
    })),
    byId: new Map(rows.map(({ l }) => [l.id, l])),
  };
}

// ---- the thread ----------------------------------------------------------

const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

function transcript(batch: IntakeBatch, names: Map<string, string>): string {
  const sender = (from: string) => (from.includes("@") ? (names.get(from) ? `${names.get(from)}, ${from}` : from) : (names.get(last10(from)) ?? `number ending ${last10(from).slice(-4)}`));
  const who = (m: IntakeMsg) => (m.outgoing ? `${brand.shortName}` : `CLIENT${m.from ? ` (${sender(m.from)})` : ""}`);
  const line = (m: IntakeMsg) =>
    `[${fmt(m.at)}] ${who(m)}: ${m.subject ? `(email, subject "${m.subject}") ` : ""}${m.text.trim() || "(no text)"}${m.media.length ? ` [${m.media.length} photo${m.media.length === 1 ? "" : "s"} attached]` : ""}${m.quoted ? `\n    (below it, their email quoted an earlier message: ${m.quoted.replace(/\s+/g, " ").slice(0, 1500)})` : ""}`;
  const earlier = batch.messages.filter((m) => !m.isNew);
  const fresh = batch.messages.filter((m) => m.isNew);
  return [`Earlier in the thread (context only):`, ...(earlier.length ? earlier.map(line) : ["(nothing)"]), ``, `NEW messages (decide on these):`, ...fresh.map(line)].join("\n");
}

function sourceText(batch: IntakeBatch): string {
  return batch.messages
    .filter((m) => m.isNew && !m.outgoing)
    .map((m) => `${m.text.trim()}${m.media.length ? ` [${m.media.length} photo${m.media.length === 1 ? "" : "s"}]` : ""}`)
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

const fromQuo = (m: QuoMessage, newIds: Set<string>): IntakeMsg => ({
  id: m.id,
  at: new Date(m.createdAt ?? Date.now()),
  from: m.from ?? null,
  outgoing: m.direction === "outgoing",
  text: typeof m.text === "string" ? m.text : typeof m.body === "string" ? m.body : "",
  media: (m.media ?? []).filter((x) => x.url).map((x) => ({ url: x.url!, type: x.type ?? null })),
  isNew: newIds.has(m.id),
});

const fromRow = (r: InboundRow, isNew: boolean): IntakeMsg => {
  const raw = (r.raw ?? {}) as { subject?: unknown; quoted?: unknown };
  return {
    id: r.externalId,
    at: r.sentAt ?? r.receivedAt,
    from: r.fromAddr,
    outgoing: false,
    text: r.body ?? "",
    media: r.media ?? [],
    isNew,
    ...(r.source === "email" ? { subject: typeof raw.subject === "string" ? raw.subject : undefined, quoted: typeof raw.quoted === "string" ? raw.quoted : undefined } : {}),
  };
};

// The claimed texts plus the last CONTEXT_DAYS of the conversation: what we
// stored (every incoming text) merged with the thread from Quo (our replies
// too; every number of a group thread) when the API key is there.
export async function batchFromRows(claimed: InboundRow[]): Promise<IntakeBatch> {
  const first = claimed[0];
  const since = new Date(Math.min(...claimed.map((r) => (r.sentAt ?? r.receivedAt).getTime())) - CONTEXT_DAYS * 86_400_000);
  const newIds = new Set(claimed.map((r) => r.externalId));
  const same = first.conversationId ? eq(schema.inboundMessages.conversationId, first.conversationId) : eq(schema.inboundMessages.fromAddr, first.fromAddr ?? "");
  const stored = await db().query.inboundMessages.findMany({ where: and(eq(schema.inboundMessages.source, first.source), same, gte(schema.inboundMessages.receivedAt, since)), orderBy: [asc(schema.inboundMessages.receivedAt)] });
  const msgs = new Map<string, IntakeMsg>();
  for (const r of stored) msgs.set(r.externalId, fromRow(r, newIds.has(r.externalId)));
  for (const r of claimed) msgs.set(r.externalId, fromRow(r, true));
  if (first.source === "quo" && first.fromAddr && hasQuoApiKey()) {
    const people = (first.conversationId ? await quoConversationParticipants(first.conversationId, since).catch(() => null) : null) ?? [first.fromAddr];
    const thread = await quoThread(people, since).catch(() => [] as QuoMessage[]);
    for (const m of thread) if (!msgs.has(m.id)) msgs.set(m.id, fromQuo(m, newIds));
  }
  if (first.source === "email" && first.conversationId) {
    // The Gmail thread: our replies from hello@ and the client's earlier mail.
    const { gmailThread } = await import("./email-intake");
    const thread = await gmailThread(first.conversationId, newIds).catch((e) => (console.error("[intake] gmail thread", e instanceof Error ? e.message : e), [] as IntakeMsg[]));
    for (const m of thread) if (m.id && !msgs.has(m.id) && m.at >= since) msgs.set(m.id, m);
  }
  const all = [...msgs.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
  const fresh = all.filter((m) => m.isNew);
  const earlier = all.filter((m) => !m.isNew && m.at <= fresh[fresh.length - 1].at).slice(-MAX_CONTEXT);
  return { source: first.source, sender: first.fromAddr, messages: [...earlier, ...fresh] };
}

// A dry run straight from Quo: the client texts in [since, until) of a thread
// (one number, or a group conversation's numbers) are NEW, the CONTEXT_DAYS
// before them are context. Nothing is stored or filed.
export async function batchFromQuo(participants: string[], since: Date, until?: Date): Promise<IntakeBatch> {
  const thread = await quoThread(participants, new Date(since.getTime() - CONTEXT_DAYS * 86_400_000), until);
  const fresh = thread.filter((m) => m.direction !== "outgoing" && new Date(m.createdAt ?? 0) >= since);
  const newIds = new Set(fresh.map((m) => m.id));
  return { source: "quo", sender: fresh[0]?.from ?? participants[0] ?? null, messages: thread.map((m) => fromQuo(m, newIds)).slice(-(MAX_CONTEXT + newIds.size)) };
}

// ---- deciding ------------------------------------------------------------

export async function decide(batch: IntakeBatch): Promise<Decision> {
  if (!hasIntakeModel()) throw new NotConfiguredError("ANTHROPIC_API_KEY (revision intake)");
  const fresh = batch.messages.filter((m) => m.isNew && !m.outgoing);
  if (!fresh.length) return { kind: "ignored", reason: "no new client messages" };
  if (fresh.every((m) => !m.text.trim() && !m.media.length && !m.subject)) return { kind: "ignored", reason: "empty messages" };

  const match = await matchClient(batch.sender);
  const { candidates, byId } = match ? await candidateListings(match.client) : { candidates: [], byId: new Map<string, ListingWithMedia>() };
  const names = new Map<string, string>();
  if (match?.client.phone && match.client.name) names.set(last10(match.client.phone), match.client.name);
  if (match?.client.name) names.set(match.client.email.toLowerCase(), match.client.name);

  const header = [
    match ? `Client: ${match.client.name ?? match.client.email} (${match.client.email})${match.client.team ? `, team ${match.client.team}` : ""}` : "Client: not matched to a client record",
    `Candidate listings, most recently delivered first:`,
    ...(candidates.length ? candidates.map((c) => `- id ${c.id}: ${c.address}; shoot ${c.shootDate ?? "unknown"}; delivered ${c.deliveredAt ?? "unknown"}; ${c.photos} photos${c.sections.length ? `; sections ${c.sections.join(", ")}` : ""}`) : ["(none)"]),
  ].join("\n");
  const cls = await askJson<Classified>(CLASSIFY_SYSTEM, [{ type: "text", text: `${header}\n\n${transcript(batch, names)}` }], CLASSIFY_SCHEMA as unknown as Record<string, unknown>, 1024);

  if (!cls.is_revision) return { kind: "ignored", reason: scrub(cls.reason).slice(0, 300), classify: cls };
  const summary = scrub(cls.summary).slice(0, 600);
  if (!match) return { kind: "needs_review", reason: batch.source === "email" ? "A revision, but the sender's email is not on any client." : "A revision, but the number is not on any client.", summary, clientId: null, classify: cls };
  const listing = cls.listing_id ? byId.get(cls.listing_id) : undefined;
  if (!listing) return { kind: "needs_review", reason: candidates.length ? "A revision, but it is not clear which listing." : "A revision, but this client has no delivered listing.", summary, clientId: match.client.id, classify: cls };

  // A video revision: the summary is the note (times kept), no photo placement.
  if (cls.media === "video") {
    return {
      kind: "file",
      client: { id: match.client.id, email: match.client.email, name: match.client.name },
      listing: { id: listing.id, address: listing.address, nda: listing.nda },
      generalNote: summary,
      items: [],
      needsReview: !cls.listing_sure,
      reviewNote: !cls.listing_sure ? `Check the listing: the ${batch.source === "email" ? "email does" : "texts do"} not name it clearly.` : null,
      sourceText: sourceText(batch),
      classify: cls,
      mediaKind: "video",
    };
  }

  // Which photos.
  const photos = visiblePhotos(listing).slice(0, MAX_PHOTOS);
  const sheets = await contactSheets(photos);
  const index = photos.map((p, i) => `${i + 1}. ${p.filename}${p.section ? ` (section ${p.section})` : ""}`).join("\n");
  const content: Block[] = [{ type: "text", text: `Listing: ${listing.address}\n\n${transcript(batch, names)}\n\nThe gallery has ${photos.length} photos on ${sheets.length} contact sheet${sheets.length === 1 ? "" : "s"}. Numbers and file names:\n${index}` }];
  const clientImages = batch.messages.filter((m) => m.isNew && !m.outgoing).flatMap((m) => m.media).filter((x) => !x.type || x.type.startsWith("image/")).slice(0, MAX_CLIENT_IMAGES);
  let n = 0;
  for (const img of clientImages) {
    const bytes = img.url.startsWith("gmail:") ? await (await import("./email-intake")).gmailAttachment(img.url) : await quoMedia(img.url);
    const jpeg = bytes ? await modelImage(bytes) : null;
    if (!jpeg) continue;
    n++;
    content.push({ type: "text", text: `Photo the client attached (${n}):` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } });
  }
  sheets.forEach((s, i) => {
    content.push({ type: "text", text: `Contact sheet ${i + 1}: photos ${i * SHEET_SIZE + 1} to ${Math.min((i + 1) * SHEET_SIZE, photos.length)}` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: s.toString("base64") } });
  });
  const placed = await askJson<Placed>(PLACE_SYSTEM, content, PLACE_SCHEMA as unknown as Record<string, unknown>, 2048);

  const byMedia = new Map<string, FiledItem>();
  const general: string[] = [];
  for (const it of placed.items ?? []) {
    const note = scrub(it.note || "").slice(0, NOTE_MAX);
    if (!note) continue;
    const picks = [...new Set((it.photos ?? []).filter((k) => Number.isInteger(k) && k >= 1 && k <= photos.length))];
    if (!picks.length) {
      general.push(note);
      continue;
    }
    for (const k of picks) {
      const p = photos[k - 1];
      const prev = byMedia.get(p.id);
      byMedia.set(p.id, { mediaId: p.id, filename: p.filename, note: prev ? `${prev.note}\n${note}`.slice(0, NOTE_MAX) : note });
    }
  }
  const items = [...byMedia.values()];
  if (!items.length && !general.length) general.push(summary);
  const doubts = [!cls.listing_sure ? `Check the listing: the ${batch.source === "email" ? "email does" : "texts do"} not name it clearly.` : null, !placed.sure ? scrub(placed.unsure_reason || "Check which photos this is about.") : null, clientImages.length > n ? "A photo the client sent could not be read." : null].filter((x): x is string => Boolean(x));
  return {
    kind: "file",
    client: { id: match.client.id, email: match.client.email, name: match.client.name },
    listing: { id: listing.id, address: listing.address, nda: listing.nda },
    generalNote: general.join("\n\n").slice(0, NOTE_MAX * 2),
    items,
    needsReview: doubts.length > 0,
    reviewNote: doubts.length ? doubts.join(" ").slice(0, 500) : null,
    sourceText: sourceText(batch),
    classify: cls,
  };
}

// ---- filing --------------------------------------------------------------

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function fileRequest(dcn: Extract<Decision, { kind: "file" }>, source: "quo" | "email"): Promise<string> {
  const d = db();
  const now = new Date();
  const [req] = await d
    .insert(schema.revisionRequests)
    .values({
      listingId: dcn.listing.id,
      clientEmail: dcn.client.email.toLowerCase(),
      notes: dcn.generalNote,
      filenames: dcn.items.map((i) => i.filename).join(", ") || null,
      status: "new",
      submittedAt: new Date(now.getTime() + 1000), // after every item, so all of them read as sent
      source,
      sourceText: dcn.sourceText,
      needsReview: dcn.needsReview,
      reviewNote: dcn.reviewNote,
      mediaKind: dcn.mediaKind ?? "photo",
    })
    .returning({ id: schema.revisionRequests.id });
  if (dcn.items.length) {
    await d.insert(schema.revisionItems).values(dcn.items.map((i) => ({ requestId: req.id, listingId: dcn.listing.id, mediaId: i.mediaId, filename: i.filename, note: i.note, clientEmail: dcn.client.email.toLowerCase(), createdAt: now, updatedAt: now })));
  }

  // Tell the team the way a portal request does (src/app/api/portal/revision/route.ts).
  const how = source === "quo" ? "by text" : "by email";
  const summary = [dcn.generalNote, ...dcn.items.map((i) => `${i.filename}: ${i.note}`)].filter(Boolean).join(" · ");
  const video = dcn.mediaKind === "video";
  let videoCardId: string | null = null;
  if (video) videoCardId = await linkVideoRevision({ listingId: dcn.listing.id, requestId: req.id, by: `intake (${how})` }).catch((e) => (console.error("intake video card:", e), null));
  await hubRevisionRequested({ listingId: dcn.listing.id, listing: { address: dcn.listing.address, nda: dcn.listing.nda }, clientEmail: `${dcn.client.email} (${how}${dcn.needsReview ? ", needs a look" : ""})`, notes: summary, fileCount: dcn.items.length, kind: video ? "video" : "photo", videoCardId }).catch((e) => console.error("intake slack:", e));
  const to = notifyEmails();
  if (to.length && process.env.RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const rows = dcn.items.map((i) => `<tr><td style="padding:8px 12px 8px 0;vertical-align:top;font-family:monospace;font-size:12px;white-space:nowrap;">${esc(i.filename)}</td><td style="padding:8px 0;vertical-align:top;">${esc(i.note)}</td></tr>`).join("");
      await new Resend(process.env.RESEND_API_KEY).emails.send({
        from: emailFrom(),
        to,
        subject: `${video ? "Video revision" : "Revision"} requested ${how}: ${dcn.listing.address.split(",")[0]} (${dcn.client.email})`,
        html: `
          <p><strong>${esc(dcn.client.name ?? dcn.client.email)}</strong> asked for revisions ${how} on <strong>${esc(dcn.listing.address)}</strong>. It is in the revision queue.</p>
          ${dcn.needsReview ? `<p><strong>Needs a look:</strong> ${esc(dcn.reviewNote ?? "")}</p>` : ""}
          <p style="white-space:pre-wrap;border-left:3px solid #ccc;padding-left:12px;">${esc(dcn.sourceText)}</p>
          ${dcn.generalNote ? `<p style="white-space:pre-wrap;">${esc(dcn.generalNote)}</p>` : ""}
          ${rows ? `<table style="border-collapse:collapse;font-size:14px;">${rows}</table>` : ""}
          <p><a href="${siteUrl()}${video && videoCardId ? `/admin/video/${videoCardId}` : "/admin/revisions"}">Open in admin →</a></p>`,
      });
    } catch (e) {
      console.error("intake notify:", e);
    }
  }
  return req.id;
}

// What the decision did to the claimed texts.
async function settle(claimed: InboundRow[], dcn: Decision): Promise<void> {
  const ids = claimed.map((r) => r.id);
  const now = new Date();
  const d = db();
  if (dcn.kind === "ignored") {
    await d.update(schema.inboundMessages).set({ status: "ignored", processedAt: now, result: { reason: dcn.reason } }).where(inArray(schema.inboundMessages.id, ids));
    return;
  }
  if (dcn.kind === "needs_review") {
    await d.update(schema.inboundMessages).set({ status: "needs_review", processedAt: now, clientId: dcn.clientId, result: { reason: dcn.reason, summary: dcn.summary } }).where(inArray(schema.inboundMessages.id, ids));
    return;
  }
  const requestId = await fileRequest(dcn, claimed[0].source);
  await d.update(schema.inboundMessages).set({ status: "filed", processedAt: now, clientId: dcn.client.id, listingId: dcn.listing.id, result: { requestId, items: dcn.items.length, needsReview: dcn.needsReview } }).where(inArray(schema.inboundMessages.id, ids));
}

// ---- the job -------------------------------------------------------------

export async function runRevisionIntake(job: JobRow): Promise<void> {
  const id = job.payload?.inboundId;
  if (!id) throw new SkipJobError("inbound.revision has no inboundId");
  const d = db();
  const row = await d.query.inboundMessages.findFirst({ where: eq(schema.inboundMessages.id, id) });
  if (!row) throw new SkipJobError("the stored text is gone");
  if (row.status !== "new" && row.status !== "processing") throw new SkipJobError(`already ${row.status}`);

  const env = row.env ?? currentEnv();
  const same = row.conversationId ? eq(schema.inboundMessages.conversationId, row.conversationId) : and(isNull(schema.inboundMessages.conversationId), eq(schema.inboundMessages.fromAddr, row.fromAddr ?? ""));
  const open = or(eq(schema.inboundMessages.status, "new"), and(eq(schema.inboundMessages.status, "processing"), lt(schema.inboundMessages.processedAt, new Date(Date.now() - STALE_CLAIM_MS))));
  const pending = await d.query.inboundMessages.findMany({ where: and(eq(schema.inboundMessages.source, row.source), eq(schema.inboundMessages.env, env), same, open), orderBy: [asc(schema.inboundMessages.receivedAt)] });
  if (!pending.length) throw new SkipJobError("nothing left to read in this conversation");
  const newest = Math.max(...pending.map((r) => r.receivedAt.getTime()));
  const quiet = Date.now() - newest;
  if (quiet < BURST_MS) throw new DeferError("waiting for the client to finish texting", BURST_MS - quiet + 5_000);

  // Claim them all at once so a second run never files the same texts.
  const claimed = await d
    .update(schema.inboundMessages)
    .set({ status: "processing", processedAt: new Date() })
    .where(and(inArray(schema.inboundMessages.id, pending.map((r) => r.id)), open))
    .returning();
  if (!claimed.length) throw new SkipJobError("another run took these texts");
  claimed.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  try {
    const batch = await batchFromRows(claimed);
    const dcn = await decide(batch);
    await settle(claimed, dcn);
  } catch (e) {
    await d.update(schema.inboundMessages).set({ status: "new", processedAt: null, error: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500) }).where(inArray(schema.inboundMessages.id, claimed.map((r) => r.id)));
    throw e;
  }
}

// What a dry run reports (admin-api revisionIntakeDryRun): the decision
// without the bytes, and nothing written anywhere.
export function describe(dcn: Decision) {
  if (dcn.kind !== "file") return dcn;
  return { ...dcn, items: dcn.items.map((i) => ({ filename: i.filename, note: i.note })) };
}
