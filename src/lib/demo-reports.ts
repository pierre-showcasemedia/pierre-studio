// Demo rows for /admin/reports (no DATABASE_URL): a small ledger spread over
// the last hundred days, built from today's date so the default range is never
// empty. The demo bookings, shoots and revisions from src/lib/demo-data.ts
// are in it too (so the unpaid list links to booking pages that exist in demo
// mode); everything else is invented, with placeholder names and addresses,
// and sized like a quiet quarter, not a real one.
import { DEMO_BOOKINGS, DEMO_CLIENTS, DEMO_REVISIONS, DEMO_SHOOTS, DEMO_CREATIVE_EMAIL } from "./demo-data";
import { addDaysYmd, localYmd } from "./local-date";
import type { RBooking, RInvoice, RRevision, RShoot, ReportRows } from "./reports";

// Deterministic: the same page every time it renders.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLIENTS = [
  ...DEMO_CLIENTS.map((c) => ({ email: c.email, name: c.name, company: c.company })),
  { email: "morgan@example.com", name: "Morgan Lee", company: "Coast Realty" },
  { email: "sam@example.com", name: "Sam Patel", company: "Springfield Homes" },
];
// Who gets the work: the first client is the big account.
const CLIENT_PICK = [0, 0, 1, 0, 2, 3, 0, 1, 4, 2, 0, 3];
const SHOOTERS = ["alex@example.com", DEMO_CREATIVE_EMAIL, "owner@example.com"];
const AMOUNTS = [60000, 90000, 150000, 240000, 75000, 210000, 60000, 180000];
const STREETS = ["1 Harbor View Lane", "412 Alameda Padre Serra", "77 Laurel Lane", "1600 Pine Road", "250 Chestnut Road", "3 Sea Ranch Drive", "905 Poplar Drive", "1288 Ironwood Road", "560 Acacia Road", "19 Rincon Point", "2 Springfield Lane", "840 Hawthorn Lane"];
const CITIES = ["Springfield, CA 90000", "Springfield, CA 90000", "Springfield, CA 90000", "Springfield, CA 90000"];

const ymdOf = (iso: string) => localYmd(new Date(iso));

