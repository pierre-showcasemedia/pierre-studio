# Studio

The back office and client portal for a real estate photo and video
business. The admin at `/admin` runs bookings, shoots, editing, QC, delivery,
payments, reports and the team; the client portal at `/portal` is where agents
sign in with a magic link, see their listings, preview galleries (watermarked
until paid), download once payment clears, share a view-only link, request
revisions and approve. The business's website posts every booking into it.

This is **studio-universal**: the studio with no business in it. A buyer's
studio is a copy with four things set (below). Stack: Next.js 16 App Router,
React 19, TypeScript, Tailwind 4, Node 22, Neon Postgres + Drizzle, Cloudflare
R2, Resend, Stripe.

Without `DATABASE_URL` the app runs in **demo mode** with sample data (clearly
labelled, plain sample frames for photos), so the whole UI can be reviewed with
no accounts. Demo mode hands the sign-in link straight back on the login page.

## A new buyer: what to set

| What | Where | From |
|---|---|---|
| Name, legal name, owner, city, region, contact email and phone, website and portal URLs, time zone, payment method, editing path, turnaround, never-message list, shooter pay rates, scorecard person | `src/lib/business.ts` (set `TEMPLATE = false`) | the website's `src/config/site.ts` and the buyer's answers |
| Logos and watermark | `public/brand/logo-dark.png`, `logo-white.png`, `watermark.png`, `src/app/icon.png`, `src/app/apple-icon.png`; the ratio in `src/lib/brand.ts` | the website's `public/brand` |
| Colors and fonts | the tokens at the top of `src/app/globals.css`; fonts in `src/app/layout.tsx` | the website's tokens |
| Prices | `src/lib/booking-pricing.ts`: an exact copy of the website's `src/lib/pricing.ts` | the website |
| Secrets | the buyer's own Vercel env vars, pasted by the buyer (names in `.env.example`) | never in the repo |

Then run every check (below). `scripts/check-business.ts` fails while any
placeholder is left, `scripts/check-pricing.ts` fails unless the price file is
identical to the website's.

## Architecture

## Architecture

