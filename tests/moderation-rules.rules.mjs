// Moderation rules: reports, blocks, terms acceptance, bans, blocked usernames and the daily quest push flag.
// Run from friend-rules.rules.mjs inside the Firestore emulator.
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { addDoc, collection, deleteDoc, deleteField, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch } from 'firebase/firestore';

const TOKEN_HASH = 'a'.repeat(64);
const TOKEN = 'f'.repeat(40);

export async function testModerationRules(environment) {
  const past = Timestamp.fromDate(new Date('2026-11-09T10:00:00Z'));
  await environment.withSecurityRulesDisabled(async context => {
    const admin = context.firestore();
    for (const [uid, name] of [['mod-ok', 'modok'], ['mod-banned', 'modbanned'], ['mod-hider', 'modhider']]) {
      await setDoc(doc(admin, `profiles/${uid}`), { username: name, createdAt: past });
      await setDoc(doc(admin, `usernames/${name}`), { uid, displayName: name, createdAt: past });
    }
    await setDoc(doc(admin, 'bans/mod-banned'), { bannedAt: past, reason: 'test' });
    await setDoc(doc(admin, 'blockedUsernames/admin'), { source: 'blocklist' });
    await setDoc(doc(admin, 'users/mod-ok'), { displayName: 'Ok' });
    await setDoc(doc(admin, 'users/mod-accepted'), { displayName: 'Accepted', termsAcceptedAt: past });
    for (const code of ['MXDJNA2345', 'MXDJNB2345']) {
      await setDoc(doc(admin, `friendHunts/${code}`), {
        hiderUid: 'mod-hider', hiderName: 'Hider', targetUid: null, targetUsername: null, seekerUid: null, seekerName: null,
        clues: ['First clue', 'Second clue', 'Third clue'], status: 'waiting', roundSeconds: 180,
        createdAt: past, startedAt: null, endedAt: null, cluesVisible: 1, costSeconds: 0, wrongGuesses: 0, triedIds: [],
        lastGuessId: '', lastGuessOutcome: '', revealed: false,
      });
    }
  });

  const ok = environment.authenticatedContext('mod-ok').firestore();
  const banned = environment.authenticatedContext('mod-banned').firestore();
  const other = environment.authenticatedContext('mod-other').firestore();
  const guest = environment.unauthenticatedContext().firestore();

  // ---- Reports: create-only for signed-in explorers, never readable by clients.
  const report = { reporterUid: 'mod-ok', targetUid: 'mod-hider', kind: 'clue', code: 'MXDJNA2345', reason: 'Offensive clues', createdAt: serverTimestamp() };
  const filed = await assertSucceeds(addDoc(collection(ok, 'reports'), report));
  const { code: _code, ...withoutCode } = report;
  await assertSucceeds(addDoc(collection(ok, 'reports'), { ...withoutCode, kind: 'profile' }));
  for (const kind of ['hunt', 'username']) await assertSucceeds(addDoc(collection(ok, 'reports'), { ...withoutCode, kind }));
  await assertSucceeds(addDoc(collection(ok, 'reports'), { ...report, reason: 'x'.repeat(200) }));
  for (const bad of [
    { ...report, reporterUid: 'mod-other' },
    { ...report, targetUid: 'mod-ok' },
    { ...report, targetUid: '' },
    { ...report, kind: 'spam' },
    { ...report, code: 'not a code' },
    { ...report, reason: 'x'.repeat(201) },
    { ...report, reason: 42 },
    { ...report, createdAt: past },
    { ...report, extra: true },
    { reporterUid: 'mod-ok', targetUid: 'mod-hider', kind: 'clue', createdAt: serverTimestamp() },
  ]) await assertFails(addDoc(collection(ok, 'reports'), bad));
  await assertFails(addDoc(collection(guest, 'reports'), report));
  await assertFails(getDoc(doc(ok, `reports/${filed.id}`)));
  await assertFails(getDocs(collection(ok, 'reports')));
  await assertFails(updateDoc(doc(ok, `reports/${filed.id}`), { reason: 'changed' }));
  await assertFails(deleteDoc(doc(ok, `reports/${filed.id}`)));
  // Banned explorers can still report: a report is never public.
  await assertSucceeds(addDoc(collection(banned, 'reports'), { ...report, reporterUid: 'mod-banned' }));

  // ---- Blocks: the owner's private list, { createdAt } stamped by the server.
  const block = doc(ok, 'users/mod-ok/blocks/mod-hider');
  await assertSucceeds(setDoc(block, { createdAt: serverTimestamp() }));
  await assertSucceeds(getDoc(block));
  await assertSucceeds(getDocs(collection(ok, 'users/mod-ok/blocks')));
  await assertFails(setDoc(doc(ok, 'users/mod-ok/blocks/mod-other'), { createdAt: past }));
  await assertFails(setDoc(doc(ok, 'users/mod-ok/blocks/mod-other'), { createdAt: serverTimestamp(), username: 'x' }));
  await assertFails(setDoc(doc(ok, 'users/mod-ok/blocks/mod-ok'), { createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(other, 'users/mod-ok/blocks/mod-other'), { createdAt: serverTimestamp() }));
  await assertFails(getDoc(doc(other, 'users/mod-ok/blocks/mod-hider')));
  await assertFails(getDocs(collection(other, 'users/mod-ok/blocks')));
  await assertFails(updateDoc(block, { createdAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(other, 'users/mod-ok/blocks/mod-hider')));
  await assertSucceeds(deleteDoc(block));

  // ---- Terms: users/{uid}.termsAcceptedAt is the server time, set once.
  await assertSucceeds(setDoc(doc(environment.authenticatedContext('mod-new').firestore(), 'users/mod-new'), { termsAcceptedAt: serverTimestamp() }, { merge: true }));
  await assertFails(setDoc(doc(environment.authenticatedContext('mod-new2').firestore(), 'users/mod-new2'), { termsAcceptedAt: past }));
  await assertFails(updateDoc(doc(ok, 'users/mod-ok'), { termsAcceptedAt: past }));
  await assertSucceeds(updateDoc(doc(ok, 'users/mod-ok'), { termsAcceptedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(ok, 'users/mod-ok'), { termsAcceptedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(ok, 'users/mod-ok'), { termsAcceptedAt: deleteField() }));
  const accepted = environment.authenticatedContext('mod-accepted').firestore();
  await assertFails(setDoc(doc(accepted, 'users/mod-accepted'), { termsAcceptedAt: serverTimestamp() }, { merge: true }));
  // Other profile merges (saveHunt) keep working once the terms are accepted.
  await assertSucceeds(setDoc(doc(ok, 'users/mod-ok'), { displayName: 'Ok', photoURL: '', updatedAt: serverTimestamp() }, { merge: true }));
  await assertFails(updateDoc(doc(other, 'users/mod-ok'), { termsAcceptedAt: serverTimestamp() }));

  // ---- Bans: server-only, and a banned explorer can't write anything public.
  for (const db of [ok, banned, guest]) {
    await assertFails(getDoc(doc(db, 'bans/mod-banned')));
    await assertFails(getDocs(collection(db, 'bans')));
    await assertFails(getDoc(doc(db, 'blockedUsernames/admin')));
  }
  await assertFails(setDoc(doc(ok, 'bans/mod-ok'), { bannedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(banned, 'bans/mod-banned')));
  await assertFails(setDoc(doc(ok, 'blockedUsernames/someone'), { source: 'client' }));

  const leaderboardEntry = (uid, name) => ({ uid, name, averageTenths: 400, levelsCompleted: 1, highestLevel: 1, dailyFinds: 0, updatedAt: serverTimestamp() });
  await assertSucceeds(setDoc(doc(ok, 'leaderboard/mod-ok'), leaderboardEntry('mod-ok', 'modok')));
  await assertFails(setDoc(doc(banned, 'leaderboard/mod-banned'), leaderboardEntry('mod-banned', 'modbanned')));

  const monthlyEntry = (uid, name) => ({ uid, name, month: '2026-11', found: 1, played: 1, timeUsed: 60, rankScore: 9940, updatedAt: serverTimestamp() });
  await assertSucceeds(setDoc(doc(ok, 'monthlyLeaderboard/2026-11/entries/mod-ok'), monthlyEntry('mod-ok', 'modok')));
  await assertFails(setDoc(doc(banned, 'monthlyLeaderboard/2026-11/entries/mod-banned'), monthlyEntry('mod-banned', 'modbanned')));

  const atlas = (uid, name) => ({ uid, name, countries: { ITA: '2026-11-09' }, count: 1, updatedAt: serverTimestamp() });
  await assertSucceeds(setDoc(doc(ok, 'atlases/modok'), atlas('mod-ok', 'modok')));
  await assertFails(setDoc(doc(banned, 'atlases/modbanned'), atlas('mod-banned', 'modbanned')));

  async function createHunt(db, uid, code) {
    const batch = writeBatch(db);
    batch.set(doc(db, `friendHunts/${code}`), {
      hiderUid: uid, hiderName: 'Explorer', targetUid: null, targetUsername: null, seekerUid: null, seekerName: null,
      clues: ['First clue', 'Second clue', 'Third clue'], status: 'waiting', roundSeconds: 180,
      createdAt: serverTimestamp(), startedAt: null, endedAt: null, cluesVisible: 1, costSeconds: 0, wrongGuesses: 0, triedIds: [],
      lastGuessId: '', lastGuessOutcome: '', revealed: false,
    });
    batch.set(doc(db, `friendHunts/${code}/private/answer`), { id: 'ITA', country: 'Italy', lng: 12.5, lat: 42.8 });
    return batch.commit();
  }
  await assertSucceeds(createHunt(ok, 'mod-ok', 'MXDCRA2345'));
  await assertFails(createHunt(banned, 'mod-banned', 'MXDCRB2345'));

  const join = uid => ({ seekerUid: uid, seekerName: 'Seeker', status: 'playing', startedAt: serverTimestamp() });
  await assertSucceeds(updateDoc(doc(ok, 'friendHunts/MXDJNA2345'), join('mod-ok')));
  await assertFails(updateDoc(doc(banned, 'friendHunts/MXDJNB2345'), join('mod-banned')));

  async function claim(db, uid, name) {
    const batch = writeBatch(db);
    batch.set(doc(db, `profiles/${uid}`), { username: name, createdAt: serverTimestamp() });
    batch.set(doc(db, `usernames/${name}`), { uid, displayName: 'Explorer', createdAt: serverTimestamp() });
    return batch.commit();
  }
  await assertSucceeds(claim(environment.authenticatedContext('mod-claim').firestore(), 'mod-claim', 'modclaim'));
  await environment.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'bans/mod-claim2'), { bannedAt: past }));
  await assertFails(claim(environment.authenticatedContext('mod-claim2').firestore(), 'mod-claim2', 'modclaimtwo'));
  // Names the server lists in blockedUsernames can't be claimed on the old client path either.
  await assertFails(claim(environment.authenticatedContext('mod-claim3').firestore(), 'mod-claim3', 'admin'));
  await assertSucceeds(claim(environment.authenticatedContext('mod-claim3').firestore(), 'mod-claim3', 'adminfan'));

  // ---- Push tokens may carry dailyQuest: false to turn the daily quest push off.
  const token = doc(ok, `users/mod-ok/pushTokens/${TOKEN_HASH}`);
  await assertSucceeds(setDoc(token, { token: TOKEN, createdAt: serverTimestamp(), dailyQuest: false }));
  await assertSucceeds(setDoc(token, { token: TOKEN, createdAt: serverTimestamp(), dailyQuest: true }));
  await assertSucceeds(setDoc(token, { token: TOKEN, createdAt: serverTimestamp() }));
  await assertFails(setDoc(token, { token: TOKEN, createdAt: serverTimestamp(), dailyQuest: 'off' }));
  await assertFails(setDoc(token, { token: TOKEN, createdAt: serverTimestamp(), dailyQuest: false, extra: 1 }));
  await assertFails(setDoc(doc(other, `users/mod-ok/pushTokens/${TOKEN_HASH}`), { token: TOKEN, createdAt: serverTimestamp(), dailyQuest: false }));

  console.log('Moderation rules: reports, blocks, terms, bans, blocked usernames and the daily quest push flag passed.');
}
