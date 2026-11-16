// The operations scorecard (/admin/scorecard): the daily and weekly work, the
// service standards and the goals for one team member (business.scorecard
// .person in src/lib/business.ts), or for the team when nobody is named.
// Admins and that person see it, nobody else.
//
// Two kinds of standards: the person's own (coverage, confirming bookings
// quickly, client replies, independence) and the field team's numbers
// (same-day uploads, on-time starts, field rework), which the person chases
// and coaches but isn't graded on.
//
// The numbers are worked out here from plain rows, so the demo and the
// database share one path (src/lib/scorecard-data.ts loads them).
// Measurement: a rolling 60-day window, counts shown with their denominators,
// at least 30 completed shoots before a shoot percentage means anything, the
// first month is the baseline, and a logged exclusion (access, weather,
// central editing, marketing or funding) leaves a shoot out.
import { business } from "./business";
import { wallClockToUtc } from "./booking-time";
import { addDaysYmd, localYmd } from "./local-date";

export type ScorecardPerson = { email: string; name: string; first: string; title: string; start: string; reportsTo: string };
const TEAM_START = "2026-01-01";
export const SCORECARD_PERSON: ScorecardPerson = business.scorecard.person
  ? { ...business.scorecard.person, reportsTo: business.owner }
  : { email: "team@scorecard.invalid", name: "The team", first: "The team", title: "Operations", start: TEAM_START, reportsTo: business.owner };
export const HAS_PERSON = Boolean(business.scorecard.person);

// Business hours for the confirm and reply clocks: Monday to Friday, in the
// business's time zone (business.scorecard.coverageHours).
export const COVERAGE_HOURS = business.scorecard.coverageHours;
export const CONFIRM_MINUTES: number = business.scorecard.confirmMinutes;

export const WINDOW_DAYS = 60;
export const MIN_SHOOTS = 30;
export const BASELINE_DAYS = 30;
export const REWORK_DAYS = 14;

// ---- The standards -----------------------------------------------------------------

export type StandardKey = "coverage" | "confirm" | "response" | "independence" | "handoff" | "onTime" | "rework";
export type Standard = { key: StandardKey; group: "own" | "team"; label: string; target: number; better: "higher" | "lower"; line: string; source: string };
const confirmWords = CONFIRM_MINUTES === 60 ? "an hour" : `${CONFIRM_MINUTES} minutes`;
export const STANDARDS: readonly Standard[] = [
  { key: "coverage", group: "own", label: "Shooter coverage", target: 1, better: "higher", line: "Every booking has a named shooter by the prior business day. Late bookings: named before the shoot.", source: "From Studio: when a shooter was first named on the booking." },
  { key: "confirm", group: "own", label: `Bookings confirmed within ${confirmWords}`, target: 0.95, better: "higher", line: `At least 95% of new bookings confirmed (time and scope) within ${confirmWords} of business time.`, source: "From Studio: the booking coming in, then Confirm time. Website and email bookings only." },
  { key: "response", group: "own", label: "Client response", target: 0.95, better: "higher", line: "An actionable reply to at least 95% of client messages within two business hours.", source: "Entered each week from the business line." },
  { key: "independence", group: "own", label: "Independence", target: 0.9, better: "higher", line: "90% of routine shoots run without the owner stepping in unplanned.", source: "Marked at check-ins." },
  { key: "handoff", group: "team", label: "Same-day uploads", target: 0.98, better: "higher", line: "At least 98% of shoots uploaded and usable by the end of the shoot day.", source: "From Studio: the first upload for the listing. Override it in the shoot log." },
  { key: "onTime", group: "team", label: "On-time starts", target: 0.95, better: "higher", line: "At least 95% of shoots start at the agreed call time.", source: "Marked in the shoot log, from the shooter or the agent." },
  { key: "rework", group: "team", label: "Field rework", target: 0.03, better: "lower", line: "No more than 3% of shoots need a field-caused reshoot or material correction within 14 days.", source: "Studio flags any reshoot or pickup visit within 14 days. A manager marks whether the field caused it." },
];

// Reasons a shoot leaves the numbers (outside the team's control).
export const EXCLUSIONS: Record<string, string> = {
  access: "Client or property access",
  weather: "Weather",
  editing: "Central editing or delivery",
  marketing: "Marketing or funding",
  other: "Other, see note",
};

// ---- The work -----------------------------------------------------------------------

