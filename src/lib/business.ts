// Every business detail of this studio, in one place. A new buyer is this
// file, src/lib/brand.ts (logos and colors), src/lib/booking-pricing.ts (a
// copy of their website's src/lib/pricing.ts) and their own accounts' env vars.
//
// Safe to import from client components: plain data and small pure helpers,
// no secrets, no server code. Nothing here is a secret; keys and tokens live
// in the buyer's own Vercel env vars only (names in .env.example).
//
// studio-universal ships with placeholders (example.com, a 555 number) and
// TEMPLATE = true. scripts/check-business.ts fails a buyer's studio that still
// has a placeholder in it.

export const TEMPLATE = true;

export type PaymentMethod = "stripe" | "manual";
export type EditingPath = "autohdr" | "manual";

export const business = {
  // ---- Who ---------------------------------------------------------------------
  // The name clients read on the portal, in emails and on the gallery.
  name: "Showcase Media",
  // After the first mention, in tight spots and on buttons.
  shortName: "Showcase",
  // The business on invoices and in the footer.
  legalName: "Showcase Media LLC",
  // The owner's first name, in sentences clients read ("Sam will confirm the
  // time") and in team-facing notes.
  owner: "Pierre",
  // How team emails (to an editor, a shooter) and client emails are signed.
  signOff: "Showcase Media",
  // Where the business is, for the footer and the shoot brief.
  city: "Your City, ST",
  region: "your area",

  // ---- Where -------------------------------------------------------------------
  // The public website (the booking form posts here from /book).
  marketingUrl: "https://www.showcasemedia.pro",
  // This app: the admin at /admin and the client portal at /portal.
  portalUrl: "https://portal.showcasemedia.pro",

  // ---- Contact -------------------------------------------------------------------
  // The sender of every email (a Resend-verified domain; it has no mailbox).
  emailFrom: "Showcase Media <portal@showcasemedia.pro>",
  // Where client replies go, and the address shown when something fails.
  supportEmail: "pierre@showcasemedia.pro",
  // The one phone number clients ever see (the business line, never a
  // personal number). Empty: no phone is shown.
  phone: "(608) 345-2123",

  // ---- When -------------------------------------------------------------------------
  // Every calendar day, shoot time and due date is read in this zone.
  // TO CONFIRM with Pierre: Central assumed from his 608 (Wisconsin) number.
  timeZone: "America/Chicago",
  // What clients read after a time ("9:00 AM local time").
  timeZoneLabel: "Central time",
  // The short name staff screens use after a time ("9:00 AM local"), and
  // the abbreviation in Slack lines ("PT").
  timeZoneShort: "Central",
  timeZoneAbbr: "CT",
  // The booking calendar's open hours (admin scheduling and the client's
  // reschedule picker). closedWeekdays: 0 = Sunday.
  schedule: { dayStart: "09:00", dayEnd: "17:00", stepMinutes: 30, closedWeekdays: [0] as readonly number[] },

  // ---- How they work ------------------------------------------------------------
  // "stripe": every booking gets a Stripe invoice; the webhook's invoice.paid
  // marks it paid and unlocks the gallery. "manual": no processor; an admin
  // marks the invoice paid (bank transfer, check) and that unlocks it.
  // Pierre invoices with Wave, not Stripe (how to connect Wave: ask Jacob).
  // Until then an admin marks each invoice paid, which unlocks the gallery.
  payments: "manual" as PaymentMethod,
  // "autohdr": raw uploads go to the AutoHDR editing service (AUTOHDR_* env
  // vars). "manual": the team edits outside the studio and uploads finished
  // frames as finals. Never named to clients either way.
  editing: "autohdr" as EditingPath,
  // Pay at close through Titus (TITUS_* env vars). Off unless the buyer has a
  // Titus account and turns it on here.
  payAtClose: false,
  // When the delivered photos are due, in what clients read.
  turnaround: "24 to 48 hours",

  // ---- Messages -------------------------------------------------------------------
  // Automated texts and emails stay off until the buyer says yes. The booking
  // email (the client's own confirmation) and the magic sign-in link are the
  // only emails that go without a person pressing send.
  autoTexts: false,
  // People who never get an automated message of any kind (lowercase emails).
  neverMessage: [] as readonly string[],

  // ---- The booking calendar ---------------------------------------------------------
  // Google Calendar event ids are derived from the booking id with this prefix
  // (letters a to v and digits only: Google's base32hex).
  calendarPrefix: "scm",

  // ---- Weather on the calendar -------------------------------------------------------
  // The fallback point when an address doesn't geocode (the business's city).
  weatherHome: { lat: 34.05, lon: -118.24 },

  // ---- Shooter pay ----------------------------------------------------------------------
  // The Shooter pay report (/admin/reports#pay): every shoot a shooter was on
  // in the range, and their pay. A rate is in cents per shoot, by shooter
  // email; a shooter with no rate shows "Rate not set" (never a made-up
  // number). byItem: a different rate for a booking whose package or service
  // is that item id (the first match wins), for shooters paid by job type.
  shooterPay: {
    enabled: true,
    perShoot: {} as Readonly<Record<string, number>>,
    byItem: {} as Readonly<Record<string, Readonly<Record<string, number>>>>,
    // Return trips, pickups and reshoots count as a shoot when true. An
    // additional shoot can have its own rate in byItem as "visit:<kind>"
    // (visit:return_trip, visit:pickup, visit:reshoot, visit:twilight).
    countVisits: true,
    // Pay as a share of what was collected on the booking (paid invoices,
    // add-on invoices included, net of refunds), for shooters with no
    // per-shoot or job-type rate above. null = off. A booking not paid yet
    // reads "Not collected yet". Additional shoots are part of the booking's
    // pay in this mode unless they have their own rate.
    percentOfCollected: null as number | null,
  },

  // ---- Scorecard ---------------------------------------------------------------------------
  // The operations scorecard (/admin/scorecard): a daily and weekly checklist,
  // shoot marks and service standards for one team member. null = admins only
  // see it, measured for the whole team.
  scorecard: {
    person: null as null | { email: string; name: string; first: string; title: string; start: string },
    coverageHours: { open: "08:00", close: "18:00", label: "8 AM to 6 PM, Monday to Friday" },
    confirmMinutes: 60,
    taskOwners: ["Owner", "Team"] as readonly string[],
  },
} as const;

// "local time" for any zone this file names, from the zone itself.
export const BUSINESS_TZ: string = business.timeZone;
export const tzLabel = (): string => business.timeZoneLabel;
export const TZ_SHORT: string = business.timeZoneShort;
export const TZ_ABBR: string = business.timeZoneAbbr;

// Whether a person may get an automated message (texts and any email that
// isn't the booking confirmation, a sign-in link or a send a person pressed).
export function mayAutoMessage(email: string | null | undefined): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  return Boolean(e) && !business.neverMessage.includes(e);
}
