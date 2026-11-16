// A listing edit that the booking calendar must follow (Oct 2026). Editing a
// listing's shoot date, address or NDA flag on /admin/listings/<id> used to
// change only the listing row, so the booking and its hello@ calendar event
// kept the old date and title. Now every live booking on the listing follows:
//   - a new shoot date moves the booking to that day at the same start time
//     (status unchanged, like Reschedule on the booking page);
//   - an address or NDA change re-writes the event's title and details;
// each through a new calendar version and a calendar.upsert job, run right
// after the response.
import { after } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "./activity";
import { bookingExtra, quote } from "./studio-pricing";
import { fmtWhen, wallClockToUtc } from "./booking-time";
import { drainJobs } from "./jobs";
import { currentEnv, enqueueJobs, jobKey } from "./jobs-core";

const LIVE = ["requested", "confirmed"] as const;

export async function syncBookingsAfterListingEdit(p: { listingId: string; actor: string; newDate: string | null; dateChanged: boolean; textChanged: boolean }): Promise<number> {
  if (!p.dateChanged && !p.textChanged) return 0;
  const d = db();
  const env = currentEnv();
  const rows = (await d.query.bookings.findMany({ where: and(eq(schema.bookings.listingId, p.listingId), inArray(schema.bookings.status, [...LIVE])) })).filter(
    (b) => (b.env ? b.env === env : env === "production")
  );
  let moved = 0;
  for (const b of rows) {
    const version = b.calendarVersion + 1;
    const now = new Date();
    const patch: Partial<typeof schema.bookings.$inferInsert> = { calendarVersion: version, updatedAt: now };
    let when: string | null = null;
    if (p.dateChanged && p.newDate && p.newDate !== b.desiredDate) {
      patch.desiredDate = p.newDate;
      if (b.startTime) {
        const startsAt = wallClockToUtc(p.newDate, b.startTime);
        if (startsAt) {
          patch.startsAt = startsAt;
          patch.endsAt = new Date(startsAt.getTime() + quote(b.serviceIds ?? [], b.addonIds ?? [], bookingExtra(b)).minutes * 60_000);
        }
      }
      when = fmtWhen({ desiredDate: p.newDate, startTime: b.startTime });
    } else if (!p.textChanged) continue;
    await d.update(schema.bookings).set(patch).where(eq(schema.bookings.id, b.id));
    if (when) {
      moved++;
      await logActivity({ actorEmail: p.actor, action: "booking.rescheduled", listingId: p.listingId, clientId: b.clientId, meta: { bookingId: b.id, date: p.newDate, time: b.startTime, when, version, via: "listing" } });
    }
    await enqueueJobs([{ kind: "calendar.upsert", idempotencyKey: jobKey("calendar.upsert", b.id, version), bookingId: b.id, listingId: p.listingId, payload: { version } }]);
    after(() => drainJobs({ bookingId: b.id, budgetMs: 30_000 }).then(() => undefined).catch((e) => console.error("[listing edit] calendar drain", e)));
  }
  return moved;
}