export type CheckItem = { key: string; label: string };
export const DAILY: readonly CheckItem[] = [
  { key: "confirm", label: `Confirmed every new booking within ${confirmWords}: time, scope and access` },
  { key: "coverage", label: "Every booking for the next business day has a named shooter and a fallback" },
  { key: "briefs", label: "The next day's shooters have what they need: access, client needs and approved scope" },
  { key: "uploads", label: "Checked today's shoots were uploaded and chased anything missing" },
  { key: "replies", label: "Every client message got an actionable reply within two business hours" },
  { key: "issues", label: "Flagged any quality, coverage or client issue with a proposed next action" },
  { key: "log", label: "Logged today's hours and travel" },
];
export const WEEKLY: readonly CheckItem[] = [
  { key: "coverage", label: "Reviewed next week's shooter and fallback coverage" },
  { key: "issues", label: "Closed or escalated every unresolved client issue" },
  { key: "qa", label: "Reviewed field QA and what caused any rework" },
  { key: "coaching", label: "Coached the field team and followed up on training" },
  { key: "actions", label: "Updated the action list: owner, due date and follow-up" },
];

export const TASK_OWNERS: readonly string[] = business.scorecard.taskOwners;

// ---- Milestones ---------------------------------------------------------------------
// Goals at set points from the start date. No pay here: compensation is
// never kept in the studio. revenue: an optional monthly revenue goal in
// dollars (null = none).
export type Milestone = { key: string; label: string; date: string; revenue: number | null; theme: string; goals: readonly string[] };
const monthsFrom = (ymd: string, n: number): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, d));
  return t.toISOString().slice(0, 10);
};
export const MILESTONES: readonly Milestone[] = [
  { key: "start", label: "First month", date: SCORECARD_PERSON.start, revenue: null, theme: "Set the baseline", goals: [
    "Agree coverage hours, shoot deadlines and who to escalate to",
    "Build the shooter roster, with a backup for each day",
    "Start the time and travel logs",
    "Set the first-month scorecard baseline",
  ] },
  { key: "m3", label: "Month 3", date: monthsFrom(SCORECARD_PERSON.start, 3), revenue: null, theme: "Steady service", goals: [
    "Meet the service standards",
    "Every booking covered, with dependable handoffs from the field team",
    "Client follow-through written down",
  ] },
  { key: "m6", label: "Month 6", date: monthsFrom(SCORECARD_PERSON.start, 6), revenue: null, theme: "Own coverage and coaching", goals: [
    "Keep the service standards",
    "Run the weekly coverage and QA review",
    "Coach the field team and keep a usable fallback roster",
  ] },
  { key: "m12", label: "Month 12", date: monthsFrom(SCORECARD_PERSON.start, 12), revenue: null, theme: "Run it without the owner", goals: [
    "Keep the service and independence standards",
    "Repeatable coverage, coaching and client-issue resolution",
    "A written playbook another team member can follow",
  ] },
];

// ---- Rows ----------------------------------------------------------------------------

export type ScEntry = { kind: string; key: string; data: Record<string, unknown>; updatedBy: string | null; updatedAt: string };

// One past shoot in the window, as Studio knows it. Times are ISO strings.
export type ScShoot = {
  bookingId: string;
  address: string;
  ymd: string; // the local shoot day
  startsAt: string;
  createdAt: string; // when the booking came in
  status: string;
  shooter: string | null;
  shooterNamedAt: string | null; // the first time any shooter was named (activity); null = at intake
  uploadedAt: string | null; // the first upload for the listing from the shoot day on
  reworkAt: string | null; // a reshoot or pickup visit added within 14 days of the shoot
  reworkKind: string | null;
};
// A client booking that came in during the window, for the confirm clock.
export type ScBooking = { bookingId: string; address: string; createdAt: string; status: string; confirmedAt: string | null };
// A shoot coming up, for the daily coverage check.
export type ScUpcoming = { bookingId: string; address: string; ymd: string; time: string | null; status: string; shooter: string | null };

export type ShootMark = { onTime: boolean | null; handoff: boolean | null; fieldRework: boolean | null; exclude: string | null; note: string | null; by: string | null; at: string | null };
export type ShootRow = ScShoot & { mark: ShootMark; covered: boolean; uploadedSameDay: boolean | null; handoffOk: boolean | null; reworkPending: boolean; excluded: boolean };
// waiting = still inside its hour; late = past the hour and not confirmed yet; norecord = confirmed some other way.
export type ConfirmRow = ScBooking & { minutes: number | null; state: "ok" | "late" | "waiting" | "norecord" | "canceled" };

const bool = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function readMark(e: ScEntry | undefined): ShootMark {
  const d = e?.data ?? {};
  return { onTime: bool(d.onTime), handoff: bool(d.handoff), fieldRework: bool(d.fieldRework), exclude: str(d.exclude), note: str(d.note), by: e?.updatedBy ?? null, at: e?.updatedAt ?? null };
}

