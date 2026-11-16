// The client's standing notes, wherever a shoot is looked at (Oct 21 2026).
// Two sources: the client's note in the business brain ("Before every shoot" and
// "Access and on site", read through src/lib/brain.ts, the same match the
// shoot brief uses) and the studio's own client notes (clients.notes, the
// "Notes, internal" box on the client page). Shown on the booking page. It
// was also appended to the booking's hello@ calendar event as a "CLIENT
// NOTES:" block until Oct 31 2026, when the owner asked for events that say only
// what that shoot needs ("should NOT say EVERYTHING about the client"); the
// event links to the booking page instead. The Slack booking card stays short
// on purpose (the owner: no paragraphs in #bookings); it links to the booking.
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { brainBriefFor, hasBrain, type BrainBrief } from "./brain";

export type ClientFile = {
  brain: BrainBrief | null;
  brainState: "matched" | "no_match" | "off" | "error";
  studioNotes: string | null;
};

export const EMPTY_CLIENT_FILE: ClientFile = { brain: null, brainState: "off", studioNotes: null };

export async function clientFileFor(who: { clientId: string | null; email?: string | null; phone?: string | null; name?: string | null; company?: string | null; address?: string | null }): Promise<ClientFile> {
  let studioNotes: string | null = null;
  if (who.clientId) {
    try {
      studioNotes = (await db().query.clients.findFirst({ where: eq(schema.clients.id, who.clientId), columns: { notes: true } }))?.notes?.trim() || null;
    } catch (e) {
      console.error("[client-file] studio notes", e);
    }
  }
  let brain: BrainBrief | null = null;
  let brainState: ClientFile["brainState"] = hasBrain() ? "no_match" : "off";
  if (hasBrain()) {
    try {
      brain = await brainBriefFor(who);
      if (brain) brainState = "matched";
    } catch (e) {
      console.error("[client-file] brain lookup failed", e);
      brainState = "error";
    }
  }
  return { brain, brainState, studioNotes };
}

export const hasClientNotes = (f: ClientFile) => Boolean(f.studioNotes || f.brain?.beforeEveryShoot.length || f.brain?.accessOnSite.length);
