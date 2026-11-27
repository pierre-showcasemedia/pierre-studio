// The booking calendar (step three, Oct 2026). Every live booking is one event
// on hello@example.com's own calendar (the business MAIN, which the owner's
// personal calendar already shows), written by the calendar.upsert and
// calendar.cancel jobs through the Google service account with domain-wide
// delegation (scope calendar.events, impersonating hello@). The website's
// booking form reads the same calendar for open times, so a booked slot is
// taken the moment its event lands.
//
// One invite path (Oct 20 2026): nobody is invited when the form is
// filled out, because the shooter is not known yet. When an admin enters a
// shooter on the booking, the shooter becomes the event's one guest and
// Google emails them the invite; moving the time updates it, clearing or
// replacing the shooter takes them off, canceling deletes the event and
// Google sends the cancel. While this sync is on, Studio's own .ics invite
// email (src/lib/shooter-invite.ts) stays off, so a shooter never gets two.
//
// Production only: previews share the database and the service account key,
// and their test bookings must never land on the real calendar or block real
// open times. GOOGLE_CALENDAR_SYNC=on turns it on elsewhere, =off turns it off.
//
// The event id is derived from the booking id (business.calendarPrefix + the uuid's hex), so a
// retry, a second job or a restore always finds the same event. Shooter-visible
// text comes from shootDetails() (never an amount): since Oct 31 2026 a few
// short lines (the owner: "10 times less complicated"), the forecast on top and
// the team's own notes kept below them.
//
// Every shoot event can be navigated to from a phone (Nov 2026): `location`
// is the full street address (shootAddress(), src/lib/shoot-address.ts),
// which Google Calendar opens in Maps on a tap, and the first Studio line of
// the description is a Google Maps directions link. Both are rewritten on
// every upsert (a full PUT), so a moved or edited booking keeps them.
import { createSign } from "node:crypto";
import { and, eq, gt, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { isTimeConfirmed } from "./booking-status";
import { logActivity } from "./activity";
import { wallClockToUtc } from "./booking-time";
import { currentEnv, drainDeadline, enqueueJobs, NotConfiguredError, SkipJobError } from "./jobs-core";
import { BOOKING_LINK, inviteWhen, inviteWhenLabels, sections, shootDetails } from "./shooter-invite";
import { addDaysYmd, localYmd } from "./local-date";
import { WEATHER_BLOCK_RE, weatherForShoot, type BookingWeather } from "./weather";
import type { JobPayload } from "@/db/schema";
import { visitEventIdFor, visitKindLabel, visitWhenLabel } from "./booking-visits";
import { hubListingName, moneyFree, scrubMoney } from "./slack";
import { BUSINESS_TZ } from "@/lib/business";
import { brand } from "@/lib/brand";
import { business } from "./business";
import { siteUrl } from "./brand";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";
const TZ = BUSINESS_TZ;

export function calendarUser(): string {
  return (process.env.GOOGLE_CALENDAR_IMPERSONATE || business.supportEmail).trim().toLowerCase();
}

function calendarId(): string {
  return (process.env.GOOGLE_BOOKINGS_CALENDAR || "primary").trim();
}

function keys(): { email: string; key: string } | null {
  const email = (process.env.GOOGLE_SA_CLIENT_EMAIL || "").trim();
  const raw = (process.env.GOOGLE_SA_PRIVATE_KEY || "").trim();
  if (!email || !raw) return null;
  return { email, key: raw.includes("BEGIN") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8") };
}

// Whether bookings go on the hello@ calendar here (and so whether Google, not
// Studio's .ics email, invites the shooter).
export function hasCalendarSync(): boolean {
  const flag = (process.env.GOOGLE_CALENDAR_SYNC || "").trim().toLowerCase();
  if (flag === "off" || !keys()) return false;
  return currentEnv() === "production" || flag === "on";
}

export const eventIdFor = (bookingId: string) => `${business.calendarPrefix}${bookingId.replace(/-/g, "").toLowerCase()}`;

const cached = new Map<string, { token: string; until: number }>();

// An access token AS hello@ (domain-wide delegation) for one scope:
// calendar.events to write bookings, calendar.readonly for free/busy.
export async function googleToken(scope: string = SCOPE): Promise<string> {
  const hit = cached.get(scope);
  if (hit && hit.until > Date.now() + 60_000) return hit.token;
  const k = keys();
  if (!k) throw new NotConfiguredError("the booking calendar (GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY)");
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: k.email, sub: calendarUser(), scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(k.key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`Google refused the ${scope.split("/").pop()} token: ${j.error ?? r.status}${j.error_description ? ` (${j.error_description})` : ""}`);
  cached.set(scope, { token: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

export const hasGoogleKeys = () => Boolean(keys());

async function gcal(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await googleToken()}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const json = (r.status === 204 ? {} : await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, json };
}

const errMsg = (j: Record<string, unknown>) => {
  const e = j.error as { message?: string } | undefined;
  return e?.message ?? "no detail";
};

type BookingRow = Parameters<typeof shootDetails>[0];

async function loadBooking(bookingId: string): Promise<BookingRow> {
  const b = (await db().query.bookings.findFirst({
    where: eq(schema.bookings.id, bookingId),
    with: { listing: { columns: { address: true, nda: true, city: true, state: true, zip: true } }, client: { columns: { name: true, email: true, phone: true, company: true } } },
  })) as BookingRow | undefined;
  if (!b) throw new SkipJobError("the booking is gone");
  return b;
}

// What the calendar event says, from the booking row. Pure, so it can be
// checked without Google or a database.
export function calendarEventBody(b: BookingRow, when: NonNullable<ReturnType<typeof inviteWhen>>) {
  const s = shootDetails(b);
  const tentative = !isTimeConfirmed(b.status);
  const shooter = (b.photographerEmail ?? "").trim().toLowerCase();
  const timeOf = (d: Date) => ({ dateTime: d.toISOString(), timeZone: TZ });
  const nextDay = (ymd: string) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  // The client moved it from the portal and nobody has reconfirmed yet (the owner,
  // Oct 20 2026): the title says so up front; Confirm time or the status
  // Confirmed clears client_rescheduled_at and the next upsert drops it.
  const moved = Boolean(b.clientRescheduledAt);
  const movedLine = moved ? `Rescheduled by the client${b.clientRescheduledFrom ? ` (was ${b.clientRescheduledFrom})` : ""}. Confirm the new time on the booking page.` : "";
  return {
    summary: `${moved ? "[RESCHEDULED - UNCONFIRMED] " : ""}${s.title(tentative)}`,
    // The directions link first (the forecast goes above it, see withBlock), then the move notice and Studio's lines.
    description: sections(s.directions, movedLine, s.describe(tentative)),
    location: s.address || undefined,
    start: when.allDay ? { date: when.date } : timeOf(when.start),
    end: when.allDay ? { date: nextDay(when.date) } : timeOf(when.end),
    status: tentative ? "tentative" : "confirmed",
    transparency: "opaque", // busy: the booking form treats this time as taken
    attendees: shooter ? [{ email: shooter }] : [],
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    source: { title: `${brand.name} booking`, url: s.adminUrl },
    extendedProperties: { private: { studioBookingId: b.id } },
  };
}

// calendar.upsert: put the booking's latest state on the calendar. A job that
// a newer version superseded does nothing (the newer job carries the change).
type CalendarJob = { id: string; bookingId: string | null; createdAt: Date };

// A newer calendar job for the same booking carries every later change, so
// an older one does nothing. (Not every version bump queues a calendar job,
// so the check is "is there a newer job", never "is my version the latest".)
async function supersededBy(job: CalendarJob): Promise<boolean> {
  const newer = await db().query.jobs.findFirst({
    where: and(
      eq(schema.jobs.env, currentEnv()),
      eq(schema.jobs.bookingId, job.bookingId!),
      inArray(schema.jobs.kind, ["calendar.upsert", "calendar.cancel"]),
      ne(schema.jobs.id, job.id),
      ne(schema.jobs.status, "dead"),
      gt(schema.jobs.createdAt, job.createdAt)
    ),
    columns: { id: true },
  });
  return Boolean(newer);
}

export async function upsertBookingEvent(job: CalendarJob): Promise<{ eventId: string; action: "created" | "updated" }> {
  if (!hasCalendarSync()) throw new NotConfiguredError("the booking calendar sync (production only, or GOOGLE_CALENDAR_SYNC=on)");
  if (!job.bookingId) throw new SkipJobError("the job names no booking");
  if (await supersededBy(job)) throw new SkipJobError("a newer calendar job for this booking covers it");
  const b = await loadBooking(job.bookingId);
  if (b.status === "canceled") throw new SkipJobError("the booking is canceled");
  const when = inviteWhen(b);
  if (!when) throw new SkipJobError("the booking has no date yet");
  const end = when.allDay ? new Date(`${when.date}T23:59:59-08:00`) : when.end;
  if (end.getTime() < Date.now() - 864e5 && !b.calendarEventId) throw new SkipJobError("the shoot date has passed and it was never on the calendar");

  const id = eventIdFor(b.id);
  const cal = encodeURIComponent(calendarId());
  const body = calendarEventBody(b, when);
  const got = await gcal("GET", `/calendars/${cal}/events/${id}`);
  if (got.status >= 300 && got.status !== 404 && got.status !== 410) throw new Error(`Google calendar read failed (${got.status}): ${errMsg(got.json)}`);
  const exists = got.status < 300;
  // Kept across Studio's updates: the team's own notes on the event (keptNotes).
  let notes = exists && typeof got.json.description === "string" ? keptNotes(got.json.description) : "";
  // One event per booking: fold in a hand-made event for the same shoot (see legacyMatches).
  const day = when.allDay ? when.date : localDay(when.start);
  const address = b.listing?.address ?? "";
  const matches = address ? await legacyMatches(address, day) : [];
  let adopted: CalendarEvent | null = null;
  if (matches.length === 1) {
    adopted = matches[0];
    const carried = carriedNotes(adopted);
    if (carried && !notes.includes(carried)) notes = notes ? `${carried}\n\n${notes}` : carried;
  } else if (matches.length > 1) {
    await enqueueJobs([{ kind: "slack.issue", idempotencyKey: `slack.issue:calendar-legacy:${b.id}:${day}`, bookingId: b.id, listingId: b.listingId, payload: { channel: "bookings", note: `${matches.length} hand-made calendar events also name ${address.split(",")[0]} on ${day}. The booking has its own event; delete the extra ones by hand. ${adminBookingUrl(b.id)}` } }]);
  }
  body.description = withNotes(body.description, notes);
  // The forecast (src/lib/weather.ts) stays on through Studio's own updates
  // while the shoot keeps its day, and so does a color someone picked by hand;
  // the calendar.weather job queued below brings the forecast up to date.
  const prevEvent = exists ? (got.json as CalendarEvent) : null;
  const finalBody = withWeather(body, prevEvent ? weatherOn(prevEvent, day) : null, prevEvent ? handColor(prevEvent) : null);
  // sendUpdates=all: Google emails the shooter (the one guest) the invite,
  // the new time, or the removal. With no guest nobody is emailed. A deleted
  // (canceled) event comes back to life with the PUT.
  let action: "created" | "updated";
  if (!exists) {
    const made = await gcal("POST", `/calendars/${cal}/events?sendUpdates=all`, { id, ...finalBody });
    if (made.status === 409) {
      const put = await gcal("PUT", `/calendars/${cal}/events/${id}?sendUpdates=all`, finalBody);
      if (put.status >= 300) throw new Error(`Google would not update the event (${put.status}): ${errMsg(put.json)}`);
    } else if (made.status >= 300) throw new Error(`Google would not create the event (${made.status}): ${errMsg(made.json)}`);
    action = "created";
  } else {
    const put = await gcal("PUT", `/calendars/${cal}/events/${id}?sendUpdates=all`, finalBody);
    if (put.status >= 300) throw new Error(`Google would not update the event (${put.status}): ${errMsg(put.json)}`);
    action = "updated";
  }
  if (adopted) {
    // The booking's own event carries everything now; the hand-made copy goes, quietly (no guest emails).
    const del = await gcal("DELETE", `/calendars/${cal}/events/${encodeURIComponent(adopted.id)}?sendUpdates=none`);
    if (del.status >= 300 && del.status !== 404 && del.status !== 410) throw new Error(`Google would not delete the hand-made event (${del.status}): ${errMsg(del.json)}`);
    await logActivity({ action: "calendar.event_merged", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, removed: adopted.id, title: adopted.summary ?? null, start: adopted.start?.dateTime ?? adopted.start?.date ?? null } });
  }
  await db().update(schema.bookings).set({ calendarEventId: id, calendarSyncedAt: new Date() }).where(eq(schema.bookings.id, b.id));
  if (inForecastRange(shootWindow(when))) {
    await enqueueJobs([{ kind: "calendar.weather", idempotencyKey: `calendar.weather:${currentEnv()}:${b.id}:after:${job.id}`, bookingId: b.id, listingId: b.listingId, payload: { version: 1 } }]);
  }
  return { eventId: id, action };
}

// calendar.cancel: the booking is off, so is the event (Google tells the
// shooter). An event that is already gone is fine.
export async function cancelBookingEvent(job: CalendarJob): Promise<{ eventId: string; deleted: boolean }> {
  if (!hasCalendarSync()) throw new NotConfiguredError("the booking calendar sync (production only, or GOOGLE_CALENDAR_SYNC=on)");
  if (!job.bookingId) throw new SkipJobError("the job names no booking");
  if (await supersededBy(job)) throw new SkipJobError("a newer calendar job for this booking covers it");
  const b = await loadBooking(job.bookingId);
  if (b.status !== "canceled") throw new SkipJobError("the booking is live again");
  const id = eventIdFor(b.id);
  const r = await gcal("DELETE", `/calendars/${encodeURIComponent(calendarId())}/events/${id}?sendUpdates=all`);
  if (r.status >= 300 && r.status !== 404 && r.status !== 410) throw new Error(`Google would not delete the event (${r.status}): ${errMsg(r.json)}`);
  await db().update(schema.bookings).set({ calendarSyncedAt: new Date() }).where(eq(schema.bookings.id, b.id));
  return { eventId: id, deleted: r.status < 300 };
}

// ---- One event per booking: merging hand-made events (Oct 21 2026) ----------
// Before the sync shipped (Oct 20), shoots were put on the business MAIN by hand or by
// the old booking automations. When Studio first creates a booking's event and
// finds exactly one such unlinked event for the same street on the same day,
// it carries that event's notes over (lines with a dollar amount dropped: the
// shooter sees the event) and deletes it, so the booking is left with its one
// linked event. Two or more candidates are left alone and the team is told.

const DIRECTIONS = "(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// "7702 Example Birch Lane, Springfield" → a pattern for "7702 birch" that also allows a direction ("21 E Main").
export function streetPattern(address: string): RegExp | null {
  const words = norm(address.split(",")[0]).split(" ");
  const num = words[0];
  if (!/^\d+[a-z]?$/.test(num)) return null;
  const rest = words.slice(1).filter((w) => !new RegExp(`^${DIRECTIONS}$`).test(w));
  if (!rest.length) return null;
  return new RegExp(`\\b${num}\\s+(?:${DIRECTIONS}\\s+)?${rest[0]}\\b`);
}

export type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; organizer?: boolean; self?: boolean; resource?: boolean }[];
  extendedProperties?: { private?: Record<string, string> };
  colorId?: string;
  etag?: string;
};

// Studio's own events: a booking's (prefix + hex) and, since Oct 27 2026, an
// additional shoot's (prefix + "v" + hex, studioVisitId). Neither is ever hand-made.
const isStudioEvent = (e: CalendarEvent) => e.id.startsWith(business.calendarPrefix) || Boolean(e.extendedProperties?.private?.studioBookingId || e.extendedProperties?.private?.studioVisitId);

// Unlinked events on the booking's local day whose title or location names its street.
export async function legacyMatches(address: string, day: string): Promise<CalendarEvent[]> {
  const pat = streetPattern(address);
  if (!pat || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const from = wallClockToUtc(day, "00:00");
  if (!from) return [];
  const to = new Date(from.getTime() + 864e5);
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", maxResults: "250" });
  const r = await gcal("GET", `/calendars/${encodeURIComponent(calendarId())}/events?${q}`);
  if (r.status >= 300) throw new Error(`Google calendar read failed (${r.status}): ${errMsg(r.json)}`);
  return ((r.json.items ?? []) as CalendarEvent[]).filter((e) => e.status !== "cancelled" && !isStudioEvent(e) && pat.test(norm(`${e.summary ?? ""} ${e.location ?? ""}`)));
}

// ---- The team's notes on an event (Oct 31 2026) --------------------------------
// Studio writes its own lines and the link to the booking (shootDetails());
// the rest of an event is the team's: notes carried from a merged hand-made
// event, and anything typed between Studio's lines and the link or after the
// link. Those stay across Studio's updates, under a "Notes:" line just above
// the link. What never comes back (the owner: each booking "should NOT say
// EVERYTHING about the client"): the client file blocks (Studio's own until
// Oct 31 and the business brain automation's, tools/client_brief.py), the old
// booking automation's copy of the form (Studio's lines say it now), and any
// line with an amount. The booking page still shows the whole client file.
//
// A client file block runs from "CLIENT NOTES:" to "Full note: the business brain,
// Clients/...". The team typed shoot notes inside it (the brain's docs said
// to, so Studio would keep them: "CALL NOTES (the coordinator with a client, ...):" and
// its bullets), so the block is read line by line: the generators' own
// headings, lines and bullets go, anything else stays.
const NOTES_HEAD = "Notes:";
const OLD_CARRIED = "NOTES FROM THE EARLIER CALENDAR EVENT:";
const STUDIO_LINK = /^(?:Admin|Booking): https?:\/\/\S+\/admin\/bookings\/[0-9a-f-]{36}$/;
const FILE_LIST = /^(?:BEFORE EVERY SHOOT|BEFORE THIS SHOOT|ACCESS AND ON SITE):$/;
const FILE_LINE = /^(?:(?:PEOPLE|USUALLY BOOKS|ACCESS|RECENT|UPCOMING|OPEN|TEAM NOTES|WE'VE SHOT THIS PROPERTY BEFORE):|\d+ listings? with us since\b)/;
const FORM_LINE = /^(?:(?:CLIENT|PHONE|EMAIL|SERVICES|ADD-ONS|ADDITIONAL|LAUNCH DATE|CUSTOM REQUEST|SQFT):|NOTE: Texts\b|Auto-created from booking form)/i;

// The client file blocks out, the team's own lines in them kept.
function withoutClientFile(lines: string[]): string[] {
  const out: string[] = [];
  let inFile = false;
  let ours = false; // inside the block: under a heading the team wrote
  let subLine = false; // the line after "CLIENT NOTES:" (brokerage · tier · who runs it)
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith("CLIENT NOTES:")) {
      inFile = true;
      ours = false;
      subLine = true;
      continue;
    }
    if (!inFile) {
      out.push(raw);
      continue;
    }
    const wasSub = subLine;
    subLine = false;
    if (/^Full note: (?:[\w ]+ )?brain, Clients\//.test(l)) {
      inFile = false;
      continue;
    }
    if (FILE_LIST.test(l) || FILE_LINE.test(l)) {
      ours = false;
      continue;
    }
    if (/^[-*] /.test(l)) {
      if (ours) out.push(raw);
      continue;
    }
    if (!l) {
      out.push(raw);
      continue;
    }
    if (wasSub && !l.endsWith(":")) continue;
    ours = true; // a heading or a line the team typed
    out.push(raw);
  }
  return out;
}

export function cleanNotes(text: string): string {
  return withoutClientFile(text.replace(/\r/g, "").split("\n"))
    .map((l) => {
      const access = /^SQFT:[^·]*·\s*ACCESS:\s*(.+)$/i.exec(l.trim());
      return access ? `Access: ${access[1]}` : l;
    })
    .filter((l) => l.trim() !== OLD_CARRIED && l.trim() !== NOTES_HEAD && !/\$\s?\d/.test(l) && !FORM_LINE.test(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The team's notes on one of Studio's events (its description as Google has it).
export function keptNotes(description: string): string {
  const lines = asText(description.replace(WEATHER_BLOCK_RE, "")).split("\n");
  const link = lines.findLastIndex((l) => STUDIO_LINK.test(l.trim()));
  if (link < 0) {
    // Not Studio's layout any more (rewritten by hand): what the old markers kept.
    const t = lines.join("\n");
    const marks = [t.indexOf(OLD_CARRIED), t.indexOf("CLIENT NOTES:")].filter((i) => i >= 0);
    return marks.length ? cleanNotes(t.slice(Math.min(...marks))) : "";
  }
  const head = lines.findIndex((l) => l.trim() === NOTES_HEAD);
  return cleanNotes([...(head >= 0 && head < link ? lines.slice(head + 1, link) : []), ...lines.slice(link + 1)].join("\n"));
}

// Studio's description with the team's notes above the link to the booking.
export function withNotes(description: string, notes: string): string {
  if (!notes) return description;
  const at = description.lastIndexOf(`\n\n${BOOKING_LINK}`);
  const block = `${NOTES_HEAD}\n${notes}`;
  return at < 0 ? `${description}\n\n${block}` : `${description.slice(0, at)}\n\n${block}${description.slice(at)}`;
}

// A hand-made event's own notes, the same way (its forecast left behind).
export function carriedNotes(e: CalendarEvent): string {
  return cleanNotes(asText((e.description ?? "").replace(WEATHER_BLOCK_RE, "")));
}

const localDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const localHm = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

// ---- Weather on the event (Oct 26 2026) ---------------------------------------
// src/lib/weather.ts builds it; this writes it. The badge goes in front of the
// title (after "[RESCHEDULED - UNCONFIRMED] " when that is there), the block at
// the top of the description, and Google's colorId 11 (Tomato) or 5 (Banana)
// when the forecast says rain or a rain chance / heavy overcast. The event's
// private properties remember what Studio wrote (studioWeatherDay, Badge,
// Color), so the next refresh replaces exactly that and never a hand-picked
// color. Writes go out with sendUpdates=none: the shooter's copy follows
// without an "updated invitation" email every three hours.

const RESCHEDULED_TAG = "[RESCHEDULED - UNCONFIRMED] ";
export const WEATHER_EVERY_MS = 3 * 3600_000;

type Shoot = { day: string; start: Date; end: Date };

// The hours the forecast is read for: the booked time, or 8 AM to 6 PM for a day with no time yet.
function shootWindow(when: NonNullable<ReturnType<typeof inviteWhen>>): Shoot {
  if (!when.allDay) return { day: localDay(when.start), start: when.start, end: when.end };
  const start = wallClockToUtc(when.date, "08:00") ?? new Date(`${when.date}T15:00:00Z`);
  const end = wallClockToUtc(when.date, "18:00") ?? new Date(`${when.date}T01:00:00Z`);
  return { day: when.date, start, end };
}

// The weather service's hourly forecast runs about 6.5 days out.
const inForecastRange = (s: Shoot, now = Date.now()) => s.end.getTime() > now && s.start.getTime() < now + 7 * 864e5;

export function withBadge(summary: string, badge: string | null, oldBadge?: string | null): string {
  let base = summary;
  if (oldBadge && base.includes(`${oldBadge} `)) base = base.replace(`${oldBadge} `, "");
  if (!badge) return base;
  return base.startsWith(RESCHEDULED_TAG) ? `${RESCHEDULED_TAG}${badge} ${base.slice(RESCHEDULED_TAG.length)}` : `${badge} ${base}`;
}

const HTML_TAG = /<(br|p|div|b|strong|i|em|u|ul|ol|li|a|span)\b/i;

// The description as HTML: Google Calendar renders a description with any tag
// in it as HTML, where a plain newline is not a line break, so every newline
// becomes <br> (and plain text is escaped first, and its links, such as the
// directions and booking links, made <a> tags so they stay tappable; asText
// reads them back as the bare URL).
export function asHtml(text: string): string {
  const body = HTML_TAG.test(text) ? text : linkify(text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  return body.replace(/\r?\n/g, "<br>");
}

// Bare http(s) URLs in already-escaped text as links (a trailing . , ; : ) or ! stays outside).
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<>"]+/g, (m) => {
    const url = m.replace(/[.,;:!)]+$/, "");
    return `<a href="${url.replace(/"/g, "&quot;")}">${url}</a>${m.slice(url.length)}`;
  });
}

// And back, for code that reads the description line by line.
export function asText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// The weather block (HTML) on top of the description, replacing any earlier
// one; the rest of the description follows as HTML. Null takes the block off.
export function withBlock(description: string, block: string | null): string {
  const rest = description.replace(WEATHER_BLOCK_RE, "").replace(/^(?:\s|<br\s*\/?>)+/, "");
  // Plain text stays plain; anything with a tag in it (a hand edit, or a tail
  // kept from an earlier HTML description) is made all HTML so no line runs on.
  if (!block) return HTML_TAG.test(rest) ? asHtml(rest) : rest;
  return rest ? `${block}<br><br>${asHtml(rest)}` : block;
}

// The weather Studio last wrote on this event, if it is still for `day`.
export function weatherOn(e: CalendarEvent, day: string): BookingWeather | null {
  const p = e.extendedProperties?.private ?? {};
  if (p.studioWeatherDay !== day || !p.studioWeatherBadge) return null;
  const m = (e.description ?? "").match(WEATHER_BLOCK_RE);
  // The first plain text format is not carried; the refresh queued after the upsert replaces it.
  if (!m || !m[0].includes("<")) return null;
  const block = m[0].replace(/(?:\s|<br\s*\/?>)+$/, "");
  return { day, badge: p.studioWeatherBadge, color: p.studioWeatherColor === "11" || p.studioWeatherColor === "5" ? p.studioWeatherColor : null, block };
}

// A color on the event that Studio's weather did not put there.
export function handColor(e: CalendarEvent): string | null {
  const ours = e.extendedProperties?.private?.studioWeatherColor || null;
  return e.colorId && e.colorId !== ours ? e.colorId : null;
}

// The upsert body with the carried weather and color on it.
function withWeather<T extends { summary: string; description: string; extendedProperties: { private: Record<string, string> } }>(body: T, wx: BookingWeather | null, keepColor: string | null): T & { colorId?: string } {
  const color = keepColor ?? wx?.color ?? null;
  return {
    ...body,
    summary: withBadge(body.summary, wx?.badge ?? null),
    description: withBlock(body.description, wx?.block ?? null),
    ...(color ? { colorId: color } : {}),
    extendedProperties: {
      private: {
        ...body.extendedProperties.private,
        ...(wx ? { studioWeatherDay: wx.day, studioWeatherBadge: wx.badge } : {}),
        ...(!keepColor && wx?.color ? { studioWeatherColor: wx.color } : {}),
      },
    },
  };
}

// calendar.weather: the latest forecast onto one booking's event. Every
// failure is a skip (no retry, no hub alert): the next refresh is at most
// three hours away and a forecast is never worth paging anyone.
export async function refreshBookingWeather(job: CalendarJob): Promise<{ eventId: string; badge: string; color: string | null }> {
  if (!hasCalendarSync()) throw new SkipJobError("the booking calendar sync is off here");
  if (!job.bookingId) throw new SkipJobError("the job names no booking");
  const b = await loadBooking(job.bookingId);
  if (b.status === "canceled") throw new SkipJobError("the booking is canceled");
  const when = inviteWhen(b);
  if (!when) throw new SkipJobError("the booking has no date yet");
  const shoot = shootWindow(when);
  if (!inForecastRange(shoot)) throw new SkipJobError("the shoot is over or more than a week out");
  const address = b.listing?.address ?? "";
  if (!address) throw new SkipJobError("the booking has no address");
  let wx: BookingWeather | null;
  try {
    wx = await weatherForShoot(address, shoot);
  } catch (e) {
    throw new SkipJobError(`no forecast this time: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!wx) throw new SkipJobError("the forecast does not reach this shoot yet, or the address did not geocode");

  const id = eventIdFor(b.id);
  const got = await gcal("GET", `/calendars/${encodeURIComponent(calendarId())}/events/${id}`);
  if (got.status === 404 || got.status === 410) throw new SkipJobError("the booking has no calendar event yet");
  if (got.status >= 300) throw new SkipJobError(`Google calendar read failed (${got.status}): ${errMsg(got.json)}`);
  const e = got.json as CalendarEvent;
  if (e.status === "cancelled") throw new SkipJobError("the event was deleted in Google");
  const wrote = await writeWeather(e, wx);
  if (wrote !== "ok") throw new SkipJobError(wrote);
  // Studio's own write: the calendar pull must not read it back as an edit.
  await db().update(schema.bookings).set({ calendarSyncedAt: new Date() }).where(eq(schema.bookings.id, b.id));
  return { eventId: id, badge: wx.badge, color: wx.color };
}

// The forecast onto one event: badge, block, color, and what Studio wrote in
// the private properties. "ok", or why it did not land.
async function writeWeather(e: CalendarEvent, wx: BookingWeather): Promise<string> {
  const p = e.extendedProperties?.private ?? {};
  const theirs = handColor(e);
  const ours = p.studioWeatherColor || null;
  const patch: Record<string, unknown> = {
    summary: withBadge(e.summary ?? "", wx.badge, p.studioWeatherBadge),
    description: withBlock(e.description ?? "", wx.block),
    extendedProperties: { private: { studioWeatherDay: wx.day, studioWeatherBadge: wx.badge, studioWeatherColor: theirs ? "" : (wx.color ?? "") } },
  };
  // Studio's own color follows the forecast (null clears it); a hand-picked one stays.
  if (!theirs && (wx.color || ours)) patch.colorId = wx.color;
  // If-Match: an upsert or a hand edit that lands between the read and this
  // write wins (the next refresh has it), so an older description never comes back.
  const put = await gcal("PATCH", `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(e.id)}?sendUpdates=none`, patch, e.etag ? { "if-match": e.etag } : {});
  if (put.status === 412) return "the event changed while the forecast loaded; the next refresh has it";
  if (put.status >= 300) return `Google would not take the forecast (${put.status}): ${errMsg(put.json)}`;
  return "ok";
}

// A hand-made shoot: an event on the business MAIN that is not a Studio booking but
// has a street address for its location (holds and blocked-off time have none).
const isHandMadeShoot = (e: CalendarEvent) => e.status !== "cancelled" && !isStudioEvent(e) && /^\s*\d+[a-z]?\s+\S/i.test(e.location ?? "");

// calendar.weather with no booking: the same forecast on the hand-made shoot
// events of the coming week (shoots booked before Studio, Oct 2026). One job
// per three-hour slot; stops before the drain's deadline.
export async function refreshHandMadeWeather(now: Date = new Date()): Promise<{ done: string[]; skipped: { id: string; why: string }[] }> {
  if (!hasCalendarSync()) throw new SkipJobError("the booking calendar sync is off here");
  const q = new URLSearchParams({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 7 * 864e5).toISOString(), singleEvents: "true", maxResults: "250" });
  const r = await gcal("GET", `/calendars/${encodeURIComponent(calendarId())}/events?${q}`);
  if (r.status >= 300) throw new SkipJobError(`Google calendar read failed (${r.status}): ${errMsg(r.json)}`);
  const out = { done: [] as string[], skipped: [] as { id: string; why: string }[] };
  for (const e of ((r.json.items ?? []) as CalendarEvent[]).filter(isHandMadeShoot)) {
    if (Date.now() > drainDeadline() - 10_000) {
      out.skipped.push({ id: e.id, why: "out of time this tick" });
      continue;
    }
    const start = e.start?.dateTime ? new Date(e.start.dateTime) : null;
    const end = e.end?.dateTime ? new Date(e.end.dateTime) : null;
    const when = start && end ? ({ allDay: false, start, end } as const) : e.start?.date ? ({ allDay: true, date: e.start.date } as const) : null;
    if (!when) continue;
    const shoot = shootWindow(when);
    if (!inForecastRange(shoot)) continue;
    try {
      const wx = await weatherForShoot(e.location!.trim(), shoot);
      if (!wx) {
        out.skipped.push({ id: e.id, why: "no forecast or address not found" });
        continue;
      }
      const wrote = await writeWeather(e, wx);
      if (wrote === "ok") out.done.push(e.id);
      else out.skipped.push({ id: e.id, why: wrote });
    } catch (err) {
      out.skipped.push({ id: e.id, why: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

// Run by the minute cron: one calendar.weather job per upcoming booking (on
// the calendar, today to six days out) per three-hour slot, plus one for the
// hand-made shoot events. The idempotency key makes every other tick in the
// slot a no-op.
// `now: true` (the admin-api op weatherRefresh) queues a fresh round at once
// instead of waiting for the next slot.
export async function scheduleWeatherRefresh(now: Date = new Date(), opts: { now?: boolean } = {}): Promise<number> {
  if (!hasCalendarSync()) return 0;
  const today = localYmd(now);
  const rows = await db()
    .select({ id: schema.bookings.id, listingId: schema.bookings.listingId })
    .from(schema.bookings)
    .where(and(
      eq(schema.bookings.env, currentEnv()),
      inArray(schema.bookings.status, ["requested", "confirmed"]),
      isNotNull(schema.bookings.calendarEventId),
      gte(schema.bookings.desiredDate, today),
      lte(schema.bookings.desiredDate, addDaysYmd(today, 6)),
    ));
  const slot = opts.now ? `now${now.getTime()}` : String(Math.floor(now.getTime() / WEATHER_EVERY_MS));
  // Additional shoots on the calendar in the same window (Oct 27 2026). Read
  // apart, so a database the migrate route has not reached yet changes nothing.
  let visits: { id: string; bookingId: string; listingId: string }[] = [];
  try {
    visits = await db()
      .select({ id: schema.bookingVisits.id, bookingId: schema.bookingVisits.bookingId, listingId: schema.bookingVisits.listingId })
      .from(schema.bookingVisits)
      .where(and(
        eq(schema.bookingVisits.env, currentEnv()),
        eq(schema.bookingVisits.status, "scheduled"),
        isNotNull(schema.bookingVisits.calendarEventId),
        gte(schema.bookingVisits.desiredDate, today),
        lte(schema.bookingVisits.desiredDate, addDaysYmd(today, 6)),
      ));
  } catch (e) {
    console.error("[calendar] visit weather list", e instanceof Error ? e.message : e);
  }
  return enqueueJobs([
    ...visits.map((v) => ({
      kind: "calendar.weather" as const,
      idempotencyKey: `calendar.weather:${currentEnv()}:visit:${v.id}:${slot}`,
      bookingId: v.bookingId,
      listingId: v.listingId,
      payload: { version: 1, visitId: v.id },
    })),
    ...rows.map((r) => ({
      kind: "calendar.weather" as const,
      idempotencyKey: `calendar.weather:${currentEnv()}:${r.id}:${slot}`,
      bookingId: r.id,
      listingId: r.listingId,
      payload: { version: 1 },
    })),
    // The hand-made shoot events (refreshHandMadeWeather): one job, no booking.
    { kind: "calendar.weather" as const, idempotencyKey: `calendar.weather:${currentEnv()}:hand-made:${slot}`, payload: { version: 1 } },
  ]);
}

// ---- Google back to Studio (Oct 21 2026) ------------------------------------
// The other direction, run by the minute cron. Studio events changed in the
// last 20 minutes by someone other than Studio (the event's "updated" is later
// than the booking's calendar_synced_at) are read back onto the booking:
//   - the time moved in Google: the booking's date, start and end follow
//   - the guest changed in Google: the shooter follows (first guest, or none)
//   - the event was deleted in Google: the booking is NOT canceled (that voids
//     the invoice); the team is told once, and the next Studio update puts
//     the event back unless the booking is canceled in the admin.
export type CalendarPullResult = { checked: number; moved: string[]; shooter: string[]; deleted: string[]; visits: { moved: string[]; shooter: string[]; deleted: string[] } };

export async function syncFromCalendar(opts: { sinceMinutes?: number } = {}): Promise<CalendarPullResult> {
  const out: CalendarPullResult = { checked: 0, moved: [], shooter: [], deleted: [], visits: { moved: [], shooter: [], deleted: [] } };
  if (!hasCalendarSync()) return out;
  const since = new Date(Date.now() - (opts.sinceMinutes ?? 20) * 60_000);
  const q = new URLSearchParams({ updatedMin: since.toISOString(), showDeleted: "true", singleEvents: "true", maxResults: "250" });
  const r = await gcal("GET", `/calendars/${encodeURIComponent(calendarId())}/events?${q}`);
  if (r.status >= 300) throw new Error(`Google calendar read failed (${r.status}): ${errMsg(r.json)}`);
  const events = ((r.json.items ?? []) as CalendarEvent[]).filter(isStudioEvent);
  for (const e of events) {
    // An additional shoot's event (Oct 27 2026) carries the booking's id too:
    // it moves the visit, never the booking.
    const visitId = e.extendedProperties?.private?.studioVisitId ?? visitIdFromEventId(e.id);
    if (visitId) {
      try {
        await pullVisit(e, visitId, out);
      } catch (err) {
        console.error("[calendar] visit pull", visitId, err instanceof Error ? err.message : err);
      }
      continue;
    }
    const bookingId = e.extendedProperties?.private?.studioBookingId;
    if (!bookingId) continue;
    const b = await db().query.bookings.findFirst({
      where: and(eq(schema.bookings.id, bookingId), eq(schema.bookings.env, currentEnv())),
      columns: { id: true, listingId: true, clientId: true, status: true, startsAt: true, endsAt: true, desiredDate: true, startTime: true, photographerEmail: true, calendarSyncedAt: true, calendarVersion: true },
    });
    if (!b || b.status === "canceled") continue;
    out.checked++;
    const updated = e.updated ? new Date(e.updated) : null;
    // Studio's own writes stamp calendar_synced_at right after Google answers, so they never come back as edits.
    if (!updated || (b.calendarSyncedAt && updated.getTime() <= b.calendarSyncedAt.getTime() + 2_000)) continue;
    const now = new Date();
    if (e.status === "cancelled") {
      await enqueueJobs([{ kind: "slack.issue", idempotencyKey: `slack.issue:calendar-deleted:${b.id}:${updated.getTime()}`, bookingId: b.id, listingId: b.listingId, payload: { channel: "bookings", note: `The calendar event for ${withBadge(e.summary ?? "a booking", null, e.extendedProperties?.private?.studioWeatherBadge).split(" - ")[0]} was deleted in Google Calendar. The booking is still live: cancel it in the admin, or it comes back on the next update. ${adminBookingUrl(b.id)}` } }]);
      await db().update(schema.bookings).set({ calendarSyncedAt: now }).where(eq(schema.bookings.id, b.id));
      out.deleted.push(b.id);
      continue;
    }
    const set: Partial<typeof schema.bookings.$inferInsert> = {};
    const start = e.start?.dateTime ? new Date(e.start.dateTime) : null;
    const end = e.end?.dateTime ? new Date(e.end.dateTime) : null;
    if (start && end && (!b.startsAt || Math.abs(start.getTime() - b.startsAt.getTime()) > 60_000 || !b.endsAt || Math.abs(end.getTime() - b.endsAt.getTime()) > 60_000)) {
      Object.assign(set, { startsAt: start, endsAt: end, desiredDate: localDay(start), startTime: localHm(start) });
      await logActivity({ action: "booking.calendar_moved", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, from: b.startsAt?.toISOString() ?? null, to: start.toISOString() } });
      out.moved.push(b.id);
    }
    const guest = (e.attendees ?? []).find((a) => !a.organizer && !a.self && !a.resource && a.email)?.email?.trim().toLowerCase() ?? null;
    const shooter = b.photographerEmail?.trim().toLowerCase() || null;
    if (guest !== shooter) {
      set.photographerEmail = guest;
      await logActivity({ action: "booking.calendar_shooter", listingId: b.listingId, clientId: b.clientId, meta: { bookingId: b.id, email: guest } });
      out.shooter.push(b.id);
    }
    await db().update(schema.bookings).set({ ...set, ...(Object.keys(set).length ? { updatedAt: now } : {}), calendarSyncedAt: now }).where(eq(schema.bookings.id, b.id));
  }
  return out;
}

function adminBookingUrl(id: string): string {
  return `${siteUrl()}/admin/bookings/${id}`;
}

// ---- Additional shoots (Oct 27 2026) -----------------------------------------
// A return trip, pickup shots, a reshoot or a twilight on a booking
// (booking_visits, src/lib/booking-visits.ts) is its own event on the business MAIN:
// id <prefix>v<visit hex>, private properties { studioBookingId, studioVisitId }, the
// visit's shooter as the one guest (Google emails the invite, the move and
// the removal: sendUpdates=all), busy (opaque) so the website form and the
// client's Reschedule see the time as taken. Title in the owner's format with the
// kind in place of the services ("7702 Example Birch Lane - Devin Wong / Return
// trip: kitchen pickups"); the description is the kind, the note, the main
// shoot's time, and the same shooter-visible details as the booking's event
// (shootDetails(), never an amount). Same rules as the booking's event: a
// newer job for the visit covers an older one, production only, and the
// forecast is carried and refreshed the same way.

type VisitRow = typeof schema.bookingVisits.$inferSelect;
type VisitJob = { id: string; bookingId: string | null; createdAt: Date; payload: JobPayload | null };

// prefix + "v" + 32 hex back to the visit's uuid (a deleted event in the pull may
// come back without its private properties).
export function visitIdFromEventId(id: string): string | null {
  const m = new RegExp(`^${business.calendarPrefix}v([0-9a-f]{32})$`).exec(id);
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function visitSupersededBy(job: VisitJob, visitId: string): Promise<boolean> {
  const newer = await db().query.jobs.findFirst({
    where: and(
      eq(schema.jobs.env, currentEnv()),
      inArray(schema.jobs.kind, ["calendar.visit_upsert", "calendar.visit_cancel"]),
      sql`${schema.jobs.payload}->>'visitId' = ${visitId}`,
      ne(schema.jobs.id, job.id),
      ne(schema.jobs.status, "dead"),
      gt(schema.jobs.createdAt, job.createdAt)
    ),
    columns: { id: true },
  });
  return Boolean(newer);
}

async function loadVisit(visitId: string): Promise<{ v: VisitRow; b: BookingRow }> {
  const v = await db().query.bookingVisits.findFirst({ where: eq(schema.bookingVisits.id, visitId) });
  if (!v) throw new SkipJobError("the additional shoot is gone");
  return { v, b: await loadBooking(v.bookingId) };
}

// What the visit's event says. Pure, like calendarEventBody.
export function visitEventBody(b: BookingRow, v: Pick<VisitRow, "id" | "kind" | "note" | "startsAt" | "endsAt" | "photographerEmail">) {
  const s = shootDetails(b);
  const label = visitKindLabel(v.kind);
  const note = scrubMoney((v.note ?? "").trim());
  const oneLine = note.replace(/\s+/g, " ");
  const short = oneLine.length > 48 ? `${oneLine.slice(0, 47).trimEnd()}…` : oneLine;
  // "<street> - <agent>" from the booking's own title, then the kind.
  const head = s.title(false).split(" / ")[0];
  const main = inviteWhen(b);
  const shooter = (v.photographerEmail ?? "").trim().toLowerCase();
  const timeOf = (d: Date) => ({ dateTime: d.toISOString(), timeZone: TZ });
  return {
    summary: moneyFree(`${head} / ${label}${short ? `: ${short}` : ""}`),
    description: moneyFree(
      sections(
        s.directions,
        `${label.toUpperCase()}: an additional shoot for this booking.`,
        note && `Note: ${note}`,
        `Main shoot: ${b.status === "canceled" ? "canceled" : main ? inviteWhenLabels(main).long : "date to be set"}`,
        s.describe(false)
      )
    ),
    location: s.address || undefined,
    start: timeOf(v.startsAt),
    end: timeOf(v.endsAt),
    status: "confirmed",
    transparency: "opaque", // busy: the booking form treats this time as taken
    attendees: shooter ? [{ email: shooter }] : [],
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    source: { title: `${brand.name} additional shoot`, url: s.adminUrl },
    extendedProperties: { private: { studioBookingId: b.id, studioVisitId: v.id } },
  };
}

// calendar.visit_upsert: the visit's latest state on the calendar.
export async function upsertVisitEvent(job: VisitJob): Promise<{ eventId: string; action: "created" | "updated" }> {
  if (!hasCalendarSync()) throw new NotConfiguredError("the booking calendar sync (production only, or GOOGLE_CALENDAR_SYNC=on)");
  const visitId = job.payload?.visitId;
  if (!visitId) throw new SkipJobError("the job names no additional shoot");
  if (await visitSupersededBy(job, visitId)) throw new SkipJobError("a newer calendar job for this additional shoot covers it");
  const { v, b } = await loadVisit(visitId);
  if (v.status !== "scheduled") throw new SkipJobError(`the additional shoot is ${v.status}`);
  if (b.status === "canceled") throw new SkipJobError("the booking is canceled");
  if (v.endsAt.getTime() < Date.now() - 864e5 && !v.calendarEventId) throw new SkipJobError("the date has passed and it was never on the calendar");

  const id = visitEventIdFor(v.id);
  const cal = encodeURIComponent(calendarId());
  const body = visitEventBody(b, v);
  const got = await gcal("GET", `/calendars/${cal}/events/${id}`);
  if (got.status >= 300 && got.status !== 404 && got.status !== 410) throw new Error(`Google calendar read failed (${got.status}): ${errMsg(got.json)}`);
  const exists = got.status < 300;
  const prevEvent = exists ? (got.json as CalendarEvent) : null;
  // The team's notes on the event stay across updates, as on the booking's event.
  body.description = withNotes(body.description, prevEvent && typeof prevEvent.description === "string" ? keptNotes(prevEvent.description) : "");
  // The forecast: the visit's own while it keeps its day, else the booking's
  // event's for the same day; the calendar.weather job queued below brings it
  // to the visit's own hours.
  let wx = prevEvent ? weatherOn(prevEvent, v.desiredDate) : null;
  if (!wx) {
    const mainEvent = await gcal("GET", `/calendars/${cal}/events/${eventIdFor(b.id)}`);
    if (mainEvent.status < 300 && (mainEvent.json as CalendarEvent).status !== "cancelled") wx = weatherOn(mainEvent.json as CalendarEvent, v.desiredDate);
  }
  const finalBody = withWeather(body, wx, prevEvent ? handColor(prevEvent) : null);
  let action: "created" | "updated";
  if (!exists) {
    const made = await gcal("POST", `/calendars/${cal}/events?sendUpdates=all`, { id, ...finalBody });
    if (made.status === 409) {
      const put = await gcal("PUT", `/calendars/${cal}/events/${id}?sendUpdates=all`, finalBody);
      if (put.status >= 300) throw new Error(`Google would not update the event (${put.status}): ${errMsg(put.json)}`);
    } else if (made.status >= 300) throw new Error(`Google would not create the event (${made.status}): ${errMsg(made.json)}`);
    action = "created";
  } else {
    const put = await gcal("PUT", `/calendars/${cal}/events/${id}?sendUpdates=all`, finalBody);
    if (put.status >= 300) throw new Error(`Google would not update the event (${put.status}): ${errMsg(put.json)}`);
    action = "updated";
  }
  await db().update(schema.bookingVisits).set({ calendarEventId: id, calendarSyncedAt: new Date() }).where(eq(schema.bookingVisits.id, v.id));
  if (inForecastRange({ day: v.desiredDate, start: v.startsAt, end: v.endsAt })) {
    await enqueueJobs([{ kind: "calendar.weather", idempotencyKey: `calendar.weather:${currentEnv()}:visit:${v.id}:after:${job.id}`, bookingId: b.id, listingId: b.listingId, payload: { version: 1, visitId: v.id } }]);
  }
  return { eventId: id, action };
}

// calendar.visit_cancel: the visit is off, so is its event (Google tells the
// shooter). An event that is already gone is fine.
export async function cancelVisitEvent(job: VisitJob): Promise<{ eventId: string; deleted: boolean }> {
  if (!hasCalendarSync()) throw new NotConfiguredError("the booking calendar sync (production only, or GOOGLE_CALENDAR_SYNC=on)");
  const visitId = job.payload?.visitId;
  if (!visitId) throw new SkipJobError("the job names no additional shoot");
  if (await visitSupersededBy(job, visitId)) throw new SkipJobError("a newer calendar job for this additional shoot covers it");
  const v = await db().query.bookingVisits.findFirst({ where: eq(schema.bookingVisits.id, visitId), columns: { id: true, status: true } });
  if (v && v.status !== "canceled") throw new SkipJobError(`the additional shoot is ${v.status} again`);
  const r = await deleteVisitEventNow(visitId);
  if (v) await db().update(schema.bookingVisits).set({ calendarSyncedAt: new Date() }).where(eq(schema.bookingVisits.id, visitId));
  return { eventId: visitEventIdFor(visitId), deleted: r === "deleted" };
}

// The event off the calendar right now (cancel, and admin-api deleteBooking,
// which removes the rows a queued job would need). sendUpdates=all.
export async function deleteVisitEventNow(visitId: string): Promise<"deleted" | "gone" | "off"> {
  if (!hasCalendarSync()) return "off";
  const r = await gcal("DELETE", `/calendars/${encodeURIComponent(calendarId())}/events/${visitEventIdFor(visitId)}?sendUpdates=all`);
  if (r.status >= 300 && r.status !== 404 && r.status !== 410) throw new Error(`Google would not delete the event (${r.status}): ${errMsg(r.json)}`);
  return r.status < 300 ? "deleted" : "gone";
}

// calendar.weather with payload.visitId: the forecast for the visit's own hours.
export async function refreshVisitWeather(visitId: string): Promise<{ eventId: string; badge: string; color: string | null }> {
  if (!hasCalendarSync()) throw new SkipJobError("the booking calendar sync is off here");
  const { v, b } = await loadVisit(visitId);
  if (v.status !== "scheduled") throw new SkipJobError(`the additional shoot is ${v.status}`);
  if (b.status === "canceled") throw new SkipJobError("the booking is canceled");
  const shoot = { day: v.desiredDate, start: v.startsAt, end: v.endsAt };
  if (!inForecastRange(shoot)) throw new SkipJobError("the shoot is over or more than a week out");
  const address = b.listing?.address ?? "";
  if (!address) throw new SkipJobError("the booking has no address");
  let wx: BookingWeather | null;
  try {
    wx = await weatherForShoot(address, shoot);
  } catch (e) {
    throw new SkipJobError(`no forecast this time: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!wx) throw new SkipJobError("the forecast does not reach this shoot yet, or the address did not geocode");
  const id = visitEventIdFor(v.id);
  const got = await gcal("GET", `/calendars/${encodeURIComponent(calendarId())}/events/${id}`);
  if (got.status === 404 || got.status === 410) throw new SkipJobError("the additional shoot has no calendar event yet");
  if (got.status >= 300) throw new SkipJobError(`Google calendar read failed (${got.status}): ${errMsg(got.json)}`);
  const e = got.json as CalendarEvent;
  if (e.status === "cancelled") throw new SkipJobError("the event was deleted in Google");
  const wrote = await writeWeather(e, wx);
  if (wrote !== "ok") throw new SkipJobError(wrote);
  await db().update(schema.bookingVisits).set({ calendarSyncedAt: new Date() }).where(eq(schema.bookingVisits.id, v.id));
  return { eventId: id, badge: wx.badge, color: wx.color };
}

// Google back to Studio for one visit's event: a move or a new guest made in
// Google lands on the visit row; a deleted event cancels nothing (the team is
// told once, and the next Studio update puts it back unless the visit is
// canceled on the booking page).
async function pullVisit(e: CalendarEvent, visitId: string, out: CalendarPullResult): Promise<void> {
  const v = await db().query.bookingVisits.findFirst({ where: and(eq(schema.bookingVisits.id, visitId), eq(schema.bookingVisits.env, currentEnv())) });
  if (!v || v.status !== "scheduled") return;
  out.checked++;
  const updated = e.updated ? new Date(e.updated) : null;
  if (!updated || (v.calendarSyncedAt && updated.getTime() <= v.calendarSyncedAt.getTime() + 2_000)) return;
  const now = new Date();
  const label = visitKindLabel(v.kind);
  if (e.status === "cancelled") {
    const b = await db().query.bookings.findFirst({ where: eq(schema.bookings.id, v.bookingId), with: { listing: { columns: { address: true, nda: true } } }, columns: { id: true } });
    const name = b?.listing ? hubListingName(b.listing) : "a booking";
    await enqueueJobs([{ kind: "slack.issue", idempotencyKey: `slack.issue:visit-deleted:${v.id}:${updated.getTime()}`, bookingId: v.bookingId, listingId: v.listingId, payload: { channel: "bookings", note: `The calendar event for the ${label.toLowerCase()} at ${name} (${visitWhenLabel(v)}) was deleted in Google Calendar. It is still scheduled in Studio: cancel it on the booking page, or it comes back on the next update. ${adminBookingUrl(v.bookingId)}` } }]);
    await db().update(schema.bookingVisits).set({ calendarSyncedAt: now }).where(eq(schema.bookingVisits.id, v.id));
    out.visits.deleted.push(v.id);
    return;
  }
  const set: Partial<typeof schema.bookingVisits.$inferInsert> = {};
  const start = e.start?.dateTime ? new Date(e.start.dateTime) : null;
  const end = e.end?.dateTime ? new Date(e.end.dateTime) : null;
  if (start && end && end > start && (Math.abs(start.getTime() - v.startsAt.getTime()) > 60_000 || Math.abs(end.getTime() - v.endsAt.getTime()) > 60_000)) {
    Object.assign(set, { startsAt: start, endsAt: end, desiredDate: localDay(start), startTime: localHm(start) });
    await logActivity({ action: "booking.visit_calendar_moved", listingId: v.listingId, meta: { bookingId: v.bookingId, visitId: v.id, kindLabel: label, from: v.startsAt.toISOString(), to: start.toISOString() } });
    out.visits.moved.push(v.id);
  }
  const guest = (e.attendees ?? []).find((a) => !a.organizer && !a.self && !a.resource && a.email)?.email?.trim().toLowerCase() ?? null;
  const shooter = v.photographerEmail?.trim().toLowerCase() || null;
  if (guest !== shooter) {
    set.photographerEmail = guest;
    await logActivity({ action: "booking.visit_calendar_shooter", listingId: v.listingId, meta: { bookingId: v.bookingId, visitId: v.id, kindLabel: label, email: guest } });
    out.visits.shooter.push(v.id);
  }
  await db().update(schema.bookingVisits).set({ ...set, ...(Object.keys(set).length ? { updatedAt: now } : {}), calendarSyncedAt: now }).where(eq(schema.bookingVisits.id, v.id));
}
