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

## Installable app, offline play and in-app browsers

TreasureHunch is a Progressive Web App. Analytics, events and the handoff's measurement are in the [analytics guide](docs/analytics.md).

- **Manifest and icons.** `public/manifest.webmanifest` (standalone display, two home-screen shortcuts, launches tagged `utm_source=pwa`). The icons in `public/icons` are drawn by `python3 scripts/generate-icons.py` (requires Pillow) from the favicon's compass star.
- **Service worker.** `src/service-worker.js` is emitted as `/sw.js` by a plugin in `vite.config.js`, with the build's file list and a build id in front. Production builds register it; `npm run dev` does not.
  - It stores the app shell (page, scripts, styles, country outlines, map glyphs), so the game opens with no connection and solo levels and today's quest can be played offline. Page loads still come from the network first, so a deploy shows at once; the stored copy answers when the network fails or takes longer than four seconds.
  - A new build waits until the home screen is showing with no hunt or dialog open, then takes over. A page still running the previous build (an installed app left open for days) reloads itself at that point.
  - Push notifications keep their own worker (`src/firebase-messaging-sw.js`); the two never overlap.
  - To take the worker out of service, deploy a `sw.js` that unregisters itself; the file is served `no-cache`, so browsers pick it up on their next visit.
  - Hosting keeps its default one-hour cache on `/assets`. Header rules also apply to a path's 404, so a year-long cache there could pin a missing file for anyone who asked for it between a deploy and a rollback; repeat visits are served by the worker anyway.
  - Paths under `/assets`, `/fonts`, `/icons`, `/illustrations` and `/.well-known` that do not exist return 404 instead of the page (`rewrites` in `firebase.json`), so a script that has been replaced by a deploy fails cleanly and the app reloads itself onto the new build.
- **Installing.** The install sheet opens by itself after a win and after signing in, at most once every two days per device, and stays away for two days after it is turned down. A sign-up ask always goes first: a guest's winning result shows the sign-in ask with a smaller install card beneath it, a new explorer chooses a username before the sheet, and the daily quest alert card is answered before it. The home screen always has an install entry. Chrome, Edge and Samsung Internet get their own install prompt from one tap; iPhone and iPad get Add to Home Screen steps, which is the only way iOS allows; an in-app browser is sent to Chrome or Safari first. `src/pwa.js` holds the decisions and `tests/pwa.test.mjs` covers them.
- **Installed-app extras.** The screen stays on while a hunt's clock runs, the icon shows a badge while today's quest is unplayed or a challenge is unread (iOS and desktop), and on iOS an installed app can receive the daily quest as a push notification, which a Safari tab cannot.
- **In-app browsers.** Most visits arrive inside Instagram's or Facebook's browser, whose storage is cut off from Chrome and Safari. `src/escape.js` is inlined into `index.html` and sends a first visit on to the real browser before the game loads; anyone who already has progress there stays. Campaign tags and click ids travel with the link. `?stay=1` on a link switches the redirect off for that visit.
  - **This has to be checked on real phones before each release that touches it.** Send yourself the site link in an Instagram direct message, a Facebook post and a WhatsApp chat on Android and on an iPhone, and tap it: the game should open in Chrome or Safari, or, where the app refuses, load normally where it is. Whether an app honours the link is the app's decision and changes with its releases, so the automated tests can only prove that a refusal is harmless.

### Play Store (Trusted Web Activity)

The site is ready to be wrapped as a Trusted Web Activity; nothing is published yet. Remaining steps:

