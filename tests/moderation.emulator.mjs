// Moderation functions against the Firestore emulator: claimUsername, banExplorer, the Telegram report alert,
// and the block and daily-quest checks in the push functions. Firebase Messaging, Admin Auth and Telegram are mocked.
// Run with: npm run test:functions
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with the Firestore emulator: npm run test:functions');
const projectId = process.env.GCLOUD_PROJECT;

// Messaging is swapped out before functions/index.js loads, so the push triggers run without FCM.
const sent = [];
const messagingPath = require.resolve('firebase-admin/messaging');
require.cache[messagingPath] = {
  id: messagingPath, filename: messagingPath, loaded: true,
  exports: {
    getMessaging: () => ({
      async send(message) { sent.push(message); return 'message-id'; },
      async sendEach(messages) {
        sent.push(...messages);
        return { successCount: messages.length, failureCount: 0, responses: messages.map(() => ({ success: true })) };
      },
    }),
  },
};
const functions = require('./index.js');
const moderation = require('./moderation.js');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const db = getFirestore();

async function reset() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  sent.length = 0;
}

async function rejectsWith(promise, code) {
  try { await promise; } catch (error) { assert.equal(error.code, code, error.message); return error; }
  assert.fail(`Expected ${code}`);
}

const exists = async path => (await db.doc(path).get()).exists;
const data = async path => (await db.doc(path).get()).data();
// Claims need the Terms of Use accepted (users/{uid}.termsAcceptedAt); terms: false leaves them unaccepted.
async function claim(uid, username, name = 'Scout Person', { terms = true } = {}) {
  if (terms) await db.doc(`users/${uid}`).set({ termsAcceptedAt: new Date() }, { merge: true });
  return functions.claimUsername.run({ auth: { uid, token: { name } }, data: { username } });
}

// ---- claimUsername

test('claimUsername writes the profile and username together, like the client batch', async () => {
  await reset();
  assert.deepEqual(await claim('u1', ' Scout '), { username: 'scout' });
  assert.equal((await data('profiles/u1')).username, 'scout');
  const name = await data('usernames/scout');
  assert.equal(name.uid, 'u1');
  assert.equal(name.displayName, 'Scout Person');
  assert.ok(name.createdAt instanceof Timestamp);
  // Asking again for the same name is a no-op, so a retried request succeeds.
  assert.deepEqual(await claim('u1', 'scout'), { username: 'scout' });
  await rejectsWith(claim('u1', 'another'), 'failed-precondition');
  await rejectsWith(claim('u2', 'scout'), 'already-exists');
  for (const invalid of ['ab', '1scout', 'scout!', 'x'.repeat(21), 42, null]) await rejectsWith(claim('u3', invalid), 'invalid-argument');
  await rejectsWith(functions.claimUsername.run({ data: { username: 'nobody' } }), 'unauthenticated');
  assert.equal(await exists('profiles/u3'), false);
  // WhatsApp accounts have no display name.
  await db.doc('users/u4').set({ termsAcceptedAt: new Date() });
  await functions.claimUsername.run({ auth: { uid: 'u4', token: {} }, data: { username: 'quiet' } });
  assert.equal((await data('usernames/quiet')).displayName, 'Explorer');
});

test('claimUsername needs the Terms of Use accepted first', async () => {
  await reset();
  const error = await rejectsWith(claim('t1', 'newcomer', 'New', { terms: false }), 'failed-precondition');
  assert.equal(error.details?.reason, 'terms');
  assert.equal(await exists('usernames/newcomer'), false);
  await db.doc('users/t1').set({ displayName: 'New' });
  await rejectsWith(claim('t1', 'newcomer', 'New', { terms: false }), 'failed-precondition');
  assert.deepEqual(await claim('t1', 'newcomer'), { username: 'newcomer' });
});

