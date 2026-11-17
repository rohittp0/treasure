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
const claim = (uid, username, name = 'Scout Person') =>
  functions.claimUsername.run({ auth: { uid, token: { name } }, data: { username } });

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
  await functions.claimUsername.run({ auth: { uid: 'u4', token: {} }, data: { username: 'quiet' } });
  assert.equal((await data('usernames/quiet')).displayName, 'Explorer');
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

  // Safe to run again.
  await moderation.banExplorerData(db, auth, 'u1', { reason: 'Abusive clues', bannedBy: 'admin1' });
  assert.equal((await data('bans/u1')).reason, 'Abusive clues');
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
  const fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), method: options.method });
    return { ok: status === 200, status, text: async () => 'telegram says no' };
  };
  return { calls, fetch };
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

test('a failed Telegram call throws without leaking the bot token', async () => {
  await reset();
  const telegram = mockFetch(401);
  const alert = moderation.createReportAlert({ db, fetch: telegram.fetch, token: '123:SECRET', chatId: 'c', projectId: 'p' });
  await db.doc('reports/fail').set(report());
  const error = await alert('fail', report()).then(() => null, failure => failure);
  assert.ok(error, 'expected a failure');
  assert.match(error.message, /401/);
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
