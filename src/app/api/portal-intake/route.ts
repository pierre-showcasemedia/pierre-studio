// Booking form → portal client + listing, the moment the form is submitted.
// The listing is born LOCKED with the requested shoot date; media arrives later
// via the upload script, and the delivery email is always a manual confirm.
// Idempotent: existing client is updated, existing slug is left alone.
//
// TODO(Phase 4): accept the business booking form payload (the marketing site/book,
// Formspree fields) and require a shared secret header before creating rows.
// Today it takes { email, name?, phone?, company?, property_address, desired_date? }
// with no auth, and nothing calls it yet.
import { timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";

export async function POST(request: Request) {
  try {
    // Oct 16 2026: this route was reachable with no auth on production. It now
    // needs the shared intake secret (BOOKING_INTAKE_SECRET) and hides until it
    // is set; the real booking intake is specified in docs/booking-to-payment.md.
    const secret = (process.env.BOOKING_INTAKE_SECRET || "").trim();
    const given = (request.headers.get("x-intake-secret") || "").trim();
    if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      return Response.json({ ok: false }, { status: 404 });
    }
    if (!process.env.DATABASE_URL) return Response.json({ ok: false, error: "no db" }, { status: 503 });
    const b = await request.json();
    const email = String(b.email || "").trim().toLowerCase();
    const address = String(b.property_address || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || address.length < 5) {
      return Response.json({ ok: false, error: "missing email/address" }, { status: 400 });
    }
    const sql = neon(process.env.DATABASE_URL);

    const name = String(b.name || "").trim() || null;
    const phone = String(b.phone || "").trim() || null;
    const company = String(b.company || "").trim() || null;
    const client = await sql`
      insert into clients (email, name, phone, company) values (${email}, ${name}, ${phone}, ${company})
      on conflict (email) do update set
        name = coalesce(clients.name, excluded.name),
        phone = coalesce(clients.phone, excluded.phone),
        company = coalesce(clients.company, excluded.company)
      returning id`;

    const slug = address.split(",")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const shootDate = b.desired_date ? new Date(String(b.desired_date)) : null;
    const r = await sql`
      insert into listings (client_id, address, slug, shoot_date, download_locked)
      values (${client[0].id}, ${address}, ${slug}, ${shootDate}, true)
      on conflict (slug) do nothing
      returning id`;

    return Response.json({ ok: true, created: r.length > 0, slug });
  } catch (e) {
    console.error("portal-intake:", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
