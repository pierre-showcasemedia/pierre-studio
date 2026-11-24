// The day the reminder email names (studio template, Nov 24 2026). The
// day-before reminder (src/lib/booking-time-email.ts) goes out whenever the
// lead time says (business.reminderLeadHours), so a shoot can be later today,
// tomorrow or a few days out. This names the shoot's day from the moment the
// email is built, in the business's time zone. Pure.
export type ReminderDay = {
  phrase: string; // "today" | "tomorrow" | "on Friday" | "on Friday, December 4" | "coming up"
  eyebrow: string; // "See you today" | "See you tomorrow" | "See you Friday" | "See you soon"
};

const DAY_MS = 86_400_000;
const ymdUtc = (ymd: string): number | null => (/^\d{4}-\d{2}-\d{2}$/.test(ymd) ? Date.parse(`${ymd}T12:00:00Z`) : null);

// yyyy-mm-dd of an instant in a time zone.
export const localYmd = (at: Date, tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

export function reminderDay(desiredDate: string | null | undefined, now: Date, tz: string): ReminderDay {
  const soon = { phrase: "coming up", eyebrow: "See you soon" };
  const shoot = desiredDate ? ymdUtc(desiredDate) : null;
  const today = ymdUtc(localYmd(now, tz));
  if (shoot == null || today == null) return soon;
  const days = Math.round((shoot - today) / DAY_MS);
  if (days < 0) return soon;
  if (days === 0) return { phrase: "today", eyebrow: "See you today" };
  if (days === 1) return { phrase: "tomorrow", eyebrow: "See you tomorrow" };
  const at = new Date(shoot);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(at);
  if (days < 7) return { phrase: `on ${weekday}`, eyebrow: `See you ${weekday}` };
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(at);
  return { phrase: `on ${weekday}, ${date}`, eyebrow: `See you ${weekday}` };
}

// The default when no day was worked out (the test email): the old wording.
export const TOMORROW: ReminderDay = { phrase: "tomorrow", eyebrow: "See you tomorrow" };
