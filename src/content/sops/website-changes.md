## Changing prices

1. Change the website's `src/lib/pricing.ts` and bump `PRICING_VERSION`.
2. Copy the file over the studio's `src/lib/booking-pricing.ts`, word for word.
3. Run `npx tsx scripts/check-pricing.ts` in the studio. It fails if the two files differ.
4. Push both. Bookings already in keep their price; new ones use the new table.

> [!note] Never invent a price
> A price nobody has confirmed is a quote: it shows as Quoted and the booking waits for Set amount.
