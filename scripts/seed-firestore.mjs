import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const projectId = 'treasurehunch';
const countries = JSON.parse(readFileSync(new URL('../data/countries.json', import.meta.url)));
const map = JSON.parse(readFileSync(new URL('../public/countries.geojson', import.meta.url)));
const mapIds = new Set(map.features.map(feature => feature.properties.id));
const difficulties = new Set(['easy', 'medium', 'hard']);

if (countries.length < 44 || new Set(countries.map(country => country.id)).size !== countries.length) {
  throw new Error('Puzzle set needs at least 44 unique countries.');
}
for (const country of countries) {
  if (!/^[A-Z]{3}$/.test(country.id) || !mapIds.has(country.id)
    || !difficulties.has(country.difficulty) || !/^[A-Z]{2}$/.test(country.iso2)
    || country.clues?.length !== 3 || country.clues.some(clue => typeof clue !== 'string' || !clue.trim())
    || !country.fact?.trim()) {
    throw new Error(`Invalid puzzle: ${country.id}`);
  }
}
for (const difficulty of difficulties) {
  if (!countries.some(country => country.difficulty === difficulty)) throw new Error(`No ${difficulty} puzzles found.`);
}

if (!process.argv.includes('--write')) {
  console.log(`Dry run: ${countries.length} valid countries are ready for Firestore. Pass --write to publish them.`);
  process.exit(0);
}

// Reuse the same signed-in account as the Firebase CLI. The CLI's auth helper is
// loaded from the executable rather than copying any credential into this repo.
const firebaseExecutable = realpathSync(execFileSync('which', ['firebase'], { encoding: 'utf8' }).trim());
const require = createRequire(import.meta.url);
const auth = require(resolve(dirname(firebaseExecutable), '../auth.js'));
const account = auth.getProjectDefaultAccount(process.cwd());
if (!account?.tokens?.refresh_token) throw new Error('Sign in first with `firebase login`.');
const token = (await auth.getAccessToken(account.tokens.refresh_token, [])).access_token;

const value = item => {
  if (typeof item === 'string') return { stringValue: item };
  if (typeof item === 'boolean') return { booleanValue: item };
  if (Array.isArray(item)) return { arrayValue: { values: item.map(value) } };
  throw new Error('Unsupported Firestore value');
};

const database = `projects/${projectId}/databases/(default)`;
const writes = countries.map(country => {
  const record = { ...country, active: true };
  return {
    update: {
      name: `${database}/documents/puzzles/${country.id}`,
      fields: Object.fromEntries(Object.entries(record).map(([key, item]) => [key, value(item)])),
    },
  };
});

const response = await fetch(`https://firestore.googleapis.com/v1/${database}/documents:commit`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ writes }),
});
if (!response.ok) {
  const failure = await response.json().catch(() => ({}));
  throw new Error(`Firestore publish failed (${response.status}): ${failure.error?.message || response.statusText}`);
}
const result = await response.json();
if (result.writeResults?.length !== countries.length) throw new Error('Firestore did not acknowledge every puzzle.');
console.log(`Published ${result.writeResults.length} country puzzles to ${projectId} Firestore.`);