test('two explorers claiming one name at once: exactly one gets it', async () => {
  await reset();
  const results = await Promise.allSettled([claim('a1', 'contested'), claim('a2', 'contested')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'already-exists');
  const owner = (await data('usernames/contested')).uid;
  assert.equal((await data(`profiles/${owner}`)).username, 'contested');
  assert.equal(await exists(`profiles/${owner === 'a1' ? 'a2' : 'a1'}`), false);
});

test('blocklisted names are refused, and exact ones are listed for the rules', async () => {
  await reset();
  const list = moderation.loadBlocklist();
  assert.equal(moderation.blockedReason('admin', list), 'exact');
  assert.equal(moderation.blockedReason('badminton', list), null);
  assert.equal(moderation.blockedReason('the_treasure_hunch', list), 'contains');
  assert.equal(moderation.blockedReason('tr3asur3hunch1', list), 'contains');
  assert.equal(moderation.blockedReason('mapfinder', list), null);

  const exact = await rejectsWith(claim('b1', 'admin'), 'invalid-argument');
  assert.match(exact.message, /isn't allowed/);
  await rejectsWith(claim('b1', 'real_treasurehunch'), 'invalid-argument');
  assert.equal(await exists('profiles/b1'), false);
  // The server keeps blockedUsernames/{name} in step with the exact entries, so old clients' batches fail too.
  assert.equal((await data('blockedUsernames/admin')).source, 'blocklist');
  // A contained match is listed as tried, so the old client path can't take that exact name either.
  assert.equal((await data('blockedUsernames/real_treasurehunch')).source, 'claim');
  assert.deepEqual(await claim('b1', 'mapfinder'), { username: 'mapfinder' });
});

test('a banned explorer cannot claim a username', async () => {
  await reset();
  await db.doc('bans/c1').set({ bannedAt: new Date() });
  await rejectsWith(claim('c1', 'freshstart'), 'permission-denied');
  assert.equal(await exists('usernames/freshstart'), false);
});

// ---- banExplorer

function mockAuth() {
  const calls = [];
  return {
    calls,
    async updateUser(uid, properties) { calls.push(['updateUser', uid, properties]); return { uid }; },
    async revokeRefreshTokens(uid) { calls.push(['revokeRefreshTokens', uid]); },
  };
}

const huntDoc = overrides => ({
  hiderUid: 'u2', hiderName: 'Hider Two', hiderUsername: 'two', targetUid: null, targetUsername: null,
  seekerUid: null, seekerName: null, clues: ['First clue', 'Second clue', 'Third clue'], status: 'waiting',
  roundSeconds: 180, createdAt: new Date(), startedAt: null, endedAt: null, cluesVisible: 1, costSeconds: 0,
  wrongGuesses: 0, triedIds: [], lastGuessId: '', lastGuessOutcome: '', revealed: false, ...overrides,
});

async function seedBanned() {
  const writes = {
    'users/u1': { displayName: 'Scout', whatsapp: { phone: '+919020277399', verifiedAt: new Date(), optIn: true } },
    'users/u1/pushTokens/aaa': { token: 't'.repeat(30), createdAt: new Date() },
    'users/u1/daily/2026-11-17': { status: 'won' },
    'profiles/u1': { username: 'scout', createdAt: new Date() },
    'usernames/scout': { uid: 'u1', displayName: 'Scout', createdAt: new Date() },
    'atlases/scout': { uid: 'u1', name: 'scout', countries: { ITA: '2026-11-17' }, count: 1, updatedAt: new Date() },
    'leaderboard/u1': { uid: 'u1', name: 'scout' },
    'monthlyLeaderboard/2026-11/entries/u1': { uid: 'u1', name: 'scout' },
    'monthlyLeaderboard/2026-10/entries/u1': { uid: 'u1', name: 'scout' },
    'monthlyLeaderboard/2026-11/entries/u2': { uid: 'u2', name: 'two' },
    'whatsappPhones/+919020277399': { uid: 'u1' },
    // A: u1 hid, u2 found it.
    'friendHunts/AAAAAAAAAA': huntDoc({ hiderUid: 'u1', hiderName: 'Scout', hiderUsername: 'scout', seekerUid: 'u2', seekerName: 'Hider Two', status: 'won' }),
    // B: u2 hid, u1 is seeking.
    'friendHunts/BBBBBBBBBB': huntDoc({ seekerUid: 'u1', seekerName: 'Scout', status: 'playing', startedAt: new Date() }),
    // C: u1 hid, nobody joined.
    'friendHunts/CCCCCCCCCC': huntDoc({ hiderUid: 'u1', hiderName: 'Scout', hiderUsername: 'scout' }),
    'friendHunts/CCCCCCCCCC/private/answer': { id: 'ITA', country: 'Italy', lng: 12, lat: 42 },
    // D: u1 challenged u2, still waiting, with u2's inbox entry.
    'friendHunts/DDDDDDDDDD': huntDoc({ hiderUid: 'u1', hiderName: 'Scout', hiderUsername: 'scout', targetUid: 'u2', targetUsername: 'two' }),
    'users/u2/notifications/DDDDDDDDDD': { code: 'DDDDDDDDDD', fromUid: 'u1', fromUsername: 'scout', read: false },
    // E: u2 challenged u1, still waiting.
    'friendHunts/EEEEEEEEEE': huntDoc({ targetUid: 'u1', targetUsername: 'scout' }),
    'users/u2/notifications/FFFFFFFFFF': { code: 'FFFFFFFFFF', fromUid: 'u3', fromUsername: 'three', read: false },
  };
  for (const [path, value] of Object.entries(writes)) await db.doc(path).set(value);
}

test('banExplorer is for admins only', async () => {
  await reset();
  await rejectsWith(functions.banExplorer.run({ data: { uid: 'u1' } }), 'unauthenticated');
  await rejectsWith(functions.banExplorer.run({ auth: { uid: 'x', token: {} }, data: { uid: 'u1' } }), 'permission-denied');
  await rejectsWith(functions.banExplorer.run({ auth: { uid: 'x', token: { admin: 'yes' } }, data: { uid: 'u1' } }), 'permission-denied');
  await rejectsWith(functions.banExplorer.run({ auth: { uid: 'x', token: { admin: true } }, data: { uid: '' } }), 'invalid-argument');
  await rejectsWith(functions.banExplorer.run({ auth: { uid: 'x', token: { admin: true } }, data: { uid: 'x' } }), 'invalid-argument');
  assert.equal(await exists('bans/u1'), false);
});

test('banExplorerData disables the account, removes public entries and anonymises friend hunts', async () => {
  await reset();
  await seedBanned();
  const auth = mockAuth();
  await moderation.banExplorerData(db, auth, 'u1', { reason: 'Abusive clues', bannedBy: 'admin1' });

  const ban = await data('bans/u1');
  assert.equal(ban.reason, 'Abusive clues');
  assert.equal(ban.bannedBy, 'admin1');
  assert.equal(ban.username, 'scout');
  assert.ok(ban.bannedAt instanceof Timestamp);
  assert.deepEqual(auth.calls, [['updateUser', 'u1', { disabled: true }], ['revokeRefreshTokens', 'u1']]);

  for (const path of ['leaderboard/u1', 'monthlyLeaderboard/2026-11/entries/u1', 'monthlyLeaderboard/2026-10/entries/u1',
    'atlases/scout', 'usernames/scout', 'profiles/u1', 'users/u1/pushTokens/aaa',
    'friendHunts/CCCCCCCCCC', 'friendHunts/CCCCCCCCCC/private/answer', 'friendHunts/DDDDDDDDDD', 'users/u2/notifications/DDDDDDDDDD',
    'friendHunts/EEEEEEEEEE']) assert.equal(await exists(path), false, `${path} should be gone`);
  // The name stays reserved, and the number stays linked so it can't sign up again.
  assert.equal((await data('blockedUsernames/scout')).source, 'ban');
  assert.equal((await data('whatsappPhones/+919020277399')).uid, 'u1');
  assert.equal((await data('users/u1')).whatsapp.optIn, false);
  assert.equal(await exists('users/u1/daily/2026-11-17'), true);
  // Other explorers' data is untouched.
  assert.equal(await exists('monthlyLeaderboard/2026-11/entries/u2'), true);
  assert.equal(await exists('users/u2/notifications/FFFFFFFFFF'), true);

  const huntA = await data('friendHunts/AAAAAAAAAA');
  assert.equal(huntA.hiderName, 'Former explorer');
  assert.equal(huntA.hiderUsername, null);
  assert.deepEqual(huntA.clues, Array(3).fill(moderation.REMOVED_CLUE));
  assert.equal(huntA.seekerName, 'Hider Two');
  assert.equal(huntA.status, 'won');
  const huntB = await data('friendHunts/BBBBBBBBBB');
  assert.equal(huntB.seekerName, 'Former explorer');
  assert.equal(huntB.hiderName, 'Hider Two');
  assert.deepEqual(huntB.clues, ['First clue', 'Second clue', 'Third clue']);

  // Safe to run again, and a re-run without a reason or admin keeps the stored ones.
  await moderation.banExplorerData(db, auth, 'u1', {});
  assert.equal((await data('bans/u1')).reason, 'Abusive clues');
  assert.equal((await data('bans/u1')).bannedBy, 'admin1');
});

test('banExplorerData tolerates an explorer with no profile or Auth user', async () => {
  await reset();
  const auth = {
    async updateUser() { throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' }); },
    async revokeRefreshTokens() { throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' }); },
  };
  await moderation.banExplorerData(db, auth, 'ghost', {});
  assert.equal(await exists('bans/ghost'), true);
});

// ---- Report alerts

function mockFetch(status = 200) {
  const calls = [];
  const mock = { calls, status };
  mock.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), method: options.method, signal: options.signal });
    if (mock.status === 'network') throw new TypeError('fetch failed');
    return { ok: mock.status === 200, status: mock.status, text: async () => 'telegram says no' };
  };
  return mock;
}

