// The shoot brief (Oct 20 2026): 30 minutes before every shoot, the
// shooter gets one short the business email with everything for the job: the time and
// address, the services and add-ons booked, the home (size, furnished,
// homeowner, view), access, the client's own notes, and the client's
// standing requests from the business brain ("Before every shoot").
//
// To: the booking's assigned shooter (bookings.photographer_email), else
// SHOOT_BRIEF_FALLBACK (default the owner). CC: SHOOT_BRIEF_CC
// (none by default) on every brief. Internal only: it never
// goes to a client, so the client-copy rules about vendors do not apply, but
// the house style does (no em dashes, plain sentences).
//
// Confirmed shoots only (Oct 20 2026): an Unconfirmed booking gets no
// brief. Access goes in full (lockbox or gate code, who meets us), since the
// shooter needs it on the doorstep; the brief is internal and never reaches a client.
//
// Scheduling: the minute cron calls scheduleShootBriefs(), which queues an
// email.shoot_brief job for each Confirmed booking starting in the next 45
// minutes, keyed to that start time and set to run 30 minutes
// before it. A rescheduled shoot gets a fresh key; the old job sees the start
// moved and skips. A booking made less than 30 minutes ahead is briefed at once.
//
// Additional shoots (Oct 27 2026, src/lib/booking-visits.ts): every scheduled
// return trip, pickup, reshoot or twilight gets its own brief 30 minutes before
// it, to the visit's shooter (else the fallback, cc as above), keyed
// email.shoot_brief:visit:<visitId>:<startsAt ms> so it never collides with the
// booking's own. The eyebrow names the kind and the visit's note leads.
import { Resend } from "resend";
import { and, eq, gt, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { brainBriefFor, hasBrain, type BrainBrief } from "./brain";
import { itemById } from "./studio-pricing";
import { isTimeConfirmed } from "./booking-status";
import { BUSINESS_TZ } from "./booking-time";
import { mapsUrl } from "./booking-email";
import { brand, emailAssetBase, emailFrom, supportEmail, notifyEmails } from "./brand";
import { currentEnv, enqueueJobs, NotConfiguredError, SkipJobError } from "./jobs-core";
import { visitKindLabel } from "./booking-visits";
import { business } from "./business";

export const BRIEF_LEAD_MINUTES = 30;
const LOOKAHEAD_MINUTES = 45;

export function briefRecipients(photographerEmail: string | null): { to: string; cc: string[] } {
  const clean = (s: string | null | undefined) => (s || "").trim().toLowerCase();
  const to = clean(photographerEmail) || clean(process.env.SHOOT_BRIEF_FALLBACK) || notifyEmails()[0] || "";
  const ccList = (process.env.SHOOT_BRIEF_CC ?? "").split(/[,\s;]+/).map(clean).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  return { to, cc: ccList.filter((e) => e !== to) };
}

const briefKey = (bookingId: string, startsAt: Date) => `email.shoot_brief:${bookingId}:${startsAt.getTime()}`;
const visitBriefKey = (visitId: string, startsAt: Date) => `email.shoot_brief:visit:${visitId}:${startsAt.getTime()}`;

// Called every minute by /api/cron/pipeline. Returns how many briefs were newly queued.
export async function scheduleShootBriefs(now: Date = new Date()): Promise<number> {
  const rows = await db()
    .select({ id: schema.bookings.id, listingId: schema.bookings.listingId, startsAt: schema.bookings.startsAt })
    .from(schema.bookings)
    .where(and(
      eq(schema.bookings.env, currentEnv()),
      eq(schema.bookings.status, "confirmed"),
      gt(schema.bookings.startsAt, now),
      lte(schema.bookings.startsAt, new Date(now.getTime() + LOOKAHEAD_MINUTES * 60_000)),
    ));
  const queued = await enqueueJobs(rows.filter((r) => r.startsAt).map((r) => ({
    kind: "email.shoot_brief" as const,
    idempotencyKey: briefKey(r.id, r.startsAt!),
    bookingId: r.id,
    listingId: r.listingId,
    runAt: new Date(Math.max(now.getTime(), r.startsAt!.getTime() - BRIEF_LEAD_MINUTES * 60_000)),
    payload: { bookingId: r.id, note: r.startsAt!.toISOString() },
  })));
  return queued + (await scheduleVisitBriefs(now));
}

// The additional shoots starting in the next 45 minutes. Read apart, so a
// database the migrate route has not reached yet never stops the booking briefs.
async function scheduleVisitBriefs(now: Date): Promise<number> {
  try {
    const rows = await db()
      .select({ id: schema.bookingVisits.id, bookingId: schema.bookingVisits.bookingId, listingId: schema.bookingVisits.listingId, startsAt: schema.bookingVisits.startsAt })
      .from(schema.bookingVisits)
      .where(and(
        eq(schema.bookingVisits.env, currentEnv()),
        eq(schema.bookingVisits.status, "scheduled"),
        gt(schema.bookingVisits.startsAt, now),
        lte(schema.bookingVisits.startsAt, new Date(now.getTime() + LOOKAHEAD_MINUTES * 60_000)),
      ));
    return await enqueueJobs(rows.map((r) => ({
      kind: "email.shoot_brief" as const,
      idempotencyKey: visitBriefKey(r.id, r.startsAt),
      bookingId: r.bookingId,
      listingId: r.listingId,
      runAt: new Date(Math.max(now.getTime(), r.startsAt.getTime() - BRIEF_LEAD_MINUTES * 60_000)),
      payload: { bookingId: r.bookingId, visitId: r.id, note: r.startsAt.toISOString() },
    })));
  } catch (e) {
    console.error("[shoot-brief] visit briefs", e instanceof Error ? e.message : e);
    return 0;
  }
}

// ---- Content ----------------------------------------------------------------

export type ShootBrief = {
  bookingId: string;
  street: string;
  address: string;
  timeLabel: string; // "2:30 PM"
  dayLabel: string; // "Thursday, November 5"
  confirmed: boolean;
  client: { name: string | null; company: string | null; phone: string | null; email: string | null };
  services: string[];
  addons: string[];
  customRequest: string | null;
  home: string[]; // "3,450 sq ft", "Lived in", "For Sale", "Off-market"
  homeownerHome: string | null; // "Yes" | "No" | null
  views: string | null; // "Ocean, Mountain" | "Yes" | null
  access: string | null;
  clientNotes: string | null;
  video: string | null; // "Medium pace · music: <link>"
  launch: string | null;
  nda: boolean;
  studioNotes: string | null; // clients.notes
  visit: { kindLabel: string; note: string | null } | null; // an additional shoot (Oct 27 2026); null for the booking's own
  brain: BrainBrief | null;
  brainState: "matched" | "no_match" | "off" | "error";
  to: string;
  cc: string[];
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const fmtLocal = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, ...o }).format(d);
const STATUS_WORD: Record<string, string> = { "Vacant / Unstaged": "Vacant", "Vacant / Staged": "Staged", "Homeowner Furniture": "Lived in", Unknown: "Furnishing unknown" };

