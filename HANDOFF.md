# Handoff: switching Showcase Media's studio on (Call 2)

The order to put Showcase Media's studio (**portal.showcasemedia.pro**) and
website (**showcasemedia.pro**) live, from zero, in **Pierre's own
accounts**. Each step can be checked before the next one starts. The website
repo has its own `HANDOFF.md` for the site itself; this file covers the
studio and where the two meet.

**The rules for every step**

- Every account is Pierre's, made with his business email and his password.
  He invites the build email where help is needed. Invites only: nobody ever
  sends a password, an API key or a token by text, email or chat.
- Keys and secrets are pasted by Pierre straight into Vercel (Project,
  Settings, Environment Variables). They are never written in the code, the
  docs, a commit or a chat. `.env.example` lists the names.
- Pierre emailed a Quo API key on Nov 13. It is treated as exposed: it is
  never used, and a new one is made on Call 2 only if the Quo webhook is
  wanted (step 13).
- **Where showcasemedia.pro is registered and where its DNS lives is not
  confirmed yet** (his site is built on Framer). Before any DNS change,
  export or screenshot the whole zone. Nothing in this list changes an email
  record (MX, SPF, autodiscover) and nothing adds a receiving MX on the root.
  The domain switches happen on Call 2 with Pierre watching.

**What is set up (status Nov 16 2026)**

| Account | Where | State |
|---|---|---|
| GitHub | `pierre-showcasemedia/pierre-site` and `pierre-showcasemedia/pierre-studio` | Invites accepted. Both repos are public and empty (Hammad: fine for now). **Pushes are refused until the Claude GitHub App is installed on the pierre-showcasemedia account** |
| Vercel | Team "Showcase Media LLC" | build@ accepted (Nov 16) |
| Cloudflare | Pierre's account (DNS and R2 Admin) | build@ accepted (Nov 16); R2 to switch on if not yet |
| Resend | Team "showcasemedia" | build@ accepted (Nov 16) |
| Formspree | Form "Booking requests" | ID `mjywydge` (not secret) |
| Payments | Wave today | **Open: how to connect Wave (ask Jacob)**. The studio starts on manual payments |
| Quo | His business number | Not invited on purpose (a paid seat) |

**Facts for this studio (so far)**

- Showcase Media LLC, Pierre Stephenson, M. Photog., Cr. Contact
  pierre@showcasemedia.pro, (608) 345-2123.
- Time zone set to **America/Chicago** (Central), assumed from his 608
  number: **to confirm**, with his city and the area he covers.
- Payment: `payments: "manual"`. Every booking gets an invoice in the studio;
  an admin presses **Mark paid** when the Wave payment arrives, and that
  unlocks the gallery.
- Prices: none yet. They go in the website's `src/lib/pricing.ts` and the
  same file here (`src/lib/booking-pricing.ts`); anything without a price
  reads "Quoted".

---

## 1. GitHub (5 min)

Both repos' `main` are pushed by the build after approval. From then on,
**push to `main` = live**.

## 2. Vercel (15 min)

1. Pierre's Vercel team on **Pro** (the studio's minute cron needs Pro).
2. Add New Project, import `pierre-showcasemedia/pierre-studio`. Framework
   preset **Next.js** (check it says `nextjs`), Node 22. Deploy (demo mode
   until the database is connected; that is fine).
3. Add New Project, import `pierre-showcasemedia/pierre-site`. Framework
   preset **Next.js**. Deploy.

## 3. Database: Neon from Vercel Storage (5 min)

Studio project only: Storage, Create Database, **Neon** (Postgres), connected
for Production and Preview. Vercel adds `DATABASE_URL`. Never connect it to
the website project.

## 4. The studio's own secrets (5 min)

`openssl rand -hex 32` three times (or any password generator making 64
random characters), each pasted by Pierre straight into the studio project's
Environment Variables (Production and Preview):

| Name | What it guards |
|---|---|
| `AUTH_SECRET` | Sign-in links and session cookies |
| `MIGRATE_TOKEN` | The migrate route, the admin API and the operator routes (the `x-migrate-token` header) |
| `CRON_SECRET` | The minute cron |

Also `ADMIN_EMAILS` = the email Pierre signs in with. Redeploy.

## 5. Run the migrate route (2 min)

```bash
curl -X POST "https://<studio project>.vercel.app/api/portal/migrate" -H "x-migrate-token: <MIGRATE_TOKEN>"
```

It answers `{ ok: true, ... }`. Safe to run again. Then the health check:

```bash
curl "https://<studio project>.vercel.app/api/studio/health" -H "x-migrate-token: <MIGRATE_TOKEN>"
```

## 6. Storage: Cloudflare R2 (15 min)

1. Pierre's Cloudflare, **R2 Object Storage**, create a bucket (for example
   `showcase-media-studio`). Cloudflare asks for a card before R2 turns on
   (free up to 10 GB).