export function demoReportRows(today = localYmd()): ReportRows {
  const rand = rng(20261021);
  const invoices: RInvoice[] = [];
  const bookings: RBooking[] = [];
  const shoots: RShoot[] = [];
  const revisions: RRevision[] = [];

  // ---- The real demo rows first ----
  for (const b of DEMO_BOOKINGS) {
    const createdYmd = ymdOf(b.createdAt);
    bookings.push({ id: b.id, status: b.status, dateYmd: b.desiredDate ?? createdYmd, shootYmd: b.desiredDate, createdYmd, photographerEmail: b.photographerEmail, clientEmail: b.client.email, clientName: b.client.name, clientCompany: b.client.company, listingId: b.listingId, address: b.address });
    if (b.invoice) {
      invoices.push({ id: b.invoice.id, status: b.invoice.status, provider: b.invoice.provider, method: b.invoice.method, amountCents: b.invoice.amountCents ?? 0, refundedCents: b.invoice.refundedCents ?? 0, paidYmd: b.invoice.paidAt ? ymdOf(b.invoice.paidAt) : null, createdYmd: b.invoice.createdAt ? ymdOf(b.invoice.createdAt) : createdYmd, clientEmail: b.client.email, clientName: b.client.name, clientCompany: b.client.company, listingId: b.listingId, address: b.address, bookingId: b.id });
    }
  }
  for (const s of DEMO_SHOOTS) shoots.push({ id: s.id, createdBy: s.createdBy, ymd: ymdOf(s.submittedAt ?? s.createdAt), status: s.status, listingId: s.listingId, address: s.address });
  for (const v of DEMO_REVISIONS) revisions.push({ id: v.id, status: v.status, createdYmd: ymdOf(v.createdAt), clientEmail: v.clientEmail, clientName: v.clientName, items: v.items.length, listingId: v.listingId, address: v.address });

  // ---- An invented quarter around them ----
  for (let k = 0; k < 30; k++) {
    const offset = -100 + k * 4 + Math.floor(rand() * 3) - 1; // days from today, oldest first, a few in the future
    const shootYmd = addDaysYmd(today, offset);
    const createdYmd = addDaysYmd(shootYmd, -(3 + Math.floor(rand() * 8)));
    const c = CLIENTS[CLIENT_PICK[k % CLIENT_PICK.length]];
    const address = `${STREETS[k % STREETS.length]}, ${CITIES[k % CITIES.length]}`;
    const listingId = `demo-rl${k}`;
    const id = `demo-rb${k}`;
    const canceled = k === 7 || k === 19;
    const status = canceled ? "canceled" : offset > 0 ? (k % 3 === 0 ? "requested" : "confirmed") : offset >= -3 ? "shot" : "delivered";
    const shooter = status === "requested" ? null : SHOOTERS[k % SHOOTERS.length];
    bookings.push({ id, status, dateYmd: shootYmd, shootYmd, createdYmd, photographerEmail: shooter, clientEmail: c.email, clientName: c.name, clientCompany: c.company, listingId, address });

    const amountCents = AMOUNTS[k % AMOUNTS.length];
    const lane = k % 7; // 0..3 Stripe card, 4..5 pay at close, 6 another way
    const provider = lane <= 3 ? "stripe" : lane <= 5 ? "titus" : null;
    const method = lane <= 3 ? "card" : lane <= 5 ? "pay_at_close" : "other";
    let invStatus: string;
    let paidYmd: string | null = null;
    let refundedCents = 0;
    if (canceled) invStatus = "void";
    else if (status === "delivered" || status === "shot") {
      if (provider === "titus") {
        // Pay at close settles weeks later; a recent one is still in review.
        const paid = addDaysYmd(shootYmd, 25 + Math.floor(rand() * 10));
        if (paid <= today) { invStatus = "paid"; paidYmd = paid; } else invStatus = k % 2 ? "processing" : "review";
      } else if (provider === "stripe") {
        if (status === "shot" && k % 2) invStatus = "open";
        else { invStatus = "paid"; paidYmd = addDaysYmd(shootYmd, 1 + Math.floor(rand() * 3)); }
      } else {
        // Paid another way (check, ACH, cash): marked paid by hand, a bit later.
        if (status === "shot") invStatus = "open";
        else { invStatus = "paid_manual"; paidYmd = addDaysYmd(shootYmd, 4 + Math.floor(rand() * 6)); }
      }
    } else if (status === "confirmed") invStatus = provider === "titus" ? "processing" : "open";
    else invStatus = provider === "titus" ? "needs_quote" : "open";
    // One partial refund and one full refund in the quarter.
    if (invStatus === "paid" && provider === "stripe" && k === 8) refundedCents = 15000;
    if (invStatus === "paid" && provider === "stripe" && k === 12) { invStatus = "refunded"; refundedCents = amountCents; }
    if (invStatus !== "void") invoices.push({ id: `demo-ri${k}`, status: invStatus, provider, method, amountCents, refundedCents, paidYmd, createdYmd, clientEmail: c.email, clientName: c.name, clientCompany: c.company, listingId, address, bookingId: id });

    // The upload: every shot or delivered booking was uploaded by its shooter.
    if ((status === "shot" || status === "delivered") && shooter) {
      shoots.push({ id: `demo-rs${k}`, createdBy: shooter, ymd: addDaysYmd(shootYmd, rand() < 0.7 ? 0 : 1), status: status === "delivered" ? "published" : "processing", listingId, address });
    }
    // A revision request now and then, mostly on delivered galleries.
    if (status === "delivered" && k % 4 === 1) {
      revisions.push({ id: `demo-rr${k}`, status: offset < -30 ? "done" : k % 8 === 1 ? "in_progress" : "new", createdYmd: addDaysYmd(shootYmd, 3 + Math.floor(rand() * 4)), clientEmail: c.email, clientName: c.name, items: 1 + Math.floor(rand() * 4), listingId, address });
    }
  }
  return { invoices, bookings, revisions, shoots };
}
