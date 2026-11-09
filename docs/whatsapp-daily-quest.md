# Task: WhatsApp daily-quest notifications for TreasureHunch

Add WhatsApp as an opt-in channel for the daily quest alert, alongside the existing browser push. Read `functions/` (especially `notifyDailyQuest`), `firestore.rules`, the username dialog in `src/`, and `tests/` before changing anything, and follow the patterns already used there.

## Fixed values

| Name | Value |
| --- | --- |
| WhatsApp sender | `whatsapp:+12296143014` (display name "Lascade") |
| Content template | `daily_quest_alert`, SID `HX00018b6d69870173c03971adf8b14060`, English, Marketing category |
| Template variable | `{{1}}` = explorer's username |
| Template button | "Play today's quest" → `https://hunch.rohittp.com/?daily=1` (static, built into the template) |

Template body: "Hi {{1}}, today's TreasureHunch daily quest is live! A new hidden country is waiting for you. You have 3 minutes and 3 clues to find it and claim it for your explorer map."

| OTP template | `hunch_otp`, SID `HXa3dceeb72ea8e70eadfd4c3baa4d323f`, English, Authentication category |
| OTP variable | `{{1}}` = the code (digits only, max 15 chars) |

The OTP template renders as "{{1}} is your verification code. For your security, do not share this code. This code expires in 10 minutes." and has a **Copy code** button. Its copy-code button also uses `{{1}}`, so send `contentVariables: {"1": code}` only. The template is generic so it can be used for both phone verification and WhatsApp login.

Template bodies are fixed. Do not send free-form text. WhatsApp rejects business-initiated messages that don't use an approved template.

## 1. Secrets and config (already in place, so don't touch Twilio)

These files are already set up. You don't need Twilio Console access.

| File | Contents | Read with |
| --- | --- | --- |
| `functions/.env.treasurehunch` | `WHATSAPP_FROM`, `WHATSAPP_DAILY_CONTENT_SID`, `WHATSAPP_OTP_CONTENT_SID` (next to the existing `CHALLENGE_EMAIL_FROM`) | `defineString(...)` for each, like `emailFrom` in `functions/index.js` |
| `functions/.secret.local` (gitignored) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (emulator only) | `defineSecret('TWILIO_ACCOUNT_SID')` and `defineSecret('TWILIO_AUTH_TOKEN')`, like `resendKey`. Add both to the `secrets` list of every function that uses them |

- Don't read, print, copy or commit the values in `.secret.local`. Don't edit `.gitignore` to un-ignore it.
- `TWILIO_AUTH_TOKEN` may still be the placeholder `PASTE_AUTH_TOKEN_HERE`. Rohit fills it in. Everything except the real test-send script must work with the placeholder, so mock the Twilio client in tests.
- Production secrets are set by Rohit with `firebase functions:secrets:set TWILIO_ACCOUNT_SID` and `firebase functions:secrets:set TWILIO_AUTH_TOKEN`. Document this in the README; don't run it.
- Don't hardcode the sender or Content SID in logic. Use the params.
- Add the `twilio` npm package to `functions/`.

## 2. Opt-in data model

Store opt-in data on the private user doc `users/{uid}`, which only the owner can read. Never put it in `leaderboard`, `monthlyLeaderboard`, `atlases` or any other public doc.

```
users/{uid}.whatsapp = {
  phone: "+919020277399",   // E.164, written ONLY by verifyWhatsAppOtp
  verifiedAt: <timestamp>,  // written ONLY by verifyWhatsAppOtp
  optIn: true,
  optInAt: <serverTimestamp>,
  optOutAt: <timestamp|null>
}
```

- **Firestore rules:**
  - Clients can never write `whatsapp.phone` or `whatsapp.verifiedAt`. Only the Admin SDK in functions writes them.
  - The owner may only toggle `optIn`, `optInAt` and `optOutAt`.
  - `optIn` can only become true when `verifiedAt` exists, and `optInAt` must equal `request.time` when it does.
  - `otpChallenges` and `whatsappPhones` (section 3a) are server-only: deny all client reads and writes.
- **Rules tests:** add tests to the existing rules suite (`npm run test:rules`) covering these cases:
  - The owner can toggle opt-in only after verification.
  - The owner can't set or change `phone` or `verifiedAt`.
  - Another user can't read or write the field.
  - The OTP collections are unreadable from clients.
  - Public docs don't leak the number.

