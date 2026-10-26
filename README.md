# TreasureHunch

A mobile-first solo geography hunt. The player has two minutes to locate a hidden country on a MapLibre world map. The first clue is free; the next two cost 20 seconds each. A wrong confirmed guess costs 5 seconds. After opening all clues, the player can pay 50 seconds to reveal the country name, then find it on the map to win.

Solo hunts start without an account. After the first completed hunt, the result screen shows a public leaderboard. A winning guest can sign in with Google to post that find; each signed-in explorer keeps their best score, measured in seconds remaining. The home screen offers a multiplayer entry that requires sign-in and clearly marks friend hunts as coming soon.

## Run locally

Requires Node 22 and a modern browser with WebGL 2.

```sh
npm ci
npm run dev
```

The browser uses the 24 included puzzles if Firestore is unavailable. Google sign-in and cloud saving work when the page runs on a Firebase Auth authorized domain.

## Curated puzzles and Firebase

- [data/countries.json](data/countries.json) is the editorial source for 24 countries and 72 clues. [data/CLUE-SOURCES.md](data/CLUE-SOURCES.md) records the references.
- `node scripts/seed-firestore.mjs` checks the data without writing. `node scripts/seed-firestore.mjs --write` publishes it to the `puzzles` collection in project `treasurehunch`, using the currently signed-in Firebase CLI account.
- Public clients can read active puzzles and leaderboard entries. Only a signed-in player can read their own profile and hunt history under `users/{uid}` or write their own best leaderboard entry. Puzzle writes require a privileged Firebase CLI account; the browser cannot edit them.
- Signed-in players save completed hunts in `users/{uid}/hunts`. A guest's best winning result is kept in the current browser session until sign-in.
- The leaderboard is a casual client-scored feature. Competitive anti-cheat would require server-validated rounds.

## Build and deploy

```sh
npm test
npm run build
firebase deploy --only firestore:rules,hosting --project treasurehunch
```

Firebase Hosting serves `dist/`. The existing GitHub Actions build and deploy on merges to `main` or create a preview for pull requests. They require the `FIREBASE_SERVICE_ACCOUNT_TREASUREHUNCH` repository secret set up by Firebase init.

The map uses Natural Earth 1:110m public-domain country outlines; source and terms: https://www.naturalearthdata.com/about/terms-of-use/. The GeoJSON is compacted to the ID, name, and label position fields used by the game. MapLibre GL JS is BSD-3-Clause licensed. The bundled map-label glyphs come from MapLibre demo tiles.
