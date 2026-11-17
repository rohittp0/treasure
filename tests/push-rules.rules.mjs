// Push token rules (users/{uid}/pushTokens/{hash}). Run from friend-rules.rules.mjs inside the Firestore emulator.
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';

const hash = char => char.repeat(64);
const token = 'f'.repeat(30);

export async function testPushRules(environment) {
  const owner = environment.authenticatedContext('push-owner').firestore();
  const other = environment.authenticatedContext('push-other').firestore();
  const guest = environment.unauthenticatedContext().firestore();
  const tokenDoc = (db, id) => doc(db, 'users/push-owner/pushTokens', hash(id));

  // Platform is optional; an absent platform counts as web.
  await assertSucceeds(setDoc(tokenDoc(owner, 'a'), { token, createdAt: serverTimestamp() }));
  await assertSucceeds(setDoc(tokenDoc(owner, 'b'), { token, createdAt: serverTimestamp(), platform: 'web' }));
  await assertSucceeds(setDoc(tokenDoc(owner, 'c'), { token, createdAt: serverTimestamp(), platform: 'android' }));
  await assertSucceeds(setDoc(tokenDoc(owner, 'd'), { token, createdAt: serverTimestamp(), platform: 'ios' }));

  // Anything else is rejected.
  await assertFails(setDoc(tokenDoc(owner, 'e'), { token, createdAt: serverTimestamp(), platform: 'desktop' }));
  await assertFails(setDoc(tokenDoc(owner, 'e'), { token, createdAt: serverTimestamp(), platform: 7 }));
  await assertFails(setDoc(tokenDoc(owner, 'e'), { token, createdAt: serverTimestamp(), foo: 'bar' }));
  await assertFails(setDoc(tokenDoc(owner, 'e'), { token, createdAt: serverTimestamp(), platform: 'ios', foo: 'bar' }));
  await assertFails(setDoc(tokenDoc(owner, 'e'), { token: 'short', createdAt: serverTimestamp(), platform: 'ios' }));

  // Only the owner writes their tokens.
  await assertFails(setDoc(tokenDoc(other, 'f'), { token, createdAt: serverTimestamp(), platform: 'android' }));
  await assertFails(setDoc(tokenDoc(other, 'f'), { token, createdAt: serverTimestamp() }));
  await assertFails(setDoc(tokenDoc(guest, 'f'), { token, createdAt: serverTimestamp(), platform: 'ios' }));
}
