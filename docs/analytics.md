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
| `page_view` | One initial page load; `display_mode=browser/standalone/twa` (a browser tab, the app added to the home screen, or the Play Store app). On a page that tried the automatic redirect out of an in-app browser it is held back until the outcome is known (see [In-app browsers](#in-app-browsers-and-the-handoff)) |
| `login` | Successful sign-in; `method=google` (popup or redirect) or `method=whatsapp` (code verified and custom token accepted) |
| `login_failed` | Every failed Google sign-in, from the popup or a returning redirect; `method=google`, `reason=popup_closed/popup_blocked/cancelled/network/app_check/unsupported/other` (a fixed code mapped from the Firebase error code, never its message). WhatsApp failures use `whatsapp_verify_failed` |
| `open_in_browser` | Leaving an in-app browser for Chrome or Safari. `step=auto`: `index.html` tried it by itself on a first visit; `source=landing`, `method=intent` (Android, Chrome), `extbrowser` (Instagram on iOS) or `safari` (the WhatsApp alert link on iOS 17+), `in_app=instagram/facebook/messenger/whatsapp`, `outcome=stayed` (the page is still in front 1.5 s later), `left` (it went to the background within 30 s with no hunt started, as when Instagram asks first) or `returned` (it went to the background at once and the visitor later came back to it). `step=tap`: a link out was tapped; `source=sign_in` (the "Prefer Google?" link) or `install` (the install sheet), `method=intent/extbrowser/safari/copy` (`copy`: no link can do it, so the address is copied with instructions). `step=landed`: a page opened from a handoff link; `source=landing/sign_in/install`, `in_app` is the app the visit left, `outcome=browser` (it arrived in a real browser) or `in_app` (it is still inside an in-app browser: the app refused the link, or Chrome is missing) |
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
| `install_prompt_shown` | An offer to install became visible; `source=win` (the sheet that opens after a win, for explorers with a username), `sign_in` (the sheet that opens after signing in, or after choosing a username when signing up), `result_card` (the card beneath the sign-in ask on a guest's winning result, once per result), `home` (the home screen entry, once per page) or `handoff` (the sheet that opens after a link out asked to install), `method=prompt` (the browser's own install prompt is ready), `ios_steps` (Add to Home Screen instructions) or `open_in_browser` (an in-app browser, which must open Chrome or Safari first) |
| `install_started` | The explorer took an install offer; `source` as above, `method=prompt` (they tapped Install and the browser's own prompt is shown), `ios_steps` ("Got it" on the Add to Home Screen steps, the last thing iOS lets the page see) or `open_in_browser` ("Open in Chrome/Safari" inside an in-app browser) |
| `install_prompt_dismissed` | The explorer turned an install offer down: closed an install sheet or tapped "Not now" on it (any `source`), tapped "Not now" on the result card, or declined the browser's own prompt (`method=prompt`, after `install_started`). No install offer is made again on that device for two days; the home screen entry stays |
| `app_installed` | The app was installed. Where the browser reports it (`appinstalled`: Chrome, Edge, Samsung Internet): `method=prompt` after our own prompt, otherwise `browser` (installed from the browser's menu). Where it does not, the installed app's first launch on a device counts: `method=home_screen` (iOS) or `play_store` (the Play Store app). `display_mode` says where the event was sent from |
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
| `sign_in_opened` | The shared sign-in sheet opens; `source=account/multiplayer/claim/leaderboard/atlas/unsubscribe/account_delete/open_in_browser` (the last when a handoff link lands with `signin=google`) |
| `whatsapp_code_requested` | A WhatsApp code was sent; `source`, `purpose=verify_phone/login`, `step=request/resend` |
| `whatsapp_verified` | A WhatsApp code was accepted; `source`, `purpose` |
| `account_delete_opened` | The delete-account confirmation was shown; `source=account` (the button in My logs) or `link` (the public `?account=delete` link, after sign-in if needed) |
| `account_deleted` | The `deleteAccount` callable succeeded and the explorer was signed out; `source` as above |
| `daily_link_opened` | A daily quest alert link (`?daily=1`) was opened; `source=whatsapp` (the WhatsApp alert's button, which has no `utm_source`), `push` (browser notification) or any other `utm_source` on the link. The daily `hunt_started` that follows carries the same `source` |
| `whatsapp_code_pasted` | A 6-digit code was taken from the clipboard after the explorer tapped Copy code in WhatsApp; `source`, `purpose`, `method=auto` (read on returning to the tab) or `button` (Paste code). The code itself is never sent |
| `whatsapp_verify_failed` | Sending or checking a code failed; `source`, `purpose`, `step=request/verify`, `reason=invalid_number/cooldown/daily_limit/expired/no_code/wrong_code/too_many_attempts/number_taken/account_mismatch/send_failed/other` |
| `whatsapp_opt_in` | The daily quest alert was switched on; `source=sign_in/welcome/result_card/settings/unsubscribe` (`sign_in` is the consent box on the WhatsApp sign-in form; `unsubscribe` is "Turn alerts back on" after using the stop link) |
| `whatsapp_opt_out` | The alert was switched off in the app; `source=settings`, or `source=unsubscribe` when a signed-in explorer opens the stop link (no confirm step) |
| `whatsapp_prompt_shown` | The "Get tomorrow's country on WhatsApp" card was shown on a daily quest result (once per result); `source=result_card`, `step=verify` (number not yet verified) or `consent` (verified, one tap) |
| `whatsapp_prompt_dismissed` | "Not now" was tapped on that card (it then stays hidden until the next daily quest, the next UTC day); `source=result_card` |
| `whatsapp_unsubscribe_viewed` | The template's `?whatsapp=stop` link was opened, sent on page load before any sign-in; `source=link` |
| `report_sent` | A report was filed from the Report sheet; `source=inbox` (a received challenge), `clues` (the clue sheet during a friend hunt), `result` (a friend-hunt result) or `map` (another explorer's map), `reason=offensive_clues/harassment/sexual/offensive_username/spam/other` (the option chosen, a fixed code; the explorer's own details are never sent) |
| `explorer_blocked` | An explorer was blocked, from Block or from "Also block" on a report; `source` as for `report_sent` |
| `username_claim_fallback` | The `claimUsername` function was down or missing and the explorer had no profile yet, so the username was claimed directly (sent just before that write); `reason=internal/unavailable/not-found/deadline-exceeded` |

Daily-quest hunts reuse the hunt events with `mode=daily` and add `streak` on `hunt_completed`. Common properties include `account_status=guest/signed_in`, `mode=solo/daily/multiplayer`, `role`, and applicable hunt statistics. Time used includes paid clue, reveal and wrong-guess costs. Legacy friend hunts remain 120 seconds; current hunts use 180 seconds.

Multiplayer `won`/`lost` describes the **seeker**. A timeout is `outcome=lost`, `winner_role=hider`. `personal_win` on `result_viewed` describes the current viewer. Hiders and historical viewers do not emit a second `hunt_completed` conversion. Completed-hunt and result-view events are deduplicated by hunt/viewer within the current page lifecycle. Multiplayer completion waits for acknowledged writes, and action events precede the final completion/result events even when listeners deliver the result before a transaction promise resolves.

### Map hint

`onboarding_hint_shown` → `onboarding_hint_completed` measures whether new seekers find the map. A shown hint without a completion means the hunt ended or was left with no country selected (`hunt_completed` with `outcome=lost`, or `hunt_abandoned`). The hint is remembered in `localStorage` (`treasurehunch:map-hint-seen`); where storage is blocked it can show once per page load.

### WhatsApp funnel

Sign-in: `sign_in_opened` → `whatsapp_code_requested` (`purpose=login`) → `whatsapp_code_pasted` (optional) → `whatsapp_verified` → `login` (`method=whatsapp`) → `whatsapp_opt_in` (`source=sign_in`, if the consent box was ticked) → `sign_up` for new explorers. Alerts: after each daily quest (won or lost), signed-in explorers with a username who haven't opted in or out get an inline card under the result: `whatsapp_prompt_shown` (`source=result_card`) → `whatsapp_code_requested` (`purpose=verify_phone`) → `whatsapp_verified` → `whatsapp_opt_in` (`source=result_card`), or `whatsapp_prompt_dismissed`. Explorers with a verified number skip straight from the card to `whatsapp_opt_in`. The same card offers browser notifications where the browser can still ask, tracked as `notifications_permission` with `source=result_card`. Guests are asked on the WhatsApp sign-in form (`source=sign_in`) or in the username dialog after sign-in (`source=welcome`) instead. Unsubscribing: `whatsapp_unsubscribe_viewed` → `sign_in_opened` (`source=unsubscribe`, guests only) → `whatsapp_opt_out` (`source=unsubscribe`). Phone numbers and codes are never event parameters, and `reason` is a fixed code, not the server's message. Opting out by replying STOP to the WhatsApp message happens on the server (the `whatsappInbound` function), so it is not tracked client-side. Opt-outs from the unsubscribe link and from settings are.

### In-app browsers and the handoff

About nine in ten visits arrive from Instagram and Facebook ads, inside those apps' own browsers. Storage there is cut off from Chrome and Safari, so an explorer who signs up in Instagram is a guest again when the WhatsApp alert opens elsewhere; Google sign-in fails there and nothing can be installed. So a first visit is sent on to the real browser before the game loads (`src/escape.js`, inlined into `index.html`):

- Instagram, Facebook and Messenger on Android open Chrome by an `intent://` link; Instagram on iOS uses its own `instagram://extbrowser` link (Instagram asks the visitor to confirm); the WhatsApp alert link on iOS 17 or later opens Safari by `x-safari-https://`.
- Nobody with progress stored in that browser is moved, and two attempts that did not get out pause the redirect there for a week. A link with `?stay=1` is never redirected, which allows an ad test of the two behaviours.
- A browser that cannot follow the link may stop loading the page; it then reloads itself as an ordinary visit and is counted as `step=landed`, `outcome=in_app`.

Reading it: `open_in_browser` `step=landed` with `outcome=browser` are visits that got out. `step=auto` with `outcome=stayed`, and `step=landed` with `outcome=in_app`, are visits that did not. A page left behind by a working redirect sends nothing, so it never shows up as a second visitor; `outcome=left` marks the few that were counted before the visitor confirmed.

**Attribution across the handoff.** The handoff link keeps the whole query, and restores any `utm_*`, `fbclid`, `gclid`, `gbraid`, `wbraid`, `msclkid` or `ttclid` the visit landed with if the address bar has since changed. The game never strips those from the address bar: only its own parameters (`daily`, `atlas`, `whatsapp`, and the handoff's `from`, `iab`, `signin`, `install`, `ph_did`, `ph_sid`) are removed, so Meta, Google and PostHog all read the campaign from the page they load on. An automatic redirect happens before any analytics start, so the Chrome or Safari visit is the first and only one. A tapped link out also carries the PostHog visitor and session ids (`ph_did`, `ph_sid`); a browser PostHog has never seen adopts them, so the funnel continues as one person and one session. Google Analytics and Meta see a new browser there and rely on the campaign tags and click id.

Sign-in: where the visitor stays in the app's browser, the sign-in sheet shows WhatsApp only, plus the link out: `sign_in_opened` → `open_in_browser` (`step=tap`) → `open_in_browser` (`step=landed`) → `sign_in_opened` (`source=open_in_browser`) → `login` (`method=google`). Google failures are counted by `login_failed`.

### Installing

Install offers are made at two moments, and each ends in exactly one of `install_started` or `install_prompt_dismissed`:

- **After a win** (solo, daily or friend hunt). An explorer with a username gets the sheet: `hunt_completed` (`outcome=won`) → `install_prompt_shown` (`source=win`). A guest gets the sign-in ask first, with the card beneath it: `install_prompt_shown` (`source=result_card`).
- **After signing in.** `sign_in_opened` → `login` → (`sign_up` for a new explorer, who chooses a username first) → `install_prompt_shown` (`source=sign_in`).

A sign-up ask always goes first: the sheet waits while the username dialog or the daily quest alert card is open, and never opens for a guest. The sheet opens at most once every two days per device, and not at all for two days after any offer is turned down. From there: `install_started` → `app_installed`, or `install_prompt_dismissed`.

Inside an in-app browser the path is `install_started` (`method=open_in_browser`) → `open_in_browser` (`step=tap`, `source=install`) → `open_in_browser` (`step=landed`, `source=install`) → `install_prompt_shown` (`source=handoff`).

### PostHog-only settings

- Every PostHog event, including its own `$pageview`, clicks and exceptions, carries `app_version`, `display_mode` and, inside an in-app browser, `in_app`. Catalogue events carry `app_version` to Google and Meta as well.
- **App version.** `app_version` is the `version` in `package.json` (currently `0.2.0`, the first release with the installable app and the handoff; everything before it has no `app_version`). Bump it for any release whose numbers should be compared with the one before.
- The account stays on the first events of a visit: PostHog keeps `user_id` and `username` between visits and they are only cleared once Firebase reports the explorer signed out, and `account_status` starts from the last known state. Before `0.2.0`, `page_view`, `sign_in_opened` and `daily_link_opened` never carried an account.
- Uncaught errors and unhandled promise rejections are captured as `$exception` events (`capture_exceptions`), so they appear in PostHog error tracking. Errors thrown by an in-app browser's own injected scripts (`Java object is gone`) and bare cross-origin `Script error.` reports are dropped before sending; they were nine in ten of all exceptions.
- The map canvas is recorded in session replay at 4 frames a second (see `src/events.js`).
- Team devices: open the site once with `?internal=1` on each phone or browser you test with. That device then sends `is_internal=true` on every PostHog event; filter it out (for example as a test-account filter on `is_internal` is not set). `?internal=0` clears it. The flag is stored in that browser only.

## Reading the funnel in GA4

Use **Explore → Funnel exploration** with steps `hunt_started`, `country_selected`, `guess_submitted`, and `hunt_completed`. Break down by `mode` or `outcome`; use **Path exploration** to see where `clue_opened`, `country_revealed`, and `selection_cancelled` occur between guesses.

Register event-scoped custom dimensions in GA4 for `mode`, `role`, `outcome`, `winner_role`, `personal_win`, `source`, `method`, `purpose`, `step`, `reason`, `in_app`, `account_status`, `display_mode` and `app_version` when using them in saved explorations. Register custom metrics for `time_used`, `clues_opened`, `wrong_guesses`, and `cost_seconds` if desired. This change does not alter GA4 report definitions or mark events as key events. In Meta, custom conversions can use `hunt_completed` filtered by `outcome`, or `challenge_created` for the challenge-creation funnel.

Only allowlisted scalar custom properties reach providers. Display names, usernames, email, Firebase UID, clue text, invite codes, and arbitrary error messages are excluded from custom event payloads. The one country answer sent is the daily quest's `country` (ISO 3166 alpha-3 id) on its `hunt_completed`, after the hunt is over, so daily countries can be compared by difficulty; it is never on an event sent while that quest is live. Provider SDKs still collect their normal browser context such as page URL, referrer and campaign attribution.

## Validation and delivery

`npm test` includes provider parity, event naming, deduplication, sign-in context, payload filtering, unsupported/failed providers, and legacy timing tests. `scripts/validate-events.js` runs through Playwright's `browser_run_code` with local Firebase/Meta/Google adapters and verifies this real controller sequence:

`clue_opened` → `clue_opened` → `country_revealed` → `country_selected` → `selection_cancelled` → `country_selected` → `guess_submitted` (wrong) → `country_selected` → `guess_submitted` (correct) → `hunt_completed` → `result_viewed`.

A separate browser check exercised the actual solo UI's start, two paid clues, country reveal and abandon flow, with matching events in both provider adapters. Test traffic was not sent to the production analytics accounts. Deployed to Firebase Hosting on 29 October 2026 with the multiplayer changes. Live browser verification confirmed that the custom domain loads Meta `fbevents.js` and the Google tag for `G-3L7L0GB63N`. Production dashboard ingestion remains unverified. No additional Firebase rules or indexes are needed for analytics.

Implementation references: [Firebase Analytics setup](https://firebase.google.com/docs/analytics/web/get-started), [Firebase event logging](https://firebase.google.com/docs/analytics/web/events).
