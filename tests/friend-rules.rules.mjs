import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';

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
    hiderUid: 'hider', hiderName: 'Hider', seekerUid: null, seekerName: null,
    clues: ['A country in Europe', 'South of Germany', 'The boot-shaped peninsula'],
    status: 'waiting', createdAt: serverTimestamp(), startedAt: null, endedAt: null,
    cluesVisible: 1, costSeconds: 0, wrongGuesses: 0, triedIds: [],
    lastGuessId: '', lastGuessOutcome: '', revealed: false,
  });
  batch.set(answer, { id: 'ITA', country: 'Italy', lng: 12.5, lat: 42.8 });
  await assertSucceeds(batch.commit());
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
  await assertSucceeds(updateDoc(doc(seeker, huntPath), { revealed: true, costSeconds: 95 }));
  const revealed = await assertSucceeds(getDoc(doc(seeker, secretPath)));
  assert.equal(revealed.data().id, 'ITA');
  await assertSucceeds(updateDoc(doc(seeker, huntPath), {
    status: 'won', endedAt: serverTimestamp(), lastGuessId: 'ITA', lastGuessOutcome: 'correct',
  }));
  const finished = await assertSucceeds(getDoc(doc(seeker, huntPath)));
  assert.equal(finished.data().status, 'won');
  await assertFails(updateDoc(doc(seeker, huntPath), { costSeconds: 100 }));

  const expiredPath = 'friendHunts/JKLMNPQRST';
  await environment.withSecurityRulesDisabled(async context => {
    const database = context.firestore();
    await setDoc(doc(database, expiredPath), {
      hiderUid: 'hider', hiderName: 'Hider', seekerUid: 'seeker', seekerName: 'Seeker',
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
  console.log('Friend hunt rules: private answer, join, time costs, guesses, reveal, and finish passed.');
} finally {
  await environment.cleanup();
}
