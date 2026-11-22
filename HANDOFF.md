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
- **showcasemedia.pro is registered at Porkbun, and its DNS and email are
  there too** (mailboxes pierre@ and mediahero@). Today the domain forwards
  to his old domain, pierrestephenson.com, which points at his Framer site.
  Hosting moves to Vercel; the domain, DNS and email stay at Porkbun.
  Before any DNS change, export or screenshot the whole zone. Nothing in this list changes an email
  record (MX, SPF, autodiscover) and nothing adds a receiving MX on the root.
  The domain switches happen on Call 2 with Pierre watching.

**Call 2: Sunday Nov 22, 2:00 pm Central (20:00 UTC)**, offered Nov 22 16:31 UTC, waiting for Pierre to confirm (Friday Nov 20 was missed).

**What is set up (status Nov 19 2026)**

| Account | Where | State |
|---|---|---|
| GitHub | `pierre-showcasemedia/pierre-site` and `pierre-showcasemedia/pierre-studio` | Claude GitHub App installed on both (Nov 18). Both repos public (Hammad: fine for now) and pushed: studio `b997ffe`, website `a21b6ca` or newer |
| Vercel | Team "Showcase Media LLC" | build@ accepted (Nov 16) |
| Cloudflare | Pierre's account (R2 storage only; DNS stays at Porkbun) | build@ accepted; R2 switched on (Nov 16) |
| Porkbun | Domain, DNS and email for showcasemedia.pro | Logins ready on Call 2 |
| Resend | Team "showcasemedia" | build@ accepted (Nov 16) |
| Formspree | Form "Booking requests" | ID `mjywydge` (not secret) |
| Payments | Wave today | **Open: how to connect Wave (REM Academy team)**. The studio runs on manual payments |
| Quo | His business number | Not invited on purpose (a paid seat) |

**Facts for this studio (his current site, Nov 17 2026)**

- Showcase Media LLC, Pierre Stephenson, M.Photog., Cr., FAA certified drone
  pilot. Studio at 3315 Ambassador Dr, Madison, WI 53718. Public contact on
  his site and price sheets: mediahero@showcasemedia.pro, (608) 345-2123.
  The studio's reply-to (`supportEmail`) and his admin login (`ADMIN_EMAILS`)
  are pierre@showcasemedia.pro.
- **America/Chicago** (Central). Serves Greater Madison, Dane County,
  Wisconsin and Northern Illinois. No travel fee within 25 miles of Madison
  and Sun Prairie; farther, $0.50 a mile round trip (Pierre confirms it from
  the address). HomeTeam4U's agreement says 30 miles.