// `visit`: the brief for an additional shoot on the booking (its own time,
// shooter, kind and note; the booking supplies everything else).
type BriefVisit = { kind: string; note: string | null; startsAt: Date; photographerEmail: string | null };

export async function buildShootBrief(bookingId: string, visit: BriefVisit | null = null): Promise<ShootBrief> {
  const b = await db().query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), with: { listing: true, client: true } });
  if (!b) throw new SkipJobError(`booking ${bookingId} not found`);
  const startsAt = visit ? visit.startsAt : b.startsAt;
  if (!startsAt) throw new SkipJobError("the booking has no start time");
  const prop = (b.property ?? {}) as Record<string, unknown>;
  const address = (b.listing?.address ?? [str(prop.street), str(prop.city), [str(prop.state), str(prop.zip)].filter(Boolean).join(" ")].filter(Boolean).join(", ")).trim();
  const street = address.split(",")[0].trim() || "the shoot";
  const names = (ids: string[] | null) => (ids ?? []).map((id) => itemById(id)?.name ?? id);
  const views = Array.isArray(prop.views) && prop.views.length ? (prop.views as string[]).join(", ") : /^yes$/i.test(str(prop.viewHome) ?? "") ? "Yes" : null;
  const status = str(prop.status);
  const home = [
    b.sqft ? `${b.sqft.toLocaleString("en-US")} sq ft` : null,
    status ? STATUS_WORD[status] ?? status : null,
    str(prop.listingType),
    /^yes$/i.test(str(prop.offMarket) ?? "") ? "Off-market" : null,
  ].filter(Boolean) as string[];
  const hasVideo = (b.serviceIds ?? []).some((id) => ["film", "basicreel", "luxreel", "basicvideo"].includes(id));
  const video = hasVideo ? [str(prop.videoStyle) ? `${str(prop.videoStyle)} pace` : null, str(prop.musicLink) ? `music: ${str(prop.musicLink)}` : null].filter(Boolean).join(" · ") || null : null;
  const payload = (b.raw?.payload ?? {}) as Record<string, unknown>;
  const formClient = (payload.client ?? {}) as Record<string, unknown>;
  const client = {
    name: b.client?.name ?? str(formClient.name),
    company: str(formClient.company) ?? b.client?.company ?? null,
    phone: str(formClient.phone) ?? b.client?.phone ?? null,
    email: b.client?.email ?? str(formClient.email),
  };

  let brain: BrainBrief | null = null;
  let brainState: ShootBrief["brainState"] = hasBrain() ? "no_match" : "off";
  if (hasBrain()) {
    try {
      brain = await brainBriefFor({ ...client, address });
      if (brain) brainState = "matched";
    } catch (e) {
      console.error("[shoot-brief] brain lookup failed", e);
      brainState = "error";
    }
  }
  const launch = b.launchDate ? fmtLocal(new Date(`${b.launchDate}T12:00:00Z`), { weekday: "long", month: "long", day: "numeric" }) : null;
  return {
    bookingId: b.id,
    street,
    address,
    timeLabel: fmtLocal(startsAt, { hour: "numeric", minute: "2-digit" }),
    dayLabel: fmtLocal(startsAt, { weekday: "long", month: "long", day: "numeric" }),
    confirmed: visit ? true : isTimeConfirmed(b.status),
    client,
    services: names(b.serviceIds),
    addons: names(b.addonIds),
    customRequest: b.customRequest,
    home,
    homeownerHome: str(prop.homeownerHome),
    views,
    access: b.accessNotes,
    clientNotes: b.clientNotes,
    video,
    launch,
    nda: Boolean(b.listing?.nda),
    studioNotes: b.client?.notes ?? null,
    brain,
    brainState,
    visit: visit ? { kindLabel: visitKindLabel(visit.kind), note: visit.note?.trim() || null } : null,
    ...briefRecipients(visit ? visit.photographerEmail : b.photographerEmail),
  };
}