2. Bucket, Settings, **CORS policy**:

   ```json
   [
     {
       "AllowedOrigins": ["https://portal.showcasemedia.pro", "https://<studio project>.vercel.app"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

3. R2, Manage API tokens, **Create API token**: Object Read and Write, this
   bucket only. Pierre pastes `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` into the studio project.

## 7. The portal address: portal.showcasemedia.pro (Call 2, 10 min)

1. Studio project, Settings, Domains: add `portal.showcasemedia.pro`.
   Vercel shows one **CNAME**.
2. Wherever showcasemedia.pro's DNS lives (Cloudflare if the domain is on
   it; otherwise the registrar or Framer): add that CNAME for `portal`. On
   Cloudflare, set it to **DNS only** (grey cloud). Touch nothing else.
3. When Vercel shows it valid, open https://portal.showcasemedia.pro.

## 8. Email: Resend on showcasemedia.pro (Call 2, 15 min)

1. Pierre's Resend (team "showcasemedia"), Domains, **Add domain**
   `showcasemedia.pro`.
2. Add Resend's records exactly as shown: they sit on
   **`send.showcasemedia.pro`** (an MX and an SPF TXT for bounces, on that
   subdomain only) and **`resend._domainkey.showcasemedia.pro`** (DKIM).
   **Do not change the root MX, the root SPF or any other email record.**
3. Verify in Resend, create a sending API key; Pierre pastes it as
   `RESEND_API_KEY`.
4. `EMAIL_FROM` is already `Showcase Media <portal@showcasemedia.pro>` in
   `src/lib/business.ts` (no mailbox needed). Replies go to
   pierre@showcasemedia.pro. Redeploy.
5. Sign in at https://portal.showcasemedia.pro/portal/login with Pierre's
   email: the link arrives from portal@showcasemedia.pro and he lands in
   `/admin`.

## 9. Payments (open)

The studio starts on **manual** payments: no processor keys are needed.
Pierre invoices in Wave as today; when a client pays, he presses **Mark
paid** on the invoice in the admin, and that unlocks the gallery. Downloads
never unlock on anything else.

Whether and how to connect Wave is a scope question for Jacob. If Pierre
moves to Stripe instead, set `payments: "stripe"` in `src/lib/business.ts`
and add Stripe as in the Guthrie and JSP handoffs: `STRIPE_SECRET_KEY`,
then a webhook to `https://portal.showcasemedia.pro/api/portal/stripe-webhook`
with `invoice.paid`, `invoice.payment_failed`, `invoice.voided`,
`invoice.marked_uncollectible`, `invoice.finalized`, `invoice.updated` and
`charge.refunded`, its signing secret as `STRIPE_WEBHOOK_SECRET`.

## 10. Website to studio: the booking intake (10 min)

1. `openssl rand -hex 32` once more; Pierre pastes the same value as the
   studio's `BOOKING_INTAKE_SECRET` and the website's `STUDIO_INTAKE_SECRET`.
2. Website: `STUDIO_URL` = `https://portal.showcasemedia.pro`,
   `NEXT_PUBLIC_PORTAL_URL` = `https://portal.showcasemedia.pro`.
3. **Formspree**: `NEXT_PUBLIC_FORMSPREE_ID` = `mjywydge` on the website.
   Then `NEXT_PUBLIC_BOOKING_TEST_MODE=false`. Redeploy both.

## 11. Shooter pay

If Pierre works with other shooters: their rate in `business.shooterPay`
(`perShoot`, or `percentOfCollected` for a share of what each booking
collects). Unknown so far.

## 12. Editing (10 min)

The studio starts on `editing: "autohdr"` from the template. **To set from
his answer:** if he edits himself or uses an editor, switch to
`editing: "manual"` (finished photos go on the listing page). If he uses
AutoHDR, he creates an API app in his own AutoHDR account and pastes
`AUTOHDR_CLIENT_ID` and `AUTOHDR_CLIENT_SECRET`.

## 13. Quo (optional, 10 min)

The studio only reads Quo; it never texts. Optional: the Quo webhook
(`QUO_WEBHOOK_SECRET`, `QUO_API_KEY`) files client texts as revision
requests. Only with a **new** key Pierre creates on the call (the emailed one
is never used). Automated texts and emails stay off until Pierre turns them
on.

## 14. A test booking (30 min)

Use a second email of Pierre's as the client.

1. Book on the website's /book: a package and an add-on. The Bookings page
   shows it within the minute, priced the same as the website.
2. **Confirm time**.
3. **Upload** 10 to 20 finished test photos on the listing page, make them
   Client visible, then **Send delivery email** (preview first). The gallery
   is watermarked until **Mark paid**; then downloads open.
4. **Clean up:** remove the test booking with the admin API
   (`{ "op": "deleteBooking", "bookingId": "...", "deleteClient": true }`).

## 15. The website on showcasemedia.pro (Call 2, last)

Today showcasemedia.pro is his Framer site.

1. Export the DNS zone first (or screenshot every record).
2. Website project, Domains: add `showcasemedia.pro` and
   `www.showcasemedia.pro`.
3. Point the root and `www` at Vercel exactly as Vercel shows. **Every email
   record stays as it is**, plus `portal`, `send` and `resend._domainkey`
   from steps 7 and 8.
4. Send Pierre a test email from another account and check it arrives; book
   once more from the live site.
5. Keep the Framer site until the new one has been live for a week.

---

Afterwards Pierre can remove the build email from GitHub, Vercel, Cloudflare
and Resend in one click each.

## Open items

- Claude GitHub App on the pierre-showcasemedia account, so the code can be pushed.
- His price list, logo files, best photos, city and service area (the website
  waits on these; the studio's brand.ts and prices too).
- Where showcasemedia.pro is registered and where its DNS is.
- Payments through Wave: ask Jacob.
- Time zone (Central assumed), shoot hours and days, editing path, any other
  shooters, anyone who must never get an automated message.
- Mac or Windows (the card-ingest and Dropbox tools need a Windows pass if Windows).
