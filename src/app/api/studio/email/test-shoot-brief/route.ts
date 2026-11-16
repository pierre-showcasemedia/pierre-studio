// POST /api/studio/email/test-shoot-brief { to?, bookingId?, brainEmail?, html?, visit? }
// Operator-only look at the shoot brief. With bookingId it renders that real
// booking (read-only, brain lookup included); without, a fixed SAMPLE, whose
// client file is looked up for real in the brain when brainEmail is given. visit:
// true renders the sample as an additional shoot (a return trip with a note). html:
// true returns the rendered page instead of sending. Sending is guarded like
// test-booking: the x-migrate-token header, never on production, and the
// recipient must be an the business admin address. Subject starts "Test: ".
import { Resend } from "resend";
import { isAdminAllowed } from "@/lib/admin-allow";
import { brand, emailFrom, supportEmail } from "@/lib/brand";
import { currentEnv } from "@/lib/jobs-core";
import { brainBriefFor, hasBrain } from "@/lib/brain";
import { buildShootBrief, briefRecipients, shootBriefHtml, shootBriefSubject, shootBriefText, type ShootBrief } from "@/lib/shoot-brief";
import { hasMigrateToken } from "@/lib/operator-token";

export const dynamic = "force-dynamic";

function sample(): ShootBrief {
  return {
    bookingId: "00000000-0000-4000-8000-000000000000",
    street: "1420 Alder Drive",
    address: "1420 Alder Drive, Springfield, CA 90000",
    timeLabel: "2:30 PM",
    dayLabel: "Thursday, November 5",
    confirmed: true,
    client: { name: "Sample Agent", company: "Example Homes", phone: "(555) 010-0100", email: "sample@example.com" },
    services: ["Photography", "Cinematic listing film"],
    addons: ["Twilight photography", "2D floor plan"],
    customRequest: null,
    home: ["3,450 sq ft", "Lived in", "For Sale"],
    homeownerHome: "Yes",
    views: "Ocean, Mountain",
    access: "Lockbox: 4821, on the side gate. Seller leaves the garage open.",
    clientNotes: "Please get the ocean view from the primary bedroom balcony.",
    video: "Medium pace",
    launch: "Monday, November 9",
    nda: false,
    studioNotes: null,
    brain: { matchedBy: "email", beforeEveryShoot: ["Views sell their listings. Hold the view shots longer and offer to reschedule if it is gloomy.", "Always deliver a horizontal film, a vertical reel, and a vertical with no music."], accessOnSite: ["Often meets the shooter on site."], note: { file: "Sample.md", client: "Sample Agent", owner: null, meta: {}, sections: {} } },
    brainState: "matched",
    visit: null,
    ...briefRecipients(null),
  };
}

export async function POST(request: Request) {
  if (!hasMigrateToken(request)) return Response.json({ ok: false }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { to?: unknown; bookingId?: unknown; brainEmail?: unknown; html?: unknown; visit?: unknown };
  const brief = typeof body.bookingId === "string" && body.bookingId ? await buildShootBrief(body.bookingId) : sample();
  if (body.visit === true) brief.visit = { kindLabel: "Return trip", note: "Kitchen and primary bath pickups after the stagers finish. Twilight exterior if the sky cooperates." };
  if (!body.bookingId && typeof body.brainEmail === "string" && body.brainEmail) {
    brief.client.email = body.brainEmail;
    brief.brain = hasBrain() ? await brainBriefFor({ email: body.brainEmail }) : null;
    brief.brainState = !hasBrain() ? "off" : brief.brain ? "matched" : "no_match";
    if (brief.brain) brief.client.name = brief.brain.note.client;
  }
  if (body.html === true) return new Response(shootBriefHtml(brief), { headers: { "content-type": "text/html; charset=utf-8" } });
  if (currentEnv() === "production") return Response.json({ ok: false, error: "test emails never send from production" }, { status: 403 });
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return Response.json({ ok: false, error: "RESEND_API_KEY is not set here" }, { status: 503 });
  const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
  if (!to || !(await isAdminAllowed(to))) return Response.json({ ok: false, error: `the recipient must be an ${brand.shortName} admin address` }, { status: 403 });
  const r = await new Resend(key).emails.send({ from: emailFrom(), replyTo: supportEmail(), to, subject: `Test: ${shootBriefSubject(brief)}`, html: shootBriefHtml(brief), text: shootBriefText(brief) });
  if (r.error) return Response.json({ ok: false, error: r.error.message }, { status: 502 });
  return Response.json({ ok: true, to, id: r.data?.id ?? null, wouldSendTo: brief.to, wouldCc: brief.cc, brain: brief.brainState });
}
