import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { pushMessage } = require('./push.js');

const DAILY = 'https://hunch.rohittp.com/?daily=1&utm_source=push';
const HUNT = 'https://hunch.rohittp.com/?hunt=ABCDEFGHJK';

test('a daily quest push carries its link for native apps and the web', () => {
  const m = pushMessage({ token: 't', platform: 'android', title: 'A new TreasureHunch quest', body: 'b', link: DAILY, tag: 'daily-2026-11-18' });
  assert.deepEqual(m.data, { link: DAILY });
  assert.equal(m.android.notification.tag, 'daily-2026-11-18');
  assert.equal(m.android.notification.channelId, 'daily_quest');
  assert.equal(m.apns.payload.aps['thread-id'], 'daily-2026-11-18');
  assert.equal(m.webpush.fcmOptions.link, m.data.link);
  assert.deepEqual(m.notification, { title: 'A new TreasureHunch quest', body: 'b' });
  assert.equal(m.webpush.notification.tag, 'daily-2026-11-18');
});

test('a missing platform is a web token and a hunt link uses the friend channel', () => {
  assert.equal(pushMessage({ token: 't', platform: undefined, title: 'x', body: 'y', link: HUNT }).webpush.fcmOptions.link, HUNT);
  assert.equal(pushMessage({ token: 't', platform: 'ios', title: 'x', body: 'y', link: HUNT }).android.notification.channelId, 'friend_challenge');
  assert.equal(pushMessage({ token: 't', title: 'x', body: 'y', link: HUNT }).token, 't');
});

test('a push without a tag leaves tag fields out', () => {
  const m = pushMessage({ token: 't', platform: 'web', title: 'x', body: 'y', link: HUNT });
  assert.equal('tag' in m.android.notification, false);
  assert.equal('thread-id' in m.apns.payload.aps, false);
  assert.equal(m.webpush.notification, undefined);
});
