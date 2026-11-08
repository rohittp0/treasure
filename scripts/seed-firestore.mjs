import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const projectId = 'treasurehunch';
const countries = JSON.parse(readFileSync(new URL('../data/countries.json', import.meta.url)));
const dailyQuests = JSON.parse(readFileSync(new URL('../data/daily-quests.json', import.meta.url)));
const map = JSON.parse(readFileSync(new URL('../public/countries.geojson', import.meta.url)));
const mapIds = new Set(map.features.map(feature => feature.properties.id));
const difficulties = new Set(['easy', 'medium', 'hard', 'expert']);
const validPuzzle = country => /^[A-Z]{3}$/.test(country.id) && mapIds.has(country.id)
  && difficulties.has(country.difficulty) && /^[A-Z]{2}$/.test(country.iso2)
  && country.clues?.length === 3 && country.clues.every(clue => typeof clue === 'string' && clue.trim())
  && !!country.fact?.trim()
  && !country.clues.some(clue => clue.toLowerCase().includes(country.country.replace(/^The /, '').toLowerCase()));

if (countries.length < 44 || new Set(countries.map(country => country.id)).size !== countries.length) {
  throw new Error('Puzzle set needs at least 44 unique countries.');
}
for (const country of countries) {
  if (!validPuzzle(country)) throw new Error(`Invalid puzzle: ${country.id}`);
}

// Daily lists: one entry per day of the month, no repeats, and no overlap with solo levels.
const soloIds = new Set(countries.map(country => country.id));
const dailyIds = new Set();
for (const [month, days] of Object.entries(dailyQuests)) {
  const [year, monthNumber] = month.split('-').map(Number);
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  if (!/^\d{4}-\d{2}$/.test(month) || days.length !== length) throw new Error(`Daily list ${month} needs ${length} days.`);
  for (const day of days) {
    if (!validPuzzle(day)) throw new Error(`Invalid daily quest in ${month}: ${day.id}`);
    if (soloIds.has(day.id)) throw new Error(`${day.id} is a solo country and cannot be in the daily list.`);
    if (dailyIds.has(day.id)) throw new Error(`${day.id} appears more than once in the daily lists.`);
    dailyIds.add(day.id);
  }
}
for (const difficulty of difficulties) {
  if (!countries.some(country => country.difficulty === difficulty)) throw new Error(`No ${difficulty} puzzles found.`);
}

if (!process.argv.includes('--write')) {
  console.log(`Dry run: ${countries.length} solo countries and ${dailyIds.size} daily quests in ${Object.keys(dailyQuests).length} monthly lists are ready for Firestore. Pass --write to publish them.`);
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
  if (item && typeof item === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, value(entry)])) } };
  throw new Error('Unsupported Firestore value');
};

const database = `projects/${projectId}/databases/(default)`;
const document = (path, record) => ({
  update: {
    name: `${database}/documents/${path}`,
    fields: Object.fromEntries(Object.entries(record).map(([key, item]) => [key, value(item)])),
  },
});
const writes = [
  ...countries.map(country => document(`puzzles/${country.id}`, { ...country, active: true })),
  ...Object.entries(dailyQuests).map(([month, days]) => document(`dailyQuests/${month}`, { month, days })),
];

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
if (result.writeResults?.length !== writes.length) throw new Error('Firestore did not acknowledge every write.');
console.log(`Published ${countries.length} solo puzzles and ${Object.keys(dailyQuests).length} daily quest lists to ${projectId} Firestore.`);
