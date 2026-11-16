# Booking to payment

How a booking on the website becomes a paid, unlocked gallery in the studio.

## The flow

1. The client books on the website's `/book`. The website prices it with
   `src/lib/pricing.ts`, sends a backup to Formspree, and posts the booking to
   the studio: `POST /api/studio/bookings` with `x-intake-secret`
   (`BOOKING_INTAKE_SECRET` here = `STUDIO_INTAKE_SECRET` on the website).
2. The studio (`src/lib/booking-intake.ts`) writes the client, the listing,
   the booking, the invoice and the activity in one batch, re-pricing from
   the selection with the same table (`src/lib/booking-pricing.ts`). A
   repeat of the same submission is a duplicate; the same client, address
   and date within 24 hours is a revision of the booking.
3. Jobs run the side effects (`src/lib/jobs.ts`): the booking email, the
   Slack card, the calendar event and, with `business.payments = "stripe"`,
   the Stripe invoice (`stripe.invoice.create`).
4. A person confirms the time (Confirm time) and assigns a shooter. The
   client gets the time email; the shooter gets the calendar invite.
5. The shoot is uploaded, edited, QC'd, published and delivered by a person.
6. The client pays the Stripe invoice. The webhook's `invoice.paid` marks the
   invoice paid and unlocks the gallery. With `"manual"` payments a person
   presses Mark paid instead.

A booking waits as **Needs quote** when the price table has a quoted size or
item, the area needs a travel fee confirmed, the client type is quoted to the
project, the website's total or price-table hash differs from the studio's,
or an id is unknown. Set amount issues the invoice.

## What the website posts

```json
{
  "submission_id": "uuid",
  "source": "website",
  "client": { "name": "", "email": "", "phone": "", "company": "" },
  "client_type": "agent | homeowner | builder | other",
  "brokerage": "",
  "billing": "pay_first",
  "property": { "address": "street, city, ST zip", "access": "" },
  "service_area": "the area picked", "outside_area": false,
  "island": "(same as service_area)", "off_island": false,
  "time_window": "morning | midday | afternoon",
  "desired_date": "YYYY-MM-DD",
  "launch_date": "YYYY-MM-DD or null",
  "package": "the home's size id",
  "items": [{ "id": "", "qty": 1, "option": null }],
  "line_items": [],
  "total_cents": 0,
  "needs_quote": false,
  "quote_reasons": [],
  "pricing_version": "",
  "pricing_hash": "",
  "notes": "",
  "agreed_to_terms": true
}
```

The studio stores the size and the package or service in `service_ids`
(size first), the add-ons in `addon_ids`, the selection with quantities in
`items`, the client type in `client_type` and the area in `market`. The
website's total is only compared, never trusted.

## Stripe

- The invoice is created on the business's own Stripe account: a customer,
  `send_invoice` due the same day, finalized, with the hosted pay link in the
  booking email.
- Register the webhook at `/api/portal/stripe-webhook` for exactly these
  events: `invoice.paid` (the only path to an unlock), `invoice.payment_failed`,
  `invoice.voided`, `invoice.marked_uncollectible`, `invoice.finalized`,
  `invoice.updated` and `charge.refunded` (a full refund relocks the gallery).
  Every delivery is recorded in `payment_events` first.
- Preview and production never share a key, and an event for another
  environment's invoice is only recorded.

## Env names (values only in Vercel)

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BOOKING_INTAKE_SECRET`,
`RESEND_API_KEY`, `SLACK_PAYMENTS_WEBHOOK_URL`. The full list is
`.env.example`.
