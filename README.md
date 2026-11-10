# TreasureHunch

A mobile-first solo geography hunt. The player has three minutes to locate a hidden country on a MapLibre world map. The first clue is free; the next two cost 20 seconds each. A wrong confirmed guess costs 5 seconds. After opening all clues, the player can pay 30 seconds to reveal the country name, then find it on the map to win. The map stays full screen during a hunt, with a floating timer and clues that minimise as the player explores.

## Daily quest and explorer maps

Every UTC day has one **daily quest**: the same hidden country for every explorer, with the usual three clues and three-minute timer. Each explorer gets one attempt per day. Leaving or reloading keeps the clock running, and the attempt can be resumed from the home screen. Finding the country **claims** it for the explorer's map. A missed or lost day is a missed country.

- **Daily list:** each month has its own list of countries in Firestore, `dailyQuests/{YYYY-MM}` (`{ month, days: [...] }`, one entry per day). Day *N* plays `days[N - 1]`. The editorial copy is [data/daily-quests.json](data/daily-quests.json), which is also bundled as a fallback; `node scripts/seed-firestore.mjs --write` publishes it. Daily countries are separate from solo countries, and the seed script refuses overlaps, repeats and lists with the wrong number of days.
- The current lists cover November 2026 (30 countries) and December 2026 (31). Add the next month to `data/daily-quests.json` and publish it before the month starts. If a month has no list, every browser falls back to the same seeded shuffle of the earlier daily countries, so the quest keeps working.
- Editing a published month in Firestore changes it for everyone without a deploy. An attempt that has already started keeps its country.
- **Monthly leaderboard** (`monthlyLeaderboard/{YYYY-MM}/entries/{uid}`): most countries found this month ranks first, and ties go to the least total time used. It is the default tab of the leaderboard screen.
- **All-time leaderboard** (`leaderboard/{uid}`): the existing solo-level score. Each daily find also counts there, weighted at double the explorer's highest solo level (minimum weight 2), so it always counts more than any single level.
- **Explorer maps** (`atlases/{username}`): the countries each explorer has claimed. Anyone can open one from a leaderboard row or a `https://hunch.rohittp.com/?atlas=<username>` link, and signed-in explorers can share their own.
- Guests can play straight away. A guest's win shows **Create a username to claim {country}**, which uses the normal sign-up: Google sign-in, then the username dialog, which also asks for notification permission. The country is claimed and entered on the monthly board once the username is saved. Until then the result is kept only on that device.
- Attempts are stored in `users/{uid}/daily/{YYYY-MM-DD}`. The document is created when the quest starts and can be finished only once.
- **Daily alerts:** the scheduled `notifyDailyQuest` function runs at 00:05 UTC. It sends a push notification to every browser registered in `users/{uid}/pushTokens` (the same tokens friend challenges use). Explorers who found yesterday's country get a keep-your-streak message. The notification opens `https://hunch.rohittp.com/?daily=1&utm_source=push&…`, which starts the quest. The WhatsApp alert's button opens the bare `?daily=1` (its URL is fixed in the approved template), so the app counts a `?daily=1` visit without `utm_source` as coming from WhatsApp (`dailyLinkSource` in `src/daily.js`). To tag WhatsApp explicitly, submit a new version of the template whose button URL ends in `&utm_source=whatsapp`; no code change is needed. A `dailyNotifications/{YYYY-MM-DD}` document stops a retried run from sending twice. Explorers who opt in also get the alert on WhatsApp at about 08:00–12:00 their local time. See [WhatsApp sign-in and daily quest alerts](#whatsapp-sign-in-and-daily-quest-alerts).

These boards are casual and client-scored like the solo leaderboard. The rules enforce one attempt per day per account and keep entries self-consistent, but a modified client could still post made-up results.

Solo hunts have easy, medium, hard and expert country pools. The first two winning levels draw easy countries, levels 3–5 medium, levels 6–10 hard, and level 11 onward expert. There are 20 expert countries, so levels 11–30 each bring a new one. Each level picks a country the player has not found yet when possible; after the pool runs out, countries repeat. Losing keeps the player on the same level. Solo progress is kept on this device; signed-in players also save completed hunts to Firestore, and their winning hunt count can restore progress on another device.

Solo hunts start without an account. After a win, the player can open the public leaderboard and sign in with Google to enter it. The score is the weighted average seconds used across won levels, including time spent on clues and wrong guesses. Each level contributes its best winning time once; level N has weight N, so later, harder levels count more. Lower averages rank higher. Guest wins stay in the browser session until sign-in.

A winning result celebrates the find and offers **Challenge a friend**. That opens the hiding flow with the just-found country selected, ready for the player to write their own clues. Guests sign in before creating the challenge.

Friend hunts require Google sign-in for both players. On first sign-in, each player claims a unique username and can opt into browser notifications. The hider searches for a country or taps the map to drop a pin, writes three clues, then shares a 10-character code or invite link. Alternatively, the hider enters a friend's username. That challenge is reserved for that account and appears in their inbox; the hider can still copy its invite link. The seeker gets the first clue free and plays with the same three-minute timer and time costs as solo mode. A Firestore listener keeps both screens in sync. Friend results live in `friendHunts` and never enter the solo leaderboard or advance solo levels.

## Run locally

Requires Node 22 and a modern browser with WebGL 2.

```sh
npm ci
npm run dev
```

The browser uses the included solo puzzles and daily lists if Firestore is unavailable. Google sign-in and cloud saving work when the page runs on a Firebase Auth authorized domain.

Home and hunt-invite links share a generic social preview that keeps the hidden country secret. Open Graph and X card tags are in `index.html`; the 1200×630 PNG is `public/social-preview.png`. Regenerate the artwork with `python3 scripts/generate-social-preview.py` (requires Pillow).

## Curated puzzles and Firebase

- [data/countries.json](data/countries.json) is the editorial source for the 64 solo countries (192 clues), each marked easy, medium, hard or expert. [data/daily-quests.json](data/daily-quests.json) holds the monthly daily lists (61 more countries). [data/CLUE-SOURCES.md](data/CLUE-SOURCES.md) records the references.
- `node scripts/seed-firestore.mjs` checks both files without writing. `node scripts/seed-firestore.mjs --write` publishes solo puzzles to `puzzles` and daily lists to `dailyQuests` in project `treasurehunch`, using the currently signed-in Firebase CLI account.
- Public clients can read active puzzles and leaderboard entries. Only a signed-in player can read their own profile and hunt history under `users/{uid}` or write their own leaderboard entry. Puzzle writes require a privileged Firebase CLI account; the browser cannot edit them.
- Signed-in players save completed hunts in `users/{uid}/hunts` and daily attempts in `users/{uid}/daily`. Monthly leaderboard entries and explorer maps are publicly readable. Guest wins are kept in the current browser session until sign-in.
- The leaderboard is a casual client-scored feature. Competitive anti-cheat would require server-validated rounds.
- A friend hunt stores the hidden country and pin in a separate Firestore document. Rules only let the hider read it until the seeker pays for the reveal or the hunt ends. Guess transitions are checked against that document by Firestore rules. This is a casual game: rejected writes can still be probed by a modified client, so friend scores deliberately stay off the leaderboard.
- Run `npm run test:rules` with Java and the Firebase CLI installed to verify friend-hunt, daily-quest, monthly leaderboard and explorer-map rules in the Firestore emulator.

### Challenge delivery setup

In-app challenges are stored under the recipient's private `users/{uid}/notifications` collection. A foreground browser alert is shown when the page is open and the player grants permission. Background alerts use Firebase Cloud Messaging and the project's public Web Push VAPID key, now included in the client. `VITE_FIREBASE_VAPID_KEY` (or the GitHub Actions repository variable `FIREBASE_WEB_VAPID_KEY`) can override it. Enable the FCM Registration API and Cloud Messaging API for the Firebase project. The inbox still works if background alerts are unavailable.

Challenge emails are sent by the `emailFriendChallenge` Cloud Function through Resend. Its secret API key stays on the server; player email addresses are read from Firebase Auth only inside the function. Configure a verified sender address as the `CHALLENGE_EMAIL_FROM` Firebase parameter and set `RESEND_API_KEY` in Firebase Secret Manager. Functions deployment may require a billing-enabled Firebase project. The function uses Resend idempotency keys and allows at most one challenge email per sender and recipient each minute. The separate `notifyFriendChallenge` function sends background alerts to registered browsers. In-app inbox delivery does not depend on either function.

```sh
firebase functions:secrets:set RESEND_API_KEY --project treasurehunch
cd functions && npm ci && cd ..
firebase deploy --only firestore:rules,functions,hosting --project treasurehunch
```

The deploy prompts for `CHALLENGE_EMAIL_FROM`; enter a sender on your verified email domain. Challenge emails and background alerts link to `https://hunch.rohittp.com/`. Do not put the Resend key in a Vite or Hosting environment variable.

### WhatsApp sign-in and daily quest alerts

The design and the decisions behind it are in [docs/whatsapp-daily-quest.md](docs/whatsapp-daily-quest.md). Messages go through Twilio from the WhatsApp sender `whatsapp:+12296143014` ("Lascade"). The app only ever sends two approved Content templates and never free-form text:

| Template | Category | Used for | Variable |
| --- | --- | --- | --- |
| `daily_quest_alert_v2` (`WHATSAPP_DAILY_CONTENT_SID`) | Marketing | The daily quest alert | `{{1}}` = username, with newlines and tabs stripped, at most 60 characters, `explorer` if none |
| `hunch_otp` (`WHATSAPP_OTP_CONTENT_SID`) | Authentication | Verification and sign-in codes | `{{1}}` = the 6-digit code |

**Functions** (all in `us-central1`; logic in `functions/whatsapp/`):

- `requestWhatsAppOtp` and `verifyWhatsAppOtp` are callables with App Check enforced. One flow serves both `purpose: "verify_phone"` (signed in; links the number to the explorer) and `purpose: "login"`, where an unknown number creates a new explorer and the app signs in with the returned custom token.
  - Codes last 10 minutes and allow 5 attempts. Only an HMAC-SHA256 of each code is stored, keyed with `OTP_HMAC_KEY`.
  - Limits: 60 seconds between codes to a number, 5 codes per number per day, and 10 per explorer (or per IP when signed out) per day.
- `sendDailyQuestWhatsApp` runs every 4 hours (`5 */4 * * *` UTC). Each run messages opted-in explorers whose local time (from `users/{uid}.whatsapp.timeZone`) is 08:00–11:59. A missing zone falls back to India time for +91 numbers and UTC otherwise.
  - Every zone lands in exactly one run a day, inside the same UTC day as the quest.
  - A `dailyNotifications/{YYYY-MM-DD}/whatsapp/{uid}` marker is created before each send, so retried or overlapping runs never message anyone twice.
  - Sends run about 10 at a time, and logs show counts and masked numbers (`+91******7399`) only.
  - `notifyDailyQuest` (browser push at 00:05 UTC) is unchanged.
- `whatsappInbound` (incoming messages) turns opt-in off when an explorer replies STOP, UNSUBSCRIBE, CANCEL or "Stop promotions".
- `whatsappStatus` (delivery status callbacks) records each message's status on its marker.
- Twilio errors 21610 (recipient opted out) and 63024 (invalid recipient) also turn opt-in off. Both webhooks reject requests without a valid `X-Twilio-Signature`.

**App.** WhatsApp is the main way to sign in. The sign-in sheet opens with the number field ready, and Google sits below it. The form also offers an unticked "send me the daily quest on WhatsApp" box. Ticking it opts in as soon as sign-in succeeds; signing in alone never does. The shared number check (`src/whatsapp-verify.js`) works like this:

- The calling code defaults to the last country picked on this device, then the device's time zone (`src/timezone-countries.js`), then the browser language's region, then India. Typing or autofilling a number that starts with `+` or `00` switches the picker to match.
- After a code is sent, returning to the tab reads the clipboard. Chrome asks once for access. If the clipboard holds exactly 6 digits, the code is filled in and checked, which covers the template's **Copy code** button. Browsers that only read the clipboard on a tap get a **Paste code** button. **Open WhatsApp** links to the sender's chat, so `SENDER_CHAT_URL` there must match `WHATSAPP_FROM`. WhatsApp's own OTP autofill only works in native Android apps, so the web app can't read the message itself.

**Data.** Each explorer's number and consent live only on the private `users/{uid}.whatsapp` (`phone`, `verifiedAt`, `optIn`, `optInAt`, `optOutAt`, `timeZone`). `phone` and `verifiedAt` are written only by the functions. These server-only collections are closed to clients by the rules:

- `otpChallenges`: pending codes
- `otpRateLimits`: daily send counters, keyed by hashed number, explorer or hashed IP
- `whatsappPhones/{E.164}`: the number-to-explorer index that makes each number belong to one explorer
- `whatsappMessages/{MessageSid}`: links status callbacks to their markers

`otpChallenges.expiresAt` and `otpRateLimits.expiresAt` are ready for a Firestore TTL policy if you want them cleaned up automatically.

**Setup:**

1. **Secrets.** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `OTP_HMAC_KEY` are already in Secret Manager for project `treasurehunch`. To rotate one, run:
   ```sh
   firebase functions:secrets:set TWILIO_AUTH_TOKEN --project treasurehunch
   ```
   The emulator reads the same names from `functions/.secret.local` (gitignored). Never commit it.
2. **Parameters.** `WHATSAPP_FROM`, `WHATSAPP_DAILY_CONTENT_SID` and `WHATSAPP_OTP_CONTENT_SID` are in `functions/.env.treasurehunch`, next to `CHALLENGE_EMAIL_FROM`. The deploy workflow rewrites only the `CHALLENGE_EMAIL_FROM` line and keeps the WhatsApp values.
3. **Custom-token signing.** WhatsApp sign-in calls `createCustomToken`, which needs `iam.serviceAccounts.signBlob` on the functions' runtime service account. It has Editor, which doesn't include it. Grant **Service Account Token Creator** once:
   ```sh
   gcloud iam service-accounts add-iam-policy-binding 555455406222-compute@developer.gserviceaccount.com \
     --member=serviceAccount:555455406222-compute@developer.gserviceaccount.com \
     --role=roles/iam.serviceAccountTokenCreator --project treasurehunch
   ```
4. **App Check.** The OTP callables reject calls without a valid App Check token, which protects against WhatsApp pumping fraud. The web app uses reCAPTCHA Enterprise site key `6LcQIBguAAAAAFm4o2o2fI6UXEoJn6WSKQYkXF0z`.
   - In the Firebase console, go to **App Check → Apps**, register the web app with the **reCAPTCHA Enterprise** provider and that site key, and make sure `hunch.rohittp.com` (and any preview domains) are allowed on the key.
   - For local development, the app prints an App Check debug token in the browser console on `localhost`. Add it under **App Check → Apps → ⋮ → Manage debug tokens**.
   - The callables enforce App Check on their own, so you don't need to switch on Cloud Functions enforcement in the console.
5. **Twilio webhooks** (after the first deploy). In the Twilio Console, open **Messaging → Senders → WhatsApp senders → +12296143014** and set:
   - **Webhook URL for incoming messages:** `https://us-central1-treasurehunch.cloudfunctions.net/whatsappInbound` (HTTP POST)
   - **Status callback URL:** `https://us-central1-treasurehunch.cloudfunctions.net/whatsappStatus`

   Use these exact `cloudfunctions.net` URLs. Twilio signs the URL it calls, and the functions validate against that form (the daily send also passes it as `statusCallback`).
6. **Unsubscribe link in the template.** `daily_quest_alert_v2` (`HX323143dfc2da934f5fe3daa9d43b2b5f`) is `daily_quest_alert` plus the footer "Reply STOP to unsubscribe." and a second static URL button, **Stop these alerts** → `https://hunch.rohittp.com/?whatsapp=stop`.
   - That page asks a signed-out visitor to sign in, then turns the alert off straight away and offers to turn it back on.
   - `WHATSAPP_DAILY_CONTENT_SID` points at v2. Until WhatsApp approves v2, sends with it fail, so point it back at v1 (`HX00018b6d69870173c03971adf8b14060`) if the alert must go out before approval.

**Manual test send.** With the real auth token in `functions/.secret.local`:

```sh
node scripts/send-test-whatsapp.mjs +919020277399 maya    # daily_quest_alert, {{1}} = maya
node scripts/send-test-whatsapp.mjs +919020277399 --otp   # hunch_otp with a random code
```

The script uses the same message helpers as the functions. It prints only the masked number, the message SID and its status (plus the test code for `--otp`), never the credentials.

**Tests.** `npm test` covers phone normalisation, `safeName`, STOP matching, code hashing and expiry, and the local-time send window. `npm run test:functions` runs the OTP flows, the daily send loop and the webhooks against the Firestore emulator with Twilio and Admin Auth mocked.

## Build and deploy

```sh
npm test
npm run test:functions
npm run build
firebase deploy --only firestore:rules,functions,hosting --project treasurehunch
```

Firebase Hosting serves `dist/`. On every push to `main`, GitHub Actions (`.github/workflows/firebase-hosting-merge.yml`) runs the unit tests and the Firestore rules tests in the emulator. If they pass, it deploys Hosting, Firestore rules and Cloud Functions. Pull requests run the rules tests and get a Hosting preview channel. The manual command above is still useful for a first deploy or a hotfix.

The merge workflow needs these repository settings (**Settings → Secrets and variables → Actions**):

| Name | Kind | Used for |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_TREASUREHUNCH` | Secret | Hosting deploys (already set up by Firebase init) |
| `FIREBASE_DEPLOY_SERVICE_ACCOUNT` | Secret | JSON key of the service account that deploys rules and functions |
| `CHALLENGE_EMAIL_FROM` | Variable | Verified sender address for challenge emails (a function parameter) |
| `FIREBASE_WEB_VAPID_KEY` | Variable | Optional Web Push key override for the build |

The deploy service account needs these roles on project `treasurehunch`: Firebase Rules Admin, Cloud Functions Admin, Service Account User, Artifact Registry Administrator, Cloud Build Editor, Eventarc Admin, Cloud Scheduler Admin, and Secret Manager Viewer. The daily alert needs the Cloud Scheduler API enabled on the project. `RESEND_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `OTP_HMAC_KEY` stay in Secret Manager; the workflow only references them. Separately, the functions' runtime service account needs Service Account Token Creator for WhatsApp sign-in (see [WhatsApp sign-in and daily quest alerts](#whatsapp-sign-in-and-daily-quest-alerts)). The workflow deploys with `--force`, so a function removed from `functions/index.js` is deleted from the project.

The map uses Natural Earth 1:110m public-domain country outlines; source and terms: https://www.naturalearthdata.com/about/terms-of-use/. The GeoJSON is compacted to the ID, name, and label position fields used by the game. MapLibre GL JS is BSD-3-Clause licensed. The bundled map-label glyphs come from MapLibre demo tiles.

Multiplayer result rendering, participant poster sharing, sent/played challenge logs, deployment requirements and validation are documented in [Multiplayer results](docs/multiplayer-results.md).

Meta Pixel, Firebase Google Analytics and PostHog use a shared [event catalogue and funnel guide](docs/analytics.md); all provider code and event definitions live in `src/events.js`.
