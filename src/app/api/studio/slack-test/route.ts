// Posts a one-line hello to the Slack hub so an admin can confirm the webhook
// works. Guarded by MIGRATE_TOKEN like the migrate route; never public.
import { postToHub } from "@/lib/slack";
import { hasMigrateToken } from "@/lib/operator-token";
import { brand } from "@/lib/brand";

export async function POST(request: Request) {
  if (!hasMigrateToken(request)) {
    return Response.json({ ok: false }, { status: 404 });
  }
  const configured = Boolean(process.env.SLACK_WEBHOOK_URL);
  const posted = configured
    ? await postToHub({
        text: `${brand.name} is connected to this channel. Revision requests, gallery approvals, uploads and finished edits will post here.`,
      })
    : false;
  return Response.json({ ok: true, configured, posted });
}
