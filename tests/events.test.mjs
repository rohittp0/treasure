import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, META_PIXEL_ID, createEventTracker, cleanEventParameters, soloEventParameters, posthogUserProperties, isNoiseException, contextProperties } from '../src/events.js';

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

test('Google sign-in failures and the in-app handoff send fixed codes only', () => {
  const calls = [];
  const tracker = createEventTracker({ google: (...args) => calls.push(args) });
  tracker.track(EVENTS.LOGIN_FAILED, { method: 'google', reason: 'popup_closed', message: 'Firebase: Error (auth/popup-closed-by-user).', code: 'auth/popup-closed-by-user' });
  tracker.track(EVENTS.OPEN_IN_BROWSER, { method: 'intent', source: 'sign_in', step: 'tap', in_app: 'instagram', href: 'https://hunch.rohittp.com/?from=inapp' });
  assert.deepEqual(calls[0], ['login_failed', { method: 'google', reason: 'popup_closed', account_status: 'guest' }]);
  assert.deepEqual(calls[1], ['open_in_browser', { method: 'intent', source: 'sign_in', step: 'tap', in_app: 'instagram', account_status: 'guest' }]);
});

test('WhatsApp events keep their funnel parameters but never the number or code', () => {
  const calls = [];
  const tracker = createEventTracker({ google: (...args) => calls.push(args) });
  tracker.track(EVENTS.WHATSAPP_VERIFY_FAILED, { source: 'result_card', purpose: 'verify_phone', step: 'verify', reason: 'wrong_code', phone: '+919020277399', code: '123456' });
  tracker.track(EVENTS.LOGIN, { method: 'whatsapp' });
  assert.deepEqual(calls[0], ['whatsapp_verify_failed', { source: 'result_card', purpose: 'verify_phone', step: 'verify', reason: 'wrong_code', account_status: 'guest' }]);
  assert.deepEqual(calls[1][1], { method: 'whatsapp', account_status: 'guest' });
  for (const name of ['whatsapp_prompt_shown', 'whatsapp_prompt_dismissed', 'whatsapp_code_requested', 'whatsapp_verified', 'whatsapp_opt_in', 'whatsapp_opt_out', 'whatsapp_unsubscribe_viewed', 'sign_in_opened'])
    assert.ok(Object.values(EVENTS).includes(name), name);
});

test('install and handoff events keep to fixed codes', () => {
  const calls = [];
  const tracker = createEventTracker({ google: (...args) => calls.push(args) });
  tracker.track(EVENTS.PAGE_VIEW, { display_mode: 'standalone', url: 'https://hunch.rohittp.com/?fbclid=secret' });
  tracker.track(EVENTS.OPEN_IN_BROWSER, { source: 'landing', step: 'auto', method: 'intent', in_app: 'instagram', outcome: 'stayed', ph_did: 'abc' });
  tracker.track(EVENTS.INSTALL_PROMPT_SHOWN, { source: 'result_card', method: 'ios_steps' });
  tracker.track(EVENTS.INSTALL_STARTED, { source: 'home', method: 'prompt' });
  tracker.track(EVENTS.INSTALL_PROMPT_DISMISSED, { source: 'home', method: 'prompt' });
  tracker.track(EVENTS.APP_INSTALLED, { method: 'prompt' });
  assert.deepEqual(calls.map(call => call[0]), ['page_view', 'open_in_browser', 'install_prompt_shown', 'install_started', 'install_prompt_dismissed', 'app_installed']);
  assert.deepEqual(calls[0][1], { display_mode: 'standalone', account_status: 'guest' });
  assert.deepEqual(calls[1][1], { source: 'landing', step: 'auto', method: 'intent', in_app: 'instagram', outcome: 'stayed', account_status: 'guest' });
});

test('PostHog context names the display mode and the in-app browser', () => {
  const instagram = 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36 Instagram 352.0 Android';
  assert.deepEqual(contextProperties(instagram, 'browser'), { display_mode: 'browser', in_app: 'instagram' });
  assert.deepEqual(contextProperties('Mozilla/5.0 (Linux; Android 10; K) Chrome/130.0 Mobile Safari/537.36', 'standalone'), { display_mode: 'standalone' });
});

test("errors from an in-app browser's own scripts are dropped, real ones are kept", () => {
  assert.equal(isNoiseException({ $exception_list: [{ type: 'Error', value: 'Error invoking postMessage: Java object is gone' }] }), true);
  assert.equal(isNoiseException({ $exception_values: ['Script error.'] }), true);
  assert.equal(isNoiseException({ $exception_list: [{ type: 'TypeError', value: "Cannot read properties of undefined (reading 'getLayer')" }] }), false);
  assert.equal(isNoiseException({ $exception_list: [{ value: 'Script error.' }, { value: 'map failed' }] }), false);
  assert.equal(isNoiseException({}), false);
  assert.equal(isNoiseException(), false);
});

test('every event carries the app version when the tracker is given one', () => {
  const calls = [];
  const tracker = createEventTracker({ version: '0.2.0', google: (...args) => calls.push(args) });
  tracker.track(EVENTS.HUNT_STARTED, { mode: 'daily', app_version: 'spoofed' });
  assert.deepEqual(calls[0][1], { mode: 'daily', account_status: 'guest', app_version: '0.2.0' });
  const plain = [];
  createEventTracker({ google: (...args) => plain.push(args) }).track(EVENTS.HUNT_STARTED);
  assert.equal('app_version' in plain[0][1], false);
});
