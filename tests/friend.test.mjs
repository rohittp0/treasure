import test from 'node:test';
import assert from 'node:assert/strict';
import { canRevealFriendCountry, canUnlockFriendClue, friendSecondsLeft, makeHuntCode, normaliseHuntCode, validHuntCode } from '../src/friend.js';

test('invite codes are short, shareable, and reject ambiguous characters', () => {
  const code = makeHuntCode(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  assert.equal(code.length, 10);
  assert.equal(validHuntCode(code), true);
  assert.equal(normaliseHuntCode('  abcd-efghjk  '), 'ABCDEFGHJK');
  assert.equal(validHuntCode('ABCDOFGHJK'), false);
});

test('friend timer charges clues and stops at the end timestamp', () => {
  const hunt = { status: 'playing', startedAt: 100_000, endedAt: null, costSeconds: 0, cluesVisible: 1, revealed: false };
  assert.equal(friendSecondsLeft(hunt, 100_000), 120);
  assert.equal(canUnlockFriendClue(hunt, 100_000), true);
  hunt.costSeconds = 20;
  hunt.cluesVisible = 2;
  assert.equal(friendSecondsLeft(hunt, 130_000), 70);
  hunt.cluesVisible = 3;
  assert.equal(canRevealFriendCountry(hunt, 130_000), true);
  hunt.costSeconds = 70;
  assert.equal(canRevealFriendCountry(hunt, 130_000), false);
  hunt.endedAt = 145_000;
  hunt.status = 'lost';
  assert.equal(friendSecondsLeft(hunt, 200_000), 5);
});