const report = (overrides = {}) => ({
  reporterUid: 'r1', targetUid: 'u1', kind: 'clue', code: 'ABCDEFGHJK', reason: 'Offensive clue *text* <b>', createdAt: new Date(), ...overrides,
});

test('a new report alerts the developer on Telegram with console links', async () => {
  await reset();
  await db.doc('profiles/u1').set({ username: 'scout' });
  await db.doc('profiles/r1').set({ username: 'reporter' });
  const telegram = mockFetch();
  const alert = moderation.createReportAlert({ db, fetch: telegram.fetch, token: '123:SECRET', chatId: '-42', projectId: 'treasurehunch' });
  await db.doc('reports/rep1').set(report());
  await alert('rep1', report());

  assert.equal(telegram.calls.length, 1);
  const [call] = telegram.calls;
  assert.equal(call.url, 'https://api.telegram.org/bot123:SECRET/sendMessage');
  assert.equal(call.method, 'POST');
  assert.ok(call.signal instanceof AbortSignal, 'the Telegram call has a timeout');
  assert.equal(call.body.chat_id, '-42');
  assert.equal('parse_mode' in call.body, false);
  const text = call.body.text;
  for (const part of ['clue', 'Offensive clue *text* <b>', '@scout', 'u1', '@reporter', 'ABCDEFGHJK',
    'https://console.firebase.google.com/project/treasurehunch/firestore/databases/-default-/data/~2FfriendHunts~2FABCDEFGHJK',
    'https://console.firebase.google.com/project/treasurehunch/firestore/databases/-default-/data/~2Freports~2Frep1',
    'https://console.firebase.google.com/project/treasurehunch/firestore/databases/-default-/data/~2Fatlases~2Fscout',
    '24 hours']) assert.ok(text.includes(part), `alert should include ${part}:\n${text}`);
  assert.equal((await data('reports/rep1')).alert, 'sent');
});

