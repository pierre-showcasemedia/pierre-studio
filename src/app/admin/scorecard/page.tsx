// The operations scorecard (/admin/scorecard): the service standards, the
// daily and weekly work and the goals for the person named in
// business.scorecard (src/lib/business.ts), or the team. Admins and that
// person only (src/lib/scorecard.ts has the math). Studio fills in what it
// knows (when a booking was confirmed, when a shooter was named, when a shoot
// was uploaded, any reshoot or pickup within 14 days); the rest is marked here.
import Link from "next/link";
import "@/styles/admin-bookings.css";
import "@/styles/admin-scorecard.css";
import { PageHead, SectionHead, Shooter } from "@/components/admin/bits";
import { requireScorecard } from "@/lib/admin";
import { fmtDay, fmtTime12, toYmd } from "@/lib/booking-time";
import { addDaysYmd, localYmd } from "@/lib/local-date";
import {
  BASELINE_DAYS,
  DAILY,
  EXCLUSIONS,
  MILESTONES,
  CONFIRM_MINUTES,
  COVERAGE_HOURS,
  MIN_SHOOTS,
  HAS_PERSON,
  SCORECARD_PERSON as P,
  TASK_OWNERS,
  WEEKLY,
  WINDOW_DAYS,
  addMonths,
  confirmRows,
  daysBetween,
  dollars,
  isWeekend,
  kpis,
  milestoneState,
  mondayOf,
  monthOf,
  pct,
  readDay,
  readTasks,
  readWeek,
  revenueGate,
  shootRows,
  type Kpi,
  type ScEntry,
  type ShootRow,
} from "@/lib/scorecard";
import { loadScorecard } from "@/lib/scorecard-data";
import { addTask, saveCheckin, saveDay, saveMilestone, saveRevenue, saveShoot, saveWeek, updateTask } from "./actions";
import { TZ_SHORT } from "@/lib/business";

export const dynamic = "force-dynamic";

const SAVED: Record<string, string> = {
  day: "Day saved.",
  week: "Week saved.",
  shoot: "Shoot updated.",
  task: "Task saved.",
  "task-done": "Task marked done.",
  "task-deleted": "Task deleted.",
  revenue: "Revenue saved.",
  milestone: "Milestone saved.",
  checkin: "Check-in saved.",
};
const STATUS_LABEL: Record<Kpi["status"], string> = { met: "On track", below: "Below target", nodata: "No data yet", dormant: "Not started" };
const RECENT_SHOOTS = 10;
const who = (email: string | null) => (email ? email.split("@")[0] : "someone");
const fmtMonth = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const fmtMinutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
const targetLabel = (k: Kpi) => (k.key === "coverage" ? "every booking" : `${k.better === "higher" ? "at least" : "at most"} ${pct(k.target)}`);

// One card per standard: the rate, the count behind it, the target and what still needs marking.
function KpiGrid({ list }: { list: Kpi[] }) {
  return (
    <div className="sc-kpis">
      {list.map((k) => (
        <div key={k.key} className={`sc-kpi sc-kpi--${k.status}`}>
          <div className="sc-kpi__top"><span className="kicker">{k.label}</span><span className="sc-dot">{STATUS_LABEL[k.status]}</span></div>
          <div className="sc-kpi__n">{k.status === "dormant" ? "Later" : pct(k.rate)}</div>
          <div className="sc-kpi__count">{k.status === "dormant" ? "Not measured yet" : `${k.num} of ${k.den}`} · target {targetLabel(k)}</div>
          {k.pending > 0 && <div className="sc-kpi__pending">{k.pending} {k.pendingLabel}</div>}
          <p className="sc-kpi__line">{k.line}</p>
          <p className="sc-kpi__src">{k.source}</p>
        </div>
      ))}
    </div>
  );
}

