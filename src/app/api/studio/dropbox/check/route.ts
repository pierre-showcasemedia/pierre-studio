// POST /api/studio/dropbox/check  (x-migrate-token)
// Operator check that the mirror can write: refreshes an access token from
// the stored connection, reads the account, lists the root folder (made if
// missing), creates one test folder under it and deletes it again. Returns
// statuses and counts only: no token, no listing names. When every step
// passes, the Dropbox jobs waiting for a connection (they sleep 30 minutes
// between looks) are woken to run on the next tick.
import { hasMigrateToken } from "@/lib/operator-token";
import { DropboxError, dropboxApi, dropboxConnection, dropboxMirrorEnabled, dropboxRoot, hasDropboxApp } from "@/lib/dropbox";
import { db, hasDb, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { currentEnv } from "@/lib/jobs-core";
import { MIRROR_KINDS } from "@/lib/dropbox-mirror";

export const dynamic = "force-dynamic";

const status = (e: unknown) => (e instanceof DropboxError ? { status: e.status, tag: e.tag } : { status: null, tag: e instanceof Error ? e.message.slice(0, 240) : String(e) });

export async function POST(request: Request) {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  if (!hasDb()) return Response.json({ ok: false, step: "db", error: "no database" }, { status: 503 });
  if (!hasDropboxApp()) return Response.json({ ok: false, step: "env", error: "NEXT_PUBLIC_DROPBOX_APP_KEY / DROPBOX_APP_SECRET not set here" });
  const conn = await dropboxConnection();
  if (!conn.connected) return Response.json({ ok: false, step: "connect", error: "Dropbox is not connected (Settings → Dropbox → Connect)", mirrorOnHere: dropboxMirrorEnabled() });
  const api = dropboxApi();
  const root = dropboxRoot();
  const out: Record<string, unknown> = { connected: true, account: { name: conn.name, email: conn.email }, root, mirrorOnHere: dropboxMirrorEnabled() };
  try {
    const me = await api.currentAccount();
    out.token = "ok";
    out.account = { name: me.name ?? conn.name, email: me.email ?? conn.email };
  } catch (e) {
    return Response.json({ ok: false, step: "token", ...out, ...status(e) });
  }
  try {
    out.rootFolder = await api.createFolder(root);
    const list = await api.listFolder(root, 500);
    out.list = { folders: list.entries.filter((e) => e.tag === "folder").length, files: list.entries.filter((e) => e.tag === "file").length, hasMore: list.hasMore };
  } catch (e) {
    return Response.json({ ok: false, step: "list", ...out, ...status(e) });
  }
  const probe = `${root}/.studio-check-${Date.now().toString(36)}`;
  try {
    out.create = await api.createFolder(probe);
  } catch (e) {
    return Response.json({ ok: false, step: "create", ...out, ...status(e) });
  }
  try {
    await api.deletePath(probe);
    out.delete = "ok";
  } catch (e) {
    return Response.json({ ok: false, step: "delete", ...out, ...status(e), note: `delete ${probe} by hand` });
  }
  const woken = await db()
    .update(schema.jobs)
    .set({ runAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.jobs.env, currentEnv()), eq(schema.jobs.status, "queued"), inArray(schema.jobs.kind, [...MIRROR_KINDS])))
    .returning({ id: schema.jobs.id });
  return Response.json({ ok: true, ...out, woken: woken.length });
}
