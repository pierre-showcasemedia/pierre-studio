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

**Call 2: Sunday Nov 22, 2:00 pm Central (20:00 UTC), confirmed by Pierre** (Friday Nov 20 was missed).

**Review call (Nov 23, 54 min): Pierre's review of the preview site.** Done Nov 23:
the larger floor plan is an optional add-on by scanned size (prices `scm-v3`,
both repos); "free floor plan*" carries the 3,000 sq ft scanned condition
everywhere; booking form: brokerage required for agents, "How big is the
property?", acreage notes and a plat or lot map link, drone photos with the
Highlight Walkthrough Bundle, twilight next to virtual twilight, "How do we get
in?" and "Vacant or occupied?" (both required), "Notes and special requests",
no aerial infospots, his "Good to know" list (videos 48 to 72 hours, sales tax,
MLS); clean landing (his video and two buttons); "Ready in 24 hours" no longer
pushed; About is about the business with Pierre as founder, smaller portrait;
"Work" is "Portfolio", one mixed gallery; copyright "Created by Showcase Media.
All Rights Reserved."; travel "within 25 miles of our location on the east side
of Madison, near Sun Prairie"; service cards open their section on /services.

Still open from that call:
- **From Pierre:** the brokerage logos (for "Trusted by"), floor plan examples,
  Matterport and Zillow tour links, business portrait examples, new videos and
  virtual staging examples, his wording for the four boxes under the video and
  the page copy, a 40% hero version if he wants it, portraits and bios of his
  photographers (later).
- **New features promised on the call (check scope with the REM Academy team first):** a
  Pricing page behind a name-and-email form (leads list); its own page per
  service (seven or more) with pricing and examples; Google Maps address
  autofill and distance (needs a Google Maps key in Pierre's account); plat map
  file upload (the link works today).
- **Hammad:** remove the extra Vercel seat before handover; send Pierre the
  final switch-on instructions once he approves the site.

**Call 2 outcome (Nov 22, 15 min):**
- **Nothing client-facing goes live until Pierre approves.** He reviews the new site on its `.vercel.app` address first; the domain switch (step 15) and the portal address wait for his OK.
- **Galleries stay on Pic-Time** for the year he has paid (from July). Built Nov 22: each listing's Pic-Time link drives the portal and the delivery email (section 12b).
- **Switch-on without the domain:** Hammad sent Pierre a prompt for his own Claude covering Part 3 Steps 3 to 5, the CORS rule, migrate and health, and a private review of the site. It sets the website's `STUDIO_URL` and `NEXT_PUBLIC_PORTAL_URL` to the studio's `.vercel.app` address **temporarily**. When `portal.showcasemedia.pro` is set up, change both back and redeploy.
- **Sign-in waits for the Resend DNS records**, done with Hammad.
- **Open for Hammad:** an email to Pierre with two website options (A or B); remove the extra Vercel seat (build@, $20 a month) before handover; a studio gallery example from a real listing once the studio is switched on.

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
  `src/lib/pricing.ts`, `scm-v3-2026-11-23`). Sizes break at 1,200 / 2,500 /
  3,000 / 5,000 / 7,500 / 10,000 sq ft. The free floor plan covers up to
  3,000 sq ft of TOTAL scanned space, so (Nov 23) the larger floor plan is an
  optional add-on the client picks by scanned size ($30 / $50 / $75), never
  charged from the finished size; Pierre adds it to the invoice after the scan
  when a client didn't.
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

## 12b. Pic-Time galleries (Nov 22 2026)

Pierre keeps delivering on Pic-Time for the year he has paid. Each listing has
a **Pic-Time gallery** field (Listings, the listing, its settings).

- Paste the gallery's link there (an `https://...pic-time.com/...` address;
  anything else is refused) and save.
- The client's portal page then shows **Open your gallery**, which goes to
  Pic-Time. The studio's own photo grid shows only if photos were also
  published in the studio.
- **Send delivery email** works without any studio photos once the link is
  set. Its main button goes to the gallery, and any unpaid invoice still has
  its Pay button.
- Downloads and payment rules inside Pic-Time are set in Pic-Time as today;
  Mark paid in the studio settles the invoice.
- Client-facing wording never names Pic-Time.
- The column (`pictime_url`) comes with the migrate route; run it after the
  deploy, as for any schema change. `scripts/check-pictime.ts` checks it all.

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
to Nov 23) and the build. Missing blocks the "you're ready" email. Last re-run
Nov 25 (night): Pierre's tours, today's emails, the website pushes, the
Dropbox assets, the Vercel seat and his onboarding answers.

