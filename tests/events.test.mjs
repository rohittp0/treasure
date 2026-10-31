import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, META_PIXEL_ID, createEventTracker, cleanEventParameters, soloEventParameters, posthogUserProperties } from '../src/events.js';

test('one catalogue sends the same event data to Google and Meta', () => {
  const google = [], meta = [];
  const tracker = createEventTracker({ google: (...args) => google.push(args), meta: (...args) => meta.push(args) });
  tracker.track(EVENTS.PAGE_VIEW);
  tracker.setSignedIn(true);
  tracker.track(EVENTS.HUNT_STARTED, { mode: 'solo', level: 3 });
  tracker.track(EVENTS.SIGN_UP, { method: 'google' });
  assert.equal(META_PIXEL_ID, '1540952161129164');
  assert.equal(meta[0][0], 'track'); assert.equal(meta[0][1], 'PageView');
  assert.deepEqual(meta[1], ['trackCustom', 'hunt_started', google[1][1]]);
  assert.equal(meta[2][1], 'CompleteRegistration');
  assert.equal(google[0][1].account_status, 'guest');
  assert.equal(google[1][1].account_status, 'signed_in');
});

test('PostHog receives every catalogue event with the cleaned payload', () => {
  const google = [], posthog = [];
  const tracker = createEventTracker({ google: (...args) => google.push(args), posthog: (...args) => posthog.push(args) });
  for (const name of Object.values(EVENTS)) tracker.track(name, { mode: 'solo', email: 'private@example.com' });
  assert.deepEqual(posthog, google);
  assert.equal(posthog.length, Object.keys(EVENTS).length);
  assert.deepEqual(posthog[0], ['page_view', { mode: 'solo', account_status: 'guest' }]);
  let googleCalls = 0;
  const failing = createEventTracker({ posthog: () => { throw new Error('blocked'); }, google: () => googleCalls++ });
  assert.doesNotThrow(() => failing.track(EVENTS.HUNT_STARTED));
  assert.equal(googleCalls, 1);
});

test('PostHog global properties carry the account and clear on sign-out', () => {
  assert.deepEqual(posthogUserProperties({ uid: 'abc', username: 'scout', email: 'private@example.com' }), { user_id: 'abc', username: 'scout' });
  assert.deepEqual(posthogUserProperties({ uid: 'abc' }), { user_id: 'abc', username: null });
  assert.deepEqual(posthogUserProperties(null), { user_id: null, username: null });
});

test('unknown events and sensitive or invalid parameters never reach providers', () => {
  const calls = [];
  const tracker = createEventTracker({ google: (...args) => calls.push(args) });
  assert.equal(tracker.track('unknown_event'), false);
  tracker.track(EVENTS.CHALLENGE_CREATED, { email: 'private@example.com', uid: 'secret', hiderName: 'Private', code: 'SECRET', clues: ['Secret'], mode: 'multiplayer', time_used: NaN, level: Infinity, source: 'x'.repeat(81) });
  assert.deepEqual(calls[0][1], { mode: 'multiplayer', account_status: 'guest' });
  assert.deepEqual(cleanEventParameters({ personal_win: false, wrong_guesses: 0, mode: 'solo' }), { personal_win: false, wrong_guesses: 0, mode: 'solo' });
});

test('deduplication applies per event/key; independent hunts still count', () => {
  let calls = 0;
  const tracker = createEventTracker({ google: () => calls++ });
  assert.equal(tracker.track(EVENTS.HUNT_COMPLETED, {}, 'hunt-a'), true);
  assert.equal(tracker.track(EVENTS.HUNT_COMPLETED, {}, 'hunt-a'), false);
  tracker.track(EVENTS.HUNT_COMPLETED, {}, 'hunt-b');
  tracker.track(EVENTS.RESULT_VIEWED, {}, 'hunt-a');
  assert.equal(calls, 3);
});

test('disabled tracking and failed providers cannot break gameplay', () => {
  const tracker = createEventTracker({ enabled: false, google: () => assert.fail() });
  assert.equal(tracker.track(EVENTS.HUNT_STARTED), false);
  let metaCalls = 0;
  const failing = createEventTracker({ google: () => { throw new Error('blocked'); }, meta: () => metaCalls++ });
  assert.doesNotThrow(() => failing.track(EVENTS.GUESS_SUBMITTED));
  assert.equal(metaCalls, 1);
  const failedMeta = createEventTracker({ meta: () => { throw new Error('blocked'); } });
  assert.doesNotThrow(() => failedMeta.track(EVENTS.HUNT_STARTED));
});

test('solo telemetry uses charged time and preserves legacy duration without the answer', () => {
  const params = soloEventParameters({ puzzle: { id: 'JPN', country: 'Japan', difficulty: 'easy' }, remaining: 65, cluesVisible: 2, wrongGuesses: 1, revealedCountry: false }, 1);
  assert.equal(params.round_seconds, 120); assert.equal(params.time_used, 55);
  assert.equal(params.country, undefined); assert.equal(params.puzzle, undefined);
});
