// The daily quest: one country per UTC day, the same for every explorer.
import { ROUND_SECONDS } from './game.js';

export const DAY_MS = 86_400_000;
// Score order for a monthly board: more finds first, then less total time used.
export const MONTHLY_FIND_POINTS = 10_000;

export function dayKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

export function monthKey(date = new Date()) {
  return dayKey(date).slice(0, 7);
}

export function isDayKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function daysInMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

export function msUntilNextDay(now = Date.now()) {
  return DAY_MS - (now % DAY_MS);
}

// Small seeded PRNG so every browser builds the same month schedule.
function seededRandom(seedText) {
  let seed = 2166136261;
  for (const character of seedText) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Each month shuffles the whole country list once, so no country repeats within a month
// while the list is at least as long as the month.
export function monthSchedule(puzzles, month) {
  const ordered = [...puzzles].sort((a, b) => a.id.localeCompare(b.id));
  const random = seededRandom(`treasurehunch-daily:${month}`);
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [ordered[index], ordered[swap]] = [ordered[swap], ordered[index]];
  }
  return ordered;
}

export function dailyPuzzle(puzzles, day = dayKey()) {
  if (!puzzles.length) throw new Error('No daily quest is available.');
  const schedule = monthSchedule(puzzles, day.slice(0, 7));
  const dayOfMonth = Number(day.slice(8, 10));
  return schedule[(dayOfMonth - 1) % schedule.length];
}

export function validDailyRecord(record) {
  return !!record && isDayKey(record.day) && ['won', 'lost'].includes(record.status) &&
    Number.isInteger(record.timeUsed) && record.timeUsed >= 0 && record.timeUsed <= ROUND_SECONDS;
}

// Consecutive found days ending today, or yesterday if today is not finished yet. Losing today breaks it.
export function currentStreak(records, today = dayKey()) {
  if (records.some(record => record.day === today && record.status === 'lost')) return 0;
  const won = new Set(records.filter(record => validDailyRecord(record) && record.status === 'won').map(record => record.day));
  let cursor = Date.parse(`${today}T00:00:00Z`);
  if (!won.has(today)) cursor -= DAY_MS;
  let streak = 0;
  while (won.has(dayKey(cursor))) {
    streak += 1;
    cursor -= DAY_MS;
  }
  return streak;
}

export function scoreMonth(records, month) {
  const finished = records.filter(record => validDailyRecord(record) && record.day.startsWith(`${month}-`));
  const finds = finished.filter(record => record.status === 'won');
  const timeUsed = finds.reduce((total, record) => total + record.timeUsed, 0);
  return {
    month,
    found: finds.length,
    played: finished.length,
    timeUsed,
    rankScore: finds.length * MONTHLY_FIND_POINTS - timeUsed,
  };
}

// The explorer's map: every country collected from a daily find, keyed by ISO id.
export function atlasFromRecords(records) {
  const countries = {};
  for (const record of [...records].sort((a, b) => a.day.localeCompare(b.day))) {
    if (validDailyRecord(record) && record.status === 'won' && /^[A-Z]{3}$/.test(record.puzzleId) && !countries[record.puzzleId])
      countries[record.puzzleId] = record.day;
  }
  return countries;
}

export function mergeDailyRecords(...lists) {
  const byDay = new Map();
  for (const record of lists.flat()) {
    if (!record || !isDayKey(record.day)) continue;
    const existing = byDay.get(record.day);
    // A finished record always wins over an in-progress one for the same day.
    if (!existing || (existing.status === 'playing' && record.status !== 'playing')) byDay.set(record.day, record);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}
