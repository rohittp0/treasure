# TreasureHunch

A mobile-first solo geography hunt. The player has two minutes to locate a hidden country on a MapLibre world map. The first clue is free; the next two cost 20 seconds each. A wrong confirmed guess costs 5 seconds. After opening all clues, the player can pay 50 seconds to reveal the country name, then find it on the map to win. The map stays full screen during a hunt, with a floating timer and clues that minimise as the player explores.

Hunts have easy, medium and hard country pools. The first two winning levels draw easy countries, levels 3–5 draw medium countries, and level 6 onward draws hard countries. Losing keeps the player on the same level. Solo progress is kept on this device; signed-in players also save completed hunts to Firestore, and their winning hunt count can restore progress on another device.

Solo hunts start without an account. After the first completed hunt, the result screen shows a public leaderboard. A winning guest can sign in with Google to post that find; each signed-in explorer keeps their best score, measured in seconds remaining.

Friend hunts require Google sign-in for both players. The hider searches for a country or taps the map to drop a pin, writes three clues, then shares a 10-character code or invite link. The seeker gets the first clue free and plays with the same two-minute timer and time costs as solo mode. A Firestore listener keeps both screens in sync. Friend results live in `friendHunts` and never enter the solo leaderboard or advance solo levels.

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

## Build and deploy

```sh
npm test
npm run build
firebase deploy --only firestore:rules,hosting --project treasurehunch
```

Firebase Hosting serves `dist/`. The existing GitHub Actions workflow deploys Hosting on pushes to `main`; Firestore rules need the Firebase CLI deployment in the command above when they change. Hosting uses the `FIREBASE_SERVICE_ACCOUNT_TREASUREHUNCH` repository secret set up by Firebase init.

The map uses Natural Earth 1:110m public-domain country outlines; source and terms: https://www.naturalearthdata.com/about/terms-of-use/. The GeoJSON is compacted to the ID, name, and label position fields used by the game. MapLibre GL JS is BSD-3-Clause licensed. The bundled map-label glyphs come from MapLibre demo tiles.