// ---- Calendar ------------------------------------------------------------------------------

const weekday = (ymd: string): number => new Date(`${ymd}T12:00:00Z`).getUTCDay();
export const isWeekend = (ymd: string): boolean => weekday(ymd) === 0 || weekday(ymd) === 6;
export function prevBusinessDay(ymd: string): string {
  let d = addDaysYmd(ymd, -1);
  while (isWeekend(d)) d = addDaysYmd(d, -1);
  return d;
}
export function nextBusinessDay(ymd: string): string {
  let d = addDaysYmd(ymd, 1);
  while (isWeekend(d)) d = addDaysYmd(d, 1);
  return d;
}
export const mondayOf = (ymd: string): string => addDaysYmd(ymd, -((weekday(ymd) + 6) % 7));
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
export const monthOf = (ymd: string): string => ymd.slice(0, 7);
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const at = (ymd: string, hm: string): number => wallClockToUtc(ymd, hm)?.getTime() ?? Date.parse(`${ymd}T${hm}:00Z`);
const endOfDay = (ymd: string): number => at(ymd, "23:59") + 59_000;

// Minutes between two instants that fall inside business hours (weekdays,
// COVERAGE_HOURS, local). A booking that comes in on Saturday starts its
// clock Monday at opening.
export function businessMinutes(from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  for (let d = localYmd(new Date(from)), last = localYmd(new Date(to)); d <= last; d = addDaysYmd(d, 1)) {
    if (isWeekend(d)) continue;
    const open = Math.max(from, at(d, COVERAGE_HOURS.open)), close = Math.min(to, at(d, COVERAGE_HOURS.close));
    if (close > open) total += (close - open) / 60_000;
  }
  return Math.round(total);
}

// ---- The math ------------------------------------------------------------------------------

export function shootRows(shoots: ScShoot[], marks: Map<string, ScEntry>, now: Date): ShootRow[] {
  return shoots.map((s) => {
    const mark = readMark(marks.get(s.bookingId));
    const created = Date.parse(s.createdAt), starts = Date.parse(s.startsAt);
    const deadline = endOfDay(prevBusinessDay(s.ymd));
    const namedAt = s.shooter ? Date.parse(s.shooterNamedAt ?? s.createdAt) : NaN;
    // A late booking (it came in after the prior business day) only needs a
    // shooter before the shoot; the offer has managers confirm those at acceptance.
    const covered = Boolean(s.shooter) && namedAt <= (created > deadline ? starts : deadline);
    const uploadedSameDay = s.uploadedAt ? Date.parse(s.uploadedAt) <= endOfDay(s.ymd) : now.getTime() > endOfDay(s.ymd) ? false : null;
    return {
      ...s,
      mark,
      covered,
      uploadedSameDay,
      handoffOk: mark.handoff ?? uploadedSameDay,
      reworkPending: Boolean(s.reworkAt) && mark.fieldRework === null,
      excluded: Boolean(mark.exclude),
    };
  });
}

export function confirmRows(bookings: ScBooking[], now: Date): ConfirmRow[] {
  return bookings.map((b) => {
    const created = Date.parse(b.createdAt);
    if (b.confirmedAt) {
      const minutes = businessMinutes(created, Date.parse(b.confirmedAt));
      return { ...b, minutes, state: minutes <= CONFIRM_MINUTES ? "ok" : "late" };
    }
    if (b.status === "canceled") return { ...b, minutes: null, state: "canceled" };
    // Confirmed, shot or delivered with no Confirm time on record (an older row, or set another way).
    if (b.status !== "requested") return { ...b, minutes: null, state: "norecord" };
    const minutes = businessMinutes(created, now.getTime());
    return { ...b, minutes, state: minutes > CONFIRM_MINUTES ? "late" : "waiting" };
  });
}

export type KpiStatus = "met" | "below" | "nodata" | "dormant";
export type Kpi = Standard & { num: number; den: number; rate: number | null; status: KpiStatus; pending: number; pendingLabel: string };

const judge = (s: Standard, num: number, den: number, pending = 0, pendingLabel = "not marked yet"): Kpi => {
  const rate = den > 0 ? num / den : null;
  const status: KpiStatus = rate === null ? "nodata" : s.better === "higher" ? (rate >= s.target ? "met" : "below") : rate <= s.target ? "met" : "below";
  return { ...s, num, den, rate, status, pending, pendingLabel };
};

