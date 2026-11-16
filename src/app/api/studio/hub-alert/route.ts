// POST /api/studio/hub-alert { text, dryRun? }  (x-migrate-token)
// The business health check's way to raise the alarm (Oct 22 2026): its message
// goes to #studio-hub through the studio's own webhook, so it arrives from
// the studio bot and its <@user> mentions notify everyone tagged
// (including the owner, who would get no notification from a post made as
// himself). Dollar amounts are scrubbed; the text is capped. dryRun returns
// the text without posting.
import { postToHub, scrubMoney } from "@/lib/slack";
import { hasMigrateToken } from "@/lib/operator-token";

export const dynamic = "force-dynamic";

const MAX = 3500;

export async function POST(request: Request) {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  const b = (await request.json().catch(() => ({}))) as { text?: unknown; dryRun?: unknown };
  const raw = typeof b.text === "string" ? b.text.trim() : "";
  if (!raw) return Response.json({ ok: false, error: "text is required" }, { status: 400 });
  const text = scrubMoney(raw).slice(0, MAX);
  if (b.dryRun === true) return Response.json({ ok: true, dryRun: true, text });
  const posted = await postToHub({ text });
  return Response.json({ ok: posted, posted }, { status: posted ? 200 : 502 });
}