- Cancellation or reschedule with less than 24 hours notice: 50%, plus any
  travel fees if he is already on the way (in the website's booking terms).
- Payment: `payments: "manual"`. Every booking gets an invoice in the studio;
  Pierre invoices in Wave as today and presses **Mark paid** when it is paid,
  which unlocks the gallery.
- Editing: `editing: "manual"` (Showcase editing is his own): he uploads
  finished photos on the listing page. The studio never calls an editing
  service.
- Turnaround: 24 hours, 48 hours guaranteed; walkthrough videos 48 hours.
- Prices: his Nov 2026 price sheet PDF, plus Showcase Photography ($175) and
  the drone and 3D tour prices on their own from his current site. The same
  file in both repos (`src/lib/booking-pricing.ts` here = the website's
  `src/lib/pricing.ts`, `scm-v2-2026-11-17`). Sizes break at 1,200 / 2,500 /
  3,000 / 5,000 / 7,500 / 10,000 sq ft; the free floor plan's large-property
  fee ($30 / $50 / $75) is added as its own invoice line.
- **Agent rates are private** and live only here, in `src/lib/agent-rates.ts`
  (never in the shared price file, which ships in the website's code):
  - **Stark Preferred** (Stark Company Realtors): Basic Photos $150 (25
    images, floor plan extra), Showcase Photography $169 (40 images), extra
    images $4, aerial photos $69, aerial video $130, aerial bundle $195,
    Matterport by scanned sq ft $125 / $150 / $200 / $300, Showcase
    Walkthrough $175, Complete Walkthrough $225 / $255 / $280 / $310, agent
    guided tour $69, advanced imaging $30 a clip, virtual staging $30 / $25,
    virtual twilight $20 / $15, free floor plan to 3,000 sq ft then $30 / $50
    / $75.
  - **Preferred Agent**: the same without the Basic package (Preferred
    Showcase Photography $169, aerial video $130, aerial bundle $195).
  - **HomeTeam4U** (a Stark agency): the Walkthrough Packages come first,
    $464 / $514 / $640 / $865 (to 1,200 / 3,000 / 6,000 / 7,999 sq ft), extra
    images $3, twilight $125, advanced imaging $30, virtual staging $30 / $25,
    virtual twilight $20 / $15, travel free to 30 miles. Without a package
    they order a la carte at the Stark Preferred rates.
  The website books everyone at the public rates. For these agents Pierre
  edits the invoice to their rate in the studio before sending it.
- **Billing:** Stark and HomeTeam4U have a card on file; Pierre charges it in
  house before delivery, then presses **Mark paid**. Everyone else: a Wave
  invoice as today, then **Mark paid**.
- **Shoot days and hours:** Monday to Friday, starts from 9:30 AM to 4 PM,
  every time approved by Pierre. Earlier, later and weekends by special
  request (he books those by hand). In the studio this is one setting,
  `schedule` in `src/lib/business.ts`: `dayStart` is the earliest start and
  `dayEnd` the latest start. **To shift with the seasons**, change `dayEnd`
  (for example "17:00" in summer) and push: it is live in about a minute.
  The website's booking form asks only for a date and a time of day, and
  says Pierre confirms every time, so it needs no change.
- **Editing:** Fotello today, AutoHDR soon, then Pierre finishes the edit
  himself, so the studio is on `editing: "manual"`. When his AutoHDR API app
  is ready: paste `AUTOHDR_CLIENT_ID` and `AUTOHDR_CLIENT_SECRET` in Vercel
  and set `editing: "autohdr"`.
- **Galleries today: Pic-Time** (showcasemediallc on pic-time.com). After
  go-live new galleries are delivered from this studio; Pic-Time stays as it
  is for his existing galleries (old galleries are not migrated).
- **His computer:** Mac. **Never-message list:** none.
- **Later options:** his animated logo (ShowcaseMediaAnimate01.mp4, sent Nov
  17) is not used yet; and the website has a slot for the homepage hero
  video he is making (see the website's `HANDOFF.md`).

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
2. Porkbun, showcasemedia.pro, DNS: add that CNAME for `portal`. Touch
   nothing else (the nameservers stay at Porkbun: his email is there).
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

Whether and how to connect Wave is an open scope question for the REM Academy team. If Pierre
moves to Stripe instead, set `payments: "stripe"` in `src/lib/business.ts`
and add Stripe: `STRIPE_SECRET_KEY`,
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

Two contract photographers shoot for Pierre: **Olesya Juodsnukis**
and **Clinton Cunanan** (their emails are in Pierre's Nov 17 answers, not in
this public repo). He pays them by Venmo today and moves contractor
payroll to his accountant in 2027. After go-live, add each one in the admin
(Settings, Add someone) as a **Creative specialist**. Their pay rates were not
given, so the Shooter pay report shows **Rate not set** for their shoots
until Pierre gives a per-shoot rate (`business.shooterPay.perShoot`, or
`percentOfCollected`). Never put in a made-up rate.

## 12. Editing

The studio is on `editing: "manual"` (Fotello, soon AutoHDR, then Pierre
finishes the edit): he drops the finished photos on the listing page
(Listings, the listing, **Upload photos**). They land as Internal only; he
checks them, makes them Client visible or presses Publish, then sends the
delivery email. AutoHDR can be connected later (see the facts above).

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

Today showcasemedia.pro forwards to pierrestephenson.com, his Framer site.

1. Export the Porkbun DNS zone first (or screenshot every record).
2. Website project, Domains: add `showcasemedia.pro` and
   `www.showcasemedia.pro`.
3. Porkbun: turn off the domain forwarding for showcasemedia.pro, then point
   the root and `www` at Vercel exactly as Vercel shows (records only; the
   nameservers stay at Porkbun). **Every email record stays as it is**
   (Porkbun email for pierre@ and mediahero@), plus `portal`, `send` and `resend._domainkey`
   from steps 7 and 8.
4. Send Pierre a test email from another account and check it arrives; book
   once more from the live site.
5. Keep the Framer site and pierrestephenson.com until the new one has been
   live for a week.

---

Afterwards Pierre can remove the build email from GitHub, Vercel, Cloudflare
and Resend in one click each.

## Go-live check Nov 19

One line per request or promise, from every build@ thread with Pierre (Nov 13
to Nov 18) and the build. Missing blocks the "you're ready" email.

| # | Request or promise | Status |
|---|---|---|
| 1 | Website and back office in Pierre's own accounts (GitHub, Vercel, Cloudflare R2, Resend, Neon) | Built and verified (code); accounts switch on during Part 3 and the call |
| 2 | Public prices from the Nov 2026 price sheet, "Quoted" where there is no price | Built and verified in code (`scm-v2-2026-11-17`, both repos byte-identical, 43 + 738 checks). Not re-read against the PDFs today: Dropbox is blocked from this machine |
| 3 | Agent rates (Stark Preferred, Preferred Agent, HomeTeam4U) private, never on the site | Built and verified (only in `src/lib/agent-rates.ts`; none in the website code) |
| 4 | HomeTeam4U: Walkthrough Packages first, a la carte at Stark rates | Built and verified |
| 5 | Stark and HomeTeam4U card on file, charged in house before delivery | Built and verified (billing note on both rate cards; manual Mark paid) |
| 6 | Payments stay in Wave, Mark paid unlocks the gallery | Built and verified (`payments: "manual"`). Connecting Wave: New scope (REM Academy team) |
| 7 | Shoot days Mon to Fri, starts 9:30 AM to 4 PM, every time confirmed; weekends and other times by request | Built and verified (`schedule`, site and booking copy) |
| 8 | Seasonal hours are one setting | Built and verified (`schedule.dayEnd`) |
| 9 | Editing: Fotello then his own finish; AutoHDR later | Built and verified (`editing: "manual"`); AutoHDR: Agreed later (Pierre, when his API app is ready) |
| 10 | Two contract photographers | Agreed later (us, after go-live: add as Creative specialists) |
| 11 | Photographers' pay per shoot | Agreed later (Pierre, optional; report shows Rate not set until then) |
| 12 | Never-message list | Built and verified (none) |
| 13 | High-resolution black and white logos in both | Built and verified (2400 px wide, both repos) |
| 14 | Instagram, Facebook, YouTube links | Built and verified (on the site) |
| 15 | Pic-Time stays for past galleries; new galleries from the studio | Built (nothing migrates). A "Past galleries" link to his Pic-Time page is built behind `site.pastGalleries.show` in the website, off by default (Nov 20). **Missing:** Pierre's yes or no (ask on the call) |
| 16 | Homepage hero video slot | Built and verified (slot ready; `scripts/add-hero-video.mjs` in the website does the rest in one command). Pierre sent five versions Nov 20 by Dropbox. **Missing:** the files here (Dropbox downloads go to a random `*.dl.dropboxusercontent.com` host the network refuses; Hammad puts the original and Dark30 in Drive, or allows that wildcard in Settings), then Pierre's pick on the call |
| 17 | Animated logo | Agreed later (option, unused) |
| 18 | Video collection with his YouTube films | Built and verified (`/work/video`; thumbnails fixed Nov 18) |
| 19 | Domain and email stay at Porkbun; forwarding stays on until the new site is ready | Built and verified (runbook Part D is last; no email record changes) |
| 20 | Hosting on Vercel, nothing else to buy | Done by Pierre (Part 3 Step 1, Nov 20); check on the call that both projects deployed and the team is on Pro |
| 21 | Formspree form `mjywydge` | Built but needs a setting (`NEXT_PUBLIC_FORMSPREE_ID`, Part 3) |
| 22 | Bookings actually send | Built but needs a setting: `NEXT_PUBLIC_BOOKING_TEST_MODE=false`. **The Part 3 email did not list it**; runbook step 11 adds it on the call |
| 23 | Part 3 switch-on steps (Vercel, Neon, secrets, R2, Resend, website settings) | Steps 1 (Vercel projects) and 2 (Neon) done by Pierre Nov 20. Steps 3 to 5 (secrets, studio settings with R2 and Resend, website settings) not reported yet |
| 24 | Portal address, Resend domain, migrate and sign-in, test booking to a delivered gallery | Agreed later (on the call, runbook Parts B and C) |
| 25 | Quo key emailed Nov 13 never used | Built and verified (not in the code or settings; a new key only if the webhook is wanted) |
| 26 | Turnaround 24 hours, 48 guaranteed; cancellation terms | Built and verified |
| 27 | Pierre's onboarding form answers | **Missing:** we can't see them (Nov 16 email), so they are not checked against the build |
| 28 | Call 2 time, meeting link and calendar invite (now Sunday Nov 22) | **Missing:** Hammad sends the time (Pierre asked for Sunday morning Central, Nov 21 18:56 UTC). Hammad offered 2:00 pm Central on Nov 22 (16:31 UTC), without a meeting link; send the Meet link and a calendar invite once Pierre confirms. Friday's invite did reach him (he waited in the Google Meet) |
| 29 | Pierre can edit the site's content himself | Agreed (Hammad, Nov 21): bring the questions to the call; show him `src/config/site.ts`, `src/data/projects.json` and the README's plain-English commands |

## Open items

- Payments through Wave: an open question for the REM Academy team.
- After go-live: add Olesya Juodsnukis and Clinton Cunanan as Creative specialists; their pay
  rates if he wants the Shooter pay report to total their pay.
- Later: the homepage hero video (he is making it) and, optionally, his animated logo.
