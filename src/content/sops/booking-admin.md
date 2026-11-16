## A booking's page

Everything on /admin/bookings/<id>, top to bottom:

- **Status card:** requested, confirmed, shot, delivered or canceled, and the team's internal note (never shown to the client).
- **Confirm time / Reschedule:** sets the start time. The client gets the time email.
- **Assign shooter:** sends the calendar invite with the shoot brief.
- **Invoice:** the line items, the amount and the pay link. Set amount for a quoted booking, Resend pay link, Mark paid for a payment that came in another way.
- **Edit booking:** the size, services, add-ons and quantities, property details, access and the client's contact. The invoice follows the rules on the page: unpaid, it is reissued at the new amount; paid, added items go on a new invoice for the difference and removed ones are refunded by hand.
- **Additional shoots:** a return trip, a pickup, a reshoot or a twilight return on the same booking, each with its own time and shooter.
- **Cancel / Restore.**

> [!note] Quoted bookings
> A booking with a quoted size or item waits as Needs quote. Set amount issues the invoice.