// ---- Email -------------------------------------------------------------------

const PAGE = "#EEECE8";
const PAPER = "#FFFFFF";
const FOG = "#F6F5F2";
const INK = "#0B0C0F";
const MUTED = "#5F646E";
const FAINT = "#8A8F98";
const LINE = "#E6E8EC";
const ALERT = "#B42318";
const SANS = "'Geist', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const linkify = (t: string) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${INK};text-decoration:underline;">$1</a>`).replace(/\n/g, "<br/>");

export function shootBriefSubject(x: ShootBrief): string {
  return x.visit ? `Shoot brief: ${x.visit.kindLabel}, ${x.street} at ${x.timeLabel}` : `Shoot brief: ${x.street} at ${x.timeLabel}`;
}

const homeownerLine = (v: string | null) => (v == null ? null : /^yes$/i.test(v) ? "Homeowner WILL be home" : "Homeowner will be away");

export function shootBriefHtml(x: ShootBrief): string {
  const logo = `${emailAssetBase()}${brand.logoWhite}`;
  const logoW = 116;
  const logoH = Math.round(logoW / brand.logoRatio);
  const row = (label: string, html: string, first: boolean) => `
              <tr>
                <td class="st-label" width="104" style="width:104px;padding:12px 12px 12px 0;${first ? "" : `border-top:1px solid ${LINE};`}font-family:${SANS};font-size:10.5px;line-height:20px;letter-spacing:.14em;text-transform:uppercase;color:${FAINT};vertical-align:top;">${esc(label)}</td>
                <td style="padding:12px 0;${first ? "" : `border-top:1px solid ${LINE};`}font-family:${SANS};font-size:14.5px;line-height:1.5;color:${INK};vertical-align:top;">${html}</td>
              </tr>`;
  const small = (t: string) => `<div style="margin-top:3px;font-size:12.5px;line-height:1.5;color:${MUTED};">${esc(t)}</div>`;
  const rows: [string, string][] = [];
  rows.push(["Where", `<a href="${esc(mapsUrl(x.address))}" style="color:${INK};text-decoration:underline;font-weight:600;">${esc(x.address)}</a>`]);
  rows.push(["Access", x.access ? `<strong style="font-weight:600;">${linkify(x.access)}</strong>` : `<span style="color:${ALERT};font-weight:600;">No access details on the booking. Call the client before you go.</span>`]);
  rows.push(["Services", `${x.services.map((s) => `<strong style="font-weight:600;">${esc(s)}</strong>`).join("<br/>") || "None listed"}${x.addons.length ? `<div style="margin-top:6px;">${x.addons.map((a) => `+ ${esc(a)}`).join("<br/>")}</div>` : ""}${x.customRequest ? small(`Custom request: ${x.customRequest}`) : ""}`]);
  const homeBits = [x.home.join(" · "), homeownerLine(x.homeownerHome)].filter(Boolean) as string[];
  if (homeBits.length) rows.push(["The home", homeBits.map((t, i) => (i === 1 && /WILL/.test(t) ? `<strong style="font-weight:600;color:${ALERT};">${esc(t)}</strong>` : esc(t))).join("<br/>")]);
  rows.push(["View", x.views ? `<strong style="font-weight:600;">View home: ${esc(x.views)}</strong>` : "Not a view home"]);
  if (x.video) rows.push(["Video", linkify(x.video)]);
  if (x.clientNotes) rows.push(["Their notes", linkify(x.clientNotes)]);
  rows.push(["Client", esc([x.client.name, x.client.company].filter(Boolean).join(" · ") || "Unknown") + (x.client.phone ? small(x.client.phone) : "")]);
  if (x.launch) rows.push(["Goes live", esc(x.launch)]);
  const details = rows.map(([l, v], i) => row(l, v, i === 0)).join("");

  const standing = [...(x.brain?.beforeEveryShoot ?? []), ...(x.brain?.accessOnSite ?? [])];
  const fileNote = x.brainState === "matched"
    ? `From ${x.brain!.note.client}'s client file`
    : x.brainState === "no_match" ? "No client file in the brain yet" : x.brainState === "error" ? "The client file could not be read this time" : "Client file not connected";
  const fileBox = `
        <tr><td class="st-pad" style="padding:0 36px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${FOG};border:1px solid ${LINE};border-radius:10px;">
            <tr><td style="padding:16px 18px;font-family:${SANS};">
              <p style="margin:0 0 8px;font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:${FAINT};">Every shoot for this client</p>
              ${standing.length ? `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.55;color:${INK};">${standing.map((s) => `<li style="margin:0 0 5px;">${linkify(s)}</li>`).join("")}</ul>` : `<p style="margin:0;font-size:14px;line-height:1.55;color:${MUTED};">Nothing on file. Shoot to the ${brand.shortName} standard and note anything worth remembering after.</p>`}
              ${x.studioNotes ? `<p style="margin:10px 0 0;font-size:13.5px;line-height:1.55;color:${INK};"><strong style="font-weight:600;">Team notes:</strong> ${linkify(x.studioNotes)}</p>` : ""}
              <p style="margin:10px 0 0;font-size:11.5px;color:${FAINT};">${esc(fileNote)}</p>
            </td></tr>
          </table>
        </td></tr>`;

  const flags = [
    x.nda ? `NDA property. Nothing from this shoot is posted, shared or demoed. Questions go to ${business.owner}.` : null,
  ].filter(Boolean) as string[];
  // An additional shoot: what this trip is for, above everything else.
  const visitBox = x.visit
    ? `<tr><td class="st-pad" style="padding:0 36px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${FOG};border:1px solid ${INK};border-radius:10px;"><tr><td style="padding:14px 16px;font-family:${SANS};">
              <p style="margin:0 0 6px;font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:${INK};">${esc(x.visit.kindLabel)} · this trip</p>
              <p style="margin:0;font-size:15px;line-height:1.5;color:${INK};font-weight:600;">${x.visit.note ? linkify(x.visit.note) : "No note on this trip. Check the booking page or ask the team what it is for."}</p>
              <p style="margin:8px 0 0;font-size:12.5px;line-height:1.5;color:${MUTED};">The services below are the original booking, for context.</p>
            </td></tr></table></td></tr>`
    : "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="light"/>
  <title>${esc(shootBriefSubject(x))}</title>
  <style>
    @media only screen and (max-width:480px) {
      .st-outer { padding:16px 8px 28px !important; }
      .st-pad { padding-left:20px !important; padding-right:20px !important; }
      .st-h1 { font-size:24px !important; }
      .st-label { width:84px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};">
    <tr><td class="st-outer" align="center" style="padding:32px 16px 40px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${PAPER};border-radius:14px;border-collapse:separate;">
        <tr><td class="st-pad" bgcolor="${INK}" style="background:${INK};border-radius:14px 14px 0 0;padding:20px 36px;">
          <img src="${logo}" width="${logoW}" height="${logoH}" alt="${brand.name}" style="display:block;border:0;width:${logoW}px;height:${logoH}px;"/>
        </td></tr>
        <tr><td class="st-pad" style="padding:32px 36px 0;">
          <p style="margin:0 0 10px;font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:${FAINT};">${x.visit ? esc(x.visit.kindLabel) : "Shoot brief"} · starts in ${BRIEF_LEAD_MINUTES} minutes</p>
          <h1 class="st-h1" style="margin:0 0 6px;font-family:${SANS};font-weight:700;font-size:28px;line-height:1.15;letter-spacing:-.02em;color:${INK};">${esc(x.street)}</h1>
          <p style="margin:0 0 20px;font-family:${SANS};font-size:15px;line-height:1.5;color:${MUTED};">${esc(x.dayLabel)} at <strong style="color:${INK};font-weight:600;">${esc(x.timeLabel)}</strong></p>
        </td></tr>
        ${visitBox}
        ${flags.map((f) => `<tr><td class="st-pad" style="padding:0 36px 12px;"><p style="margin:0;padding:10px 14px;border-radius:8px;background:#FDF0EE;font-family:${SANS};font-size:13.5px;line-height:1.5;color:${ALERT};font-weight:600;">${esc(f)}</p></td></tr>`).join("")}
        <tr><td class="st-pad" style="padding:${flags.length ? "8px" : "0"} 36px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};">${details}
          </table>
        </td></tr>
        ${fileBox}
        <tr><td class="st-pad" bgcolor="${FOG}" style="background:${FOG};border-top:1px solid ${LINE};border-radius:0 0 14px 14px;padding:16px 36px 18px;">
          <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">Sent ${BRIEF_LEAD_MINUTES} minutes before every shoot by ${esc(brand.name)}. Reply to reach ${esc(supportEmail())}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function shootBriefText(x: ShootBrief): string {
  const standing = [...(x.brain?.beforeEveryShoot ?? []), ...(x.brain?.accessOnSite ?? [])];
  return [
    x.visit ? `SHOOT BRIEF (${x.visit.kindLabel.toUpperCase()}): ${x.street}` : `SHOOT BRIEF: ${x.street}`,
    `${x.dayLabel} at ${x.timeLabel}`,
    ...(x.visit ? [`This trip: ${x.visit.note || "no note, check the booking page"}`, "The services below are the original booking, for context."] : []),
    ...(x.nda ? ["NDA property. Nothing from this shoot is posted, shared or demoed."] : []),
    "",
    `Where: ${x.address}`,
    `Maps: ${mapsUrl(x.address)}`,
    `Access: ${x.access || "none on the booking, call the client before you go"}`,
    `Services: ${x.services.join(", ") || "none listed"}`,
    ...(x.addons.length ? [`Add-ons: ${x.addons.join(", ")}`] : []),
    ...(x.customRequest ? [`Custom request: ${x.customRequest}`] : []),
    ...(x.home.length ? [`The home: ${x.home.join(" · ")}`] : []),
    ...(homeownerLine(x.homeownerHome) ? [homeownerLine(x.homeownerHome)!] : []),
    `View: ${x.views ? `view home (${x.views})` : "not a view home"}`,
    ...(x.video ? [`Video: ${x.video}`] : []),
    ...(x.clientNotes ? [`Their notes: ${x.clientNotes}`] : []),
    `Client: ${[x.client.name, x.client.company, x.client.phone].filter(Boolean).join(" · ")}`,
    ...(x.launch ? [`Goes live: ${x.launch}`] : []),
    "",
    "EVERY SHOOT FOR THIS CLIENT",
    ...(standing.length ? standing.map((s) => `- ${s}`) : ["Nothing on file."]),
    ...(x.studioNotes ? [`Team notes: ${x.studioNotes}`] : []),
  ].join("\n");
}

// The email.shoot_brief job. payload.note is the start time the job was
// queued for; a shoot that moved, was canceled, or already started is skipped.
export async function sendShootBrief(job: { bookingId: string | null; payload: { bookingId?: string; visitId?: string; note?: string } | null; idempotencyKey: string }): Promise<{ to: string; id: string | null }> {
  const bookingId = job.bookingId ?? job.payload?.bookingId;
  if (!bookingId) throw new SkipJobError("no booking on the job");
  if (job.payload?.visitId) return sendVisitBrief(bookingId, job.payload.visitId, job);
  const b = await db().query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), columns: { status: true, startsAt: true, listingId: true, clientId: true } });
  if (!b) throw new SkipJobError("the booking is gone");
  if (b.status !== "confirmed") throw new SkipJobError(b.status === "requested" ? "the booking is not confirmed; briefs go for confirmed shoots only" : `the booking is ${b.status}`);
  if (!b.startsAt || (job.payload?.note && b.startsAt.toISOString() !== job.payload.note)) throw new SkipJobError("the shoot moved; a new brief is queued for the new time");
  if (b.startsAt.getTime() < Date.now() - 10 * 60_000) throw new SkipJobError("the shoot already started");
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) throw new NotConfiguredError("email sending (RESEND_API_KEY)");
  const x = await buildShootBrief(bookingId);
  const r = await new Resend(key).emails.send(
    { from: emailFrom(), replyTo: supportEmail(), to: x.to, cc: x.cc.length ? x.cc : undefined, subject: shootBriefSubject(x), html: shootBriefHtml(x), text: shootBriefText(x) },
    { idempotencyKey: job.idempotencyKey },
  );
  if (r.error) throw new Error(`Resend rejected the shoot brief: ${r.error.message}`);
  await logActivity({ action: "email.shoot_brief_sent", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, to: x.to, cc: x.cc, brain: x.brainState, resendId: r.data?.id ?? null } });
  return { to: x.to, id: r.data?.id ?? null };
}

// The brief for an additional shoot. Same rules as the booking's: a visit that
// moved, was canceled or marked done, or already started, is skipped.
async function sendVisitBrief(bookingId: string, visitId: string, job: { payload: { note?: string } | null; idempotencyKey: string }): Promise<{ to: string; id: string | null }> {
  const v = await db().query.bookingVisits.findFirst({ where: eq(schema.bookingVisits.id, visitId) });
  if (!v) throw new SkipJobError("the additional shoot is gone");
  if (v.status !== "scheduled") throw new SkipJobError(`the additional shoot is ${v.status}`);
  if (job.payload?.note && v.startsAt.toISOString() !== job.payload.note) throw new SkipJobError("the additional shoot moved; a new brief is queued for the new time");
  if (v.startsAt.getTime() < Date.now() - 10 * 60_000) throw new SkipJobError("the additional shoot already started");
  const b = await db().query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId), columns: { status: true, listingId: true, clientId: true } });
  if (!b) throw new SkipJobError("the booking is gone");
  if (b.status === "canceled") throw new SkipJobError("the booking is canceled");
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) throw new NotConfiguredError("email sending (RESEND_API_KEY)");
  const x = await buildShootBrief(bookingId, v);
  const r = await new Resend(key).emails.send(
    { from: emailFrom(), replyTo: supportEmail(), to: x.to, cc: x.cc.length ? x.cc : undefined, subject: shootBriefSubject(x), html: shootBriefHtml(x), text: shootBriefText(x) },
    { idempotencyKey: job.idempotencyKey },
  );
  if (r.error) throw new Error(`Resend rejected the shoot brief: ${r.error.message}`);
  await logActivity({ action: "email.shoot_brief_sent", listingId: b.listingId, clientId: b.clientId, meta: { bookingId, visitId, kind: v.kind, to: x.to, cc: x.cc, brain: x.brainState, resendId: r.data?.id ?? null } });
  return { to: x.to, id: r.data?.id ?? null };
}
