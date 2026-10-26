import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSoloHunts } from '../src/leaderboard.js';

test('later levels weigh more in the average time used', () => {
  const result = scoreSoloHunts([
    { result: 'won', level: 1, timeLeft: 110 }, // 10 seconds, weight 1
    { result: 'won', level: 2, timeLeft: 80 },  // 40 seconds, weight 2
    { result: 'won', level: 3, timeLeft: 60 },  // 60 seconds, weight 3
  ]);
  assert.deepEqual(result, { averageTenths: 450, levelsCompleted: 3, highestLevel: 3 });
});

test('replays use the best win for each level and losses do not count', () => {
  const result = scoreSoloHunts([
    { result: 'won', level: 2, timeLeft: 90 },
    { result: 'won', level: 2, timeLeft: 100 },
    { result: 'lost', level: 3, timeLeft: 0 },
    { result: 'won', level: 1, timeLeft: 115 },
  ]);
  assert.deepEqual(result, { averageTenths: 150, levelsCompleted: 2, highestLevel: 2 });
  assert.equal(scoreSoloHunts([{ result: 'lost', level: 1, timeLeft: 0 }]), null);
});
