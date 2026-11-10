# Game analytics

`src/events.js` is the single event catalogue, payload allowlist, Meta Pixel bootstrap, Firebase Analytics adapter and PostHog adapter. UI/controllers call `trackEvent(EVENTS.…, parameters)`; they do not call any provider directly.

- Meta Pixel: `1540952161129164` (the supplied Pixel).
- Firebase/GA4: `G-3L7L0GB63N`, verified using `firebase apps:sdkconfig` for the existing TreasureHunch web app on 29 October 2026.
- PostHog: project key `phc_mMjEnzpqWruQeWnybSbFzbFZkDRG5Ct5HcesQzZJEUPa` on `https://us.i.posthog.com`, initialised with `defaults: '2026-05-30'` (so PostHog's own autocapture, `$pageview` and session features follow those defaults). Every catalogue event, including `page_view`, is also sent via `posthog.capture` with the catalogue name and the same cleaned payload Google receives. `posthog-js` is lazy-loaded and early events are queued until it is ready.
- PostHog events are anonymous: `person_profiles: 'identified_only'` is set and `identify()` is never called, so no person profiles are created. Instead the signed-in account is attached to every PostHog event as global (super) properties via `posthog.register`: `user_id` (Firebase uid) and `username` (once claimed). They are unregistered on sign-out. These properties go to PostHog only; Meta and Google still receive just `account_status`.
- Tracking is enabled in production builds and disabled in Vite development. The JavaScript-disabled Meta PageView fallback is in `index.html`.
- Google receives the catalogue's event names. Meta receives matching custom events, except `page_view` → standard `PageView` and `sign_up` → standard `CompleteRegistration`.
- Firebase's automatic initial PageView is disabled because the adapter sends one explicitly. Early Google events are queued until Firebase Analytics is ready. Provider blocking or unsupported browsers cannot interrupt gameplay.

## Action flow

A typical hunt is:

`page_view` → `hunt_started` → `country_selected` → `guess_submitted` (wrong) → `clue_opened` → `country_selected` → `guess_submitted` (correct) → `hunt_completed` → `result_viewed` (multiplayer).

Selections can instead lead to `selection_cancelled`; seekers can open additional clues, use `country_revealed`, or leave with `hunt_abandoned`. No event is sent merely because the timer rerenders or a clue/guess request fails.

| Event | Trigger / useful parameters |
| --- | --- |
| `page_view` | One initial page load |
| `login` | Successful sign-in; `method=google` (popup or redirect) or `method=whatsapp` (code verified and custom token accepted) |
| `login_failed` | Every failed Google sign-in, from the popup or a returning redirect; `method=google`, `reason=popup_closed/popup_blocked/cancelled/network/app_check/unsupported/other` (a fixed code mapped from the Firebase error code, never its message). WhatsApp failures use `whatsapp_verify_failed` |
| `open_in_browser` | The in-app browser handoff for Google sign-in. `step=tap`: the "Prefer Google?" link in the sign-in sheet was tapped; `source=sign_in`, `method=intent` (Android, opens Chrome) or `copy` (iOS/other, link copied or shown), `in_app=instagram/facebook/messenger/whatsapp/line/other_webview`. `step=landed`: a page opened with `?from=inapp` from that link; `source=sign_in`, plus `in_app` only if it landed in an in-app browser again |
| `sign_up` | Successfully claimed the first username; `method=google/whatsapp` from the account's sign-in provider |
| `logout` | Successful sign-out |
| `hunt_started` | Solo hunt actually starts or seeker accepts a waiting challenge; `mode`, `role`, `level`, `difficulty`, `round_seconds` where applicable |
| `country_selected` | A valid country is selected on the map; `method=map`, current hunt stats |
| `selection_cancelled` | Player explicitly cancels a selected country; current hunt stats |
| `guess_submitted` | Confirmed solo guess or successfully committed multiplayer guess; `outcome=correct/wrong`, `wrong_guesses`, `cost_seconds` |
| `clue_opened` | An additional clue is successfully opened; `clue_number`, `clues_opened`, `cost_seconds=20` |
| `country_revealed` | Country reveal succeeds; `revealed=true`, `cost_seconds=30` |
| `hunt_completed` | Solo win/timeout, or a confirmed multiplayer completion observed during seeker gameplay; `outcome=won/lost`, `winner_role`, time/clue/guess stats |
| `hunt_abandoned` | Player exits an unfinished solo or seeker hunt, including switching to a different hunt; current hunt stats. Closing the browser without using an exit action is not counted. |
| `onboarding_hint_shown` | The one-time map hint ("Tap a country on the map, then press Guess.") appears about a second into the first solo or daily hunt on a device. Players with a solo win or a finished daily quest on the device never see it; current hunt stats |
| `onboarding_hint_completed` | The seeker selects a country on the map while that hint is showing, which hides it; current hunt stats (`time_used` is the hunt time used before that first selection, including any clue costs) |
| `multiplayer_opened` | Signed-in user opens the multiplayer lobby |
| `challenge_setup_opened` | Hider opens hunt creation |
| `challenge_created` | Challenge creation succeeds; `targeted`, `role=hider` |
| `challenge_accepted` | Seeker joins a waiting hunt; `source=invite/code/inbox/history` |
| `invite_shared` | Native invite sharing succeeds or invite is copied; `method=native/clipboard` |
| `result_viewed` | Multiplayer result is rendered; `source`, `role`, `outcome`, `winner_role`, `personal_win` |
| `rematch_started` | Seeker starts challenge-back/revenge setup; previous outcome |
| `poster_exported` | Poster is shared or downloaded; `method=native/download`, hunt stats. Cancellation is excluded. |
| `logs_opened` | User opens My logs |
| `history_result_opened` | User successfully opens a challenge from My logs |
| `leaderboard_viewed` | Leaderboard opened from a button; `source=home/result`, `board=monthly/all_time` (also sent when switching tabs, with `source=tab`) |
| `atlas_viewed` | An explorer map is opened; `owner=self/other`, `source=home/result/leaderboard/link`, `countries` collected |
| `atlas_shared` | The explorer shares their map link; `method=native/clipboard`, `countries` collected |
| `notifications_permission` | Browser notification permission prompt resolves, sent once this browser's push registration has finished; `permission=granted/denied/default`, `source=welcome/result_card`, `outcome=registered/unsupported/token_failed/save_failed` when granted (`unsupported`: no Web Push key, service worker or Firebase Messaging support; `token_failed`: the worker or FCM token could not be set up; `save_failed`: the token could not be stored), otherwise `denied` or `dismissed` (`signed_out` if the explorer signed out meanwhile) |
| `sign_in_opened` | The shared sign-in sheet opens; `source=account/multiplayer/claim/leaderboard/atlas/unsubscribe/open_in_browser` (the last when the handoff link lands with `signin=google`) |
| `whatsapp_code_requested` | A WhatsApp code was sent; `source`, `purpose=verify_phone/login`, `step=request/resend` |
| `whatsapp_verified` | A WhatsApp code was accepted; `source`, `purpose` |
| `daily_link_opened` | A daily quest alert link (`?daily=1`) was opened; `source=whatsapp` (the WhatsApp alert's button, which has no `utm_source`), `push` (browser notification) or any other `utm_source` on the link. The daily `hunt_started` that follows carries the same `source` |
| `whatsapp_code_pasted` | A 6-digit code was taken from the clipboard after the explorer tapped Copy code in WhatsApp; `source`, `purpose`, `method=auto` (read on returning to the tab) or `button` (Paste code). The code itself is never sent |
| `whatsapp_verify_failed` | Sending or checking a code failed; `source`, `purpose`, `step=request/verify`, `reason=invalid_number/cooldown/daily_limit/expired/no_code/wrong_code/too_many_attempts/number_taken/account_mismatch/send_failed/other` |
| `whatsapp_opt_in` | The daily quest alert was switched on; `source=sign_in/welcome/result_card/settings/unsubscribe` (`sign_in` is the consent box on the WhatsApp sign-in form; `unsubscribe` is "Turn alerts back on" after using the stop link) |
| `whatsapp_opt_out` | The alert was switched off in the app; `source=settings`, or `source=unsubscribe` when a signed-in explorer opens the stop link (no confirm step) |
| `whatsapp_prompt_shown` | The "Get tomorrow's country on WhatsApp" card was shown on a daily quest result (once per result); `source=result_card`, `step=verify` (number not yet verified) or `consent` (verified, one tap) |
| `whatsapp_prompt_dismissed` | "Not now" was tapped on that card (it then stays hidden until the next daily quest, the next UTC day); `source=result_card` |
| `whatsapp_unsubscribe_viewed` | The template's `?whatsapp=stop` link was opened, sent on page load before any sign-in; `source=link` |

Daily-quest hunts reuse the hunt events with `mode=daily` and add `streak` on `hunt_completed`. Common properties include `account_status=guest/signed_in`, `mode=solo/daily/multiplayer`, `role`, and applicable hunt statistics. Time used includes paid clue, reveal and wrong-guess costs. Legacy friend hunts remain 120 seconds; current hunts use 180 seconds.

Multiplayer `won`/`lost` describes the **seeker**. A timeout is `outcome=lost`, `winner_role=hider`. `personal_win` on `result_viewed` describes the current viewer. Hiders and historical viewers do not emit a second `hunt_completed` conversion. Completed-hunt and result-view events are deduplicated by hunt/viewer within the current page lifecycle. Multiplayer completion waits for acknowledged writes, and action events precede the final completion/result events even when listeners deliver the result before a transaction promise resolves.

### Map hint

`onboarding_hint_shown` → `onboarding_hint_completed` measures whether new seekers find the map. A shown hint without a completion means the hunt ended or was left with no country selected (`hunt_completed` with `outcome=lost`, or `hunt_abandoned`). The hint is remembered in `localStorage` (`treasurehunch:map-hint-seen`); where storage is blocked it can show once per page load.

### WhatsApp funnel

Sign-in: `sign_in_opened` → `whatsapp_code_requested` (`purpose=login`) → `whatsapp_code_pasted` (optional) → `whatsapp_verified` → `login` (`method=whatsapp`) → `whatsapp_opt_in` (`source=sign_in`, if the consent box was ticked) → `sign_up` for new explorers. Alerts: after each daily quest (won or lost), signed-in explorers with a username who haven't opted in or out get an inline card under the result: `whatsapp_prompt_shown` (`source=result_card`) → `whatsapp_code_requested` (`purpose=verify_phone`) → `whatsapp_verified` → `whatsapp_opt_in` (`source=result_card`), or `whatsapp_prompt_dismissed`. Explorers with a verified number skip straight from the card to `whatsapp_opt_in`. The same card offers browser notifications where the browser can still ask, tracked as `notifications_permission` with `source=result_card`. Guests are asked on the WhatsApp sign-in form (`source=sign_in`) or in the username dialog after sign-in (`source=welcome`) instead. Unsubscribing: `whatsapp_unsubscribe_viewed` → `sign_in_opened` (`source=unsubscribe`, guests only) → `whatsapp_opt_out` (`source=unsubscribe`). Phone numbers and codes are never event parameters, and `reason` is a fixed code, not the server's message. Opting out by replying STOP to the WhatsApp message happens on the server (the `whatsappInbound` function), so it is not tracked client-side. Opt-outs from the unsubscribe link and from settings are.

### In-app browsers and Google

Most traffic comes from the Instagram, Facebook and WhatsApp in-app browsers, where Google's popup usually closes without signing in. There the sign-in sheet shows WhatsApp only, plus a link out: `sign_in_opened` → `open_in_browser` (`step=tap`) → `open_in_browser` (`step=landed`, in the real browser) → `sign_in_opened` (`source=open_in_browser`) → `login` (`method=google`). Google failures anywhere are `login_failed` with a fixed `reason`. Compare `step=tap` and `step=landed` counts by `method` to see how many handoffs reach the real browser.

### PostHog-only settings

- Uncaught errors and unhandled promise rejections are captured as `$exception` events (`capture_exceptions`), so they appear in PostHog error tracking.
- The map canvas is recorded in session replay at 4 frames a second (see `src/events.js`).
- Team devices: open the site once with `?internal=1` on each phone or browser you test with. That device then sends `is_internal=true` on every PostHog event; filter it out (for example as a test-account filter on `is_internal` is not set). `?internal=0` clears it. The flag is stored in that browser only.

## Reading the funnel in GA4

Use **Explore → Funnel exploration** with steps `hunt_started`, `country_selected`, `guess_submitted`, and `hunt_completed`. Break down by `mode` or `outcome`; use **Path exploration** to see where `clue_opened`, `country_revealed`, and `selection_cancelled` occur between guesses.

Register event-scoped custom dimensions in GA4 for `mode`, `role`, `outcome`, `winner_role`, `personal_win`, `source`, `method`, `purpose`, `step`, `reason`, `in_app`, and `account_status` when using them in saved explorations. Register custom metrics for `time_used`, `clues_opened`, `wrong_guesses`, and `cost_seconds` if desired. This change does not alter GA4 report definitions or mark events as key events. In Meta, custom conversions can use `hunt_completed` filtered by `outcome`, or `challenge_created` for the challenge-creation funnel.

Only allowlisted scalar custom properties reach providers. Display names, usernames, email, Firebase UID, clue text, invite codes, and arbitrary error messages are excluded from custom event payloads. The one country answer sent is the daily quest's `country` (ISO 3166 alpha-3 id) on its `hunt_completed`, after the hunt is over, so daily countries can be compared by difficulty; it is never on an event sent while that quest is live. Provider SDKs still collect their normal browser context such as page URL, referrer and campaign attribution.

## Validation and delivery

`npm test` includes provider parity, event naming, deduplication, sign-in context, payload filtering, unsupported/failed providers, and legacy timing tests. `scripts/validate-events.js` runs through Playwright's `browser_run_code` with local Firebase/Meta/Google adapters and verifies this real controller sequence:

`clue_opened` → `clue_opened` → `country_revealed` → `country_selected` → `selection_cancelled` → `country_selected` → `guess_submitted` (wrong) → `country_selected` → `guess_submitted` (correct) → `hunt_completed` → `result_viewed`.

A separate browser check exercised the actual solo UI's start, two paid clues, country reveal and abandon flow, with matching events in both provider adapters. Test traffic was not sent to the production analytics accounts. Deployed to Firebase Hosting on 29 October 2026 with the multiplayer changes. Live browser verification confirmed that the custom domain loads Meta `fbevents.js` and the Google tag for `G-3L7L0GB63N`. Production dashboard ingestion remains unverified. No additional Firebase rules or indexes are needed for analytics.

Implementation references: [Firebase Analytics setup](https://firebase.google.com/docs/analytics/web/get-started), [Firebase event logging](https://firebase.google.com/docs/analytics/web/events).
