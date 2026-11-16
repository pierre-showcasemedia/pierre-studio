## Paying shooters

The **Shooter pay** section of Reports lists every shoot a shooter was on in the date range, with their pay, and downloads as a CSV for payroll.

- A shoot counts when the shooter is on the booking and its shoot date is in the range. Canceled bookings are left out. Return trips, pickups and reshoots count too.
- Pay is set in the studio's settings (`business.shooterPay`) one of two ways: a rate per shoot for each shooter (with optional rates by job type), or a share of what each booking has collected (`percentOfCollected`). A shooter's own rate wins over the share.
- With a share, pay follows the money: a booking's paid invoices, add-on invoices included, net of refunds. A booking not paid yet shows **Not collected** and joins the total once it is paid. Return trips are part of the booking's pay.
- A shoot with no rate and no share shows **No rate** and stays out of the total. Add the rate, then download again.
- Check the list against the calendar before paying: the shooter on the booking is the one who gets paid.