## 3a. WhatsApp OTP: one generic flow for verification and login

Build two callable functions (`onCall`, region and style as in `index.js`) that share a helper module, so phone verification and WhatsApp login use the same code path.

**`requestWhatsAppOtp({ phone, purpose })`**
- `purpose` is `"verify_phone"` (caller must be signed in) or `"login"` (may be unauthenticated).
- Normalise `phone` to E.164 with `libphonenumber-js` and reject invalid numbers.
- Generate a 6-digit code with `crypto.randomInt`. Store only an HMAC-SHA256 of it, keyed with a new secret `OTP_HMAC_KEY` added to `.secret.local` and Secret Manager. Never store or log the plain code.
- Store the challenge at `otpChallenges/{sha256(phone + purpose)}` with these fields:
  - `codeHash`, `purpose`, `uid` (null for login)
  - `expiresAt` = now + 10 min (this must match the template's 10-minute footer)
  - `attempts: 0`, `lastSentAt`, `sendsToday`
- Limits:
  - Resend cooldown of 60 s.
  - At most 5 sends per phone per day, and at most 10 per uid or IP per day.
  - Return `resource-exhausted` when a limit is hit.
- Send with `contentSid: WHATSAPP_OTP_CONTENT_SID` and `contentVariables: JSON.stringify({ 1: code })`.
- Return only `{ ok: true, resendAfter }`. Never say whether a number belongs to an existing account.

**`verifyWhatsAppOtp({ phone, purpose, code })`**
- Load the challenge. Reject it if it's missing, expired, has `attempts >= 5` or has a mismatched `purpose`. Increment `attempts` in a transaction before comparing.
- Compare hashes with `crypto.timingSafeEqual`. On success, delete the challenge.
- If `purpose = "verify_phone"`:
  - The caller must be the challenge's `uid`.
  - In one transaction, set `users/{uid}.whatsapp.phone` and `verifiedAt`, and claim the index doc `whatsappPhones/{phone}` = `{ uid }`.
  - If another uid already owns the phone, fail with `already-exists`.
- If `purpose = "login"`:
  - Look up `whatsappPhones/{phone}`. If a uid is found, return `{ customToken: await admin.auth().createCustomToken(uid) }`.
  - If none is found, return `{ needsAccount: true }`. Don't create users here. Sign-up stays Google + username until Rohit decides otherwise.
  - Check that the functions service account has the `iam.serviceAccounts.signBlob` permission (Service Account Token Creator), and note it in the README.
- On the client, sign in with `signInWithCustomToken`.

**Abuse protection:** OTP endpoints attract SMS/WhatsApp pumping fraud. Enforce Firebase App Check on both callables (`enforceAppCheck: true`), and add App Check (reCAPTCHA Enterprise) to the web app if it isn't already there.

**UI:**
- The WhatsApp section in section 3 becomes a two-step flow: enter the number, then enter the 6-digit code.
- Opt-in only becomes possible after the number is verified.
- Add autocomplete `one-time-code` on the code input, show a resend countdown, and show clear errors for expired, wrong and too-many-attempts codes.
- Build the UI pieces so a later "Continue with WhatsApp" login button can reuse them with `purpose: "login"`. Don't ship that button yet unless Rohit asks.

**Tests:**
- Unit-test the hashing and expiry logic.
- With the emulator and a mocked Twilio client, cover these cases:
  - The happy path for both purposes.
  - A wrong code, an expired code and too many attempts.
  - The resend cooldown.
  - A phone number already claimed by another uid.

## 3. UI: collecting consent

- In the username dialog, next to the existing notification-permission prompt, add an optional section titled **"Get the daily quest on WhatsApp"** with:
  - A phone input with a country code. Default it to +91 and normalise to E.164 with `libphonenumber-js`.
  - An unticked consent checkbox: "Send me the TreasureHunch daily quest on WhatsApp. Reply STOP anytime to unsubscribe."
- Only save `optIn: true` when the checkbox is ticked and the number has been verified by OTP (section 3a).
- Add the same toggle and number field wherever signed-in explorers manage notifications (or a small settings entry on the home screen) so they can change the number or turn it off. Turning it off sets `optIn: false` and `optOutAt`.
- Keep the UI mobile-first and in the existing style.

## 4. Sending, inside `notifyDailyQuest`

After the existing push send (00:05 UTC), and inside the same `dailyNotifications/{YYYY-MM-DD}` run guard:

1. Query `users` where `whatsapp.optIn == true`. Add a composite or single-field index if needed.
2. For each user, first create the marker `dailyNotifications/{date}/whatsapp/{uid}` with `create()`. If the marker already exists, skip that user. This makes retries safe at the per-recipient level, not just the per-run level.
3. Send the message:
   ```js
   client.messages.create({
     from: WHATSAPP_FROM,
     to: `whatsapp:${phone}`,
     contentSid: WHATSAPP_DAILY_CONTENT_SID,
     contentVariables: JSON.stringify({ 1: safeName }),
     statusCallback: <whatsappStatus function URL>,
   })
   ```
   `safeName` is the username with newlines and tabs stripped, at most 60 characters. Fall back to `"explorer"` if there is no username.
4. Store the returned `sid` and status on the marker.
5. Throttle sends with `p-limit` (about 10 in flight). The sender allows 80 messages per second.
6. Catch errors per recipient so one failure never aborts the batch. Twilio errors 21610 (recipient opted out) and 63024 (invalid recipient) set `optIn: false` for that user.
7. Log counts only (sent, skipped, failed). Never log full phone numbers; mask them, for example `+91******7399`.

The existing keep-your-streak push message stays as it is. WhatsApp uses the single template for now. A streak-specific WhatsApp template can come later as a second Content SID.

## 4a. "Stop these alerts" link (`daily_quest_alert_v2`)

`daily_quest_alert_v2` (SID `HX323143dfc2da934f5fe3daa9d43b2b5f`, submitted 9 Nov 2026) replaces v1 once WhatsApp approves it. Rohit will switch `WHATSAPP_DAILY_CONTENT_SID` in the env file then; the code just reads the param. V2 has the same body and variable plus:

- the footer "Reply STOP to unsubscribe."
- a second static URL button, **Stop these alerts** → `https://hunch.rohittp.com/?whatsapp=stop`

Handle `?whatsapp=stop` in the web app like the existing `?daily=1` param:

- If the explorer is signed in, set `whatsapp.optIn: false` and `optOutAt`, show a confirmation ("You won't get daily quests on WhatsApp any more"), and offer a way to turn alerts back on.
- If they're not signed in, ask them to sign in first, then do the same.
- Remove the param from the URL afterwards.

The link is static and carries no token, so sign-in is what identifies the explorer. Never opt someone out based on the URL alone.

## 5. New HTTPS functions

- **`whatsappInbound`** (Twilio "incoming message" webhook):
  - Validate the `X-Twilio-Signature` header with `twilio.validateRequest`.
  - If the body (trimmed, case-insensitive) is STOP, UNSUBSCRIBE, CANCEL or "Stop promotions", find the user by `whatsapp.phone` and set `optIn: false`, `optOutAt: now`.
  - Reply with empty TwiML.
- **`whatsappStatus`** (status callback):
  - Validate the signature.
  - Update the matching marker's `status` and `errorCode` by `MessageSid`.
  - Apply the same auto opt-out on 21610 and 63024.

After deploying, set both URLs on the WhatsApp sender in the Twilio Console:

1. Messaging → Senders → WhatsApp senders → +12296143014.
2. Put the `whatsappInbound` URL in "Webhook URL for incoming messages".
3. Put the `whatsappStatus` URL in "Status callback URL".

## 6. Tests and verification

- Unit-test the phone normalisation, `safeName` sanitising and STOP keyword matching.
- Test the send loop in the emulator with the Twilio client mocked. Cover these cases:
  - Opted-in users get exactly one call each.
  - A retried run sends nothing new.
  - A 21610 error flips `optIn` to false.
  - Users without opt-in are untouched.
- Add a manual admin script, `scripts/send-test-whatsapp.mjs <E.164 phone> <name>`, that sends the template once using the same helper and reads the credentials from `functions/.secret.local` without printing them. Rohit runs it, once the real token is filled in, to test with `+919020277399` (`daily_quest_alert` was approved on 9 Nov 2026; `hunch_otp` was submitted the same day and is under review). Give the script a `--otp` flag that sends `hunch_otp` with a random code.
- Run the existing lint, test and rules suites, and keep them green.

## Out of scope / don't do

- Don't send WhatsApp to anyone without `optIn: true`. Browser-push consent is not WhatsApp consent.
- Don't change the push notification behaviour or the daily quest logic.
- Don't create or edit Twilio templates from code.
