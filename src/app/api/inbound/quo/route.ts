// Quo → portal (Oct 21 2026). Texts to the business line arrive here as
// message.received deliveries (webhook made in Quo: that one event, the
// business line only). The raw body is verified (src/lib/quo.ts) and every
// accepted text is stored in inbound_messages BEFORE anything acts on it, and
// an inbound.revision job is queued for BURST_MS later (src/lib/revision-intake.ts
// waits for the client to finish texting, then files or ignores the burst).
//
// 503 until QUO_WEBHOOK_SECRET is set, 401 on a bad signature, 400 on a body
// that is not JSON. Everything else is 200: other event types, outgoing
// messages and repeats (unique on the Quo message id) are acknowledged so Quo
// does not retry them. Read only: nothing here ever texts back.
import { db, hasDb, schema } from "@/db";
import { currentEnv, enqueueJobs, jobKey } from "@/lib/jobs-core";
import { BURST_MS } from "@/lib/revision-intake";
import { verifyQuoSignature, type QuoVerify } from "@/lib/quo";
import type { InboundMedia } from "@/db/schema";

export const dynamic = "force-dynamic";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function sentAt(m: Record<string, unknown>): Date | null {
  const v = str(m.createdAt);
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

export async function POST(request: Request) {
  const secret = (process.env.QUO_WEBHOOK_SECRET || "").trim();
  if (!secret) return Response.json({ ok: false, error: "not configured" }, { status: 503 });
  const raw = await request.text();
  const v: QuoVerify = verifyQuoSignature(raw, request.headers, secret);
  if (!v.ok) {
    console.warn("quo webhook: rejected signature", { scheme: v.scheme });
    return Response.json({ ok: false }, { status: 401 });
  }

  let evt: Record<string, unknown> | null = null;
  try {
    evt = obj(JSON.parse(raw));
  } catch {}
  if (!evt) return Response.json({ ok: false, error: "bad body" }, { status: 400 });

  const type = str(evt.type);
  const m = obj(obj(evt.data)?.object);
  if (type !== "message.received" || !m || str(m.direction) === "outgoing") return Response.json({ ok: true, ignored: type ?? "unknown" });
  const externalId = str(m.id) ?? str(evt.id);
  if (!externalId) return Response.json({ ok: true, ignored: "no message id" });
  if (!hasDb()) return Response.json({ ok: false, error: "no database" }, { status: 503 });

  const media: InboundMedia[] = (Array.isArray(m.media) ? m.media : [])
    .map((x) => obj(x))
    .filter((x): x is Record<string, unknown> => Boolean(x && str(x.url)))
    .map((x) => ({ url: str(x.url)!, type: str(x.type) }));

  const stored = await db()
    .insert(schema.inboundMessages)
    .values({
      source: "quo",
      externalId,
      eventId: str(evt.id),
      conversationId: str(m.conversationId),
      fromAddr: str(m.from),
      toAddr: Array.isArray(m.to) ? str(m.to[0]) : str(m.to),
      body: typeof m.body === "string" ? m.body : typeof m.text === "string" ? m.text : null,
      media,
      sentAt: sentAt(m),
      env: currentEnv(),
      raw: evt,
    })
    .onConflictDoNothing({ target: [schema.inboundMessages.source, schema.inboundMessages.externalId] })
    .returning({ id: schema.inboundMessages.id });

  if (stored.length) {
    await enqueueJobs([{ kind: "inbound.revision", idempotencyKey: jobKey("inbound.revision", stored[0].id), payload: { version: 1, inboundId: stored[0].id }, runAt: new Date(Date.now() + BURST_MS) }]);
  }
  return Response.json({ ok: true, stored: stored.length > 0 });
}
