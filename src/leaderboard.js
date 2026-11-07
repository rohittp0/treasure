import { ROUND_SECONDS } from './game.js';
import { validDailyRecord } from './daily.js';

// A daily find always outweighs any single solo level: it counts double the highest level reached.
export function dailyFindWeight(highestLevel) {
  return 2 * Math.max(1, highestLevel);
}

// Each completed level contributes one result. Replaying a level can improve it.
// Each daily-quest find contributes one more result with the daily weight.
export function scoreSoloHunts(hunts, dailyRecords = []) {
  const bestTimeByLevel = new Map();
  for (const hunt of hunts) {
    const roundSeconds = hunt.roundSeconds ?? 120;
    if (hunt.result !== 'won' || !Number.isInteger(roundSeconds) || roundSeconds < 120 || roundSeconds > ROUND_SECONDS ||
      !Number.isInteger(hunt.timeLeft) || hunt.timeLeft < 1 || hunt.timeLeft > roundSeconds) continue;
    const level = Number.isSafeInteger(hunt.level) && hunt.level > 0 ? hunt.level : 1;
    const timeUsed = roundSeconds - hunt.timeLeft;
    bestTimeByLevel.set(level, Math.min(bestTimeByLevel.get(level) ?? ROUND_SECONDS, timeUsed));
  }
  const dailyByDay = new Map();
  for (const record of dailyRecords) {
    if (validDailyRecord(record) && record.status === 'won' && record.timeUsed < ROUND_SECONDS) dailyByDay.set(record.day, record.timeUsed);
  }
  if (!bestTimeByLevel.size && !dailyByDay.size) return null;

  const highestLevel = bestTimeByLevel.size ? Math.max(...bestTimeByLevel.keys()) : 0;
  let weightedTime = 0;
  let totalWeight = 0;
  for (const [level, timeUsed] of bestTimeByLevel) {
    weightedTime += level * timeUsed;
    totalWeight += level;
  }
  const dailyWeight = dailyFindWeight(highestLevel);
  for (const timeUsed of dailyByDay.values()) {
    weightedTime += dailyWeight * timeUsed;
    totalWeight += dailyWeight;
  }
  return {
    averageTenths: Math.round(weightedTime * 10 / totalWeight),
    levelsCompleted: bestTimeByLevel.size,
    highestLevel,
    dailyFinds: dailyByDay.size,
  };
}
