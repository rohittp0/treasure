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
| `login` | Successful Google popup or redirect login; `method` |
| `sign_up` | Successfully claimed the first username; `method` |
| `logout` | Successful sign-out |
| `hunt_started` | Solo hunt actually starts or seeker accepts a waiting challenge; `mode`, `role`, `level`, `difficulty`, `round_seconds` where applicable |
| `country_selected` | A valid country is selected on the map; `method=map`, current hunt stats |
| `selection_cancelled` | Player explicitly cancels a selected country; current hunt stats |
| `guess_submitted` | Confirmed solo guess or successfully committed multiplayer guess; `outcome=correct/wrong`, `wrong_guesses`, `cost_seconds` |
| `clue_opened` | An additional clue is successfully opened; `clue_number`, `clues_opened`, `cost_seconds=20` |
| `country_revealed` | Country reveal succeeds; `revealed=true`, `cost_seconds=30` |
| `hunt_completed` | Solo win/timeout, or a confirmed multiplayer completion observed during seeker gameplay; `outcome=won/lost`, `winner_role`, time/clue/guess stats |
| `hunt_abandoned` | Player exits an unfinished solo or seeker hunt, including switching to a different hunt; current hunt stats. Closing the browser without using an exit action is not counted. |
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
| `leaderboard_viewed` | Leaderboard opened from a button; `source=home/result` |
| `notifications_permission` | Notification permission prompt resolves; `permission` |

Common properties include `account_status=guest/signed_in`, `mode=solo/multiplayer`, `role`, and applicable hunt statistics. Time used includes paid clue, reveal and wrong-guess costs. Legacy friend hunts remain 120 seconds; current hunts use 180 seconds.

Multiplayer `won`/`lost` describes the **seeker**. A timeout is `outcome=lost`, `winner_role=hider`. `personal_win` on `result_viewed` describes the current viewer. Hiders and historical viewers do not emit a second `hunt_completed` conversion. Completed-hunt and result-view events are deduplicated by hunt/viewer within the current page lifecycle. Multiplayer completion waits for acknowledged writes, and action events precede the final completion/result events even when listeners deliver the result before a transaction promise resolves.

## Reading the funnel in GA4

Use **Explore → Funnel exploration** with steps `hunt_started`, `country_selected`, `guess_submitted`, and `hunt_completed`. Break down by `mode` or `outcome`; use **Path exploration** to see where `clue_opened`, `country_revealed`, and `selection_cancelled` occur between guesses.

Register event-scoped custom dimensions in GA4 for `mode`, `role`, `outcome`, `winner_role`, `personal_win`, `source`, `method`, and `account_status` when using them in saved explorations. Register custom metrics for `time_used`, `clues_opened`, `wrong_guesses`, and `cost_seconds` if desired. This change does not alter GA4 report definitions or mark events as key events. In Meta, custom conversions can use `hunt_completed` filtered by `outcome`, or `challenge_created` for the challenge-creation funnel.

Only allowlisted scalar custom properties reach providers. Display names, usernames, email, Firebase UID, country answers, clue text, invite codes, and arbitrary error messages are excluded from custom event payloads. Provider SDKs still collect their normal browser context such as page URL, referrer and campaign attribution.

## Validation and delivery

`npm test` includes provider parity, event naming, deduplication, sign-in context, payload filtering, unsupported/failed providers, and legacy timing tests. `scripts/validate-events.js` runs through Playwright's `browser_run_code` with local Firebase/Meta/Google adapters and verifies this real controller sequence:

`clue_opened` → `clue_opened` → `country_revealed` → `country_selected` → `selection_cancelled` → `country_selected` → `guess_submitted` (wrong) → `country_selected` → `guess_submitted` (correct) → `hunt_completed` → `result_viewed`.

A separate browser check exercised the actual solo UI's start, two paid clues, country reveal and abandon flow, with matching events in both provider adapters. Test traffic was not sent to the production analytics accounts. Deployed to Firebase Hosting on 29 October 2026 with the multiplayer changes. Live browser verification confirmed that the custom domain loads Meta `fbevents.js` and the Google tag for `G-3L7L0GB63N`. Production dashboard ingestion remains unverified. No additional Firebase rules or indexes are needed for analytics.

Implementation references: [Firebase Analytics setup](https://firebase.google.com/docs/analytics/web/get-started), [Firebase event logging](https://firebase.google.com/docs/analytics/web/events).