| Piece | What it does | Where |
|---|---|---|
| Next.js 16 App Router + Tailwind v4 | UI and API routes, Node runtime on Vercel | `src/app` |
| Neon Postgres + Drizzle | `clients → listings → media`, `invoices`, `downloads`, `revision_requests`, `shoots`, `shoot_files`, `activity` | `src/db/schema.ts`, DDL in `src/app/api/portal/migrate/route.ts` |
| Magic-link auth (Resend + jose) | one-time 15 min login token emailed (random, SHA-256 at rest in `login_tokens`, consumed on first use), 30 day httpOnly session JWT; the login request is rate limited per email and per address (`rate_limits`); `verify` honours the `next` bound to the token only when it normalizes to a `/portal/` path (dot segments, raw or percent-encoded, are refused); `src/proxy.ts` sends signed-out requests for `/admin` and `/portal` to the sign-in page. | `src/lib/portal-auth.ts`, `src/lib/session-token.ts`, `src/lib/login-tokens.ts`, `src/lib/rate-limit.ts`, `src/proxy.ts`, `src/app/api/portal/{login,verify,logout}` |
| Cloudflare R2 | raw uploads, originals, derivatives (`thumb`, `preview`, `-wm`, `mls`), zip bundles | `src/lib/r2.ts`, `src/lib/media-keys.ts`, `src/lib/derivatives.ts` |
| Payment gate | downloads mint a 10 min signed URL only if the session owns the listing AND it is unlocked AND the frame is QC-approved | `src/app/api/portal/download`, `bundle`, `dropbox-manifest` |
| Stripe webhook | every delivery recorded in `payment_events` first, matched by `metadata.invoice_id` then the Stripe id then the legacy street match; `invoice.paid` unlocks through `applyPaid`; another environment's invoice is only recorded (see "Stripe webhook events") | `src/app/api/portal/stripe-webhook` |
| Titus webhook (step two) | HMAC on the raw body, `payment_events` first, `checkout.updated` with `succeeded` unlocks through `applyPaid`; stale deliveries act only through a provider read; a `succeeded` for a checkout the row no longer holds settles the row with it and cancels the newer checkout at Titus (one money-free hub line if Titus refuses); a second `succeeded` from another checkout on a paid row is flagged as a duplicate funding; a row that has since moved to card (Switch to card) is never settled, moved or retired by a Titus event: a funded checkout or a completed refund is one money-free hub line for a human, anything else is only noted | `src/app/api/portal/titus-webhook` |
| Payments core (step two) | `applyPaid` (one CTE), `closeProviderObject`, `syncInvoiceFromProvider` (env-scoped, throttled 30 s; a Titus 404 is noted, never treated as a cancel; only the pay at close button's own POST resets after two of its own misses, and only an `open` row), `reconcileInvoices`, `markPaidManually` (refuses before closing anything unless the row is `needs_quote | open | processing | review | uncollectible`), `retireSupersededTitusCheckout` | `src/lib/payments.ts` |
| Booking intake | website booking → client, listing, booking, invoice, activity, jobs in one batch; duplicate and revision rules; re-prices from the website's selection with the same price table | `src/app/api/studio/bookings`, `src/lib/booking-intake.ts`, `src/lib/booking-pricing.ts`, `src/lib/studio-pricing.ts` |
| Job queue | every booking side effect as a `jobs` row: leased drainer, `2^attempts` backoff, dead at 8, one Slack alert; drained in `after()` and by the cron; `env` keeps preview and production apart | `src/lib/jobs.ts`, `src/lib/jobs-core.ts`, `src/app/api/studio/jobs/drain` |
| Stripe invoice at booking | `stripe.invoice.create` job on the business's account: customer, send_invoice due 11:59 PM local the day it is issued, finalize, hosted link | `src/lib/stripe-invoice.ts` |
| Booking email | what we have, when, services, payment line, pay button; Resend with the job key as idempotency key. The studio emails only this (and its pay-link variants) and the delivery email: Stripe and Titus email the invoice and the receipt themselves, the pay page is the in-portal receipt | `src/lib/booking-email.ts` |
| Admin | dashboard, upload wizard, shoots + QC, listings grid, clients (+ "View as"), revisions, downloads, delivery email preview and send. Every page calls `requireAdmin()` (full admins) or `requireStaff()` (admins and the QA team) as its first statement: the layout's gate is not a boundary (Next renders layout and page concurrently, so a page that fetched first would stream its data into the 307 body). Roles: see "QA team and client visibility" | `src/app/admin`, `src/components/admin`, `src/lib/admin.ts` |
| Admin bookings (step two) | `/admin/bookings` list (upcoming first; filters upcoming, needs quote, unpaid, in review, stopped, all; search) and `/admin/bookings/<id>` with the form payload, the invoice (line items, provider link), the side-effect jobs and the history; actions: confirm time / reschedule, assign shooter, set amount, resend pay link, switch to card, mark paid, cancel, run job, and since Oct 21 2026 Edit booking (services, add-ons, property, access, launch, client, details; the invoice follows, see "Edit a booking after it comes in"); money renders only here | `src/app/admin/bookings`, `adminBookings` / `adminBooking` in `src/lib/admin-data.ts`, the bookings block of `src/app/admin/actions.ts`, `src/lib/booking-edit.ts` |
| Editing pipeline | state machine driven by `advanceShoot()` (immediate start on submit, admin "Run now", the status poll) with the cron as safety net: R2 → editing service → finished frames → R2 + media rows (QC pending, unpublished) → twilight → automatic QC → ready for review | `src/lib/pipeline.ts`, `src/lib/autohdr.ts`, `src/app/api/cron/pipeline` |
| Automatic QC (v1.2) | every frame goes to Claude with a strict JSON contract: score 1 to 10, issues by severity (block / fix / minor), suggestions, one-line summary; each issue is a checkbox on the frame; since Nov 3 2026 no issue rejects or hides a frame (see "The editors' photo flow") | `src/lib/qc.ts`, `src/lib/qc-labels.ts`, `src/components/admin/QcReport.tsx` |
| Publish gate (v1.2) | client sees a frame only when `qc_state='approved'` AND `published=true` AND its shoot has a `published_at`; the paths are Publish and, since Oct 2026, the explicit "Client visible" toggle. Admin and QA screens read every frame as "Client visible" or "Internal only" with a reason (`src/lib/visibility.ts`); `media.held` keeps a frame moved to internal by hand out of every later Publish | `src/lib/media-visibility.ts`, `src/lib/visibility.ts`, `src/lib/visibility-core.ts`, `publishShoot` in `src/app/admin/actions.ts` |
| Download / finals (v1.2) | zip of originals for local fixes; corrected JPGs come back by filename (replace or add), approved but unpublished until Publish; never sent to editing | `src/app/api/studio/shoots/[id]/download`, `.../finals/*`, `src/lib/finals.ts`, `src/components/admin/UploadFinals.tsx` |
| Slack | the hub webhook (`SLACK_WEBHOOK_URL`, never a dollar amount: `moneyFree()` throws) and, since step two, the private payments channel (`SLACK_PAYMENTS_WEBHOOK_URL`, amounts allowed) | `src/lib/slack.ts` |
| Activity log | who did what, read on the dashboard and listing pages | `src/lib/activity.ts` |
| Dropbox raw mirror (Oct 21 2026) | every raw photo and clip a shooter uploads is copied into the business's Dropbox under `/Listings/<address>/Raw/Photos` or `/Raw/Video` by one `dropbox.mirror` job per file, resumable across ticks; the admin connects Dropbox once on Settings (OAuth, refresh token in `settings`); raw video is its own upload box and never goes to editing; see "Dropbox raw mirror and video uploads" | `src/lib/dropbox.ts`, `src/lib/dropbox-mirror.ts`, `src/app/api/studio/dropbox/*`, `src/app/admin/dropbox-actions.ts` |
| Admin API | token-guarded data ops for scripts (`createListing`, `addMedia`, `setLock`, ...) | `src/app/api/portal/admin-api` |
| Push script | local JPGs and films → an existing listing with no browser and no R2 keys on the Mac: the "Add files" routes (`upload-urls`, streamed PUTs, `ingest`) with `x-migrate-token`, logged as `claude-token`; refuses NDA listings unless `--nda-ok` | `scripts/push-to-listing.mjs` |
| Upload script (legacy, superseded by the push script for adding files) | local folder → R2 originals + derivatives + zips → `addMedia` manifest; needs R2 keys locally | `scripts/upload-listing-media.mjs`, `scripts/make-derivatives.py` |
| Brand | the logos, the watermark mark, the design tokens, the fonts | `public/brand`, `src/app/globals.css`, `src/lib/brand.ts` |

Without `DATABASE_URL` the app runs in **demo mode** with sample data (clearly
labelled), so the whole UI can be reviewed with no accounts. Demo mode also
hands the sign-in link straight back on the login page ("Continue to the demo").

### Status vocabulary

Listings (`src/lib/listing-status.ts`, derived, not stored): Awaiting shoot (no
published media) → In the edit / In review (admin only, a shoot is moving) →
Awaiting payment (media, locked) → Delivered (unlocked) → Completed (client
approved).

Shoots (`src/lib/shoot-status.ts`): `draft` (wizard open) → `uploaded` →
`transferring` → `committing` → `processing` → `importing` → `twilight` →
`qc` (v1.2) → `ready_for_review` → `published`, or `failed` (retry from the
shoot page). Every v1.1 status keeps its meaning; `qc` is inserted before
review and a shoot that was mid-flight on v1.1 code simply picks it up.

### R2 key layout

```
shoots/<shootId>/raw/<safe filename>         raw uploads from the wizard (direct browser PUT or Dropbox import)
listings/<slug>/edited/<Street>-<NN>.jpg     finished frames pulled from editing (main gallery)
listings/<slug>/s/twilight/photos/<...>.jpg  virtual twilight frames ("Twilight" section)
listings/<slug>/photos/<file>                originals uploaded by the legacy script
listings/<slug>/video/<file>
listings/<slug>/d/<variant>/<name>.jpg       thumb | thumb-wm | preview | preview-wm | mls (derivativeKey drops the parent folder)
listings/<slug>/s/<section>/d/<variant>/...  derivatives of a section
listings/<slug>/rev/...                      revised deliverables (legacy script)
listings/<slug>/bundles/photos-full.zip | photos-mls.zip | photos-<section>.zip | photos-<section>-mls.zip
```

Zip bundles are still made by the legacy script only; the pipeline does not
build them yet (see TODO). The portal shows "Download all" only when the zip
exists, so per-file and "Download selected" work either way.



## Prices: one table, two repos

The website's `src/lib/pricing.ts` is the only place prices live. The studio's
`src/lib/booking-pricing.ts` is a byte-for-byte copy (so the same
`PRICING_HASH`), and `src/lib/studio-pricing.ts` is the studio's layer on top:
sizes, services and add-ons for the admin, `quote()` for invoices and
calendar durations, `fmtDollars`, `isVideoBooking`.

- The website sends the home's size as `package`, the selection as `items`
  (`[{ id, qty, option }]`), the area, the client type, its total and the
  table's hash. The studio re-prices every booking itself; a different total,
  a different hash, a quoted size or item, or an unknown id makes the invoice
  wait as Needs quote for a person to set the amount.
- A booking row keeps the size and the package or service in `service_ids`
  (size first), the add-ons in `addon_ids`, and the selection with quantities
  in `items`.
- To change a price: change the website's file, bump `PRICING_VERSION`, copy
  it over this one, run `npx tsx scripts/check-pricing.ts` (with `SITE_DIR`
  pointing at the website checkout), push both.
- Never invent a price. An unknown price is `{ kind: "quote" }` and reads
  "Quoted".

## Payments

- `business.payments = "stripe"`: every booking gets a Stripe invoice on the
  buyer's own account (the `stripe.invoice.create` job). The webhook at
  `/api/portal/stripe-webhook` records every event in `payment_events` and
  `invoice.paid` marks the invoice paid and unlocks the gallery
  (`applyPaid` in `src/lib/payments.ts`).
- `"manual"`: no processor. A person presses Mark paid when the money is in,
  and that unlocks the gallery.
- Downloads unlock only on a processor's success event or an admin's Mark
  paid, never on a page the client lands on.
- Pay at close through Titus stays off unless `business.payAtClose` is true
  and the Titus env vars are set.
- Money shows in the admin, the payments Slack channel, the reports and the
  CSVs, nowhere else (`moneyFree()` throws before a hub post carries an amount).

## Shooter pay

Reports → Shooter pay (`/admin/reports#pay`, CSV at
`/api/studio/reports/pay`): every shoot a shooter was on in the range
(bookings by shoot date, canceled ones left out, additional shoots included
when `business.shooterPay.countVisits`), with their pay. Rates are cents per
shoot by shooter email in `business.shooterPay.perShoot`, and optional
job-type rates in `byItem` (by package or service id, or `visit:<kind>`). A
shoot without a rate reads "Rate not set" and stays out of the total. The
read-only admin API op `shooterPay` returns the same bookings and visits for
scripts.

## Messages

Automated texts and emails stay off until the buyer turns them on
(`business.autoTexts`, `business.neverMessage`). The studio sends only the
booking confirmation, the magic sign-in link and what a person presses send
on (time emails, the delivery email). Quo is read only: the studio never
texts.

## The team

Roles: admins (`ADMIN_EMAILS` and the Settings page), the Photo QC team,
creative specialists (shooters who upload) and video editors. Every page,
server action and route calls its gate first (`src/lib/admin.ts`);
`scripts/check-qa-role.ts` audits every entry point. Team SOPs at
`/admin/sops` (`src/content/sops`), the operations scorecard at
`/admin/scorecard` (`business.scorecard`).

## Running it

```bash
npm ci
npm run dev        # demo mode without DATABASE_URL
npm run typecheck
npm run lint
npm run build
for f in scripts/check-*.ts; do npx tsx "$f" || echo "FAILED $f"; done
```

`scripts/check-roles-http.mjs` drives a running dev server
(`ADMIN_EMAILS=... npx next dev -p 3171`, then `node scripts/check-roles-http.mjs`).

`check-bundle-resume` runs `unzip -t` on a ZIP64 test zip. Debian's
`unzip` 6.00 reports a false "mismatching local filename" on a UTF-8 name
inside a ZIP64 entry, so that one line fails on Debian and Ubuntu machines
while Python's zipfile and macOS read the zip clean.

## Schema changes

Add idempotent DDL (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) to the list
in `src/app/api/portal/migrate/route.ts`, mirror it in `src/db/schema.ts`,
deploy, then POST to `/api/portal/migrate` with the `x-migrate-token`
header. Never hand-edit the production database.
