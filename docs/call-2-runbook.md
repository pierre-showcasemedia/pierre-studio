# Call 2 runbook: Showcase Media goes live

**Call 2 happened Nov 22 (15 min).** Pierre reviews the site before anything goes live: Parts B (portal and email DNS) and D (domain switch) wait for his approval, on a later call. Part A runs through the prompt Hammad sent him for his own Claude. See HANDOFF.md, Call 2 outcome.
Pierre drives his own screen; we guide. The detail behind each step is in
`HANDOFF.md` (the section number is in brackets).

**Ground rules for the whole call**

- Every account is Pierre's. He types or pastes every secret straight into
  Vercel. Nobody reads a key aloud, and nothing goes in chat, email or the code.
- At Porkbun, only the records named below change. **No email record (MX,
  SPF, autodiscover) is touched**, and the nameservers stay at Porkbun.
- The old Quo key he emailed is never used.
- Automated texts and emails stay off.

## Before the call (build side)

- [ ] **Meet link and calendar invite sent to Pierre?** The 2:00 pm offer had no link. Send both before the call.
- [x] Pierre confirmed 2:00 pm (Nov 22 16:31 UTC).
- [ ] Both repos' `main` pass every check (pull first; use the latest commit on each).
- [ ] Hero video: if Hammad has put Pierre's files in Drive, run `node scripts/add-hero-video.mjs` in pierre-site with the chosen version (original or Dark30 suggested) and push before the call. Otherwise show the versions on the call and add it after.
- [ ] Read Pierre's latest emails for anything new (Part 3 progress, pay rates, hero video).
- [ ] Have `openssl rand -hex 32` ready to run four times on Pierre's machine (or a password generator).

## Part A: accounts and the studio (about 60 min)

Pierre's progress on Part 3 (emails Nov 20): Step 1 (both Vercel projects) done 16:13 UTC; Step 2 (Neon) done 16:28 UTC. Steps 3 to 5 not reported yet. Before the call, read his latest emails and mark any more done.

| # | Step | Done when |
|---|---|---|
| 1 | Porkbun: **export the DNS zone** (or screenshot every record) before anything else. | The file or screenshots are saved on his Mac. |
| 2 | **Done by Pierre Nov 20 (Part 3 Step 1): check only.** Vercel team on **Pro** [2]. | The plan page says Pro. |
| 3 | **Done by Pierre Nov 20 (Part 3 Step 1): check only.** Import `pierre-studio` (preset **Next.js**, check it says `nextjs`, Node 22) and `pierre-site` (Next.js). Deploy both [2]. | Two green deploys, both reachable on `.vercel.app`. |
| 4 | **Done by Pierre Nov 20 (Part 3 Step 2): check only.** Studio project, Storage: **Neon**, Production and Preview [3]. | `DATABASE_URL` is in the studio's env vars (and not in the website's). |
| 5 | Studio env vars: `AUTH_SECRET`, `MIGRATE_TOKEN`, `CRON_SECRET` (three fresh random values), `ADMIN_EMAILS` = pierre@showcasemedia.pro. Redeploy [4]. | Redeploy is green. |
| 6 | Run the migrate route, then the health check [5]. | Migrate answers `ok: true`. Health shows the database connected. |
| 7 | Cloudflare **R2**: bucket, CORS policy, a token for that bucket only. Pierre pastes `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Redeploy [6]. | Health shows storage connected. |

## Part B: portal address and email (about 30 min)

| # | Step | Done when |
|---|---|---|
| 8 | Studio project, Domains: `portal.showcasemedia.pro`. Porkbun: add **only** that CNAME [7]. | Vercel shows the domain valid; the portal opens over https. |
| 9 | Resend: add showcasemedia.pro. At Porkbun add **only** the `send` MX and TXT and the `resend._domainkey` record. Pierre pastes `RESEND_API_KEY`. Redeploy [8]. | Resend shows Verified. |
| 10 | Sign in at the portal with pierre@showcasemedia.pro [8]. | The link arrives from portal@showcasemedia.pro and he lands in the admin. |

## Part C: website to studio, and a test booking (about 40 min)

| # | Step | Done when |
|---|---|---|
| 11 | **`NEXT_PUBLIC_BOOKING_TEST_MODE=false` is the one setting the Part 3 email did not list: without it the booking form stays in test mode and sends nothing.** One more random value: the studio's `BOOKING_INTAKE_SECRET` = the website's `STUDIO_INTAKE_SECRET`. Website: `STUDIO_URL` and `NEXT_PUBLIC_PORTAL_URL` = the portal address, `NEXT_PUBLIC_FORMSPREE_ID` = `mjywydge`, `NEXT_PUBLIC_BOOKING_TEST_MODE` = `false`. Redeploy both [10]. | Both deploys green. |
| 12 | Test booking from the website's `.vercel.app` /book, using his second email: a package and an add-on [14]. | It shows on Bookings within a minute, at the website's price. |
| 13 | Confirm time, upload 10 to 20 test photos, make them Client visible, preview and **send the delivery email by hand** [14]. | The client email arrives; the gallery is watermarked. |
| 14 | Press **Mark paid** on the invoice [9]. | Downloads open. |
| 15 | Delete the test booking with the admin API [14]. | It is gone from Bookings and Clients. |

## Part D: the website on showcasemedia.pro (last, about 20 min)

| # | Step | Done when |
|---|---|---|
| 16 | Website project, Domains: `showcasemedia.pro` and `www` [15]. | Vercel shows the records it wants. |
| 17 | Porkbun: turn off the forwarding to pierrestephenson.com, then add the root and `www` records exactly as Vercel shows. Nothing else changes [15]. | Vercel shows both valid; showcasemedia.pro opens the new site. |
| 18 | **Email check:** send pierre@ and mediahero@ a test from another account. | Both arrive. If not, compare against the zone export from step 1 at once. |
| 19 | One more booking from the live site, then delete it. | Same as steps 12 and 15. |

## Decisions to ask Pierre on the call

- **Hero video:** which version (original, Dark30, 40, 50 or 60). The page already darkens the hero, so the original or Dark30 is suggested.
- **Past galleries:** a link to his Pic-Time page next to Client Login? Yes: set `pastGalleries.show` to `true` in the website's `src/config/site.ts` and push.
- **Part 3:** which steps he already did, so we skip them.

## After the call

- Pierre keeps the Framer site and pierrestephenson.com for a week.
- Add Olesya Juodsnukis and Clinton Cunanan in the admin as **Creative specialists** [11]. Their
  pay shows "Rate not set" until Pierre gives rates.
- Optional later: the Quo webhook with a **new** key [13], the hero video, the animated logo.
- Open for the REM Academy team: whether and how to connect Wave. Until then payments stay
  manual (Wave invoice, then Mark paid).

## If something goes wrong

- **A deploy fails:** check the framework preset says `nextjs`, then read the build log. Nothing is live yet, so there's no rush.
- **The migrate route says not allowed:** the `x-migrate-token` header must match `MIGRATE_TOKEN` exactly; redeploy after adding it.
- **Email stops arriving after a DNS change:** undo the last record change and compare with the zone export. Never edit MX or SPF to "fix" it.
- **Running out of time:** stop after Part C. The website can move to showcasemedia.pro on a short follow-up call; the old site keeps working until then.
