// The admin gates. Admins sign in through the same magic-link flow as clients.
// Gates check the REAL signed-in email, so /admin keeps working (and view-as
// can be exited) even while an admin is impersonating a client in the portal.
//
// Four roles since Oct 2026 (src/lib/admin-allow.ts), five levels of gate:
//   requireAdmin / assertAdmin / requireAdminApi          full admins only
//   requireStaff / assertStaff / requireStaffApi          admins and the QA team
//   requireUploader / assertUploader / requireUploaderApi admins and creative
//                                                          specialists (the
//                                                          upload flow)
//   requireVideo / assertVideo / requireVideoApi          admins and video
//                                                          editors (the Video
//                                                          board, Oct 26 2026)
//   requireScorecard / assertScorecard                     admins and the one
//                                                          person a scorecard
//                                                          is for (Nov 10 2026)
//   requireTeam                                            anyone who may open
//                                                          /admin at all (the
//                                                          layout, the dashboard
//                                                          and the shoot page,
//                                                          which branch on the
//                                                          role themselves)
// Every page, server action and route handler calls one of them itself; the
// layout and the nav only decide what is shown. Someone who reaches a page
// their role may not use lands on their own home with a note (the QA team on
// the dashboard, a creative specialist on Upload a shoot, a video editor on
// the Video board), an action redirects the same way, a route answers 403.
// Every gate names the roles it lets in, never the ones it keeps out.
import { redirect } from "next/navigation";
import { realSessionEmail as sessionEmail } from "./portal-auth";
import { envAdminEmails, isAdminAllowed, isStaffAllowed, staffRole, type StaffRole } from "./admin-allow";
import { hasMigrateToken } from "./operator-token";

export type Staff = { email: string; role: StaffRole };

// The env list only (sync). Admins can also be added on /admin/settings:
// every gate below goes through staffRole, which checks both.
export function adminEmails(): string[] {
  return envAdminEmails();
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().includes(email.trim().toLowerCase());
}

export { isAdminAllowed, isStaffAllowed };

// Where the Photo QC team lands when they reach something only an admin may
// use: the Photo QC board (Oct 26 2026; was the dashboard).
export const QA_DENIED_PATH = "/admin/photo-qc?denied=1";
// Where a creative specialist lands when they reach anything but the upload flow.
export const CREATIVE_DENIED_PATH = "/admin/upload?denied=1";
// Where a video editor lands when they reach anything but the Video board.
export const VIDEO_DENIED_PATH = "/admin/video?denied=1";
export const deniedPath = (role: StaffRole): string => (role === "creative" ? CREATIVE_DENIED_PATH : role === "video" ? VIDEO_DENIED_PATH : QA_DENIED_PATH);

const STAFF: readonly StaffRole[] = ["admin", "qa"];
const UPLOADERS: readonly StaffRole[] = ["admin", "creative"];
const VIDEO_TEAM: readonly StaffRole[] = ["admin", "video"];
export const isStaffRole = (r: StaffRole): boolean => STAFF.includes(r);
export const isVideoRole = (r: StaffRole): boolean => VIDEO_TEAM.includes(r);

// The signed-in team member, or null (not signed in, or not on the team).
export async function currentStaff(): Promise<Staff | null> {
  const email = await sessionEmail();
  const role = await staffRole(email);
  return email && role ? { email, role } : null;
}

export async function isAdmin(): Promise<boolean> {
  return (await currentStaff())?.role === "admin";
}

// ---- Full admins ----------------------------------------------------------

// For pages (and the server actions that use it as their actor): bounce
// strangers to the portal login and everyone else to their own home.
export async function requireAdmin(): Promise<string> {
  const s = await currentStaff();
  if (!s) redirect("/portal/login");
  if (s.role !== "admin") redirect(deniedPath(s.role));
  return s.email;
}

// For server actions that answer instead of redirecting: hard error.
export async function assertAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new Error("admin only");
}

// For route handlers: the admin's email, or a 401 / 403 Response to return as-is.
export async function requireAdminApi(): Promise<string | Response> {
  const s = await currentStaff();
  if (!s) return Response.json({ ok: false, error: "admin only" }, { status: 401 });
  if (s.role !== "admin") return Response.json({ ok: false, error: "admin only" }, { status: 403 });
  return s.email;
}

// ---- The scorecard (Nov 10 2026) -------------------------------------------------
// /admin/scorecard and its actions: full admins, plus the person the
// scorecard is for (the coordinator), whatever his role. Nobody else, since it shows
// his pay milestones.

export const canSeeScorecard = (s: Staff | null, person: string): boolean => Boolean(s && (s.role === "admin" || s.email.toLowerCase() === person.toLowerCase()));

export async function requireScorecard(person: string): Promise<Staff> {
  const s = await currentStaff();
  if (!s) redirect("/portal/login");
  if (!canSeeScorecard(s, person)) redirect(deniedPath(s.role));
  return s;
}

export async function assertScorecard(person: string): Promise<Staff> {
  const s = await currentStaff();
  if (!s || !canSeeScorecard(s, person)) throw new Error("admin only");
  return s;
}

