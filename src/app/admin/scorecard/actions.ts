"use server";
// The scorecard's forms (/admin/scorecard, src/lib/scorecard.ts): the day's
// checklist with hours and miles, the week's review and client-response count,
// a mark on a shoot (on time, handoff, field rework, exclusion), the action
// list, a month's eligible revenue and check-in, and a milestone's goals. Admins and the person the scorecard is for, nobody else.
// Every save records who made it and when (scorecard_entries.updated_by), and
// nothing here touches a booking, a client or an email.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireScorecard } from "@/lib/admin";
import { toYmd } from "@/lib/booking-time";
import { localYmd } from "@/lib/local-date";
import { DAILY, EXCLUSIONS, MILESTONES, SCORECARD_PERSON, TASK_OWNERS, WEEKLY, mondayOf } from "@/lib/scorecard";
import { deleteEntry, getEntry, saveEntry } from "@/lib/scorecard-data";

const PERSON = SCORECARD_PERSON.email;
const PAGE = "/admin/scorecard";
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Back to the section the form was in, which shows the saved or error line (`at`).
function finish(section: string, params: Record<string, string> = {}): never {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${new URLSearchParams({ ...params, at: section }).toString()}#${section}`);
}
const fail = (section: string, error: string): never => finish(section, { error });

const text = (f: FormData, k: string, max: number): string => String(f.get(k) ?? "").trim().slice(0, max);
// A number in [min, max], rounded to `step`, or null when the field is blank. NaN = not a number.
function amount(f: FormData, k: string, min: number, max: number, digits = 1): number | null {
  const raw = String(f.get(k) ?? "").trim().replace(/[$,\s]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return NaN;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
const picked = (f: FormData, allowed: readonly { key: string }[]): string[] => {
  const keys = new Set(f.getAll("check").map(String));
  return allowed.filter((c) => keys.has(c.key)).map((c) => c.key);
};
const yesNo = (v: string): boolean | null => (v === "yes" ? true : v === "no" ? false : null);

export async function saveDay(f: FormData) {
  const me = await requireScorecard(PERSON);
  const today = localYmd();
  const day = toYmd(String(f.get("day") || "")) ?? today;
  if (day > today || day < SCORECARD_PERSON.start) fail("today", "Pick a day between the start date and today.");
  const hours = amount(f, "hours", 0, 24), miles = amount(f, "miles", 0, 2000);
  if (Number.isNaN(hours)) fail("today", "Hours should be a number between 0 and 24.");
  if (Number.isNaN(miles)) fail("today", "Miles should be a number between 0 and 2,000.");
  await saveEntry(PERSON, "day", day, { checks: picked(f, DAILY), hours, miles, notes: text(f, "notes", 2000) }, me.email);
  finish("today", { day, saved: "day" });
}

export async function saveWeek(f: FormData) {
  const me = await requireScorecard(PERSON);
  const monday = mondayOf(toYmd(String(f.get("week") || "")) ?? localYmd());
  const answered = amount(f, "answered", 0, 5000, 0), total = amount(f, "total", 0, 5000, 0);
  if (Number.isNaN(answered) || Number.isNaN(total)) fail("week", "Messages should be whole numbers.");
  if (answered !== null && total !== null && answered > total) fail("week", "Answered on time can't be more than the messages received.");
  if ((answered === null) !== (total === null)) fail("week", "Enter both message numbers, or leave both blank.");
  await saveEntry(PERSON, "week", monday, { checks: picked(f, WEEKLY), answered, total, notes: text(f, "notes", 2000) }, me.email);
  finish("week", { week: monday, saved: "week" });
}

export async function saveShoot(f: FormData) {
  const me = await requireScorecard(PERSON);
  const bookingId = text(f, "bookingId", 80);
  if (!bookingId) fail("shoots", "That shoot wasn't found.");
  const handoff = text(f, "handoff", 8), exclude = text(f, "exclude", 20), note = text(f, "note", 500);
  const data = {
    onTime: yesNo(text(f, "onTime", 8)),
    handoff: handoff === "auto" ? null : yesNo(handoff),
    fieldRework: yesNo(text(f, "fieldRework", 8)),
    exclude: exclude && EXCLUSIONS[exclude] ? exclude : null,
    note: note || null,
  };
  if (Object.values(data).every((v) => v === null)) await deleteEntry(PERSON, "shoot", bookingId);
  else await saveEntry(PERSON, "shoot", bookingId, data, me.email);
  finish("shoots", { saved: "shoot" });
}

export async function addTask(f: FormData) {
  const me = await requireScorecard(PERSON);
  const title = text(f, "title", 200);
  if (!title) fail("tasks", "Write what needs doing.");
  const ownerIn = text(f, "owner", 20);
  const owner = (TASK_OWNERS as readonly string[]).includes(ownerIn) ? ownerIn : SCORECARD_PERSON.first;
  const due = toYmd(String(f.get("due") || ""));
  await saveEntry(PERSON, "task", crypto.randomUUID(), { title, owner, due, status: "open", createdAt: new Date().toISOString() }, me.email);
  finish("tasks", { saved: "task" });
}

export async function updateTask(f: FormData) {
  const me = await requireScorecard(PERSON);
  const id = text(f, "id", 80), op = text(f, "op", 10);
  const e = id ? await getEntry(PERSON, "task", id) : null;
  if (!e) fail("tasks", "That task wasn't found. It may have been deleted.");
  if (op === "delete") {
    await deleteEntry(PERSON, "task", id);
    finish("tasks", { saved: "task-deleted" });
  }
  const done = op === "done";
  await saveEntry(PERSON, "task", id, { ...e!.data, status: done ? "done" : "open", doneAt: done ? new Date().toISOString() : null }, me.email);
  finish("tasks", { saved: done ? "task-done" : "task" });
}

export async function saveRevenue(f: FormData) {
  const me = await requireScorecard(PERSON);
  const month = text(f, "month", 7);
  if (!MONTH_RE.test(month)) fail("goals", "That month isn't valid.");
  const dollars = amount(f, "dollars", 0, 10_000_000, 2);
  if (Number.isNaN(dollars)) fail("goals", "Revenue should be a dollar amount.");
  if (dollars === null) await deleteEntry(PERSON, "revenue", month);
  else await saveEntry(PERSON, "revenue", month, { cents: Math.round(dollars * 100) }, me.email);
  finish("goals", { saved: "revenue" });
}

export async function saveMilestone(f: FormData) {
  const me = await requireScorecard(PERSON);
  const m = MILESTONES.find((x) => x.key === text(f, "milestone", 10));
  if (!m) fail("goals", "That milestone wasn't found.");
  const keys = new Set(f.getAll("goal").map(String));
  const done = m!.goals.map((_, i) => String(i)).filter((i) => keys.has(i));
  await saveEntry(PERSON, "milestone", m!.key, { done, note: text(f, "note", 1000) }, me.email);
  finish("goals", { saved: "milestone" });
}

export async function saveCheckin(f: FormData) {
  const me = await requireScorecard(PERSON);
  const month = text(f, "month", 7);
  if (!MONTH_RE.test(month)) fail("checkins", "That month isn't valid.");
  const notes = text(f, "notes", 3000), decisions = text(f, "decisions", 2000);
  if (!notes && !decisions) await deleteEntry(PERSON, "checkin", month);
  else await saveEntry(PERSON, "checkin", month, { notes, decisions }, me.email);
  finish("checkins", { saved: "checkin" });
}
