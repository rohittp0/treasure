import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp, collection, getDocs, query, where } from 'firebase/firestore';

const projectId = 'demo-treasure-friend-tests';
const environment = await initializeTestEnvironment({
  projectId,
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
});

try {
  const hider = environment.authenticatedContext('hider').firestore();
  const seeker = environment.authenticatedContext('seeker').firestore();
  const stranger = environment.authenticatedContext('stranger').firestore();
  const code = 'ABCDEFGHJK';
  const huntPath = `friendHunts/${code}`;
  const secretPath = `${huntPath}/private/answer`;
  const hunt = doc(hider, huntPath);
  const answer = doc(hider, secretPath);
  const batch = writeBatch(hider);
  batch.set(hunt, {
    hiderUid: 'hider', hiderName: 'Hider', targetUid: null, targetUsername: null, seekerUid: null, seekerName: null,
    clues: ['A country in Europe', 'South of Germany', 'The boot-shaped peninsula'],
    status: 'waiting', createdAt: serverTimestamp(), startedAt: null, endedAt: null,
    cluesVisible: 1, costSeconds: 0, wrongGuesses: 0, triedIds: [],
    lastGuessId: '', lastGuessOutcome: '', revealed: false,
  });
  batch.set(answer, { id: 'ITA', country: 'Italy', lng: 12.5, lat: 42.8 });
  await assertSucceeds(batch.commit());
  const newCode = 'MNPRSTUVWX';
  const newHunt = writeBatch(hider);
  newHunt.set(doc(hider, `friendHunts/${newCode}`), {
    hiderUid: 'hider', hiderName: 'Hider', targetUid: null, targetUsername: null, seekerUid: null, seekerName: null,
    clues: ['First clue', 'Second clue', 'Third clue'], status: 'waiting', roundSeconds: 180,
    createdAt: serverTimestamp(), startedAt: null, endedAt: null,
    cluesVisible: 1, costSeconds: 0, wrongGuesses: 0, triedIds: [],
    lastGuessId: '', lastGuessOutcome: '', revealed: false,
  });
  newHunt.set(doc(hider, `friendHunts/${newCode}/private/answer`), { id: 'ITA', country: 'Italy', lng: 12.5, lat: 42.8 });
  await assertSucceeds(newHunt.commit());
  await assertSucceeds(getDoc(hunt));
  await assertSucceeds(getDoc(doc(seeker, huntPath)));
  await assertSucceeds(getDoc(answer));
  await assertFails(getDoc(doc(seeker, secretPath)));
  await assertFails(getDoc(doc(stranger, secretPath)));

  await assertSucceeds(updateDoc(doc(seeker, huntPath), {
    seekerUid: 'seeker', seekerName: 'Seeker', status: 'playing', startedAt: serverTimestamp(),
  }));
  await assertFails(getDoc(doc(seeker, secretPath)));
  await assertFails(getDoc(doc(stranger, huntPath)));
  await assertFails(updateDoc(hunt, { clues: ['Changed', 'Changed', 'Changed'] }));
  await assertFails(updateDoc(doc(seeker, huntPath), { status: 'lost', endedAt: serverTimestamp() }));
  await assertFails(updateDoc(hunt, { status: 'won', endedAt: serverTimestamp(), lastGuessId: 'ITA', lastGuessOutcome: 'correct' }));
  await assertFails(updateDoc(doc(seeker, huntPath), {
    status: 'won', endedAt: serverTimestamp(), lastGuessId: 'FRA', lastGuessOutcome: 'correct',
  }));
  await assertSucceeds(updateDoc(doc(seeker, huntPath), {
    costSeconds: 5, wrongGuesses: 1, triedIds: ['FRA'], lastGuessId: 'FRA', lastGuessOutcome: 'wrong',
  }));
  await assertFails(updateDoc(doc(seeker, huntPath), {
    costSeconds: 10, wrongGuesses: 2, triedIds: ['FRA', 'FRA'], lastGuessId: 'FRA', lastGuessOutcome: 'wrong',
  }));
  await assertSucceeds(updateDoc(doc(seeker, huntPath), { cluesVisible: 2, costSeconds: 25 }));
  await assertSucceeds(updateDoc(doc(seeker, huntPath), { cluesVisible: 3, costSeconds: 45 }));
  await assertFails(updateDoc(doc(seeker, huntPath), { revealed: true, costSeconds: 95 }));
  await assertSucceeds(updateDoc(doc(seeker, huntPath), { revealed: true, costSeconds: 75 }));
  const revealed = await assertSucceeds(getDoc(doc(seeker, secretPath)));
  assert.equal(revealed.data().id, 'ITA');
  await assertSucceeds(updateDoc(doc(seeker, huntPath), {
    status: 'won', endedAt: serverTimestamp(), lastGuessId: 'ITA', lastGuessOutcome: 'correct',
  }));
  const finished = await assertSucceeds(getDoc(doc(seeker, huntPath)));
  assert.equal(finished.data().status, 'won');
  for (const [database, field, uid] of [[hider, 'hiderUid', 'hider'], [seeker, 'seekerUid', 'seeker']]) {
    const logs = await assertSucceeds(getDocs(query(collection(database, 'friendHunts'), where(field, '==', uid))));
    assert.ok(logs.docs.some(item => item.id === code));
  }
  await assertFails(getDocs(collection(stranger, 'friendHunts')));
  await assertFails(getDocs(query(collection(stranger, 'friendHunts'), where('hiderUid', '==', 'hider'))));
  await assertFails(getDocs(query(collection(stranger, 'friendHunts'), where('seekerUid', '==', 'seeker'))));
  await assertFails(getDocs(query(collection(stranger, 'friendHunts'), where('status', '==', 'won'))));
  const ownEmptyLog = await assertSucceeds(getDocs(query(collection(stranger, 'friendHunts'), where('hiderUid', '==', 'stranger'))));
  assert.equal(ownEmptyLog.size, 0);
  const sharedResult = await assertSucceeds(getDoc(doc(stranger, huntPath)));
  assert.equal(sharedResult.data().status, 'won');
  await assertFails(getDoc(doc(stranger, secretPath)));
  await assertFails(updateDoc(doc(stranger, huntPath), { seekerUid: 'stranger', seekerName: 'Stranger' }));
  await assertFails(updateDoc(doc(seeker, huntPath), { costSeconds: 80 }));

  const expiredPath = 'friendHunts/JKLMNPQRST';
  await environment.withSecurityRulesDisabled(async context => {
    const database = context.firestore();
    await setDoc(doc(database, expiredPath), {
      hiderUid: 'hider', hiderName: 'Hider', targetUid: null, targetUsername: null, seekerUid: 'seeker', seekerName: 'Seeker',
      clues: ['First clue', 'Second clue', 'Third clue'], status: 'playing',
      createdAt: Timestamp.fromMillis(Date.now() - 150_000),
      startedAt: Timestamp.fromMillis(Date.now() - 130_000), endedAt: null,
      cluesVisible: 1, costSeconds: 0, wrongGuesses: 0, triedIds: [],
      lastGuessId: '', lastGuessOutcome: '', revealed: false,
    });
    await setDoc(doc(database, `${expiredPath}/private/answer`), { id: 'ITA', country: 'Italy', lng: 12.5, lat: 42.8 });
  });
  await assertSucceeds(updateDoc(doc(hider, expiredPath), { status: 'lost', endedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(seeker, `${expiredPath}/private/answer`)));
  const sharedLoss = await assertSucceeds(getDoc(doc(stranger, expiredPath)));
  assert.equal(sharedLoss.data().status, 'lost');
  await assertFails(getDoc(doc(stranger, `${expiredPath}/private/answer`)));

  const threeMinutePath = 'friendHunts/UVWXYZ2345';
  await environment.withSecurityRulesDisabled(async context => {
    const database = context.firestore();
    await setDoc(doc(database, threeMinutePath), {
      hiderUid: 'hider', hiderName: 'Hider', targetUid: null, targetUsername: null, seekerUid: 'seeker', seekerName: 'Seeker',
      clues: ['First clue', 'Second clue', 'Third clue'], status: 'playing', roundSeconds: 180,
      createdAt: Timestamp.fromMillis(Date.now() - 150_000),
      startedAt: Timestamp.fromMillis(Date.now() - 130_000), endedAt: null,
      cluesVisible: 1, costSeconds: 0, wrongGuesses: 0, triedIds: [],
      lastGuessId: '', lastGuessOutcome: '', revealed: false,
    });
    await setDoc(doc(database, `${threeMinutePath}/private/answer`), { id: 'ITA', country: 'Italy', lng: 12.5, lat: 42.8 });
  });
  await assertFails(updateDoc(doc(hider, threeMinutePath), { status: 'lost', endedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(seeker, threeMinutePath), {
    costSeconds: 5, wrongGuesses: 1, triedIds: ['FRA'], lastGuessId: 'FRA', lastGuessOutcome: 'wrong',
  }));
  await environment.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), threeMinutePath), { startedAt: Timestamp.fromMillis(Date.now() - 190_000) });
  });
  await assertSucceeds(updateDoc(doc(hider, threeMinutePath), { status: 'lost', endedAt: serverTimestamp() }));

  const hiderName = writeBatch(hider);
  hiderName.set(doc(hider, 'profiles/hider'), { username: 'mapmaker', createdAt: serverTimestamp() });
  hiderName.set(doc(hider, 'usernames/mapmaker'), { uid: 'hider', displayName: 'Hider', createdAt: serverTimestamp() });
  await assertSucceeds(hiderName.commit());
  const seekerName = writeBatch(seeker);
  seekerName.set(doc(seeker, 'profiles/seeker'), { username: 'mapfinder', createdAt: serverTimestamp() });
  seekerName.set(doc(seeker, 'usernames/mapfinder'), { uid: 'seeker', displayName: 'Seeker', createdAt: serverTimestamp() });
  await assertSucceeds(seekerName.commit());
  await assertFails(setDoc(doc(stranger, 'usernames/mapmaker'), { uid: 'stranger', displayName: 'Stranger', createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(hider, 'usernames/anothername'), { uid: 'hider', displayName: 'Hider', createdAt: serverTimestamp() }));
  await assertFails(getDoc(doc(stranger, 'profiles/hider')));
  await assertSucceeds(getDoc(doc(stranger, 'usernames/mapfinder')));

  const leader = doc(seeker, 'leaderboard/seeker');
  const leaderboardEntry = { uid: 'seeker', averageTenths: 500, levelsCompleted: 2, highestLevel: 2, updatedAt: serverTimestamp() };
  await assertFails(setDoc(leader, { ...leaderboardEntry, name: 'Impostor' }));
  await assertSucceeds(setDoc(leader, { ...leaderboardEntry, name: 'mapfinder' }));
  await assertFails(updateDoc(leader, { name: 'Impostor', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(leader, { averageTenths: 550, levelsCompleted: 3, highestLevel: 3, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(leader, { averageTenths: 540, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(leader, { averageTenths: 560, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(leader, { levelsCompleted: 2, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(leader, { averageTenths: 1790, levelsCompleted: 4, highestLevel: 4, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(leader, { averageTenths: 1801, levelsCompleted: 5, highestLevel: 5, updatedAt: serverTimestamp() }));
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'leaderboard/hider'), {
      uid: 'hider', name: 'Explorer HIDE', country: 'Italy', puzzleId: 'ITA', score: 80, completedAt: Timestamp.now(),
    });
  });
  await assertSucceeds(setDoc(doc(hider, 'leaderboard/hider'), {
    uid: 'hider', name: 'mapmaker', averageTenths: 400, levelsCompleted: 1, highestLevel: 1, updatedAt: serverTimestamp(),
  }));

  await assertFails(setDoc(doc(hider, 'friendHunts/QRSTUVWX23'), {
    hiderUid: 'hider', hiderName: 'Hider', targetUid: 'seeker', targetUsername: 'mapfinder', seekerUid: null, seekerName: null,
    clues: ['First clue', 'Second clue', 'Third clue'], status: 'waiting', createdAt: serverTimestamp(),
    startedAt: null, endedAt: null, cluesVisible: 1, costSeconds: 0, wrongGuesses: 0, triedIds: [],
    lastGuessId: '', lastGuessOutcome: '', revealed: false,
  }));

  const directCode = 'NPQRSTUVWX';
  const directPath = `friendHunts/${directCode}`;
  const direct = writeBatch(hider);
  direct.set(doc(hider, directPath), {
    hiderUid: 'hider', hiderName: 'Hider', hiderUsername: 'mapmaker', targetUid: 'seeker', targetUsername: 'mapfinder', seekerUid: null, seekerName: null,
    clues: ['First clue', 'Second clue', 'Third clue'], status: 'waiting', createdAt: serverTimestamp(),
    startedAt: null, endedAt: null, cluesVisible: 1, costSeconds: 0, wrongGuesses: 0, triedIds: [],
    lastGuessId: '', lastGuessOutcome: '', revealed: false,
  });
  direct.set(doc(hider, `${directPath}/private/answer`), { id: 'ITA', country: 'Italy', lng: 12.5, lat: 42.8 });
  direct.set(doc(hider, `users/seeker/notifications/${directCode}`), {
    code: directCode, fromUid: 'hider', fromUsername: 'mapmaker', createdAt: serverTimestamp(), read: false,
  });
  await assertSucceeds(direct.commit());
  await assertFails(getDoc(doc(stranger, directPath)));
  await assertSucceeds(getDoc(doc(seeker, directPath)));
  await assertFails(getDoc(doc(hider, `users/seeker/notifications/${directCode}`)));
  await assertSucceeds(getDoc(doc(seeker, `users/seeker/notifications/${directCode}`)));
  await assertFails(updateDoc(doc(hider, `users/seeker/notifications/${directCode}`), { read: true }));
  await assertSucceeds(updateDoc(doc(seeker, `users/seeker/notifications/${directCode}`), { read: true }));
  await assertFails(updateDoc(doc(stranger, directPath), {
    seekerUid: 'stranger', seekerName: 'Stranger', status: 'playing', startedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(doc(seeker, directPath), {
    seekerUid: 'seeker', seekerName: 'Seeker', status: 'playing', startedAt: serverTimestamp(),
  }));
  const tokenPath = `users/seeker/pushTokens/${'a'.repeat(64)}`;
  await assertSucceeds(setDoc(doc(seeker, tokenPath), { token: 'fcm-registration-token-12345', createdAt: serverTimestamp() }));
  await assertFails(getDoc(doc(stranger, tokenPath)));
  await assertFails(setDoc(doc(stranger, tokenPath), { token: 'stolen-registration-token', createdAt: serverTimestamp() }));
  console.log('Friend hunt rules: username claims, direct challenges, private answer, join, time costs, guesses, reveal, and finish passed.');
} finally {
  await environment.cleanup();
}