// ---- Admins and the QA team -------------------------------------------------
// A creative specialist or a video editor is not staff here: the shoot and
// listing pages, the media work and the studio routes behind them stay
// closed to them.

export async function requireStaff(): Promise<Staff> {
  const s = await currentStaff();
  if (!s) redirect("/portal/login");
  if (!STAFF.includes(s.role)) redirect(deniedPath(s.role));
  return s;
}

export async function assertStaff(): Promise<Staff> {
  const s = await currentStaff();
  if (!s || !STAFF.includes(s.role)) throw new Error("admin only");
  return s;
}

export async function requireStaffApi(): Promise<Staff | Response> {
  const s = await currentStaff();
  if (!s) return Response.json({ ok: false, error: "admin only" }, { status: 401 });
  if (!STAFF.includes(s.role)) return Response.json({ ok: false, error: "admin only" }, { status: 403 });
  return s;
}

// ---- Admins and creative specialists: the upload flow -----------------------
// /admin/upload, the listing picker, the upload routes (upload-urls,
// upload-status, import-dropbox, models) and submit. The QA team has no
// Upload a shoot (it never did) and lands on its dashboard.

export async function requireUploader(): Promise<Staff> {
  const s = await currentStaff();
  if (!s) redirect("/portal/login");
  if (!UPLOADERS.includes(s.role)) redirect(deniedPath(s.role));
  return s;
}

export async function assertUploader(): Promise<Staff> {
  const s = await currentStaff();
  if (!s || !UPLOADERS.includes(s.role)) throw new Error("admin only");
  return s;
}

export async function requireUploaderApi(): Promise<string | Response> {
  const s = await currentStaff();
  if (!s) return Response.json({ ok: false, error: "admin only" }, { status: 401 });
  if (!UPLOADERS.includes(s.role)) return Response.json({ ok: false, error: "admin only" }, { status: 403 });
  return s.email;
}

// ---- Admins and video editors: the Video board --------------------------------
// /admin/video and its cards (stage, assignee, notes, the client's video
// notes) and a cut uploaded onto a card's listing as internal only.

export async function requireVideo(): Promise<Staff> {
  const s = await currentStaff();
  if (!s) redirect("/portal/login");
  if (!VIDEO_TEAM.includes(s.role)) redirect(deniedPath(s.role));
  return s;
}

export async function assertVideo(): Promise<Staff> {
  const s = await currentStaff();
  if (!s || !VIDEO_TEAM.includes(s.role)) throw new Error("admin only");
  return s;
}

export async function requireVideoApi(): Promise<Staff | Response> {
  const s = await currentStaff();
  if (!s) return Response.json({ ok: false, error: "admin only" }, { status: 401 });
  if (!VIDEO_TEAM.includes(s.role)) return Response.json({ ok: false, error: "admin only" }, { status: 403 });
  return s;
}

// ---- Everyone on the team ---------------------------------------------------
// The layout, the dashboard and the shoot page: they decide per role what to
// show (the dashboard sends a creative specialist on to Upload a shoot; the
// shoot page opens for a creative specialist only through mayOpenShoot).

export async function requireTeam(): Promise<Staff> {
  const s = await currentStaff();
  if (!s) redirect("/portal/login");
  return s;
}

// A creative specialist may open only the shoots they uploaded (the shoot's
// createdBy is their email). Admins and the QA team pass; a video editor
// never opens a shoot page. Use after requireTeam.
export function mayOpenShoot(s: Staff, createdBy: string | null | undefined): boolean {
  if (s.role === "video") return false;
  if (s.role !== "creative") return true;
  return Boolean(createdBy) && createdBy!.trim().toLowerCase() === s.email.trim().toLowerCase();
}

// Activity actor for operator scripts that call an admin route with the token.
export const TOKEN_ACTOR = "claude-token";

// For the direct listing upload routes only: an operator script may send
// x-migrate-token instead of a session (the same token, and the same exact
// match, as /api/portal/admin-api, compared in constant time). Returns
// TOKEN_ACTOR for the token, else the signed-in staff member's email (admin
// or QA: both may upload files to a listing; a creative specialist may not).
export async function requireStaffOrTokenApi(request: Request): Promise<string | Response> {
  if (hasMigrateToken(request)) return TOKEN_ACTOR;
  const s = await requireStaffApi();
  return s instanceof Response ? s : s.email;
}

// The same two routes with the Video board's cut upload (Oct 26 2026): a
// video editor may add films too (video true: the route then checks the
// listing has a Video card, takes films only and keeps them internal).
export async function requireListingUploaderApi(request: Request): Promise<{ actor: string; video: boolean } | Response> {
  if (hasMigrateToken(request)) return { actor: TOKEN_ACTOR, video: false };
  const s = await currentStaff();
  if (!s) return Response.json({ ok: false, error: "admin only" }, { status: 401 });
  if (STAFF.includes(s.role)) return { actor: s.email, video: false };
  if (s.role === "video") return { actor: s.email, video: true };
  return Response.json({ ok: false, error: "admin only" }, { status: 403 });
}