| # | Request or promise | Status |
|---|---|---|
| 1 | Website and back office in Pierre's own accounts (GitHub, Vercel, Cloudflare R2, Resend, Neon) | Built and verified (code); accounts switch on during Part 3 and the call |
| 2 | Public prices from the Nov 2026 price sheet, "Quoted" where there is no price | Built and verified in code: `main` has `scm-v3-2026-11-23` and `new-scope` has `scm-v4-2026-11-24` (same prices, empty travel bands, new optional fields). Both repos are byte-identical on each branch (site 49 checks, studio 739). Not re-read against the PDFs: Dropbox is blocked from this machine |
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
| 15 | Pic-Time for galleries (for the year he has paid) | Built and verified (Nov 22): each listing's Pic-Time link drives the portal and the delivery email (section 12b, `scripts/check-pictime.ts`); past galleries link built, off |
| 16 | Homepage hero video, clean landing, logo as sharp as his original | Built and verified: Pierre's Dark30 V2 with only two buttons over it (Nov 23). Re-encoded Nov 23 after he found the logo soft (website `ac2ab69`): AV1 and H.264 at 1920 wide, a 1280 file for phones; logo-area SSIM 0.92 to 0.97 against his original, was 0.79 to 0.88. Files are 20 to 52 MB (was 8.8). A 40% version: Agreed later (Pierre, if he sends one) |
| 17 | Animated logo | Agreed later (option, unused) |
| 18 | Video collection with his YouTube films | Built and verified (`/work/video`; thumbnails fixed Nov 18) |
| 19 | Domain and email stay at Porkbun; forwarding stays on until the new site is ready | Built and verified (runbook Part D is last; no email record changes) |
| 20 | Hosting on Vercel, nothing else to buy | Done by Pierre (Part 3 Step 1, Nov 20); check on the call that both projects deployed and the team is on Pro |
| 21 | Formspree form `mjywydge` | Built but needs a setting (`NEXT_PUBLIC_FORMSPREE_ID`, Part 3) |
| 22 | Bookings actually send | Built but needs a setting: `NEXT_PUBLIC_BOOKING_TEST_MODE=false`. **The Part 3 email did not list it**; runbook step 11 adds it on the call |
| 23 | Part 3 switch-on steps (Vercel, Neon, secrets, R2, Resend, website settings) | Steps 1 (Vercel projects) and 2 (Neon) done by Pierre Nov 20. Steps 3 to 5 (secrets, studio settings with R2 and Resend, website settings) not reported yet |
| 24 | Portal address, Resend domain, migrate and sign-in, test booking | Agreed later: after Pierre approves the preview site (review call Nov 23); Hammad sends the final switch-on instructions then |
| 25 | Quo key emailed Nov 13 never used | Built and verified (not in the code or settings; a new key only if the webhook is wanted) |
| 26 | Turnaround 24 hours, 48 guaranteed; cancellation terms | Built and verified |
| 27 | Pierre's onboarding form answers | **Missing:** we can't see them (Nov 16 email), so they are not checked against the build |
| 28 | Calls: meeting link and calendar invite | Done: Call 2 (Nov 22) and the review call (Nov 23) both happened on Google Meet. Each new call still needs a link and an invite |
| 29 | Pierre can edit the site's content himself | Agreed (Hammad, Nov 21): bring the questions to the call; show him `src/config/site.ts`, `src/data/projects.json` and the README's plain-English commands |
| 30 | Review call changes (Nov 23): floor plan add-on, booking form, landing, About, Portfolio, copy | Built and verified (website `d7de14a`, studio `4fbb16b`; prices `scm-v3`; booking form walked through in a browser) |
| 31 | Pierre's content for the review: floor plan examples, tour links, new videos, staging examples, wording for the four boxes and pages | **Missing:** from Pierre |
| 35 | Brokerage logos ("Trusted by") and a business portraits section | **Missing:** Pierre sent both as Dropbox folder links (Nov 22). Folders can't be downloaded from the build machine, and nothing was in Drive as of Nov 25; Hammad puts the files in Drive (or allows the Dropbox download hosts in the environment's network settings), then we build both |
| 36 | New business portrait on Home and About (Nov 22) | Built and verified (website `99d090e`, `pierre-2026.jpg`) |
| 37 | Tell Pierre the portrait and the sharper hero are done, with the file-size trade-off | **Missing:** Pierre still has no preview link. The Nov 24 10:20 UTC review email went with the "[PREVIEW ADDRESS]" placeholder. The Nov 25 10:06 UTC reply went without the link and with the note to Hammad ("[HAMMAD: ... paste that address ...]") still at the top, followed at 10:06 by "Just want to double check you have access to the newest website?". Hammad sends him the address |
| 32 | Pricing page behind a name and email form; a page per service; Google Maps autofill and distance; plat map upload | Built and verified on `new-scope` in both repos (Hammad's go-ahead Nov 24), not on `main`. On GitHub since Nov 25 (website `new-scope` df5db85, Hammad's push). **Missing:** Hammad OKs merging to `main` in both repos, and a Google Maps key in Pierre's account (address suggestions stay off without it) |
| 33 | Pierre approves the preview site, then go live on showcasemedia.pro | **Missing:** Pierre's review and OK; domain switch on a call after that |
| 34 | Extra Vercel seat (build@, $20 a month) | **Missing:** Hammad removes it before handover |
| 38 | Studio template features: Google Drive, client discount, travel fields, shoot reminder, Book again, property page, upsell prompts, headshot and logo | Built and verified on studio `new-scope` (313c17b; 38 check scripts, 528 role checks) and the website's Book again. Every switch is off (HANDOFF section 12a). Turning one on: Agreed later (Pierre) |
| 39 | Test runs can never reach Pierre's real Formspree, studio or Google key | Built and verified (website `368b4f5`, `npm run test:server`, 28 checks); on GitHub since Nov 25 |
| 40 | His Matterport and Zillow 3D tours (embed codes, Nov 25) on the site | Built and verified on website `tours-embeds` (a93e337, on GitHub; Portfolio and the 3D tours page, lazy 16:9 frames, 17 checks; no CSP on the site). **Missing:** the tours themselves were not seen loading (the build machine can't reach either host), so check them on the preview; then Hammad OKs merging with row 32 |
| 41 | Newer walkthrough videos and floor plan examples (Nov 25) | **Missing:** from Pierre (he is pulling them) |

## Open items

- Payments through Wave: an open question for the REM Academy team.
- After go-live: add Olesya Juodsnukis and Clinton Cunanan as Creative specialists; their pay
  rates if he wants the Shooter pay report to total their pay.
- Later: the homepage hero video (he is making it) and, optionally, his animated logo.
