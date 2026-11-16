// Who the hub tags for QC (Oct 26 2026). the owner: Slack roles "photo qc" and
// "video qc", tagged the moment a photo or video edit request comes in, so
// they hear at once.
//
// In Slack these are user groups (@photo-qc, @video-qc: Pro plan and up). An
// incoming webhook can only ping a group by its id (<!subteam^S0123ABC>), or
// a person by theirs (<@U0123ABC>), so /admin/settings keeps, per kind, the
// group id or a list of member ids (the free plan has no groups). Stored in
// the settings table under QC_TAGS_KEY; ids are not secrets.
//
// Tagged:
//   photo  a photo revision request (portal or text) and a gallery ready for review
//   video  a video revision request (the film review or a text) and a cut ready for review
//   final  corrected photos sent for final review (Oct 28 2026, src/lib/final-review.ts):
//          the owner: the editors upload the corrected JPGs, press Send for final
//          review, and that "notifies me, the coordinator, the coordinator, and a manager". Until
//          Settings says otherwise it tags those four, the same member ids the
//          health check tags (the owner, a manager, the coordinator, the coordinator).
import { eq } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";

export const QC_TAGS_KEY = "slack.qc_tags";
export type QcKind = "photo" | "video" | "final";
export type QcTags = Record<QcKind, string>;
// Nobody by default: the buyer pastes their final review team on /admin/settings.
export const FINAL_REVIEW_DEFAULT = "";
export const EMPTY_QC_TAGS: QcTags = { photo: "", video: "", final: FINAL_REVIEW_DEFAULT };

// Every id in what was pasted, in order, once: a bare id (S…, U…, W…), a
// Slack mention as copied (<!subteam^S…|@photo-qc>, <@U…>) or a profile or
// group link that ends in one. Anything else is ignored.
export function qcIds(raw: string): string[] {
  const out: string[] = [];
  // Slack ids always carry a digit, which keeps words like "SUBTEAM" out.
  for (const m of (raw || "").toUpperCase().matchAll(/(?:^|[^A-Z0-9])([SUW](?=[A-Z0-9]*\d)[A-Z0-9]{6,14})(?=$|[^A-Z0-9])/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// The mention text for a webhook post: groups as <!subteam^…>, people as <@…>.
export function qcMentionText(raw: string): string {
  return qcIds(raw)
    .map((id) => (id.startsWith("S") ? `<!subteam^${id}>` : `<@${id}>`))
    .join(" ");
}

let cache: { at: number; tags: QcTags } | null = null;

export async function qcTags(): Promise<QcTags> {
  if (!hasDb()) return EMPTY_QC_TAGS;
  if (cache && Date.now() - cache.at < 60_000) return cache.tags;
  let tags = EMPTY_QC_TAGS;
  try {
    const row = await db().query.settings.findFirst({ where: eq(schema.settings.key, QC_TAGS_KEY) });
    const v = (row?.value ?? {}) as Partial<QcTags>;
    // An empty final list falls back to the four: a final review always pings someone.
    tags = { photo: typeof v.photo === "string" ? v.photo : "", video: typeof v.video === "string" ? v.video : "", final: typeof v.final === "string" && qcIds(v.final).length ? v.final : FINAL_REVIEW_DEFAULT };
  } catch (e) {
    console.error("[slack-qc] read", e);
  }
  cache = { at: Date.now(), tags };
  return tags;
}

export async function saveQcTags(tags: QcTags): Promise<void> {
  const value = { photo: qcIds(tags.photo).join(" "), video: qcIds(tags.video).join(" "), final: qcIds(tags.final).join(" ") };
  await db()
    .insert(schema.settings)
    .values({ key: QC_TAGS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  cache = null;
}

// "<!subteam^S…> " to put in front of a hub line, or "" when nobody is set.
export async function qcMention(kind: QcKind): Promise<string> {
  const text = qcMentionText((await qcTags())[kind]);
  return text ? `${text} ` : "";
}