test('report alerts are limited per reporter, and skipped without the Telegram secrets', async () => {
  await reset();
  const telegram = mockFetch();
  const alert = moderation.createReportAlert({ db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'p' });
  for (let index = 0; index < moderation.ALERTS_PER_REPORTER_PER_HOUR + 2; index++) {
    await db.doc(`reports/spam${index}`).set(report({ targetUid: `t${index}` }));
    await alert(`spam${index}`, report({ targetUid: `t${index}` }));
  }
  assert.equal(telegram.calls.length, moderation.ALERTS_PER_REPORTER_PER_HOUR);
  assert.equal((await data(`reports/spam${moderation.ALERTS_PER_REPORTER_PER_HOUR}`)).alert, 'limited');

  const quiet = mockFetch();
  const unconfigured = moderation.createReportAlert({ db, fetch: quiet.fetch, token: '', chatId: '', projectId: 'p' });
  await db.doc('reports/quiet').set(report({ reporterUid: 'r2' }));
  await unconfigured('quiet', report({ reporterUid: 'r2' }));
  assert.equal(quiet.calls.length, 0);
  assert.equal((await data('reports/quiet')).alert, 'unconfigured');
});

test('a transient Telegram failure throws without leaking the bot token', async () => {
  await reset();
  const telegram = mockFetch(503);
  const alert = moderation.createReportAlert({ db, fetch: telegram.fetch, token: '123:SECRET', chatId: 'c', projectId: 'p' });
  await db.doc('reports/fail').set(report());
  const error = await alert('fail', report()).then(() => null, failure => failure);
  assert.ok(error, 'expected a failure');
  assert.match(error.message, /503/);
  assert.equal(error.message.includes('SECRET'), false);
});

