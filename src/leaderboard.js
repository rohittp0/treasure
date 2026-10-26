import { ROUND_SECONDS } from './game.js';

// Each completed level contributes one result. Replaying a level can improve it.
export function scoreSoloHunts(hunts) {
  const bestTimeByLevel = new Map();
  for (const hunt of hunts) {
    if (hunt.result !== 'won' || !Number.isInteger(hunt.timeLeft) || hunt.timeLeft < 1 || hunt.timeLeft > ROUND_SECONDS) continue;
    const level = Number.isSafeInteger(hunt.level) && hunt.level > 0 ? hunt.level : 1;
    const timeUsed = ROUND_SECONDS - hunt.timeLeft;
    bestTimeByLevel.set(level, Math.min(bestTimeByLevel.get(level) ?? ROUND_SECONDS, timeUsed));
  }
  if (!bestTimeByLevel.size) return null;

  let weightedTime = 0;
  let totalWeight = 0;
  for (const [level, timeUsed] of bestTimeByLevel) {
    weightedTime += level * timeUsed;
    totalWeight += level;
  }
  return {
    averageTenths: Math.round(weightedTime * 10 / totalWeight),
    levelsCompleted: bestTimeByLevel.size,
    highestLevel: Math.max(...bestTimeByLevel.keys()),
  };
}
