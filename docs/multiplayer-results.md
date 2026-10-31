# Multiplayer results and posters

The result model in `src/friend-result.js` supplies live results, reopened historical results, log entries and PNG posters. Stored `won` means the seeker found the treasure; stored `lost` means the hider won on timeout. The viewer's personal outcome is calculated separately. Participants can export every completed challenge, including losses. Spectators retain the existing signed-in completed-hunt access and cannot load the private country or export a poster.

The seeker's time used remains `friendRoundSeconds(match) - friendSecondsLeft(match)`: wall time plus clue, reveal and wrong-guess costs, clamped by the existing timer. Missing `roundSeconds` means the original 120-second hunt, not the current 180-second hunt. Names, country and statistics are rendered as text; none are baked into the illustrations.

“My logs” reads `friendHunts` using two equality queries: `hiderUid == currentUser.uid` and `seekerUid == currentUser.uid`. Results are deduplicated and sorted locally by completion date (or creation date for unfinished challenges). This includes older games and sent, unaccepted challenges. Waiting games say “Not yet accepted”; active games say “In progress”. Opening a pending sent challenge restores the existing invitation screen. Solo totals and leaderboard writes are unchanged.

## Deployment

Deploy the Firestore rule update **before** deploying the web build:

```sh
firebase deploy --only firestore:rules
npm run build
firebase deploy --only hosting
```

`friendHunts` list reads now require the authenticated user to be the hider or seeker. Both client queries are restricted to that user's UID. Unscoped queries and queries for someone else's games are denied. Private answer rules and direct document access rules are unchanged.

No composite indexes or backfill are required. The queries use Firestore's default single-field indexes on `hiderUid` and `seekerUid` and intentionally avoid server-side ordering/status filters that would exclude legacy records or require composite indexes. If these fields have index exemptions in the deployed project, restore their default ascending indexes first. This checkout contains no index exemption configuration.

Deployed Firestore rules first, then Firebase Hosting to project `treasurehunch` on 29 October 2026. The custom domain `https://hunch.rohittp.com/` was checked after release.

## Sharing

Posters are generated locally as 1080 × 1560 PNGs, with a torn parchment composition, original rivalry illustration, player identities, actual winner, hidden country, time used, clues, wrong guesses, TreasureHunch branding and the canonical game URL. Font loading is awaited; unavailable fonts fall back to installed fonts. Text fits dedicated regions, including long names and unavailable country data. App controls are excluded.

The PNG is prepared before the share button becomes available, preserving user activation for native file sharing. `navigator.canShare({files})` gates native file sharing. Unsupported or failed sharing downloads the PNG; cancellation produces no error or download. Temporary object URLs are revoked after the download starts. Native share-sheet appearance still requires physical-device acceptance; automated checks exercise supported, unsupported, failure and cancellation branches with adapters.

## Verification

- `npm test`: result roles/outcomes, cost-inclusive and legacy timing, missing country, escaped/long names, history ordering/deduplication, pending state, native sharing/cancellation/download fallback, and existing gameplay/leaderboard tests.
- `npm run test:rules`: Firestore emulator tests, including successful own-role history queries, rejection of other-user and unscoped queries, and existing private-answer checks.
- `npm run build`: production bundle (existing large-bundle advisory remains).
- `scripts/validate-multiplayer.js`: Playwright `browser_run_code` fixture workflow against local Vite at port 5173. It uses actual app screens/controllers and a substituted Firebase module from `tests/fixtures/multiplayer-firebase.js`; it performs no production writes. Run with the repository as the browser workspace and create `output/multiplayer` first. It covers both roles/outcomes, rematch preselection, history reopening, pending/active/empty/retry states, participant poster access, spectators, 320px long names, missing country, legacy timing, PNG downloads and screenshot capture.

Rendered evidence is in `output/multiplayer/`: `seeker-won-mobile.png`, `seeker-lost-mobile.png`, `hider-won-mobile.png`, `hider-lost-mobile.png`, `victory-desktop.png`, `multiplayer-logs-mobile.png`, `long-names-mobile.png`, `poster-seeker.png`, `poster-hider.png`, and `poster-long-names.png`. Output files are intentionally ignored by Git; the fixture and validation source are tracked deliverables.

## Illustration sources

Generated using the built-in image generation tool, then copied into `public/illustrations/victory.png` and `public/illustrations/defeat.png`. The user's mockup was used only as a layout reference; the assets are the original generated rivalry artwork. The initial cooperative high-five illustration was discarded.

Final prompt direction for victory: storybook gouache and fine ink on warm parchment, deep teal and copper; a triumphant seeker claims an open treasure chest and coin while the frustrated rival hider stands separately with folded arms; no collaboration, touching, text or UI.

Final prompt direction for timeout: the disappointed but determined seeker sits with a map beside a closed locked chest and empty hourglass; the smug victorious hider stands separately guarding the chest; the same parchment, deep teal, copper and storybook treatment; no collaboration, text or UI.
