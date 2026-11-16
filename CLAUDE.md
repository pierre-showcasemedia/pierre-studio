@AGENTS.md

# Studio

The back office (`/admin`) and client portal (`/portal`) of one real estate
photo and video business: magic-link sign-in, locked and unlocked galleries,
downloads, share links, revisions, approvals, bookings from the business's
website, Stripe invoices, shooter pay and the team side that delivers it all.
Next.js 16 App Router + Tailwind v4, Neon Postgres + Drizzle, Cloudflare R2,
Resend. How it fits together: `STUDIO.md`.

Every business detail is in `src/lib/business.ts` and `src/lib/brand.ts`;
the prices are `src/lib/booking-pricing.ts`, an exact copy of the website's
`src/lib/pricing.ts`. A new business is those files, its logos and colors,
and its own accounts' env vars.

## Rules

1. **Everything lives in the business's own accounts** (Vercel, Neon, R2,
   Resend, Stripe, GitHub). Never deploy it on anyone else's account.
2. **No secrets in the repo, ever.** No keys, tokens, connection strings,
   webhook ids or account ids in code, comments, docs or commits. Real values
   live in the business's Vercel env vars and an untracked `.env.local`.
   `.env.example` lists names only. Search for secrets before every push.
3. **Vercel framework preset must be `nextjs`.**
4. **Push to `main` = production** once the Vercel project exists. Before every
   push: `npm run typecheck`, `npm run lint`, `npm run build` and every
   `scripts/check-*.ts` must pass.
5. **Schema changes go through the migrate route.** Add idempotent DDL to
   `src/app/api/portal/migrate/route.ts`, mirror it in `src/db/schema.ts`,
   deploy, then POST to `/api/portal/migrate` with the `x-migrate-token`
   header. Never hand-edit the production database.
6. **Downloads unlock only on a processor's success event** (Stripe
   `invoice.paid`) or an admin's Mark paid. Never on a client-side redirect.
7. **Delivery emails are never automatic.** Automated texts and emails stay
   off until the business turns them on; respect `business.neverMessage`.
8. **Real prices only.** Never invent a price: an unknown one is a quote and
   reads "Quoted". Prices change in the website's `pricing.ts` and this
   repo's copy together, with `PRICING_VERSION` bumped.
9. **NDA listings** are never posted, shared, demoed or used in marketing.
10. **Never touch email DNS records** (MX, SPF, autodiscover).

## Client-facing copy

- Say the business's name (`brand.name`, then `brand.shortName`). Plain and
  warm, short sentences.
- No em dashes or double hyphens. Ranges read "24 to 48 hrs".
- Never mention AI, editing software or any vendor.
- Sentence case for buttons and links. No emoji, no exclamation marks.
- Emails sign off with `brand.signOff`.
- Design tokens are at the top of `src/app/globals.css`.
