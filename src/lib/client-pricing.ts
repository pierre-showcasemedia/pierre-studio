// Client-specific pricing (Nov 18 2026, from the studio template): a percentage
// off a client's priced lines, saved on the client record
// (clients.discount_percent) and applied when a booking comes in, as its own
// negative line so the invoice shows the list prices and the discount. A quote
// that needs a human is left alone (the person setting the amount sees the
// client's discount on the client page). Off unless business.clientDiscount.
// Pure, so the check script can run it.
//
// Showcase Media's agent rate sheets (Stark Preferred, Preferred Agent,
// HomeTeam4U) are not percentages and stay in src/lib/agent-rates.ts, applied
// by hand on the invoice; this switch is for a flat client discount only.
import type { InvoiceLineItem } from "@/db/schema";

export function applyClientDiscount<Q extends { lineItems: InvoiceLineItem[]; totalCents: number }>(q: Q, percent: number | null | undefined): Q {
  const pct = Math.max(0, Math.min(100, Math.round(percent ?? 0)));
  if (!pct || q.totalCents <= 0) return q;
  const off = Math.round((q.totalCents * pct) / 100);
  if (off <= 0) return q;
  return { ...q, totalCents: q.totalCents - off, lineItems: [...q.lineItems, { id: "client_discount", name: `Client discount (${pct}%)`, cents: -off, priced: true }] };
}