1. Create the app in the Play Console and choose a package name (it can never be changed).
2. Build the Android package from the live manifest with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) (`npx @bubblewrap/cli init --manifest https://hunch.rohittp.com/manifest.webmanifest`, then `build`) or [PWABuilder](https://www.pwabuilder.com/).
3. Add `public/.well-known/assetlinks.json` with the package name and the SHA-256 fingerprint Play shows under **App integrity**, deploy, and check that `https://hunch.rohittp.com/.well-known/assetlinks.json` returns JSON. Without it the app shows a browser address bar.
4. Play requires in-app account deletion for apps with sign-up; the game has none yet.

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

### Moderation

Friend-hunt clues and public usernames are user-generated content, so the game follows App Store Guideline 1.2 (spec decision 22). The code is in `functions/moderation.js`, `src/moderation.js` and `src/moderation-dialog.js`; the pages are `public/terms.html`, `public/privacy.html` and `public/support.html` (also served at `/terms`, `/privacy` and `/support`).

- **Terms before sign-in.** The sign-in sheet has an unticked "I agree to the Terms of Use" box. Google and WhatsApp sign-in only start once it is ticked (the box locks once a WhatsApp code is sent), and the acceptance is stored once as `users/{uid}.termsAcceptedAt` (the server time), retried on the next sign-in event if that write fails. Signing in only to stop WhatsApp alerts (`?whatsapp=stop`) or to delete the account (`?account=delete`, source `account_delete`) shows no box and records nothing: that exemption covers only that action. **Choosing a username needs the Terms accepted**, and everything an explorer posts needs a username. So an account without `termsAcceptedAt` (from before the box, or from an exempt sign-in) gets the unticked box in the username dialog. `claimUsername` refuses with `failed-precondition` (`reason: 'terms'`), and the rules refuse a `profiles` create unless `users/{uid}.termsAcceptedAt` is set, before or in the same batch.
- **Report.** Received challenges in My logs, the clue sheet during a friend hunt, friend-hunt results and other explorers' maps have Report. A report is a create-only `reports/{id}` document (`reporterUid`, `targetUid`, `kind` = `clue`, `hunt`, `profile` or `username`, an optional hunt `code`, a `reason` of at most 200 characters, `createdAt`), which clients can't read; the reported explorer must have a profile. The `onReportCreated` function sends it to the developer on Telegram, as plain text with Firebase console links to the report, the hunt, the explorer's map and `users/{uid}`, with a 10-second timeout per call. Network errors, timeouts, 429 and 5xx are retried. Other refusals (a bad token, a missing chat) are not: the report gets `alert: 'failed'` and `alertStatus`. The report records the outcome in `alert`:
  - `sent`;
  - `duplicate`: the same reporter, explorer, kind and hunt within 24 hours;
  - `limited`: more than five alerts from one reporter in an hour. The report a Block files skips the limit while the block exists, once per reporter and blocked explorer a day;
  - `failed` or `unconfigured`.

  The scheduled `moderationDigest` runs every 6 hours. It sends one Telegram message listing the reports of the last 7 days that weren't alerted, oldest first and as many as fit in one message ("…and N more" for the rest), and marks only those as `digested`. Without the secrets it logs the count. **Act on every report within 24 hours**, as the Terms promise: remove the content and ban the explorer.
- **Block.** Block hides that explorer's challenges and your friend hunts with them at once (`users/{uid}/blocks/{otherUid}`), refuses their invite links, and also files a report. `notifyFriendChallenge` and `emailFriendChallenge` skip a sender the recipient blocked.
- **Ban.** `banExplorer` (callable, needs the `admin` custom claim) writes `bans/{uid}` first, so the rules refuse every public write from that account, then disables the Auth user and revokes its sessions, removes the leaderboard and monthly entries, explorer map, username and profile, reserves the username in `blockedUsernames`, deletes waiting hunts and the challenges the explorer sent, and shows the explorer as "Former explorer" in other friend hunts, with their clues replaced. The WhatsApp number stays linked to the banned account so it can't sign up again. Push tokens are deleted and the WhatsApp alert is switched off. A failed ban can be run again.
- **Usernames.** The web game claims usernames through the `claimUsername` callable, which writes `profiles/{uid}` and `usernames/{name}` in one transaction and refuses names in `functions/moderation/blocklist.txt` (plain lines match the whole name, `~` lines match anywhere in it, ignoring underscores and digit swaps). The starter list is neutral and short: **add slurs and abusive words to it** before relying on it. Exact entries are mirrored to `blockedUsernames/{name}` on each claim, and the rules refuse those names on the older client path that writes the two documents directly. Rules can only compare whole names, so a name that merely contains a `~` word can still be claimed by an old client; `claimUsername` lists each such name it refuses, so it can't be taken that way afterwards. If the function itself is down or missing (`internal`, `unavailable`, `not-found`, `deadline-exceeded`), the web game re-reads the explorer's profile and otherwise falls back to the direct claim, tracked as `username_claim_fallback`; App Check and sign-in failures never fall back.
- **Follow-up:** once `claimUsername` is confirmed live in production and old web bundles have gone, change the client creates of `profiles` and `usernames` in `firestore.rules` to `if false` (marked with a TODO there), so every claim passes the full blocklist.

Setup, once:

```sh
# The bot that posts alerts (from @BotFather) and the chat it posts to (a private chat or group with the bot).
firebase functions:secrets:set MODERATION_TELEGRAM_TOKEN --project treasurehunch
firebase functions:secrets:set MODERATION_TELEGRAM_CHAT_ID --project treasurehunch
```

**Do this before merging**, or the deploy on merge breaks in a way that is worse than a failed function:

- The merge workflow deploys Firestore rules and Cloud Functions in one `firebase deploy`. `onReportCreated` and `moderationDigest` declare the two secrets, so if either is missing, or the functions' runtime service account can't read it, the deploy fails while preparing the functions. The rules are then not released either. The Hosting job waits for that deploy (`needs: [test, deploy_backend]`), so the new web game is not released either: nothing goes live until the secrets are fixed, and the site keeps serving the previous version.
- Granting the runtime account access is something `firebase deploy` normally does itself, but the CI deploy account only has Secret Manager Viewer and can't change a secret's IAM policy.

So, after setting both secrets, either grant the access once:

```sh
for secret in MODERATION_TELEGRAM_TOKEN MODERATION_TELEGRAM_CHAT_ID; do
  gcloud secrets add-iam-policy-binding "$secret" --project treasurehunch \
    --member=serviceAccount:555455406222-compute@developer.gserviceaccount.com \
    --role=roles/secretmanager.secretAccessor
done
```

or run one `firebase deploy --only functions --project treasurehunch` from an owner account, which grants it. The merge workflow's "Check deploy configuration (function secrets)" step stops the deploy before anything is released if a secret is missing, has no enabled version, or isn't readable by the runtime account (or if the deploy account can't read the secret's metadata or IAM policy).

To ban, run `node scripts/moderate.mjs ban <uid> "<reason>"` (the uid is in the alert). It needs `gcloud auth application-default login` with an account that can manage Auth and Firestore on the project. The same script grants the `admin` claim (`node scripts/moderate.mjs admin <uid>`) to an account that should be able to call `banExplorer` from an app. `banExplorer` is not behind App Check, so a signed-in admin can call it with their ID token.

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
- Twilio error 21610 (recipient opted out) turns opt-in off at once. Error 63024 (invalid recipient) can fix itself (an outdated WhatsApp, terms not yet accepted), so it is counted once a day on `users/{uid}.whatsapp.unreachableCount` and only switches the alert off after three days running. That leaves `optOutAt` unset and stamps `unreachableAt`, so the game offers the alert again; a delivered message resets the count. Other errors, such as 63049 (Meta chose not to deliver a marketing message to that person), are recorded on the marker and change nothing.
- Both webhooks reject requests without a valid `X-Twilio-Signature`.

**App.** WhatsApp is the main way to sign in. The sign-in sheet opens with the number field ready, and Google sits below it. The form also offers an unticked "send me the daily quest on WhatsApp" box. Ticking it opts in as soon as sign-in succeeds; signing in alone never does. The shared number check (`src/whatsapp-verify.js`) works like this:

- The calling code defaults to the last country picked on this device, then the device's time zone (`src/timezone-countries.js`), then the browser language's region, then India. Typing or autofilling a number that starts with `+` or `00` switches the picker to match.
- After a code is sent, returning to the tab reads the clipboard. Chrome asks once for access. If the clipboard holds exactly 6 digits, the code is filled in and checked, which covers the template's **Copy code** button. Browsers that only read the clipboard on a tap get a **Paste code** button. **Open WhatsApp** links to the sender's chat, so `SENDER_CHAT_URL` there must match `WHATSAPP_FROM`. WhatsApp's own OTP autofill only works in native Android apps, so the web app can't read the message itself.

**In-app browsers.** Google sign-in fails inside the Instagram, Facebook, Messenger, WhatsApp and LINE browsers and Android web views (`src/inapp.js` spots them by user agent). There the sheet hides Google and shows a small link instead. On Android, **Prefer Google? Open in Chrome** opens the same page in Chrome with an `intent://` link. Elsewhere, **Prefer Google? Open in your browser** copies the link, or shows it in a field if copying fails. The link keeps the page's query (`utm_*` etc.) and adds `from=inapp&signin=google`. The real browser drops those two and opens the sign-in sheet. The app never leaves the in-app browser on its own. If a guest has an unclaimed find, which lives only in this browser's storage, the link is left out and a caption says to sign in with WhatsApp here. That covers claiming a daily win and entering the leaderboard. A closed or cancelled Google popup says so in the sheet and points to WhatsApp, instead of failing silently.

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

Firebase Hosting serves `dist/`. On every push to `main`, GitHub Actions (`.github/workflows/firebase-hosting-merge.yml`) runs the unit tests and the Firestore rules tests in the emulator. If they pass, it deploys Firestore rules and Cloud Functions, and then Hosting, so the site never goes live ahead of its rules. Pull requests run the rules tests and get a Hosting preview channel. The manual command above is still useful for a first deploy or a hotfix.

The merge workflow needs these repository settings (**Settings → Secrets and variables → Actions**):

| Name | Kind | Used for |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_TREASUREHUNCH` | Secret | Hosting deploys (already set up by Firebase init) |
| `FIREBASE_DEPLOY_SERVICE_ACCOUNT` | Secret | JSON key of the service account that deploys rules and functions |
| `CHALLENGE_EMAIL_FROM` | Variable | Verified sender address for challenge emails (a function parameter) |
| `FIREBASE_WEB_VAPID_KEY` | Variable | Optional Web Push key override for the build |

The deploy service account needs these roles on project `treasurehunch`: Firebase Rules Admin, Cloud Functions Admin, Service Account User, Artifact Registry Administrator, Cloud Build Editor, Eventarc Admin, Cloud Scheduler Admin, and Secret Manager Viewer. The daily alert needs the Cloud Scheduler API enabled on the project. `RESEND_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OTP_HMAC_KEY`, `MODERATION_TELEGRAM_TOKEN` and `MODERATION_TELEGRAM_CHAT_ID` stay in Secret Manager; the workflow only references them. Separately, the functions' runtime service account needs Service Account Token Creator for WhatsApp sign-in (see [WhatsApp sign-in and daily quest alerts](#whatsapp-sign-in-and-daily-quest-alerts)). The workflow deploys with `--force`, so a function removed from `functions/index.js` is deleted from the project.

The map uses Natural Earth 1:110m public-domain country outlines; source and terms: https://www.naturalearthdata.com/about/terms-of-use/. The GeoJSON is compacted to the ID, name, and label position fields used by the game. MapLibre GL JS is BSD-3-Clause licensed. The bundled map-label glyphs come from MapLibre demo tiles.

Multiplayer result rendering, participant poster sharing, sent/played challenge logs, deployment requirements and validation are documented in [Multiplayer results](docs/multiplayer-results.md).

Meta Pixel, Firebase Google Analytics and PostHog use a shared [event catalogue and funnel guide](docs/analytics.md); all provider code and event definitions live in `src/events.js`.
