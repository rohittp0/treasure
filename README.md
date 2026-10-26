# TreasureHunch

A mobile-first solo geography hunt. The player has two minutes to locate a hidden country on a MapLibre world map. The first clue is free; the next two cost 20 seconds each. A wrong confirmed guess costs 5 seconds. After opening all clues, the player can pay 30 seconds to reveal the country name, then find it on the map to win. The map stays full screen during a hunt, with a floating timer and clues that minimise as the player explores.

Hunts have easy, medium and hard country pools. The first two winning levels draw easy countries, levels 3–5 draw medium countries, and level 6 onward draws hard countries. Losing keeps the player on the same level. Solo progress is kept on this device; signed-in players also save completed hunts to Firestore, and their winning hunt count can restore progress on another device.

Solo hunts start without an account. After the first completed hunt, the result screen shows a public leaderboard. A winning guest can sign in with Google to post that find; each signed-in explorer keeps their best score, measured in seconds remaining.

A winning result celebrates the find and offers **Challenge a friend**. That opens the hiding flow with the just-found country selected, ready for the player to write their own clues. Guests sign in before creating the challenge.

Friend hunts require Google sign-in for both players. On first sign-in, each player claims a unique username and can opt into browser notifications. The hider searches for a country or taps the map to drop a pin, writes three clues, then shares a 10-character code or invite link. Alternatively, the hider enters a friend's username. That challenge is reserved for that account and appears in their inbox; the hider can still copy its invite link. The seeker gets the first clue free and plays with the same two-minute timer and time costs as solo mode. A Firestore listener keeps both screens in sync. Friend results live in `friendHunts` and never enter the solo leaderboard or advance solo levels.

## Run locally

Requires Node 22 and a modern browser with WebGL 2.

```sh
npm ci
npm run dev
```

The browser uses the 44 included puzzles if Firestore is unavailable. Google sign-in and cloud saving work when the page runs on a Firebase Auth authorized domain.

## Curated puzzles and Firebase

- [data/countries.json](data/countries.json) is the editorial source for 44 countries and 132 clues, each country marked easy, medium or hard. [data/CLUE-SOURCES.md](data/CLUE-SOURCES.md) records the references.
- `node scripts/seed-firestore.mjs` checks the data without writing. `node scripts/seed-firestore.mjs --write` publishes it to the `puzzles` collection in project `treasurehunch`, using the currently signed-in Firebase CLI account.
- Public clients can read active puzzles and leaderboard entries. Only a signed-in player can read their own profile and hunt history under `users/{uid}` or write their own best leaderboard entry. Puzzle writes require a privileged Firebase CLI account; the browser cannot edit them.
- Signed-in players save completed hunts in `users/{uid}/hunts`. A guest's best winning result is kept in the current browser session until sign-in.
- The leaderboard is a casual client-scored feature. Competitive anti-cheat would require server-validated rounds.
- A friend hunt stores the hidden country and pin in a separate Firestore document. Rules only let the hider read it until the seeker pays for the reveal or the hunt ends. Guess transitions are checked against that document by Firestore rules. This is a casual game: rejected writes can still be probed by a modified client, so friend scores deliberately stay off the leaderboard.
- Run `npm run test:rules` with Java and the Firebase CLI installed to verify friend-hunt rules in the Firestore emulator.

### Challenge delivery setup

In-app challenges are stored under the recipient's private `users/{uid}/notifications` collection. A foreground browser alert is shown when the page is open and the player grants permission. Background alerts use Firebase Cloud Messaging and the project's public Web Push VAPID key, now included in the client. `VITE_FIREBASE_VAPID_KEY` (or the GitHub Actions repository variable `FIREBASE_WEB_VAPID_KEY`) can override it. Enable the FCM Registration API and Cloud Messaging API for the Firebase project. The inbox still works if background alerts are unavailable.

Challenge emails are sent by the `emailFriendChallenge` Cloud Function through Resend. Its secret API key stays on the server; player email addresses are read from Firebase Auth only inside the function. Configure a verified sender address as the `CHALLENGE_EMAIL_FROM` Firebase parameter and set `RESEND_API_KEY` in Firebase Secret Manager. Functions deployment may require a billing-enabled Firebase project. The function uses Resend idempotency keys and allows at most one challenge email per sender and recipient each minute. The separate `notifyFriendChallenge` function sends background alerts to registered browsers. In-app inbox delivery does not depend on either function.

```sh
firebase functions:secrets:set RESEND_API_KEY --project treasurehunch
cd functions && npm ci && cd ..
firebase deploy --only firestore:rules,functions,hosting --project treasurehunch
```

The deploy prompts for `CHALLENGE_EMAIL_FROM`; enter a sender on your verified email domain. The function links to `https://treasurehunch.web.app/`. If the site uses a custom domain, update `huntUrl` in `functions/index.js` before deploying. Do not put the Resend key in a Vite or Hosting environment variable.

## Build and deploy

```sh
npm test
npm run build
firebase deploy --only firestore:rules,functions,hosting --project treasurehunch
```

Firebase Hosting serves `dist/`. The existing GitHub Actions workflow deploys Hosting on pushes to `main`; Firestore rules and Functions need the Firebase CLI deployment in the command above when they change. Hosting uses the `FIREBASE_SERVICE_ACCOUNT_TREASUREHUNCH` repository secret set up by Firebase init.

The map uses Natural Earth 1:110m public-domain country outlines; source and terms: https://www.naturalearthdata.com/about/terms-of-use/. The GeoJSON is compacted to the ID, name, and label position fields used by the game. MapLibre GL JS is BSD-3-Clause licensed. The bundled map-label glyphs come from MapLibre demo tiles.
