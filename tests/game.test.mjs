import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePuzzle, createGame } from '../src/game.js';

const japan = { id: 'JPN', country: 'Japan', clues: ['a', 'b', 'c'] };
const peru = { id: 'PER', country: 'Peru', clues: ['a', 'b', 'c'] };

test('last puzzle is avoided when another is available', () => {
  assert.equal(choosePuzzle([japan, peru], 'JPN', () => 0).id, 'PER');
});

test('selection is free; wrong guess costs five seconds and cannot be repeated', () => {
  let now = 0;
  const game = createGame(japan, () => now);
  game.select(peru);
  assert.equal(game.snapshot().remaining, 120);
  game.cancel();
  assert.equal(game.snapshot().remaining, 120);
  game.select(peru);
  game.guess();
  assert.equal(game.snapshot().remaining, 115);
  assert.equal(game.snapshot().wrongGuesses, 1);
  game.select(peru);
  game.guess();
  assert.equal(game.snapshot().wrongGuesses, 1);
  now = 10_000;
  assert.equal(game.tick().remaining, 105);
});

test('clues unlock in order, reveal waits for all clues, and correct map guess wins', () => {
  const game = createGame(japan, () => 0);
  game.reveal();
  assert.equal(game.snapshot().revealedCountry, false);
  game.unlock();
  game.unlock();
  assert.equal(game.snapshot().cluesVisible, 3);
  assert.equal(game.snapshot().remaining, 80);
  game.reveal();
  assert.equal(game.snapshot().remaining, 30);
  assert.equal(game.snapshot().revealedCountry, true);
  game.select({ id: 'JPN', country: 'Japan' });
  assert.equal(game.guess().status, 'won');
});

test('time costs cannot consume the final second and a round times out', () => {
  let now = 0;
  const game = createGame(japan, () => now);
  now = 99_000;
  game.unlock();
  assert.equal(game.snapshot().remaining, 1);
  game.unlock();
  assert.equal(game.snapshot().cluesVisible, 2);
  now = 100_000;
  assert.equal(game.tick().status, 'lost');
  game.select({ id: 'JPN', country: 'Japan' });
  assert.equal(game.guess().status, 'lost');
});
