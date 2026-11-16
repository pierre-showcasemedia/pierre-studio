// The client's Reschedule (src/lib/client-reschedule.ts).
//   GET  → open times for this booking (same calendar as the website form)
//   POST { date: "2026-10-23", time: "13:00" } → moves the booking
// Signed-in client or teammate only; anything else is a 404.
import { hasDb } from "@/db";
import { sessionEmail, viewingAs } from "@/lib/portal-auth";
import { clientReschedule, rescheduleOptions } from "@/lib/client-reschedule";
import { availability } from "@/lib/availability";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const email = await sessionEmail();
  if (!email) return Response.json({ ok: false, error: "not signed in" }, { status: 401 });
  // Demo mode: the dialog can be looked at (every time open), never saved.
  if (!hasDb()) return Response.json({ ok: true, availability: await availability(120), current: { date: "2026-07-28", time: "14:30", when: "Tue, Jul 28 at 2:30 PM" } });
  const { id } = await params;
  const r = await rescheduleOptions(email, id);
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: r.status });
  return Response.json(r, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const email = await sessionEmail();
  if (!email) return Response.json({ ok: false, error: "not signed in" }, { status: 401 });
  if (!hasDb()) return Response.json({ ok: false, error: "Demo mode: nothing can be moved here." }, { status: 503 });
  if (await viewingAs()) return Response.json({ ok: false, error: "You are viewing as this client. Move the shoot from the admin booking page." }, { status: 403 });
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { date?: unknown; time?: unknown };
  const r = await clientReschedule({ email, bookingId: id, date: body.date, time: body.time });
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: r.status });
  return Response.json(r);
}
