import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSoloHunts } from '../src/leaderboard.js';

test('later levels weigh more in the average time used', () => {
  const result = scoreSoloHunts([
    { result: 'won', level: 1, timeLeft: 110 }, // 10 seconds, weight 1
    { result: 'won', level: 2, timeLeft: 80 },  // 40 seconds, weight 2
    { result: 'won', level: 3, timeLeft: 60 },  // 60 seconds, weight 3
  ]);
  assert.deepEqual(result, { averageTenths: 450, levelsCompleted: 3, highestLevel: 3, dailyFinds: 0 });
});

test('replays use the best win for each level and losses do not count', () => {
  const result = scoreSoloHunts([
    { result: 'won', level: 2, timeLeft: 90 },
    { result: 'won', level: 2, timeLeft: 100 },
    { result: 'lost', level: 3, timeLeft: 0 },
    { result: 'won', level: 1, timeLeft: 115 },
  ]);
  assert.deepEqual(result, { averageTenths: 150, levelsCompleted: 2, highestLevel: 2, dailyFinds: 0 });
  assert.equal(scoreSoloHunts([{ result: 'lost', level: 1, timeLeft: 0 }]), null);
});

test('two-minute history and three-minute wins use their actual time used', () => {
  const result = scoreSoloHunts([
    { result: 'won', level: 1, timeLeft: 110 },
    { result: 'won', level: 2, roundSeconds: 180, timeLeft: 170 },
  ]);
  assert.deepEqual(result, { averageTenths: 100, levelsCompleted: 2, highestLevel: 2, dailyFinds: 0 });
  assert.deepEqual(scoreSoloHunts([{ result: 'won', level: 1, roundSeconds: 180, timeLeft: 1 }]),
    { averageTenths: 1790, levelsCompleted: 1, highestLevel: 1, dailyFinds: 0 });
});

test('a daily find counts double the highest level reached', () => {
  const result = scoreSoloHunts([
    { result: 'won', level: 1, roundSeconds: 180, timeLeft: 170 }, // 10 seconds, weight 1
    { result: 'won', level: 2, roundSeconds: 180, timeLeft: 160 }, // 20 seconds, weight 2
  ], [
    { day: '2026-11-01', status: 'won', timeUsed: 60, puzzleId: 'JPN' }, // weight 4
    { day: '2026-11-02', status: 'lost', timeUsed: 180, puzzleId: 'PER' },
  ]);
  // (10 + 40 + 240) / 7 = 41.43 seconds
  assert.deepEqual(result, { averageTenths: 414, levelsCompleted: 2, highestLevel: 2, dailyFinds: 1 });
});

test('daily finds alone can enter the all-time board', () => {
  assert.deepEqual(scoreSoloHunts([], [{ day: '2026-11-03', status: 'won', timeUsed: 45, puzzleId: 'FRA' }]),
    { averageTenths: 450, levelsCompleted: 0, highestLevel: 0, dailyFinds: 1 });
  assert.equal(scoreSoloHunts([], [{ day: '2026-11-03', status: 'lost', timeUsed: 180, puzzleId: 'FRA' }]), null);
});
