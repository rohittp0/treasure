import test from 'node:test';
import assert from 'node:assert/strict';
import { clockText, huntSheetKey } from '../src/hunt-view.js';
import { createGame } from '../src/game.js';

const japan = { id: 'JPN', country: 'Japan', difficulty: 'easy', clues: ['a', 'b', 'c'] };

test('the clock shows minutes and padded seconds', () => {
  assert.equal(clockText(180), '3:00');
  assert.equal(clockText(65), '1:05');
  assert.equal(clockText(0), '0:00');
});

test('the sheet key ignores ticking time but follows clues, guesses and selection', () => {
  let now = 0;
  const game = createGame(japan, () => now);
  const keys = [huntSheetKey(game.tick())];
  now = 30_000;
  assert.equal(huntSheetKey(game.tick()), keys[0]);
  keys.push(huntSheetKey(game.select({ id: 'ITA', country: 'Italy' })));
  keys.push(huntSheetKey(game.guess()));
  keys.push(huntSheetKey(game.unlock()));
  keys.push(huntSheetKey(game.unlock()));
  keys.push(huntSheetKey(game.reveal()));
  keys.push(huntSheetKey(game.select({ id: 'JPN', country: 'Japan' })));
  keys.push(huntSheetKey(game.cancel()));
  // Cancelling returns to the state before the selection.
  assert.equal(keys.at(-1), keys.at(-3));
  assert.equal(new Set(keys.slice(0, -1)).size, keys.length - 1);
});

test('the sheet key changes when time gets too short to pay for a clue or a reveal', () => {
  let now = 0;
  const game = createGame(japan, () => now);
  now = 155_000;
  const plenty = huntSheetKey(game.tick());
  now = 156_000;
  assert.equal(huntSheetKey(game.tick()), plenty);
  now = 161_000;
  assert.notEqual(huntSheetKey(game.tick()), plenty);
});