export function kpis(rows: ShootRow[], confirms: ConfirmRow[], weeks: ScEntry[]): Kpi[] {
  const counted = rows.filter((r) => !r.excluded);
  const std = (k: StandardKey) => STANDARDS.find((s) => s.key === k)!;
  const answered = weeks.reduce((n, w) => n + (num(w.data.answered) ?? 0), 0);
  const total = weeks.reduce((n, w) => n + (num(w.data.total) ?? 0), 0);
  const timed = confirms.filter((c) => c.state === "ok" || c.state === "late");
  return [
    judge(std("coverage"), counted.filter((r) => r.covered).length, counted.length),
    judge(std("confirm"), timed.filter((c) => c.state === "ok").length, timed.length, confirms.filter((c) => c.state === "norecord").length, "confirmed with no Confirm time on record"),
    judge(std("response"), answered, total),
    { ...std("independence"), num: 0, den: 0, rate: null, status: "dormant", pending: 0, pendingLabel: "" },
    judge(std("handoff"), counted.filter((r) => r.handoffOk === true).length, counted.filter((r) => r.handoffOk !== null).length, counted.filter((r) => r.handoffOk === null).length, "waiting on today's upload"),
    judge(std("onTime"), counted.filter((r) => r.mark.onTime === true).length, counted.filter((r) => r.mark.onTime !== null).length, counted.filter((r) => r.mark.onTime === null).length),
    judge(std("rework"), counted.filter((r) => r.mark.fieldRework === true).length, counted.length, counted.filter((r) => r.reworkPending).length, "reshoot or pickup to review"),
  ];
}

export type DayLog = { ymd: string; checks: string[]; hours: number | null; miles: number | null; notes: string };
export function readDay(ymd: string, e: ScEntry | undefined): DayLog {
  const d = e?.data ?? {};
  return { ymd, checks: Array.isArray(d.checks) ? d.checks.filter((c): c is string => typeof c === "string") : [], hours: num(d.hours), miles: num(d.miles), notes: str(d.notes) ?? "" };
}
export type WeekLog = { monday: string; checks: string[]; answered: number | null; total: number | null; notes: string };
export function readWeek(monday: string, e: ScEntry | undefined): WeekLog {
  const d = e?.data ?? {};
  return { monday, checks: Array.isArray(d.checks) ? d.checks.filter((c): c is string => typeof c === "string") : [], answered: num(d.answered), total: num(d.total), notes: str(d.notes) ?? "" };
}

export type Task = { id: string; title: string; owner: string; due: string | null; status: "open" | "done"; doneAt: string | null; by: string | null; createdAt: string };
export function readTasks(entries: ScEntry[]): Task[] {
  return entries
    .filter((e) => e.kind === "task" && str(e.data.title))
    .map((e) => ({ id: e.key, title: str(e.data.title)!, owner: str(e.data.owner) ?? SCORECARD_PERSON.first, due: str(e.data.due), status: (e.data.status === "done" ? "done" : "open") as Task["status"], doneAt: str(e.data.doneAt), by: e.updatedBy, createdAt: str(e.data.createdAt) ?? e.updatedAt }))
    .sort((a, b) => (a.status === b.status ? (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.createdAt.localeCompare(b.createdAt) : a.status === "open" ? -1 : 1));
}

// The revenue gate (offer page 4): the average of the last three completed
// calendar months of eligible revenue, from the finance ledger, against the
// next milestone's target. Studio's own paid invoices sit beside it as a
// cross-check, never as the number.
export type RevenueMonthRow = { month: string; cents: number | null; estimateCents: number | null; by: string | null };
export function revenueGate(entries: ScEntry[], estimate: Record<string, number>, today: string) {
  const cur = monthOf(today);
  const months: RevenueMonthRow[] = [3, 2, 1].map((n) => {
    const month = addMonths(cur, -n);
    const e = entries.find((x) => x.kind === "revenue" && x.key === month);
    return { month, cents: e ? num(e.data.cents) : null, estimateCents: estimate[month] ?? null, by: e?.updatedBy ?? null };
  });
  const entered = months.filter((m) => m.cents !== null);
  const avgCents = entered.length === 3 ? Math.round(entered.reduce((s, m) => s + (m.cents ?? 0), 0) / 3) : null;
  return { months, entered: entered.length, avgCents };
}

export function milestoneState(today: string) {
  const next = MILESTONES.find((m) => m.date > today) ?? null;
  const current = [...MILESTONES].reverse().find((m) => m.date <= today) ?? MILESTONES[0];
  return { next, current, daysToNext: next ? daysBetween(today, next.date) : null };
}

export const pct = (rate: number | null, digits = 0): string => (rate === null ? "No data" : `${(rate * 100).toFixed(digits)}%`);
export const dollars = (cents: number | null): string => (cents === null ? "Not entered" : `$${Math.round(cents / 100).toLocaleString("en-US")}`);
