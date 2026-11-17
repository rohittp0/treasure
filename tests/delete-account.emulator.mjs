// Account deletion against the Firestore emulator, with Firebase Auth mocked.
// Run with: npm run test:functions
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { deleteAccountData, FORMER_EXPLORER } = require('./account.js');
const { challengeId, rateLimitRef, sha256 } = require('./whatsapp/otp.js');

const projectId = 'demo-treasure-friend-tests';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with the Firestore emulator: npm run test:functions');
initializeApp({ projectId });
const db = getFirestore();

const PHONE = '+919020277399';
const HUNT_A = 'DELAAAAAAA'; // u1 hid it for u2, u2 won.
const HUNT_B = 'DELBBBBBBB'; // u2 hid it, u1 is playing.
const HUNT_C = 'DELCCCCCCC'; // u1 hid it, open to anyone, nobody joined yet.
const HUNT_D = 'DELDDDDDDD'; // u1 hid it for u2, u2 has not joined yet.
const HUNT_E = 'DELEEEEEEE'; // u2 hid it for u1, u1 lost.
const HUNT_F = 'DELFFFFFFF'; // u2 hid it for u1, u1 has not joined yet.
const today = '2026-11-17';
const clock = () => new Date('2026-11-17T09:30:00Z');

// Starts from an empty emulator database, whatever ran before.
test.before(() => fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' }));

// The part of the Admin Auth API deletion uses. It records whether Firestore was already cleared when it ran.
function mockAuth(db) {
  return {
    users: new Set(['u1', 'u2', 'u3']),
    calls: [],
    async deleteUser(uid) {
      this.calls.push({ uid, userDocExists: (await db.doc(`users/${uid}`).get()).exists });
      if (!this.users.has(uid)) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
      this.users.delete(uid);
    },
  };
}

function hunt(fields) {
  return {
    hiderUid: 'u2', hiderName: 'Friend', hiderUsername: 'friend', targetUid: null, targetUsername: null,
    seekerUid: null, seekerName: null, clues: ['First clue', 'Second clue', 'Third clue'], status: 'waiting',
    createdAt: new Date(), startedAt: null, endedAt: null, cluesVisible: 1, costSeconds: 0, wrongGuesses: 0,
    triedIds: [], lastGuessId: '', lastGuessOutcome: '', revealed: false,
    ...fields,
  };
}

const answer = { id: 'FRA', country: 'France', lng: 2.2, lat: 46.2 };
const exists = async path => (await db.doc(path).get()).exists;
const data = async path => (await db.doc(path).get()).data();

async function seed() {
  const batch = db.batch();
  const set = (path, value) => batch.set(db.doc(path), value);
  // The explorer being deleted.
  set('users/u1', { createdAt: new Date(), whatsapp: { phone: PHONE, verifiedAt: new Date(), optIn: true } });
  set('users/u1/pushTokens/' + 'a'.repeat(64), { token: 'token-one-'.repeat(4), createdAt: new Date() });
  set('users/u1/pushTokens/' + 'b'.repeat(64), { token: 'token-two-'.repeat(4), createdAt: new Date(), platform: 'android' });
  set('users/u1/hunts/h1', { level: 1, seconds: 12 });
  set('users/u1/daily/2026-11-16', { day: '2026-11-16', status: 'won' });
  set('users/u1/notifications/' + HUNT_E, { code: HUNT_E, fromUid: 'u2', fromUsername: 'friend', createdAt: new Date(), read: true });
  set('profiles/u1', { username: 'scout', createdAt: new Date() });
  set('usernames/scout', { uid: 'u1', displayName: 'Scout Person', createdAt: new Date() });
  set('atlases/scout', { uid: 'u1', name: 'scout', countries: { FRA: true }, count: 1, updatedAt: new Date() });
  set('leaderboard/u1', { uid: 'u1', name: 'scout', averageTenths: 100, levelsCompleted: 2, highestLevel: 2, updatedAt: new Date() });
  // Month entries are written without a parent month document.
  set('monthlyLeaderboard/2026-11/entries/u1', { uid: 'u1', name: 'scout', month: '2026-11', found: 1 });
  set('monthlyLeaderboard/2026-10', { note: 'a month document that exists' });
  set('monthlyLeaderboard/2026-10/entries/u1', { uid: 'u1', name: 'scout', month: '2026-10', found: 3 });
  set(`whatsappPhones/${PHONE}`, { uid: 'u1', claimedAt: new Date() });
  // Server-only data keyed by the explorer.
  set(`dailyNotifications/${today}/whatsapp/u1`, { uid: 'u1', status: 'sent', sid: 'SMu1' });
  set('dailyNotifications/2026-11-16', { startedAt: new Date() }); // An earlier day, with its document.
  set('dailyNotifications/2026-11-16/whatsapp/u1', { uid: 'u1', status: 'sent', sid: 'SMu1old' });
  set('whatsappMessages/SMu1', { uid: 'u1', marker: `dailyNotifications/${today}/whatsapp/u1` });
  set('whatsappMessages/SMu1old', { uid: 'u1', marker: 'dailyNotifications/2026-11-16/whatsapp/u1' });
  set(`otpChallenges/${challengeId(PHONE, 'verify_phone')}`, { purpose: 'verify_phone', uid: 'u1' });
  set(`otpChallenges/${challengeId(PHONE, 'login')}`, { purpose: 'login', uid: null });
  batch.set(rateLimitRef(db, 'phone', sha256(PHONE), today), { count: 1 });
  batch.set(rateLimitRef(db, 'uid', 'u1', today), { count: 1 });
  set('challengeDeliveryLimits/push/recipients/u1/senders/u2', { code: HUNT_E, lastAt: new Date() });
  set('challengeDeliveryLimits/email/recipients/u1/senders/u2', { code: HUNT_E, lastAt: new Date() });

  // Friend hunts.
  set(`friendHunts/${HUNT_A}`, hunt({
    hiderUid: 'u1', hiderName: 'Scout Person', hiderUsername: 'scout', targetUid: 'u2', targetUsername: 'friend',
    seekerUid: 'u2', seekerName: 'Friend', status: 'won', startedAt: new Date(), endedAt: new Date(),
  }));
  set(`friendHunts/${HUNT_A}/private/answer`, answer);
  set(`users/u2/notifications/${HUNT_A}`, { code: HUNT_A, fromUid: 'u1', fromUsername: 'scout', createdAt: new Date(), read: true });
  set(`friendHunts/${HUNT_B}`, hunt({ seekerUid: 'u1', seekerName: 'Scout Person', status: 'playing', startedAt: new Date() }));
  set(`friendHunts/${HUNT_B}/private/answer`, answer);
  set(`friendHunts/${HUNT_C}`, hunt({ hiderUid: 'u1', hiderName: 'Scout Person', hiderUsername: 'scout' }));
  set(`friendHunts/${HUNT_C}/private/answer`, answer);
  set(`friendHunts/${HUNT_D}`, hunt({
    hiderUid: 'u1', hiderName: 'Scout Person', hiderUsername: 'scout', targetUid: 'u2', targetUsername: 'friend',
  }));
  set(`friendHunts/${HUNT_D}/private/answer`, answer);
  set(`users/u2/notifications/${HUNT_D}`, { code: HUNT_D, fromUid: 'u1', fromUsername: 'scout', createdAt: new Date(), read: false });
  set(`friendHunts/${HUNT_E}`, hunt({
    targetUid: 'u1', targetUsername: 'scout', seekerUid: 'u1', seekerName: 'Scout Person', status: 'lost',
    startedAt: new Date(), endedAt: new Date(),
  }));
  set(`friendHunts/${HUNT_F}`, hunt({ targetUid: 'u1', targetUsername: 'scout' }));
  set(`friendHunts/${HUNT_F}/private/answer`, answer);
  set('users/u1/notifications/' + HUNT_F, { code: HUNT_F, fromUid: 'u2', fromUsername: 'friend', createdAt: new Date(), read: false });

  // Another explorer, who must keep everything.
  set('users/u2', { createdAt: new Date(), whatsapp: { phone: '+14155552671', verifiedAt: new Date(), optIn: true } });
  set('users/u2/pushTokens/' + 'c'.repeat(64), { token: 'token-three-'.repeat(4), createdAt: new Date() });
  set('profiles/u2', { username: 'friend', createdAt: new Date() });
  set('usernames/friend', { uid: 'u2', displayName: 'Friend', createdAt: new Date() });
  set('leaderboard/u2', { uid: 'u2', name: 'friend' });
  set('monthlyLeaderboard/2026-11/entries/u2', { uid: 'u2', name: 'friend', month: '2026-11', found: 2 });
  set(`dailyNotifications/${today}/whatsapp/u2`, { uid: 'u2', status: 'sent', sid: 'SMu2' });
  set('whatsappMessages/SMu2', { uid: 'u2', marker: `dailyNotifications/${today}/whatsapp/u2` });
  set('challengeDeliveryLimits/push/recipients/u2/senders/u1', { code: HUNT_A, lastAt: new Date() });
  await batch.commit();
}

test('deleteAccountData erases the explorer, anonymises shared hunts and can run again', async () => {
  await seed();
  const auth = mockAuth(db);

  await deleteAccountData(db, auth, 'u1', { clock });

  // The explorer's own documents and subcollections.
  for (const path of [
    'users/u1', 'profiles/u1', 'usernames/scout', 'atlases/scout', 'leaderboard/u1',
    'monthlyLeaderboard/2026-11/entries/u1', 'monthlyLeaderboard/2026-10/entries/u1', `whatsappPhones/${PHONE}`,
    `users/u1/notifications/${HUNT_E}`, 'users/u1/hunts/h1', 'users/u1/daily/2026-11-16',
  ]) assert.equal(await exists(path), false, `${path} should be deleted`);
  for (const sub of ['pushTokens', 'hunts', 'daily', 'notifications'])
    assert.equal((await db.collection(`users/u1/${sub}`).get()).size, 0, `users/u1/${sub} should be empty`);

  // Server-only data keyed by the explorer.
  for (const path of [
    `dailyNotifications/${today}/whatsapp/u1`, 'dailyNotifications/2026-11-16/whatsapp/u1',
    'whatsappMessages/SMu1', 'whatsappMessages/SMu1old',
    `otpChallenges/${challengeId(PHONE, 'verify_phone')}`, `otpChallenges/${challengeId(PHONE, 'login')}`,
    rateLimitRef(db, 'phone', sha256(PHONE), today).path, rateLimitRef(db, 'uid', 'u1', today).path,
    'challengeDeliveryLimits/push/recipients/u1/senders/u2', 'challengeDeliveryLimits/email/recipients/u1/senders/u2',
  ]) assert.equal(await exists(path), false, `${path} should be deleted`);

  // Hunt A: u1 hid it and u2 won. Kept for u2 with the hider anonymised.
  const a = await data(`friendHunts/${HUNT_A}`);
  assert.equal(FORMER_EXPLORER, 'Former explorer');
  assert.equal(a.hiderName, 'Former explorer');
  assert.equal(a.hiderUsername, null);
  assert.equal(a.hiderUid, 'u1');
  assert.deepEqual([a.seekerUid, a.seekerName, a.targetUid, a.targetUsername, a.status], ['u2', 'Friend', 'u2', 'friend', 'won']);
  assert.equal(await exists(`friendHunts/${HUNT_A}/private/answer`), true);
  // The challenge in u2's inbox still names the deleted explorer, so it goes.
  assert.equal(await exists(`users/u2/notifications/${HUNT_A}`), false);

  // Hunt B: u2 hid it and u1 is playing. Kept with the seeker anonymised.
  const b = await data(`friendHunts/${HUNT_B}`);
  assert.equal(b.seekerName, 'Former explorer');
  assert.deepEqual([b.hiderUid, b.hiderName, b.hiderUsername, b.status], ['u2', 'Friend', 'friend', 'playing']);
  assert.equal(await exists(`friendHunts/${HUNT_B}/private/answer`), true);

  // Hunts C and D: u1's waiting hunts nobody joined are deleted with their answers and u2's challenge.
  for (const code of [HUNT_C, HUNT_D]) {
    assert.equal(await exists(`friendHunts/${code}`), false, `${code} should be deleted`);
    assert.equal(await exists(`friendHunts/${code}/private/answer`), false, `${code} answer should be deleted`);
  }
  assert.equal(await exists(`users/u2/notifications/${HUNT_D}`), false);

  // Hunt E: u2 hid it for u1. The seeker and the target username are anonymised.
  const e = await data(`friendHunts/${HUNT_E}`);
  assert.equal(e.seekerName, 'Former explorer');
  assert.equal(e.targetUsername, null);
  assert.deepEqual([e.hiderName, e.hiderUsername, e.status], ['Friend', 'friend', 'lost']);

  // Hunt F: u2's challenge to u1, never joined. It is u2's hunt, so it stays, without u1's username.
  const f = await data(`friendHunts/${HUNT_F}`);
  assert.deepEqual([f.targetUid, f.targetUsername, f.status, f.hiderName], ['u1', null, 'waiting', 'Friend']);
  assert.equal(await exists(`friendHunts/${HUNT_F}/private/answer`), true);

  // Everything of u2's stays.
  for (const path of [
    'users/u2', 'users/u2/pushTokens/' + 'c'.repeat(64), 'profiles/u2', 'usernames/friend', 'leaderboard/u2',
    'monthlyLeaderboard/2026-11/entries/u2', `dailyNotifications/${today}/whatsapp/u2`, 'whatsappMessages/SMu2',
    'challengeDeliveryLimits/push/recipients/u2/senders/u1', 'monthlyLeaderboard/2026-10', 'dailyNotifications/2026-11-16',
  ]) assert.equal(await exists(path), true, `${path} should be kept`);

  // The Auth user is deleted last, after the Firestore data.
  assert.deepEqual(auth.calls, [{ uid: 'u1', userDocExists: false }]);
  assert.equal(auth.users.has('u1'), false);

  // The username is free again at once.
  await db.doc('usernames/scout').create({ uid: 'u3', displayName: 'New Scout', createdAt: new Date() });

  // A retry finds nothing left and resolves, even though the Auth user is gone, and leaves u3's claim alone.
  await deleteAccountData(db, auth, 'u1', { clock });
  assert.equal(auth.calls.length, 2);
  assert.equal((await data('usernames/scout')).uid, 'u3');
  assert.equal((await data(`friendHunts/${HUNT_A}`)).hiderName, 'Former explorer');
});

test('deleteAccountData only frees a username, atlas or number the explorer still owns', async () => {
  const batch = db.batch();
  batch.set(db.doc('users/u4'), { whatsapp: { phone: '+14155550100', verifiedAt: new Date() } });
  batch.set(db.doc('profiles/u4'), { username: 'taken', createdAt: new Date() });
  batch.set(db.doc('usernames/taken'), { uid: 'u5', displayName: 'Other', createdAt: new Date() });
  batch.set(db.doc('atlases/taken'), { uid: 'u5', name: 'taken', countries: {}, count: 0, updatedAt: new Date() });
  batch.set(db.doc('whatsappPhones/+14155550100'), { uid: 'u5', claimedAt: new Date() });
  await batch.commit();

  await deleteAccountData(db, mockAuth(db), 'u4', { clock });

  assert.equal(await exists('profiles/u4'), false);
  assert.equal(await exists('users/u4'), false);
  assert.equal((await data('usernames/taken')).uid, 'u5');
  assert.equal((await data('atlases/taken')).uid, 'u5');
  assert.equal((await data('whatsappPhones/+14155550100')).uid, 'u5');
});