// ---- Push checks in functions/index.js

async function seedChallenge(code, senderUid) {
  await db.doc(`friendHunts/${code}`).set(huntDoc({ hiderUid: senderUid, hiderUsername: 'sender', targetUid: 'rcpt', targetUsername: 'rcpt' }));
  await db.doc('users/rcpt/pushTokens/aaa').set({ token: 'r'.repeat(30), createdAt: new Date() });
  const notification = { code, fromUid: senderUid, fromUsername: 'sender', createdAt: new Date(), read: false };
  await db.doc(`users/rcpt/notifications/${code}`).set(notification);
  return { params: { recipientUid: 'rcpt', code }, data: { data: () => notification } };
}

test('a challenge push is skipped when the recipient blocked the sender', async () => {
  await reset();
  assert.equal(await moderation.isBlocked(db, 'rcpt', 'blocked1'), false);
  await db.doc('users/rcpt/blocks/blocked1').set({ createdAt: new Date() });
  assert.equal(await moderation.isBlocked(db, 'rcpt', 'blocked1'), true);
  await functions.notifyFriendChallenge.run(await seedChallenge('GGGGGGGGGG', 'blocked1'));
  assert.equal(sent.length, 0);
  await functions.notifyFriendChallenge.run(await seedChallenge('HHHHHHHHHH', 'friend1'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, 'r'.repeat(30));
});

test('the daily quest push skips devices with dailyQuest: false', async () => {
  await reset();
  await db.doc('users/d1/pushTokens/off').set({ token: 'o'.repeat(30), createdAt: new Date(), dailyQuest: false });
  await db.doc('users/d1/pushTokens/on').set({ token: 'n'.repeat(30), createdAt: new Date(), dailyQuest: true });
  await db.doc('users/d2/pushTokens/old').set({ token: 'l'.repeat(30), createdAt: new Date() });
  await functions.notifyDailyQuest.run({});
  assert.deepEqual(sent.map(message => message.token).sort(), ['l'.repeat(30), 'n'.repeat(30)]);
});

test('a retried report alert is sent once and counted once', async () => {
  await reset();
  const telegram = mockFetch(500);
  const alert = moderation.createReportAlert({ db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'p' });
  await db.doc('reports/retry').set(report());
  await assert.rejects(alert('retry', report()));
  assert.equal((await data('reports/retry')).alert, 'failed');
  telegram.status = 200;
  await alert('retry', report());
  assert.equal((await data('reports/retry')).alert, 'sent');
  assert.equal((await data('moderationLimits/r1')).count, 1);
  // A redelivered event for a sent report does nothing.
  await alert('retry', report());
  assert.equal(telegram.calls.length, 2);
});

test('the same report twice within a day is alerted once', async () => {
  await reset();
  const telegram = mockFetch();
  const alert = moderation.createReportAlert({ db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'p' });
  for (const id of ['first', 'again']) {
    await db.doc(`reports/${id}`).set(report());
    await alert(id, report());
  }
  assert.equal(telegram.calls.length, 1);
  assert.equal((await data('reports/again')).alert, 'duplicate');
  // A different hunt from the same explorer is a different report.
  await db.doc('reports/other').set(report({ code: 'BCDEFGHJKL' }));
  await alert('other', report({ code: 'BCDEFGHJKL' }));
  assert.equal(telegram.calls.length, 2);
});

test("a block's report is alerted even past the reporter's hourly limit", async () => {
  await reset();
  const telegram = mockFetch();
  const alert = moderation.createReportAlert({ db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'p' });
  for (let index = 0; index < moderation.ALERTS_PER_REPORTER_PER_HOUR; index++) {
    await db.doc(`reports/fill${index}`).set(report({ targetUid: `f${index}` }));
    await alert(`fill${index}`, report({ targetUid: `f${index}` }));
  }
  const blockReport = report({ targetUid: 'blocked', kind: 'profile', code: undefined, reason: moderation.BLOCK_REASON });
  delete blockReport.code;
  // Without the block in place, the block reason earns nothing.
  await db.doc('reports/fake').set(blockReport);
  await alert('fake', blockReport);
  assert.equal((await data('reports/fake')).alert, 'limited');
  await db.doc('users/r1/blocks/blocked').set({ createdAt: new Date() });
  await db.doc('reports/block').set(blockReport);
  await alert('block', blockReport);
  assert.equal((await data('reports/block')).alert, 'sent');
  assert.equal(telegram.calls.length, moderation.ALERTS_PER_REPORTER_PER_HOUR + 1);
});

test('the digest sends every report of the last 7 days that was not alerted', async () => {
  await reset();
  const now = new Date('2026-11-18T06:00:00Z');
  const hoursAgo = hours => new Date(now.getTime() - hours * 3_600_000);
  const seeds = {
    limited: { alert: 'limited', createdAt: hoursAgo(2) },
    failed: { alert: 'failed', createdAt: hoursAgo(20) },
    unprocessed: { createdAt: hoursAgo(30) },
    sent: { alert: 'sent', createdAt: hoursAgo(3) },
    duplicate: { alert: 'duplicate', createdAt: hoursAgo(3) },
    old: { alert: 'limited', createdAt: hoursAgo(8 * 24) },
    lastWeek: { alert: 'failed', createdAt: hoursAgo(6 * 24) },
  };
  for (const [id, fields] of Object.entries(seeds)) await db.doc(`reports/${id}`).set({ ...report({ targetUid: `t-${id}` }), ...fields });

  const errors = [];
  const quiet = mockFetch();
  const unconfigured = await moderation.sendReportDigest({ db, fetch: quiet.fetch, token: '', chatId: '', projectId: 'p', clock: () => now, log: { error: message => errors.push(message) } });
  assert.deepEqual(unconfigured, { pending: 4, sent: false });
  assert.equal(quiet.calls.length, 0);
  assert.match(errors[0], /4 reports/);

  const telegram = mockFetch();
  const result = await moderation.sendReportDigest({ db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'treasurehunch', clock: () => now });
  assert.deepEqual(result, { pending: 4, sent: true, listed: 4 });
  assert.equal(telegram.calls.length, 1);
  const text = telegram.calls[0].body.text;
  for (const id of ['limited', 'failed', 'unprocessed', 'lastWeek']) assert.ok(text.includes(`t-${id}`), `digest lists ${id}`);
  // Oldest first.
  assert.ok(text.indexOf('t-lastWeek') < text.indexOf('t-unprocessed') && text.indexOf('t-unprocessed') < text.indexOf('t-limited'));
  for (const id of ['sent', 'duplicate', 'old']) assert.equal(text.includes(`t-${id}`), false, `digest skips ${id}`);
  assert.ok(telegram.calls[0].signal instanceof AbortSignal);
  for (const id of ['limited', 'failed', 'unprocessed', 'lastWeek']) assert.equal((await data(`reports/${id}`)).alert, 'digested');
  // Nothing is left for the next run.
  await moderation.sendReportDigest({ db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'p', clock: () => now });
  assert.equal(telegram.calls.length, 1);
});

test('a rejected Telegram call is recorded, not retried; network errors and 429 or 5xx are retried', async () => {
  await reset();
  const telegram = mockFetch(401);
  const alert = moderation.createReportAlert({ db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'p' });
  await db.doc('reports/bad').set(report());
  await alert('bad', report());
  const stored = await data('reports/bad');
  assert.equal(stored.alert, 'failed');
  assert.equal(stored.alertStatus, 401);
  for (const [id, status] of [['busy', 429], ['down', 500], ['offline', 'network']]) {
    telegram.status = status;
    await db.doc(`reports/${id}`).set(report({ targetUid: id }));
    await assert.rejects(alert(id, report({ targetUid: id })), `${status} should be retried`);
    assert.equal((await data(`reports/${id}`)).alert, 'failed');
  }
});

test('a block lifts the hourly limit for one alert per explorer a day', async () => {
  await reset();
  const telegram = mockFetch();
  const alert = moderation.createReportAlert({ db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'p' });
  for (let index = 0; index < moderation.ALERTS_PER_REPORTER_PER_HOUR; index++) {
    await db.doc(`reports/fill${index}`).set(report({ targetUid: `f${index}` }));
    await alert(`fill${index}`, report({ targetUid: `f${index}` }));
  }
  await db.doc('users/r1/blocks/blocked').set({ createdAt: new Date() });
  const first = report({ targetUid: 'blocked', kind: 'profile', reason: moderation.BLOCK_REASON });
  delete first.code;
  await db.doc('reports/block1').set(first);
  await alert('block1', first);
  assert.equal((await data('reports/block1')).alert, 'sent');
  // Another block report on the same explorer (other kind and hunt) the same day is counted as usual.
  const second = report({ targetUid: 'blocked', kind: 'clue', code: 'CDEFGHJKLM', reason: moderation.BLOCK_REASON });
  await db.doc('reports/block2').set(second);
  await alert('block2', second);
  assert.equal((await data('reports/block2')).alert, 'limited');
});

test('a long digest stays within one Telegram message and keeps the rest for the next run', async () => {
  await reset();
  const now = new Date('2026-11-18T06:00:00Z');
  for (let index = 0; index < 30; index++) {
    await db.doc(`reports/long${String(index).padStart(2, '0')}`).set({
      ...report({ targetUid: `target-${String(index).padStart(2, '0')}`, reason: `${index} `.padEnd(200, 'x') }),
      alert: 'limited', createdAt: new Date(now.getTime() - (40 - index) * 3_600_000),
    });
  }
  const telegram = mockFetch();
  const first = await moderation.sendReportDigest({ db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'treasurehunch', clock: () => now });
  const text = telegram.calls[0].body.text;
  assert.ok(text.length <= 4000, `digest is ${text.length} characters`);
  assert.equal(first.pending, 30);
  assert.ok(first.listed > 0 && first.listed < 30);
  assert.ok(text.includes(`…and ${30 - first.listed} more`));
  assert.ok(text.includes('target-00') && !text.includes(`target-${String(first.listed).padStart(2, '0')}`), 'oldest first');
  const states = await Promise.all(Array.from({ length: 30 }, (_, index) => data(`reports/long${String(index).padStart(2, '0')}`)));
  assert.equal(states.filter(state => state.alert === 'digested').length, first.listed);
  const second = await moderation.sendReportDigest({ db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'treasurehunch', clock: () => now });
  assert.equal(second.pending, 30 - first.listed);
});

test('a rejected digest is logged, not retried; a 5xx digest is retried', async () => {
  await reset();
  const now = new Date('2026-11-18T06:00:00Z');
  await db.doc('reports/one').set({ ...report(), alert: 'limited', createdAt: new Date(now.getTime() - 3_600_000) });
  const errors = [];
  const telegram = mockFetch(400);
  const options = { db, fetch: telegram.fetch, token: 't', chatId: 'c', projectId: 'p', clock: () => now, log: { error: message => errors.push(message) } };
  assert.deepEqual(await moderation.sendReportDigest(options), { pending: 1, sent: false, status: 400 });
  assert.match(errors[0], /400/);
  assert.equal((await data('reports/one')).alert, 'limited');
  telegram.status = 502;
  await assert.rejects(moderation.sendReportDigest(options));
});