// The shoot log, one row per completed shoot: what Studio knows (named,
// upload) beside the marks. A phone stacks each row into a card.
function ShootTable({ list }: { list: ShootRow[] }) {
  return (
    <div className="adm-table-wrap"><div className="adm-table-scroll">
      <table className="adm-table sc-table">
        <thead><tr><th>Shoot</th><th>Shooter</th><th>Named</th><th>Upload</th><th>On time</th><th>Handoff</th><th>Field rework</th><th>Leave out</th><th>Note</th><th /></tr></thead>
        <tbody>
          {list.map((r) => {
            const f = `sc-shoot-${r.bookingId}`;
            return (
              <tr key={r.bookingId} className={r.excluded ? "is-out" : undefined}>
                <td><Link href={`/admin/bookings/${r.bookingId}`} className="sc-shoot"><span className="adm-mono">{fmtDay(r.ymd)}</span><span>{r.address}</span></Link></td>
                <td><Shooter email={r.shooter} /></td>
                <td><span className={`sc-flag ${r.covered ? "is-ok" : "is-bad"}`}>{r.covered ? "In time" : r.shooter ? "Late" : "Nobody"}</span></td>
                <td><span className={`sc-flag ${r.uploadedSameDay === true ? "is-ok" : r.uploadedSameDay === false ? "is-bad" : ""}`}>{r.uploadedSameDay === true ? "Same day" : r.uploadedSameDay === false ? (r.uploadedAt ? "Late" : "Missing") : "Waiting"}</span></td>
                <td><select form={f} name="onTime" defaultValue={r.mark.onTime === null ? "" : r.mark.onTime ? "yes" : "no"} aria-label="On time"><option value="">Not marked</option><option value="yes">Yes</option><option value="no">No</option></select></td>
                <td><select form={f} name="handoff" defaultValue={r.mark.handoff === null ? "auto" : r.mark.handoff ? "yes" : "no"} aria-label="Handoff"><option value="auto">From upload</option><option value="yes">Complete</option><option value="no">Incomplete</option></select></td>
                <td>
                  {r.reworkAt && <span className="sc-tag sc-tag--warn">{r.reworkKind === "pickup" ? "Pickup" : "Reshoot"} added</span>}
                  <select form={f} name="fieldRework" defaultValue={r.mark.fieldRework === null ? "" : r.mark.fieldRework ? "yes" : "no"} aria-label="Field rework"><option value="">{r.reworkAt ? "Review" : "None"}</option><option value="no">Not field caused</option><option value="yes">Field caused</option></select>
                </td>
                <td><select form={f} name="exclude" defaultValue={r.mark.exclude ?? ""} aria-label="Leave out"><option value="">Counts</option>{Object.entries(EXCLUSIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                <td><input form={f} name="note" defaultValue={r.mark.note ?? ""} aria-label="Note" className="sc-input" /></td>
                <td>
                  <form id={f} action={saveShoot}><input type="hidden" name="bookingId" value={r.bookingId} /><button type="submit" className="adm-chip adm-chip--quiet">Save</button></form>
                  {r.mark.by && <span className="sc-by">{who(r.mark.by)}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div></div>
  );
}

// The saved or error line, shown in the section the form came back to (?at=).
function Note({ at, sp }: { at: string; sp: { at?: string; saved?: string; error?: string } }) {
  if (sp.at !== at) return null;
  if (sp.error) return <p className="adm-banner adm-banner--bad sc-note">{sp.error}</p>;
  return sp.saved && SAVED[sp.saved] ? <p className="adm-banner adm-banner--ok sc-note">{SAVED[sp.saved]}</p> : null;
}

export default async function ScorecardPage({ searchParams }: { searchParams: Promise<{ day?: string; week?: string; saved?: string; error?: string; at?: string }> }) {
  // The gate, here and not only in the layout (see src/lib/admin.ts).
  await requireScorecard(P.email);
  const sp = await searchParams;
  const now = new Date();
  const today = localYmd(now);
  const data = await loadScorecard(P, now);
  const of = (kind: string) => data.entries.filter((e) => e.kind === kind);
  const entry = (kind: string, key: string): ScEntry | undefined => data.entries.find((e) => e.kind === kind && e.key === key);

  const rows = shootRows(data.shoots, new Map(of("shoot").map((e) => [e.key, e])), now);
  const windowStart = addDaysYmd(today, -(WINDOW_DAYS - 1));
  const weeks = of("week").filter((w) => w.key >= mondayOf(windowStart));
  const confirms = confirmRows(data.bookings, now);
  const scores = kpis(rows, confirms, weeks);
  const toConfirm = confirms.filter((c) => c.status === "requested" && !c.confirmedAt);
  const counted = rows.filter((r) => !r.excluded).length;
  const dayN = daysBetween(P.start, today) + 1;
  const { next, current, daysToNext } = milestoneState(today);
  const rev = revenueGate(data.entries, data.estimate, today);
  const revTarget = next?.revenue ?? null;

  const asked = toYmd(sp.day ?? "") ?? today;
  const day = asked > today ? today : asked < P.start ? P.start : asked;
  const dayLog = readDay(day, entry("day", day));
  const week = mondayOf(toYmd(sp.week ?? "") ?? today);
  const weekLog = readWeek(week, entry("week", week));
  const recentDays = Array.from({ length: 20 }, (_, i) => addDaysYmd(today, -i)).filter((d) => !isWeekend(d) && d >= P.start).slice(0, 10).map((d) => readDay(d, entry("day", d)));
  const recentWeeks = Array.from({ length: 8 }, (_, i) => addDaysYmd(mondayOf(today), -7 * i)).filter((m) => m >= mondayOf(P.start)).map((m) => readWeek(m, entry("week", m)));
  const tasks = readTasks(data.entries);
  const open = tasks.filter((t) => t.status === "open"), closed = tasks.filter((t) => t.status === "done").slice(0, 10);
  const checkins = of("checkin").sort((a, b) => b.key.localeCompare(a.key));
  const thisMonth = monthOf(today);
  const upcomingDays = [...new Set(data.upcoming.map((u) => u.ymd))];

  return (
    <section className="wrap adm-page sc">
      <PageHead eyebrow="Team" title={HAS_PERSON ? `${P.first}’s scorecard.` : "Team scorecard."} lede={HAS_PERSON ? `${P.name}, ${P.title}. Bookings, shooter coverage and client communication, measured against the standards below.` : "Bookings, shooter coverage and client communication, measured against the standards below. Name a person in src/lib/business.ts (business.scorecard.person) to make it theirs."} />

      <div className="sc-stats">
        <div className="sc-stat"><div className="sc-stat__n">Day {dayN}</div><div className="sc-stat__l">Since {fmtDay(P.start)}</div></div>
        <div className="sc-stat"><div className="sc-stat__n">{next ? next.label : "All reviews held"}</div><div className="sc-stat__l">{next ? `Next formal review, ${fmtDay(next.date)}${daysToNext !== null ? `, in ${daysToNext} days` : ""}` : "Month 18 has passed"}</div></div>
        <div className="sc-stat"><div className="sc-stat__n">{counted}</div><div className="sc-stat__l">Shoots counted in the last {WINDOW_DAYS} days ({MIN_SHOOTS} needed for percentages)</div></div>
        <div className="sc-stat"><div className="sc-stat__n">{rev.avgCents !== null ? dollars(rev.avgCents) : `${rev.entered} of 3`}</div><div className="sc-stat__l">{rev.avgCents !== null ? "Eligible revenue, 3-month average" : "Months of eligible revenue entered"}{revTarget ? `. ${next?.label} target ${dollars(revTarget * 100)}` : ""}</div></div>
      </div>

      {data.demo && <p className="adm-banner adm-banner--info sc-note">Demo mode: sample shoots, and saves last until the server restarts.</p>}
      {data.tableMissing && <p className="adm-banner adm-banner--warn sc-note">The scorecard table isn&apos;t in the database yet, so nothing saved here will stick. Run the migrate route once (POST /api/portal/migrate).</p>}

      {/* ---- Service standards ---- */}
      <div className="adm-section" id="kpis">
        <SectionHead title={`Service standards · last ${WINDOW_DAYS} days`} />
        {dayN <= BASELINE_DAYS && <p className="adm-banner adm-banner--info sc-note">First month: these numbers set the baseline. They aren&apos;t a grade yet.</p>}
        {counted < MIN_SHOOTS && <p className="adm-banner adm-banner--info sc-note">Fewer than {MIN_SHOOTS} shoots in the last {WINDOW_DAYS} days, so the shoot-based numbers are a review, not percentages. The counts are still the record.</p>}
        <h3 className="sc-group">{HAS_PERSON ? `${P.first}’s standards` : "Operations standards"}</h3>
        <KpiGrid list={scores.filter((k) => k.group === "own")} />
        <p className="muted sc-fine">Business hours for the confirm and reply clocks: {COVERAGE_HOURS.label}, {TZ_SHORT}. A booking that comes in after hours starts its {CONFIRM_MINUTES}-minute clock at the next opening.</p>
        <h3 className="sc-group">The field team</h3>
        <p className="muted sc-lede">The shooters&apos; numbers, chased and coached here. They aren&apos;t graded as the coordinator&apos;s own work.</p>
        <KpiGrid list={scores.filter((k) => k.group === "team")} />
        <p className="muted sc-fine">Shoots left out for reasons outside the team&apos;s control (access, weather, central editing or delivery, marketing or funding) are excluded in the shoot log and don&apos;t count either way. Communication and escalation are judged separately at check-ins.</p>
      </div>

      {/* ---- Today ---- */}
      <div className="adm-section" id="today">
        <SectionHead title="Daily: deliver and document" />
        <Note at="today" sp={sp} />
        <div className="sc-split">
          <div className="adm-card adm-card--lg">
            <form method="get" className="sc-pick">
              <div className="field"><label htmlFor="sc-day">Day</label><input id="sc-day" type="date" name="day" defaultValue={day} min={P.start} max={today} /></div>
              <button type="submit" className="adm-chip adm-chip--quiet">Open day</button>
            </form>
            <form action={saveDay} className="sc-form">
              <input type="hidden" name="day" value={day} />
              <div className="kicker">{day === today ? "Today" : fmtDay(day, { long: true })}</div>
              <ul className="sc-checks">
                {DAILY.map((c) => <li key={c.key}><label className="sc-check"><input type="checkbox" name="check" value={c.key} defaultChecked={dayLog.checks.includes(c.key)} /><span>{c.label}</span></label></li>)}
              </ul>
              <div className="sc-row">
                <div className="field"><label htmlFor="sc-hours">Hours worked</label><input id="sc-hours" name="hours" inputMode="decimal" placeholder="8" defaultValue={dayLog.hours ?? ""} /></div>
                <div className="field"><label htmlFor="sc-miles">Business miles</label><input id="sc-miles" name="miles" inputMode="decimal" placeholder="64" defaultValue={dayLog.miles ?? ""} /></div>
              </div>
              <div className="field"><label htmlFor="sc-notes">Issues flagged, and the next action for each</label><textarea id="sc-notes" name="notes" defaultValue={dayLog.notes} placeholder="Coverage gap Thursday, asked a backup shooter to hold 2 PM. Lockbox code wrong at one listing, agent sending a new one." /></div>
              <button type="submit" className="btn btn-primary">Save day</button>
              <p className="muted sc-fine">Hours and miles here are a working record. Payroll timekeeping and the monthly mileage log still go through their usual channels.</p>
            </form>
          </div>
          <div className="sc-side">
            <div className="adm-card">
              <div className="kicker">Bookings to confirm</div>
              {toConfirm.length === 0 ? <p className="muted sc-empty">Every new booking is confirmed.</p> : toConfirm.slice(0, 8).map((c) => (
                <Link key={c.bookingId} href={`/admin/bookings/${c.bookingId}`} className="sc-up__row sc-up__row--confirm">
                  <span className="sc-up__addr">{c.address}</span>
                  <span className={`sc-flag ${c.state === "late" ? "is-bad" : ""}`}>{c.state === "late" ? `Late, ${fmtMinutes(c.minutes ?? 0)}` : `${fmtMinutes(Math.max(0, CONFIRM_MINUTES - (c.minutes ?? 0)))} left`}</span>
                </Link>
              ))}
              <p className="muted sc-fine">Business minutes since the booking came in. Confirm time on the booking stops the clock.</p>
            </div>
            <div className="adm-card">
              <div className="kicker">Coming up</div>
              {data.upcoming.length === 0 ? <p className="muted sc-empty">Nothing booked today or on the next business day.</p> : upcomingDays.map((d) => (
                <div key={d} className="sc-up">
                  <div className="sc-up__day">{d === today ? "Today" : fmtDay(d)}</div>
                  {data.upcoming.filter((u) => u.ymd === d).map((u) => (
                    <Link key={u.bookingId} href={`/admin/bookings/${u.bookingId}`} className="sc-up__row">
                      <span className="sc-up__time adm-mono">{u.time ? fmtTime12(u.time) : "No time"}</span>
                      <span className="sc-up__addr">{u.address}{u.status === "requested" ? <span className="sc-tag">Unconfirmed</span> : null}</span>
                      <Shooter email={u.shooter} needed />
                    </Link>
                  ))}
                </div>
              ))}
              <p className="muted sc-fine">Studio shows the named shooter. Keep the fallback in mind for each one.</p>
            </div>
            <div className="adm-card">
              <div className="kicker">Last ten workdays</div>
              <ul className="sc-days">
                {recentDays.map((d) => (
                  <li key={d.ymd}><Link href={`/admin/scorecard?day=${d.ymd}#today`} className={d.ymd === day ? "is-on" : undefined}>
                    <span>{d.ymd === today ? "Today" : fmtDay(d.ymd)}</span>
                    <span className={`sc-days__n${d.checks.length === DAILY.length ? " is-full" : d.checks.length === 0 ? " is-none" : ""}`}>{d.checks.length} of {DAILY.length}</span>
                    <span className="muted adm-mono">{d.hours !== null ? `${d.hours} h` : ""}{d.miles !== null ? ` · ${d.miles} mi` : ""}</span>
                  </Link></li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* ---- Week ---- */}
      <div className="adm-section" id="week">
        <SectionHead title="Weekly: keep coverage and quality dependable" />
        <Note at="week" sp={sp} />
        <div className="sc-split">
          <div className="adm-card adm-card--lg">
            <form method="get" className="sc-pick">
              <div className="field"><label htmlFor="sc-week">Week of</label><input id="sc-week" type="date" name="week" defaultValue={week} min={mondayOf(P.start)} max={today} /></div>
              <button type="submit" className="adm-chip adm-chip--quiet">Open week</button>
            </form>
            <form action={saveWeek} className="sc-form">
              <input type="hidden" name="week" value={week} />
              <div className="kicker">Week of {fmtDay(week, { long: true })}</div>
              <ul className="sc-checks">
                {WEEKLY.map((c) => <li key={c.key}><label className="sc-check"><input type="checkbox" name="check" value={c.key} defaultChecked={weekLog.checks.includes(c.key)} /><span>{c.label}</span></label></li>)}
              </ul>
              <div className="sc-row">
                <div className="field"><label htmlFor="sc-total">Client messages this week</label><input id="sc-total" name="total" inputMode="numeric" placeholder="42" defaultValue={weekLog.total ?? ""} /></div>
                <div className="field"><label htmlFor="sc-answered">Answered within 2 business hours</label><input id="sc-answered" name="answered" inputMode="numeric" placeholder="41" defaultValue={weekLog.answered ?? ""} /></div>
              </div>
              <div className="field"><label htmlFor="sc-wnotes">Coverage, QA and coaching notes</label><textarea id="sc-wnotes" name="notes" defaultValue={weekLog.notes} /></div>
              <button type="submit" className="btn btn-primary">Save week</button>
              <p className="muted sc-fine">The message counts come from the business line and feed the client response standard.</p>
            </form>
          </div>
          <div className="adm-card">
            <div className="kicker">Recent weeks</div>
            <ul className="sc-days">
              {recentWeeks.map((w) => (
                <li key={w.monday}><Link href={`/admin/scorecard?week=${w.monday}#week`} className={w.monday === week ? "is-on" : undefined}>
                  <span>{fmtDay(w.monday)}</span>
                  <span className={`sc-days__n${w.checks.length === WEEKLY.length ? " is-full" : w.checks.length === 0 ? " is-none" : ""}`}>{w.checks.length} of {WEEKLY.length}</span>
                  <span className="muted adm-mono">{w.total ? `${pct((w.answered ?? 0) / w.total)} replies` : ""}</span>
                </Link></li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* ---- Shoot log ---- */}
      <div className="adm-section" id="shoots">
        <SectionHead title={`Shoot log · last ${WINDOW_DAYS} days`} />
        <Note at="shoots" sp={sp} />
        <p className="muted sc-lede">Studio fills in Named and Upload. Mark On time for every shoot. When Studio flags a reshoot or pickup, a manager marks whether the field caused it. Handoff follows the upload unless you set it.</p>
        {rows.length === 0 ? <p className="muted sc-empty">No completed shoots in the last {WINDOW_DAYS} days.</p> : (
          <>
            <ShootTable list={rows.slice(0, RECENT_SHOOTS)} />
            {rows.length > RECENT_SHOOTS && (
              <details className="sc-done">
                <summary>Older shoots in the last {WINDOW_DAYS} days ({rows.length - RECENT_SHOOTS})</summary>
                <ShootTable list={rows.slice(RECENT_SHOOTS)} />
              </details>
            )}
          </>
        )}
      </div>

      {/* ---- Action list ---- */}
      <div className="adm-section" id="tasks">
        <SectionHead title="Action list" />
        <Note at="tasks" sp={sp} />
        <form action={addTask} className="adm-card sc-add">
          <div className="field sc-add__title"><label htmlFor="sc-task">What needs doing</label><input id="sc-task" name="title" required maxLength={200} placeholder="Line up a fallback shooter for Thursday afternoons" /></div>
          <div className="field"><label htmlFor="sc-owner">Owner</label><select id="sc-owner" name="owner" defaultValue={P.first}>{TASK_OWNERS.map((o) => <option key={o}>{o}</option>)}</select></div>
          <div className="field"><label htmlFor="sc-due">Due</label><input id="sc-due" type="date" name="due" /></div>
          <button type="submit" className="btn btn-primary">Add</button>
        </form>
        {open.length === 0 ? <p className="muted sc-empty">Nothing open.</p> : (
          <ul className="sc-tasks">
            {open.map((t) => (
              <li key={t.id} className="sc-task">
                <div className="sc-task__body">
                  <span className="sc-task__title">{t.title}</span>
                  <span className="sc-task__meta"><span className="sc-tag">{t.owner}</span>{t.due && <span className={`adm-mono${t.due < today ? " sc-late" : ""}`}>{t.due < today ? "Overdue, " : "Due "}{fmtDay(t.due)}</span>}</span>
                </div>
                <form action={updateTask} className="sc-task__acts">
                  <input type="hidden" name="id" value={t.id} />
                  <button type="submit" name="op" value="done" className="adm-chip">Done</button>
                  <button type="submit" name="op" value="delete" className="adm-chip adm-chip--quiet">Delete</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {closed.length > 0 && (
          <details className="sc-done">
            <summary>Done recently ({closed.length})</summary>
            <ul className="sc-tasks">
              {closed.map((t) => (
                <li key={t.id} className="sc-task is-done">
                  <div className="sc-task__body"><span className="sc-task__title">{t.title}</span><span className="sc-task__meta"><span className="sc-tag">{t.owner}</span>{t.doneAt && <span className="adm-mono muted">Done {fmtDay(localYmd(new Date(t.doneAt)))}</span>}</span></div>
                  <form action={updateTask} className="sc-task__acts"><input type="hidden" name="id" value={t.id} /><button type="submit" name="op" value="reopen" className="adm-chip adm-chip--quiet">Reopen</button></form>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* ---- Milestones and revenue ---- */}
      <div className="adm-section" id="goals">
        <SectionHead title="Milestones and pay" />
        <Note at="goals" sp={sp} />
        <div className="adm-card adm-card--lg sc-rev">
          <div className="kicker">Eligible revenue, last three completed months</div>
          <p className="muted sc-fine">Collected service revenue for completed work, net of refunds, from the finance ledger. No taxes or deposits for unfinished work. Studio&apos;s paid invoices (every market) sit beside it as a cross-check, never as the number.</p>
          <div className="adm-table-wrap"><div className="adm-table-scroll">
            <table className="adm-table sc-table">
              <thead><tr><th>Month</th><th>Eligible revenue</th><th>Studio paid invoices</th><th /></tr></thead>
              <tbody>
                {rev.months.map((m) => {
                  const f = `sc-rev-${m.month}`;
                  return (
                    <tr key={m.month}>
                      <td>{fmtMonth(m.month)}</td>
                      <td><input form={f} name="dollars" inputMode="decimal" defaultValue={m.cents !== null ? String(m.cents / 100) : ""} placeholder="From the ledger" aria-label={`Eligible revenue for ${fmtMonth(m.month)}`} className="sc-input" /></td>
                      <td className="adm-mono">{m.estimateCents !== null ? dollars(m.estimateCents) : "None"}</td>
                      <td><form id={f} action={saveRevenue}><input type="hidden" name="month" value={m.month} /><button type="submit" className="adm-chip adm-chip--quiet">Save</button></form>{m.by && <span className="sc-by">{who(m.by)}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div></div>
          <p className="sc-rev__avg">
            {rev.avgCents !== null ? <>Three-month average <strong>{dollars(rev.avgCents)}</strong></> : <>Enter all three months to see the average ({rev.entered} of 3 so far)</>}
            {revTarget ? <> · {next?.label} target <strong>{dollars(revTarget * 100)}</strong>{rev.avgCents !== null ? (rev.avgCents >= revTarget * 100 ? <span className="sc-flag is-ok">Met</span> : <span className="sc-flag is-bad">{dollars(revTarget * 100 - rev.avgCents)} to go</span>) : null}</> : null}
          </p>
        </div>

        <div className="sc-miles">
          {MILESTONES.map((m) => {
            const saved = entry("milestone", m.key);
            const done = Array.isArray(saved?.data.done) ? (saved!.data.done as string[]) : [];
            const state = m.key === next?.key ? "next" : m.key === current.key ? "current" : m.date < today ? "past" : "later";
            return (
              <form key={m.key} action={saveMilestone} className={`adm-card sc-mile sc-mile--${state}`}>
                <input type="hidden" name="milestone" value={m.key} />
                <div className="sc-mile__top"><span className="kicker">{m.label}</span><span className="sc-dot">{state === "next" ? `Next · ${daysBetween(today, m.date)} days` : state === "current" ? "Now" : state === "past" ? "Passed" : "Later"}</span></div>
                <h3 className="sc-mile__theme">{m.theme}</h3>
                <dl className="sc-mile__kv">
                  <div><dt>Review</dt><dd>{fmtDay(m.date)}, {m.date.slice(0, 4)}</dd></div>
                  {m.revenue ? <div><dt>Revenue goal</dt><dd>{`${dollars(m.revenue * 100)} a month`}</dd></div> : null}
                </dl>
                <ul className="sc-checks sc-checks--tight">
                  {m.goals.map((g, i) => <li key={i}><label className="sc-check"><input type="checkbox" name="goal" value={String(i)} defaultChecked={done.includes(String(i))} /><span>{g}</span></label></li>)}
                </ul>
                <div className="field"><label htmlFor={`sc-mn-${m.key}`}>Evidence and notes</label><textarea id={`sc-mn-${m.key}`} name="note" defaultValue={typeof saved?.data.note === "string" ? saved.data.note : ""} /></div>
                <div className="sc-mile__foot"><button type="submit" className="adm-chip">Save</button><span className="muted adm-mono">{done.length} of {m.goals.length}{saved ? ` · ${who(saved.updatedBy)}` : ""}</span></div>
              </form>
            );
          })}
        </div>
        <p className="muted sc-fine">Goals to review at each milestone, with the evidence written down. Pay is never kept in the studio.</p>
      </div>

      {/* ---- Check-ins ---- */}
      <div className="adm-section" id="checkins">
        <SectionHead title="Monthly check-ins" />
        <Note at="checkins" sp={sp} />
        <div className="sc-split">
          <form action={saveCheckin} className="adm-card adm-card--lg sc-form">
            <div className="field"><label htmlFor="sc-cm">Month</label><input id="sc-cm" type="month" name="month" defaultValue={thisMonth} max={thisMonth} min={monthOf(P.start)} /></div>
            <div className="field"><label htmlFor="sc-cn">Scorecard, exceptions, training and client follow-through</label><textarea id="sc-cn" name="notes" defaultValue={typeof entry("checkin", thisMonth)?.data.notes === "string" ? String(entry("checkin", thisMonth)!.data.notes) : ""} /></div>
            <div className="field"><label htmlFor="sc-cd">Decisions, support owner and next steps</label><textarea id="sc-cd" name="decisions" defaultValue={typeof entry("checkin", thisMonth)?.data.decisions === "string" ? String(entry("checkin", thisMonth)!.data.decisions) : ""} /></div>
            <button type="submit" className="btn btn-primary">Save check-in</button>
          </form>
          <div className="adm-card">
            <div className="kicker">Past check-ins</div>
            {checkins.length === 0 ? <p className="muted sc-empty">None yet. The first one is due at the end of {fmtMonth(addMonths(monthOf(P.start), 1))}.</p> : (
              <ul className="sc-checkins">
                {checkins.map((c) => (
                  <li key={c.key}>
                    <div className="sc-checkins__head"><strong>{fmtMonth(c.key)}</strong><span className="muted adm-mono">{who(c.updatedBy)}</span></div>
                    {typeof c.data.notes === "string" && c.data.notes && <p>{c.data.notes}</p>}
                    {typeof c.data.decisions === "string" && c.data.decisions && <p className="muted">{c.data.decisions}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
