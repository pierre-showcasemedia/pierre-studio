// Who may open /admin, and as what (Oct 2026: roles).
//
//   admin  everything. Every ADMIN_EMAILS address is an admin (never
//          removable or demotable from the UI, so nobody locks everyone out),
//          plus the admins rows whose role is "admin".
//   qa     the QA team: the work queue, shoots, listings, every frame
//          (internal ones too), downloads for editing, QC, corrected finals,
//          listing uploads, client visibility and Publish. No money, no
//          client or team admin, no settings, no view as, no deletes, no
//          delivery emails. src/lib/admin.ts has the gates; STUDIO.md has the
//          full list.
//   creative  a creative specialist (the shooter, Oct 21 2026): Upload a
//          shoot (the listing picker, the file upload, the editing options,
//          submit) and a read-only view of the shoots they uploaded. Nothing
//          else: no other page, action or route.
//   video  a video editor (the video editor's team, Oct 26 2026): the Video board, its
//          cards (only the video side of a booking), the Dropbox Video
//          folder link, and uploading a cut onto a card's listing as internal
//          only. Nothing else.
//
// "Team" = any of the four. "Staff" = admin or qa (the QA team's pages and
// actions; a creative specialist and a video editor are refused there).
// Every gate is an allow list, so a new role opens nothing by default. The database roster is
// cached for 20 seconds per instance; a change takes effect within that
// window.
import { db, hasDb } from "@/db";
import type { StaffRole } from "@/db/schema";
import { DEMO_STAFF } from "./demo-data";

export type { StaffRole };

export function envAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Exactly "admin", "creative" or "video"; anything else reads as "qa" (the
// value an unknown or hand-edited row has always read as, so nobody gains
// access by a typo).
export const toRole = (v: unknown): StaffRole => (v === "admin" ? "admin" : v === "creative" ? "creative" : v === "video" ? "video" : "qa");

let cache: { at: number; roles: Map<string, StaffRole> } | null = null;

export async function dbStaffRoles(): Promise<Map<string, StaffRole>> {
  // Demo mode (no database, local only): a sample QA login so the QA view can
  // be reviewed. Never consulted once DATABASE_URL is set.
  if (!hasDb()) return new Map(DEMO_STAFF.map((s) => [s.email, s.role]));
  if (cache && Date.now() - cache.at < 20_000) return cache.roles;
  let roles = new Map<string, StaffRole>();
  try {
    const rows = await db().query.admins.findMany({ columns: { email: true, role: true } });
    roles = new Map(rows.map((r) => [r.email.toLowerCase(), toRole(r.role)]));
  } catch {
    // Deployed before the migrate route added admins.role: every row is an
    // admin, exactly as before roles existed.
    try {
      const rows = await db().query.admins.findMany({ columns: { email: true } });
      roles = new Map(rows.map((r) => [r.email.toLowerCase(), "admin" as const]));
    } catch {
      // The table lands with the migrate route; until then only the env list counts.
    }
  }
  cache = { at: Date.now(), roles };
  return roles;
}

export function forgetAdminCache(): void {
  cache = null;
}

// The role of a signed-in email, or null when it is not staff at all.
export async function staffRole(email: string | null | undefined): Promise<StaffRole | null> {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  if (envAdminEmails().includes(e)) return "admin";
  return (await dbStaffRoles()).get(e) ?? null;
}

// Full admin only (the QA team is NOT an admin here). Every older call site
// keeps its meaning: view as, the operator test email, anything not opened
// to the QA team on purpose.
export async function isAdminAllowed(email: string | null | undefined): Promise<boolean> {
  return (await staffRole(email)) === "admin";
}

// Admin, QA or creative specialist: may sign in to /admin (the login and
// verify routes; what each role may open is decided by the gates).
export async function isStaffAllowed(email: string | null | undefined): Promise<boolean> {
  return (await staffRole(email)) !== null;
}

// The creative specialists on the roster (env admins are never listed here).
export async function creativeEmails(): Promise<string[]> {
  return [...(await dbStaffRoles()).entries()].filter(([, r]) => r === "creative").map(([e]) => e);
}

// Who a Video card may be assigned to: the video editors and the admins on
// the roster (env admins included), each once.
export async function videoAssignees(): Promise<string[]> {
  const db = [...(await dbStaffRoles()).entries()].filter(([, r]) => r === "video" || r === "admin").map(([e]) => e);
  return [...new Set([...db, ...envAdminEmails()])];
}
